/** Bounded image previews with viewport-driven loading. Originals remain on gallery items. */
const cache = new Map();
const leases = new Map();
const retired = new Set();
const states = new WeakMap();
const observedParents = new WeakMap();
const inView = new Set();
let tracked = new Set();
let ownerSection = null;
let observer;
let resizeObserver;
let upgradeFrame = 0;
let pendingUpgrade = false;
let densityQuery;
const inFlight = new Map();
const downloads = new Set();
const originalLoads = new Set();
const decoderWaiters = new Set();
let decoding = false;
const previewWorkers = new Set();
const workerWaiters = new Set();
let previewWorkerObserver;
let previewWorkerId = 0;
let previewWorkerUnavailable = false;
let previewWorkerTimer = 0;
let foregroundTimer = 0;
let resumeTimer = 0;
let active = true;
let libraryOpen = false;
let generation = 0;
const pendingVisibility = new Map();
let originalWarmup = null;
let warmupTimer = 0;
const queue = [];
const idleWaiters = new Set();
const MAX_PIXELS = 4 * 1024 * 1024;
// Entry and pixel caps bound galleries with mixed preview sizes.
const MAX_ENTRIES = 96;
// Compressed downloads can run ahead of the bounded decoder pool.
const MAX_WORKERS = Math.max(1, Math.min(2, navigator.hardwareConcurrency || 2));
const MAX_DOWNLOADS = 6;
const MAX_IN_FLIGHT = 12;
const REQUEST_TIMEOUT_MS = 15000;

