/** Viewport-owned image previews. Original URLs remain on gallery items. */
const cache = new Map();
const leases = new Map();
const retired = new Set();
const states = new WeakMap();
const observedParents = new WeakMap();
const inView = new Set();
let tracked = new Set();
let observer;
let resizeObserver;
let upgradeFrame = 0;
let densityQuery;
let running = false;
let active = true;
let generation = 0;
const pendingVisibility = new Map();
let originalWarmup = null;
let warmupTimer = 0;
const queue = [];
const MAX_PIXELS = 4 * 1024 * 1024;
// A complete 48-image gallery must fit without cycling through fresh URLs.
const MAX_ENTRIES = 96;
const REQUEST_TIMEOUT_MS = 15000;

export function releaseLibraryOriginal() {
    clearTimeout(warmupTimer);
    warmupTimer = 0;
    originalWarmup?.removeAttribute('src');
    originalWarmup = null;
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
    let bitmap;
    const canvas = document.createElement('canvas');
    try {
        try {
            if (blob.type === 'image/svg+xml') throw new Error('SVG uses the image decoder');
            bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeQuality: 'high' });
        }
        catch {
            bitmap = new Image();
            bitmap.src = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(blob);
            });
            await bitmap.decode();
        }
        canvas.width = Math.max(1, Math.min(width, bitmap.width, Math.round(bitmap.width * 1024 / bitmap.height)));
        canvas.height = Math.max(1, Math.round(bitmap.height * canvas.width / bitmap.width));
        const context = canvas.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const encoded = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!encoded) throw new Error('Cannot encode preview');
        if (started !== generation || signal.aborted) throw new Error('Preview released');
        const item = { url: URL.createObjectURL(encoded), pixels: canvas.width * canvas.height };
        cache.set(key, item);
        trimCache();
        return item.url;
    } finally {
        bitmap?.close?.();
        bitmap?.removeAttribute?.('src');
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
    states.get(image)?.controller?.abort();
    const url = image.getAttribute('src');
    image.removeAttribute('src');
    releaseLease(image, url);
    states.delete(image);
    inView.delete(image);
}

async function drain() {
    if (running) return;
    running = true;
    try {
        while (queue.length) {
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
        if (states.has(image)) return;
        states.set(image, true);
        image.src = source;
        return;
    }
    const target = Math.max(128, Math.min(512, (image.clientWidth || 128) * Math.min(devicePixelRatio || 1, 3)));
    const width = target <= 128 ? 128 : target <= 256 ? 256 : 512;
    const previous = states.get(image);
    if (previous?.source === source && previous.width >= width) return;
    previous?.controller?.abort();
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

export function observeLibraryImages() {
    const section = document.getElementById('iig_characters_section');
    const visible = section?.closest('details')?.open;
    const next = new Set(visible ? section.querySelectorAll('img[data-iig-library-src]') : []);
    for (const image of tracked) if (!next.has(image)) {
        const parent = observedParents.get(image);
        if (parent) {
            observer?.unobserve(parent);
            resizeObserver?.unobserve(parent);
            pendingVisibility.delete(parent);
        }
        observedParents.delete(image);
        release(image);
    }
    const added = [...next].filter(image => !tracked.has(image));
    added.forEach(image => observedParents.set(image, image.parentElement));
    tracked = next;
    // Drop detached queued nodes immediately, rather than retaining old editors.
    for (let i = queue.length - 1; i >= 0; i--) if (!next.has(queue[i].image)) queue.splice(i, 1);
    if (!visible) {
        if (originalWarmup || cache.size) document.dispatchEvent(new Event('iig-library-images-released'));
        releaseLibraryOriginal();
        pendingVisibility.clear();
        generation++;
        for (const item of cache.values()) retire(item.url);
        cache.clear();
        return;
    }
    if (typeof ResizeObserver === 'function') {
        resizeObserver ||= new ResizeObserver(scheduleUpgrade);
        added.forEach(image => resizeObserver.observe(image.parentElement));
    }
    if (typeof IntersectionObserver !== 'function') { next.forEach(image => { inView.add(image); load(image); }); return; }
    observer ||= new IntersectionObserver(updateVisibility, { rootMargin: '160px 0px' });
    added.forEach(image => observer.observe(image.parentElement));
    scheduleOriginalWarmup();
}

function updateVisibility(entries) {
    // Preserve visible previews under the modal and reconcile deferred entries on close.
    if (document.getElementById('iig_lightbox')?.open) {
        for (const entry of entries) pendingVisibility.set(entry.target, entry);
        return;
    }
    for (const entry of entries) {
        const image = entry.target.querySelector('img[data-iig-library-src]');
        if (!tracked.has(image)) continue;
        if (entry.isIntersecting) { inView.add(image); load(image); }
        else release(image);
    }
    scheduleOriginalWarmup();
}

document.addEventListener('close', event => {
    if (event.target.id !== 'iig_lightbox') return;
    updateVisibility([...pendingVisibility.values()]);
    pendingVisibility.clear();
    observeLibraryImages();
}, true);

function dispose() {
    active = false;
    generation++;
    releaseLibraryOriginal();
    pendingVisibility.clear();
    observer?.disconnect();
    resizeObserver?.disconnect();
    if (upgradeFrame) cancelAnimationFrame(upgradeFrame);
    upgradeFrame = 0;
    for (const image of tracked) release(image);
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
