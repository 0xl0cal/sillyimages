/** Viewport-owned image previews. Original URLs remain on gallery items. */
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
let densityQuery;
let running = false;
let resumeTimer = 0;
let active = true;
let libraryOpen = false;
let generation = 0;
const pendingVisibility = new Map();
let originalWarmup = null;
let warmupTimer = 0;
const queue = [];
const MAX_PIXELS = 4 * 1024 * 1024;
// A complete 48-image gallery must fit without cycling through fresh URLs.
const MAX_ENTRIES = 96;
const REQUEST_TIMEOUT_MS = 15000;

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
    if (warmupTimer || document.getElementById('iig_lightbox')?.open) return;
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
    if (leases.has(url)) retired.add(url);
    else revoke(url);
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

async function thumbnail(source, width, signal) {
    if (!active) throw new Error('Preview page released');
    const started = generation;
    const assertCurrent = () => {
        if (!active || started !== generation || signal.aborted) throw new Error('Preview released');
    };
    const key = `${width}:${source}`;
    if (cache.has(key)) {
        const item = cache.get(key);
        cache.delete(key);
        cache.set(key, item);
        return item.url;
    }
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
    });
    assertCurrent();
    let bitmap, decoderUrl;
    const canvas = document.createElement('canvas');
    try {
        try {
            if (blob.type === 'image/svg+xml') throw new Error('SVG uses the image decoder');
            bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeQuality: 'high' });
        }
        catch {
            assertCurrent();
            bitmap = new Image();
            bitmap.src = decoderUrl = URL.createObjectURL(blob);
            await bitmap.decode();
        }
        // Native decoders finish asynchronously even after their owner has left.
        assertCurrent();
        canvas.width = Math.max(1, Math.min(width, bitmap.width, Math.round(bitmap.width * 1024 / bitmap.height)));
        canvas.height = Math.max(1, Math.round(bitmap.height * canvas.width / bitmap.width));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const encoded = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!encoded) throw new Error('Cannot encode preview');
        assertCurrent();
        const item = { url: URL.createObjectURL(encoded), pixels: canvas.width * canvas.height };
        cache.set(key, item);
        trimCache();
        return item.url;
    } finally {
        bitmap?.close?.();
        bitmap?.removeAttribute?.('src');
        if (decoderUrl) revoke(decoderUrl);
        canvas.width = canvas.height = 0;
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

function release(image) {
    const job = states.get(image);
    if (job && !job.committed) job.controller.abort();
    const url = image.getAttribute('src');
    if (url !== null) {
        image.removeAttribute('src');
        releaseLease(image, url);
    }
    if (job) states.delete(image);
    inView.delete(image);
}

async function drain() {
    if (running || resumeTimer) return;
    running = true;
    try {
        while (queue.length && !resumeTimer && !document.getElementById('iig_lightbox')?.open) {
            const job = queue.shift();
            const { image, source, width } = job;
            if (!active || !image.isConnected || image.ownerDocument !== document || states.get(image) !== job) continue;
            let src;
            try { src = await thumbnail(source, width, job.controller.signal); }
            catch { src = source; }
            // A scroll, editor change or collapse can invalidate an in-flight decode.
            if (image.isConnected && states.get(image) === job) {
                const previous = image.getAttribute('src');
                if (src.startsWith('blob:')) {
                    if (!leases.has(src)) leases.set(src, new Set());
                    leases.get(src).add(image);
                }
                image.src = src;
                job.committed = true;
                if (previous !== src) releaseLease(image, previous);
            }
        }
    } finally { running = false; }
}

function load(image) {
    if (!active) return;
    const source = image.getAttribute('data-iig-library-src');
    if (!source) return;
    if (!image.hasAttribute('data-iig-full-src')) {
        if (image.getAttribute('src') !== source) image.src = source;
        return;
    }
    const target = Math.max(128, Math.min(512, (image.clientWidth || 128) * Math.min(devicePixelRatio || 1, 3)));
    const width = target <= 128 ? 128 : target <= 256 ? 256 : 512;
    const previous = states.get(image);
    if (previous?.source === source && previous.width >= width) return;
    if (previous && !previous.committed) previous.controller.abort();
    const job = { image, source, width, controller: new AbortController() };
    states.set(image, job);
    queue.push(job);
    drain();
}

function scheduleUpgrade() {
    if (!active || upgradeFrame) return;
    upgradeFrame = requestAnimationFrame(() => {
        upgradeFrame = 0;
        if (document.getElementById('iig_lightbox')?.open) return;
        for (const image of inView) if (tracked.has(image)) load(image);
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
    libraryOpen = visible;
    const next = visibilityOnly && section === ownerSection
        ? tracked : new Set(section?.querySelectorAll('img[data-iig-library-src]') || []);
    ownerSection = section;
    const retainedUrls = closing ? new Set([...cache.values()].map(item => item.url)) : null;
    const resetObservers = closing || next !== tracked && tracked.size > 0 && ![...tracked].some(image => next.has(image));
    if (resetObservers) {
        observer?.disconnect();
        resizeObserver?.disconnect();
        pendingVisibility.clear();
    }
    for (const image of tracked) if (closing || next !== tracked && !next.has(image)) {
        const parent = observedParents.get(image);
        if (parent && !resetObservers) {
            observer?.unobserve(parent);
            if (image.hasAttribute('data-iig-full-src')) resizeObserver?.unobserve(parent);
            pendingVisibility.delete(parent);
        }
        observedParents.delete(image);
        // Closed DOM owners retain only server thumbnails and previews in the bounded cache.
        if (closing && next.has(image) && (!image.hasAttribute('data-iig-full-src') || retainedUrls.has(image.getAttribute('src')))) {
            const job = states.get(image);
            if (job && !job.committed) { job.controller.abort(); states.delete(image); }
            inView.delete(image);
        } else release(image);
    }
    // Loaded server thumbnails belong to their DOM rows; only custom previews need exit tracking.
    const added = visible ? [...next].filter(image => !observedParents.has(image)
        && (image.hasAttribute('data-iig-full-src') || image.getAttribute('src') !== image.getAttribute('data-iig-library-src'))) : [];
    added.forEach(image => observedParents.set(image, image.parentElement));
    tracked = next;
    // Drop detached queued nodes immediately, rather than retaining old editors.
    for (let i = queue.length - 1; i >= 0; i--) if (!visible || !next.has(queue[i].image)) queue.splice(i, 1);
    if (!visible) {
        clearTimeout(resumeTimer);
        resumeTimer = 0;
        if (closing) document.dispatchEvent(new Event('iig-library-images-released'));
        releaseLibraryOriginal();
        pendingVisibility.clear();
        generation++;
        return;
    }
    if (typeof IntersectionObserver !== 'function') {
        next.forEach(image => { watchSize(image); load(image); });
        return;
    }
    if (added.length) {
        observer ||= new IntersectionObserver(updateVisibility, { rootMargin: '160px 0px' });
        added.forEach(image => observer.observe(image.parentElement));
    }
    scheduleOriginalWarmup();
}

function watchSize(image) {
    if (!image.hasAttribute('data-iig-full-src') || inView.has(image)) return;
    inView.add(image);
    if (typeof ResizeObserver !== 'function') return;
    resizeObserver ||= new ResizeObserver(scheduleUpgrade);
    resizeObserver.observe(image.parentElement);
}

function updateVisibility(entries) {
    if (!libraryOpen) return;
    // Preserve visible previews under the modal and reconcile deferred entries on close.
    if (document.getElementById('iig_lightbox')?.open) {
        for (const entry of entries) pendingVisibility.set(entry.target, entry);
        return;
    }
    for (const entry of entries) {
        const image = entry.target.querySelector('img[data-iig-library-src]');
        if (!tracked.has(image) || observedParents.get(image) !== entry.target) continue;
        if (entry.isIntersecting) {
            const alreadyVisible = inView.has(image);
            watchSize(image);
            if (!alreadyVisible) load(image);
            if (!image.hasAttribute('data-iig-full-src')) {
                observer.unobserve(entry.target);
                observedParents.delete(image);
            }
        } else if (inView.has(image) || states.has(image)) {
            if (inView.has(image)) resizeObserver?.unobserve(entry.target);
            release(image);
        }
    }
    scheduleOriginalWarmup();
}

document.addEventListener('close', event => {
    if (event.target.id !== 'iig_lightbox' || event.target.open) return;
    // Give rapid reopening priority over queued preview raster work.
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { resumeTimer = 0; drain(); }, 150);
    updateVisibility([...pendingVisibility.values()]);
    pendingVisibility.clear();
}, true);

function dispose() {
    active = false;
    libraryOpen = false;
    ownerSection = null;
    clearTimeout(resumeTimer);
    resumeTimer = 0;
    generation++;
    releaseLibraryOriginal();
    pendingVisibility.clear();
    observer?.disconnect();
    resizeObserver?.disconnect();
    if (upgradeFrame) cancelAnimationFrame(upgradeFrame);
    upgradeFrame = 0;
    const ownedImages = new Set([...tracked, ...document.querySelectorAll('#iig_characters_section img[data-iig-library-src]')]);
    for (const image of ownedImages) { release(image); observedParents.delete(image); }
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
