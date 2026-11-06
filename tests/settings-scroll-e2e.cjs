const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { chromium, webkit } = require('playwright');

// Failure cases: host drawer animations retain an inline height; switching to a
// longer gallery overlaps later extensions; hidden overflow clips later settings;
// nested lists trap wheel input; and reopening a viewer or section locks scrolling.
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/sillyimages/';
const engine = process.env.IIG_BROWSER_ENGINE || 'chromium';
const artifacts = path.resolve(process.env.IIG_SCROLL_ARTIFACTS || path.join(__dirname, 'artifacts', 'settings-scroll-' + engine));
const filter = process.env.IIG_SCROLL_FILTER && new RegExp(process.env.IIG_SCROLL_FILTER);
const fixture = fs.readFileSync(path.join(__dirname, 'generation-library-e2e.cjs'), 'utf8');
const scope = { require, __dirname };
vm.runInNewContext(fixture.slice(0, fixture.indexOf('const server=')) + '\nglobalThis.hostText=host;', scope);
const hostStyles = `
html,body{margin:0;height:100%;overflow:hidden}
#rm_extensions_block{position:absolute;top:35px;left:0;right:0;margin:auto;width:min(2200px,100%);max-height:calc(100dvh - 80px);overflow-y:scroll;padding:5px;border:1px solid #666}
#rm_extensions_block::-webkit-scrollbar{width:12px}
#rm_extensions_block::-webkit-scrollbar-thumb{background:#aaa}
.extensions_block{display:flex;flex-wrap:wrap;gap:5px}
#extensions_settings,#extensions_settings2{flex:1;min-width:0}
#iig_settings_root>.inline-drawer-content{display:block}
#following-extension{height:200px;position:relative;background:#423d47;padding:16px}
@media(max-width:700px){#extensions_settings,#extensions_settings2{flex-basis:100%}}
`;
const hostMarkup = '<div id="rm_extensions_block" tabindex="-1"><div class="extensions_block"><div id="extensions_settings"></div><div id="extensions_settings2">Other extensions</div></div></div>';
const seed = `
context.characters.push(...Array.from({length:98},(_,i)=>({name:'Character '+i,avatar:'extra-'+i+'.png'})));
settings.characterReferenceLibrary.characters['avatar:a.png'].generations=Array.from({length:44},(_,i)=>gen('gallery-'+i,'iig_gallery_'+i+'.png'));
settings.lorebooks[0].enabled=true;
settings.lorebooks[0].refs=Array.from({length:44},(_,i)=>({id:'reference-'+i,enabled:true,name:'Reference '+i,keys:'Reference '+i,imagePath:url('Beta','iig_lore_'+i+'.png'),description:'Reference description '+i}));
`;
const host = scope.hostText
    .replace('</head>', '<style>' + hostStyles + '</style></head>')
    .replace('<div id="extensions_settings"></div>', hostMarkup)
    .replace('const library=await import', seed + '\nconst library=await import')
    .replace("if(location.hash!=='#debug-only')await library.renderCharacterLibrary(settings);", '')
    .replace("for(const id of location.hash==='#debug-only'?['iig_debug_section']:['iig_characters_section','iig_debug_section'])document.getElementById(id).closest('details').open=true;", `
        document.querySelectorAll('.iig-section').forEach(section=>section.open=false);
        document.getElementById('extensions_settings').insertAdjacentHTML('beforeend','<div id="following-extension">Following extension <input aria-label="Following extension input"></div>');
    `);
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720"><rect width="480" height="720" fill="#557383"/><circle cx="240" cy="250" r="150" fill="#dcc299"/></svg>';
const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    let body, type = 'application/javascript';
    if (url.pathname === '/') { body = host; type = 'text/html'; }
    else if (/^\/(user\/images|thumbnail|User(?:%20| )Avatars)/.test(req.url)) { body = picture; type = 'image/svg+xml'; }
    else if (url.pathname === '/scripts/i18n.js') body = 'export const t=(s,...v)=>String.raw({raw:s},...v);export const translate=s=>s;';
    else if (url.pathname === '/scripts/popup.js') body = 'export class Popup {static show={confirm:(...args)=>window.confirmDeletion(...args)};}';
    else {
        if (!url.pathname.startsWith(prefix)) return res.writeHead(404).end();
        const file = path.resolve(root, decodeURIComponent(url.pathname.slice(prefix.length)));
        if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
        try { body = fs.readFileSync(file); } catch { return res.writeHead(404).end(); }
        if (file.endsWith('.css')) type = 'text/css';
    }
    res.writeHead(200, { 'Content-Type': type }).end(body);
});

