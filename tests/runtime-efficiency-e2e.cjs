const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { server, prefix, tag } = require('./chat-image-actions-e2e.cjs');

// Failure cases: retained abort listeners, unbounded response bodies, blocked
// reference cancellation, stale UI caches, input/selection loss, unnecessary
// catalog sorts and snapshots that copy unrelated persona histories.
(async () => {
    const engine = process.env.IIG_BROWSER_ENGINE || 'chromium';
    const artifacts = path.join(__dirname, 'artifacts', 'runtime-efficiency-' + engine);
    mkdirSync(artifacts, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true,
        ...(engine === 'chromium' && process.env.IIG_BROWSER_CHANNEL ? { channel: process.env.IIG_BROWSER_CHANNEL } : {}) });
    const checks = [], failures = [], metrics = {};
    const test = async (name, run) => {
        const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
        try {
            await page.goto('http://127.0.0.1:' + server.address().port);
            await page.waitForFunction(() => window.ready);
            await run(page);
            checks.push(name);
        } catch (error) { failures.push({ name, error: error.stack }); }
        finally { await page.close(); }
    };
    try {
        await test('request lifecycle releases listeners after success, network and decoder errors', async page => {
            const result = await page.evaluate(async prefix => {
                const { fetchWithTimeout } = await import(prefix + 'src/utils.js');
                const owner = new AbortController();
                const add = owner.signal.addEventListener.bind(owner.signal), remove = owner.signal.removeEventListener.bind(owner.signal);
                let added = 0, removed = 0;
                owner.signal.addEventListener = (...args) => { added++; return add(...args); };
                owner.signal.removeEventListener = (...args) => { removed++; return remove(...args); };
                let requestSignal;
                window.fetch = async (url, init) => { requestSignal = init.signal; return Response.json({ ok: true }); };
                for (let i = 0; i < 40; i++) await fetchWithTimeout('https://fixture.invalid', {}, 1000, owner.signal, response => response.json());
                let decoderError = '', networkError = '';
                try { await fetchWithTimeout('https://fixture.invalid', {}, 1000, owner.signal, () => { throw new Error('decode failure'); }); } catch (error) { decoderError = error.message; }
                const decoderAborted = requestSignal.aborted;
                window.fetch = async () => { throw new TypeError('network failure'); };
                try { await fetchWithTimeout('https://fixture.invalid', {}, 1000, owner.signal, response => response.json()); } catch (error) { networkError = error.message; }
                return { added, removed, decoderError, networkError, decoderAborted };
            }, prefix);
            assert.equal(result.added, result.removed);
            assert.equal(result.decoderError, 'decode failure');
            assert.equal(result.networkError, 'network failure');
            assert.equal(result.decoderAborted, true);
            metrics.transport = result;
        });

        await test('deadline covers headers and body; cancellation rejects before an aborted request starts', async page => {
            const result = await page.evaluate(async prefix => {
                const { fetchWithTimeout } = await import(prefix + 'src/utils.js');
                const outcomes = [];
                for (const phase of ['headers', 'body']) {
                    let signal, stream;
                    window.fetch = async (url, init) => {
                        signal = init.signal;
                        if (phase === 'headers') return new Promise(() => {});
                        return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
                    };
                    const pending = fetchWithTimeout('https://fixture.invalid', {}, 25, null, response => response.text())
                        .then(() => 'resolved', error => error.name);
                    outcomes.push({ phase, outcome: await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('pending'), 150))]), aborted: signal?.aborted });
                    stream?.close();
                }
                let calls = 0;
                window.fetch = async () => { calls++; return Response.json({}); };
                const owner = new AbortController(); owner.abort('user-cancel');
                let preAborted = false;
                try { await fetchWithTimeout('https://fixture.invalid', {}, 1000, owner.signal, response => response.json()); } catch { preAborted = true; }
                return { outcomes, calls, preAborted };
            }, prefix);
            for (const item of result.outcomes) { assert.equal(item.outcome, 'AbortError', item.phase); assert.equal(item.aborted, true); }
            assert.equal(result.calls, 0); assert.equal(result.preAborted, true);
        });

        for (const mode of ['stop', 'timeout']) await test('blocked reference ' + mode + ' releases message ownership', async page => {
            await page.evaluate(({ html, mode }) => {
                context.characters = [{ name: 'Alpha', avatar: 'a.png' }]; context.characterId = 0;
                Object.assign(app.settings, { naisteraModel: 'banana', naisteraSendCharAvatar: true });
                app.settings.characterReferenceLibrary.characters['avatar:a.png'] = { primary: { imagePath: '/user/images/Fixture/blocked.png' }, appearanceItems: [], generations: [] };
                const old = fetch, timeout = setTimeout;
                if (mode === 'timeout') window.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 15000 ? 25 : ms, ...args);
                window.fetch = (url, init) => {
                    if (String(url).endsWith('/api/models')) return Promise.resolve(Response.json({ models: [{ id: 'banana', references: true }] }));
                    if (String(url).endsWith('/blocked.png')) {
                        window.blocked = true; window.hasSignal = Boolean(init?.signal);
                        return new Promise((resolve, reject) => {
                            window.releaseReference = () => resolve(new Response('', { status: 404 }));
                            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                        });
                    }
                    return old(url, init);
                };
                setSource(html); window.settled = false;
                window.pending = app.pipeline.processMessageTags(0).finally(() => { window.settled = true; });
            }, { html: tag('[IMG:GEN]', 'reference lifecycle'), mode });
            await page.waitForFunction(() => window.blocked);
            if (mode === 'stop') await page.locator('.iig-stop-btn').click();
            await page.waitForTimeout(180);
            const result = await page.evaluate(() => ({ hasSignal, settled, locks: app.pipeline.processingMessages.size, requests: requests.length, stopped: Boolean(document.querySelector('.iig-stopped-image')) }));
            await page.evaluate(async () => { releaseReference(); await pending; });
            assert.equal(result.hasSignal, true);
            assert.equal(result.settled, true); assert.equal(result.locks, 0);
            assert.equal(result.requests, mode === 'stop' ? 0 : 1);
            if (mode === 'stop') assert.equal(result.stopped, true);
        });

        for (const phase of ['catalog', 'generation', 'poll']) await test('Naistera ' + phase + ' cannot hold a message after cancellation/deadline', async page => {
            await page.evaluate(({ html, phase }) => {
                Object.assign(app.settings, { naisteraModel: 'new-banana', naisteraPolling: phase === 'poll' });
                const old = fetch, timeout = setTimeout;
                if (phase !== 'catalog') window.setTimeout = (fn, ms, ...args) => timeout(fn, ms > 1000 ? 25 : ms, ...args);
                window.fetch = (url, init) => {
                    const u = String(url);
                    if (u.endsWith('/api/models')) {
                        if (phase !== 'catalog') return Promise.resolve(Response.json({ models: [{ id: 'new-banana', references: false }] }));
                        window.blocked = true;
                        return new Promise((resolve, reject) => {
                            window.releaseRequest = () => resolve(Response.json({ models: [{ id: 'new-banana', references: false }] }));
                            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                        });
                    }
                    if (u.endsWith('/api/generate') || u.includes('/api/generate/jobs/')) {
                        if (phase === 'poll' && u.endsWith('/api/generate')) return Promise.resolve(Response.json({ job_id: 'fixture-job' }));
                        window.blocked = true;
                        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
                            window.releaseRequest = () => { try {
                                controller.enqueue(new TextEncoder().encode(JSON.stringify({ status: 'completed', data_url: 'data:image/png;base64,AA==' })));
                                controller.close();
                            } catch {} };
                            init?.signal?.addEventListener('abort', () => { try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {} }, { once: true });
                        } }), { headers: { 'Content-Type': 'application/json' } }));
                    }
                    return old(url, init);
                };
                setSource(html); window.settled = false;
                window.pending = app.pipeline.processMessageTags(0).finally(() => { window.settled = true; });
            }, { html: tag('[IMG:GEN]', 'request deadline'), phase });
            await page.waitForFunction(() => window.blocked);
            if (phase === 'catalog') await page.locator('.iig-stop-btn').click();
            await page.waitForTimeout(180);
            const result = await page.evaluate(() => ({ settled, locks: app.pipeline.processingMessages.size }));
            await page.evaluate(async () => { releaseRequest(); await pending; });
            assert.equal(result.settled, true, phase); assert.equal(result.locks, 0, phase);
        });

        await test('style editing retains objects, input focus and replacement normalization', async page => {
            const result = await page.evaluate(async prefix => {
                const { renderStyleSettings } = await import(prefix + 'src/promptLibraryUi.js');
                const { ensureStyles } = await import(prefix + 'src/settings.js');
                app.settings.styles = Array.from({ length: 100 }, (_, i) => ({ id: 's' + i, name: 'Style ' + i, value: 'style '.repeat(100) }));
                renderStyleSettings();
                document.getElementById('extensions_settings').style.display = 'block';
                document.getElementById('iig_styles_section').closest('details').open = true;
                const input = document.getElementById('iig_style_value'); input.focus();
                const first = app.settings.styles[0], array = app.settings.styles;
                let allocations = 0;
                const map = Array.prototype.map;
                Array.prototype.map = function (fn, ...args) { if (new Error().stack.includes('ensureStyles')) allocations += this.length; return map.call(this, fn, ...args); };
                for (let i = 0; i < 20; i++) { input.value += 'x'; input.dispatchEvent(new Event('input', { bubbles: true })); }
                Array.prototype.map = map;
                const stable = first === app.settings.styles[0] && array === app.settings.styles;
                const focused = document.activeElement === input;
                app.settings.styles[1] = { id: 'replacement', name: ' Replacement ', value: ' new ' };
                const replacement = ensureStyles(app.settings)[1];
                app.settings.negativePrompts = [{ id: 'n', name: ' Negative ', value: ' bad ' }];
                const negative = ensureStyles(app.settings, 'negativePrompts')[0];
                return { allocations, stable, focused, replacement, negative };
            }, prefix);
            assert.equal(result.allocations, 0); assert.equal(result.stable, true); assert.equal(result.focused, true);
            assert.deepEqual(result.replacement, { id: 'replacement', name: 'Replacement', value: 'new' });
            assert.deepEqual(result.negative, { id: 'n', name: 'Negative', value: 'bad' });
            metrics.styles = { events: 20, styles: 100, allocatedByNormalization: result.allocations };
        });

        await test('visual mutations reuse parsing; source and DOM replacements restore current instruction bindings', async page => {
            const html = Array.from({ length: 40 }, (_, i) => tag('/user/images/Fixture/' + i + '.png', 'scene ' + i)).join('');
            await page.evaluate(html => setSource(html), html);
            await page.waitForFunction(() => document.querySelectorAll('.iig-img-host').length === 40);
            await page.waitForTimeout(100);
            const result = await page.evaluate(async () => {
                const parse = JSON.parse; let parses = 0;
                JSON.parse = (...args) => { if (new Error().stack.includes('parseImageTags')) parses++; return parse(...args); };
                const image = document.querySelector('.mes_text img');
                for (let i = 0; i < 5; i++) { image.classList.toggle('fixture-highlight'); await new Promise(resolve => setTimeout(resolve, 45)); }
                const visualParses = parses;
                document.querySelector('.mes_text').innerHTML = context.messageFormatting(context.chat[0].mes);
                await new Promise(resolve => setTimeout(resolve, 100));
                const repeatedParses = parses - visualParses;
                context.chat[0].mes = context.chat[0].mes.replace('scene 0', 'updated scene');
                document.querySelector('.mes_text').innerHTML = context.messageFormatting(context.chat[0].mes);
                await new Promise(resolve => setTimeout(resolve, 100));
                const first = document.querySelector('.mes_text img');
                const prompt = JSON.parse(first.getAttribute('data-iig-instruction')).prompt;
                JSON.parse = parse;
                return { visualParses, repeatedParses, changedParses: parses - repeatedParses - visualParses, prompt, hosts: document.querySelectorAll('.iig-img-host').length, tagIndex: first.dataset.iigTagIndex };
            });
            assert.equal(result.visualParses, 0); assert.equal(result.repeatedParses, 0);
            assert.ok(result.changedParses > 0); assert.equal(result.prompt, 'updated scene');
            assert.equal(result.hosts, 40); assert.equal(result.tagIndex, '0');
            metrics.hydration = result;
        });

        await test('search reuses sorted catalogs and observes in-place names and library edits', async page => {
            const result = await page.evaluate(async prefix => {
                const library = await import(prefix + 'src/characterLibraryUi.js');
                context.characters = Array.from({ length: 2000 }, (_, i) => ({ name: 'Person ' + String(i).padStart(4, '0'), avatar: 'a' + i + '.png' }));
                context.characterId = 0; await library.renderCharacterLibrary(app.settings);
                const compare = String.prototype.localeCompare; let comparisons = 0;
                String.prototype.localeCompare = function (...args) { comparisons++; return compare.apply(this, args); };
                const input = document.getElementById('iig_library_search');
                const query = async value => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 130)); };
                for (const value of ['P', 'Pe', 'Per']) await query(value);
                const searchComparisons = comparisons;
                context.characters[7].name = 'Zelda'; await query('Zelda');
                const renamed = document.querySelector('.iig-library-entity strong')?.textContent;
                app.settings.characterReferenceLibrary.characters['avatar:a7.png'] = { displayName: 'Nickname', primary: {}, appearanceItems: [], generations: [] };
                await query('Nickname'); const nickname = document.querySelector('.iig-library-entity strong')?.textContent;
                String.prototype.localeCompare = compare;
                return { searchComparisons, renamed, nickname };
            }, prefix);
            assert.equal(result.searchComparisons, 0); assert.equal(result.renamed, 'Zelda'); assert.equal(result.nickname, 'Nickname');
            metrics.search = result;
        });

        await test('persona search retains catalog order and observes persona name edits', async page => {
            const result = await page.evaluate(async prefix => {
                const { fetchUserAvatars } = await import(prefix + 'src/avatarPicker.js');
                const avatars = Array.from({ length: 200 }, (_, i) => 'u' + i + '.png');
                context.powerUserSettings.personas = Object.fromEntries(avatars.map((file, i) => [file, 'Persona ' + i]));
                const old = fetch;
                window.fetch = (url, init) => String(url) === '/api/avatars/get' ? Promise.resolve(Response.json(avatars)) : old(url, init);
                await fetchUserAvatars();
                document.querySelector('[data-library-tab="user"]').click();
                await new Promise(resolve => setTimeout(resolve, 80));
                let comparisons = 0;
                const compare = String.prototype.localeCompare;
                String.prototype.localeCompare = function (...args) { comparisons++; return compare.apply(this, args); };
                const search = document.getElementById('iig_library_search');
                const query = async value => { search.value = value; search.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 130)); };
                for (const value of ['P', 'Pe', 'Per']) await query(value);
                const searchComparisons = comparisons;
                context.powerUserSettings.personas['u7.png'] = 'New Persona'; await query('New Persona');
                const title = document.querySelector('.iig-library-entity strong')?.textContent;
                String.prototype.localeCompare = compare;
                return { searchComparisons, title };
            }, prefix);
            assert.equal(result.searchComparisons, 0); assert.equal(result.title, 'New Persona');
            metrics.personaSearch = result;
        });

        await test('plain messages allocate no snapshot; image requests copy only the selected persona', async page => {
            const result = await page.evaluate(async ({ prefix, html }) => {
                app.settings.characterReferenceLibrary.users = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['avatar:u' + i + '.png', { primary: { description: 'persona ' + i }, appearanceItems: [], generations: [] }]));
                Object.assign(app.settings, { userAvatarFile: 'u7.png', naisteraCharacterDescriptionsMode: 'character-prompt' });
                const clone = structuredClone; let copies = 0;
                window.structuredClone = value => { if (value && !Array.isArray(value) && Object.hasOwn(value, 'generations')) copies++; return clone(value); };
                setSource('Plain text without image instructions.');
                await app.pipeline.processMessageTags(0); const plainCopies = copies;
                setSource(html); await app.pipeline.processMessageTags(0);
                const selectedCopies = copies - plainCopies;
                window.structuredClone = clone;
                return { plainCopies, selectedCopies, prompt: requests[0]?.prompt, locks: app.pipeline.processingMessages.size };
            }, { prefix, html: tag('[IMG:GEN]', 'persona request') });
            assert.equal(result.plainCopies, 0); assert.equal(result.selectedCopies, 1);
            assert.ok(result.prompt.includes('persona 7')); assert.ok(!result.prompt.includes('persona 8'));
            assert.equal(result.locks, 0); metrics.snapshots = result;
            await page.screenshot({ path: path.join(artifacts, 'chat.png'), fullPage: true });
        });

        const report = { passed: failures.length === 0, engine, checks, failures, metrics };
        writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
        if (failures.length) process.exitCode = 1;
    } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
