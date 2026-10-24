const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

// Real library, viewer and deletion service with an in-memory image API.
// Failure cases: accidental viewer opening during selection, canceled deletion,
// wrong character scope, truncated history, duplicate paths, lost failures,
// reference deletion, unsafe URLs, repeated submits and folder discovery failure.
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/sillyimages/';
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="#557383"/><circle cx="90" cy="70" r="40" fill="#dcc299"/></svg>';
const host = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${prefix}style.css"><style>
:root{--SmartThemeQuoteColor:#c7b89f;--SmartThemeBodyColor:#eee;--SmartThemeBorderColor:#666;--SmartThemeBlurTintColor:#302c35}*{box-sizing:border-box}body{margin:12px;background:#302c35;color:#eee;font:16px sans-serif}.menu_button{background:#444;color:#eee;border:1px solid #666;padding:7px;border-radius:5px;cursor:pointer}.redWarningBG{background:#733737}.text_pole{background:#27232c;color:#eee;border:1px solid #666;padding:6px;border-radius:5px;min-width:0}button,input,textarea{font:inherit}.checkbox_label{display:flex;align-items:center}dialog{max-width:90vw;background:#302c35;color:#eee;border:1px solid #888;border-radius:8px}dialog::backdrop{background:#0009}dialog button{padding:10px;margin:6px}#iig_characters_section{max-width:1100px;margin:auto}
</style></head><body><div class="iig-settings"><div id="iig_characters_section"></div></div><script type="module">
window.notes=[];window.toastr=Object.fromEntries(['info','warning','success','error'].map(k=>[k,(...v)=>notes.push([k,...v])]));
window.context={extensionSettings:{},characters:[{name:'Alpha & One',avatar:'a.png'},{name:'Beta',avatar:'b.png'}],characterId:0,chat:[],powerUserSettings:{personas:{'user.png':'User'}},getRequestHeaders:()=>({'Content-Type':'application/json'}),saveSettingsDebounced(){window.saves=(window.saves||0)+1;}};window.SillyTavern={getContext:()=>context};
window.requests=[];window.deleteCalls=[];window.failures=[];window.delay=0;window.folderFailure=false;window.invalidListing=false;window.activeDeletes=0;window.peakDeletes=0;
window.files={'Alpha & One':['iig_a #1.png','iig_missing.png','iig_fail.png','iig_primary.png','iig_appearance.png',...Array.from({length:52},(_,i)=>'iig_old_'+i+'.png'),'unrelated.png'],Beta:['iig_beta.png','iig_lore.png','iig_persona.png'],Orphan:['iig_orphan.png','other.png']};
const realFetch=fetch.bind(window);window.fetch=async(url,init={})=>{
 const u=String(url);if(!u.startsWith('/api/'))return realFetch(url,init);const body=init.body?JSON.parse(init.body):{};requests.push({url:u,body});
 if(u==='/api/characters/avatars')return Response.json([]);
 if(u==='/api/avatars/get')return Response.json(['user.png']);
 if(u==='/api/files/sanitize-filename')return Response.json({fileName:body.fileName});
 if(u==='/api/images/folders')return folderFailure?new Response('unavailable',{status:503}):Response.json(Object.keys(files));
 if(u==='/api/images/list')return folderFailure?new Response('unavailable',{status:503}):Response.json(invalidListing?{}:files[body.folder]||[]);
 if(u==='/api/images/delete'){
  activeDeletes++;peakDeletes=Math.max(peakDeletes,activeDeletes);try{
  deleteCalls.push(body.path);if(delay)await new Promise(r=>setTimeout(r,delay));
  if(failures.includes(body.path))return new Response('locked',{status:500});
  const parts=body.path.split('/'),name=parts.pop(),folder=parts.pop();
  if(name==='iig_missing.png')files[folder]=files[folder].filter(f=>f!==name);
  if(!files[folder]?.includes(name))return new Response('missing',{status:404});
  files[folder]=files[folder].filter(f=>f!==name);return Response.json({});
  }finally{activeDeletes--;}
 }
 return Response.json([]);
};
window.confirmDeletion=(header,text,options={})=>new Promise(resolve=>{
 const dlg=document.createElement('dialog');dlg.id='confirm-delete';dlg.innerHTML='<h3></h3><div class="message"></div><button id="confirm-no">Cancel</button><button id="confirm-yes">Delete</button>';
 dlg.querySelector('h3').textContent=header;dlg.querySelector('.message').innerHTML=text;
 const finish=v=>{dlg.close();dlg.remove();resolve(v);};dlg.querySelector('#confirm-no').onclick=()=>finish(false);dlg.querySelector('#confirm-yes').onclick=()=>finish(true);dlg.oncancel=e=>{e.preventDefault();finish(false);};dlg.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();finish(Boolean(options.defaultResult));}};document.body.append(dlg);dlg.showModal();
});
const settingsModule=await import('${prefix}src/settings.js');const settings=settingsModule.getSettings();
const url=(folder,file)=>'/user/images/'+encodeURIComponent(folder)+'/'+encodeURIComponent(file);
const entry=(generations,primary='',appearanceItems=[])=>({displayName:'',primary:{enabled:true,imagePath:primary,description:'keep description'},appearanceItems,generations});
const gen=(id,file,folder='Alpha & One')=>({id,imagePath:url(folder,file),prompt:id,createdAt:Date.now()});
settings.characterReferenceLibrary={characters:{'avatar:a.png':entry([gen('a','iig_a #1.png'),gen('missing','iig_missing.png'),gen('fail','iig_fail.png')],url('Alpha & One','iig_primary.png'),[{id:'ref',type:'image',enabled:false,imagePath:url('Alpha & One','iig_appearance.png'),description:'keep appearance'}]),'avatar:b.png':entry([gen('b','iig_beta.png','Beta'),gen('shared','iig_a #1.png')])},users:{'avatar:user.png':entry([],url('Beta','iig_persona.png'))}};
settings.lorebooks=[{id:'book',name:'Book',enabled:false,refs:[{id:'ref',imagePath:url('Beta','iig_lore.png'),description:'keep lore'}]}];
const library=await import('${prefix}src/characterLibraryUi.js');document.querySelector('#iig_characters_section').innerHTML=library.buildCharacterLibraryBodyHtml();library.bindCharacterLibraryEvents(settings);await library.renderCharacterLibrary(settings);
const viewer=await import('${prefix}src/lightbox.js');viewer.initLightbox();window.app={settings,library,settingsModule};window.ready=true;
</script></body></html>`;

const server=createServer((req,res)=>{
    let body,type='application/javascript';
    if(req.url==='/'){body=host;type='text/html';}
    else if(req.url.startsWith('/user/images/')||req.url.startsWith('/thumbnail')){body=picture;type='image/svg+xml';}
    else if(req.url==='/scripts/i18n.js')body='export const t=(s,...v)=>String.raw({raw:s},...v);export const translate=s=>s;';
    else if(req.url==='/scripts/popup.js')body='export class Popup {static show={confirm:(...args)=>window.confirmDeletion(...args)};}';
    else if(req.url.startsWith(prefix)){
        const file=path.resolve(root,decodeURIComponent(req.url.slice(prefix.length)));
        if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
        try{body=readFileSync(file);}catch{res.writeHead(404).end();return;}
        if(file.endsWith('.css'))type='text/css';
    }else{res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':type});res.end(body);
});

(async()=>{
    const engine=process.env.IIG_BROWSER_ENGINE||'chromium';
    const artifacts=path.join(__dirname,'artifacts','generation-library-'+engine);mkdirSync(artifacts,{recursive:true});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.IIG_BROWSER_CHANNEL?{channel:process.env.IIG_BROWSER_CHANNEL}:{})});
    const checks=[],errors=[];let page;
    try{
        for(const [mode,width]of[['desktop',1100],['mobile',320]]){
            const context=await browser.newContext({viewport:{width,height:950},isMobile:mode==='mobile',hasTouch:true});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
            const reset=async()=>{await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.ready);};
            const click=async selector=>{if(mode==='mobile')await page.locator(selector).tap();else await page.locator(selector).click();};
            const ids=()=>page.evaluate(()=>app.settings.characterReferenceLibrary.characters['avatar:a.png'].generations.map(g=>g.id));
            const idle=()=>page.waitForFunction(()=>!document.querySelector('.iig-library-generations-clear-all').disabled&&!document.querySelector('#confirm-delete'));
            await reset();
            await page.evaluate(()=>window.initialThumb=document.querySelector('[data-iig-generation-id="a"]'));
            await click('.iig-library-generations-select');await click('[data-iig-generation-id="a"]');
            assert.equal(await page.locator('#iig_lightbox').evaluate(e=>e.open),false);
            assert.equal(await page.locator('.iig-library-generation-item[aria-pressed="true"]').count(),1);
            await click('.iig-library-generations-select-all');assert.equal(await page.locator('.iig-library-generation-item[aria-pressed="true"]').count(),3);
            await click('.iig-library-generations-delete-selected');await page.locator('#confirm-delete').waitFor();
            assert.match(await page.locator('#confirm-delete').innerText(),/3/);
            await page.screenshot({path:path.join(artifacts,mode+'-confirm.png')});await click('#confirm-no');await idle();
            assert.equal(await page.evaluate(()=>deleteCalls.length),0);assert.deepEqual(await ids(),['a','missing','fail']);
            assert.equal(await page.evaluate(()=>initialThumb===document.querySelector('[data-iig-generation-id="a"]')),true);
            checks.push(mode+': selection stays out of viewer; select all and cancellation preserve files and history');

            await page.screenshot({path:path.join(artifacts,mode+'-selection.png')});
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
            await click('.iig-library-generations-select');await click('[data-iig-generation-id="a"]');
            await page.waitForFunction(()=>document.querySelector('#iig_lightbox').open);
            await click('.iig-lightbox-close');await page.waitForFunction(()=>!document.querySelector('#iig_lightbox').open);
            await click('[data-library-key="avatar:b.png"].iig-library-entity');
            assert.equal(await page.locator('.iig-library-generation-item[aria-pressed="true"]').count(),0);
            await click('[data-library-key="avatar:a.png"].iig-library-entity');
            await click('.iig-library-generations-select');await click('[data-iig-generation-id="a"]');
            await click('.iig-library-generations-delete-selected');await click('#confirm-yes');await idle();
            assert.deepEqual(await ids(),['missing','fail']);
            assert.deepEqual(await page.evaluate(()=>deleteCalls),['/user/images/Alpha & One/iig_a #1.png']);
            assert.deepEqual(await page.evaluate(()=>app.settings.characterReferenceLibrary.characters['avatar:b.png'].generations.map(g=>g.id)),['b']);
            checks.push(mode+': selection resets between characters; deletion decodes paths once and removes duplicate history links');

            await reset();await page.evaluate(()=>failures=['/user/images/Alpha & One/iig_fail.png']);
            await click('.iig-library-generations-select');await click('.iig-library-generations-select-all');await click('.iig-library-generations-delete-selected');await click('#confirm-yes');await idle();
            assert.deepEqual(await ids(),['fail']);assert.equal(await page.locator('.iig-library-generation-item').count(),1);
            assert.equal(await page.locator('.iig-library-generation-item[aria-pressed="true"]').count(),1);
            assert.ok(await page.evaluate(()=>notes.some(n=>n[0]==='warning')));
            checks.push(mode+': missing files are removed from history; failed files stay visible and selected');
            await page.evaluate(()=>failures=[]);await click('.iig-library-generations-delete-selected');await click('#confirm-yes');await idle();
            assert.equal(await page.locator('.iig-library-generation-item').count(),0);
            assert.equal(await page.locator('.iig-library-generation-actions').isVisible(),false);
            assert.equal(await page.locator('.iig-library-generations-select').isDisabled(),true);
            checks.push(mode+': retry removes failed files and exits selection after the last image');

            await reset();await click('.iig-library-generations-clear');await page.locator('#confirm-delete').waitFor();
            assert.match(await page.locator('#confirm-delete').innerText(),/Alpha & One/);
            assert.match(await page.locator('#confirm-delete').innerText(),/55/);
            await click('#confirm-yes');await idle();
            assert.deepEqual(await ids(),[]);
            assert.deepEqual(await page.evaluate(()=>files['Alpha & One']),['iig_primary.png','iig_appearance.png','unrelated.png']);
            assert.ok(await page.evaluate(()=>files.Beta.includes('iig_beta.png')));
            assert.equal(await page.evaluate(()=>app.settings.characterReferenceLibrary.characters['avatar:a.png'].primary.description),'keep description');
            checks.push(mode+': character cleanup includes files outside saved history and keeps other characters and references');

            await reset();await page.evaluate(()=>invalidListing=true);await click('.iig-library-generations-clear-all');await idle();
            assert.equal(await page.evaluate(()=>deleteCalls.length),0);assert.equal(await page.locator('#confirm-delete').count(),0);
            assert.ok(await page.evaluate(()=>notes.some(n=>n[0]==='error')));
            checks.push(mode+': malformed folder listings abort the cleanup without deleting known files');

            await reset();await click('.iig-library-generations-clear-all');await page.locator('#confirm-delete').waitFor();
            assert.match(await page.locator('#confirm-delete').innerText(),/57/);
            await click('#confirm-no');await idle();assert.equal(await page.evaluate(()=>deleteCalls.length),0);
            await click('.iig-library-generations-clear-all');await click('#confirm-yes');await idle();
            assert.deepEqual(await page.evaluate(()=>files.Orphan),['other.png']);
            assert.deepEqual(await page.evaluate(()=>files.Beta),['iig_lore.png','iig_persona.png']);
            assert.equal(await page.evaluate(()=>new Set(deleteCalls).size===deleteCalls.length),true);
            checks.push(mode+': global cleanup covers orphan folders, deduplicates files and protects disabled persona/lorebook references');

            await reset();await page.evaluate(()=>folderFailure=true);await click('.iig-library-generations-clear-all');await idle();
            assert.equal(await page.evaluate(()=>deleteCalls.length),0);assert.equal(await page.locator('#confirm-delete').count(),0);
            assert.ok(await page.evaluate(()=>notes.some(n=>n[0]==='error')));
            checks.push(mode+': discovery errors abort safely before confirmation or deletion');

            await reset();await click('.iig-library-generations-clear-all');await page.locator('#confirm-delete').waitFor();
            await page.keyboard.press('Enter');await idle();assert.equal(await page.evaluate(()=>deleteCalls.length),0);
            checks.push(mode+': Enter cancels the destructive confirmation');

            await reset();await click('.iig-library-generations-select');await click('[data-iig-generation-id="a"]');
            await click('.iig-library-generations-delete-selected');await page.locator('#confirm-delete').waitFor();
            await page.evaluate(()=>{const entry=app.settings.characterReferenceLibrary.characters['avatar:a.png'];entry.primary.imagePath=entry.generations[0].imagePath;});
            await click('#confirm-yes');await idle();assert.equal(await page.evaluate(()=>deleteCalls.length),0);assert.deepEqual(await ids(),['a','missing','fail']);
            checks.push(mode+': references assigned during confirmation are rechecked and preserved');

            await reset();await page.evaluate(()=>{
                app.settings.characterReferenceLibrary.characters['avatar:a.png'].generations=[
                    {id:'external',imagePath:'https://external.example/image.png'},
                    {id:'unsafe',imagePath:'/user/images/Alpha/%2e%2e/%2e%2e/private.png'},
                    {id:'encoded',imagePath:'/user/images/Alpha%20%26%20One/iig_%2520.png'}];
                files['Alpha & One'].push('iig_%20.png');return app.library.renderCharacterLibrary(app.settings);
            });
            await click('.iig-library-generations-select');await click('.iig-library-generations-select-all');await click('.iig-library-generations-delete-selected');await click('#confirm-yes');await idle();
            assert.deepEqual(await page.evaluate(()=>deleteCalls),['/user/images/Alpha & One/iig_%20.png']);
            assert.deepEqual(await ids(),['unsafe']);
            checks.push(mode+': remote images are unlinked without network deletion; unsafe paths are rejected and percent names decode once');

            await reset();await page.evaluate(()=>delay=80);await click('.iig-library-generations-clear');await click('#confirm-yes');
            await page.waitForFunction(()=>deleteCalls.length>0);
            assert.equal(await page.locator('.iig-library-generations-clear-all').isDisabled(),true);
            await page.evaluate(()=>{
                files['Alpha & One'].push('iig_new.png');
                app.settings.characterReferenceLibrary.characters['avatar:a.png'].generations.push({id:'new',imagePath:'/user/images/Alpha%20%26%20One/iig_new.png'});
            });
            await click('[data-library-key="avatar:b.png"].iig-library-entity');
            await page.waitForTimeout(100);await idle();assert.equal(await page.evaluate(()=>new Set(deleteCalls).size===deleteCalls.length),true);
            assert.deepEqual(await ids(),['new']);
            assert.equal(await page.locator('.iig-library-editor').getAttribute('data-library-key'),'avatar:b.png');
            assert.ok(await page.evaluate(()=>peakDeletes<=3&&peakDeletes>1));
            checks.push(mode+': batch controls stay locked; new generations and character selection survive completion');
            await context.close();
        }
        assert.deepEqual(errors,[]);writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:true,engine,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks,artifacts},null,2));
    }catch(error){if(page&&!page.isClosed())await page.screenshot({path:path.join(artifacts,'failure.png')});writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:false,checks,errors,error:String(error)},null,2));throw error;}
    finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
