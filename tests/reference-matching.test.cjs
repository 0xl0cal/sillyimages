const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Run the extension modules with an in-memory Tavern context and HTTP transport.
async function loadExtension({ respond } = {}) {
    const requests = [];
    const tavern = { extensionSettings: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }) };
    const context = vm.createContext({
        console, URL, Blob, FormData, AbortController, setTimeout, clearTimeout,
        structuredClone, atob, btoa,
        SillyTavern: { getContext: () => tavern },
        fetch: async (url, init = {}) => {
            requests.push({ url, ...init });
            if (respond) return respond(url, init);
            if (init.method === 'POST') {
                return Response.json({ data_url: 'data:image/png;base64,AA==', data: [{ b64_json: 'AA==' }] });
            }
            return new Response(new Uint8Array([0]), { headers: { 'Content-Type': 'image/png' } });
        },
        FileReader: class {
            async readAsDataURL(blob) {
                this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
                this.onloadend();
            }
        },
    });
    const modules = new Map();
    function moduleFor(filename) {
        if (modules.has(filename)) return modules.get(filename);
        const module = filename.endsWith(`${path.sep}src${path.sep}i18n.js`)
            ? new vm.SyntheticModule(['t', 'translate'], function () {
                this.setExport('t', (parts, ...values) => String.raw({ raw: parts }, ...values));
                this.setExport('translate', (value) => value);
            }, { context, identifier: filename })
            : new vm.SourceTextModule(readFileSync(filename, 'utf8'), { context, identifier: filename });
        modules.set(filename, module);
        return module;
    }
    const sourceDir = path.resolve(__dirname, '../src');
    const providers = moduleFor(path.join(sourceDir, 'providers.js'));
    await providers.link((specifier, parent) => moduleFor(path.resolve(path.dirname(parent.identifier), specifier)));
    await providers.evaluate();
    const settingsModule = moduleFor(path.join(sourceDir, 'settings.js')).namespace;
    const settings = settingsModule.getSettings();
    Object.assign(settings, { apiType: 'naistera', endpoint: 'https://example.test', apiKey: 'test', naisteraModel: 'image-model' });
    return {
        requests, settings, settingsModule, providers: providers.namespace,
        parser: moduleFor(path.join(sourceDir, 'parser.js')).namespace,
        references: moduleFor(path.join(sourceDir, 'references.js')).namespace,
        utils: moduleFor(path.join(sourceDir, 'utils.js')).namespace,
    };
}

function setReferences(settings, refs) {
    settings.lorebooks = [{ id: 'book', name: 'Book', enabled: true, refs }];
}

test('media paths encode filenames and round-trip through URL decoding', async () => {
    const { utils } = await loadExtension();
    for (const raw of [
        '/user/images/Nora Ashford #1/image 01.png',
        '/user/images/Демьян & friends/iig_100%.png',
        '/user/images/Literal %20/iig_%23.png',
        '/user/images/Aria/iig_what?x=1&y=2.png',
    ]) {
        const encoded = utils.encodeLocalMediaPath(raw);
        const parsed = new URL(encoded, 'https://example.test');
        assert.equal(parsed.search, '');
        assert.equal(parsed.hash, '');
        assert.equal(decodeURIComponent(parsed.pathname), raw);
        assert.equal(utils.normalizeStoredImagePath(encoded), encoded);
    }
    assert.equal(utils.encodeLocalMediaPath('/user/images/Nora Ashford #1/image 01.png'),
        '/user/images/Nora%20Ashford%20%231/image%2001.png');
    assert.equal(utils.encodeLocalMediaPath('user/images/Literal %20/iig_%23.png'),
        '/user/images/Literal%20%2520/iig_%2523.png');
    assert.throws(() => utils.encodeLocalMediaPath(undefined), /No path/);
});

test('stored URLs preserve query parameters, fragments and existing escapes', async () => {
    const { utils } = await loadExtension();
    for (const url of [
        '/thumbnail?type=avatar&file=Nora%20Ashford%20%231.png',
        'https://example.test/a%20b.png?signature=a%2Fb%3D#preview',
        '//example.test/a%20b.png?size=80',
        'data:image/png;base64,AA==',
    ]) assert.equal(utils.normalizeStoredImagePath(url), url);
});

test('image uploads return encoded URLs for prompt tags and references', async () => {
    const { utils, requests } = await loadExtension({
        respond: () => Response.json({ path: '/user/images/Nora #1 100%/iig_01.png' }),
    });
    const stored = await utils.saveImageToFile('data:image/png;base64,AA==');
    assert.equal(stored, '/user/images/Nora%20%231%20100%25/iig_01.png');
    assert.equal(utils.normalizeStoredImagePath(stored), stored);
    assert.equal(requests[0].url, '/api/images/upload');
});

