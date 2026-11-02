const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

// Guard catalogs, empty/malformed responses, HTTP/network failures, Basic auth,
// optional credentials, default/raw endpoints, payloads, no-image results and Stop.
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/sillyimages/';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JQAAAABJRU5ErkJggg==';
const host = `<!doctype html><link rel="stylesheet" href="${prefix}style.css"><div id="extensions_settings"></div><script type="module">
window.notes=[];window.toastr=Object.fromEntries(['info','error','warning','success'].map(kind=>[kind,message=>notes.push({kind,message})]));
window.context={extensionSettings:{},characters:[],characterId:-1,chat:[],powerUserSettings:{personas:{}},saveSettingsDebounced(){},getRequestHeaders:()=>({'Content-Type':'application/json'})};window.SillyTavern={getContext:()=>context};
window.mode='normal';window.requests=[];const realFetch=fetch.bind(window);
window.fetch=async(url,init={})=>{
 const u=String(url);if(!u.startsWith('https://fixture.invalid')&&!u.startsWith('http://127.0.0.1:7860')){
  if(u.startsWith('/api/'))return Response.json([]);return realFetch(url,init);
 }
 requests.push({url:u,method:init.method||'GET',headers:Object.fromEntries(new Headers(init.headers)),body:init.body?JSON.parse(init.body):null});
 if(mode==='network')throw new TypeError('fixture offline');
 if(mode==='abort')throw new DOMException('fixture aborted','AbortError');
 if(mode==='timeout')throw new DOMException('fixture timeout','AbortError');
 if(mode==='unknown')throw new Error('fixture unexpected');
 if(mode==='existing-error')throw window.fixtureError;
 if(mode==='http')return new Response('fixture unavailable',{status:503});
 if(mode==='malformed')return new Response('{');
 if(mode==='nonarray')return Response.json({unexpected:true});
 if(mode==='empty')return Response.json([]);
 if(init.method==='POST')return Response.json(mode==='no-image'?{images:[]}:{images:['${png}']});
 if(u.endsWith('/sd-models'))return Response.json([{title:'Fixture checkpoint'},{model_name:'Fallback checkpoint'},null,{}]);
 if(u.endsWith('/schedulers'))return Response.json([{label:'Fixture scheduler'},{name:'Fallback scheduler'},null,{}]);
 if(u.endsWith('/sd-vae'))return Response.json([{model_name:'Fixture VAE'},null,{}]);
 return Response.json([{name:'Fixture option'},null,{}]);
};
const settingsModule=await import('${prefix}src/settings.js');const settings=settingsModule.getSettings();Object.assign(settings,{apiType:'a1111',endpoint:'https://fixture.invalid',apiKey:'fixture:password',model:'Fixture checkpoint'});
const providers=await import('${prefix}src/providers.js');const ui=await import('${prefix}src/ui.js');ui.createSettingsUI();
const {ProviderError}=await import('${prefix}src/utils.js');window.fixtureError=new ProviderError({message:'fixture provider failure',code:'fixture_code',retryable:true,providerId:'fixture'});
window.app={settings,providers,ui};window.ready=true;
</script>`;
const server = createServer((req,res)=>{
    let body,type='application/javascript';
    if(req.url==='/'){body=host;type='text/html';}
    else if(req.url==='/scripts/i18n.js')body='export const t=(s,...v)=>String.raw({raw:s},...v);export const translate=s=>s;';
    else if(req.url==='/scripts/popup.js')body='export class Popup{static show={confirm:async()=>false,input:async()=>null};}';
    else if(req.url.startsWith(prefix)){
        const file=path.resolve(root,req.url.slice(prefix.length));
        if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
        try{body=readFileSync(file);}catch{return res.writeHead(404).end();}
        if(file.endsWith('.css'))type='text/css';
    }else return res.writeHead(404).end();
    res.writeHead(200,{'Content-Type':type});res.end(body);
});
(async()=>{
    const engine=process.env.IIG_BROWSER_ENGINE||'chromium';
    const artifacts=path.join(__dirname,'artifacts','a1111-'+engine);mkdirSync(artifacts,{recursive:true});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.IIG_BROWSER_CHANNEL?{channel:process.env.IIG_BROWSER_CHANNEL}:{})});
    const page=await browser.newPage();const checks=[],errors=[],contracts=[];
    page.on('pageerror',e=>errors.push(e.message));
    try{
        await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.ready);
        const invoke=(method,value='normal')=>page.evaluate(async({method,value})=>{
            mode=value;try{return{value:await app.providers.getProviderById('a1111')[method]()};}catch(error){return{error:error.message};}
        },{method,value});
        const expected={fetchModels:['Fixture checkpoint','Fallback checkpoint'],fetchSamplers:['Fixture option'],fetchSchedulers:['Fixture scheduler','Fallback scheduler'],fetchVaes:['Fixture VAE'],fetchUpscalers:['Fixture option']};
        const defaults={fetchSamplers:await invoke('fetchSamplers','http'),fetchSchedulers:await invoke('fetchSchedulers','http')};
        assert.ok(defaults.fetchSamplers.value.includes('Euler a'));assert.ok(defaults.fetchSchedulers.value.includes('Automatic'));
        for(const[method,list]of Object.entries(expected)){
            assert.deepEqual(await invoke(method),{value:list});
            for(const failure of ['http','network','malformed','nonarray','empty']){
                const result=await invoke(method,failure);
                if(method==='fetchModels'&&['http','network','malformed'].includes(failure))assert.ok(result.error,method+'/'+failure);
                else assert.deepEqual(result,defaults[method]||{value:[]},method+'/'+failure);
            }
            checks.push(method+': valid catalogs and five failure/empty conditions');
        }
        assert.deepEqual(await invoke('ping'),{value:true});
        assert.deepEqual(await invoke('ping','malformed'),{value:true});
        for(const failure of ['http','network'])assert.ok((await invoke('ping',failure)).error);
        checks.push('connection check validates HTTP status independently of catalog JSON');
        await page.evaluate(()=>{mode='normal';app.settings.endpoint='';app.settings.apiKey='';});
        await invoke('fetchModels');
        const fallback=await page.evaluate(()=>requests.at(-1));
        assert.equal(fallback.url,'http://127.0.0.1:7860/sdapi/v1/sd-models');assert.deepEqual(fallback.headers,{});
        await page.evaluate(()=>{app.settings.endpoint='https://fixture.invalid/';app.settings.apiKey='fixture:password';});
        await invoke('fetchModels');
        assert.equal(await page.evaluate(()=>requests.at(-1).headers.authorization),'Basic '+Buffer.from('fixture:password').toString('base64'));
        checks.push('catalog requests preserve default endpoint, trailing slash handling and optional Basic auth');
        for(const id of ['iig_a1111_refresh_samplers','iig_a1111_refresh_vae_upscalers','iig_a1111_validate']){
            await page.locator('#'+id).evaluate(element=>element.click());
            await page.waitForFunction(id=>!document.getElementById(id).classList.contains('loading'),id);
        }
        assert.ok((await page.locator('#iig_a1111_vae').textContent()).includes('Fixture VAE'));
        assert.ok((await page.locator('#iig_a1111_sampler').textContent()).includes('Fixture option'));
        checks.push('settings refresh and validate controls use provider catalogs');
        for(const raw of [false,true]){
            const result=await page.evaluate(async raw=>{
                Object.assign(app.settings,{rawEndpoint:raw,endpoint:raw?'https://fixture.invalid/raw':'https://fixture.invalid',a1111PromptPrefix:'fixture prefix',a1111NegativePrompt:'fixture negative',a1111AdetailerFace:true});
                const image=await app.providers.getProviderById('a1111').generate({prompt:'fixture scene',style:'ignored style'});
                return{image,request:requests.at(-1)};
            },raw);
            assert.equal(result.image,'data:image/png;base64,'+png);assert.equal(result.request.body.prompt,'fixture prefix, fixture scene');
            assert.equal(result.request.url,raw?'https://fixture.invalid/raw':'https://fixture.invalid/sdapi/v1/txt2img');
            assert.equal(result.request.body.negative_prompt,'fixture negative');assert.ok(result.request.body.alwayson_scripts.ADetailer);
            contracts.push(result.request);checks.push((raw?'raw':'normal')+' generation request and decoded image');
        }
        for(const[scenario,code,retryable]of [['http','503',true],['network','network',true],['no-image','no_image',false],['abort','aborted',false],['timeout','timeout',true],['unknown','unknown',false],['existing-error','fixture_code',true]]){
            const result=await page.evaluate(async scenario=>{
                mode=scenario;const controller=new AbortController();if(scenario==='abort')controller.abort('user-cancel');
                try{await app.providers.getProviderById('a1111').generate({prompt:'fixture',options:{signal:controller.signal}});return null;}
                catch(error){if(scenario==='existing-error'&&error!==fixtureError)throw new Error('Provider error identity changed');return{code:error.code,retryable:error.retryable};}
            },scenario);
            assert.deepEqual(result,{code,retryable});checks.push(scenario+': structured generation error');
        }
        assert.deepEqual(errors,[]);writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:true,engine,checks,errors,contracts},null,2));
        console.log(JSON.stringify({passed:true,engine,checks,artifacts},null,2));
    }catch(error){writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:false,engine,checks,errors,error:String(error)},null,2));throw error;}
    finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
