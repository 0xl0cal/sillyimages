const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

// Real reference libraries and provider requests. Guard attachment order, clipping,
// image formats, disabled descriptions, context priority and text-only models.
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/sillyimages/';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JQAAAABJRU5ErkJggg==';
const host = `<!doctype html><script type="module">
window.toastr={error(){},warning(){},info(){},success(){}};
window.context={extensionSettings:{},saveSettingsDebounced(){},characters:[{name:'Fixture',avatar:'char.png'}],characterId:0,chat:[{mes:${JSON.stringify('<img data-iig-instruction=\'{}\' src="/context.png">')}}],getRequestHeaders:()=>({'Content-Type':'application/json'})};
window.SillyTavern={getContext:()=>context};
const realFetch=fetch.bind(window);window.requests=[];
window.fetch=async(url,init={})=>{
 const u=String(url);
 if(u.startsWith('https://provider.invalid')){
  let body=init.body;
  if(body instanceof FormData)body=await Promise.all([...body.entries()].map(async([key,value])=>[key,value instanceof Blob?{type:value.type,bytes:[...new Uint8Array(await value.arrayBuffer())]}:value]));
  else if(typeof body==='string')body=JSON.parse(body);
  requests.push({url:u,body});
  if(u.endsWith('/api/models'))return Response.json({models:[{id:'banana',references:true},{id:'novelai-v5',references:false,negative_prompt:true}]});
  return Response.json({data:[{b64_json:'${png}'}],data_url:'data:image/png;base64,${png}',candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'${png}'}}]}}],choices:[{message:{images:[{image_url:{url:'data:image/png;base64,${png}'}}]}}]});
 }
 if(u.endsWith('.png')||u.startsWith('/characters/')||u.startsWith('/User Avatars/')||u.startsWith('/thumbnail'))return new Response(Uint8Array.from(atob('${png}'),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/png'}});
 return realFetch(url,init);
};
const settingsModule=await import('${prefix}src/settings.js'),references=await import('${prefix}src/references.js'),providers=await import('${prefix}src/providers.js');
const settings=settingsModule.getSettings();Object.assign(settings,{endpoint:'https://provider.invalid',apiKey:'fixture',userAvatarFile:'user.png',useActiveUserPersonaAvatar:false,sendCharAvatar:true,sendUserAvatar:true,naisteraSendCharAvatar:true,naisteraSendUserAvatar:true,imageContextEnabled:true,imageContextCount:1,naisteraPolling:false,naisteraCharacterDescriptionsMode:'as-is'});
for(const kind of ['char','user']){
 const key=kind==='char'?references.getCurrentCharacterReferenceKey():await references.getCurrentUserReferenceKey(settings);
 const entry=references.getCharacterLibraryEntry(kind,key,settings);
 entry.primary={enabled:true,imagePath:'/'+kind+'.png',description:kind+' primary'};
 entry.appearanceItems=[{id:kind+'-extra',type:'image',enabled:true,imagePath:'/'+kind+'-extra.png',description:kind+' extra'}];
}
window.app={settings,providers,references,settingsModule};window.ready=true;
</script>`;
const server = createServer((req, res) => {
    let body, type = 'application/javascript';
    if (req.url === '/') { body = host; type = 'text/html'; }
    else if (req.url === '/scripts/i18n.js') body = 'export const t=(s,...v)=>String.raw({raw:s},...v);export const translate=s=>s;';
    else if (req.url.startsWith(prefix)) {
        const file = path.resolve(root, req.url.slice(prefix.length));
        if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
        try { body = readFileSync(file); } catch { return res.writeHead(404).end(); }
    } else return res.writeHead(404).end();
    res.writeHead(200, {'Content-Type': type}); res.end(body);
});

(async () => {
    const engine = process.env.IIG_BROWSER_ENGINE || 'chromium';
    const artifacts = path.join(__dirname, 'artifacts', 'provider-references-' + engine);
    mkdirSync(artifacts, {recursive: true});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await (engine === 'webkit' ? webkit : chromium).launch({headless: true, ...(engine === 'chromium' && process.env.IIG_BROWSER_CHANNEL ? {channel: process.env.IIG_BROWSER_CHANNEL} : {})});
    const page = await browser.newPage();
    const checks = [], errors = [], contracts = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        for (const [id, model, limit, order] of [
            ['openai', 'gpt-image-1', 5, ['char','user']],
            ['electronhub', 'flux-1-kontext-pro', 1, ['char','user']],
            ['xai', 'grok-imagine-image-2.0', 3, ['char','user']],
            ['gemini', 'gemini-3-pro-image-preview', 11, ['user','char']],
            ['openrouter', 'google/gemini-3-pro-image-preview', 11, ['user','char']],
            ['naistera', 'banana', Infinity, ['user','char']],
        ]) {
            const result = await page.evaluate(async ({id,model}) => {
                const {settings,providers,references} = app;
                Object.assign(settings,{apiType:id,model,naisteraModel:model,sendRefDescriptions:true});
                const provider=providers.resolveActiveProvider(settings);
                const matchedAdditionalRefs=[{id:'extra',name:'Fixture',imagePath:'/additional.png',description:'additional description'}];
                const refs=await provider.collectReferences({messageId:1,matchedAdditionalRefs});
                const image=await provider.generate({prompt:'fixture scene',style:'fixture style',references:refs,options:{matchedAdditionalRefs}});
                return {refs:refs.map(ref=>({source:references.getReferenceSource(ref),description:references.getReferenceDescription(ref),dataUrl:references.getReferenceImage(ref).startsWith('data:')})),image,request:requests.at(-1)};
            }, {id,model});
            const sources = [...order,...order,'additional','context'].slice(0,limit);
            assert.deepEqual(result.refs.map(ref=>ref.source),sources,id+': attachment priority');
            assert.ok(result.refs.every(ref=>ref.dataUrl===['xai','openrouter','naistera'].includes(id)),id+': image format');
            assert.match(result.image,/^data:image\/(png|jpeg);base64,/,id+': decoded response');
            contracts.push({id,...result});
            checks.push(id+': reference priority, limit, format and generation request');
        }
        const textOnly = await page.evaluate(async()=>{
            Object.assign(app.settings,{apiType:'naistera',naisteraModel:'novelai-v5'});
            return app.providers.resolveActiveProvider().collectReferences({messageId:1,matchedAdditionalRefs:[{imagePath:'/additional.png'}]});
        });
        assert.deepEqual(textOnly,[]);checks.push('Naistera text-only models do not collect images');
        for (const mode of ['none','character-prompt','as-is']) {
            const descriptions = await page.evaluate(async mode=>{
                Object.assign(app.settings,{apiType:'naistera',naisteraModel:'banana',naisteraCharacterDescriptionsMode:mode});
                const refs=await app.providers.resolveActiveProvider().collectReferences({messageId:1});
                return refs.filter(ref=>['char','user'].includes(app.references.getReferenceSource(ref))).map(app.references.getReferenceDescription);
            },mode);
            assert.ok(descriptions.every(text=>mode==='as-is'?text.length>0:text===''));
            checks.push('Naistera '+mode+': avatar description policy');
        }
        assert.deepEqual(errors,[]);
        writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:true,engine,checks,errors,contracts},null,2));
        console.log(JSON.stringify({passed:true,engine,checks,artifacts},null,2));
    } catch(error) {
        writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:false,engine,checks,errors,error:String(error)},null,2));
        throw error;
    } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
