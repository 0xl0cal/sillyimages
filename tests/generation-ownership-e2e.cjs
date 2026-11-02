const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const { server, prefix, png, tag } = require('./chat-image-actions-e2e.cjs');

// Failures: cross-chat writes, duplicate dispatch, mutable API/retry settings,
// protected single-image deletion, stale protection indexes, wasted image reads,
// lost reference ordering/fallbacks and repeated normalization while typing.
(async () => {
    const engine = process.env.IIG_BROWSER_ENGINE || 'chromium';
    const artifacts = path.join(__dirname, 'artifacts', 'generation-ownership-' + engine);
    mkdirSync(artifacts, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true,
        ...(engine === 'chromium' && process.env.IIG_BROWSER_CHANNEL ? { channel: process.env.IIG_BROWSER_CHANNEL } : {}) });
    const checks = [], failures = [], metrics = {};
    let page;
    const test = async (name, run) => {
        page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
        try {
            await page.goto('http://127.0.0.1:' + server.address().port);
            await page.waitForFunction(() => window.ready);
            await run(page);
            checks.push(name);
        } catch (error) { failures.push({ name, error: error.stack }); }
        finally { await page.close(); }
    };
    try {
        await test('one message owns parsing, dispatch and saving across overlapping events', async page => {
            for (const mode of ['new', 'single', 'batch']) {
                await page.reload(); await page.waitForFunction(() => window.ready);
                await page.evaluate(html => setSource(html), tag('[IMG:GEN]', 'one request'));
                await page.evaluate(async mode => {
                    delay = 80;
                    const run = () => mode === 'new' ? app.pipeline.processMessageTags(0)
                        : mode === 'single' ? app.pipeline.regenerateSingleTag(0, 0) : app.pipeline.regenerateMessageImages(0);
                    await Promise.all([run(), run()]);
                }, mode);
                assert.deepEqual(await page.evaluate(() => [requests.length, uploads, saves, app.pipeline.processingMessages.size]), [1, 1, 1, 0], mode);
            }
        });

        await test('message ownership lasts through saving and releases after a save failure', async page => {
            await page.evaluate(html => {
                setSource(html);
                context.saveChat = async () => { window.saving = true; await new Promise((resolve, reject) => { window.failSave = () => reject(new Error('fixture save failure')); }); };
                window.pending = app.pipeline.processMessageTags(0).catch(error => error.message);
            }, tag('[IMG:GEN]', 'save ownership'));
            await page.waitForFunction(() => window.saving);
            assert.equal(await page.evaluate(() => app.pipeline.processingMessages.size), 1);
            await page.evaluate(() => app.pipeline.regenerateMessageImages(0));
            assert.equal(await page.evaluate(() => requests.length), 1);
            assert.equal(await page.evaluate(async () => { failSave(); return await pending; }), 'fixture save failure');
            assert.equal(await page.evaluate(() => app.pipeline.processingMessages.size), 0);
        });

        await test('chat replacement cancels old work and does not block the same message index in the next chat', async page => {
            await page.evaluate(html => {
                context.characters = [{ name: 'Alpha', avatar: 'a.png' }, { name: 'Beta', avatar: 'b.png' }];
                context.characterId = 0;
                setSource(html);
                window.originalMessage = context.chat[0];
                window.folders = [];
                const old = fetch;
                window.fetch = async (url, init) => {
                    if (String(url).endsWith('/api/generate') && JSON.parse(init.body).prompt.includes('Alpha')) {
                        window.started = true;
                        await new Promise(resolve => { window.release = resolve; });
                    }
                    if (String(url) === '/api/images/upload') folders.push(JSON.parse(init.body).ch_name);
                    return old(url, init);
                };
                window.oldPending = app.pipeline.processMessageTags(0);
            }, tag('[IMG:GEN]', 'Alpha scene'));
            await page.waitForFunction(() => window.started);
            await page.evaluate(async html => {
                context.characterId = 1;
                setSource(html);
                await bus.emit('chat');
                await app.pipeline.processMessageTags(0);
                release();
                await oldPending;
            }, tag('[IMG:GEN]', 'Beta scene'));
            assert.deepEqual(await page.evaluate(() => ({ folders, saves,
                keys: Object.keys(app.settings.characterReferenceLibrary.characters),
                oldUnchanged: originalMessage.mes.includes('[IMG:GEN]'),
                currentReady: !context.chat[0].mes.includes('[IMG:GEN]'),
                locks: app.pipeline.processingMessages.size })), {
                folders: ['Beta'], saves: 1, keys: ['avatar:b.png'], oldUnchanged: true, currentReady: true, locks: 0,
            });
        });

        await test('source replacement during parsing releases ownership without issuing a request', async page => {
            await page.evaluate(async html => {
                setSource(html);
                const old = fetch;
                window.fetch = async (url, init) => {
                    if (init?.method === 'HEAD') { window.started = true; await new Promise(resolve => { window.release = resolve; }); return new Response('', { status: 404 }); }
                    return old(url, init);
                };
                window.pending = app.pipeline.processMessageTags(0);
            }, tag('/user/images/Fixture/missing.png', 'stale parsing'));
            await page.waitForFunction(() => window.started);
            await page.evaluate(async () => { setSource('another chat'); release(); await pending; });
            assert.deepEqual(await page.evaluate(() => [requests.length, saves, app.pipeline.processingMessages.size]), [0, 0, 0]);
        });

        await test('provider preparation and retries retain the original API credentials and model', async page => {
            const result = await page.evaluate(async ({ prefix, png }) => {
                const providers = await import(prefix + 'src/providers.js');
                const settingsModule = await import(prefix + 'src/settings.js');
                const provider = providers.resolveActiveProvider(app.settings);
                await provider.fetchModels();
                Object.assign(app.settings, { maxRetries: 1, retryDelay: 0 });
                app.settings.styles = [{ id: 'fixed', name: 'Fixed', value: 'original style' }];
                app.settings.activeStyleId = 'fixed';
                context.characters = [{ name: 'Alpha', avatar: 'a.png' }]; context.characterId = 0;
                app.settings.characterReferenceLibrary.characters['avatar:a.png'] = { primary: { description: 'original appearance' }, appearanceItems: [], generations: [] };
                let release;
                let started;
                const collecting = new Promise(resolve => { started = resolve; });
                provider.collectReferences = () => new Promise(resolve => { release = () => resolve([]); started(); });
                const calls = [];
                window.fetch = async (url, init) => {
                    if (!init.body) return Response.json({ models: [{ id: 'nano-banana-2-lite', references: false }] });
                    calls.push({ url: String(url), token: init.headers.Authorization, body: JSON.parse(init.body) });
                    if (calls.length === 1) return Response.json({ error: 'busy' }, { status: 503 });
                    return Response.json({ data_url: 'data:image/png;base64,' + png });
                };
                const pending = app.pipeline.generateImageWithRetry('scene', '', status => {
                    if (status.includes('Retry in')) app.settings.naisteraModel = 'changed-again';
                });
                await collecting;
                Object.assign(app.settings, { apiType: 'openai', endpoint: 'https://other-fixture.invalid', apiKey: 'synthetic-other', model: 'gpt-image-1' });
                app.settings.styles[0].value = 'changed style';
                app.settings.characterReferenceLibrary.characters['avatar:a.png'].primary.description = 'changed appearance';
                release();
                await pending;
                return { calls, snapshot: settingsModule.getLastRequestSnapshot().metadata };
            }, { prefix, png });
            assert.equal(result.calls.length, 2);
            for (const call of result.calls) {
                assert.equal(call.url, 'https://fixture.invalid/api/generate');
                assert.equal(call.token, 'Bearer fixture-key');
                assert.equal(call.body.model, 'nano-banana-2-lite');
                assert.ok(call.body.prompt.includes('original style'));
                assert.ok(!call.body.prompt.includes('changed style'));
                assert.ok(call.body.prompt.includes('original appearance'));
                assert.ok(!call.body.prompt.includes('changed appearance'));
            }
            assert.equal(result.snapshot.apiType, 'naistera');
            assert.equal(result.snapshot.model, 'nano-banana-2-lite');
        });

        await test('in-flight Naistera model metadata stays isolated from a different connection', async page => {
            const result = await page.evaluate(async ({ prefix, png }) => {
                const { resolveActiveProvider } = await import(prefix + 'src/providers.js');
                Object.assign(app.settings, { naisteraModel: 'novelai-fixture', naisteraNegativePrompt: 'original negative' });
                const provider = resolveActiveProvider(app.settings);
                let started, release;
                const loading = new Promise(resolve => { started = resolve; });
                const bodies = [];
                window.fetch = async (url, init) => {
                    if (String(url).endsWith('/api/models')) {
                        const original = String(url).startsWith('https://fixture.invalid');
                        if (original) { started(); await new Promise(resolve => { release = resolve; }); }
                        return Response.json({ models: [{ id: 'novelai-fixture', references: false, negative_prompt: original }] });
                    }
                    bodies.push(JSON.parse(init.body));
                    return Response.json({ data_url: 'data:image/png;base64,' + png });
                };
                const pending = app.pipeline.generateImageWithRetry('scene', '');
                await loading;
                Object.assign(app.settings, { endpoint: 'https://other-fixture.invalid', apiKey: 'synthetic-other' });
                await provider.fetchModels();
                release();
                await pending;
                return { body: bodies[0], currentSupportsNegative: provider.supportsNegativePrompt(app.settings) };
            }, { prefix, png });
            assert.equal(result.body.negative_prompt, 'original negative');
            assert.equal(result.currentSupportsNegative, false);
        });

        const setupGallery = async (page, protectedImage) => page.evaluate(async ({ prefix, protectedImage }) => {
            const refs = await import(prefix + 'src/references.js');
            const source = '/user/images/Fixture/shared.png';
            const entry = refs.getCharacterLibraryEntry('char', 'avatar:a.png', app.settings);
            entry.primary.imagePath = protectedImage ? source : '';
            entry.generations = [{ id: 'a', imagePath: source, prompt: '', createdAt: 1 }];
            refs.getCharacterLibraryEntry('char', 'avatar:b.png', app.settings).generations = [{ id: 'b', imagePath: source, prompt: '', createdAt: 1 }];
            window.deletions = [];
            const old = fetch;
            window.fetch = (url, init) => { if (String(url) === '/api/images/delete') deletions.push(JSON.parse(init.body).path); return old(url, init); };
            const gallery = document.createElement('div');
            gallery.setAttribute('data-iig-lightbox-gallery', 'fixture');
            gallery.innerHTML = '<div class="iig-library-generation-item"><img id="fixture-gallery" data-iig-lightbox data-iig-generation-id="a" data-iig-generation-key="avatar:a.png" src="' + source + '"></div>';
            document.body.append(gallery);
            document.getElementById('fixture-gallery').click();
        }, { prefix, protectedImage });

        await test('viewer preserves protected reference files and their history entries', async page => {
            await setupGallery(page, true);
            await page.locator('.iig-lightbox-delete').click();
            await page.waitForFunction(() => !document.querySelector('.iig-lightbox-delete').disabled);
            assert.deepEqual(await page.evaluate(() => [deletions.length, app.settings.characterReferenceLibrary.characters['avatar:a.png'].generations.length]), [0, 1]);
        });

        await test('viewer shares deletion cleanup across duplicate history links and honors cancellation', async page => {
            await setupGallery(page, false);
            await page.evaluate(() => window.confirmResult = false);
            await page.locator('.iig-lightbox-delete').click();
            assert.equal(await page.evaluate(() => deletions.length), 0);
            await page.evaluate(() => window.confirmResult = true);
            await page.locator('.iig-lightbox-delete').click();
            await page.waitForFunction(() => notes.some(note => note.kind === 'success' && note.message.includes('Generation deleted')));
            assert.deepEqual(await page.evaluate(() => [deletions.length, ...Object.values(app.settings.characterReferenceLibrary.characters).map(entry => entry.generations.length)]), [1, 0, 0]);
        });

        await test('deletion scans protections once per settings revision and rechecks edits during deletion', async page => {
            const result = await page.evaluate(async prefix => {
                const { deleteGenerationImages } = await import(prefix + 'src/generationImages.js');
                const { saveSettings } = await import(prefix + 'src/settings.js');
                let reads = 0;
                const paths = Array.from({ length: 100 }, (_, i) => '/user/images/Fixture/delete-' + i + '.png');
                let reference = '';
                app.settings.lorebooks = [];
                app.settings.characterReferenceLibrary = { characters: { fixture: { primary: { get imagePath() { reads++; return reference; } }, appearanceItems: [], generations: [] } }, users: {} };
                const calls = [];
                window.fetch = async (url, init) => {
                    calls.push(JSON.parse(init.body).path);
                    if (calls.length === 1) { reference = paths[99]; saveSettings(); }
                    return Response.json({});
                };
                const result = await deleteGenerationImages(paths.map(imagePath => ({ imagePath, identity: imagePath, localPath: imagePath })), app.settings);
                return { reads, deleted: result.deleted, skipped: result.skipped, protectedDeleted: calls.includes(paths[99]) };
            }, prefix);
            assert.equal(result.protectedDeleted, false);
            assert.equal(result.deleted, 99);
            assert.equal(result.skipped, 1);
            assert.ok(result.reads <= 3, 'reference scans must follow revisions, not image count: ' + result.reads);
            metrics.deletion = result;
        });

        await test('viewer confirmation pins the displayed file instead of a replacement history path', async page => {
            await setupGallery(page, false);
            await page.evaluate(() => window.confirmHook = () => {
                app.settings.characterReferenceLibrary.characters['avatar:a.png'].generations[0].imagePath = '/user/images/Fixture/new.png';
            });
            await page.locator('.iig-lightbox-delete').click();
            await page.waitForFunction(() => notes.some(note => note.kind === 'success' && note.message.includes('Generation deleted')));
            assert.deepEqual(await page.evaluate(() => deletions), ['/user/images/Fixture/shared.png']);
            assert.equal(await page.evaluate(() => app.settings.characterReferenceLibrary.characters['avatar:a.png'].generations[0]?.imagePath), '/user/images/Fixture/new.png');
        });

        await test('reference collection respects budget, source order, failed images and zero limit', async page => {
            const result = await page.evaluate(async ({ prefix, png }) => {
                const { collectProviderReferences } = await import(prefix + 'src/providerReferences.js');
                const refs = await import(prefix + 'src/references.js');
                context.characters = [{ name: 'Alpha', avatar: 'a.png' }]; context.characterId = 0;
                Object.assign(app.settings, { sendCharAvatar: true, sendUserAvatar: true, userAvatarFile: 'user.png' });
                for (const [kind, key] of [['char', 'avatar:a.png'], ['user', 'avatar:user.png']]) {
                    const entry = refs.getCharacterLibraryEntry(kind, key, app.settings);
                    entry.primary.imagePath = '/user/images/Fixture/' + kind + '-primary.png';
                    entry.appearanceItems = [1, 2].map(id => ({ id: String(id), type: 'image', enabled: true, imagePath: '/user/images/Fixture/' + kind + '-' + id + '.png', description: kind + '-' + id }));
                }
                let failed = '', calls = [];
                window.fetch = async url => {
                    calls.push(String(url));
                    return String(url).includes(failed || '\\0') ? new Response('', { status: 404 })
                        : new Response(Uint8Array.from(atob(png), c => c.charCodeAt(0)), { headers: { 'Content-Type': 'image/png' } });
                };
                const results = [];
                for (const limit of [0, 1, 2, 4]) {
                    calls = [];
                    const selected = await collectProviderReferences({ messageId: 0 }, limit);
                    results.push({ limit, calls: calls.map(url => url.split('/').pop()), count: selected.length });
                }
                calls = []; failed = 'char-primary';
                const fallback = await collectProviderReferences({ messageId: 0 }, 2);
                return { results, fallbackSources: fallback.map(refs.getReferenceSource), fallbackCalls: calls.map(url => url.split('/').pop()) };
            }, { prefix, png });
            assert.deepEqual(result.results, [
                { limit: 0, calls: [], count: 0 },
                { limit: 1, calls: ['char-primary.png'], count: 1 },
                { limit: 2, calls: ['char-primary.png', 'user-primary.png'], count: 2 },
                { limit: 4, calls: ['char-primary.png', 'user-primary.png', 'char-1.png', 'char-2.png'], count: 4 },
            ]);
            assert.deepEqual(result.fallbackSources, ['char', 'user']);
            assert.deepEqual(result.fallbackCalls, ['char-primary.png', 'char-1.png', 'user-primary.png']);
            metrics.referenceCollection = result;
        });

        await test('library reads retain normalized entry, item and history identity until replacement', async page => {
            const result = await page.evaluate(async prefix => {
                const refs = await import(prefix + 'src/references.js');
                const settings = app.settings;
                settings.characterReferenceLibrary.characters['avatar:a.png'] = { primary: { description: ' primary ' },
                    appearanceItems: [{ id: 'text', type: 'text', description: ' description ' }],
                    generations: Array.from({ length: 48 }, (_, i) => ({ id: String(i), imagePath: '/user/images/Fixture/' + i + '.png', createdAt: i })) };
                const first = refs.getCharacterLibraryEntry('char', 'avatar:a.png', settings);
                const history = first.generations, item = first.appearanceItems[0];
                for (let i = 0; i < 100; i++) {
                    const current = refs.getCharacterLibraryEntry('char', 'avatar:a.png', settings);
                    if (current !== first || current.generations !== history || current.appearanceItems[0] !== item) return { stable: false };
                }
                settings.characterReferenceLibrary.characters['avatar:a.png'] = { primary: { description: ' replaced ' } };
                const replacement = refs.getCharacterLibraryEntry('char', 'avatar:a.png', settings);
                return { stable: true, description: replacement.primary.description, replaced: replacement !== first, generations: replacement.generations.length };
            }, prefix);
            assert.deepEqual(result, { stable: true, description: 'replaced', replaced: true, generations: 0 });
        });

        const screenshot = await browser.newPage();
        await screenshot.goto('http://127.0.0.1:' + server.address().port);
        await screenshot.waitForFunction(() => window.ready);
        await screenshot.screenshot({ path: path.join(artifacts, 'chat.png'), fullPage: true });
        await screenshot.close();
        const report = { passed: failures.length === 0, engine, checks, failures, metrics };
        writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
        if (failures.length) process.exitCode = 1;
    } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