function waitForTurn(signal, waiters) {
    return new Promise((resolve, reject) => {
        const finish = error => {
            waiters.delete(resume);
            signal.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve();
        };
        const resume = () => finish();
        const abort = () => finish(new DOMException('Preview released', 'AbortError'));
        waiters.add(resume);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
}

async function waitForPreviewIdle(signal) {
    if (signal.aborted) throw new DOMException('Preview released', 'AbortError');
    if (!resumeTimer && !document.getElementById('iig_lightbox')?.open) return;
    return waitForTurn(signal, idleWaiters);
}

function releaseLibraryOriginal() {
    clearTimeout(warmupTimer);
    warmupTimer = 0;
    originalWarmup?.removeAttribute('src');
    originalWarmup = null;
}

export function takeLibraryOriginal(source) {
    const image = originalWarmup;
    // Detach ownership before clearing the timer so the decoded resource survives transfer.
    originalWarmup = null;
    releaseLibraryOriginal();
    if (image?.complete && image.naturalWidth > 0 && image.src === source) return image;
    image?.removeAttribute('src');
    return null;
}

function scheduleOriginalWarmup() {
    if (!libraryOpen || warmupTimer || inFlight.size || queue.length || document.getElementById('iig_lightbox')?.open) return;
    // One visible original prepares entry to the viewer without retaining a gallery of decodes.
    warmupTimer = setTimeout(() => {
        warmupTimer = 0;
        const candidate = [...tracked].find(image => inView.has(image) && image.hasAttribute('data-iig-lightbox'));
        const source = candidate?.getAttribute('data-iig-full-src');
        if (originalWarmup?.getAttribute('src') === source) return;
        releaseLibraryOriginal();
        if (!active || !source || document.getElementById('iig_lightbox')?.open) return;
        originalWarmup = new Image();
        originalWarmup.decoding = 'async';
        originalWarmup.src = source;
        originalWarmup.decode().catch(() => {});
    }, 500);
}

// Filtering changes gallery visibility; speculative decodes must not compete with typing.
document.addEventListener('input', event => {
    if (!(event.target instanceof Element) || !event.target.closest('#iig_characters_section')) return;
    releaseLibraryOriginal();
    scheduleOriginalWarmup();
}, true);

// Let image cancellation finish before WebKit releases its URL resource.
function revoke(url) { setTimeout(() => URL.revokeObjectURL(url), 250); }

function retire(url) {
    const owners = leases.get(url);
    if (!owners) { revoke(url); return; }
    retired.add(url);
    // Offscreen rows share the cache budget; visible owners keep their source until exit.
    for (const image of owners) if (!libraryOpen || !inView.has(image)) release(image);
}

function trimCache() {
    let pixels = [...cache.values()].reduce((sum, item) => sum + item.pixels, 0);
    while (cache.size > MAX_ENTRIES || pixels > MAX_PIXELS) {
        const [key, item] = cache.entries().next().value;
        cache.delete(key);
        pixels -= item.pixels;
        retire(item.url);
    }
}

function cachedThumbnail(source, width) {
    const key = `${width}:${source}`;
    const item = cache.get(key);
    if (item) {
        cache.delete(key);
        cache.set(key, item);
    }
    return item;
}

function stopPreviewWorker(error = new DOMException('Preview released', 'AbortError')) {
    clearTimeout(previewWorkerTimer);
    previewWorkerTimer = 0;
    previewWorkerObserver?.disconnect();
    previewWorkerObserver = null;
    for (const slot of previewWorkers) {
        slot.worker.terminate();
        slot.task?.reject(error);
    }
    previewWorkers.clear();
    for (const resume of workerWaiters) resume();
}

function pausePreviewWorkers(paused) {
    for (const slot of previewWorkers) slot.worker.postMessage({ paused });
}

async function encodeInWorker(blob, width, signal) {
    if (blob.type === 'image/svg+xml' || previewWorkerUnavailable
        || typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function') return null;
    let slot = [...previewWorkers].find(slot => !slot.task);
    while (!slot && previewWorkers.size >= MAX_WORKERS) {
        await waitForTurn(signal, workerWaiters);
        if (previewWorkerUnavailable) return null;
        slot = [...previewWorkers].find(slot => !slot.task);
    }
    if (signal.aborted) throw new DOMException('Preview released', 'AbortError');
    if (!slot) {
        try { slot = { worker: new Worker(new URL('./previewWorker.js', import.meta.url), { type: 'module' }), task: null }; }
        catch { previewWorkerUnavailable = true; return null; }
        previewWorkers.add(slot);
        const { worker } = slot;
        const fail = event => {
            event.preventDefault?.();
            if (!previewWorkers.has(slot)) return;
            previewWorkerUnavailable = true;
            stopPreviewWorker(new Error('Preview worker unavailable'));
        };
        worker.onerror = fail;
        worker.onmessageerror = fail;
        worker.onmessage = ({ data }) => {
            const task = slot.task;
            if (!previewWorkers.has(slot) || task?.id !== data.id) return;
            slot.task = null;
            if (data.error) task.reject(new Error(data.error));
            else task.resolve(data);
            workerWaiters.values().next().value?.();
        };
        const viewer = document.getElementById('iig_lightbox');
        if (viewer && !previewWorkerObserver) {
            previewWorkerObserver = new MutationObserver(() => {
                if (viewer.open) pausePreviewWorkers(true);
            });
            previewWorkerObserver.observe(viewer, { attributes: true, attributeFilter: ['open'] });
        }
    }
    // One task per worker; the remaining compressed downloads wait without decoding.
    return new Promise((resolve, reject) => {
        const id = ++previewWorkerId;
        const finish = (data, error) => {
            signal.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve(data);
        };
        const abort = () => {
            slot.worker.terminate();
            previewWorkers.delete(slot);
            slot.task = null;
            finish(null, new DOMException('Preview released', 'AbortError'));
            workerWaiters.values().next().value?.();
        };
        slot.task = { id, resolve: data => finish(data), reject: error => finish(null, error) };
        signal.addEventListener('abort', abort, { once: true });
        try { slot.worker.postMessage({ id, blob, width }); }
        catch (error) { stopPreviewWorker(error); }
    });
}

function cacheThumbnail(key, blob, pixels) {
    const item = { url: URL.createObjectURL(blob), pixels };
    cache.set(key, item);
    trimCache();
    return item.url;
}

async function thumbnail(source, width, signal) {
    if (!active) throw new Error('Preview page released');
    const started = generation;
    const assertCurrent = () => {
        if (!active || started !== generation || signal.aborted) throw new Error('Preview released');
    };
    const key = `${width}:${source}`;
    const cached = cachedThumbnail(source, width);
    if (cached) return cached.url;
    downloads.add(key);
    const blob = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        const abort = () => request.abort();
        request.open('GET', source);
        request.responseType = 'blob';
        request.timeout = REQUEST_TIMEOUT_MS;
        request.onload = () => request.status === 0 || request.status >= 200 && request.status < 300
            ? resolve(request.response) : reject(new Error(`Preview HTTP ${request.status}`));
        request.onerror = () => reject(new Error('Preview unavailable'));
        request.ontimeout = () => reject(new Error('Preview request timed out'));
        request.onabort = () => reject(new DOMException('Preview released', 'AbortError'));
        request.onloadend = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { reject(new DOMException('Preview released', 'AbortError')); return; }
        request.send();
    }).finally(() => { downloads.delete(key); drain(); });
    await waitForPreviewIdle(signal);
    assertCurrent();
    let workerResult;
    try { workerResult = await encodeInWorker(blob, width, signal); }
    catch { /* The document decoder also handles unavailable workers and unsupported formats. */ }
    await waitForPreviewIdle(signal);
    assertCurrent();
    if (workerResult) return cacheThumbnail(key, workerResult.blob, workerResult.pixels);
    if (decoding) await waitForTurn(signal, decoderWaiters);
    else decoding = true;
    let bitmap, decoderUrl, canvas;
    try {
        await waitForPreviewIdle(signal);
        assertCurrent();
        canvas = document.createElement('canvas');
        try {
            if (blob.type === 'image/svg+xml') throw new Error('SVG uses the image decoder');
            bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeQuality: 'high' });
        }
        catch {
            await waitForPreviewIdle(signal);
            assertCurrent();
            bitmap = new Image();
            bitmap.src = decoderUrl = URL.createObjectURL(blob);
            await bitmap.decode();
        }
        // Native decoders finish asynchronously even after their owner has left.
        await waitForPreviewIdle(signal);
        assertCurrent();
        canvas.width = Math.max(1, Math.min(width, bitmap.width, Math.round(bitmap.width * 1024 / bitmap.height)));
        canvas.height = Math.max(1, Math.round(bitmap.height * canvas.width / bitmap.width));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const encoded = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!encoded) throw new Error('Cannot encode preview');
        assertCurrent();
        return cacheThumbnail(key, encoded, canvas.width * canvas.height);
    } finally {
        bitmap?.close?.();
        bitmap?.removeAttribute?.('src');
        if (decoderUrl) revoke(decoderUrl);
        if (canvas) canvas.width = canvas.height = 0;
        const resume = decoderWaiters.values().next().value;
        if (resume) resume();
        else decoding = false;
    }
}

