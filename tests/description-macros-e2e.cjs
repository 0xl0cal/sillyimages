const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

// Failure cases: missing registration, async macro values, stale chat/persona or
// library edits, editor selection replacing the active character, disabled or
// empty descriptions leaking, duplicate temporary references, provider-dependent
// text, avatar downloads, settings writes and interference with existing macros.
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/sillyimages/';
const engine = process.env.IIG_BROWSER_ENGINE || 'chromium';
const artifacts = path.join(__dirname, 'artifacts', 'description-macros-' + engine);
const host = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${prefix}style.css">
<style>body{background:#302c35;color:#eee;font:16px sans-serif}textarea{width:95%;min-height:70px}pre{white-space:pre-wrap}</style>
<label>Prompt template<textarea id="template"></textarea></label><button id="expand">Expand</button><pre id="output"></pre>
<div id="extensions_settings"></div><script type="module">
window.saves=0;window.requests=[];window.handlers=new Map();window.notes=[];
window.toastr=Object.fromEntries(['error','warning','info','success'].map(name=>[name,(...args)=>notes.push([name,...args])]));
const listeners=new Map();
window.context={
 extensionSettings:{},characters:[{name:'Alpha',avatar:'alpha.png'},{name:'Beta',avatar:'beta.png'}],characterId:0,chat:[],
 powerUserSettings:{personas:{'user.png':'User','other.png':'Other','manual.png':'Manual'}},
 getRequestHeaders:()=>({'Content-Type':'application/json'}),saveSettingsDebounced(){saves++;},
 event_types:{APP_READY:'ready',CHAT_CHANGED:'chat',CHARACTER_MESSAGE_RENDERED:'character',USER_MESSAGE_RENDERED:'user'},
 eventSource:{on(name,fn){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);},makeLast(name,fn){this.on(name,fn);},async emit(name,...args){for(const fn of listeners.get(name)||[])await fn(...args);}},
 registerMacro(name,handler){if(handlers.has(name))throw new Error('Duplicate macro: '+name);handlers.set(name,handler);},
 substituteParams(text){return text.replace(/{{([^{}]+)}}/g,(token,name)=>{
  if(!handlers.has(name))return token;const value=handlers.get(name)();
  if(typeof value!=='string')throw new Error('Macro must return text synchronously: '+name);return value;
 });},
};
handlers.set('charDescription',()=> 'Native character description');handlers.set('persona',()=> 'Native persona description');
window.SillyTavern={getContext:()=>context};
document.getElementById('expand').onclick=()=>document.getElementById('output').textContent=context.substituteParams(document.getElementById('template').value);
const realFetch=fetch.bind(window);window.fetch=(url,init)=>{
 const value=String(url);requests.push(value);
 if(value==='/api/avatars/get')return Promise.resolve(Response.json(['user.png','other.png','manual.png']));
 if(value.startsWith('/api/'))return Promise.resolve(Response.json([]));return realFetch(url,init);
};
const settingsModule=await import('${prefix}src/settings.js');
const references=await import('${prefix}src/references.js');
const personas=await import('/scripts/personas.js');
const settings=settingsModule.getSettings();
Object.assign(settings,{useActiveUserPersonaAvatar:true,userAvatarFile:'manual.png',apiType:'novelai',sendRefDescriptions:false,novelaiCharacterDescriptionsMode:'none',naisteraCharacterDescriptionsMode:'none',sendCharAvatar:false,sendUserAvatar:false,naisteraSendCharAvatar:false,naisteraSendUserAvatar:false});
const configure=(kind,key,label)=>{
 const entry=references.getCharacterLibraryEntry(kind,key,settings);
 entry.primary={enabled:true,imagePath:'/missing-main.png',description:'  '+label+' main  '};
 entry.appearanceItems=[
  {id:'text',type:'text',enabled:true,description:label+' details\\nsecond line'},
  {id:'off-text',type:'text',enabled:false,description:'HIDDEN text'},
  {id:'image',type:'image',enabled:true,imagePath:'/missing-extra.png',description:label+' image'},
  {id:'off-image',type:'image',enabled:false,imagePath:'/hidden.png',description:'HIDDEN image'},
  {id:'empty',type:'text',enabled:true,description:'   '},
  {id:'no-image',type:'image',enabled:true,imagePath:'',description:label+' image description only'},
 ];return entry;
};
for(const [kind,key,label]of[['char','avatar:alpha.png','Alpha'],['char','avatar:beta.png','Beta'],['user','avatar:user.png','User'],['user','avatar:other.png','Other'],['user','avatar:manual.png','Manual']])configure(kind,key,label);
settings.lorebooks=[{id:'book',name:'Book',enabled:true,refs:[{id:'book-ref',name:'forest',description:'quiet woods',enabled:true,group:'locations',imagePath:''}]}];
await import('${prefix}index.js');
window.app={settings,settingsModule,references,personas};window.ready=true;
</script>`;
const server = createServer((req, res) => {
    let body, type = 'application/javascript';
    if (req.url === '/') { body = host; type = 'text/html'; }
    else if (req.url === '/scripts/i18n.js') body = 'export const t=(s,...v)=>String.raw({raw:s},...v);export const translate=s=>s;';
    else if (req.url === '/scripts/popup.js') body = 'export class Popup{static show={confirm:async()=>false,input:async()=>null};}';
    else if (req.url === '/scripts/personas.js') body = 'export let user_avatar="user.png";export function setAvatar(value){user_avatar=value;}export const getUserAvatar=value=>"/User Avatars/"+encodeURIComponent(value);';
    else if (req.url.startsWith(prefix)) {
        const file = path.resolve(root, decodeURIComponent(req.url.slice(prefix.length)));
        if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
        try { body = readFileSync(file); } catch { return res.writeHead(404).end(); }
        if (file.endsWith('.css')) type = 'text/css';
    } else if (/^\/(thumbnail|User(?:%20| )Avatars|characters|missing|hidden\.png)/.test(req.url)) {
        body = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#687"/></svg>';
        type = 'image/svg+xml';
    } else return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': type }); res.end(body);
});

(async () => {
    mkdirSync(artifacts, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await (engine === 'webkit' ? webkit : chromium).launch({
        headless: true, ...(engine === 'chromium' ? { channel: process.env.IIG_BROWSER_CHANNEL || 'msedge' } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const report = { passed: false, engine, checks: [], outputs: [], errors: [], failedRequests: [] };
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) report.failedRequests.push({ url: response.url(), status: response.status() }); });
    const description = label => `${label} main\n${label} details\nsecond line\n${label} image\n${label} image description only`;
    const expand = async (template, expected, name) => {
        await page.locator('#template').fill(template);
        await page.locator('#expand').click();
        const actual = await page.locator('#output').textContent();
        report.outputs.push({ name, template, actual });
        assert.equal(actual, expected, name);
        report.checks.push(name);
    };
    try {
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        const names = await page.evaluate(() => [...handlers.keys()]);
        assert.ok(names.includes('iig_char_description') && names.includes('iig_user_description'), 'entry point registers both macros');
        report.checks.push('entry point registers both macros');
        await expand('{{iig_char_description}}', description('Alpha'), 'enabled main, text and image descriptions in library order');
        await expand('{{iig_user_description}}', description('User'), 'active persona with automatic descriptions and images disabled');
        await expand('{{charDescription}} / {{persona}} / {{unknown}}', 'Native character description / Native persona description / {{unknown}}', 'native and unknown macros are untouched');
        const book = await page.evaluate(() => context.substituteParams('{{iig-book}}'));
        assert.match(book, /forest.*quiet woods/); report.checks.push('existing lorebook macro remains registered');

        const sideEffects = await page.evaluate(() => {
            const before = JSON.stringify(context.extensionSettings), beforeSaves = saves, beforeRequests = requests.length;
            for (let i = 0; i < 100; i++) context.substituteParams('{{iig_char_description}} {{iig_user_description}}');
            return { unchanged: before === JSON.stringify(context.extensionSettings), saves: saves - beforeSaves, requests: requests.length - beforeRequests };
        });
        assert.deepEqual(sideEffects, { unchanged: true, saves: 0, requests: 0 });
        report.checks.push('repeated expansion does not save, change storage or fetch images');

        await page.evaluate(() => { context.characterId = 1; app.personas.setAvatar('other.png'); });
        await expand('{{iig_char_description}}\n---\n{{iig_user_description}}', description('Beta') + '\n---\n' + description('Other'), 'chat and persona switches apply without refresh or queued events');
        await page.evaluate(() => { app.settings.useActiveUserPersonaAvatar = false; });
        await expand('{{iig_user_description}}', description('Manual'), 'explicitly selected reference persona');
        await page.evaluate(() => { app.settings.userAvatarFile = 'user.png'; });
        await expand('{{iig_user_description}}', description('User'), 'manual persona changes apply immediately');
        await page.evaluate(() => { app.settings.useActiveUserPersonaAvatar = true; app.personas.setAvatar(''); });
        await expand('{{iig_user_description}}', description('User'), 'missing active persona uses selected avatar');

        await page.evaluate(() => {
            const entry = app.references.getCharacterLibraryEntry('char', 'avatar:beta.png');
            entry.primary.enabled = false;
            entry.appearanceItems.find(item => item.id === 'text').enabled = false;
            entry.appearanceItems.find(item => item.id === 'image').description = 'edited <detail> & "quoted"';
        });
        await expand('{{iig_char_description}}', 'edited <detail> & "quoted"\nBeta image description only', 'edits and enable switches update plain text without escaping');
        await page.evaluate(() => app.references.setTemporaryCharacterPrimary('char', 'avatar:beta.png', 'image'));
        await expand('{{iig_char_description}}', 'edited <detail> & "quoted"\nBeta image description only', 'temporary primary appears once');
        await page.evaluate(() => {
            app.settings.characterReferenceLibrary.characters['avatar:beta.png'] = { primary: { enabled: true, description: 'Replacement' }, appearanceItems: [] };
        });
        await expand('{{iig_char_description}}', 'Replacement', 'replaced library entry is read live');

        for (const apiType of ['openai', 'naistera', 'novelai', 'a1111']) {
            await page.evaluate(apiType => { Object.assign(app.settings, { apiType, naisteraModel: 'novelai-v5', enabled: false }); }, apiType);
            await expand('{{iig_char_description}}', 'Replacement', apiType + ': explicit macro is independent of provider and automatic generation');
        }
        await page.evaluate(() => {
            context.characterId = 20; app.personas.setAvatar('missing.png');
            app.settings.characterReferenceLibrary.characters['no-character'] = { primary: { description: 'HIDDEN stale character' } };
            app.settings.characterReferenceLibrary.users['no-user-avatar'] = { primary: { description: 'HIDDEN stale persona' } };
        });
        await expand('A{{iig_char_description}}B{{iig_user_description}}C', 'ABC', 'missing character or persona entry expands to empty text');
        await page.evaluate(() => { context.characterId = undefined; app.personas.setAvatar(''); app.settings.userAvatarFile = ''; });
        await expand('A{{iig_char_description}}B{{iig_user_description}}C', 'ABC', 'no selection does not read sentinel entries');

        await page.evaluate(async prefix => {
            context.characterId = 0; app.personas.setAvatar('user.png');
            const ui = await import(prefix + 'src/ui.js'); ui.createSettingsUI();
            app.library = await import(prefix + 'src/characterLibraryUi.js');
            document.getElementById('iig_characters_section').closest('details').open = true;
            await app.library.renderCharacterLibrary(app.settings);
        }, prefix);
        await page.locator('button.iig-library-entity[data-library-key="avatar:beta.png"]').click();
        await page.waitForFunction(() => document.querySelector('.iig-library-editor')?.dataset.libraryKey === 'avatar:beta.png');
        await page.locator('.iig-library-primary-description').fill('Editor-only Beta');
        await expand('{{iig_char_description}}', description('Alpha'), 'editing another character does not change the current chat macro');
        await page.locator('button.iig-library-entity[data-library-key="avatar:alpha.png"]').click();
        await page.waitForFunction(() => document.querySelector('.iig-library-editor')?.dataset.libraryKey === 'avatar:alpha.png');
        await page.locator('.iig-library-primary-description').fill('Edited through UI');
        await expand('{{iig_char_description}}', description('Alpha').replace('Alpha main', 'Edited through UI'), 'library input updates the macro without reopening');
        await page.screenshot({ path: path.join(artifacts, 'library-macros.png'), fullPage: true });
        await page.evaluate(() => {
            const entry = app.references.getCharacterLibraryEntry('char', 'avatar:alpha.png');
            entry.primary.enabled = false; entry.appearanceItems.forEach(item => item.enabled = false);
        });
        await expand('before{{iig_char_description}}after', 'beforeafter', 'all descriptions disabled produces no placeholder');

        assert.deepEqual(report.errors, []);
        assert.deepEqual(report.failedRequests, []);
        report.passed = true;
    } catch (error) {
        report.error = String(error);
        throw error;
    } finally {
        report.sources = Object.fromEntries(['index.js', 'src/descriptionMacros.js', 'src/references.js', 'tests/description-macros-e2e.cjs'].map(file => {
            try { return [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]; }
            catch { return [file, null]; }
        }));
        writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
