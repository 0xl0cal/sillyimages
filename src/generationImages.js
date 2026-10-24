import { getSettings, saveSettings } from './settings.js';
import { getCharacterReferenceLibrary } from './references.js';
import { listCharacterGenerationPaths } from './utils.js';

const WORKERS = 3;

function imageIdentity(imagePath) {
    const raw = String(imagePath || '').trim();
    if (!raw) return null;
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return { identity: url.href, imagePath: raw, localPath: null };
    const decoded = decodeURIComponent(url.pathname);
    const segments = decoded.split('/');
    const isLocalImage = decoded.startsWith('/user/images/')
        && segments.slice(3).every(segment => segment && segment !== '.' && segment !== '..' && !/[\\\x00-\x1f]/.test(segment));
    if (!isLocalImage) return null;
    return { identity: decoded, imagePath: raw, localPath: decoded };
}

function safeIdentity(imagePath) {
    try {
        return imageIdentity(imagePath);
    } catch (_error) {
        return null;
    }
}

function referenceImages(settings) {
    const paths = new Set();
    const add = path => {
        const image = safeIdentity(path);
        if (image) paths.add(image.identity);
    };
    const library = getCharacterReferenceLibrary(settings);
    for (const bucket of [library.characters, library.users]) {
        for (const entry of Object.values(bucket)) {
            add(entry?.primary?.imagePath);
            for (const item of entry?.appearanceItems || []) add(item.imagePath);
        }
    }
    for (const book of settings.lorebooks || []) {
        for (const ref of book.refs || []) add(ref.imagePath);
    }
    return paths;
}

async function mapLimited(items, callback) {
    let cursor = 0;
    const results = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(WORKERS, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await callback(items[index]);
        }
    }));
    return results;
}

// A plan is a path snapshot: confirmation cannot expand to files generated later.
export async function planGenerationImageDeletion({ scope, key = '', folder = '', ids = [] }, settings = getSettings()) {
    if (!['selected', 'character', 'all'].includes(scope)) throw new Error('Invalid generation deletion scope');
    const protectedPaths = referenceImages(settings);
    const targets = new Map();
    const add = path => {
        const image = safeIdentity(path);
        if (image && !protectedPaths.has(image.identity)) targets.set(image.identity, image);
    };
    const library = getCharacterReferenceLibrary(settings);
    const entries = scope === 'all' ? Object.values(library.characters) : [library.characters[key]];
    const selectedIds = new Set(ids);
    for (const entry of entries) {
        for (const generation of entry?.generations || []) {
            if (scope !== 'selected' || selectedIds.has(generation.id)) add(generation.imagePath);
        }
    }
    if (scope === 'all') {
        const response = await fetch('/api/images/folders', {
            method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify({}),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const folders = await response.json();
        if (!Array.isArray(folders) || folders.some(name => typeof name !== 'string' || !name.trim())) {
            throw new Error('Invalid image folder list');
        }
        const paths = await mapLimited([...new Set(folders)], listCharacterGenerationPaths);
        paths.flat().forEach(add);
    } else if (scope === 'character' && folder) {
        (await listCharacterGenerationPaths(folder)).forEach(add);
    }
    return [...targets.values()];
}

export async function deleteGenerationImages(plan, settings = getSettings(), onProgress = () => {}) {
    const deleted = new Set();
    let completed = 0;
    const results = await mapLimited(plan, async image => {
        try {
            // A reference may have been assigned while confirmation was open.
            if (referenceImages(settings).has(image.identity)) return { skipped: image.imagePath };
            if (image.localPath) {
                const response = await fetch('/api/images/delete', {
                    method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(),
                    body: JSON.stringify({ path: image.localPath }),
                });
                if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
            }
            deleted.add(image.identity);
            return { deleted: image.imagePath };
        } catch (error) {
            return { failed: image.imagePath, error };
        } finally {
            onProgress(++completed, plan.length);
        }
    });
    const library = getCharacterReferenceLibrary(settings);
    let changed = false;
    for (const bucket of [library.characters, library.users]) {
        for (const entry of Object.values(bucket)) {
            if (!Array.isArray(entry?.generations)) continue;
            const remaining = entry.generations.filter(generation => !deleted.has(safeIdentity(generation.imagePath)?.identity));
            if (remaining.length === entry.generations.length) continue;
            entry.generations = remaining;
            changed = true;
        }
    }
    if (changed) saveSettings();
    return {
        deleted: deleted.size,
        failed: results.filter(result => result.failed),
        skipped: results.filter(result => result.skipped).length,
    };
}
