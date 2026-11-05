const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

// Guard stable picker rows, synchronized selection, repeated clicks, escaped names,
// catalog reorder, concurrent refreshes, header/body stalls, retained cache and retry.
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/sillyimages/';
const host = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${prefix}style.css"><div id="extensions_settings"></div><script type="module">
window.context={extensionSettings:{},characters:[],characterId:-1,chat:[],powerUserSettings:{personas:{}},saveSettingsDebounced(){window.saves++;},getRequestHeaders:()=>({'Content-Type':'application/json'})};window.SillyTavern={getContext:()=>context};window.saves=0;window.toastr={success(){},error(){},warning(){},info(){}};
window.files=Array.from({length:1000},(_,i)=>'avatar_'+i+'.png');files.push('<b>& café #%.png');window.format='array';window.fail=false;window.delay=0;window.avatarRequests=0;
const realFetch=fetch.bind(window);window.fetch=async(url,init={})=>{
 const u=String(url);if(u==='/api/avatars/get'){
  avatarRequests++;if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
  if(fail)return new Response('fixture unavailable',{status:503});
  return Response.json(format==='array'?files:format==='invalid'?{}:{[format]:files});
 }
 if(u.startsWith('/api/'))return Response.json([]);return realFetch(url,init);
};
const settingsModule=await import('${prefix}src/settings.js'),references=await import('${prefix}src/references.js'),ui=await import('${prefix}src/ui.js');
const settings=settingsModule.getSettings();Object.assign(settings,{apiType:'gemini',sendUserAvatar:true,useActiveUserPersonaAvatar:false});ui.createSettingsUI();await references.refreshUserAvatarSelects();
window.app={settings,references};window.ready=true;
</script>`;
const server=createServer((req,res)=>{
    let body,type='application/javascript';
    if(req.url==='/'){body=host;type='text/html';}
    else if(req.url.startsWith('/User%20Avatars/')||req.url.startsWith('/User Avatars/')){body='<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#687"/></svg>';type='image/svg+xml';}
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
    const artifacts=path.join(__dirname,'artifacts','avatar-picker-'+engine);mkdirSync(artifacts,{recursive:true});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.IIG_BROWSER_CHANNEL?{channel:process.env.IIG_BROWSER_CHANNEL}:{})});
    const checks=[],errors=[],benchmarks=[];let page;
    try{
        for(const[mode,width]of[['desktop',1000],['mobile',390]]){
            page=await browser.newPage({viewport:{width,height:900}});page.on('pageerror',error=>errors.push(error.message));
            await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.ready);
            const selection=await page.evaluate(async()=>{
                const lists=app.references.getUserAvatarDropdownConfigs().map(config=>document.getElementById(config.listId));
                const first=lists.map(list=>list.firstElementChild);let childMutations=0;
                const observer=new MutationObserver(records=>childMutations+=records.length);lists.forEach(list=>observer.observe(list,{childList:true}));
                app.references.syncUserAvatarSelection('avatar_5.png');await new Promise(resolve=>setTimeout(resolve,0));observer.disconnect();
                return{childMutations,sameRows:lists.every((list,i)=>list.firstElementChild===first[i]),selected:lists.map(list=>list.querySelector('.selected')?.dataset.value)};
            });
            benchmarks.push({mode,avatars:1001,...selection});
            assert.equal(selection.childMutations,0,'selection must not rebuild avatar lists');assert.equal(selection.sameRows,true);
            assert.deepEqual(selection.selected,['avatar_5.png','avatar_5.png']);
            checks.push(mode+': selecting an avatar preserves both 1001-row lists');
            const clicked=await page.evaluate(()=>{
                const list=document.getElementById('iig_user_avatar_dropdown_list');const target=list.children[6];const before=saves;
                target.querySelector('span').click();target.querySelector('span').click();
                return{saves:saves-before,value:app.settings.userAvatarFile,selects:app.references.getUserAvatarDropdownConfigs().map(config=>document.getElementById(config.listId).querySelector('.selected')?.dataset.value)};
            });
            assert.deepEqual(clicked,{saves:2,value:'avatar_6.png',selects:['avatar_6.png','avatar_6.png']});
            checks.push(mode+': nested clicks save once and synchronize both provider selectors');
            const special=await page.evaluate(()=>{
                const row=document.getElementById('iig_user_avatar_dropdown_list').lastElementChild;row.click();
                return{name:row.querySelector('span').textContent,src:row.querySelector('img').getAttribute('src'),html:row.querySelectorAll('b').length,value:app.settings.userAvatarFile};
            });
            assert.equal(special.name,'<b>& café #%.png');assert.equal(special.value,special.name);assert.equal(special.html,0);
            assert.equal(special.src,'/User Avatars/'+encodeURIComponent(special.name));checks.push(mode+': special filenames remain escaped and selectable');
            const concurrency=await page.evaluate(async()=>{
                delay=30;const before=avatarRequests;const results=await Promise.all(Array.from({length:5},()=>app.references.fetchUserAvatars()));delay=0;
                return{requests:avatarRequests-before,lengths:results.map(result=>result.length)};
            });
            assert.equal(concurrency.requests,1);assert.deepEqual(concurrency.lengths,[1001,1001,1001,1001,1001]);
            checks.push(mode+': concurrent catalog consumers share one HTTP request');
            for(const format of ['avatars','files','array']){
                const result=await page.evaluate(async format=>{
                    window.format=format;const list=document.getElementById('iig_user_avatar_dropdown_list'),first=list.firstElementChild;const before=avatarRequests;
                    await app.references.refreshUserAvatarSelects();return{requests:avatarRequests-before,same:first===list.firstElementChild,length:list.children.length};
                },format);
                assert.deepEqual(result,{requests:1,same:true,length:1001});
            }
            checks.push(mode+': supported catalog payloads refresh without rebuilding unchanged rows');
            const recovery=await page.evaluate(async()=>{
                fail=true;const failed=await app.references.fetchUserAvatars();const cached=app.references.getCachedUserAvatars();cached.length=0;
                const retained=app.references.getCachedUserAvatars().length;fail=false;files=files.slice().reverse();await app.references.refreshUserAvatarSelects();
                return{failed,retained,first:document.getElementById('iig_user_avatar_dropdown_list').firstElementChild.dataset.value};
            });
            assert.deepEqual(recovery,{failed:[],retained:1001,first:'<b>& café #%.png'});
            checks.push(mode+': failed refresh retains cache; retry fetches fresh catalog order');
            for(const phase of ['headers','body']){
                const stalled=await page.evaluate(async phase=>{
                    const originalFetch=fetch,timeout=setTimeout;
                    const list=document.getElementById('iig_user_avatar_dropdown_list'),first=list.firstElementChild;
                    let signal,release,calls=0;
                    window.setTimeout=(fn,ms,...args)=>timeout(fn,ms===15000?25:ms,...args);
                    window.fetch=(url,init)=>{
                        if(String(url)!=='/api/avatars/get')return originalFetch(url,init);
                        calls++;signal=init?.signal;
                        if(phase==='headers')return new Promise(resolve=>{release=()=>resolve(Response.json(files));});
                        return Promise.resolve(new Response(new ReadableStream({start(controller){release=()=>{
                            controller.enqueue(new TextEncoder().encode(JSON.stringify(files)));controller.close();
                        };}})));
                    };
                    const pending=Promise.all([app.references.fetchUserAvatars(),app.references.refreshUserAvatarSelects()]);
                    const outcome=await Promise.race([pending.then(()=> 'settled'),new Promise(resolve=>timeout(()=>resolve('pending'),200))]);
                    const state={outcome,calls,aborted:Boolean(signal?.aborted),retained:app.references.getCachedUserAvatars().length,sameRows:first===list.firstElementChild};
                    window.fetch=originalFetch;window.setTimeout=timeout;release();await pending;
                    const before=avatarRequests;await app.references.refreshUserAvatarSelects();
                    return {...state,retryRequests:avatarRequests-before};
                },phase);
                assert.deepEqual(stalled,{outcome:'settled',calls:1,aborted:true,retained:1001,sameRows:true,retryRequests:1});
                checks.push(mode+': '+phase+' timeout releases shared catalog request, retains rows and allows retry');
            }
            const empty=await page.evaluate(async()=>{format='invalid';await app.references.refreshUserAvatarSelects();return document.getElementById('iig_user_avatar_dropdown_list').children.length;});
            assert.equal(empty,0);checks.push(mode+': invalid catalog renders an empty list');
            const personaMode=await page.evaluate(()=>{
                const editor=document.getElementById('iig_library_editor_host');const before=editor.innerHTML;
                const checkbox=document.getElementById('iig_use_active_persona_avatar');checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));
                return{enabled:app.settings.useActiveUserPersonaAvatar,synced:document.getElementById('iig_naistera_use_active_persona_avatar').checked,editorUnchanged:before===editor.innerHTML};
            });
            await page.waitForTimeout(30);assert.deepEqual(errors,[]);
            assert.deepEqual(personaMode,{enabled:true,synced:true,editorUnchanged:true});
            checks.push(mode+': active persona mode synchronizes without rendering a collapsed library');
            await page.screenshot({path:path.join(artifacts,mode+'.png')});await page.close();
        }
        assert.deepEqual(errors,[]);writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:true,engine,checks,errors,benchmarks},null,2));console.log(JSON.stringify({passed:true,checks,artifacts},null,2));
    }catch(error){writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:false,checks,errors,benchmarks,error:String(error)},null,2));throw error;}
    finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
