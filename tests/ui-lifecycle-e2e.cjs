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
    else if (req.url === '/slow.svg') return; // Released with the browser context after the timeout scenario.
    else if (req.url === '/scripts/i18n.js') body = 'export const t=(s,...v)=>String.raw({raw:s},...v);export const translate=s=>s;';
    else if (req.url === '/scripts/popup.js') body = 'export class Popup{static show={confirm:async()=>false,input:async()=>null};}';
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
    } finally {
        report.passed = report.failures.length === 0;
        fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
        await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
