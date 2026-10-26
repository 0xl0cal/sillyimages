const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

// Real entry point, chat buttons, renderer, pipeline and viewer. Cover stripped
// metadata, persisted error/stop assets, hidden controls, failed batches, missing
// media, unrelated images, repeated initialization and keyboard/touch retries.
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/sillyimages/';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JQAAAABJRU5ErkJggg==';
const tag = (src, prompt = 'fixture scene') => `<img data-iig-instruction='${JSON.stringify({ prompt })}' src="${src}">`;
const host = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${prefix}style.css"><style>
*{box-sizing:border-box}body{margin:12px;background:#302c35;color:#eee;font:16px sans-serif}#extensions_settings{display:none}.mes_text img{width:300px;max-width:100%}.mes{padding:8px;border:1px solid #666}.extraMesButtons{display:flex;height:32px;gap:8px}.mes_button{width:30px;height:30px;background:#777;cursor:pointer}.mes_text{min-height:260px}.mes_text p{margin:0}.iig-img-host{vertical-align:top}button{font:inherit}#notes{white-space:pre-wrap}
</style></head><body><div id="extensions_settings"></div><div id="chat"></div><pre id="notes"></pre><script type="module">
window.notes=[];window.toastr=Object.fromEntries(['success','error','warning','info'].map(kind=>[kind,(message,title)=>{notes.push({kind,message,title});document.querySelector('#notes').textContent=notes.map(n=>n.kind+': '+n.message).join('\\n');}]));
const handlers=new Map();window.bus={on(name,fn){const list=handlers.get(name)||[];list.push(fn);handlers.set(name,list);},makeLast(name,fn){this.on(name,fn);},async emit(name,...args){for(const fn of handlers.get(name)||[])await fn(...args);}};
window.stripAttributes=true;window.failNext=false;window.delay=0;window.requests=[];window.uploads=0;window.saves=0;
window.context={extensionSettings:{},characters:[],characterId:-1,chat:[],powerUserSettings:{personas:{}},eventSource:bus,event_types:{APP_READY:'ready',CHAT_CHANGED:'chat',CHARACTER_MESSAGE_RENDERED:'rendered',USER_MESSAGE_RENDERED:'user'},getRequestHeaders:()=>({'Content-Type':'application/json'}),saveSettingsDebounced(){},async saveChat(){saves++;},messageFormatting(text){const template=document.createElement('template');template.innerHTML=text;if(stripAttributes)template.content.querySelectorAll('[data-iig-instruction]').forEach(e=>e.removeAttribute('data-iig-instruction'));return template.innerHTML;}};window.SillyTavern={getContext:()=>context};
window.setSource=text=>{context.chat=[{mes:text,is_user:false,name:'Fixture'}];document.querySelector('#chat').innerHTML='<div class="mes" mesid="0"><div class="extraMesButtons"></div><div class="mes_text">'+context.messageFormatting(text)+'</div></div>';};
setSource(${JSON.stringify(tag(prefix + 'error.svg'))});
const realFetch=fetch.bind(window);window.fetch=async(url,init={})=>{
 const u=String(url);if(u==='https://fixture.invalid/api/models')return Response.json({models:[{id:'nano-banana-2-lite',name:'Fixture',references:false}]});
 if(u==='https://fixture.invalid/api/generate'){
  requests.push(JSON.parse(init.body));if(delay)await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,delay);init.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});});
  if(failNext){failNext=false;return Response.json({error:'fixture provider unavailable'},{status:503});}
  return Response.json({data_url:'data:image/png;base64,${png}'});
 }
 if(u==='/api/images/upload')return Response.json({path:'user/images/Fixture/iig_'+(++uploads)+'.png'});
 if(u.startsWith('/api/'))return Response.json([]);return realFetch(url,init);
};
const settingsModule=await import('${prefix}src/settings.js');const settings=settingsModule.getSettings();Object.assign(settings,{apiType:'naistera',endpoint:'https://fixture.invalid',apiKey:'fixture-key',naisteraModel:'nano-banana-2-lite',naisteraPolling:false,naisteraSendCharAvatar:false,naisteraSendUserAvatar:false,useActiveUserPersonaAvatar:false,imageContextEnabled:false,maxRetries:0});
await import('${prefix}index.js');await bus.emit('ready');
const actions=await import('${prefix}src/imageActions.js'),events=await import('${prefix}src/events.js'),pipeline=await import('${prefix}src/pipeline.js');
window.app={settings,actions,events,pipeline};window.genericImageClicks=0;document.querySelector('#chat').addEventListener('click',e=>{if(e.target.matches('img'))genericImageClicks++;});window.ready=true;
</script></body></html>`;
const server = createServer((req,res)=>{
    let body,type='application/javascript';
    if(req.url==='/'){body=host;type='text/html';}
    else if(req.url.startsWith('/user/images/')||req.url==='/decoration.png'){body=Buffer.from(png,'base64');type='image/png';}
    else if(req.url==='/scripts/i18n.js')body='export const t=(s,...v)=>String.raw({raw:s},...v);export const translate=s=>s;';
    else if(req.url==='/scripts/popup.js')body='export class Popup {static show={confirm:async()=>true,input:async()=>null};}';
    else if(req.url.startsWith(prefix)){
        const file=path.resolve(root,decodeURIComponent(req.url.split('?')[0].slice(prefix.length)));
        if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
        try{body=readFileSync(file);}catch{res.writeHead(404).end();return;}
        if(file.endsWith('.css'))type='text/css';if(file.endsWith('.svg'))type='image/svg+xml';
    }else{res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':type});res.end(body);
});
(async()=>{
    const engine=process.env.IIG_BROWSER_ENGINE||'chromium';
    const artifacts=path.join(__dirname,'artifacts','chat-image-actions-'+engine);mkdirSync(artifacts,{recursive:true});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.IIG_BROWSER_CHANNEL?{channel:process.env.IIG_BROWSER_CHANNEL}:{})});
    const checks=[],errors=[];let page;
    try{
        for(const[mode,width]of[['desktop',900],['mobile',390]]){
            const context=await browser.newContext({viewport:{width,height:950},isMobile:mode==='mobile',hasTouch:true});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
            const reset=async()=>{await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.ready);};
            const click=async selector=>{if(mode==='mobile')await page.locator(selector).tap();else await page.locator(selector).click();};
            const source=async html=>page.evaluate(async html=>{setSource(html);app.events.addButtonsToExistingMessages();},html);
            const settled=async()=>{
                await page.waitForFunction(()=>requests.length>0&&!app.pipeline.processingMessages.size&&!document.querySelector('.iig-loading-placeholder'));
                await page.waitForFunction(()=>{const images=[...document.querySelectorAll('.mes_text img[data-iig-instruction]')];return images.length>0&&images.every(img=>img.closest('.iig-img-host'));});
            };
            await reset();await page.locator('.iig-img-retry').waitFor();
            assert.equal(await page.locator('.iig-img-download').count(),0);
            assert.equal(await page.locator('.iig-error-image').count(),1);
            await page.screenshot({path:path.join(artifacts,mode+'-error-controls.png')});
            await click('.mes_text img');await settled();
            assert.equal(await page.evaluate(()=>requests.length),1);assert.equal(await page.evaluate(()=>genericImageClicks),0);
            assert.equal(await page.locator('#iig_lightbox').evaluate(e=>e.open),false);
            await page.locator('.iig-img-download').waitFor();assert.equal(await page.locator('.iig-img-host').count(),1);
            checks.push(mode+': persisted error restores metadata and retry controls; image click sends one request instead of opening a viewer');

            await reset();await page.evaluate(()=>{app.settings.imageActionsEnabled=false;app.actions.applyImageActionsStyle();});
            await click('.mes_text img');await settled();assert.equal(await page.evaluate(()=>requests.length),1);
            assert.equal(await page.locator('.iig-img-actions').isVisible(),false);
            checks.push(mode+': image retry remains available when floating controls are disabled');

            await reset();await page.evaluate(()=>stripAttributes=false);await source(tag(prefix+'error.svg'));
            await page.locator('.iig-img-retry').waitFor();await click('.iig-img-retry');await settled();
            assert.equal(await page.evaluate(()=>requests.length),1);
            checks.push(mode+': rendering that preserves metadata keeps working');

            await reset();await source(tag(prefix+'stopped.svg'));
            await page.locator('.iig-img-retry').waitFor();await page.locator('.mes_text img').focus();await page.keyboard.press('Enter');await settled();
            assert.equal(await page.evaluate(()=>requests.length),1);assert.equal(await page.locator('#iig_lightbox').evaluate(e=>e.open),false);
            checks.push(mode+': stopped placeholder supports keyboard retry after sanitized rendering');

            await reset();await page.evaluate(()=>{app.actions.initImageActions();app.actions.initImageActions();});
            await source(tag(prefix+'error.svg?cache=1'));await page.locator('.iig-img-retry').waitFor();await click('.iig-img-retry');await settled();
            assert.equal(await page.evaluate(()=>requests.length),1);assert.equal(await page.locator('.iig-img-host').count(),1);
            checks.push(mode+': repeated initialization and cache-busted error assets do not duplicate handlers or requests');

            await reset();await source('<img id="decoration" src="/decoration.png">'+tag(prefix+'error.svg'));
            await click('.iig-regenerate-btn');await settled();assert.equal(await page.evaluate(()=>requests.length),1);
            assert.equal(await page.locator('#decoration').getAttribute('src'),'/decoration.png');
            await page.locator('.iig-img-download').waitFor();
            checks.push(mode+': message regeneration rebinds stripped attributes without replacing unrelated images');

            await reset();await source(tag(prefix+'error.svg','first fixture')+tag(prefix+'error.svg','second fixture')+tag(prefix+'error.svg','third fixture'));
            await page.evaluate(()=>{failNext=true;delay=180;});await click('.iig-regenerate-btn');
            await page.waitForFunction(()=>requests.length===2&&document.querySelector('.iig-loading-placeholder'));
            assert.deepEqual(await page.locator('.mes_text img').evaluateAll(images=>images.map(img=>JSON.parse(img.getAttribute('data-iig-instruction')).prompt)),['third fixture']);
            await page.waitForFunction(()=>requests.length===3&&!app.pipeline.processingMessages.size&&!document.querySelector('.iig-loading-placeholder'));
            await page.waitForFunction(()=>document.querySelectorAll('.iig-img-host').length===3);
            assert.deepEqual(await page.evaluate(()=>requests.map(r=>r.prompt)),['first fixture','second fixture','third fixture']);
            assert.equal(await page.locator('.iig-img-retry').count(),1);assert.equal(await page.locator('.iig-img-download').count(),2);
            checks.push(mode+': failed first generation does not shift the remaining batch image targets');

            await reset();await source(tag(prefix+'error.svg','first fixture')+tag(prefix+'error.svg','second fixture')+tag(prefix+'error.svg','third fixture'));
            await page.evaluate(()=>delay=250);await click('.iig-regenerate-btn');
            await page.waitForFunction(()=>requests.length===1&&document.querySelector('.iig-loading-placeholder'));
            await page.waitForTimeout(60);
            assert.deepEqual(await page.locator('.mes_text img').evaluateAll(images=>images.map(img=>JSON.parse(img.getAttribute('data-iig-instruction')).prompt)),['second fixture','third fixture']);
            await page.waitForFunction(()=>requests.length===3&&!app.pipeline.processingMessages.size);
            checks.push(mode+': pending loading slots do not reassign metadata on sibling images');

            await reset();await page.evaluate(html=>{
                setSource(html);context.chat[0].mes='fixture narrative';context.chat[0].extra={extblocks:html,display_text:html};
                app.settings.externalBlocks=true;app.events.addButtonsToExistingMessages();
            },tag(prefix+'error.svg'));
            await page.locator('.iig-img-retry').waitFor();await click('.iig-img-retry');await settled();
            assert.equal(await page.evaluate(()=>requests.length),1);
            assert.ok(await page.evaluate(()=>context.chat[0].extra.extblocks.includes('/user/images/Fixture/')));
            checks.push(mode+': external-block image retries preserve their source and rendered display');

            await reset();await source(tag('/user/images/Fixture/hidden.png','hidden fixture')+tag(prefix+'error.svg','visible fixture'));
            await page.evaluate(()=>document.querySelector('.mes_text img').remove());
            await page.waitForFunction(()=>document.querySelector('.mes_text img')?.getAttribute('data-iig-tag-index')==='1');
            await click('.iig-img-retry');await settled();
            assert.deepEqual(await page.evaluate(()=>requests.map(r=>r.prompt)),['visible fixture']);
            assert.ok(await page.evaluate(()=>context.chat[0].mes.includes('/user/images/Fixture/hidden.png')));
            checks.push(mode+': source tag indices remain correct when another image is absent from rendered content');

            await reset();await source('<img id="duplicate-decoration" src="'+prefix+'error.svg">'+tag(prefix+'error.svg'));
            await click('.iig-regenerate-btn');await page.waitForFunction(()=>!app.pipeline.processingMessages.size&&notes.some(n=>n.kind==='error'));
            assert.equal(await page.evaluate(()=>requests.length),0);
            assert.equal(await page.locator('#duplicate-decoration').getAttribute('data-iig-instruction'),null);
            checks.push(mode+': ambiguous duplicate media are not guessed or overwritten');

            await reset();await page.evaluate(()=>{document.querySelector('.mes_text').replaceChildren();});await click('.iig-regenerate-btn');
            await page.waitForFunction(()=>!app.pipeline.processingMessages.size&&notes.some(n=>n.kind==='error'));
            assert.equal(await page.evaluate(()=>requests.length),0);
            checks.push(mode+': missing rendered media produces a visible error rather than silently completing');

            await reset();await source(tag('/user/images/Fixture/saved.png'));
            await page.locator('.iig-img-download').waitFor();await click('.mes_text img');await page.waitForFunction(()=>document.querySelector('#iig_lightbox').open);
            await click('.iig-lightbox-close');await click('.iig-img-regen');await settled();
            assert.equal(await page.evaluate(()=>requests.length),1);
            await page.screenshot({path:path.join(artifacts,mode+'-success-controls.png')});
            checks.push(mode+': successful images keep viewer and per-image regeneration controls');
            await context.close();
        }
        assert.deepEqual(errors,[]);writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:true,engine,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks,artifacts},null,2));
    }catch(error){if(page&&!page.isClosed())await page.screenshot({path:path.join(artifacts,'failure.png')});writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:false,engine,checks,errors,error:String(error)},null,2));throw error;}
    finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
