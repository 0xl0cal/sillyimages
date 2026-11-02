/** Viewport-owned image previews. Original URLs remain on gallery items. */
const cache = new Map();
const leases = new Map();
const retired = new Set();
const states = new WeakMap();
let tracked = new Set();
let observer;
let running = false;
let generation = 0;
const queue = [];
const MAX_PIXELS = 4 * 1024 * 1024;
const MAX_ENTRIES = 24;

function retire(url) {
    if (leases.has(url)) retired.add(url);
    else URL.revokeObjectURL(url);
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
    const started = generation;
    const key = `${width}:${source}`;
    if (cache.has(key)) {
        const item = cache.get(key);
        cache.delete(key);
        cache.set(key, item);
        return item.url;
    }
    const response = await fetch(source, { signal });
    if (!response.ok) throw new Error(`Preview HTTP ${response.status}`);
    const blob = await response.blob();
    let bitmap, temporary;
    const canvas = document.createElement('canvas');
    try {
        try { bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeQuality: 'high' }); }
        catch {
            temporary = URL.createObjectURL(blob);
            bitmap = new Image();
            bitmap.src = temporary;
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
        if (temporary) URL.revokeObjectURL(temporary);
        canvas.width = canvas.height = 0;
    }
}

function release(image) {
    states.get(image)?.controller?.abort();
    const url = image.getAttribute('src');
    const owners = leases.get(url);
    owners?.delete(image);
    if (owners?.size === 0) {
        leases.delete(url);
        if (retired.delete(url)) URL.revokeObjectURL(url);
    }
    states.delete(image);
    image.removeAttribute('src');
}

async function drain() {
    if (running) return;
    running = true;
    try {
        while (queue.length) {
            const job = queue.shift();
            const { image, source, width } = job;
            if (!image.isConnected || states.get(image) !== job) continue;
            let src;
            try { src = await thumbnail(source, width, job.controller.signal); }
            catch { src = source; }
            // A scroll, editor change or collapse can invalidate an in-flight decode.
            if (image.isConnected && states.get(image) === job) {
                if (src.startsWith('blob:')) {
                    if (!leases.has(src)) leases.set(src, new Set());
                    leases.get(src).add(image);
                }
                image.src = src;
            }
        }
    } finally { running = false; }
}

function load(image) {
    if (states.has(image)) return;
    const source = image.getAttribute('data-iig-library-src');
    if (!source) return;
    if (!image.hasAttribute('data-iig-full-src')) {
        states.set(image, true);
        image.src = source;
        return;
    }
    const target = Math.max(128, Math.min(512, (image.clientWidth || 128) * Math.min(devicePixelRatio || 1, 3)));
    const job = { image, source, width: target <= 128 ? 128 : target <= 256 ? 256 : 512, controller: new AbortController() };
    states.set(image, job);
    queue.push(job);
    drain();
}

export function observeLibraryImages() {
    const section = document.getElementById('iig_characters_section');
    const visible = section?.closest('details')?.open;
    const next = new Set(visible ? section.querySelectorAll('img[data-iig-library-src]') : []);
    for (const image of tracked) if (!next.has(image)) {
        if (image.parentElement) observer?.unobserve(image.parentElement);
        release(image);
    }
    tracked = next;
    // Drop detached queued nodes immediately, rather than retaining old editors.
    for (let i = queue.length - 1; i >= 0; i--) if (!next.has(queue[i].image)) queue.splice(i, 1);
    if (!visible) {
        generation++;
        for (const item of cache.values()) retire(item.url);
        cache.clear();
        return;
    }
    if (typeof IntersectionObserver !== 'function') { next.forEach(load); return; }
    if (!observer) observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            const image = entry.target.querySelector('img[data-iig-library-src]');
            if (!tracked.has(image)) continue;
            if (entry.isIntersecting) load(image);
            else release(image);
        }
    }, { rootMargin: '160px 0px' });
    next.forEach(image => observer.observe(image.parentElement));
}

window.addEventListener('pagehide', () => {
    generation++;
    observer?.disconnect();
    for (const image of tracked) release(image);
    tracked.clear();
    queue.length = 0;
    for (const item of cache.values()) retire(item.url);
    cache.clear();
});