function releaseLease(image, url) {
    const owners = leases.get(url);
    owners?.delete(image);
    if (owners?.size === 0) {
        leases.delete(url);
        if (retired.delete(url)) revoke(url);
    }
}

function release(image, { retainCached = false, retainVisibility = false } = {}) {
    const job = states.get(image);
    if (job && !job.committed) job.controller.abort();
    job?.finishOriginal?.();
    const url = image.getAttribute('src');
    const retained = retainCached && (!image.hasAttribute('data-iig-full-src')
        || leases.get(url)?.has(image) && !retired.has(url));
    if (url !== null && !retained) {
        image.removeAttribute('src');
        releaseLease(image, url);
    }
    if (job && (!retained || !job.committed)) states.delete(image);
    if (!retainVisibility) inView.delete(image);
}

function isCurrent(job) {
    return active && job.image.isConnected && job.image.ownerDocument === document
        && states.get(job.image) === job && !job.controller.signal.aborted;
}

function displayPreview(job, src) {
    if (!isCurrent(job)) return;
    const { image, source } = job;
    const previous = image.getAttribute('src');
    if (src !== source && src.startsWith('blob:')) {
        if (!leases.has(src)) leases.set(src, new Set());
        leases.get(src).add(image);
    }
    // Visibility is owned by the library observer, not a second native lazy gate.
    image.loading = 'eager';
    image.fetchPriority = 'auto';
    image.src = src;
    job.committed = true;
    if (previous !== src) releaseLease(image, previous);
}