async function geometry(page) {
    return page.evaluate(() => {
        const panel = document.getElementById('rm_extensions_block');
        const rect = element => {
            const box = element?.getBoundingClientRect();
            return box && { top: box.top, bottom: box.bottom, height: box.height, left: box.left, width: box.width };
        };
        const debug = document.querySelector('[data-section-id="iig_debug_section"] > summary');
        const bounds = rect(panel), target = rect(debug);
        const hit = document.elementFromPoint(target.left + target.width / 2, target.top + target.height / 2);
        return {
            scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight,
            panel: bounds, debug: target, content: rect(document.querySelector('#iig_settings_root > .inline-drawer-content')),
            settings: rect(document.querySelector('.iig-settings')), following: rect(document.getElementById('following-extension')),
            last: rect(document.querySelector('.iig-library-generation-item:last-child')),
            debugReachable: target.top >= bounds.top && target.bottom <= bounds.bottom && debug.contains(hit),
            modal: Boolean(document.querySelector('dialog[open]')),
        };
    });
}

(async () => {
    fs.mkdirSync(artifacts, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], ...(engine === 'chromium' ? process.env.IIG_BROWSER_EXECUTABLE ? { executablePath: process.env.IIG_BROWSER_EXECUTABLE } : { channel: process.env.IIG_BROWSER_CHANNEL || 'msedge' } : {}) });
    const report = { engine, browser: browser.version(), checks: [], failures: [], cases: [], sources: {} };
    for (const file of ['style.css', 'src/libraryImages.js', 'src/characterLibraryUi.js', 'src/ui.js', 'tests/settings-scroll-e2e.cjs']) report.sources[file] = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    fs.writeFileSync(path.join(artifacts, 'fixture.html'), host);
    try {
        for (const width of [2560, 1440, 390]) for (const scenario of ['characters', 'references', 'references-height', 'switch-short-long', 'retained-height', 'clipped-height', 'scrollbar', 'collapse-loading', 'after-viewer']) {
            const section = scenario.startsWith('references') ? 'references' : 'characters';
            const name = scenario + '-' + width;
            if (filter && !filter.test(name)) continue;
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            const evidence = { name, samples: [], errors };
            report.cases.push(evidence);
            try {
                await page.goto('http://127.0.0.1:' + server.address().port);
                await page.waitForFunction(() => window.ready);
                if (scenario === 'references-height') await page.evaluate(() => {
                    const content = document.querySelector('#iig_settings_root > .inline-drawer-content');
                    content.style.height = content.getBoundingClientRect().height + 'px';
                    content.style.overflow = 'hidden';
                });
                await page.locator(`[data-section-id="iig_${section}_section"] > summary`).click();
                if (section === 'characters') await page.waitForFunction(() => document.querySelectorAll('.iig-library-generation-item').length === 44);
                if (['switch-short-long', 'retained-height', 'clipped-height', 'scrollbar'].includes(scenario)) {
                    await page.locator('.iig-library-entity[data-library-key="avatar:b.png"]').click();
                    await page.waitForFunction(() => document.querySelectorAll('.iig-library-generation-item').length === 2);
                    if (scenario !== 'switch-short-long') {
                        // State retained by the host's interrupted slideToggle animation.
                        evidence.hostHeight = await page.evaluate(clip => {
                            const content = document.querySelector('#iig_settings_root > .inline-drawer-content');
                            const height = content.getBoundingClientRect().height;
                            content.style.height = height + 'px';
                            if (clip) content.style.overflow = 'hidden';
                            return height;
                        }, scenario === 'clipped-height' || scenario === 'scrollbar');
                    }
                    await page.locator('.iig-library-entity[data-library-key="avatar:a.png"]').click();
                    await page.waitForFunction(() => document.querySelectorAll('.iig-library-generation-item').length === 44);
                }
                if (scenario === 'collapse-loading') {
                    await page.locator('[data-section-id="iig_characters_section"] > summary').click();
                    await page.locator('[data-section-id="iig_characters_section"] > summary').click();
                }
                if (scenario === 'after-viewer') {
                    await page.locator('.iig-library-generation-item img').first().click();
                    await page.waitForFunction(() => document.getElementById('iig_lightbox').open);
                    await page.locator('.iig-lightbox-close').click();
                    await page.waitForFunction(() => !document.getElementById('iig_lightbox').open);
                }
                const bounds = await page.locator('#rm_extensions_block').boundingBox();
                const settings = await page.locator('.iig-settings').boundingBox();
                await page.mouse.move(settings.x + settings.width * 0.8, bounds.y + bounds.height * 0.65);
                evidence.samples.push(await geometry(page));
                if (scenario === 'scrollbar') {
                    const { scrollTop, scrollHeight, clientHeight } = evidence.samples[0];
                    const thumb = clientHeight * clientHeight / scrollHeight;
                    const offset = (clientHeight - thumb) * scrollTop / (scrollHeight - clientHeight);
                    const x = bounds.x + bounds.width - 6;
                    await page.mouse.move(x, bounds.y + 1 + offset + thumb / 2);
                    await page.mouse.down();
                    await page.mouse.move(x, bounds.y + bounds.height - 2, { steps: 20 });
                    await page.mouse.up();
                    await page.waitForTimeout(100);
                    evidence.samples.push(await geometry(page));
                }
                for (let step = 0; scenario !== 'scrollbar' && step < 55; step++) {
                    await page.mouse.wheel(0, 180);
                    await page.waitForTimeout(65);
                    const sample = await geometry(page);
                    evidence.samples.push(sample);
                    if (sample.debugReachable) break;
                }
                evidence.result = await geometry(page);
                await page.screenshot({ path: path.join(artifacts, name + '.png') });
                assert.ok(evidence.result.debugReachable, 'Wheel scrolling must reach and hit Debug, not a covering extension');
                assert.ok(evidence.result.content.height + 1 >= evidence.result.settings.height, 'The open drawer must contain its growing libraries');
                assert.ok(evidence.result.following.top + 1 >= evidence.result.settings.bottom, 'Following extensions must not overlap settings');
                assert.equal(evidence.result.modal, false, 'No modal may retain input ownership');
                await page.mouse.click(evidence.result.debug.left + 60, evidence.result.debug.top + 15);
                assert.equal(await page.locator('[data-section-id="iig_debug_section"]').getAttribute('open'), '', 'Debug must open through an actual pointer click');
                assert.deepEqual(errors, []);
                report.checks.push(name + ': later settings remain reachable');
            } catch (error) {
                report.failures.push({ name, error: String(error) });
                evidence.result = await geometry(page).catch(() => null);
                await page.screenshot({ path: path.join(artifacts, name + '-failure.png') }).catch(() => {});
            } finally { await page.close(); }
        }
    } finally {
        report.passed = report.failures.length === 0 && report.checks.length > 0;
        fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ passed: report.passed, checks: report.checks, failures: report.failures, report: path.join(artifacts, 'report.json') }, null, 2));
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        process.exitCode = report.passed ? 0 : 1;
    }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
