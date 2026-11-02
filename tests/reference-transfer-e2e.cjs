const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

// Guard the existing v1 export schema, URL/File UI imports, partial image failures,
// invalid input, atomic URL batches, slot limits and browser downloads.
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/sillyimages/';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JQAAAABJRU5ErkJggg==';
const host = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${prefix}style.css"><div id="extensions_settings"></div><script type="module">
window.context={extensionSettings:{},characters:[],characterId:-1,chat:[],powerUserSettings:{personas:{}},saveSettingsDebounced(){},getRequestHeaders:()=>({'Content-Type':'application/json'})};window.SillyTavern={getContext:()=>context};
window.notes=[];window.inputs=[];window.confirmResult=true;window.toastr=Object.fromEntries(['success','error','info','warning'].map(kind=>[kind,message=>notes.push({kind,message})]));window.uploads=0;
window.book={kind:'iig-lorebook',version:1,name:'Fixture book',refs:[{id:'foreign-id',name:' Fixture ',description:' Description ',imageUrl:'https://files.invalid/ok.png',imagePath:'/foreign/path.png',matchMode:'always',enabled:false,group:' group ',priority:7,useRegex:true,secondaryKeys:'secondary'},{name:'Text only',description:'text description'},{name:'Missing image',imageUrl:'https://files.invalid/missing.png'}]};
const realFetch=fetch.bind(window);window.fetch=async(url,init={})=>{
 const u=String(url);
 if(u==='https://files.invalid/book.json')return Response.json(book);
 if(u==='https://files.invalid/bad.json')return new Response('invalid');
 if(u==='https://files.invalid/offline.json')throw new TypeError('fixture offline');
 if(u==='https://files.invalid/missing.png')return new Response('missing',{status:404});
 if(u.startsWith('https://files.invalid/'))return new Response(Uint8Array.from(atob('${png}'),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/png'}});
 if(u==='/api/images/upload')return Response.json({path:'user/images/Fixture/import_'+(++uploads)+'.png'});
 if(u.startsWith('/api/'))return Response.json([]);return realFetch(url,init);
};
const settingsModule=await import('${prefix}src/settings.js'),references=await import('${prefix}src/references.js'),ui=await import('${prefix}src/ui.js');const settings=settingsModule.getSettings();Object.assign(settings,{apiType:'openai',model:'gpt-image-1'});ui.createSettingsUI();
window.app={settings,settingsModule,references};window.ready=true;
</script>`;
const server=createServer((req,res)=>{
    let body,type='application/javascript';
    if(req.url==='/'){body=host;type='text/html';}
    else if(req.url==='/scripts/i18n.js')body='export const t=(s,...v)=>String.raw({raw:s},...v);export const translate=s=>s;';
    else if(req.url==='/scripts/popup.js')body='export class Popup{static show={input:async()=>window.inputs.shift(),confirm:async()=>window.confirmResult};}';
    else if(req.url.startsWith(prefix)){
        const file=path.resolve(root,req.url.slice(prefix.length));if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
        try{body=readFileSync(file);}catch{return res.writeHead(404).end();}if(file.endsWith('.css'))type='text/css';
    }else return res.writeHead(404).end();
    res.writeHead(200,{'Content-Type':type});res.end(body);
});
(async()=>{
    const engine=process.env.IIG_BROWSER_ENGINE||'chromium',artifacts=path.join(__dirname,'artifacts','reference-transfer-'+engine);mkdirSync(artifacts,{recursive:true});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.IIG_BROWSER_CHANNEL?{channel:process.env.IIG_BROWSER_CHANNEL}:{})});
    const page=await browser.newPage({acceptDownloads:true});const checks=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
    const click=selector=>page.locator(selector).evaluate(element=>element.click());
    try{
        await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.ready);
        await page.evaluate(()=>inputs.push('https://files.invalid/book.json'));await click('#iig_lorebook_import_url');
        await page.waitForFunction(()=>notes.some(n=>n.kind==='success'&&n.message.includes('Imported 3 refs')));
        const imported=await page.evaluate(()=>app.settingsModule.getActiveLorebook(app.settings));
        assert.equal(imported.name,'Fixture book');assert.equal(imported.refs.length,3);assert.notEqual(imported.refs[0].id,'foreign-id');
        assert.equal(imported.refs[0].imagePath,'/user/images/Fixture/import_1.png');assert.equal(imported.refs[2].imagePath,'');
        assert.equal(imported.refs[0].enabled,false);assert.equal(imported.refs[0].group,'group');assert.equal(imported.refs[0].priority,7);
        assert.equal(imported.meta.sourceUrl,'https://files.invalid/book.json');checks.push('URL UI import preserves rules and text records while counting image failures');
        const downloadPromise=page.waitForEvent('download');await click('#iig_lorebook_export');const download=await downloadPromise;
        await download.saveAs(path.join(artifacts,'export.iig.json'));const exported=JSON.parse(readFileSync(path.join(artifacts,'export.iig.json'),'utf8'));
        assert.equal(download.suggestedFilename(),'Fixture_book.iig.json');assert.equal(exported.kind,'iig-lorebook');assert.equal(exported.version,1);
        assert.deepEqual(Object.keys(exported.refs[0]).sort(),['description','enabled','group','imageUrl','matchMode','name','priority','secondaryKeys','useRegex'].sort());
        assert.equal(exported.refs[0].imageUrl,'');assert.equal(JSON.stringify(exported).includes('/user/images/'),false);
        checks.push('browser export retains v1 fields and excludes local paths, IDs and image content');
        await page.locator('#iig_lorebook_import_file_input').setInputFiles({name:'fixture.iig.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...exported,name:'File import'}))});
        await page.waitForFunction(()=>app.settingsModule.getActiveLorebook(app.settings).name==='File import');
        assert.equal(await page.locator('#iig_lorebook_import_file_input').inputValue(),'');checks.push('file UI import clears the input and creates a separate lorebook');
        for(const url of ['https://files.invalid/bad.json','https://files.invalid/offline.json']){
            const before=await page.evaluate(()=>({count:app.settings.lorebooks.length,errors:notes.filter(n=>n.kind==='error').length}));
            await page.evaluate(url=>inputs.push(url),url);await click('#iig_lorebook_import_url');
            await page.waitForFunction(n=>notes.filter(note=>note.kind==='error').length>n,before.errors);
            assert.equal(await page.evaluate(()=>app.settings.lorebooks.length),before.count);
        }checks.push('invalid JSON and network failures leave the library unchanged and show an error');
        const validation=await page.evaluate(()=>['null','{}','{"kind":"wrong"}','{"kind":"iig-lorebook","version":2,"refs":[]}','{"kind":"iig-lorebook","version":1,"refs":{}}'].map(text=>{
            try{app.references.parseLorebookJson(text);return false;}catch{return true;}
        }));assert.ok(validation.every(Boolean));checks.push('invalid format, version and reference arrays are rejected');
        await page.evaluate(()=>{notes.length=0;});await click('#iig_additional_refs_import');
        assert.equal(await page.locator('#iig_ref_import_modal').getAttribute('aria-hidden'),'false');
        await page.locator('#iig_ref_import_urls').fill('https://files.invalid/Caf%C3%A9%20ref.png\nhttps://files.invalid/second.png');await click('#iig_ref_import_submit');
        await page.waitForFunction(()=>notes.some(n=>n.kind==='success'&&n.message.includes('Imported: 2')));
        const refs=await page.evaluate(()=>app.settingsModule.getActiveLorebookReferences(app.settings));assert.deepEqual(refs.slice(0,2).map(ref=>ref.name),['Café ref.png','second.png']);
        assert.equal(await page.locator('#iig_ref_import_modal').getAttribute('aria-hidden'),'true');checks.push('URL list modal imports names from decoded filenames in source order');
        const atomic=await page.evaluate(async()=>{
            const before=app.settingsModule.getActiveLorebookReferences(app.settings).length;
            try{await app.references.importAdditionalReferencesFromUrls('https://files.invalid/ok.png\nhttps://files.invalid/missing.png');return false;}catch{return app.settingsModule.getActiveLorebookReferences(app.settings).length===before;}
        });assert.equal(atomic,true);checks.push('failed URL batches do not insert partially downloaded records');
        const limit=await page.evaluate(async()=>{
            const refs=app.settingsModule.getActiveLorebookReferences(app.settings);refs.splice(0,refs.length,...Array.from({length:255},(_,i)=>({id:'fixture-'+i,name:'fixture '+i})));
            const stats=await app.references.importAdditionalReferencesFromUrls('https://files.invalid/first.png\nhttps://files.invalid/second.png');
            let rejected=false;try{await app.references.importAdditionalReferencesFromUrls('https://files.invalid/third.png');}catch{rejected=true;}
            return{stats,count:app.settingsModule.getActiveLorebookReferences(app.settings).length,rejected};
        });assert.deepEqual(limit,{stats:{importedCount:1,skippedCount:1},count:256,rejected:true});checks.push('URL imports respect the existing 256-reference limit');
        assert.deepEqual(errors,[]);writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:true,engine,checks,errors,exported},null,2));console.log(JSON.stringify({passed:true,engine,checks,artifacts},null,2));
    }catch(error){writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:false,engine,checks,errors,error:String(error)},null,2));throw error;}
    finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
