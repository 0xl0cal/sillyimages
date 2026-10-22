const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

// Real viewer, CSS, native dialogs and browser pointers. Failures covered:
// lost scroll ownership, invisible modal hit targets, pending wheel/tap/RAF work,
// captured touches after close, nested modal isolation and stale async deletion.
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/sillyimages/';
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><rect width="1200" height="1600" fill="#426477"/><circle cx="600" cy="800" r="300" fill="#dac297"/></svg>';
const image = (id, attrs = '') => `<img id="${id}" alt="${id}" src="/image.svg" ${attrs}>`;
const host = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${prefix}style.css"><style>
*{box-sizing:border-box}body{margin:0;background:#302c35;color:#eee;font:16px sans-serif;overflow:hidden}
header{height:80px;padding:10px}button,input{font:inherit}#chat{height:400px;overflow:auto;border:1px solid #777}
#chat img,[data-iig-lightbox-gallery] img{width:130px;height:180px;object-fit:cover}.spacer{height:1500px}
#gallery-popup{width:500px;max-width:90vw;background:#302c35;color:#eee}#gallery-popup::backdrop{background:#0008}
</style></head><body style="overflow:auto !important">
<header><button id="app-button">App action</button><input id="app-input" aria-label="Chat input"></header>
<div id="chat" tabindex="0">${image('chat-image', "data-iig-instruction='{}'")}${image('chat-image-2', "data-iig-instruction='{}'")}<div class="spacer"></div></div>
<div data-iig-lightbox-gallery id="gallery"><button class="iig-library-generation-item">${image('gallery-image', 'data-iig-lightbox data-iig-generation-id="g1" data-iig-generation-key="char" data-iig-full-src="/user/images/char/image.svg"')}</button>
<button class="iig-library-generation-item">${image('gallery-image-2', 'data-iig-lightbox data-iig-generation-id="g2" data-iig-generation-key="char"')}</button></div>
<dialog id="gallery-popup"><button id="popup-action">Popup action</button><div data-iig-lightbox-gallery>${image('popup-image', 'data-iig-lightbox')}</div></dialog>
<div class="spacer"></div><script type="module">
window.toastr={success(){},error(){}};window.SillyTavern={getContext:()=>({getRequestHeaders:()=>({'Content-Type':'application/json'})})};
window.actions=0;document.querySelector('#app-button').onclick=()=>actions++;
document.querySelector('#popup-action').onclick=()=>actions++;
window.removed=[];window.pointerIds=new Set();
document.addEventListener('pointerdown',e=>{if(e.target.matches('.iig-lightbox-img'))pointerIds.add(e.pointerId);},true);
window.viewerTimers=new Set();window.viewerFrames=new Set();
const timeout=window.setTimeout.bind(window),clear=window.clearTimeout.bind(window),raf=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
window.setTimeout=(fn,ms,...args)=>{const owned=new Error().stack.includes('/src/lightbox.js');let id=timeout(()=>{viewerTimers.delete(id);fn(...args);},ms);if(owned)viewerTimers.add(id);return id;};
window.clearTimeout=id=>{viewerTimers.delete(id);clear(id);};
window.requestAnimationFrame=fn=>{let id=raf(t=>{viewerFrames.delete(id);fn(t);});if(new Error().stack.includes('/src/lightbox.js'))viewerFrames.add(id);return id;};
window.cancelAnimationFrame=id=>{viewerFrames.delete(id);cancel(id);};
window.deferDeletion=false;const realFetch=fetch.bind(window);
window.fetch=(url,init)=>String(url)==='/api/images/delete'&&deferDeletion?new Promise(resolve=>{window.completeDeletion=()=>resolve(Response.json({}));}):realFetch(url,init);
window.confirmDeletion=()=>new Promise(resolve=>{
 const dlg=document.createElement('dialog');dlg.id='confirm-delete';dlg.innerHTML='<button id="confirm-yes">Delete</button>';
 const finish=value=>{dlg.close();dlg.remove();resolve(value);};
 dlg.querySelector('button').onclick=()=>finish(true);dlg.addEventListener('cancel',e=>{e.preventDefault();finish(false);});
 document.body.append(dlg);dlg.showModal();
});
const {initLightbox}=await import('${prefix}src/lightbox.js');initLightbox();initLightbox();
window.genericImageClicks=0;document.querySelector('#chat').addEventListener('click',e=>{if(e.target.matches('img'))genericImageClicks++;});
window.ready=true;
</script></body></html>`;
const server = createServer((req, res) => {
    let body, type = 'application/javascript';
    if (req.url === '/') { body = host; type = 'text/html'; }
    else if (req.url === '/image.svg' || req.url === '/user/images/char/image.svg') { body = picture; type = 'image/svg+xml'; }
    else if (req.url === '/scripts/i18n.js') body = 'export const t=(s,...v)=>String.raw({raw:s},...v);export const translate=s=>s;';
    else if (req.url === '/scripts/popup.js') body = 'export class Popup {static show={confirm:()=>window.confirmDeletion()};}';
    else if (req.url === prefix+'src/references.js') body = 'export function removeCharacterGeneration(key,id){window.removed.push({key,id});return {id};}';
    else if (req.url === '/api/images/delete') { body = '{}'; type = 'application/json'; }
    else if (req.url.startsWith(prefix)) {
        const file = path.resolve(root, decodeURIComponent(req.url.slice(prefix.length)));
        if (!file.startsWith(root+path.sep)) { res.writeHead(403).end(); return; }
        try { body = readFileSync(file); } catch { res.writeHead(404).end(); return; }
        if (file.endsWith('.css')) type = 'text/css';
    } else { res.writeHead(404).end(); return; }
    res.writeHead(200, {'Content-Type':type});res.end(body);
});

(async()=>{
    const engine=process.env.IIG_BROWSER_ENGINE||'chromium';
    assert.ok(['chromium','webkit'].includes(engine),'IIG_BROWSER_ENGINE must be chromium or webkit');
    const artifacts=path.join(__dirname,'artifacts',engine==='webkit'?'lightbox-webkit':'lightbox');mkdirSync(artifacts,{recursive:true});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.IIG_BROWSER_CHANNEL?{channel:process.env.IIG_BROWSER_CHANNEL}:{})});
    const checks=[],errors=[],skipped=[];
    let page;
    try {
        for(const [mode,width,height] of [['desktop',900,900],['mobile',390,844]]) {
            const mobileWebKit=engine==='webkit'&&mode==='mobile';
            const context=await browser.newContext({viewport:{width,height},isMobile:mode==='mobile',hasTouch:true});
            page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
            await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready);
            const overlay=page.locator('#iig_lightbox'),full=page.locator('.iig-lightbox-img');
            const open=async(id='chat-image')=>{
                if(mode==='mobile')await page.locator('#'+id).tap();else await page.locator('#'+id).click();
                await page.waitForFunction(()=>document.querySelector('#iig_lightbox').classList.contains('open'));
                await page.waitForFunction(()=>document.querySelector('.iig-lightbox-img').naturalWidth>0);
                await page.waitForFunction(()=>getComputedStyle(document.querySelector('#iig_lightbox')).opacity==='1');
            };
            const released=async()=>{
                assert.equal(await overlay.evaluate(e=>e.classList.contains('open')),false);
                const state=await page.evaluate(()=>{
                    const e=document.querySelector('#iig_lightbox'),img=e.querySelector('img');
                    return {overflow:document.body.style.getPropertyValue('overflow'),priority:document.body.style.getPropertyPriority('overflow'),
                        timers:viewerTimers.size,frames:viewerFrames.size,captures:[...pointerIds].filter(id=>img.hasPointerCapture(id)),
                        displayed:getComputedStyle(e).display,source:img.getAttribute('src'),modal:e.matches(':modal')};
                });
                assert.deepEqual(state,{overflow:'auto',priority:'important',timers:0,frames:0,captures:[],displayed:'none',source:null,modal:false});
                if(mode==='mobile')await page.locator('#app-button').tap();else await page.locator('#app-button').click();
                await page.locator('#app-input').fill('responsive');
                await page.locator('#chat').evaluate(e=>e.scrollTop=0);
                if(mobileWebKit)await page.locator('#chat').press('ArrowDown');
                else {await page.mouse.move(100,250);await page.mouse.wheel(0,150);}
                await page.waitForFunction(()=>document.querySelector('#chat').scrollTop>0);
            };
            assert.equal(await overlay.count(),1);
            await open();assert.equal(await page.locator('.iig-lightbox-delete').isVisible(),false);
            assert.equal(await page.evaluate(()=>genericImageClicks),0);
            await page.locator('.iig-lightbox-close').click();await released();
            checks.push(mode+': close restores scroll, input, clicks and removes modal/hit targets');

            await open();await full.tap();
            await page.waitForFunction(()=>!document.querySelector('#iig_lightbox').open);await released();
            checks.push(mode+': tapping the image closes without leaving a scroll or input lock');

            await open();await full.tap();await full.tap();
            await page.waitForFunction(()=>document.querySelector('#iig_lightbox').classList.contains('zoomed'));
            await page.locator('.iig-lightbox-close').tap();await released();
            checks.push(mode+': double-tap zoom followed by touch close restores app interaction');

            await open();await full.tap();await page.keyboard.press('Escape');await open('chat-image-2');
            await page.waitForTimeout(350);assert.equal(await overlay.evaluate(e=>e.open),true);
            await page.keyboard.press('Escape');await released();
            checks.push(mode+': a canceled tap timeout cannot close a reopened viewer');

            if(!mobileWebKit) {
                await open();const rect=await full.boundingBox();await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);
                await page.mouse.wheel(0,-120);await page.keyboard.press('Escape');await released();
                await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>viewerTimers.size+viewerFrames.size),0);
                checks.push(mode+': Escape during wheel cancels timers and frames');
            } else skipped.push(mode+': wheel injection is unsupported in mobile WebKit; post-close scrolling uses a keyboard, not a native swipe');

            await open();const drag=await full.boundingBox();await page.mouse.move(drag.x+20,drag.y+20);await page.mouse.down();
            await page.mouse.move(drag.x+60,drag.y+50);await page.keyboard.press('Escape');
            assert.equal(await full.evaluate(e=>[...pointerIds].some(id=>e.hasPointerCapture(id))),false);
            await page.mouse.up();await released();
            checks.push(mode+': closing with a held pointer releases capture');

            if(engine==='chromium') {
                const cdp=await context.newCDPSession(page);await open();const box=await full.boundingBox();
                const x=box.x+box.width/2,y=box.y+box.height/2;
                await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-20,y,id:1},{x:x+20,y,id:2}]});
                await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-50,y,id:1},{x:x+50,y,id:2}]});
                await page.keyboard.press('Escape');
                assert.equal(await full.evaluate(e=>[...pointerIds].some(id=>e.hasPointerCapture(id))),false);
                await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await released();
                checks.push(mode+': closing mid-pinch releases both touch captures');
            } else skipped.push(mode+': native multi-touch injection requires Chromium CDP; physical iPhone pinch is not tested');

            await open();await overlay.evaluate(e=>e.close());await page.waitForFunction(()=>!document.querySelector('#iig_lightbox').classList.contains('open'));await released();
            checks.push(mode+': native dialog close runs complete cleanup');

            await open();
            await page.evaluate(()=>{document.querySelector('#iig_lightbox').close();document.querySelector('#chat-image-2').click();});
            await page.waitForFunction(()=>document.querySelector('#iig_lightbox').open);
            assert.equal(await full.getAttribute('alt'),'chat-image-2');
            await page.keyboard.press('Escape');await released();
            checks.push(mode+': immediate reopen after native close preserves the original scroll lock owner');

            const overflowStyles=await page.evaluate(()=>{
                document.body.style.removeProperty('overflow');document.body.style.setProperty('overflow-x','clip');document.body.style.setProperty('overflow-y','scroll','important');
                return ['overflow','overflow-x','overflow-y'].map(name=>[name,document.body.style.getPropertyValue(name),document.body.style.getPropertyPriority(name)]);
            });
            await open();await page.keyboard.press('Escape');
            assert.deepEqual(await page.evaluate(()=>['overflow','overflow-x','overflow-y'].map(name=>[name,document.body.style.getPropertyValue(name),document.body.style.getPropertyPriority(name)])),overflowStyles);
            await page.evaluate(()=>document.body.style.setProperty('overflow','auto','important'));await released();
            checks.push(mode+': mixed overflow axes and priorities survive viewing');

            await page.evaluate(()=>document.querySelector('#gallery-popup').showModal());
            await open('popup-image');await page.locator('.iig-lightbox-close').click();
            assert.equal(await page.locator('#gallery-popup').evaluate(e=>e.open),true);
            await page.locator('#popup-action').click();await page.evaluate(()=>document.querySelector('#gallery-popup').close());await released();
            checks.push(mode+': gallery viewer nests above native modal and returns to it');

            await open('gallery-image');await page.locator('.iig-lightbox-delete').click();
            await page.locator('#confirm-delete').waitFor();await page.keyboard.press('Escape');
            await page.locator('#confirm-delete').waitFor({state:'detached'});
            assert.equal(await overlay.evaluate(e=>e.open),true);
            await page.locator('.iig-lightbox-close').click();await released();
            checks.push(mode+': Escape cancels the topmost delete confirmation, not the viewer');

            await open('gallery-image');await page.evaluate(()=>window.deferDeletion=true);
            await page.locator('.iig-lightbox-delete').click();await page.locator('#confirm-yes').click();
            await page.waitForFunction(()=>typeof window.completeDeletion==='function');
            await page.locator('.iig-lightbox-close').click();await open('chat-image');
            await page.evaluate(()=>window.completeDeletion());await page.waitForFunction(()=>removed.length===1);
            assert.equal(await full.getAttribute('alt'),'chat-image');
            assert.equal(await overlay.evaluate(e=>e.open),true);
            await page.locator('.iig-lightbox-close').click();await released();
            checks.push(mode+': a completed old deletion cannot change a reopened viewer');

            for(let i=0;i<15;i++){await open(i%2?'gallery-image-2':'chat-image');await page.keyboard.press('Escape');}
            await released();assert.equal(await overlay.count(),1);
            checks.push(mode+': fifteen repeated open/close cycles leave app responsive');
            await open();await page.screenshot({path:path.join(artifacts,mode+'-open.png')});
            await page.locator('.iig-lightbox-close').click();await released();
            await page.screenshot({path:path.join(artifacts,mode+'-closed.png')});
            await context.close();
        }
        assert.deepEqual(errors,[]);
        writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:true,engine,checks,skipped,errors},null,2));
        console.log(JSON.stringify({passed:true,engine,checks,skipped,artifacts},null,2));
    } catch(error) {
        if(page&&!page.isClosed())await page.screenshot({path:path.join(artifacts,'failure.png')});
        writeFileSync(path.join(artifacts,'report.json'),JSON.stringify({passed:false,engine,checks,skipped,errors,error:String(error)},null,2));throw error;
    } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