test('gallery uses the server-sanitized folder and encodes raw filenames', async () => {
    const { utils, requests } = await loadExtension({
        respond: (url) => url === '/api/files/sanitize-filename'
            ? Response.json({ fileName: 'NoraAshford #1 %20' })
            : Response.json(['iig_image #1 %.png', 'unrelated.png']),
    });
    const paths = await utils.listCharacterGenerationPaths('Nora/Ashford?: #1 %20');
    assert.equal(JSON.parse(requests[0].body).fileName, 'Nora/Ashford?: #1 %20');
    assert.equal(JSON.parse(requests[1].body).folder, 'NoraAshford #1 %20');
    assert.deepEqual(Array.from(paths), ['/user/images/NoraAshford%20%231%20%2520/iig_image%20%231%20%25.png']);
});

test('gallery stops when the server cannot resolve its folder', async () => {
    const { utils, requests } = await loadExtension({ respond: () => new Response('Unavailable', { status: 503 }) });
    await assert.rejects(utils.listCharacterGenerationPaths('Nora'), /Unavailable/);
    assert.equal(requests.length, 1);
});

test('literal names, aliases, Unicode and word boundaries', async () => {
    const { parser } = await loadExtension();
    for (const [prompt, name, expected] of [
        ['LENORE, standing by a desk', 'Lenore', true],
        ['A portrait of Демьян.', 'Демьян', true],
        ['Aria draws', 'Lenore, Aria', true],
        ['Mary   Jane smiles', 'Mary Jane', true],
        ['Ｌｅｎｏｒｅ smiles', 'Lenore', true],
        ['Ariadne smiles', 'Aria', false],
        ['An unrelated scene', 'Lenore', false],
    ]) {
        assert.equal(Boolean(parser.findPrimaryKeyMatch(prompt, name, false)), expected, `${prompt} / ${name}`);
    }
});

test('enabled books, secondary conditions, regex, priority and always mode', async () => {
    const { settings, parser } = await loadExtension();
    settings.additionalReferencesMode = 'power';
    const ref = { name: 'Lenore', imagePath: '/ref.png' };
    setReferences(settings, [
        { ...ref, id: 'match', secondaryKeys: 'desk, candle' },
        { ...ref, id: 'disabled', name: 'desk', enabled: false },
        { ...ref, id: 'secondary-miss', name: 'candle', secondaryKeys: 'night' },
        { ...ref, id: 'regex', name: '/lenore/i', useRegex: true, priority: 10 },
        { ...ref, id: 'always', name: 'Background', matchMode: 'always' },
    ]);
    settings.lorebooks.push({ id: 'off', enabled: false, refs: [{ ...ref, id: 'off' }] });
    const matched = parser.getMatchedAdditionalReferences('Lenore at a desk with a candle');
    assert.deepEqual(Array.from(matched, (ref) => ref.id), ['regex', 'match', 'always']);
});

test('simple mode sends Daniel by alias despite stored power-mode conditions', async () => {
    const { settings, parser, providers, requests, references: referenceModule } = await loadExtension();
    setReferences(settings, [{
        id: 'daniel', name: 'Daniel Mercer, Daniel, Dan', imagePath: '/daniel.png',
        description: 'Dark blond hair', enabled: true, useRegex: true,
        secondaryKeys: 'night, outdoors', priority: 50,
    }, { id: 'off', name: 'Daniel', description: 'disabled description', enabled: false }]);
    settings.lorebooks[0].enabled = false;
    const prompt = 'Attractively well-built and handsome Daniel in a dark denim jacket, slouching back into the booth corner, looking away toward the noisy bar.';
    const matchedAdditionalRefs = parser.getMatchedAdditionalReferences(prompt);
    assert.equal(matchedAdditionalRefs.length, 1);
    assert.equal(matchedAdditionalRefs[0]._matchReason.detail, 'daniel');
    assert.match(referenceModule.renderIigBookMacro(settings), /Daniel Mercer/);
    const provider = new providers.NaisteraProvider();
    provider.modelCatalog.set('image-model', { references: true });
    const references = await provider.collectReferences({ matchedAdditionalRefs });
    await provider.generate({ prompt, references, options: { matchedAdditionalRefs, characterDescriptionPromptBlock: '' } });
    const body = JSON.parse(requests.find((request) => request.method === 'POST').body);
    assert.equal(body.reference_objects.length, 1);
    assert.match(body.prompt, /Dark blond hair/);
    assert.doesNotMatch(body.prompt, /disabled description/);
    settings.additionalReferencesMode = 'power';
    assert.equal(parser.getMatchedAdditionalReferences(prompt).length, 0);
    assert.equal(referenceModule.renderIigBookMacro(settings), '');
    settings.lorebooks[0].enabled = true;
    assert.equal(parser.getMatchedAdditionalReferences(prompt).length, 0);
    const ref = settings.lorebooks[0].refs[0];
    ref.useRegex = false;
    ref.secondaryKeys = '';
    assert.equal(parser.getMatchedAdditionalReferences(prompt).length, 1);
});

