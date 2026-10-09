const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Real settings UI/provider. Cover wire settings, Medium locks, retained High
// values, provider isolation, profiles and desktop/mobile layout. Direct Medium
// also covers fixed UC/character negatives, request-only overrides and snapshots.
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/sillyimages/';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JQAAAABJRU5ErkJggg==';
const samplers = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_2s_ancestral', 'k_dpmpp_sde'];
const parameters = (max, medium = false) => ({
    steps: { min: medium ? 14 : 1, max, default: medium ? 14 : 23 },
    sampler: { choices: medium ? [samplers[0]] : samplers, default: samplers[0] },
    scale: { min: 0, max: 10, default: 7 },
    cfg_rescale: medium ? null : { min: 0, max: 1, default: 0 },
});
const models = [
    {id: 'nano-banana-2', name: 'Nano Banana 2', references: true},
    {id: 'novelai-v4.5', name: 'NovelAI V4.5', references: false, negative_prompt: true, parameters: parameters(28)},
    {id: 'novelai-v5', name: 'NovelAI V5', references: false, negative_prompt: true, parameters: parameters(23)},
    {id: 'novelai-v5-medium', name: 'NovelAI V5 Medium', references: false, negative_prompt: false, parameters: parameters(14, true)},
];
const host = `<!doctype html><html><head><link rel="stylesheet" href="${prefix}style.css">
<style>:root{--SmartThemeQuoteColor:#c7b89f;--SmartThemeBodyColor:#eee;--SmartThemeBorderColor:#666;--SmartThemeBlurTintColor:#302c35}body{background:#302c35;color:#eee;font:16px sans-serif;margin:10px}*{box-sizing:border-box}.menu_button{background:#444;color:#eee;border:0;padding:7px;border-radius:5px}.text_pole,select{background:#27232c;color:#eee;border:1px solid #666;padding:6px;min-width:0}.flex-row{display:flex;gap:8px;align-items:center}.flex1{flex:1}.inline-drawer-content{display:block}</style></head><body><div id="extensions_settings"></div><script type="module">
window.toastr={info(){},success(){},error(){},warning(){}};
window.context={extensionSettings:{},characters:[],chat:[],characterId:-1,powerUserSettings:{personas:{}},saveSettingsDebounced(){},getRequestHeaders:()=>({'Content-Type':'application/json'})};
window.SillyTavern={getContext:()=>context}; window.requests=[];
const realFetch=fetch.bind(window);
window.fetch=async(url,init={})=>{
 if(String(url).startsWith('https://')) {
  requests.push({url:String(url),body:init.body?JSON.parse(init.body):null});
  if(String(url).endsWith('/api/models')) return Response.json({models:${JSON.stringify(models)}});
  if(String(url).endsWith('/ai/generate-image')) return Response.json({images:[{image:'${png}'}]});
  return Response.json({data_url:'data:image/png;base64,${png}'});
 } if(String(url).startsWith('/api/')) return Response.json([]); return realFetch(url,init);
};
const settingsModule=await import('${prefix}src/settings.js'); const settings=settingsModule.getSettings();
Object.assign(settings,{apiType:'naistera',endpoint:'https://naistera.org',apiKey:'test',naisteraModel:'novelai-v5',naisteraPolling:false,maxRetries:0});
const providers=await import('${prefix}src/providers.js'); await providers.resolveActiveProvider(settings).fetchModels();
const ui=await import('${prefix}src/ui.js'); ui.createSettingsUI();
window.app={settings,settingsModule,providers,ui,pipeline:await import('${prefix}src/pipeline.js')};window.ready=true;
</script></body></html>`;
const server = createServer((req, res) => {
    let body, type = 'application/javascript';
    if (req.url === '/') { body = host; type = 'text/html'; }
    else if (req.url === '/scripts/i18n.js') body = 'export const t=(s,...v)=>String.raw({raw:s},...v);export const translate=s=>s;';
    else if (req.url === '/scripts/popup.js') body = 'export class Popup {static show={input:async()=>"Test",confirm:async()=>true};}';
    else if (req.url.startsWith(prefix)) {
        const file = path.resolve(root, decodeURIComponent(req.url.slice(prefix.length)));
        if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
        try { body = readFileSync(file); } catch { res.writeHead(404).end(); return; }
        if (file.endsWith('.css')) type = 'text/css';
    } else { res.writeHead(404).end(); return; }
    res.writeHead(200, {'Content-Type': type}); res.end(body);
});
(async () => {
    const artifacts = path.join(__dirname, 'artifacts', 'naistera-parameters');
    mkdirSync(artifacts, {recursive: true});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({headless: true, ...(process.env.IIG_BROWSER_CHANNEL ? {channel: process.env.IIG_BROWSER_CHANNEL} : {})});
    const page = await browser.newPage({viewport: {width: 900, height: 1000}});
    const errors = [], checks = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => window.ready);
        await page.locator('[data-section-id="iig_api_section"] > summary').click();
        await page.locator('#iig_api_section .iig-settings-group').evaluateAll(groups => groups.forEach(g => g.open = true));
        await page.locator('#iig_refresh_naistera_models').click();
        await page.locator('#iig_naistera_model option[value="novelai-v5-medium"]').waitFor({state: 'attached'});
        const generate = () => page.evaluate(async () => {
            await app.providers.resolveActiveProvider(app.settings).generate({prompt: 'a landscape'});
            return requests.filter(r => r.url.endsWith('/api/generate')).at(-1).body;
        });
        assert.deepEqual(await page.evaluate(() => {
            const s = app.settingsModule.defaultSettings;
            return [s.novelaiSteps,s.novelaiCfgScale,s.novelaiCfgRescale,s.novelaiSampler,
                s.naisteraSteps,s.naisteraCfgScale,s.naisteraCfgRescale,s.naisteraSampler];
        }), [23,7,0,'k_euler_ancestral',23,7,0,'k_euler_ancestral']);
        for (const model of ['novelai-v5', 'novelai-v4.5']) {
            await page.locator('#iig_naistera_model').selectOption(model);
            const defaults = await generate();
            assert.deepEqual([defaults.steps,defaults.scale,defaults.cfg_rescale,defaults.sampler], [23,7,0,'k_euler_ancestral']);
        }
        await page.locator('#iig_naistera_model').selectOption('novelai-v5');
        checks.push('both NovelAI sources default to 23 steps, guidance 7, rescale 0, Euler Ancestral');
        await page.locator('#iig_naistera_steps').fill('8');
        await page.locator('#iig_naistera_sampler').selectOption('k_euler');
        await page.locator('#iig_naistera_cfg_scale').fill('4.5');
        await page.locator('#iig_naistera_cfg_rescale').fill('0.2');
        let body = await generate();
        assert.deepEqual([body.steps, body.sampler, body.scale, body.cfg_rescale], [8, 'k_euler', 4.5, 0.2]);
        checks.push('High controls reach API');
        await page.locator('#iig_naistera_model').selectOption('novelai-v5-medium');
        assert.equal(await page.locator('#iig_naistera_steps').inputValue(), '14');
        assert.equal(await page.locator('#iig_naistera_steps').isDisabled(), true);
        assert.equal(await page.locator('#iig_naistera_sampler').isDisabled(), true);
        assert.equal(await page.locator('#iig_naistera_cfg_rescale').isVisible(), false);
        assert.equal(await page.locator('#iig_naistera_negative_prompt').isVisible(), false);
        body = await generate();
        assert.deepEqual([body.steps, body.sampler, body.scale], [14, 'k_euler_ancestral', 4.5]);
        assert.ok(!('cfg_rescale' in body) && !('negative_prompt' in body));
        checks.push('Medium constraints and adjustable guidance');
        await page.locator('#iig_naistera_model').selectOption('novelai-v5');
        assert.equal(await page.locator('#iig_naistera_steps').inputValue(), '8');
        assert.equal(await page.locator('#iig_naistera_sampler').inputValue(), 'k_euler');
        assert.equal(await page.locator('#iig_naistera_cfg_rescale').inputValue(), '0.2');
        assert.equal(await page.evaluate(() => app.settings.novelaiSteps), 23);
        checks.push('High values retained; direct NovelAI unchanged');
        const profileValues = await page.evaluate(() => {
            const profile = app.settingsModule.createConnectionProfile('NovelAI parameters', app.settings);
            Object.assign(app.settings, {naisteraSteps: 20, naisteraSampler: 'k_dpmpp_2m', naisteraCfgScale: 7, naisteraCfgRescale: 0.7});
            app.settingsModule.loadConnectionProfile(profile.id, app.settings);
            return [app.settings.naisteraSteps, app.settings.naisteraSampler, app.settings.naisteraCfgScale, app.settings.naisteraCfgRescale];
        });
        assert.deepEqual(profileValues, [8, 'k_euler', 4.5, 0.2]);
        checks.push('connection profile retains generation settings');
        for (const [name, width, height] of [['desktop',900,1000],['mobile',390,844]]) {
            await page.setViewportSize({width,height});
            await page.locator('#iig_naistera_steps').scrollIntoViewIfNeeded();
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            for (const id of ['steps','sampler','cfg_scale','cfg_rescale']) {
                assert.ok(await page.locator('#iig_naistera_'+id).evaluate(e => {const b=e.getBoundingClientRect();return b.width>20 && b.right<=innerWidth && b.left>=0;}));
            }
            await page.screenshot({path:path.join(artifacts,name+'.png')});
        }
        checks.push('desktop and mobile controls fit');
        await page.locator('#iig_naistera_model').selectOption('nano-banana-2');
        assert.equal(await page.locator('#iig_naistera_steps').isVisible(), false);
        body = await generate();
        assert.ok(!('steps' in body) && !('sampler' in body) && !('scale' in body));
        checks.push('Nano Banana payload unchanged');
        await page.setViewportSize({width:900,height:1000});
        await page.locator('#iig_api_type').selectOption('novelai');
        await page.locator('#iig_model_select option[value="nai-diffusion-5-full-medium"]').waitFor({state:'attached'});
        await page.locator('#iig_model_select').selectOption('nai-diffusion-5-full');
        await page.locator('#iig_novelai_character_descriptions_mode').selectOption('none');
        const direct = (options = {}) => page.evaluate(async options => {
            await app.pipeline.generateImageWithRetry('a landscape | a person', '', null, options);
            return {body:requests.at(-1).body,snapshot:app.settingsModule.getLastRequestSnapshot()};
        }, options);
        let native = await direct();
        assert.deepEqual([native.body.parameters.steps,native.body.parameters.scale,native.body.parameters.cfg_rescale,native.body.parameters.sampler], [23,7,0,'k_euler_ancestral']);
        for (const [field,value] of [['steps','28'],['cfg_scale','4.5'],['cfg_rescale','0.25']]) await page.locator('#iig_novelai_'+field).fill(value);
        await page.locator('#iig_novelai_sampler').selectOption('k_euler');
        await page.locator('#iig_novelai_negative_prompt').fill('CUSTOM_NEGATIVE | CHARACTER_NEGATIVE');
        await page.locator('#iig_model_select').selectOption('nai-diffusion-5-full-medium');
        assert.equal(await page.locator('#iig_novelai_steps').inputValue(),'14');
        assert.equal(await page.locator('#iig_novelai_steps').isDisabled(),true);
        assert.equal(await page.locator('#iig_novelai_sampler').inputValue(),'k_euler_ancestral');
        assert.equal(await page.locator('#iig_novelai_sampler').isDisabled(),true);
        assert.equal(await page.locator('#iig_novelai_cfg_rescale').isVisible(),false);
        assert.equal(await page.locator('#iig_novelai_negative_prompt').isVisible(),false);
        await page.locator('#iig_novelai_cfg_scale').fill('6');
        native = await direct();
        assert.equal(native.body.model,'nai-diffusion-5-full-medium');
        const p = native.body.parameters;
        assert.deepEqual([p.steps,p.sampler,p.scale,p.ucPreset],[14,'k_euler_ancestral',6,0]);
        assert.ok(!('cfg_rescale' in p) && !('noise_schedule' in p) && !('skip_cfg_above_sigma' in p));
        assert.ok(p.negative_prompt.startsWith('lowres, artistic error') && !p.negative_prompt.includes('CUSTOM_NEGATIVE'));
        assert.equal(p.v4_negative_prompt.caption.base_caption,p.negative_prompt);
        assert.deepEqual(p.v4_negative_prompt.caption.char_captions.map(c=>c.char_caption),['']);
        assert.equal(p.v4_prompt.caption.char_captions[0].char_caption,'a person');
        assert.equal(native.snapshot.negativePrompt,p.negative_prompt);
        assert.deepEqual([native.snapshot.metadata.steps,native.snapshot.metadata.sampler,native.snapshot.metadata.cfgScale], [14,'k_euler_ancestral',6]);
        assert.ok(!native.snapshot.metadata.cfgRescale);
        checks.push('direct Medium: separate model, fixed sampling/UC, adjustable guidance, correct character captions and snapshot');
        for (const [name,width,height] of [['desktop',900,1000],['mobile',390,844]]) {
            await page.setViewportSize({width,height});
            await page.locator('#iig_novelai_options').scrollIntoViewIfNeeded();
            assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
            await page.locator('#iig_novelai_options').screenshot({path:path.join(artifacts,'direct-medium-'+name+'.png')});
        }
        await page.locator('#iig_model_select').selectOption('nai-diffusion-5-full');
        assert.equal(await page.locator('#iig_novelai_steps').inputValue(),'28');
        assert.equal(await page.locator('#iig_novelai_sampler').inputValue(),'k_euler');
        assert.equal(await page.locator('#iig_novelai_cfg_rescale').inputValue(),'0.25');
        assert.equal(await page.locator('#iig_novelai_negative_prompt').inputValue(),'CUSTOM_NEGATIVE | CHARACTER_NEGATIVE');
        native = await direct({model:'nai-diffusion-5-full-medium'});
        assert.equal(native.body.parameters.steps,14);
        assert.equal(native.snapshot.metadata.model,'nai-diffusion-5-full-medium');
        assert.equal(await page.evaluate(()=>app.settings.model),'nai-diffusion-5-full');
        native = await direct();
        assert.deepEqual([native.body.parameters.steps,native.body.parameters.cfg_rescale,native.body.parameters.sampler], [28,0.25,'k_euler']);
        assert.equal(native.body.parameters.negative_prompt,'CUSTOM_NEGATIVE');
        checks.push('High settings restored; request-only Medium override leaves defaults unchanged');
        assert.deepEqual(errors, []);
        writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:true,checks,errors},null,2));
        console.log(JSON.stringify({passed:true,checks,artifacts},null,2));
    } catch(error) {
        await page.screenshot({path:path.join(artifacts,'failure.png')});
        writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:false,checks,errors,error:String(error)},null,2));
        throw error;
    } finally {await browser.close(); await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
