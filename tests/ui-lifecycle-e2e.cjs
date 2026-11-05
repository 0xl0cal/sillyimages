const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createServer } = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/sillyimages/';
const engine = process.env.IIG_BROWSER_ENGINE || 'chromium';
const scenarioFilter = process.env.IIG_UI_SCENARIO_FILTER ? new RegExp(process.env.IIG_UI_SCENARIO_FILTER) : null;
const artifacts = path.join(__dirname, 'artifacts', 'ui-lifecycle-' + engine);
fs.mkdirSync(artifacts, { recursive: true });
function fixture(name) {
    const text = fs.readFileSync(path.join(__dirname, name + '-e2e.cjs'), 'utf8');
    const context = { require, __dirname };
    vm.runInNewContext(text.slice(0, text.indexOf('const server=')) + '\nglobalThis.hostText=host;', context);
    return context.hostText;
}
const hosts = { '/': fixture('generation-library'), '/api-test': fixture('avatar-picker') };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="#567"/></svg>';
const server = createServer((req, res) => {
    let body, type = 'application/javascript';
    if (hosts[req.url]) { body = hosts[req.url]; type = 'text/html'; }
    else if (req.url.startsWith('/loading.svg?')) {
        const delay = Number(new URL(req.url, 'http://fixture').searchParams.get('delay')) || 0;
        const timer = setTimeout(() => res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(svg), delay);
        res.on('close', () => clearTimeout(timer));
        return;
    }
    else if (req.url === '/pending.png') { body = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'); type = 'image/png'; }
    else if (req.url.startsWith('/large.svg')) { body = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="1024"><rect width="512" height="1024" fill="#567"/></svg>'; type = 'image/svg+xml'; }
    else if (req.url === '/slow.svg') return; // Released with the browser context after the timeout scenario.
    else if (req.url === '/scripts/i18n.js') body = 'export const t=(s,...v)=>String.raw({raw:s},...v);export const translate=s=>s;';
    else if (req.url === '/scripts/popup.js') body = 'export class Popup{static show={confirm:async()=>false,input:async()=>window.fixtureInput||null};}';
    else if (req.url.startsWith(prefix)) {
        const file = path.resolve(root, decodeURIComponent(req.url.slice(prefix.length)));
        if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
        try { body = fs.readFileSync(file); } catch { return res.writeHead(404).end(); }
        if (file.endsWith('.css')) type = 'text/css';
    } else if (/^\/(fast.svg|user\/images|thumbnail|User(?:%20| )Avatars)/.test(req.url)) { body = svg; type = 'image/svg+xml'; }
    else return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': type }); res.end(body);
});
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'chromium' ? { channel: process.env.IIG_BROWSER_CHANNEL || 'msedge' } : {}) });
    const report = { engine, scenarioFilter: process.env.IIG_UI_SCENARIO_FILTER || null, checks: [], failures: [], evidence: {} };
    const open = async (url = '/') => {
        const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
        await page.addInitScript(() => {
            // Observe the document fallback without changing its encoded pixels.
            window.wrapPreviewEncoder = wrap => {
                const encode = HTMLCanvasElement.prototype.toBlob;
                HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
                    Promise.resolve(wrap.call(this, () => new Promise(resolve => encode.call(this, resolve, ...args))))
                        .then(callback, () => callback(null));
                };
            };
        });
        await page.goto('http://127.0.0.1:' + server.address().port + url);
        await page.waitForFunction(() => window.ready);
        return page;
    };
    const scenario = async (name, run) => {
        if (scenarioFilter && !scenarioFilter.test(name)) return;
        try { await run(); report.checks.push(name); }
        catch (error) { report.failures.push({ name, error: String(error) }); }
    };
    // Scroll ownership failures: blank cached rows, unbounded leases, stale LRU order,
    // canceled upgrades replacing retained images, and ownership of fallback originals.
    const scrollPreviews = async (page, options = {}) => {
        await page.evaluate(async ({ prefix, count = 3, width = 120, large = false, fallback = '' }) => {
            const images = await import(prefix + 'src/libraryImages.js');
            const section = document.getElementById('iig_characters_section');
            section.closest('details').open = false;
            images.observeLibraryImages();
            window.scrollWork = { requests: 0, encodes: 0, mutations: 0, exits: [], revoked: [] };
            const open = XMLHttpRequest.prototype.open;
            const unobserve = ResizeObserver.prototype.unobserve, revoke = URL.revokeObjectURL;
            XMLHttpRequest.prototype.open = function (method, url, ...args) {
                if (String(url).includes('scroll-preview')) scrollWork.requests++;
                return open.call(this, method, url, ...args);
            };
            wrapPreviewEncoder(async function (encode) {
                scrollWork.encodes++;
                if (fallback) return null;
                if (window.pausePreviewEncode) {
                    window.pausePreviewEncode = false;
                    const blob = await encode();
                    return new Promise(resolve => window.finishPreviewEncode = () => resolve(blob));
                }
                return encode();
            });
            ResizeObserver.prototype.unobserve = function (target, ...args) {
                const id = target.querySelector('img')?.id;
                if (id?.startsWith('scroll-preview')) scrollWork.exits.push(id);
                return unobserve.call(this, target, ...args);
            };
            URL.revokeObjectURL = function (url) { scrollWork.revoked.push(url); return revoke.call(this, url); };
            if (fallback === 'blob') window.foreignOriginal = URL.createObjectURL(new Blob([
                '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="#567"/></svg>',
            ], { type: 'image/svg+xml' }));
            section.innerHTML = '<div id="preview-scroll" style="position:relative;height:140px;overflow:auto">' + Array.from({ length: count }, (_, i) => {
                const src = i === 0 && fallback === 'blob' ? foreignOriginal : `/${large ? 'large' : 'fast'}.svg?scroll-preview=${i}`;
                return `<div style="width:${width}px;height:120px;margin-bottom:360px"><img id="scroll-preview-${i}" data-iig-library-src="${src}" data-iig-full-src="${src}" style="width:100%;height:100%;object-fit:contain"></div>`;
            }).join('') + '</div>';
            new MutationObserver(records => scrollWork.mutations += records.length).observe(section, { subtree: true, attributes: true, attributeFilter: ['src'] });
            section.closest('details').open = true;
            section.scrollIntoView({ block: 'start' });
            images.observeLibraryImages();
        }, { prefix, ...options });
    };
    const previewReady = (page, index) => page.waitForFunction(index => {
        const image = document.getElementById('scroll-preview-' + index);
        return image.hasAttribute('src') && image.complete && image.naturalWidth > 0;
    }, index);
    const scrollToPreview = async (page, index, previous) => {
        await page.evaluate(index => {
            scrollWork.exits.length = 0;
            document.getElementById('preview-scroll').scrollTop = document.getElementById('scroll-preview-' + index).parentElement.offsetTop;
        }, index);
        await page.waitForFunction(previous => scrollWork.exits.includes('scroll-preview-' + previous), previous);
    };
    // Loading failures: one slow download blocks siblings or cached rows, duplicate
    // requests/decodes grow memory, speculative originals compete with previews,
    // and modal/collapse transitions leak work or leave the queue stalled.
    const loadingPreviews = async (page, sources) => {
        await page.evaluate(async ({ prefix, sources }) => {
            const module = await import(prefix + 'src/libraryImages.js');
            const section = document.getElementById('iig_characters_section');
            section.closest('details').open = false;
            module.observeLibraryImages();
            if (!window.loadingWork) {
                window.loadingWork = { active: 0, peak: 0, encodes: 0, activeEncodes: 0, peakEncodes: 0, requests: [], warmups: [] };
                const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
                XMLHttpRequest.prototype.open = function (method, url, ...args) { this.loadingSource = String(url); return open.call(this, method, url, ...args); };
                XMLHttpRequest.prototype.send = function (...args) {
                    if (this.loadingSource.startsWith('/loading.svg?')) {
                        const request = { source: this.loadingSource, started: performance.now() };
                        loadingWork.requests.push(request);
                        loadingWork.peak = Math.max(loadingWork.peak, ++loadingWork.active);
                        this.addEventListener('loadend', () => { loadingWork.active--; request.finished = performance.now(); request.status = this.status; }, { once: true });
                    }
                    return send.apply(this, args);
                };
                wrapPreviewEncoder(async function (encode) {
                    if (!new Error().stack.includes('/src/libraryImages.js')) return encode();
                    loadingWork.encodes++;
                    loadingWork.peakEncodes = Math.max(loadingWork.peakEncodes, ++loadingWork.activeEncodes);
                    const blob = await encode();
                    return new Promise(resolve => {
                        const finish = () => { loadingWork.activeEncodes--; resolve(blob); };
                        if (window.pauseLoadingEncode) { window.pauseLoadingEncode = false; window.finishLoadingEncode = finish; }
                        else finish();
                    });
                });
                const Native = Image;
                window.Image = function (...args) {
                    const image = new Native(...args);
                    const decode = image.decode;
                    image.decode = function () {
                        if (this.getAttribute('src')?.startsWith('/loading.svg?')) loadingWork.warmups.push(performance.now());
                        return decode.call(this);
                    };
                    return image;
                };
            }
            window.loadingStartedAt = performance.now();
            section.innerHTML = '<div id="loading-gallery" data-iig-lightbox-gallery style="display:grid;grid-template-columns:repeat(3,100px);gap:4px">' + sources.map((source, i) =>
                `<div style="width:100px;height:100px"><img id="loading-preview-${i}" data-iig-library-src="${source}" data-iig-full-src="${source}" data-iig-lightbox loading="lazy" decoding="async" fetchpriority="low" style="width:100%;height:100%;object-fit:contain"></div>`).join('') + '</div>';
            for (const image of section.querySelectorAll('#loading-gallery img')) image.addEventListener('load', () => image.dataset.readyAt = performance.now());
            section.closest('details').open = true;
            section.scrollIntoView({ block: 'start' });
            module.observeLibraryImages();
        }, { prefix, sources });
    };
    const loadingReady = page => page.waitForFunction(() => [...document.querySelectorAll('#loading-gallery img')].every(image => image.dataset.readyAt && image.naturalWidth > 0));
    try {
        // Worker failures: unavailable/crashed workers, retained native resources,
        // altered alpha/pixels, and late replies updating canceled gallery owners.
        for (const mode of ['native', 'unavailable', 'crash', 'cancel', 'scroll-cancel', 'progressive', 'prefetch']) await scenario(`raster preview ownership: ${mode}`, async () => {
            const page = await open();
            try {
                await page.evaluate(async ({ prefix, mode }) => {
                    const supported = typeof Worker === 'function' && typeof OffscreenCanvas === 'function';
                    window.rasterWorkers = { supported, created: 0, terminated: 0, foregroundFullDecodes: 0, earlyStarts: 0 };
                    window.foregroundFrames = 0;
                    if (!supported && ['unavailable', 'crash'].includes(mode)) window.OffscreenCanvas = function () {};
                    wrapPreviewEncoder(async function (encode) {
                        if (mode === 'native' && foregroundFrames < 2) rasterWorkers.earlyStarts++;
                        const blob = await encode();
                        if (!supported && !window.allowWorkerReplies && ['cancel', 'scroll-cancel', 'progressive', 'prefetch'].includes(mode)) {
                            return new Promise(resolve => window.finishWorkerReply = () => resolve(blob));
                        }
                        return blob;
                    });
                    const decode = HTMLImageElement.prototype.decode;
                    HTMLImageElement.prototype.decode = function () {
                        if (this.hasAttribute('data-iig-full-src')) rasterWorkers.foregroundFullDecodes++;
                        return decode.call(this);
                    };
                    const Native = Worker;
                    window.Worker = function (...args) {
                        if (mode === 'unavailable') throw new Error('Worker unavailable');
                        const worker = new Native(...args), terminate = worker.terminate.bind(worker);
                        if (mode === 'native' && foregroundFrames < 2) rasterWorkers.earlyStarts++;
                        rasterWorkers.created++;
                        worker.terminate = () => { rasterWorkers.terminated++; terminate(); };
                        if (mode === 'crash') worker.postMessage = () => queueMicrotask(() => worker.dispatchEvent(new Event('error')));
                        if (['cancel', 'scroll-cancel', 'progressive', 'prefetch'].includes(mode)) worker.addEventListener('message', event => {
                            if (window.allowWorkerReplies) return;
                            event.stopImmediatePropagation();
                            window.finishWorkerReply = () => worker.onmessage?.(event);
                        });
                        return worker;
                    };
                    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
                    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 256, 128);
                    const original = canvas.toDataURL('image/png');
                    const section = document.getElementById('iig_characters_section');
                    section.innerHTML = `<div style="width:128px;height:128px"><img id="raster-worker-preview" data-iig-library-src="${original}" data-iig-full-src="${original}" style="width:100%;height:100%"></div>`;
                    section.querySelector('img').addEventListener('load', () => requestAnimationFrame(() => {
                        foregroundFrames++; requestAnimationFrame(() => foregroundFrames++);
                    }), { once: true });
                    section.scrollIntoView({ block: 'start' });
                    if (mode === 'prefetch') Object.assign(section.firstElementChild.style, { position: 'fixed', top: (innerHeight + 40) + 'px', left: '20px' });
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, { prefix, mode });
                if (mode === 'progressive') {
                    await page.waitForFunction(() => typeof finishWorkerReply === 'function');
                    await page.waitForFunction(() => { const image = document.getElementById('raster-worker-preview'); return image.complete && image.naturalWidth === 256; });
                    await page.evaluate(() => finishWorkerReply());
                }
                if (mode === 'prefetch') {
                    await page.waitForFunction(() => typeof finishWorkerReply === 'function');
                    assert.equal(await page.locator('#raster-worker-preview').getAttribute('src'), null, 'Offscreen preparation does not display a full original');
                    await page.evaluate(() => { document.getElementById('raster-worker-preview').parentElement.style.top = '60px'; finishWorkerReply(); });
                }
                if (mode === 'cancel' || mode === 'scroll-cancel') {
                    await page.waitForFunction(() => typeof finishWorkerReply === 'function');
                    if (mode === 'scroll-cancel') {
                        await page.locator('#raster-worker-preview').evaluate(image => image.parentElement.style.transform = 'translateY(4000px)');
                        await page.waitForFunction(() => !document.getElementById('raster-worker-preview').getAttribute('src'));
                        await page.waitForFunction(() => rasterWorkers.terminated === rasterWorkers.created, null, { timeout: 2000 });
                    }
                    await page.evaluate(async ({ prefix, mode }) => {
                        const section = document.getElementById('iig_characters_section');
                        if (mode === 'cancel') {
                            section.closest('details').open = false;
                            (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                        }
                        finishWorkerReply();
                    }, { prefix, mode });
                    assert.equal(await page.locator('#raster-worker-preview').getAttribute('src'), null);
                    if (mode === 'cancel') {
                        await page.evaluate(async prefix => {
                            window.allowWorkerReplies = true;
                            const section = document.getElementById('iig_characters_section');
                            section.closest('details').open = true;
                            (await import(prefix + 'src/libraryImages.js')).observeLibraryImages({ visibilityOnly: true });
                        }, prefix);
                        await page.waitForFunction(() => {
                            const image = document.getElementById('raster-worker-preview');
                            return image.src.startsWith('blob:') && image.complete && image.naturalWidth === 128;
                        }, null, { timeout: 3000 });
                    }
                } else {
                    await page.waitForFunction(() => { const image = document.getElementById('raster-worker-preview'); return image.src.startsWith('blob:') && image.complete && image.naturalWidth === 128; });
                    const pixels = await page.evaluate(() => {
                        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
                        const ctx = canvas.getContext('2d'); ctx.drawImage(document.getElementById('raster-worker-preview'), 0, 0);
                        return [...ctx.getImageData(32, 32, 1, 1).data, ...ctx.getImageData(32, 96, 1, 1).data];
                    });
                    assert.deepEqual(pixels, [255, 0, 0, 255, 0, 0, 0, 0]);
                    await page.waitForFunction(() => rasterWorkers.terminated === rasterWorkers.created, null, { timeout: 2500 });
                    await page.screenshot({ path: path.join(artifacts, `raster-worker-${mode}.png`) });
                }
                await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
                const resources = await page.evaluate(() => rasterWorkers);
                assert.equal(resources.created, mode === 'unavailable' ? 0 : Number(resources.supported || mode === 'crash') * (mode === 'cancel' ? 2 : 1));
                assert.equal(resources.terminated, resources.created);
                assert.equal(resources.foregroundFullDecodes, 0, 'Foreground display leaves decode sizing to the browser');
                assert.equal(resources.earlyStarts, 0, 'Native display gets two frames before background encoding');
                report.evidence['rasterWorker-' + mode] = resources;
            } finally { await page.close(); }
        });
        for (const width of [390, 1100]) await scenario(`preview loading overlaps downloads without concurrent encodes at ${width}px`, async () => {
            const page = await open();
            try {
                await page.setViewportSize({ width, height: 950 });
                await loadingPreviews(page, Array.from({ length: 12 }, (_, i) => `/loading.svg?id=batch-${i}&delay=200`));
                await loadingReady(page);
                const result = await page.evaluate(() => ({
                    ...loadingWork, elapsedMs: Math.max(...[...document.querySelectorAll('#loading-gallery img')].map(image => Number(image.dataset.readyAt))) - loadingStartedAt,
                }));
                report.evidence['loadingBatch' + width] = result;
                await page.screenshot({ path: path.join(artifacts, `loading-batch-${width}.png`) });
                assert.ok(result.peak > 1 && result.peak <= 7, 'Six downloads plus a completed response awaiting loadend');
                assert.equal(result.peakEncodes, 1, 'Only one preview encoder owns a decoded image at a time');
                assert.equal(result.requests.length, 12);
                assert.equal(result.encodes, 12);
                assert.equal(result.warmups.length, 0, 'Speculative originals wait until visible previews finish');
            } finally { await page.close(); }
        });
        await scenario('preview loading shows fast siblings before a slow download finishes', async () => {
            const page = await open();
            try {
                await loadingPreviews(page, ['/loading.svg?id=slow-first&delay=1600', '/loading.svg?id=fast-second&delay=40', '/loading.svg?id=fast-third&delay=40']);
                await loadingReady(page);
                const result = await page.evaluate(() => ({
                    slowFinished: loadingWork.requests.find(request => request.source.includes('slow-first')).finished - loadingStartedAt,
                    fastReady: Number(document.getElementById('loading-preview-1').dataset.readyAt) - loadingStartedAt,
                    warmups: loadingWork.warmups.length,
                }));
                report.evidence.loadingSlowSibling = result;
                assert.ok(result.fastReady < result.slowFinished, 'A fast visible tile does not wait for an unrelated download');
                assert.equal(result.warmups, 0);
            } finally { await page.close(); }
        });
        await scenario('preview loading restores cached rows while a fresh download is pending', async () => {
            const page = await open();
            try {
                const cached = '/loading.svg?id=cached&delay=40';
                await loadingPreviews(page, [cached]);
                await loadingReady(page);
                const url = await page.locator('#loading-preview-0').getAttribute('src');
                await loadingPreviews(page, ['/loading.svg?id=uncached&delay=1200', cached]);
                await loadingReady(page);
                const result = await page.evaluate(() => ({
                    cachedReady: Number(document.getElementById('loading-preview-1').dataset.readyAt) - loadingStartedAt,
                    downloadFinished: loadingWork.requests.find(request => request.source.includes('uncached')).finished - loadingStartedAt,
                    cachedRequests: loadingWork.requests.filter(request => request.source.includes('id=cached')).length,
                }));
                report.evidence.loadingCachedRow = result;
                assert.ok(result.cachedReady < result.downloadFinished);
                assert.equal(result.cachedRequests, 1);
                assert.equal(await page.locator('#loading-preview-1').getAttribute('src'), url);
            } finally { await page.close(); }
        });
        await scenario('preview loading deduplicates owners and bounds downloaded work behind a paused encoder', async () => {
            const page = await open();
            try {
                await page.evaluate(() => window.pauseLoadingEncode = true);
                const shared = '/loading.svg?id=shared&delay=40';
                await loadingPreviews(page, [shared, shared, shared, ...Array.from({ length: 7 }, (_, i) => `/loading.svg?id=distinct-${i}&delay=40`)]);
                await page.waitForFunction(() => typeof finishLoadingEncode === 'function');
                await page.waitForTimeout(200);
                const pending = await page.evaluate(() => ({ requests: loadingWork.requests.length, peakEncodes: loadingWork.peakEncodes, encodes: loadingWork.encodes }));
                await page.evaluate(() => finishLoadingEncode());
                await loadingReady(page);
                const result = await page.evaluate(pending => ({ pending, peak: loadingWork.peak, requests: loadingWork.requests.length, encodes: loadingWork.encodes,
                    sharedUrls: new Set([0, 1, 2].map(i => document.getElementById('loading-preview-' + i).getAttribute('src'))).size,
                }), pending);
                report.evidence.loadingDeduplicated = result;
                assert.ok(pending.requests <= 12 && pending.requests > 1);
                assert.equal(pending.encodes, 1);
                assert.equal(result.requests, 8);
                assert.equal(result.encodes, 8);
                assert.equal(result.sharedUrls, 1);
            } finally { await page.close(); }
        });
        await scenario('preview loading parks completed downloads under the viewer and resumes after closing', async () => {
            const page = await open();
            try {
                await loadingPreviews(page, Array.from({ length: 8 }, (_, i) => `/loading.svg?id=modal-${i}&delay=300`));
                await page.waitForFunction(() => loadingWork.active > 0);
                await page.locator('#loading-preview-0').evaluate(image => image.click());
                const before = await page.evaluate(() => loadingWork.requests.length);
                await page.waitForTimeout(400);
                assert.equal(await page.evaluate(() => loadingWork.encodes), 0);
                assert.equal(await page.evaluate(() => loadingWork.requests.length), before);
                await page.evaluate(() => {
                    document.getElementById('iig_lightbox').close();
                    document.getElementById('loading-preview-0').click();
                });
                await page.waitForTimeout(200);
                assert.equal(await page.evaluate(() => loadingWork.encodes), 0);
                await page.locator('.iig-lightbox-close').evaluate(button => { window.loadingClosedAt = performance.now(); button.click(); });
                await loadingReady(page);
                const delay = await page.evaluate(() => Math.min(...[...document.querySelectorAll('#loading-gallery img')].map(image => Number(image.dataset.readyAt))) - loadingClosedAt);
                report.evidence.loadingModalResume = { requestsBeforeOpen: before, delayMs: delay };
                assert.ok(delay >= 140);
            } finally { await page.close(); }
        });
        await scenario('preview loading cancels replaced owners and releases all download slots', async () => {
            const page = await open();
            try {
                await loadingPreviews(page, Array.from({ length: 8 }, (_, i) => `/loading.svg?id=removed-${i}&delay=1400`));
                await page.waitForFunction(() => loadingWork.active > 0);
                await page.evaluate(() => window.removedLoadingImages = [...document.querySelectorAll('#loading-gallery img')]);
                await loadingPreviews(page, ['/loading.svg?id=replacement&delay=40']);
                await loadingReady(page);
                await page.waitForFunction(() => loadingWork.active === 0);
                const result = await page.evaluate(() => ({ requests: loadingWork.requests, staleSources: removedLoadingImages.filter(image => image.hasAttribute('src')).length,
                    readyMs: Number(document.getElementById('loading-preview-0').dataset.readyAt) - loadingStartedAt,
                }));
                report.evidence.loadingReplacement = result;
                assert.equal(result.staleSources, 0);
                assert.ok(result.requests.filter(request => request.source.includes('removed')).every(request => request.status === 0));
                assert.ok(result.readyMs < 1000);
            } finally { await page.close(); }
        });
        for (const width of [390, 1100]) await scenario(`scroll previews retain decoded rows on round trips at ${width}px`, async () => {
            const page = await open();
            try {
                await page.setViewportSize({ width, height: 950 });
                await scrollPreviews(page);
                await previewReady(page, 0);
                const first = await page.locator('#scroll-preview-0').getAttribute('src');
                const retained = [];
                for (let i = 0; i < 3; i++) {
                    await scrollToPreview(page, 1, 0);
                    await previewReady(page, 1);
                    retained.push(await page.locator('#scroll-preview-0').getAttribute('src') === first);
                    await scrollToPreview(page, 0, 1);
                    await previewReady(page, 0);
                }
                const result = await page.evaluate(() => ({ requests: scrollWork.requests, encodes: scrollWork.encodes, mutations: scrollWork.mutations }));
                report.evidence['scrollRoundTrips' + width] = { ...result, retained };
                await page.screenshot({ path: path.join(artifacts, `scroll-round-trips-${width}.png`) });
                assert.deepEqual(retained, [true, true, true], 'Offscreen cached rows keep their decoded source');
                assert.deepEqual(result, { requests: 2, encodes: 2, mutations: 2 }, 'Returning to cached rows does not rewrite src or enter the preview worker');
                await page.evaluate(async prefix => {
                    window.detachedPreviews = [...document.querySelectorAll('#preview-scroll img')];
                    document.getElementById('preview-scroll').remove();
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                assert.equal(await page.evaluate(() => detachedPreviews.every(image => !image.hasAttribute('src'))), true);
            } finally { await page.close(); }
        });
        for (const [limit, width, large] of [[96, 120, false], [8, 512, true]]) await scenario(`scroll previews enforce the ${large ? 'pixel' : 'entry'} budget and refresh LRU on return`, async () => {
            const page = await open();
            try {
                await scrollPreviews(page, { count: limit + 4, width, large });
                const urls = [];
                let previous = 0;
                for (let i = 0; i < limit + 4; i++) {
                    if (i) await scrollToPreview(page, i, previous);
                    await previewReady(page, i);
                    urls.push(await page.locator('#scroll-preview-' + i).getAttribute('src'));
                    previous = i;
                    if (i === limit - 1) {
                        await scrollToPreview(page, 0, i);
                        await previewReady(page, 0);
                        previous = 0;
                    }
                }
                await page.waitForFunction(urls => urls.filter(url => scrollWork.revoked.includes(url)).length >= 4, urls);
                const result = await page.evaluate(() => {
                    const retained = [...document.querySelectorAll('#preview-scroll img')].filter(image => image.hasAttribute('src'));
                    return { entries: retained.length, pixels: retained.reduce((sum, image) => sum + image.naturalWidth * image.naturalHeight, 0), ids: retained.map(image => image.id) };
                });
                report.evidence['scrollBudget' + limit] = result;
                assert.equal(result.entries, limit, 'Offscreen DOM owners share the bounded cache, not a second unbounded cache');
                assert.ok(result.pixels <= 4 * 1024 * 1024);
                assert.ok(result.ids.includes('scroll-preview-0'), 'Returning to a row renews its cache priority');
                assert.ok(!result.ids.includes('scroll-preview-1'), 'The least recently viewed row releases its source');
                await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
                await page.waitForFunction(urls => urls.every(url => scrollWork.revoked.includes(url)), urls);
                assert.equal(await page.evaluate(() => [...document.querySelectorAll('#preview-scroll img')].every(image => !image.hasAttribute('src'))), true);
            } finally { await page.close(); }
        });
        await scenario('scroll previews retain the previous image while canceling an offscreen size upgrade', async () => {
            const page = await open();
            try {
                await scrollPreviews(page);
                await previewReady(page, 0);
                const first = await page.locator('#scroll-preview-0').getAttribute('src');
                await page.evaluate(() => {
                    window.pausePreviewEncode = true;
                    document.getElementById('scroll-preview-0').parentElement.style.width = '300px';
                });
                await page.waitForFunction(() => typeof finishPreviewEncode === 'function');
                await scrollToPreview(page, 1, 0);
                const whilePending = await page.locator('#scroll-preview-0').getAttribute('src');
                await page.evaluate(() => finishPreviewEncode());
                await previewReady(page, 1);
                const afterCanceled = await page.locator('#scroll-preview-0').getAttribute('src');
                await scrollToPreview(page, 0, 1);
                await page.waitForFunction(first => {
                    const image = document.getElementById('scroll-preview-0');
                    return image.getAttribute('src') !== first && image.complete && image.naturalWidth === 180;
                }, first);
                report.evidence.scrollUpgrade = { retainedWhilePending: whilePending === first, retainedAfterCancel: afterCanceled === first, upgradedOnReturn: true };
                assert.equal(whilePending, first);
                assert.equal(afterCanceled, first);
            } finally { await page.close(); }
        });
        await scenario('scroll previews release evicted shared URLs only after their last visible owner leaves', async () => {
            const page = await open();
            try {
                await scrollPreviews(page, { count: 10, width: 512, large: true });
                await previewReady(page, 0);
                const first = await page.locator('#scroll-preview-0').getAttribute('src');
                await page.evaluate(async prefix => {
                    const scroll = document.getElementById('preview-scroll');
                    const copy = document.getElementById('scroll-preview-0').parentElement.cloneNode(true);
                    copy.querySelector('img').id = 'scroll-preview-copy';
                    copy.querySelector('img').removeAttribute('src');
                    scroll.append(copy);
                    Object.assign(copy.style, { position: 'absolute', top: '0px', marginBottom: '0px' });
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                await previewReady(page, 'copy');
                assert.equal(await page.locator('#scroll-preview-copy').getAttribute('src'), first);
                await page.locator('#preview-scroll').evaluate(scroll => {
                    for (const row of scroll.children) Object.assign(row.style, { position: 'absolute', top: '0px', marginBottom: '0px' });
                });
                await previewReady(page, 9);
                await page.waitForFunction(() => scrollWork.encodes >= 10);
                await page.locator('#scroll-preview-0').evaluate(image => image.parentElement.style.display = 'none');
                await page.waitForFunction(() => scrollWork.exits.includes('scroll-preview-0'));
                assert.equal(await page.locator('#scroll-preview-0').getAttribute('src'), null);
                assert.equal(await page.locator('#scroll-preview-copy').getAttribute('src'), first);
                assert.equal(await page.evaluate(first => scrollWork.revoked.includes(first), first), false);
                await page.locator('#scroll-preview-copy').evaluate(image => image.parentElement.style.display = 'none');
                await page.waitForFunction(first => scrollWork.revoked.includes(first), first);
                report.evidence.scrollSharedLease = { visibleOwnerPreserved: true, revokedAfterLastOwner: true };
            } finally { await page.close(); }
        });
        for (const fallback of ['http', 'blob']) await scenario(`scroll previews release fallback ${fallback} originals outside the viewport`, async () => {
            const page = await open();
            try {
                await scrollPreviews(page, { fallback });
                await previewReady(page, 0);
                const source = await page.locator('#scroll-preview-0').getAttribute('data-iig-library-src');
                assert.equal(await page.locator('#scroll-preview-0').getAttribute('src'), source);
                await scrollToPreview(page, 1, 0);
                assert.equal(await page.locator('#scroll-preview-0').getAttribute('src'), null);
                if (fallback === 'blob') {
                    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
                    assert.equal(await page.evaluate(async source => !scrollWork.revoked.includes(source) && (await fetch(source)).ok, source), true, 'The preview cache does not own the original Blob URL');
                }
                report.evidence['scrollFallback' + fallback] = { offscreenOriginalReleased: true };
            } finally { await page.close(); }
        });
        await scenario('contained persona lists preserve narrow scrolling and editor selection', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    const original = fetch;
                    window.fetch = (url, init) => String(url) === '/api/avatars/get'
                        ? Promise.resolve(Response.json(Array.from({ length: 100 }, (_, i) => `person-${String(i).padStart(3, '0')}.png`)))
                        : original(url, init);
                    await (await import(prefix + 'src/avatarPicker.js')).fetchUserAvatars();
                }, prefix);
                for (const width of [390, 1100]) {
                    await page.setViewportSize({ width, height: 900 });
                    await page.locator('[data-library-tab="user"]').click();
                    await page.waitForFunction(() => document.querySelectorAll('.iig-library-entity[data-library-kind="user"]').length === 80);
                    const list = page.locator('.iig-library-entities');
                    assert.ok((await list.evaluate(e => getComputedStyle(e).contain)).includes('layout'));
                    const last = page.locator('.iig-library-entity').last();
                    const key = await last.getAttribute('data-library-key');
                    await last.scrollIntoViewIfNeeded();
                    await last.click();
                    await page.waitForFunction(key => document.querySelector('.iig-library-editor')?.dataset.libraryKey === key, key);
                    const geometry = await list.evaluate(e => ({ scrollTop: e.scrollTop, clientHeight: e.clientHeight, scrollHeight: e.scrollHeight, width: e.getBoundingClientRect().width }));
                    assert.ok(geometry.scrollTop > 0 && geometry.scrollHeight > geometry.clientHeight && geometry.width > 0);
                    await page.locator('.iig-library-primary-description').fill('Persona description remains editable');
                    await page.locator('.iig-library-primary-description').evaluate(e => { e.style.height = '240px'; });
                    assert.equal(await page.locator('.iig-library-primary-description').inputValue(), 'Persona description remains editable');
                    report.evidence['contained-personas-' + width] = { key, ...geometry };
                    await page.screenshot({ path: path.join(artifacts, `contained-personas-${width}.png`) });
                    await page.locator('[data-library-tab="char"]').click();
                }
            } finally { await page.close(); }
        });
        await scenario('Styles clicks retain closed avatar menus and close only open menus', async () => {
            const page = await open('/api-test');
            try {
                const result = await page.evaluate(async prefix => {
                    const { closeUserAvatarDropdowns } = await import(prefix + 'src/avatarPicker.js');
                    app.settings.styles = [{ id: 'style-click', name: 'Style click', value: 'detailed' }];
                    (await import(prefix + 'src/promptLibraryUi.js')).renderStyleSettings();
                    const roots = [...document.querySelectorAll('.iig-avatar-dropdown')];
                    if (roots.length !== 2) throw new Error('Expected both provider avatar menus');
                    closeUserAvatarDropdowns();
                    const row = document.querySelector('.iig-style-item');
                    if (!row) throw new Error('Expected a rendered style row');
                    const observer = new MutationObserver(() => {});
                    roots.forEach(root => observer.observe(root, { attributes: true, attributeFilter: ['class'] }));
                    const toggle = document.getElementById('iig_styles_section').closest('details').querySelector('summary');
                    for (let i = 0; i < 3; i++) toggle.click();
                    const closedWrites = observer.takeRecords().length;
                    roots.forEach(root => root.classList.add('open'));
                    observer.takeRecords();
                    roots[0].click();
                    const insidePreservesOpen = roots.every(root => root.classList.contains('open'));
                    observer.takeRecords();
                    toggle.click();
                    const openWrites = observer.takeRecords().length;
                    observer.disconnect();
                    return { closedWrites, openWrites, insidePreservesOpen, allClosed: roots.every(root => !root.classList.contains('open')), sameStyleRow: document.querySelector('.iig-style-item') === row };
                }, prefix);
                report.evidence.stylesAvatarWrites = result;
                assert.equal(result.closedWrites, 0);
                assert.equal(result.openWrites, 2);
                assert.equal(result.insidePreservesOpen, true);
                assert.equal(result.allClosed, true);
                assert.equal(result.sameStyleRow, true);
            } finally { await page.close(); }
        });
        await scenario('HTML text and quoted attributes preserve names and descriptions without DOM allocation', async () => {
            const page = await open();
            try {
                const result = await page.evaluate(async prefix => {
                    const { sanitizeForHtml } = await import(prefix + 'src/utils.js');
                    const values = [null, undefined, false, 0, NaN, '', '&<>"\'', '&amp; &#39;', 'line\nnext\tend', '\u00a0\u2028\ud83d\udc3a', '<img src=x onerror="window.unexpectedMarkup=true">', '</textarea><script>window.unexpectedMarkup=true</script>'];
                    const oracle = document.createElement('div');
                    const parsed = document.createElement('div');
                    let checked = 0;
                    for (const value of values) {
                        oracle.textContent = value;
                        const expected = oracle.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                        if (sanitizeForHtml(value) !== expected) throw new Error('Escaping differs for ' + String(value));
                        parsed.innerHTML = `<span title="${sanitizeForHtml(value)}">${sanitizeForHtml(value)}</span>`;
                        if (parsed.querySelectorAll('*').length !== 1 || parsed.firstChild.textContent !== oracle.textContent || parsed.firstChild.title !== oracle.textContent) throw new Error('Markup round trip differs');
                        checked++;
                    }
                    const create = document.createElement;
                    let allocations = 0;
                    document.createElement = function (...args) {
                        if (new Error().stack.includes('sanitizeForHtml')) allocations++;
                        return create.apply(this, args);
                    };
                    try {
                        const context = SillyTavern.getContext();
                        context.characters = Array.from({ length: 100 }, (_, i) => ({ name: 'Name & <' + i + '> "quoted"', avatar: 'safe-' + i + '.png' }));
                        await app.library.renderCharacterLibrary(app.settings);
                        return { checked, allocations, rows: document.querySelectorAll('.iig-library-entity').length, title: [...document.querySelectorAll('.iig-library-entity strong')].find(title => title.textContent.startsWith('Name')).textContent, unexpectedMarkup: Boolean(window.unexpectedMarkup) };
                    } finally { document.createElement = create; }
                }, prefix);
                report.evidence.htmlEscaping = result;
                assert.equal(result.checked, 12);
                assert.equal(result.rows, 80);
                assert.ok(result.title.includes('& <'));
                assert.equal(result.unexpectedMarkup, false);
                assert.equal(result.allocations, 0);
                await page.screenshot({ path: path.join(artifacts, 'escaped-library.png') });
            } finally { await page.close(); }
        });
        for (const outcome of ['success', 'failure', 'cancel']) await scenario(`fallback preview URLs release their owner: ${outcome}`, async () => {
            const page = await open();
            try {
                await page.evaluate(async ({ prefix, outcome }) => {
                    const module = await import(prefix + 'src/libraryImages.js');
                    const section = document.getElementById('iig_characters_section');
                    section.closest('details').open = false;
                    module.observeLibraryImages();
                    window.previewLifecycle = { reads: 0, created: [], revoked: [], decoded: [], encodes: 0 };
                    const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
                    URL.createObjectURL = function (blob) { const url = create.call(this, blob); previewLifecycle.created.push(url); return url; };
                    URL.revokeObjectURL = function (url) { previewLifecycle.revoked.push(url); return revoke.call(this, url); };
                    const read = FileReader.prototype.readAsDataURL;
                    FileReader.prototype.readAsDataURL = function (...args) { previewLifecycle.reads++; return read.apply(this, args); };
                    wrapPreviewEncoder(function (encode) { previewLifecycle.encodes++; return encode(); });
                    const decode = HTMLImageElement.prototype.decode;
                    HTMLImageElement.prototype.decode = async function () {
                        if (this.isConnected) return decode.call(this);
                        previewLifecycle.decoded.push(this.src);
                        if (outcome === 'failure') throw new Error('Controlled decoder failure');
                        await decode.call(this);
                        if (outcome === 'cancel') await new Promise(resolve => window.completeFallback = resolve);
                    };
                    section.innerHTML = '<div style="width:120px;height:120px"><img id="fallback-preview" data-iig-library-src="/fast.svg" data-iig-full-src="/fast.svg" style="width:100%;height:100%"></div>';
                    section.closest('details').open = true;
                    section.scrollIntoView({ block: 'start' });
                    module.observeLibraryImages();
                }, { prefix, outcome });
                if (outcome === 'cancel') {
                    await page.waitForFunction(() => typeof completeFallback === 'function');
                    await page.evaluate(async prefix => {
                        document.getElementById('iig_characters_section').closest('details').open = false;
                        (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                        completeFallback();
                    }, prefix);
                } else {
                    await page.waitForFunction(outcome => {
                        const image = document.getElementById('fallback-preview');
                        return image.complete && image.naturalWidth > 0 && (outcome === 'failure' ? image.getAttribute('src') === '/fast.svg' : image.src.startsWith('blob:'));
                    }, outcome);
                    if (outcome === 'success') {
                        const rgba = await page.evaluate(() => {
                            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
                            const ctx = canvas.getContext('2d'); ctx.drawImage(document.getElementById('fallback-preview'), 0, 0, 1, 1);
                            return [...ctx.getImageData(0, 0, 1, 1).data];
                        });
                        assert.deepEqual(rgba, [85, 102, 119, 255]);
                    }
                    await page.evaluate(async prefix => {
                        document.getElementById('iig_characters_section').closest('details').open = false;
                        (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                    }, prefix);
                }
                await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
                await page.waitForFunction(() => previewLifecycle.created.every(url => previewLifecycle.revoked.includes(url)));
                const result = await page.evaluate(() => ({ ...previewLifecycle, released: !document.getElementById('fallback-preview').hasAttribute('src') }));
                report.evidence['fallback-' + outcome] = result;
                assert.equal(result.reads, 0);
                assert.equal(result.decoded.length, 1);
                assert.ok(result.decoded[0].startsWith('blob:'));
                assert.equal(result.created.length, outcome === 'success' ? 2 : 1);
                assert.equal(result.encodes, outcome === 'success' ? 1 : 0);
                assert.equal(result.released, true);
            } finally { await page.close(); }
        });
        await scenario('PNG previews use readback-oriented canvases and preserve rendered pixels', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    window.previewContexts = [];
                    const getContext = HTMLCanvasElement.prototype.getContext;
                    HTMLCanvasElement.prototype.getContext = function (kind, options) { if (new Error().stack.includes('/src/libraryImages.js')) previewContexts.push(options || {}); return getContext.call(this, kind, options); };
                    const section = document.getElementById('iig_characters_section');
                    section.innerHTML = '<div style="width:120px;height:120px"><img id="readback-preview" data-iig-library-src="/fast.svg" data-iig-full-src="/fast.svg" style="width:100%;height:100%"></div>';
                    section.scrollIntoView({ block: 'start' });
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                await page.waitForFunction(() => document.getElementById('readback-preview').src.startsWith('blob:') && document.getElementById('readback-preview').complete && document.getElementById('readback-preview').naturalWidth > 0);
                const result = await page.evaluate(() => {
                    const image = document.getElementById('readback-preview');
                    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
                    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 1, 1);
                    return { rgba: [...context.getImageData(0, 0, 1, 1).data], source: image.getAttribute('data-iig-full-src'), readback: previewContexts.length > 0 && previewContexts.every(options => options.willReadFrequently === true) };
                });
                assert.deepEqual(result, { rgba: [85, 102, 119, 255], source: '/fast.svg', readback: true });
                report.evidence.previewReadback = result;
            } finally { await page.close(); }
        });
        await scenario('preview queue waits through viewer reopen and resumes after closing', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    window.Worker = undefined;
                    const create = createImageBitmap;
                    const openRequest = XMLHttpRequest.prototype.open;
                    window.secondPreviewRequests = 0;
                    window.queuedPreviewEncodes = 0;
                    wrapPreviewEncoder(function (encode) { if (this.width === 41) queuedPreviewEncodes++; return encode(); });
                    XMLHttpRequest.prototype.open = function (method, url, ...args) { if (url === '/fast.svg') { secondPreviewRequests++; window.secondPreviewStartedAt = performance.now(); } return openRequest.call(this, method, url, ...args); };
                    window.createImageBitmap = async (...args) => {
                        if (window.finishPreviewDecode) return create(...args);
                        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 41;
                        window.pendingBitmap = await create(canvas);
                        await new Promise(resolve => window.finishPreviewDecode = resolve);
                        window.previewBitmapReady = true;
                        return pendingBitmap;
                    };
                    const section = document.getElementById('iig_characters_section');
                    section.innerHTML = '<div data-iig-lightbox-gallery style="display:flex;height:140px"><div style="width:120px;height:120px"><img id="queued-viewer-image" data-iig-library-src="/pending.png" data-iig-full-src="/pending.png" data-iig-lightbox style="width:100%;height:100%"></div><div style="width:120px;height:120px;display:none"><img id="queued-preview" data-iig-library-src="/fast.svg" data-iig-full-src="/fast.svg" style="width:100%;height:100%"></div></div>';
                    section.scrollIntoView({ block: 'start' });
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                await page.waitForFunction(() => typeof finishPreviewDecode === 'function', null, { timeout: 3000 });
                await page.evaluate(() => {
                    document.getElementById('queued-viewer-image').click();
                    document.getElementById('queued-preview').parentElement.style.display = 'block';
                    document.getElementById('iig_lightbox').close();
                    document.getElementById('queued-viewer-image').click();
                    finishPreviewDecode();
                });
                await page.waitForFunction(() => window.previewBitmapReady, null, { timeout: 3000 });
                await page.waitForTimeout(200);
                assert.equal(await page.evaluate(() => queuedPreviewEncodes), 0, 'An in-flight bitmap must not start raster work over the viewer');
                assert.equal(await page.evaluate(() => secondPreviewRequests), 0);
                await page.locator('.iig-lightbox-close').evaluate(button => { window.viewerClosedAt = performance.now(); button.click(); });
                await page.waitForFunction(() => secondPreviewRequests === 1 && document.getElementById('queued-preview').complete && document.getElementById('queued-preview').naturalWidth > 0, null, { timeout: 3000 });
                const delay = await page.evaluate(() => secondPreviewStartedAt - viewerClosedAt);
                report.evidence.previewResumeDelayMs = delay;
                assert.ok(delay >= 140, 'Queued previews resume after an idle window, not between rapid viewer openings');
                assert.equal(await page.evaluate(() => pendingBitmap.width), 0);
                report.evidence.viewerQueueResumeRequests = 1;
            } finally { await page.close(); }
        });
        await scenario('viewer close resumes previews without rescanning unchanged library rows', async () => {
            const page = await open();
            try {
                await page.locator('.iig-library-generation-item').first().evaluate(element => element.scrollIntoView({ block: 'center' }));
                await page.waitForFunction(() => document.querySelector('.iig-library-generation-item img').naturalWidth > 0);
                const scans = await page.evaluate(async () => {
                    const section = document.getElementById('iig_characters_section');
                    const query = section.querySelectorAll;
                    let scans = 0;
                    section.querySelectorAll = function (selector, ...args) { if (selector === 'img[data-iig-library-src]') scans++; return query.call(this, selector, ...args); };
                    document.querySelector('.iig-library-generation-item img').click();
                    await document.querySelector('.iig-lightbox-img').decode();
                    const closed = new Promise(resolve => document.getElementById('iig_lightbox').addEventListener('close', resolve, { once: true }));
                    document.querySelector('.iig-lightbox-close').click();
                    await closed;
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    section.querySelectorAll = query;
                    return scans;
                });
                report.evidence.viewerCloseImageScans = scans;
                assert.equal(scans, 0, 'Closing a viewer with no library edits needs no DOM ownership scan');
                assert.equal(await page.locator('.iig-library-generation-item img').first().evaluate(image => image.complete && image.naturalWidth > 0), true);
            } finally { await page.close(); }
        });
        await scenario('library reopening reuses bounded previews and visible server avatars', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    const section = document.getElementById('iig_characters_section');
                    const images = await import(prefix + 'src/libraryImages.js');
                    section.closest('details').open = false;
                    images.observeLibraryImages();
                    const open = XMLHttpRequest.prototype.open, revoke = URL.revokeObjectURL;
                    window.reopenWork = { requests: 0, encodes: 0, revoked: [], avatarWrites: 0 };
                    XMLHttpRequest.prototype.open = function (method, url, ...args) { if (url === '/fast.svg') reopenWork.requests++; return open.call(this, method, url, ...args); };
                    wrapPreviewEncoder(function (encode) { reopenWork.encodes++; return encode(); });
                    URL.revokeObjectURL = function (url) { reopenWork.revoked.push(url); return revoke.call(this, url); };
                    section.innerHTML = '<div style="display:flex;height:130px"><div style="width:120px;height:120px"><img id="reuse-preview" data-iig-library-src="/fast.svg" data-iig-full-src="/fast.svg" style="width:100%;height:100%"></div><div style="width:64px;height:64px"><img id="reuse-avatar" data-iig-library-src="/thumbnail?type=avatar&file=reuse.png" style="width:100%;height:100%"></div></div>';
                    section.closest('details').open = true;
                    section.scrollIntoView({ block: 'start' });
                    images.observeLibraryImages();
                }, prefix);
                await page.waitForFunction(() => ['reuse-preview','reuse-avatar'].every(id => { const image = document.getElementById(id); return image.complete && image.naturalWidth > 0; }));
                const first = await page.locator('#reuse-preview').getAttribute('src');
                await page.evaluate(() => {
                    window.reopenAvatarObserver = new MutationObserver(records => reopenWork.avatarWrites += records.length);
                    reopenAvatarObserver.observe(document.getElementById('reuse-avatar'), { attributes: true, attributeFilter: ['src'] });
                });
                const urls = [first];
                for (let i = 0; i < 3; i++) {
                    await page.evaluate(async prefix => {
                        document.getElementById('iig_characters_section').closest('details').open = false;
                        (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                    }, prefix);
                    assert.equal(await page.locator('#reuse-preview').getAttribute('src'), first, 'Keep an already decoded preview while its cache entry owns the URL');
                    await page.evaluate(async prefix => {
                        document.getElementById('iig_characters_section').closest('details').open = true;
                        (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                    }, prefix);
                    await page.waitForFunction(() => document.getElementById('reuse-preview').src.startsWith('blob:') && document.getElementById('reuse-preview').complete && document.getElementById('reuse-preview').naturalWidth > 0);
                    urls.push(await page.locator('#reuse-preview').getAttribute('src'));
                }
                const result = await page.evaluate(() => ({ requests: reopenWork.requests, encodes: reopenWork.encodes, avatarWrites: reopenWork.avatarWrites + reopenAvatarObserver.takeRecords().length }));
                report.evidence.reopenWork = { ...result, uniquePreviewUrls: new Set(urls).size };
                assert.deepEqual(result, { requests: 1, encodes: 1, avatarWrites: 0 });
                assert.equal(new Set(urls).size, 1);
                await page.evaluate(async prefix => {
                    document.getElementById('iig_characters_section').closest('details').open = false;
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                    window.dispatchEvent(new Event('pagehide'));
                }, prefix);
                await page.waitForFunction(first => reopenWork.revoked.includes(first), first);
                assert.equal(await page.locator('#reuse-avatar').getAttribute('src'), null);
            } finally { await page.close(); }
        });
        await scenario('collapsed preview cache stays within four megapixels and releases on pagehide', async () => {
            const page = await open();
            try {
                await page.evaluate(() => {
                    window.budgetPreviews = []; window.budgetRevoked = [];
                    window.budgetPendingRevocations = 0;
                    const timeout = window.setTimeout;
                    window.setTimeout = function (callback, delay, ...args) {
                        if (delay !== 250 || !new Error().stack.includes('/src/libraryImages.js')) return timeout(callback, delay, ...args);
                        budgetPendingRevocations++;
                        return timeout(() => { try { callback(...args); } finally { budgetPendingRevocations--; } }, delay);
                    };
                    const revoke = URL.revokeObjectURL;
                    URL.revokeObjectURL = function (url) { budgetRevoked.push(url); return revoke.call(this, url); };
                    document.getElementById('iig_characters_section').innerHTML = '<div id="budget-card" style="width:512px;height:1024px"></div>';
                });
                for (let i = 0; i < 12; i++) {
                    await page.evaluate(async ({prefix, i}) => {
                        const card = document.getElementById('budget-card');
                        card.innerHTML = `<img id="budget-preview" data-iig-library-src="/large.svg?index=${i}" data-iig-full-src="/large.svg?index=${i}" style="width:100%;height:100%">`;
                        card.scrollIntoView({ block: 'start' });
                        (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                    }, {prefix, i});
                    await page.waitForFunction(() => { const image = document.getElementById('budget-preview'); return image.src.startsWith('blob:') && image.complete && image.naturalWidth > 0; });
                    await page.evaluate(() => { const image = document.getElementById('budget-preview'); budgetPreviews.push({ url: image.src, pixels: image.naturalWidth * image.naturalHeight }); });
                }
                await page.evaluate(async prefix => {
                    document.getElementById('iig_characters_section').closest('details').open = false;
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                await page.waitForFunction(() => budgetPendingRevocations === 0 && budgetPreviews.filter(item => budgetRevoked.includes(item.url)).length >= 4);
                const result = await page.evaluate(() => { const live = budgetPreviews.filter(item => !budgetRevoked.includes(item.url)); return { entries: live.length, pixels: live.reduce((sum, item) => sum + item.pixels, 0) }; });
                report.evidence.collapsedPreviewBudget = result;
                assert.deepEqual(result, { entries: 8, pixels: 4 * 1024 * 1024 });
                await page.evaluate(async prefix => {
                    document.getElementById('iig_characters_section').innerHTML = '';
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                    window.dispatchEvent(new Event('pagehide'));
                }, prefix);
                await page.waitForFunction(() => budgetPreviews.every(item => budgetRevoked.includes(item.url)));
            } finally { await page.close(); }
        });
        await scenario('server avatars load on visibility without resize subscriptions', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    const section = document.getElementById('iig_characters_section');
                    section.innerHTML = '<div id="avatar-scroll" style="height:140px;overflow:auto"><div style="width:64px;height:64px"><img id="near-avatar" data-iig-library-src="/thumbnail?type=avatar&file=near.png" loading="lazy" decoding="async" style="width:100%;height:100%"></div><div style="height:2500px"></div><div style="width:64px;height:64px"><img id="far-avatar" data-iig-library-src="/thumbnail?type=avatar&file=far.png" loading="lazy" decoding="async" style="width:100%;height:100%"></div></div>';
                    window.avatarResizeSubscriptions = 0;
                    const observe = ResizeObserver.prototype.observe;
                    ResizeObserver.prototype.observe = function (target, ...args) { if (target.closest('#avatar-scroll')) avatarResizeSubscriptions++; return observe.call(this, target, ...args); };
                    section.scrollIntoView({ block: 'start' });
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                await page.waitForFunction(() => document.getElementById('near-avatar').complete && document.getElementById('near-avatar').naturalWidth > 0);
                const first = await page.evaluate(() => ({ near: document.getElementById('near-avatar').getAttribute('src'), far: document.getElementById('far-avatar').getAttribute('src'), resizeSubscriptions: avatarResizeSubscriptions }));
                report.evidence.viewportAvatars = first;
                assert.deepEqual(first, { near: '/thumbnail?type=avatar&file=near.png', far: null, resizeSubscriptions: 0 });
                await page.locator('#avatar-scroll').evaluate(element => element.scrollTop = element.scrollHeight);
                await page.waitForFunction(() => document.getElementById('far-avatar').complete && document.getElementById('far-avatar').naturalWidth > 0);
                await page.evaluate(async prefix => {
                    document.getElementById('iig_characters_section').closest('details').open = false;
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                assert.equal(await page.locator('#far-avatar').getAttribute('src'), '/thumbnail?type=avatar&file=far.png');
                await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
                assert.equal(await page.evaluate(() => [...document.querySelectorAll('#avatar-scroll img')].every(image => !image.hasAttribute('src'))), true);
            } finally { await page.close(); }
        });
        await scenario('image observers batch replacements and watch sizes only in view', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    const section = document.getElementById('iig_characters_section');
                    section.innerHTML = '<div id="observer-scroll" style="height:140px;overflow:auto"><div style="width:64px;height:64px"><img id="loaded-avatar" data-iig-library-src="/thumbnail?file=loaded.png" style="width:100%;height:100%"></div><div style="height:2500px"></div><div style="width:120px;height:120px"><img id="distant-preview" data-iig-library-src="/fast.svg" data-iig-full-src="/fast.svg" style="width:100%;height:100%"></div></div>';
                    window.imageObserverWork = { resize: 0, avatarObserve: 0, unobserve: 0, disconnect: 0, coldReleases: 0 };
                    const remove = HTMLImageElement.prototype.removeAttribute;
                    HTMLImageElement.prototype.removeAttribute = function (name) {
                        if (name === 'src' && !this.hasAttribute('src') && this.closest('#observer-scroll')) imageObserverWork.coldReleases++;
                        return remove.call(this, name);
                    };
                    for (const Type of [IntersectionObserver, ResizeObserver]) for (const name of ['observe', 'unobserve', 'disconnect']) {
                        const original = Type.prototype[name];
                        Type.prototype[name] = function (target, ...args) {
                            if (name === 'observe' && Type === ResizeObserver && target.closest('#observer-scroll')) imageObserverWork.resize++;
                            if (name === 'observe' && Type === IntersectionObserver && target.querySelector('#loaded-avatar')) imageObserverWork.avatarObserve++;
                            if (name !== 'observe') imageObserverWork[name]++;
                            return original.call(this, target, ...args);
                        };
                    }
                    section.scrollIntoView({ block: 'start' });
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                await page.waitForFunction(() => document.getElementById('loaded-avatar').naturalWidth > 0);
                const hidden = await page.evaluate(() => imageObserverWork.resize);
                assert.equal(hidden, 0, 'Offscreen previews need no resize subscription');
                assert.equal(await page.evaluate(() => imageObserverWork.coldReleases), 0, 'Initial offscreen entries have no loaded resource to release');
                await page.evaluate(async prefix => {
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                assert.equal(await page.evaluate(() => imageObserverWork.avatarObserve), 1, 'Loaded native thumbnails need no renewed visibility subscription');
                await page.locator('#observer-scroll').evaluate(element => element.scrollTop = element.scrollHeight);
                await page.waitForFunction(() => document.getElementById('distant-preview').getAttribute('src')?.startsWith('blob:'));
                assert.equal(await page.evaluate(() => imageObserverWork.resize), 1);
                const replacement = await page.evaluate(async prefix => {
                    const module = await import(prefix + 'src/libraryImages.js');
                    imageObserverWork.unobserve = imageObserverWork.disconnect = 0;
                    document.getElementById('iig_characters_section').innerHTML = '<div style="width:64px;height:64px"><img data-iig-library-src="/thumbnail?file=replacement.png"></div>';
                    module.observeLibraryImages();
                    return { unobserve: imageObserverWork.unobserve, disconnect: imageObserverWork.disconnect };
                }, prefix);
                report.evidence.imageObserverReplacement = replacement;
                assert.equal(replacement.unobserve, 0, 'A complete replacement disconnects observers once, not once per old image');
                assert.ok(replacement.disconnect > 0);
                await page.screenshot({ path: path.join(artifacts, 'image-observer-replacement.png') });
            } finally { await page.close(); }
        });
        await scenario('visibility toggles reuse image membership and do not abort completed previews', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    const section = document.getElementById('iig_characters_section');
                    section.innerHTML = '<div style="width:120px;height:120px"><img id="stable-preview" data-iig-library-src="/large.svg" data-iig-full-src="/large.svg" style="width:100%;height:100%"></div>';
                    section.scrollIntoView({ block: 'start' });
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                await page.waitForFunction(() => document.getElementById('stable-preview').getAttribute('src')?.startsWith('blob:') && document.getElementById('stable-preview').naturalWidth > 0);
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                const work = await page.evaluate(async prefix => {
                    const module = await import(prefix + 'src/libraryImages.js');
                    const section = document.getElementById('iig_characters_section'), details = section.closest('details');
                    let imageScans = 0, completedAborts = 0, observerChanges = 0, rapidWidthReads = 0, normalWidthReads = 0, countWidthReads = false, rapidReopen = false;
                    const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
                    Object.defineProperty(Element.prototype, 'clientWidth', { ...clientWidth, get() {
                        if (countWidthReads && this.id === 'stable-preview') {
                            if (rapidReopen) rapidWidthReads++;
                            else normalWidthReads++;
                        }
                        return clientWidth.get.call(this);
                    } });
                    const restoreObservers = [];
                    for (const Type of [IntersectionObserver, ResizeObserver]) for (const name of ['observe', 'unobserve', 'disconnect']) {
                        const original = Type.prototype[name];
                        Type.prototype[name] = function (...args) { observerChanges++; return original.apply(this, args); };
                        restoreObservers.push(() => Type.prototype[name] = original);
                    }
                    const query = section.querySelectorAll;
                    section.querySelectorAll = function (selector, ...args) { if (selector === 'img[data-iig-library-src]') imageScans++; return query.call(this, selector, ...args); };
                    const abort = AbortController.prototype.abort;
                    AbortController.prototype.abort = function (...args) { if (new Error().stack.includes('/src/libraryImages.js')) completedAborts++; return abort.apply(this, args); };
                    for (const rapid of [true, false]) {
                        countWidthReads = true;
                        rapidReopen = rapid;
                        details.open = false; module.observeLibraryImages({ visibilityOnly: true });
                        if (!rapid) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                        details.open = true; module.observeLibraryImages({ visibilityOnly: true });
                        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                        countWidthReads = false;
                    }
                    Object.defineProperty(Element.prototype, 'clientWidth', clientWidth);
                    const visibilityScans = imageScans;
                    restoreObservers.forEach(restore => restore());
                    details.open = false; module.observeLibraryImages({ visibilityOnly: true });
                    const image = document.getElementById('stable-preview'), previousSource = image.src;
                    image.parentElement.style.width = '180px';
                    window.dispatchEvent(new Event('resize'));
                    await new Promise(resolve => setTimeout(resolve, 100));
                    const hiddenSourceUnchanged = image.src === previousSource;
                    details.open = true; module.observeLibraryImages({ visibilityOnly: true });
                    await new Promise((resolve, reject) => {
                        const deadline = performance.now() + 3000;
                        const check = () => image.complete && image.naturalWidth >= 256 ? resolve()
                            : performance.now() > deadline ? reject(new Error('Reopened preview did not upgrade after hidden resize')) : setTimeout(check, 20);
                        check();
                    });
                    details.open = false; module.observeLibraryImages({ visibilityOnly: true });
                    const density = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
                    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2.5 });
                    window.dispatchEvent(new Event('resize'));
                    details.open = true; module.observeLibraryImages({ visibilityOnly: true });
                    await new Promise((resolve, reject) => {
                        const deadline = performance.now() + 3000;
                        const check = () => image.complete && image.naturalWidth === 512 ? resolve()
                            : performance.now() > deadline ? reject(new Error('Hidden density change did not upgrade the reopened preview')) : setTimeout(check, 20);
                        check();
                    });
                    if (density) Object.defineProperty(window, 'devicePixelRatio', density);
                    else delete window.devicePixelRatio;
                    section.innerHTML = '';
                    module.observeLibraryImages();
                    return { visibilityScans, completedAborts, observerChanges, hiddenSourceUnchanged, rapidWidthReads, normalWidthReads };
                }, prefix);
                report.evidence.stableCollapseWork = work;
                assert.deepEqual(work, { visibilityScans: 0, completedAborts: 0, observerChanges: 0, hiddenSourceUnchanged: true, rapidWidthReads: 0, normalWidthReads: 0 });
                await page.screenshot({ path: path.join(artifacts, 'stable-collapse-ownership.png') });
            } finally { await page.close(); }
        });
        // Resume failures: canceled rows use stale visibility after hidden layout changes,
        // or remain blank when collapse and reopening happen within the same frame.
        for (const rapid of [true, false]) for (const moved of [true, false]) await scenario(`canceled previews recheck visibility: rapid=${rapid} moved=${moved}`, async () => {
            const page = await open();
            try {
                await loadingPreviews(page, Array.from({ length: 6 }, (_, i) => `/loading.svg?id=resume-${i}&delay=600`));
                await page.waitForFunction(() => loadingWork.requests.length === 6);
                const before = await page.evaluate(() => loadingWork.requests.length);
                await page.evaluate(async ({ prefix, rapid, moved }) => {
                    const module = await import(prefix + 'src/libraryImages.js');
                    const section = document.getElementById('iig_characters_section'), details = section.closest('details');
                    details.open = false;
                    module.observeLibraryImages({ visibilityOnly: true });
                    if (moved) document.getElementById('loading-gallery').style.marginTop = '2500px';
                    if (!rapid) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    details.open = true;
                    details.scrollIntoView({ block: 'start' });
                    module.observeLibraryImages({ visibilityOnly: true });
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                }, { prefix, rapid, moved });
                await page.waitForTimeout(150);
                const result = await page.evaluate(before => ({ newRequests: loadingWork.requests.length - before,
                    assigned: [...document.querySelectorAll('#loading-gallery img')].filter(image => image.hasAttribute('src')).length,
                    top: document.getElementById('loading-gallery').getBoundingClientRect().top, viewport: innerHeight }), before);
                report.evidence[`resume-${rapid}-${moved}`] = result;
                if (moved) {
                    assert.ok(result.top > result.viewport + 160, 'Rows are outside the prefetch margin');
                    assert.equal(result.newRequests, 0, 'Reopening must not resume canceled offscreen downloads');
                    assert.equal(result.assigned, 0);
                    await page.locator('#loading-gallery').evaluate(element => element.scrollIntoView({ block: 'start' }));
                }
                await loadingReady(page);
                assert.ok(await page.evaluate(() => [...document.querySelectorAll('#loading-gallery img')].every(image => image.src.startsWith('blob:'))));
                await page.screenshot({ path: path.join(artifacts, `resume-${rapid}-${moved}.png`) });
            } finally { await page.close(); }
        });
        for (const moved of [true, false]) await scenario(`cached preview resume uses current viewport: moved=${moved}`, async () => {
            const page = await open();
            try {
                await loadingPreviews(page, Array.from({ length: 6 }, (_, i) => `/loading.svg?id=cached-resume-${i}`));
                await loadingReady(page);
                const result = await page.evaluate(async ({ prefix, moved }) => {
                    const module = await import(prefix + 'src/libraryImages.js');
                    const section = document.getElementById('iig_characters_section'), details = section.closest('details');
                    const gallery = document.getElementById('loading-gallery'), replacement = gallery.cloneNode(true);
                    for (const image of replacement.querySelectorAll('img')) { image.removeAttribute('src'); delete image.dataset.readyAt; }
                    const viewer = document.getElementById('iig_lightbox');
                    viewer.showModal();
                    await new Promise(resolve => { viewer.addEventListener('close', resolve, { once: true }); viewer.close(); });
                    // The viewer close grace period holds cached jobs while new rows enter view.
                    let observed = 0;
                    const observe = ResizeObserver.prototype.observe;
                    ResizeObserver.prototype.observe = function (element, ...args) {
                        if (replacement.contains(element)) observed++;
                        return observe.call(this, element, ...args);
                    };
                    gallery.replaceWith(replacement);
                    module.observeLibraryImages();
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    ResizeObserver.prototype.observe = observe;
                    const pending = [...replacement.querySelectorAll('img')].every(image => !image.hasAttribute('src'));
                    details.open = false;
                    module.observeLibraryImages({ visibilityOnly: true });
                    if (moved) replacement.style.marginTop = '2500px';
                    let writes = 0;
                    const mutations = new MutationObserver(records => writes += records.filter(record => record.target.getAttribute('src')?.startsWith('blob:')).length);
                    mutations.observe(replacement, { subtree: true, attributes: true, attributeFilter: ['src'] });
                    details.open = true;
                    details.scrollIntoView({ block: 'start' });
                    module.observeLibraryImages({ visibilityOnly: true });
                    await new Promise(resolve => setTimeout(resolve, 200));
                    mutations.disconnect();
                    return { observed, pending, writes, requests: loadingWork.requests.length };
                }, { prefix, moved });
                report.evidence[`cached-resume-${moved}`] = result;
                assert.equal(result.observed, 6, 'New owners enter the visibility set before collapse');
                assert.ok(result.pending, 'Cached assignments wait for the viewer close grace period');
                assert.equal(result.writes, moved ? 0 : 6, 'Resume only cached rows in the current viewport');
                assert.equal(result.requests, 6, 'Cached rows need no new original download');
                if (moved) await page.locator('#loading-gallery').evaluate(element => element.scrollIntoView({ block: 'start' }));
                await page.waitForFunction(() => [...document.querySelectorAll('#loading-gallery img')].every(image => image.src.startsWith('blob:') && image.complete && image.naturalWidth > 0));
                await page.screenshot({ path: path.join(artifacts, `cached-resume-${moved}.png`) });
            } finally { await page.close(); }
        });
        await scenario('a released preview closes its pending bitmap without rasterizing or encoding', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    window.Worker = undefined;
                    const create = createImageBitmap;
                    window.previewEncodes = 0;
                    wrapPreviewEncoder(function (encode) { if (this.width === 41) previewEncodes++; return encode(); });
                    window.createImageBitmap = async () => {
                        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 41;
                        window.pendingBitmap = await create(canvas);
                        await new Promise(resolve => window.finishPreviewDecode = resolve);
                        return pendingBitmap;
                    };
                    const section = document.getElementById('iig_characters_section');
                    section.innerHTML = '<div style="width:120px;height:120px"><img data-iig-library-src="/pending.png" data-iig-full-src="/pending.png" style="width:100%;height:100%"></div>';
                    section.scrollIntoView({ block: 'start' });
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                await page.waitForFunction(() => typeof finishPreviewDecode === 'function', null, { timeout: 3000 });
                await page.evaluate(async prefix => {
                    document.getElementById('iig_characters_section').closest('details').open = false;
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                    finishPreviewDecode();
                }, prefix);
                await page.waitForFunction(() => pendingBitmap.width === 0, null, { timeout: 3000 });
                assert.equal(await page.evaluate(() => previewEncodes), 0);
                report.evidence.releasedPreviewEncodes = 0;
            } finally { await page.close(); }
        });
        await scenario('original preparation waits for input idle and follows visible DOM order', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    window.warmed = []; const Native = Image;
                    window.Image = function (...args) { const image = new Native(...args); warmed.push(image); return image; };
                    const section = document.getElementById('iig_characters_section');
                    section.innerHTML = '<input id="iig_library_search"><div data-iig-lightbox-gallery style="display:flex;width:300px;height:150px"><div id="first-original" style="width:140px;height:140px;transform:translateY(3000px)"><img data-iig-library-src="/user/images/first.svg" data-iig-full-src="/user/images/first.svg" data-iig-lightbox style="width:100%;height:100%"></div><div style="width:140px;height:140px"><img data-iig-library-src="/user/images/second.svg" data-iig-full-src="/user/images/second.svg" data-iig-lightbox style="width:100%;height:100%"></div></div>';
                    section.scrollIntoView({ block: 'start' });
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                    const input = document.getElementById('iig_library_search');
                    for (let i = 0; i < 10; i++) {
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        await new Promise(resolve => setTimeout(resolve, 80));
                    }
                }, prefix);
                assert.equal(await page.evaluate(() => warmed.some(image => image.getAttribute('src')?.startsWith('/user/images/'))), false, 'Typing must not decode speculative originals');
                await page.waitForFunction(() => warmed.some(image => image.getAttribute('src') === '/user/images/second.svg' && image.complete));
                await page.locator('#first-original').evaluate(element => element.style.transform = 'none');
                await page.waitForFunction(() => warmed.some(image => image.getAttribute('src') === '/user/images/first.svg' && image.complete));
                assert.equal(await page.evaluate(() => warmed.filter(image => image.getAttribute('src')?.startsWith('/user/images/')).length), 1);
                await page.screenshot({ path: path.join(artifacts, 'original-input-idle.png') });
            } finally { await page.close(); }
        });
        await scenario('cached gallery rows measure sizes before assigning sources', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    window.batchMarkup = '<div style="display:grid;grid-template-columns:repeat(4,90px)">' + Array.from({ length: 12 }, (_, i) =>
                        `<div style="width:90px;height:90px"><img class="batch-preview" data-iig-library-src="/fast.svg?batch=${i}" data-iig-full-src="/fast.svg?batch=${i}" style="width:100%;height:100%"></div>`).join('') + '</div>';
                    const section = document.getElementById('iig_characters_section');
                    section.innerHTML = batchMarkup;
                    section.scrollIntoView({ block: 'start' });
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                await page.waitForFunction(() => [...document.querySelectorAll('.batch-preview')].every(image => image.src.startsWith('blob:') && image.complete));
                await page.evaluate(async prefix => {
                    window.previewBatches = [];
                    let batch;
                    const record = (image, kind) => {
                        if (!image.classList?.contains('batch-preview')) return;
                        if (!batch) { batch = []; previewBatches.push(batch); queueMicrotask(() => batch = null); }
                        batch.push(kind);
                    };
                    const width = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
                    Object.defineProperty(Element.prototype, 'clientWidth', { ...width, get() { record(this, 'read'); return width.get.call(this); } });
                    const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
                    Object.defineProperty(HTMLImageElement.prototype, 'src', { ...src, set(value) { record(this, 'write'); return src.set.call(this, value); } });
                    document.getElementById('iig_characters_section').innerHTML = batchMarkup;
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                await page.waitForFunction(() => [...document.querySelectorAll('.batch-preview')].every(image => image.src.startsWith('blob:') && image.complete));
                const batches = await page.evaluate(() => previewBatches);
                report.evidence.previewBatchOrder = batches;
                assert.ok(batches.some(batch => batch.filter(op => op === 'read').length > 1));
                for (const batch of batches) {
                    const firstWrite = batch.indexOf('write');
                    assert.ok(firstWrite < 0 || !batch.slice(firstWrite).includes('read'), 'Read all row sizes before source writes can invalidate layout');
                }
            } finally { await page.close(); }
        });
        await scenario('stable previews reuse observers and transfer prepared originals to the viewer', async () => {
            const page = await open();
            try {
                await page.locator('.iig-library-generation-item').first().evaluate(e => e.scrollIntoView({ block: 'center' }));
                await page.waitForTimeout(500);
                const work = await page.evaluate(async prefix => {
                    const module = await import(prefix + 'src/libraryImages.js');
                    let changes = 0;
                    const restores = [];
                    for (const Type of [IntersectionObserver, ResizeObserver]) for (const name of ['observe', 'unobserve', 'disconnect']) {
                        const original = Type.prototype[name];
                        Type.prototype[name] = function (...args) { changes++; return original.apply(this, args); };
                        restores.push(() => Type.prototype[name] = original);
                    }
                    try { module.observeLibraryImages(); module.observeLibraryImages(); return changes; }
                    finally { restores.forEach(restore => restore()); }
                }, prefix);
                assert.equal(work, 0, 'Unchanged previews must not restart observers');
                await page.evaluate(() => {
                    window.warmed = []; const Native = Image;
                    window.Image = function (...args) { const image = new Native(...args); warmed.push(image); return image; };
                    const section = document.getElementById('iig_characters_section');
                    section.innerHTML = '<div data-iig-lightbox-gallery style="width:140px;height:140px"><img data-iig-library-src="/fast.svg" data-iig-full-src="/fast.svg" data-iig-lightbox style="width:100%;height:100%"></div>';
                    section.scrollIntoView({ block: 'start' });
                });
                await page.evaluate(async prefix => (await import(prefix + 'src/libraryImages.js')).observeLibraryImages(), prefix);
                await page.waitForFunction(() => warmed.some(image => image.getAttribute('src') === '/fast.svg' && image.complete));
                assert.equal(await page.evaluate(() => warmed.filter(image => image.hasAttribute('src')).length), 1);
                await page.evaluate(() => window.preparedOriginal = warmed.find(image => image.getAttribute('src') === '/fast.svg'));
                await page.locator('[data-iig-lightbox]').evaluate(image => image.click());
                await page.waitForFunction(() => document.querySelector('.iig-lightbox-img').complete && document.querySelector('.iig-lightbox-img').naturalWidth > 0);
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                assert.equal(await page.evaluate(() => preparedOriginal.getAttribute('src')), '/fast.svg', 'The viewer must reuse the prepared resource instead of dropping and decoding it again');
                await page.locator('.iig-lightbox-close').evaluate(button => button.click());
                await page.locator('#iig_characters_section').evaluate(section => section.closest('details').open = false);
                assert.equal(await page.evaluate(() => warmed.filter(image => image.hasAttribute('src')).length), 1, 'Only the transferred viewer source remains retained');
                await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
                await page.waitForFunction(() => warmed.every(image => !image.hasAttribute('src')));
                report.evidence.stableObserverChanges = work;
            } finally { await page.close(); }
        });
        await scenario('new persona rows enter the live list in one batch', async () => {
            const page = await open();
            try {
                const mutations = await page.evaluate(async prefix => {
                    context.powerUserSettings.personas = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['p' + i + '.png', 'Persona ' + i]));
                    const old = fetch;
                    window.fetch = (url, init) => String(url) === '/api/avatars/get' ? Promise.resolve(Response.json(Object.keys(context.powerUserSettings.personas))) : old(url, init);
                    await (await import(prefix + 'src/avatarPicker.js')).fetchUserAvatars();
                    const personaNames = context.powerUserSettings.personas;
                    let personaNameReads = 0;
                    Object.defineProperty(context.powerUserSettings, 'personas', { configurable: true, get() { personaNameReads++; return personaNames; } });
                    let batches = 0;
                    let templates = 0;
                    let imageScans = 0;
                    const section = document.getElementById('iig_characters_section');
                    const query = section.querySelectorAll;
                    section.querySelectorAll = function (selector, ...args) { if (selector === 'img[data-iig-library-src]') imageScans++; return query.call(this, selector, ...args); };
                    const create = document.createElement;
                    document.createElement = function (name, ...args) { if (name === 'template' && new Error().stack.includes('/src/characterLibraryUi.js')) templates++; return create.call(this, name, ...args); };
                    const observer = new MutationObserver(records => batches += records.filter(record => record.addedNodes.length).length);
                    observer.observe(document.getElementById('iig_library_entities'), { childList: true });
                    document.querySelector('[data-library-tab="user"]').click();
                    while (document.querySelectorAll('.iig-library-entity[data-library-kind="user"]').length !== 80 || document.querySelector('.iig-library-editor')?.dataset.libraryKind !== 'user') await new Promise(requestAnimationFrame);
                    observer.disconnect(); document.createElement = create; section.querySelectorAll = query;
                    return { batches, templates, imageScans, personaNameReads };
                }, prefix);
                report.evidence.personaInsertBatches = mutations.batches;
                report.evidence.personaTemplateBatches = mutations.templates;
                report.evidence.personaImageScans = mutations.imageScans;
                report.evidence.personaNameReads = mutations.personaNameReads;
                assert.equal(mutations.batches, 1, 'Insert the rows and search note together');
                assert.equal(mutations.imageScans, 1, 'Reconcile images after the list and editor are both current');
                assert.equal(mutations.templates, 0, 'Parse a wholesale replacement directly in the live document');
                assert.equal(mutations.personaNameReads, 1, 'Read persona metadata once for a coherent catalog snapshot');
            } finally { await page.close(); }
        });
        await scenario('canceled departure restores previews; accepted reload remains usable', async () => {
            const page = await open();
            try {
                await page.locator('.iig-library-generation-item').first().evaluate(e => e.scrollIntoView({ block: 'center' }));
                await page.waitForFunction(() => [...document.querySelectorAll('.iig-library-generation-item img')].some(e => e.src.startsWith('blob:') && e.complete));
                await page.locator('#iig_library_search').click();
                await page.evaluate(() => { window.marker = 'same document'; window.preventExit = e => { e.preventDefault(); e.returnValue = 'Unsaved fixture'; }; window.addEventListener('beforeunload', preventExit); });
                if (engine === 'chromium') {
                    page.once('dialog', dialog => dialog.dismiss());
                    await page.reload({ timeout: 1500 }).catch(() => {});
                } else {
                    // WebKit automation does not expose a cancellable native beforeunload dialog.
                    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
                }
                assert.equal(await page.evaluate(() => marker), 'same document');
                await page.locator('.iig-library-generation-item').first().evaluate(e => e.scrollIntoView({ block: 'center' }));
                await page.waitForFunction(() => [...document.querySelectorAll('.iig-library-generation-item img')].some(e => e.src.startsWith('blob:') && e.complete), null, { timeout: 1800 });
                await page.evaluate(() => window.removeEventListener('beforeunload', preventExit));
                await page.reload(); await page.waitForFunction(() => window.ready);
                await page.screenshot({ path: path.join(artifacts, 'after-reload.png') });
            } finally { await page.close(); }
        });
        await scenario('late catalog cannot overwrite a switched provider', async () => {
            const page = await open('/api-test');
            try {
                await page.evaluate(() => {
                    Object.assign(app.settings, { apiType: 'electronhub', endpoint: 'https://fixture.invalid', apiKey: 'fixture', rawEndpoint: false, model: 'gpt-image-1' });
                    const original = fetch; window.fetch = async (url, init) => {
                        if (String(url).includes('fixture.invalid') && String(url).endsWith('/models')) { window.catalogStarted = true; await new Promise(r => setTimeout(r, 350)); return Response.json({ data: [{ id: 'gpt-image-stale' }] }); }
                        return original(url, init);
                    };
                    document.getElementById('iig_refresh_models').click();
                });
                await page.waitForFunction(() => window.catalogStarted);
                await page.locator('#iig_api_type').evaluate(e => { e.value = 'novelai'; e.dispatchEvent(new Event('change', { bubbles: true })); });
                await page.waitForTimeout(70); const selected = await page.evaluate(() => app.settings.model);
                await page.waitForTimeout(500);
                const actual = await page.evaluate(() => ({ model: app.settings.model, shown: document.getElementById('iig_model_select').value }));
                report.evidence.providerSwitch = { selected, ...actual };
                assert.deepEqual(actual, { model: selected, shown: selected });
            } finally { await page.close(); }
        });
        await scenario('profile switches refresh their catalog and ignore an old profile response', async () => {
            const page = await open('/api-test');
            try {
                await page.evaluate(async prefix => {
                    const module = await import(prefix + 'src/settings.js');
                    Object.assign(app.settings, { apiType: 'electronhub', endpoint: 'https://fixture.invalid/old', apiKey: 'old-fixture', rawEndpoint: false, model: 'gpt-image-current' });
                    const a = module.createConnectionProfile('Old fixture', app.settings);
                    app.settings.endpoint = 'https://fixture.invalid/new'; app.settings.apiKey = 'new-fixture';
                    const b = module.createConnectionProfile('New fixture', app.settings);
                    const select = document.getElementById('iig_profile_select');
                    for (const p of [a, b]) select.add(new Option(p.name, p.id));
                    const original = fetch; window.fetch = async (url, init) => {
                        if (String(url).includes('fixture.invalid')) { const old = String(url).includes('/old/'); await new Promise(r => setTimeout(r, old ? 350 : 20)); return Response.json({ data: [{ id: old ? 'gpt-image-stale' : 'gpt-image-new' }] }); }
                        return original(url, init);
                    };
                    module.loadConnectionProfile(a.id, app.settings); select.value = a.id;
                    document.getElementById('iig_refresh_models').click();
                    select.value = b.id; select.dispatchEvent(new Event('change', { bubbles: true }));
                }, prefix);
                await page.waitForTimeout(600);
                const options = await page.locator('#iig_model_select option').evaluateAll(rows => rows.map(row => row.value));
                report.evidence.profileCatalog = options;
                assert.ok(options.includes('gpt-image-new')); assert.ok(!options.includes('gpt-image-stale'));
            } finally { await page.close(); }
        });
        await scenario('late Naistera catalogs cannot replace current capability metadata', async () => {
            const page = await open('/api-test');
            try {
                await page.evaluate(() => {
                    Object.assign(app.settings, { apiType: 'naistera', endpoint: 'https://fixture.invalid/old', apiKey: 'old-fixture', naisteraModel: 'fixture-nai' });
                    const original = fetch; window.fetch = async (url, init) => {
                        if (String(url).includes('fixture.invalid')) { const old = String(url).includes('/old/'); await new Promise(r => setTimeout(r, old ? 350 : 20)); return Response.json({ models: [{ id: 'fixture-nai', name: old ? 'Old metadata' : 'New metadata', references: !old }] }); }
                        return original(url, init);
                    };
                    document.getElementById('iig_refresh_naistera_models').click();
                    app.settings.endpoint = 'https://fixture.invalid/new'; app.settings.apiKey = 'new-fixture';
                    document.getElementById('iig_refresh_naistera_models').click();
                });
                await page.waitForTimeout(600);
                const metadata = await page.evaluate(async prefix => { const provider = (await import(prefix + 'src/providers.js')).resolveActiveProvider(app.settings); return { label: provider.getModelLabel('fixture-nai'), references: provider.supportsReferences(app.settings) }; }, prefix);
                assert.deepEqual(metadata, { label: 'New metadata', references: true });
            } finally { await page.close(); }
        });
        await scenario('a timed out preview request does not block the next visible preview', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    const section = document.getElementById('iig_characters_section'); section.closest('details').open = false;
                    await new Promise(r => setTimeout(r, 70));
                    const Native = XMLHttpRequest, descriptor = Object.getOwnPropertyDescriptor(Native.prototype, 'timeout');
                    window.previewTimeouts = [];
                    window.XMLHttpRequest = function () { const xhr = new Native(); Object.defineProperty(xhr, 'timeout', { get() { return descriptor.get.call(xhr); }, set(value) { previewTimeouts.push(value); descriptor.set.call(xhr, Math.min(value, 120)); } }); return xhr; };
                    section.innerHTML = '<div style="display:flex;height:150px"><div style="width:120px;height:120px"><img id="slow-preview" data-iig-library-src="/slow.svg" data-iig-full-src="/slow.svg" style="width:100%;height:100%"></div><div style="width:120px;height:120px"><img id="fast-preview" data-iig-library-src="/fast.svg" data-iig-full-src="/fast.svg" style="width:100%;height:100%"></div></div>';
                    section.closest('details').open = true; section.scrollIntoView({ block: 'start' });
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                await page.waitForFunction(() => document.getElementById('fast-preview').src.startsWith('blob:') && document.getElementById('fast-preview').complete, null, { timeout: 2000 });
                const configured = await page.evaluate(() => previewTimeouts);
                assert.ok(configured.length && configured.every(ms => ms > 0 && ms <= 30000));
                report.evidence.timeoutMs = configured;
            } finally { await page.close(); }
        });
        await scenario('previews upgrade for larger cards and never downgrade on shrink', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    const section = document.getElementById('iig_characters_section');
                    section.innerHTML = '<div id="resize-box" style="width:110px;height:180px"><img id="resize-preview" data-iig-library-src="/fast.svg" data-iig-full-src="/fast.svg" style="width:100%;height:100%"></div>';
                    section.scrollIntoView({ block: 'start' });
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                await page.waitForFunction(() => document.getElementById('resize-preview').src.startsWith('blob:') && document.getElementById('resize-preview').naturalWidth === 128);
                let initial = await page.locator('#resize-preview').getAttribute('src');
                if (engine === 'chromium') {
                    const cdp = await page.context().newCDPSession(page);
                    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1101, height: 950, deviceScaleFactor: 2, mobile: false });
                    await page.waitForFunction(initial => document.getElementById('resize-preview').src !== initial && document.getElementById('resize-preview').naturalWidth > 128, initial, { timeout: 2000 });
                    initial = await page.locator('#resize-preview').getAttribute('src');
                    report.evidence.densityUpgrade = true;
                    await cdp.detach();
                }
                await page.locator('#resize-box').evaluate(e => e.style.width = '260px');
                await page.waitForFunction(initial => { const image = document.getElementById('resize-preview'); return image.src !== initial && image.naturalWidth > 128; }, initial, { timeout: 2000 });
                const upgraded = await page.locator('#resize-preview').getAttribute('src');
                await page.locator('#resize-box').evaluate(e => e.style.width = '80px');
                await page.waitForTimeout(150);
                assert.equal(await page.locator('#resize-preview').getAttribute('src'), upgraded);
                assert.equal(await page.locator('#resize-preview').getAttribute('data-iig-full-src'), '/fast.svg');
            } finally { await page.close(); }
        });
        await scenario('search reuses matching character rows and avatars', async () => {
            const page = await open();
            try {
                await page.evaluate(() => { window.betaRow = [...document.querySelectorAll('.iig-library-entity')].find(e => e.textContent.includes('Beta')); window.betaAvatar = betaRow.querySelector('img'); });
                await page.locator('#iig_library_search').fill('Beta');
                await page.waitForFunction(() => document.querySelectorAll('.iig-library-entity').length === 1);
                assert.equal(await page.evaluate(() => document.querySelector('.iig-library-entity') === betaRow && betaRow.querySelector('img') === betaAvatar), true);
                const mutations = await page.evaluate(async () => {
                    let mutations = 0; const observer = new MutationObserver(rows => mutations += rows.length);
                    observer.observe(document.getElementById('iig_library_entities'), { childList: true });
                    const input = document.getElementById('iig_library_search'); input.value = 'Beta '; input.dispatchEvent(new Event('input', { bubbles: true }));
                    await new Promise(r => setTimeout(r, 150)); observer.disconnect(); return mutations;
                });
                assert.equal(mutations, 0);
                await page.locator('.iig-library-entity').click();
                await page.locator('.iig-library-display-name').fill('Beta renamed');
                await page.waitForFunction(() => betaRow.querySelector('strong').textContent === 'Beta renamed');
                assert.equal(await page.evaluate(() => document.activeElement.classList.contains('iig-library-display-name') && document.querySelector('.iig-library-entity') === betaRow), true);
                await page.evaluate(() => {
                    window.partialTemplates = 0; const create = document.createElement;
                    document.createElement = function (name, ...args) { if (name === 'template' && new Error().stack.includes('/src/characterLibraryUi.js')) partialTemplates++; return create.call(this, name, ...args); };
                });
                await page.locator('#iig_library_search').fill('');
                await page.waitForFunction(() => document.querySelectorAll('.iig-library-entity').length === 2);
                assert.equal(await page.evaluate(() => partialTemplates), 0);
                assert.equal(await page.evaluate(() => [...document.querySelectorAll('.iig-library-entity')].includes(betaRow)), true);
                const childCount = await page.locator('#iig_library_entities').evaluate(host => host.childNodes.length);
                for (let i = 0; i < 3; i++) {
                    await page.locator('#iig_library_search').fill('Beta');
                    await page.waitForFunction(() => document.querySelectorAll('.iig-library-entity').length === 1);
                    await page.locator('#iig_library_search').fill('');
                    await page.waitForFunction(() => document.querySelectorAll('.iig-library-entity').length === 2);
                }
                assert.equal(await page.locator('#iig_library_entities').evaluate(host => host.childNodes.length), childCount, 'Filtering must not accumulate detached-row whitespace');
                await page.locator('.iig-library-display-name').fill('A Beta renamed');
                await page.waitForFunction(() => document.querySelector('.iig-library-entity') === betaRow);
                assert.equal(await page.evaluate(() => betaRow.querySelector('img') === betaAvatar), true);
                report.evidence.unchangedSearchChildMutations = mutations;
            } finally { await page.close(); }
        });
        for (const mode of ['primary-file', 'persona-url', 'switch-editor', 'deleted-entry', 'deleted-item']) {
            await scenario(`reference upload ownership: ${mode}`, async () => {
                const page = await open();
                try {
                    if (mode === 'persona-url' || mode === 'deleted-item') {
                        await page.locator('[data-library-tab="user"]').click();
                        await page.waitForFunction(() => document.querySelector('.iig-library-editor')?.dataset.libraryKind === 'user');
                        await page.locator('.iig-library-appearance-add[data-appearance-type="image"]').click();
                    }
                    const before = await page.locator('.iig-library-editor').evaluate(e => ({ kind: e.dataset.libraryKind, key: e.dataset.libraryKey }));
                    const itemId = ['persona-url', 'deleted-item'].includes(mode) ? await page.locator('.iig-library-appearance-row.image').first().getAttribute('data-appearance-id') : '';
                    await page.evaluate(() => {
                        const original = fetch; window.fixtureInput = 'https://fixture.invalid/reference.png';
                        window.fetch = async (url, init) => {
                            if (String(url) === fixtureInput) return new Response(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0)), { headers: { 'Content-Type': 'image/png' } });
                            if (String(url) === '/api/images/upload') { window.uploadStarted = true; await new Promise(resolve => window.completeUpload = resolve); window.uploadFinished = true; return Response.json({ path: '/user/images/Alpha & One/uploaded.png' }); }
                            return original(url, init);
                        };
                    });
                    if (mode === 'persona-url' || mode === 'deleted-item') await page.locator('.iig-library-appearance-url').first().click();
                    else await page.locator('.iig-library-primary-file').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JQAAAABJRU5ErkJggg==', 'base64') });
                    await page.waitForFunction(() => window.uploadStarted);
                    if (mode === 'deleted-item') {
                        await page.locator('.iig-library-appearance-remove').first().click();
                    } else if (mode === 'switch-editor' || mode === 'deleted-entry') {
                        await page.locator('.iig-library-entity[data-library-key="avatar:b.png"]').click();
                        await page.locator('.iig-library-primary-description').fill('current editor text');
                        if (mode === 'deleted-entry') await page.evaluate(async prefix => (await import(prefix + 'src/references.js')).deleteCharacterLibraryEntry('char', 'avatar:a.png', app.settings), prefix);
                    } else {
                        const field = mode === 'persona-url' ? '.iig-library-appearance-description' : '.iig-library-primary-description';
                        await page.locator(field).first().fill('edited during upload');
                    }
                    await page.evaluate(() => completeUpload());
                    await page.waitForFunction(() => window.uploadFinished);
                    await page.waitForTimeout(120);
                    const result = await page.evaluate(({ before, itemId }) => {
                        const entry = app.settings.characterReferenceLibrary[before.kind === 'user' ? 'users' : 'characters'][before.key];
                        const target = itemId ? entry?.appearanceItems.find(i => i.id === itemId) : entry?.primary;
                        return { exists: Boolean(entry), path: target?.imagePath, description: target?.description, success: notes.some(n => n[0] === 'success' && String(n[1]).includes('Reference saved')), focused: document.activeElement?.matches('textarea'), editorKey: document.querySelector('.iig-library-editor')?.dataset.libraryKey, headerSource: document.querySelector('.iig-library-editor-avatar img')?.getAttribute('data-iig-full-src') };
                    }, { before, itemId });
                    if (mode === 'deleted-entry') { assert.equal(result.exists, false); assert.equal(result.success, false); }
                    else if (mode === 'deleted-item') { assert.equal(result.path, undefined); assert.equal(result.success, false); }
                    else {
                        assert.equal(result.path, '/user/images/Alpha%20%26%20One/uploaded.png');
                        assert.equal(result.success, true); assert.equal(result.focused, true);
                        if (mode !== 'switch-editor') assert.equal(result.description, 'edited during upload');
                    }
                    if (mode === 'switch-editor') assert.equal(result.editorKey, 'avatar:b.png');
                    if (mode === 'primary-file') assert.equal(result.headerSource, result.path);
                    report.evidence[mode] = result;
                } finally { await page.close(); }
            });
        }
        await scenario('late persona rows cannot replace a selected Characters tab', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    const refs = await import(prefix + 'src/references.js'), original = fetch;
                    window.fetch = async (url, init) => String(url) === '/api/avatars/get' ? Response.json([]) : original(url, init);
                    await refs.fetchUserAvatars();
                    window.fetch = async (url, init) => { if (String(url) === '/api/avatars/get') { window.personasStarted = true; await new Promise(r => setTimeout(r, 350)); return Response.json(['other.png']); } return original(url, init); };
                    document.querySelector('[data-library-tab="user"]').click();
                }, prefix);
                await page.waitForFunction(() => window.personasStarted);
                await page.locator('[data-library-tab="char"]').click();
                await page.waitForTimeout(550);
                const view = await page.evaluate(() => ({ tab: document.querySelector('[data-library-tab].selected').dataset.libraryTab, kinds: [...document.querySelectorAll('.iig-library-entity')].map(e => e.dataset.libraryKind), editor: document.querySelector('.iig-library-editor')?.dataset.libraryKind }));
                assert.equal(view.tab, 'char'); assert.equal(view.editor, 'char'); assert.ok(view.kinds.every(k => k === 'char'));
                report.evidence.tabOwnership = view;
            } finally { await page.close(); }
        });
        await scenario('obsolete catalog failures are silent; current failures are reported', async () => {
            const page = await open('/api-test');
            try {
                await page.evaluate(() => {
                    window.catalogErrors = []; toastr.error = message => catalogErrors.push(String(message));
                    Object.assign(app.settings, { apiType: 'electronhub', endpoint: 'https://fixture.invalid', apiKey: 'fixture', rawEndpoint: false });
                    const original = fetch; window.fetch = async (url, init) => { if (String(url).includes('fixture.invalid')) { window.catalogStarted = true; await new Promise(resolve => window.completeCatalog = resolve); return new Response('controlled failure', { status: 500 }); } return original(url, init); };
                    document.getElementById('iig_refresh_models').click();
                });
                await page.waitForFunction(() => window.catalogStarted);
                await page.locator('#iig_api_type').evaluate(e => { e.value = 'novelai'; e.dispatchEvent(new Event('change', { bubbles: true })); });
                await page.evaluate(async () => { completeCatalog(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
                assert.deepEqual(await page.evaluate(() => catalogErrors), []);
                await page.evaluate(() => { window.catalogStarted = false; Object.assign(app.settings, { apiType: 'electronhub', endpoint: 'https://fixture.invalid', apiKey: 'fixture', rawEndpoint: false }); document.getElementById('iig_refresh_models').click(); });
                await page.waitForFunction(() => window.catalogStarted);
                await page.evaluate(() => completeCatalog());
                await page.waitForFunction(() => catalogErrors.length === 1);
            } finally { await page.close(); }
        });
    } finally {
        report.passed = report.failures.length === 0 && report.checks.length > 0;
        fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
        await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
