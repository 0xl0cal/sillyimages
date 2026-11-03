const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createServer } = require('node:http');
const { chromium, webkit } = require('playwright');
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/sillyimages/';
const engine = process.env.IIG_BROWSER_ENGINE || 'chromium';
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
    else if (req.url === '/pending.png') { body = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'); type = 'image/png'; }
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
    const report = { engine, checks: [], failures: [], evidence: {} };
    const open = async (url = '/') => {
        const page = await browser.newPage({ viewport: { width: 1100, height: 950 } });
        await page.goto('http://127.0.0.1:' + server.address().port + url);
        await page.waitForFunction(() => window.ready);
        return page;
    };
    const scenario = async (name, run) => {
        try { await run(); report.checks.push(name); }
        catch (error) { report.failures.push({ name, error: String(error) }); }
    };
    try {
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
                    const create = createImageBitmap;
                    const openRequest = XMLHttpRequest.prototype.open;
                    window.secondPreviewRequests = 0;
                    XMLHttpRequest.prototype.open = function (method, url, ...args) { if (url === '/fast.svg') secondPreviewRequests++; return openRequest.call(this, method, url, ...args); };
                    window.createImageBitmap = async (...args) => {
                        if (window.finishPreviewDecode) return create(...args);
                        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 41;
                        window.pendingBitmap = await create(canvas);
                        await new Promise(resolve => window.finishPreviewDecode = resolve);
                        return pendingBitmap;
                    };
                    const section = document.getElementById('iig_characters_section');
                    section.innerHTML = '<div data-iig-lightbox-gallery style="display:flex;height:140px"><div style="width:120px;height:120px"><img id="queued-viewer-image" data-iig-library-src="/pending.png" data-iig-full-src="/pending.png" data-iig-lightbox style="width:100%;height:100%"></div><div style="width:120px;height:120px"><img id="queued-preview" data-iig-library-src="/fast.svg" data-iig-full-src="/fast.svg" style="width:100%;height:100%"></div></div>';
                    section.scrollIntoView({ block: 'start' });
                    (await import(prefix + 'src/libraryImages.js')).observeLibraryImages();
                }, prefix);
                await page.waitForFunction(() => typeof finishPreviewDecode === 'function', null, { timeout: 3000 });
                await page.evaluate(() => {
                    document.getElementById('queued-viewer-image').click();
                    document.getElementById('iig_lightbox').close();
                    document.getElementById('queued-viewer-image').click();
                    finishPreviewDecode();
                });
                await page.waitForFunction(() => pendingBitmap.width === 0, null, { timeout: 3000 });
                await page.waitForTimeout(200);
                assert.equal(await page.evaluate(() => secondPreviewRequests), 0);
                await page.locator('.iig-lightbox-close').evaluate(button => button.click());
                await page.waitForFunction(() => secondPreviewRequests === 1 && document.getElementById('queued-preview').complete && document.getElementById('queued-preview').naturalWidth > 0, null, { timeout: 3000 });
                report.evidence.viewerQueueResumeRequests = 1;
            } finally { await page.close(); }
        });
        await scenario('server avatar thumbnails use native loading without observer subscriptions', async () => {
            const page = await open();
            try {
                const result = await page.evaluate(async prefix => {
                    const section = document.getElementById('iig_characters_section');
                    section.innerHTML = '<div style="width:64px;height:64px"><img data-iig-library-src="/thumbnail?type=avatar&file=fixture.png" loading="lazy" decoding="async" style="width:100%;height:100%"></div>';
                    const image = section.querySelector('img');
                    let subscriptions = 0;
                    const restores = [];
                    for (const Type of [IntersectionObserver, ResizeObserver]) {
                        const original = Type.prototype.observe;
                        Type.prototype.observe = function (target, ...args) { if (target === image.parentElement) subscriptions++; return original.call(this, target, ...args); };
                        restores.push(() => Type.prototype.observe = original);
                    }
                    try {
                        const module = await import(prefix + 'src/libraryImages.js');
                        module.observeLibraryImages();
                        const source = image.getAttribute('src');
                        section.closest('details').open = false;
                        module.observeLibraryImages();
                        return { source, subscriptions, released: !image.hasAttribute('src') };
                    } finally { restores.forEach(restore => restore()); }
                }, prefix);
                assert.deepEqual(result, { source: '/thumbnail?type=avatar&file=fixture.png', subscriptions: 0, released: true });
                report.evidence.nativeAvatars = result;
            } finally { await page.close(); }
        });
        await scenario('a released preview closes its pending bitmap without rasterizing or encoding', async () => {
            const page = await open();
            try {
                await page.evaluate(async prefix => {
                    const create = createImageBitmap;
                    const encode = HTMLCanvasElement.prototype.toBlob;
                    window.previewEncodes = 0;
                    HTMLCanvasElement.prototype.toBlob = function (...args) { if (this.width === 41) previewEncodes++; return encode.apply(this, args); };
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
        await scenario('stable previews keep observer ownership and release original warmup on collapse', async () => {
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
                    let batches = 0;
                    const observer = new MutationObserver(records => batches += records.filter(record => record.addedNodes.length).length);
                    observer.observe(document.getElementById('iig_library_entities'), { childList: true });
                    document.querySelector('[data-library-tab="user"]').click();
                    while (document.querySelectorAll('.iig-library-entity[data-library-kind="user"]').length !== 80) await new Promise(requestAnimationFrame);
                    observer.disconnect(); return batches;
                }, prefix);
                assert.equal(mutations, 2, 'Insert the row fragment and the search note, not 80 separate rows');
                report.evidence.personaInsertBatches = mutations;
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
                await page.locator('#iig_library_search').fill('');
                await page.waitForFunction(() => document.querySelectorAll('.iig-library-entity').length === 2);
                assert.equal(await page.evaluate(() => [...document.querySelectorAll('.iig-library-entity')].includes(betaRow)), true);
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
        report.passed = report.failures.length === 0;
        fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
        await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
