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
window.notes=[];window.inputs=[];window.confirmResult=true;window.toastr=Object.fromEntries(['info','error','warning','success'].map(kind=>[kind,message=>notes.push({kind,message})]));
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
window.app={settings,providers,ui,settingsModule};window.ready=true;
</script>`;
const server = createServer((req,res)=>{
    let body,type='application/javascript';
    if(req.url==='/'){body=host;type='text/html';}
    else if(req.url==='/scripts/i18n.js')body='export const t=(s,...v)=>String.raw({raw:s},...v);export const translate=s=>s;';
    else if(req.url==='/scripts/popup.js')body='export class Popup{static show={confirm:async()=>window.confirmResult,input:async()=>window.inputs.shift()};}';
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
        const fields=[['iig_a1111_width','a1111Width',768,512],['iig_a1111_height','a1111Height',512,768],['iig_a1111_steps','a1111Steps',28,15],['iig_a1111_cfg','a1111CfgScale',6.5,4],['iig_a1111_seed','a1111Seed',123,456],['iig_a1111_prompt_prefix','a1111PromptPrefix','first prefix','second prefix'],['iig_a1111_negative','a1111NegativePrompt','first negative','second negative'],['iig_a1111_restore_faces','a1111RestoreFaces',true,false]];
        fields.push(['iig_naistera_poll_interval','naisteraPollIntervalMs',5000,1000],['iig_naistera_poll_timeout','naisteraPollTimeoutMs',90000,60000],['iig_naistera_polling','naisteraPolling',true,false],['iig_a1111_sampler','a1111Sampler','Custom sampler A','Custom sampler B']);
        const profileIds=[];
        await page.locator('#iig_profile_select').evaluate(element=>{for(let node=element.parentElement;node;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;});
        for(const index of [2,3]){
            const name=index===2?'First fixture profile':'Second fixture profile';
            await page.evaluate(({fields,index,name})=>{
                mode='normal';
                for(const[id,,a,b]of fields){const element=document.getElementById(id),value=index===2?a:b;if(element.type==='checkbox')element.checked=value;else{if(element instanceof HTMLSelectElement&&!Array.from(element.options).some(o=>o.value===String(value)))element.add(new Option(String(value),String(value)));element.value=String(value);}element.dispatchEvent(new Event(element.type==='checkbox'||element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));}
                inputs.push(name);document.getElementById('iig_profile_save_as').click();
            },{fields,index,name});
            await page.waitForFunction(name=>app.settings.connectionProfiles.some(p=>p.name===name),name);
            profileIds.push(await page.evaluate(()=>app.settings.activeConnectionProfileId));
        }
        for(const[index,id]of profileIds.entries()){
            await page.locator('#iig_profile_select').selectOption(id);
            const values=await page.evaluate(fields=>fields.map(([id,key])=>{const element=document.getElementById(id);return{key,stored:app.settings[key],shown:element.type==='checkbox'?element.checked:element.value,pair:document.getElementById(id+'_value')?.value};}),fields);
            for(const[fieldIndex,value]of values.entries()){
                const expected=fields[fieldIndex][index+2];assert.equal(value.stored,expected,value.key+': stored');assert.equal(value.shown,typeof expected==='boolean'?expected:String(expected),value.key+': shown');
                if(value.pair!==undefined)assert.equal(value.pair,String(expected),value.key+': numeric pair');
            }
        }
        checks.push('profile switches restore A1111 values, both range controls, text and checkboxes');
        const widths=await page.evaluate(()=>{
            const range=document.getElementById('iig_a1111_width'),number=document.getElementById('iig_a1111_width_value');
            number.value='896';number.dispatchEvent(new Event('input',{bubbles:true}));const fromNumber={stored:app.settings.a1111Width,range:range.value};
            range.value='1024';range.dispatchEvent(new Event('input',{bubbles:true}));return{fromNumber,fromRange:{stored:app.settings.a1111Width,number:number.value}};
        });assert.deepEqual(widths,{fromNumber:{stored:896,range:'896'},fromRange:{stored:1024,number:'1024'}});
        await page.locator('#iig_a1111_resolution').selectOption('768x512');
        await page.locator('#iig_a1111_swap').evaluate(element=>element.click());
        assert.deepEqual(await page.evaluate(()=>['iig_a1111_width','iig_a1111_width_value','iig_a1111_height','iig_a1111_height_value'].map(id=>document.getElementById(id).value)),['512','512','768','768']);
        checks.push('range/number edits, resolution presets and swapping share consistent dimensions');
        await page.locator('#iig_a1111_prompt_prefix').evaluate(element=>{element.value='updated fixture';element.dispatchEvent(new Event('input',{bubbles:true}));});
        await page.locator('#iig_profile_save').evaluate(element=>element.click());
        const savedProfile=await page.evaluate(()=>app.settingsModule.getActiveConnectionProfile(app.settings));
        assert.equal(savedProfile.a1111PromptPrefix,'updated fixture');
        const profileKeys=await page.evaluate(()=>['id','name',...app.settingsModule.CONNECTION_FIELDS].sort());
        assert.deepEqual(Object.keys(savedProfile).sort(),profileKeys);
        checks.push('save updates the active profile using the existing connection-field schema');
        await page.evaluate(()=>{inputs.push('Renamed fixture');document.getElementById('iig_profile_rename').click();});
        await page.waitForFunction(()=>app.settings.connectionProfiles.some(profile=>profile.name==='Renamed fixture'));
        await page.evaluate(()=>{confirmResult=false;document.getElementById('iig_profile_remove').click();});
        assert.equal(await page.evaluate(()=>app.settings.connectionProfiles.some(profile=>profile.name==='Renamed fixture')),true);
        await page.evaluate(()=>{confirmResult=true;document.getElementById('iig_profile_remove').click();});
        await page.waitForFunction(()=>!app.settings.connectionProfiles.some(profile=>profile.name==='Renamed fixture'));
        await page.locator('#iig_profile_remove').evaluate(element=>element.click());
        await page.waitForFunction(()=>notes.some(note=>note.kind==='warning'&&note.message.includes('Cannot delete the last profile')));
        assert.equal(await page.evaluate(()=>app.settings.connectionProfiles.length),1);
        checks.push('profile rename and confirmed/canceled removal retain the active connection');
        assert.deepEqual(errors,[]);writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:true,engine,checks,errors,contracts},null,2));
        console.log(JSON.stringify({passed:true,engine,checks,artifacts},null,2));
    }catch(error){writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:false,engine,checks,errors,error:String(error)},null,2));throw error;}
    finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
