const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Real settings UI and pipeline; fake Tavern state and provider HTTP responses.
// Failures covered: leaked image descriptions, tab cross-talk, lost focus/scroll,
// missing profile fields, wrong native payload/snapshot and narrow-window overflow.
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/sillyimages/';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JQAAAABJRU5ErkJggg==';
const host = `<!doctype html><html><head><link rel="stylesheet" href="${prefix}style.css">
<style>:root{--SmartThemeQuoteColor:#c7b89f;--SmartThemeBodyColor:#eee;--SmartThemeBorderColor:#666;--SmartThemeBlurTintColor:#302c35}body{background:#302c35;color:#eee;font:16px sans-serif;margin:10px}*{box-sizing:border-box}.menu_button{background:#444;color:#eee;border:0;padding:7px;border-radius:5px;cursor:pointer}.text_pole,select{background:#27232c;color:#eee;border:1px solid #666;border-radius:5px;padding:6px;min-width:0}textarea{resize:vertical}.flex-row{display:flex;gap:8px;align-items:center}.flex1{flex:1}.checkbox_label{display:flex;gap:8px;align-items:center}input[type=checkbox]{width:16px;height:16px}.inline-drawer-content{display:block}</style></head>
<body><div id="extensions_settings"></div><img id="result"><script type="module">
window.toastr={info(){},success(){},error(){},warning(){}};
window.context={extensionSettings:{},characters:[],chat:[],characterId:-1,powerUserSettings:{personas:{}},saveSettingsDebounced(){},getRequestHeaders:()=>({'Content-Type':'application/json'})};
window.SillyTavern={getContext:()=>context};
window.requests=[]; const realFetch=window.fetch.bind(window);
window.fetch=async(url,init={})=>{
 const u=String(url); if(u.startsWith('https://')) {
 requests.push({url:u,headers:init.headers,body:init.body?JSON.parse(init.body):null});
 if(u.endsWith('/api/models')) return Response.json({models:[{id:'banana',references:true},{id:'novelai-v5',references:false,negative_prompt:true}]});
 if(u.endsWith('/ai/generate-image')) return Response.json({images:[{image:'${png}',seed:42}]},{status:201});
 if(u.endsWith('/api/generate')) return Response.json({data_url:'data:image/png;base64,${png}'});
 return new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}});
 } if(u.startsWith('/api/')) return Response.json([]);
 return realFetch(url,init);
};
const settingsModule=await import('${prefix}src/settings.js');
const settings=settingsModule.getSettings(); Object.assign(settings,{apiType:'naistera',endpoint:'https://naistera.org',apiKey:'test-key',naisteraModel:'banana',naisteraCharacterDescriptionsMode:'none',maxRetries:0});
settings.styles=Array.from({length:20},(_,i)=>({id:'style-'+i,name:'Style '+i,value:'painting '+i}));settings.activeStyleId='style-0';
settings.lorebooks=[{id:'book',name:'Book',enabled:true,refs:[{id:'image',name:'Lenore',imagePath:'https://example.test/ref.png',description:'IMAGE_DESCRIPTION'},{id:'text',name:'Lenore',description:'TEXT_DESCRIPTION'}]}];
const ui=await import('${prefix}src/ui.js'); ui.createSettingsUI();
window.app={settings,settingsModule,ui,references:await import('${prefix}src/references.js'),providers:await import('${prefix}src/providers.js'),pipeline:await import('${prefix}src/pipeline.js')};window.ready=true;
</script></body></html>`;

