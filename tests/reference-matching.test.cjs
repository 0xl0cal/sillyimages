const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Run the extension modules with an in-memory Tavern context and HTTP transport.
async function loadExtension() {
    const requests = [];
    const referenceStatus = { textContent: '' };
    const tavern = { extensionSettings: {}, saveSettingsDebounced() {} };
    const context = vm.createContext({
        console, URL, Blob, FormData, AbortController, setTimeout, clearTimeout,
        structuredClone, atob, btoa,
        SillyTavern: { getContext: () => tavern },
        document: { getElementById: (id) => id === 'iig_additional_refs_status' ? referenceStatus : null },
        fetch: async (url, init = {}) => {
            requests.push({ url, ...init });
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
        referenceStatus,
    };
}

function setReferences(settings, refs) {
    settings.lorebooks = [{ id: 'book', name: 'Book', enabled: true, refs }];
}

test('Daniel aliases from the reference editor match the pictured scene', async () => {
    const { settings, parser } = await loadExtension();
    setReferences(settings, [{
        name: 'Daniel Mercer, Daniel, Dan', description: 'Dark blond hair', imagePath: '/daniel.png',
    }]);
    const prompt = 'Attractively well-built and handsome Daniel in a dark denim jacket, slouching back into the booth corner, looking away toward the noisy bar.';
    const matches = parser.getMatchedAdditionalReferences(prompt);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]._matchReason.detail, 'daniel');
});

test('Daniel exclusions identify disabled books and hidden matching conditions', async () => {
    const { settings, parser } = await loadExtension();
    const ref = { name: 'Daniel Mercer, Daniel, Dan', imagePath: '/daniel.png', enabled: true };
    const prompt = 'Attractively well-built and handsome Daniel in a dark denim jacket';
    for (const [bookEnabled, fields, reason] of [
        [false, {}, 'book-disabled'],
        [true, { enabled: false }, 'reference-disabled'],
        [true, { useRegex: true }, 'regex-miss'],
        [true, { secondaryKeys: 'night' }, 'secondary-miss'],
        [true, { name: 'Nora' }, 'name-miss'],
        [true, { name: '' }, 'missing-name'],
        [true, { imagePath: '' }, 'empty-reference'],
    ]) {
        setReferences(settings, [{ ...ref, ...fields }]);
        settings.lorebooks[0].enabled = bookEnabled;
        const excluded = [];
        assert.equal(parser.getMatchedAdditionalReferences(prompt, { excluded }).length, 0);
        assert.equal(excluded.length, 1);
        assert.equal(excluded[0].reason.kind, reason);
        assert.equal(excluded[0].lorebookName, 'Book');
    }
});

test('active reference count follows the lorebook toggle', async () => {
    const { settings, references, referenceStatus, settingsModule } = await loadExtension();
    setReferences(settings, [{ name: 'Daniel', imagePath: '/daniel.png', enabled: true }]);
    settingsModule.setLorebookEnabled('book', false, settings);
    references.renderAdditionalReferencesStatus(5);
    assert.match(referenceStatus.textContent, /Lorebook is disabled/);
    assert.match(referenceStatus.textContent, /0\/1/);
    settingsModule.setLorebookEnabled('book', true, settings);
    references.renderAdditionalReferencesStatus(5);
    assert.doesNotMatch(referenceStatus.textContent, /Lorebook is disabled/);
    assert.match(referenceStatus.textContent, /1\/1/);
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