async function preparePreview(job) {
    let src;
    try { src = await thumbnail(job.source, job.width, job.controller.signal); }
    catch { src = job.source; }
    try { await waitForPreviewIdle(job.controller.signal); }
    catch { return; }
    displayPreview(job, src);
}

function drain() {
    if (!active || resumeTimer || document.getElementById('iig_lightbox')?.open) return;
    clearTimeout(previewWorkerTimer);
    previewWorkerTimer = 0;
    for (let i = 0; i < queue.length;) {
        const job = queue[i];
        if (!isCurrent(job)) { queue.splice(i, 1); continue; }
        const cached = cachedThumbnail(job.source, job.width);
        if (cached) { queue.splice(i, 1); displayPreview(job, cached.url); continue; }
        const key = `${job.width}:${job.source}`;
        // Duplicate owners reuse the completed cache entry without a second download.
        if (originalLoads.size || foregroundTimer || inFlight.size >= MAX_IN_FLIGHT || downloads.size >= MAX_DOWNLOADS || inFlight.has(key)) { i++; continue; }
        queue.splice(i, 1);
        releaseLibraryOriginal();
        inFlight.set(key, job);
        preparePreview(job).finally(() => { inFlight.delete(key); drain(); });
    }
    // Workers own native decoder caches; an idle library retains only its preview URLs.
    if (previewWorkers.size && !inFlight.size && !queue.length) previewWorkerTimer = setTimeout(stopPreviewWorker, 500);
    scheduleOriginalWarmup();
}

function loadImages(images) {
    // Snapshot layout before any source assignment invalidates subsequent measurements.
    const measured = Array.from(images, image => [image, image.hasAttribute('data-iig-full-src') ? {
        width: image.clientWidth,
        bounds: image.hasAttribute('src') ? null : image.getBoundingClientRect(),
    } : null]);
    for (const [image, dimensions] of measured) load(image, dimensions);
}