test('simple mode uses library order; power mode uses priority', async () => {
    const { settings, parser } = await loadExtension();
    setReferences(settings, [
        { id: 'first', name: 'Daniel', description: 'dark blond hair', priority: 0 },
        { id: 'second', name: 'Daniel', description: 'denim jacket', priority: 100 },
    ]);
    assert.deepEqual(Array.from(parser.getMatchedAdditionalReferences('Daniel'), (ref) => ref.id), ['first', 'second']);
    settings.additionalReferencesMode = 'power';
    assert.deepEqual(Array.from(parser.getMatchedAdditionalReferences('Daniel'), (ref) => ref.id), ['second', 'first']);
});

test('description-only references reach the final prompt', async () => {
    const { settings, parser } = await loadExtension();
    setReferences(settings, [
        { id: 'text', name: 'Lenore', description: 'silver ring' },
        { id: 'outfit', name: 'Lenore', description: 'linen shirt' },
        { id: 'duplicate', name: 'Lenore', description: 'silver ring' },
        { id: 'empty', name: 'Lenore' },
    ]);
    const matched = parser.getMatchedAdditionalReferences('Lenore at a desk');
    assert.deepEqual(Array.from(matched, (ref) => ref.id), ['text', 'outfit']);
    assert.match(parser.buildFinalGenerationPrompt('Lenore at a desk', '', matched, settings), /Lenore: silver ring/);
    settings.sendRefDescriptions = false;
    assert.equal(parser.buildFinalGenerationPrompt('Lenore at a desk', '', matched, settings), 'Lenore at a desk');
});

test('Naistera sends matching images and descriptions in the HTTP request', async () => {
    const { settings, parser, providers, requests } = await loadExtension();
    setReferences(settings, [{ name: 'Lenore', description: 'silver ring', imagePath: '/ref.png' }]);
    const provider = new providers.NaisteraProvider();
    provider.modelCatalog.set('image-model', { references: true });
    const matchedAdditionalRefs = parser.getMatchedAdditionalReferences('Lenore at a desk');
    const references = await provider.collectReferences({ matchedAdditionalRefs });
    await provider.generate({ prompt: 'Lenore at a desk', references, options: { matchedAdditionalRefs, characterDescriptionPromptBlock: '' } });
    const body = JSON.parse(requests.find((request) => request.method === 'POST').body);
    assert.equal(body.reference_objects.length, 1);
    assert.equal(body.reference_objects[0].image, 'data:image/png;base64,AA==');
    assert.match(body.prompt, /Lenore: silver ring/);
});

test('NovelAI includes matching descriptions without requesting reference images', async () => {
    const { settings, parser, providers, requests } = await loadExtension();
    settings.naisteraModel = 'novelai-v5';
    setReferences(settings, [{ name: 'Lenore', description: 'silver ring', imagePath: '/ref.png' }]);
    const provider = new providers.NaisteraProvider();
    provider.modelCatalog.set('novelai-v5', { references: false });
    const matchedAdditionalRefs = parser.getMatchedAdditionalReferences('Lenore at a desk');
    const references = await provider.collectReferences({ matchedAdditionalRefs });
    await provider.generate({ prompt: 'Lenore at a desk', references, options: { matchedAdditionalRefs, characterDescriptionPromptBlock: '' } });
    assert.equal(requests.length, 1);
    const body = JSON.parse(requests[0].body);
    assert.equal(body.reference_objects, undefined);
    assert.match(body.prompt, /Lenore: silver ring/);
});

test('OpenAI sends matching images as multipart attachments', async () => {
    const { settings, parser, providers, requests } = await loadExtension();
    Object.assign(settings, { apiType: 'openai', model: 'gpt-image-1' });
    setReferences(settings, [{ name: 'Lenore', description: 'silver ring', imagePath: '/ref.png' }]);
    const provider = new providers.OpenAIProvider();
    const matchedAdditionalRefs = parser.getMatchedAdditionalReferences('Lenore at a desk');
    const references = await provider.collectReferences({ matchedAdditionalRefs });
    await provider.generate({ prompt: 'Lenore at a desk', references, options: { matchedAdditionalRefs } });
    const request = requests.find((request) => request.method === 'POST');
    assert.match(request.url, /\/images\/edits$/);
    assert.equal(request.body.getAll('image').length, 1);
    assert.equal(request.body.get('image').size, 1);
    assert.match(request.body.get('prompt'), /Lenore: silver ring/);
});

test('a name absent from the prompt causes no reference fetch or attachment', async () => {
    const { settings, parser, providers, requests } = await loadExtension();
    setReferences(settings, [{ name: 'Lenore', description: 'silver ring', imagePath: '/ref.png' }]);
    const provider = new providers.NaisteraProvider();
    provider.modelCatalog.set('image-model', { references: true });
    const matchedAdditionalRefs = parser.getMatchedAdditionalReferences('An empty bedroom');
    const references = await provider.collectReferences({ matchedAdditionalRefs });
    await provider.generate({ prompt: 'An empty bedroom', references, options: { matchedAdditionalRefs, characterDescriptionPromptBlock: '' } });
    assert.equal(requests.length, 1);
    const body = JSON.parse(requests[0].body);
    assert.equal(body.reference_objects, undefined);
    assert.equal(body.prompt, 'An empty bedroom');
});