const server = createServer((req, res) => {
    let body;
    let type = 'application/javascript';
    if (req.url === '/') { body = host; type = 'text/html'; }
    else if (req.url === '/scripts/i18n.js') body = 'export const t=(s,...v)=>String.raw({raw:s},...v); export const translate=s=>s;';
    else if (req.url === '/scripts/popup.js') body = 'export class Popup { static show={input:async()=>"Test prompt",confirm:async()=>true}; }';
    else if (req.url.startsWith(prefix)) {
        const file = path.resolve(root, decodeURIComponent(req.url.slice(prefix.length)));
        if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
        try { body = readFileSync(file); } catch { res.writeHead(404).end(); return; }
        if (file.endsWith('.css')) type = 'text/css';
    } else { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': type }); res.end(body);
});

(async () => {
    const artifacts = path.resolve(process.env.IIG_E2E_ARTIFACTS || 'tests/artifacts/novelai');
    mkdirSync(artifacts, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true, ...(process.env.IIG_BROWSER_CHANNEL ? { channel: process.env.IIG_BROWSER_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
    const errors = [];
    const checks = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => window.ready);
        await page.locator('[data-section-id="iig_api_section"] > summary').click();
        await page.locator('[data-section-id="iig_styles_section"] > summary').click();
        assert.equal(await page.locator('[data-section-id="iig_styles_section"] > summary .iig-section-title').textContent(), 'Styles & Negatives');
        await page.locator('#iig_api_section .iig-settings-group').evaluateAll(groups => groups.forEach(group => group.open = true));
        const emptyLibraryMetrics = {};
        await page.addStyleTag({content: '.menu_button:not(.disabled):not([disabled]):hover,.menu_button:not(.disabled):not([disabled]).active{background-color:var(--white30a)}'});
        const savedStyles = await page.evaluate(() => {
            const saved = {styles: app.settings.styles, activeStyleId: app.settings.activeStyleId};
            app.settings.styles = []; app.settings.activeStyleId = ''; app.ui.renderStyleSettings();
            return saved;
        });
        for (const library of ['styles', 'negativePrompts']) {
            await page.locator(`[data-style-library="${library}"]`).click();
            const none = page.locator('[data-style-disable]');
            assert.equal((await none.textContent()).trim(), library === 'styles' ? 'No style' : 'Value from API settings');
            assert.equal(await none.getAttribute('aria-pressed'), 'true');
            for (const [theme, body, tint, quote] of [
                ['dark', '#eeeeee', '#302c35', '#c7b89f'],
                ['light', '#29232c', '#f7e8ee', '#bd467c'],
            ]) {
                await page.evaluate(({body, tint, quote}) => {
                    const root = document.documentElement.style;
                    root.setProperty('--SmartThemeBodyColor', body);
                    root.setProperty('--SmartThemeBlurTintColor', tint);
                    root.setProperty('--SmartThemeQuoteColor', quote);
                    root.setProperty('--white30a', 'rgba(255,255,255,0.3)');
                }, {body, tint, quote});
                await none.hover();
                const metrics = await page.evaluate(() => {
                    const none = document.querySelector('[data-style-disable]');
                    const empty = document.querySelector('.iig-style-editor-empty');
                    const range = document.createRange(); range.selectNodeContents(empty);
                    const text = range.getBoundingClientRect(), box = empty.getBoundingClientRect();
                    const css = getComputedStyle(none);
                    return {textColor: css.color, bodyColor: getComputedStyle(document.body).color,
                        background: css.backgroundColor, opacity: css.opacity, filter: css.filter,
                        dx: Math.abs((text.left + text.right - box.left - box.right) / 2),
                        dy: Math.abs((text.top + text.bottom - box.top - box.bottom) / 2), height: box.height};
                });
                assert.equal(metrics.textColor, body === '#eeeeee' ? 'rgb(238, 238, 238)' : 'rgb(41, 35, 44)');
                assert.equal(metrics.opacity, '1');
                assert.equal(metrics.filter, 'none');
                assert.notEqual(metrics.background, 'rgba(255, 255, 255, 0.3)');
                assert.ok(metrics.dx <= 1 && metrics.dy <= 1, `${library}/${theme} empty editor not centered: ${JSON.stringify(metrics)}`);
                assert.ok(metrics.height >= 132);
                emptyLibraryMetrics[`${library}/${theme}`] = metrics;
                await page.locator('#iig_styles_section').screenshot({path: path.join(artifacts, `empty-${library}-${theme}.png`)});
            }
        }
        await page.evaluate(saved => {
            Object.assign(app.settings, saved);
            const root = document.documentElement.style;
            for (const key of ['--SmartThemeBodyColor', '--SmartThemeBlurTintColor', '--SmartThemeQuoteColor', '--white30a']) root.removeProperty(key);
            app.ui.renderStyleSettings();
        }, savedStyles);
        checks.push('empty libraries: readable selected/hover state in light/dark themes and centered editor text');
        // Cover zero/partial results, clearing, tab isolation and wrapping in a narrow panel.
        const libraryState = await page.evaluate(() => {
            const saved = structuredClone({styles: app.settings.styles, negativePrompts: app.settings.negativePrompts});
            const longText = 'a long preview with enough words to exceed the narrow list width '.repeat(3);
            app.settings.styles[2].name = 'A long style title that exceeds the narrow list width';
            app.settings.styles[2].value = longText;
            app.settings.negativePrompts = Array.from({length: 10}, (_, i) => ({id: 'negative-'+i, name: 'Negative '+i, value: longText}));
            app.ui.renderStyleSettings();
            return saved;
        });
        for (const library of ['styles', 'negativePrompts']) {
            await page.locator(`[data-style-library="${library}"]`).click();
            await page.locator('#iig_style_search').fill('unmatched-search-key');
            assert.equal(await page.locator('.iig-style-item:visible').count(), 0);
            assert.equal(await page.locator('.iig-style-search-empty').isVisible(), true);
            assert.equal((await page.locator('.iig-style-search-empty').textContent()).trim(), 'Nothing found.');
            assert.equal(await page.locator('#iig_style_search').evaluate(e => document.activeElement === e), true);
            await page.locator('#iig_styles_section').screenshot({path: path.join(artifacts, `search-empty-${library}.png`)});
            await page.locator(`[data-style-library="${library === 'styles' ? 'negativePrompts' : 'styles'}"]`).click();
            assert.equal(await page.locator('#iig_style_search').inputValue(), '');
            await page.locator(`[data-style-library="${library}"]`).click();
            assert.equal(await page.locator('#iig_style_search').inputValue(), 'unmatched-search-key');
            assert.equal(await page.locator('.iig-style-search-empty').isVisible(), true);
            await page.locator('#iig_style_search').fill(library === 'styles' ? 'Style 19' : 'Negative 9');
            assert.equal(await page.locator('.iig-style-item:visible').count(), 1);
            assert.equal(await page.locator('.iig-style-search-empty').isVisible(), false);
            await page.locator(`[data-style-select="${library === 'styles' ? 'style-19' : 'negative-9'}"]`).click();
            await page.locator('#iig_style_name').fill('Changed entry');
            assert.equal(await page.locator('.iig-style-item:visible').count(), 0);
            assert.equal(await page.locator('.iig-style-search-empty').isVisible(), true);
            assert.equal(await page.locator('#iig_style_name').evaluate(e => document.activeElement === e), true);
            await page.locator('#iig_style_name').fill(library === 'styles' ? 'Style 19' : 'Negative 9');
            assert.equal(await page.locator('.iig-style-search-empty').isVisible(), false);
            await page.locator('#iig_style_search').fill('');
            assert.equal(await page.locator('.iig-style-item:visible').count(), library === 'styles' ? 20 : 10);
            await page.setViewportSize({width: 390, height: 844});
            const preview = page.locator(`[data-style-select="${library === 'styles' ? 'style-2' : 'negative-2'}"] small`);
            const metrics = await preview.evaluate(e => {
                const range = document.createRange(); range.selectNodeContents(e);
                return {whiteSpace: getComputedStyle(e).whiteSpace,
                    lines: new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size,
                    textLength: e.textContent.length, textOverflow: getComputedStyle(e).textOverflow};
            });
            assert.equal(metrics.whiteSpace, 'nowrap');
            assert.equal(metrics.lines, 1);
            assert.equal(metrics.textOverflow, 'ellipsis');
            assert.ok(metrics.textLength <= 53);
            assert.equal(await page.locator(`[data-style-select="${library === 'styles' ? 'style-2' : 'negative-2'}"] strong`).evaluate(e => getComputedStyle(e).whiteSpace), 'nowrap');
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.locator('#iig_styles_section').screenshot({path: path.join(artifacts, `previews-${library}-mobile.png`)});
            await page.setViewportSize({width: 900, height: 1000});
        }
        await page.evaluate(saved => {Object.assign(app.settings, saved); app.ui.renderStyleSettings();}, libraryState);
        checks.push('both libraries: zero/partial/cleared search results, retained focus and single-line mobile previews');
        await page.locator('#iig_styles_section [data-style-library="negativePrompts"]').click();
        await page.locator('#iig_style_add').click();
        await page.locator('#iig_style_value').fill('bad anatomy');
        await page.locator('#iig_style_toggle_active').click();
        assert.equal(await page.locator('[data-style-disable]').getAttribute('aria-pressed'), 'false');
        assert.equal(await page.evaluate(() => app.settings.styles.length), 20);
        assert.equal(await page.evaluate(() => app.settings.activeStyleId), 'style-0');
        assert.equal(await page.evaluate(() => app.settings.negativePrompts[0].value), 'bad anatomy');
        checks.push('independent libraries; create/edit/activate negative prompt');
        await page.locator('#iig_styles_section [data-style-library="styles"]').click();
        await page.locator('.iig-style-list').evaluate(e => e.scrollTop = 160);
        const scroll = await page.locator('.iig-style-list').evaluate(e => e.scrollTop);
        await page.locator('[data-style-select="style-3"]').click();
        assert.equal(await page.evaluate(() => app.settings.activeStyleId), 'style-0');
        assert.equal(await page.locator('.iig-style-list').evaluate(e => e.scrollTop), scroll);
        await page.locator('#iig_style_value').fill('new painting');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'iig_style_value');
        checks.push('opening does not activate; editing retains focus and list position');

        const transition = await page.evaluate(async () => {
            await app.pipeline.generateImageWithRetry('Lenore in a room', '');
            const before = requests.filter(r => r.body?.prompt).at(-1).body;
            app.settings.naisteraModel='novelai-v5';
            await app.pipeline.generateImageWithRetry('Lenore in a room', '');
            return {before,after:requests.filter(r=>r.body?.prompt).at(-1).body,snapshot:app.settingsModule.getLastRequestSnapshot()};
        });
        assert.match(transition.before.prompt, /IMAGE_DESCRIPTION/);
        assert.doesNotMatch(transition.after.prompt, /IMAGE_DESCRIPTION/);
        assert.match(transition.after.prompt, /TEXT_DESCRIPTION/);
        assert.equal(transition.after.negative_prompt, 'bad anatomy');
        assert.equal(transition.snapshot.prompt, transition.after.prompt);
        assert.equal(transition.snapshot.matchedRefs.length, 1);
        checks.push('Naistera model switch filters image reference and its description; snapshot agrees');

        await page.locator('#iig_api_type').selectOption('novelai');
        await page.waitForFunction(() => document.querySelector('#iig_model_select option[value="nai-diffusion-5-full"]'));
        await page.locator('#iig_model_select').selectOption('nai-diffusion-5-full');
        assert.equal(await page.locator('#iig_novelai_resolution').inputValue(), '832x1216');
        for (const size of ['832x1216', '1216x832', '1024x1024', '1024x1536', '1536x1024', '1536x1536']) {
            await page.locator('#iig_novelai_resolution').selectOption(size);
            const [width, height] = size.split('x');
            assert.equal(await page.locator('#iig_novelai_width').inputValue(), width);
            assert.equal(await page.locator('#iig_novelai_height').inputValue(), height);
        }
        await page.locator('#iig_novelai_resolution').selectOption('1216x832');
        assert.equal(await page.locator('#iig_novelai_width').inputValue(), '1216');
        assert.equal(await page.locator('#iig_novelai_height').inputValue(), '832');
        await page.locator('#iig_novelai_width').fill('1152');
        assert.equal(await page.locator('#iig_novelai_resolution').inputValue(), 'custom');
        await page.locator('#iig_novelai_resolution').selectOption('1024x1024');
        assert.equal(await page.locator('#iig_novelai_height').inputValue(), '1024');
        await page.locator('#iig_novelai_resolution').selectOption('832x1216');
        checks.push('resolution presets update dimensions; custom dimensions and profile-derived selection');
        await page.locator('[data-section-id="iig_references_section"] > summary').click();
        assert.equal(await page.locator('#iig_additional_refs_section').isVisible(), true);
        const imageRow = page.locator('.iig-additional-ref-list-row[data-ref-id="image"]');
        const textRow = page.locator('.iig-additional-ref-list-row[data-ref-id="text"]');
        assert.equal(await imageRow.locator('input[type="checkbox"]').isDisabled(), true);
        assert.equal(await imageRow.locator('[data-ref-select]').isDisabled(), true);
        assert.equal(await imageRow.evaluate(e => getComputedStyle(e).opacity), '0.35');
        assert.equal(await page.locator('#iig_additional_refs_import').isDisabled(), true);
        assert.equal(await page.locator('.iig-additional-ref-editor-content').evaluate(e => e.disabled), true);
        await textRow.locator('[data-ref-select]').click();
        assert.equal(await page.locator('.iig-additional-ref-description').isDisabled(), false);
        await page.locator('.iig-additional-ref-description').fill('TEXT_DESCRIPTION edited');
        assert.equal(await page.locator('.iig-additional-ref-description').evaluate(e => document.activeElement === e), true);
        assert.equal(await page.locator('.iig-additional-ref-upload-url').isDisabled(), true);
        await textRow.locator('input[type="checkbox"]').uncheck();
        let referencePrompt = await page.evaluate(async () => {
            await app.pipeline.generateImageWithRetry('Lenore in a room', '');
            return requests.at(-1).body.parameters.v4_prompt.caption.base_caption;
        });
        assert.doesNotMatch(referencePrompt, /TEXT_DESCRIPTION|IMAGE_DESCRIPTION/);
        await page.locator('#iig_send_ref_descriptions').uncheck();
        await textRow.locator('input[type="checkbox"]').check();
        referencePrompt = await page.evaluate(async () => {
            await app.pipeline.generateImageWithRetry('Lenore in a room', '');
            return requests.at(-1).body.parameters.v4_prompt.caption.base_caption;
        });
        assert.doesNotMatch(referencePrompt, /TEXT_DESCRIPTION|IMAGE_DESCRIPTION/);
        await page.locator('#iig_send_ref_descriptions').check();
        referencePrompt = await page.evaluate(async () => {
            await app.pipeline.generateImageWithRetry('Lenore in a room', '');
            return requests.at(-1).body.parameters.v4_prompt.caption.base_caption;
        });
        assert.match(referencePrompt, /TEXT_DESCRIPTION/);
        assert.doesNotMatch(referencePrompt, /IMAGE_DESCRIPTION/);
        const macro = await page.evaluate(() => app.references.renderIigBookMacro(app.settings, app.providers.resolveActiveProvider(app.settings).supportsReferences(app.settings)));
        assert.match(macro, /TEXT_DESCRIPTION/);
        assert.doesNotMatch(macro, /IMAGE_DESCRIPTION/);
        await page.locator('#iig_api_type').selectOption('naistera');
        await page.locator('#iig_naistera_model').selectOption('banana');
        assert.equal(await imageRow.locator('input[type="checkbox"]').isDisabled(), false);
        assert.equal(await imageRow.locator('input[type="checkbox"]').isChecked(), true);
        await page.locator('#iig_naistera_model').selectOption('novelai-v5');
        assert.equal(await imageRow.locator('input[type="checkbox"]').isDisabled(), true);
        assert.equal(await textRow.locator('input[type="checkbox"]').isDisabled(), false);
        await page.locator('#iig_api_type').selectOption('novelai');
        await page.locator('label:has(input[name="iig_additional_refs_mode"][value="power"])').click();
        assert.equal(await imageRow.locator('input[type="checkbox"]').isDisabled(), true);
        await page.locator('label:has(input[name="iig_additional_refs_mode"][value="simple"])').click();
        checks.push('text references remain editable and toggle generation; image controls dim/disable and restore across providers and modes');
        for (const [field, value] of [['steps','28'],['cfg_scale','7'],['cfg_rescale','0.25'],['seed','42']]) {
            await page.locator('#iig_novelai_'+field).fill(value);
        }
        await page.locator('#iig_novelai_character_descriptions_mode').selectOption('none');
        const native = await page.evaluate(async () => {
            const data = await app.pipeline.generateImageWithRetry('scene | 1boy \\| 1girl', '');
            document.querySelector('#result').src = data;
            return {data,request:requests.at(-1),snapshot:app.settingsModule.getLastRequestSnapshot(),profile:app.settingsModule.createConnectionProfile('Native')};
        });
        assert.equal(native.request.headers.Accept, 'application/json');
        assert.equal(native.request.url, 'https://image.novelai.net/ai/generate-image');
        assert.equal(native.request.body.parameters.steps, 28);
        assert.equal(native.request.body.parameters.cfg_rescale, 0.25);
        assert.equal(native.request.body.parameters.seed, 42);
        assert.equal(native.request.body.parameters.v4_prompt.caption.char_captions.length, 2);
        assert.equal(native.request.body.parameters.negative_prompt, 'bad anatomy');
        assert.equal(native.request.body.parameters.noise_schedule, undefined);
        assert.equal(native.request.body.parameters.skip_cfg_above_sigma, undefined);
        assert.equal(native.profile.novelaiSteps, 28);
        assert.equal(native.profile.novelaiCfgRescale, 0.25);
        assert.equal(native.profile.novelaiSeed, 42);
        assert.equal(native.snapshot.negativePrompt, 'bad anatomy');
        assert.equal(native.snapshot.metadata.size, '832x1216');
        await page.waitForFunction(() => document.querySelector('#result').naturalWidth === 1);
        checks.push('native source UI -> pipeline -> JSON request -> decoded image; snapshot and profile');
        await page.locator('#iig_profile_save_as').click();
        await page.locator('#iig_novelai_steps').fill('12');
        await page.locator('#iig_novelai_resolution').selectOption('1536x1536');
        await page.locator('#iig_profile_select').selectOption(await page.locator('#iig_profile_select').inputValue());
        assert.equal(await page.locator('#iig_novelai_steps').inputValue(), '28');
        assert.equal(await page.locator('#iig_novelai_cfg_rescale').inputValue(), '0.25');
        assert.equal(await page.locator('#iig_novelai_resolution').inputValue(), '832x1216');
        checks.push('connection profile restores native settings in the UI');
        await page.locator('#iig_styles_section [data-style-library="negativePrompts"]').click();
        await page.locator('#iig_style_duplicate').click();
        assert.equal(await page.evaluate(() => app.settings.negativePrompts.length), 2);
        await page.locator('#iig_style_remove').click();
        assert.equal(await page.evaluate(() => app.settings.negativePrompts.length), 1);
        await page.locator('[data-style-disable]').click();
        assert.equal(await page.locator('#iig_novelai_negative_prompt').isDisabled(), false);
        await page.locator('#iig_novelai_negative_prompt').fill('custom negative');
        const fallbackNegative = await page.evaluate(async () => {
            await app.pipeline.generateImageWithRetry('scene', '');
            return requests.at(-1).body.parameters.negative_prompt;
        });
        assert.equal(fallbackNegative, 'custom negative');
        assert.equal((await page.locator('[data-style-disable]').textContent()).trim(), 'Value from API settings');
        await page.locator('#iig_style_toggle_active').click();
        assert.equal(await page.locator('#iig_novelai_negative_prompt').inputValue(), 'bad anatomy');
        await page.locator('[data-section-id="iig_characters_section"] > summary').click();
        await page.waitForTimeout(100);
        assert.equal(await page.locator('[data-style-library="negativePrompts"]').evaluate(e => e.classList.contains('selected')), true);
        checks.push('negative prompt duplicate/delete/disable; custom fallback and library override');
        const descriptions = await page.evaluate(async () => {
            context.characters=[{name:'Lenore',avatar:'lenore.png'}]; context.characterId=0;
            const char = app.references.getCharacterLibraryEntry('char',app.references.getCurrentCharacterReferenceKey());
            char.primary.description='CHAR_DESCRIPTION';
            char.appearanceItems=[{id:'img',type:'image',enabled:true,imagePath:'https://example.test/extra.png',description:'EXTRA_IMAGE_DESCRIPTION'}];
            app.settings.userAvatarFile='persona.png';
            const user = app.references.getCharacterLibraryEntry('user',app.references.getUserReferenceKeyForAvatar('persona.png'));
            user.primary.description='USER_DESCRIPTION';
            app.settings.novelaiCharacterDescriptionsMode='character-prompt';
            await app.pipeline.generateImageWithRetry('scene', '');
            const enabled=requests.at(-1).body.parameters.v4_prompt.caption.char_captions;
            app.settings.novelaiCharacterDescriptionsMode='none';
            await app.pipeline.generateImageWithRetry('scene', '');
            return {enabled,disabled:requests.at(-1).body.parameters.v4_prompt.caption.char_captions};
        });
        assert.deepEqual(descriptions.enabled.map(c => c.char_caption), ['USER_DESCRIPTION','CHAR_DESCRIPTION']);
        assert.deepEqual(descriptions.disabled, []);
        checks.push('explicit character/persona description mode produces captions and disables cleanly');
        const cancelled = await page.evaluate(async () => {
            const count=requests.length;
            const controller=new AbortController();controller.abort('user-cancel');
            try {await app.pipeline.generateImageWithRetry('scene','',null,{signal:controller.signal});return null;}
            catch(error){return {code:error.code,requests:requests.length-count};}
        });
        assert.deepEqual(cancelled, {code:'aborted',requests:0});
        checks.push('cancelled request does not call the provider');
        await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile overflow');
        await page.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
        checks.push('390px layout without horizontal overflow');
        assert.deepEqual(errors, []);
        writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify({ checks, errors, transition, native, emptyLibraryMetrics }, null, 2));
        console.log(JSON.stringify({ checks, artifacts }, null, 2));
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