function load(image, dimensions) {
    if (!active) return;
    const source = image.getAttribute('data-iig-library-src');
    if (!source) return;
    if (!image.hasAttribute('data-iig-full-src')) {
        if (image.getAttribute('src') !== source) image.src = source;
        return;
    }
    const target = Math.max(128, Math.min(512, (dimensions.width || 128) * Math.min(devicePixelRatio || 1, 3)));
    const width = target <= 128 ? 128 : target <= 256 ? 256 : 512;
    const previous = states.get(image);
    if (previous?.source === source && previous.width >= width) {
        if (previous.committed) cachedThumbnail(source, previous.width);
        return;
    }
    if (previous && !previous.committed) {
        previous.controller.abort();
        previous.finishOriginal?.();
    }
    const job = { image, source, width, controller: new AbortController() };
    states.set(image, job);
    if (!image.hasAttribute('src') && !cachedThumbnail(source, width) && !/^(?:data:image\/svg\+xml)|\.svg(?:[?#]|$)/i.test(source)) {
        const bounds = dimensions.bounds;
        if (bounds.top < innerHeight && bounds.bottom > 0 && bounds.left < innerWidth && bounds.right > 0) {
            // Visible originals display natively; the prefetch margin prepares only bounded previews.
            image.loading = 'eager';
            image.fetchPriority = 'auto';
            originalLoads.add(job);
            const timeout = setTimeout(() => job.finishOriginal?.(), 1000);
            const finish = job.finishOriginal = event => {
                clearTimeout(timeout);
                image.removeEventListener('load', finish);
                image.removeEventListener('error', finish);
                originalLoads.delete(job);
                job.finishOriginal = null;
                if (event?.type === 'load') {
                    // Allow native image presentation before competing for image-decode resources.
                    clearTimeout(foregroundTimer);
                    foregroundTimer = setTimeout(() => { foregroundTimer = 0; drain(); }, 100);
                }
                drain();
            };
            image.addEventListener('load', finish);
            image.addEventListener('error', finish);
            image.src = source;
        }
    }
    queue.push(job);
    drain();
}

function scheduleUpgrade() {
    if (!active) return;
    if (!libraryOpen) { pendingUpgrade = true; return; }
    if (upgradeFrame) return;
    pendingUpgrade = false;
    upgradeFrame = requestAnimationFrame(() => {
        upgradeFrame = 0;
        if (!libraryOpen || document.getElementById('iig_lightbox')?.open) return;
        loadImages([...inView].filter(image => tracked.has(image)));
    });
}

function watchDensity() {
    densityQuery?.removeEventListener('change', densityChanged);
    densityQuery = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
    densityQuery.addEventListener('change', densityChanged);
}
function densityChanged() { watchDensity(); scheduleUpgrade(); }
watchDensity();
window.addEventListener('resize', scheduleUpgrade, { passive: true });

export function observeLibraryImages({ visibilityOnly = false } = {}) {
    if (!active) return;
    const section = document.getElementById('iig_characters_section');
    const visible = Boolean(section?.closest('details')?.open);
    const closing = libraryOpen && !visible;
    const opening = !libraryOpen && visible;
    libraryOpen = visible;
    const next = visibilityOnly && section === ownerSection
        ? tracked : new Set(section?.querySelectorAll('img[data-iig-library-src]') || []);
    ownerSection = section;
    const resetObservers = next !== tracked && tracked.size > 0 && ![...tracked].some(image => next.has(image));
    if (resetObservers) {
        observer?.disconnect();
        resizeObserver?.disconnect();
        pendingVisibility.clear();
    }
    for (const image of tracked) if (closing || next !== tracked && !next.has(image)) {
        if (closing && next.has(image)) {
            // Collapsed rows keep subscriptions, not pending work or full-resolution resources.
            release(image, { retainCached: true, retainVisibility: true });
            continue;
        }
        const parent = observedParents.get(image);
        if (parent && !resetObservers) {
            observer?.unobserve(parent);
            if (image.hasAttribute('data-iig-full-src')) resizeObserver?.unobserve(parent);
            pendingVisibility.delete(parent);
        }
        observedParents.delete(image);
        release(image);
    }
    // Loaded server thumbnails belong to their DOM rows; only custom previews need exit tracking.
    const added = visible ? [...next].filter(image => !observedParents.has(image)
        && (image.hasAttribute('data-iig-full-src') || image.getAttribute('src') !== image.getAttribute('data-iig-library-src'))) : [];
    added.forEach(image => observedParents.set(image, image.parentElement));
    tracked = next;
    // Drop detached queued nodes immediately, rather than retaining old editors.
    for (let i = queue.length - 1; i >= 0; i--) if (!visible || !next.has(queue[i].image)) queue.splice(i, 1);
    if (!visible) {
        if (upgradeFrame) { pendingUpgrade = true; cancelAnimationFrame(upgradeFrame); }
        upgradeFrame = 0;
        clearTimeout(foregroundTimer);
        foregroundTimer = 0;
        clearTimeout(resumeTimer);
        resumeTimer = 0;
        if (closing) document.dispatchEvent(new Event('iig-library-images-released'));
        releaseLibraryOriginal();
        stopPreviewWorker();
        pendingVisibility.clear();
        generation++;
        return;
    }
    if (typeof IntersectionObserver !== 'function') {
        next.forEach(watchSize);
        loadImages(next);
        pendingUpgrade = false;
        return;
    }
    if (added.length) {
        observer ||= new IntersectionObserver(updateVisibility, { rootMargin: '160px 0px' });
        added.forEach(image => observer.observe(image.parentElement));
    }
    if (opening) loadImages([...inView].filter(image => tracked.has(image) && !states.get(image)?.committed));
    if (pendingUpgrade || typeof ResizeObserver !== 'function') scheduleUpgrade();
    scheduleOriginalWarmup();
}

function watchSize(image) {
    if (!image.hasAttribute('data-iig-full-src') || inView.has(image)) return;
    inView.add(image);
    if (typeof ResizeObserver !== 'function') return;
    resizeObserver ||= new ResizeObserver(() => { if (libraryOpen) scheduleUpgrade(); });
    resizeObserver.observe(image.parentElement);
}

function updateVisibility(entries) {
    if (!libraryOpen) return;
    // Preserve visible previews under the modal and reconcile deferred entries on close.
    if (document.getElementById('iig_lightbox')?.open) {
        for (const entry of entries) pendingVisibility.set(entry.target, entry);
        return;
    }
    const entering = [];
    for (const entry of entries) {
        const image = entry.target.querySelector('img[data-iig-library-src]');
        if (!tracked.has(image) || observedParents.get(image) !== entry.target) continue;
        if (entry.isIntersecting) {
            const alreadyVisible = inView.has(image);
            watchSize(image);
            if (!alreadyVisible) entering.push(image);
            if (!image.hasAttribute('data-iig-full-src')) {
                observer.unobserve(entry.target);
                observedParents.delete(image);
            }
        } else if (inView.has(image) || states.has(image)) {
            if (inView.has(image)) resizeObserver?.unobserve(entry.target);
            release(image, { retainCached: true });
        }
    }
    loadImages(entering);
    scheduleOriginalWarmup();
}

document.addEventListener('close', event => {
    if (event.target.id !== 'iig_lightbox' || event.target.open) return;
    // Give rapid reopening priority over queued preview raster work.
    clearTimeout(resumeTimer);
    pausePreviewWorkers(true);
    resumeTimer = setTimeout(() => {
        resumeTimer = 0;
        if (!document.getElementById('iig_lightbox')?.open) {
            pausePreviewWorkers(false);
            for (const resume of idleWaiters) resume();
        }
        drain();
    }, 150);
    updateVisibility([...pendingVisibility.values()]);
    pendingVisibility.clear();
}, true);

function dispose() {
    active = false;
    libraryOpen = false;
    ownerSection = null;
    clearTimeout(foregroundTimer);
    foregroundTimer = 0;
    clearTimeout(resumeTimer);
    resumeTimer = 0;
    generation++;
    releaseLibraryOriginal();
    stopPreviewWorker();
    pendingVisibility.clear();
    observer?.disconnect();
    resizeObserver?.disconnect();
    if (upgradeFrame) cancelAnimationFrame(upgradeFrame);
    upgradeFrame = 0;
    pendingUpgrade = false;
    const ownedImages = new Set([...tracked, ...document.querySelectorAll('#iig_characters_section img[data-iig-library-src]')]);
    for (const image of ownedImages) { release(image); observedParents.delete(image); }
    for (const resume of idleWaiters) resume();
    tracked.clear();
    queue.length = 0;
    for (const item of cache.values()) retire(item.url);
    cache.clear();
}
window.addEventListener('beforeunload', () => {
    dispose();
    const suspendedGeneration = generation;
    // The confirmation dialog can leave this document active. Pagehide invalidates recovery.
    setTimeout(() => {
        if (generation !== suspendedGeneration) return;
        active = true;
        observeLibraryImages();
    }, 0);
});
window.addEventListener('pagehide', dispose);
window.addEventListener('pageshow', () => { active = true; watchDensity(); observeLibraryImages(); });
