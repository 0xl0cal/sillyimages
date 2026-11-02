/** Character/persona reference libraries, context images and additional-reference views. */

import {
    getSettings,
    saveSettings,
    getActiveLorebookReferences,
    getMatchingLorebooks,
    ensureLorebooks,
    normalizeImageContextCount,
    normalizeGroupName,
    MAX_ADDITIONAL_REFERENCES,
} from './settings.js';
import {
    imageUrlToBase64,
    imageUrlToDataUrl,
    normalizeStoredImagePath,
    sanitizeForHtml,
} from './utils.js';
import {
    extractGeneratedImageUrlsFromText,
    getMessageRenderText,
    filterPromptReferences,
} from './parser.js';
import { t } from './i18n.js';
import { normalizeReferenceUrlList, getReferenceNameFromUrl, downloadReferenceImageFromUrl } from './referenceTransfer.js';
export {
    normalizeReferenceUrlList, getReferenceNameFromUrl, downloadReferenceImageFromUrl, buildLorebookExportJson,
    lorebookFileNameFromTitle, parseLorebookJson, importLorebookFromPayload, importLorebookFromUrl,
    importLorebookFromFile, triggerBrowserDownload,
} from './referenceTransfer.js';

// ----- Module state -----

const PERSONAS_MODULE_PATHS = Object.freeze([
    '/scripts/personas.js',
    '../../../personas.js',
]);

let personasModulePromise = null;
const temporaryPrimaryReferenceIds = new Map();
const MAX_CHARACTER_GENERATIONS = 48;
const normalizedEntries = new WeakSet();

function makeCharacterLibraryItemId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCharacterAppearanceItem(raw) {
    const type = raw?.type === 'image' ? 'image' : 'text';
    return {
        id: String(raw?.id || '').trim() || makeCharacterLibraryItemId('appearance'),
        type,
        enabled: raw?.enabled !== false,
        imagePath: type === 'image' ? normalizeStoredImagePath(raw?.imagePath) : '',
        description: String(raw?.description || '').trim(),
    };
}

function normalizeCharacterGeneration(raw) {
    const imagePath = normalizeStoredImagePath(raw?.imagePath);
    if (!imagePath) return null;
    return {
        id: String(raw?.id || '').trim() || makeCharacterLibraryItemId('generation'),
        imagePath,
        prompt: String(raw?.prompt || '').trim(),
        createdAt: Number.isFinite(Number(raw?.createdAt)) ? Number(raw.createdAt) : Date.now(),
    };
}

function normalizeCharacterLibraryEntry(raw) {
    return {
        displayName: String(raw?.displayName || '').trim(),
        primary: {
            enabled: raw?.primary?.enabled !== false,
            imagePath: normalizeStoredImagePath(raw?.primary?.imagePath),
            description: String(raw?.primary?.description || '').trim(),
        },
        appearanceItems: (Array.isArray(raw?.appearanceItems) ? raw.appearanceItems : []).map(normalizeCharacterAppearanceItem),
        generations: (Array.isArray(raw?.generations) ? raw.generations : [])
            .map(normalizeCharacterGeneration)
            .filter(Boolean)
            .slice(0, MAX_CHARACTER_GENERATIONS),
    };
}

function getTemporaryPrimaryKey(kind, key) {
    return `${kind === 'user' ? 'user' : 'char'}:${String(key || '').trim()}`;
}

function ensureCharacterReferenceLibrary(settings = getSettings()) {
    if (!settings.characterReferenceLibrary || typeof settings.characterReferenceLibrary !== 'object') {
        settings.characterReferenceLibrary = { characters: {}, users: {} };
    }
    for (const bucketName of ['characters', 'users']) {
        const bucket = settings.characterReferenceLibrary[bucketName];
        settings.characterReferenceLibrary[bucketName] = bucket && typeof bucket === 'object' ? bucket : {};
    }
    return settings.characterReferenceLibrary;
}

function normalizeReferenceDescription(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

export function getCharacterReferenceLibrary(settings = getSettings()) {
    return ensureCharacterReferenceLibrary(settings);
}

export function getCharacterReferenceKeyForCharacter(character, fallbackIndex = 0) {
    const avatar = String(character?.avatar || '').trim();
    if (avatar) return `avatar:${avatar}`;
    const name = String(character?.name || '').trim();
    if (name) return `name:${name}`;
    return `id:${fallbackIndex}`;
}

export function getUserReferenceKeyForAvatar(avatarFile) {
    const value = String(avatarFile || '').trim();
    return value ? `avatar:${value}` : 'no-user-avatar';
}

export function characterAvatarUrl(character) {
    const avatar = String(character?.avatar || '').trim();
    return avatar ? `/characters/${encodeURIComponent(avatar)}` : '';
}

export function userAvatarUrl(avatarFile) {
    const value = String(avatarFile || '').trim();
    return value ? `/User Avatars/${encodeURIComponent(value)}` : '';
}

export function makeReferenceObject(image, description = '', source = '') {
    return {
        image,
        description: normalizeReferenceDescription(description),
        source: String(source || '').trim(),
    };
}

export function getReferenceImage(ref) {
    if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
        return String(ref.image || '').trim();
    }
    return String(ref || '').trim();
}

export function getReferenceDescription(ref) {
    if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
        return normalizeReferenceDescription(ref.description);
    }
    return '';
}

export function getReferenceSource(ref) {
    if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
        return String(ref.source || '').trim();
    }
    return '';
}

export function buildAvatarReferencePromptBlock(references = [], settings = getSettings()) {
    if (settings.sendRefDescriptions === false) return '';
    const lines = references.map((ref, index) => {
        const source = getReferenceSource(ref);
        const description = getReferenceDescription(ref);
        if (!['char', 'user'].includes(source) || !description) return '';
        const label = source === 'char' ? '{{char}} avatar' : '{{user}} avatar';
        return `- Reference ${index + 1} (${label}): ${description}`;
    }).filter(Boolean);
    return lines.length ? `Character reference descriptions:\n${lines.join('\n')}` : '';
}

export function getCurrentCharacterReferenceKey() {
    try {
        const context = SillyTavern.getContext();
        const characterId = context?.characterId;
        if (characterId === undefined || characterId === null || Number(characterId) < 0) {
            return 'no-character';
        }
        return getCharacterReferenceKeyForCharacter(context?.characters?.[characterId] || {}, characterId);
    } catch (_error) {
        return 'no-character';
    }
}

export async function getCurrentUserReferenceKey(settings = getSettings()) {
    if (settings.useActiveUserPersonaAvatar) {
        try {
            const personasModule = await loadPersonasModule();
            const activeAvatarId = String(personasModule?.user_avatar || '').trim();
            if (activeAvatarId) return getUserReferenceKeyForAvatar(activeAvatarId);
        } catch (_error) {
            // Fall back to selected avatar below.
        }
    }
    const avatarFile = String(settings.userAvatarFile || '').trim();
    return getUserReferenceKeyForAvatar(avatarFile);
}

export function getCharacterLibraryEntry(kind, key, settings = getSettings(), { create = true } = {}) {
    const library = ensureCharacterReferenceLibrary(settings);
    const bucket = kind === 'user' ? library.users : library.characters;
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return null;
    if (!bucket[normalizedKey] && create) {
        bucket[normalizedKey] = {};
    }
    if (!bucket[normalizedKey]) return null;
    if (!normalizedEntries.has(bucket[normalizedKey])) {
        bucket[normalizedKey] = normalizeCharacterLibraryEntry(bucket[normalizedKey]);
        normalizedEntries.add(bucket[normalizedKey]);
    }
    return bucket[normalizedKey];
}

export function deleteCharacterLibraryEntry(kind, key, settings = getSettings()) {
    const library = ensureCharacterReferenceLibrary(settings);
    const bucket = kind === 'user' ? library.users : library.characters;
    delete bucket[String(key || '').trim()];
    temporaryPrimaryReferenceIds.delete(getTemporaryPrimaryKey(kind, key));
    saveSettings();
}

export function addCharacterLibraryAppearanceItem(kind, key, type, settings = getSettings()) {
    const entry = getCharacterLibraryEntry(kind, key, settings);
    const item = normalizeCharacterAppearanceItem({ type });
    entry.appearanceItems.push(item);
    saveSettings();
    return item;
}

export function removeCharacterLibraryAppearanceItem(kind, key, itemId, settings = getSettings()) {
    const entry = getCharacterLibraryEntry(kind, key, settings, { create: false });
    const normalizedId = String(itemId || '').trim();
    if (!entry || !normalizedId) return false;
    const nextItems = entry.appearanceItems.filter((item) => item.id !== normalizedId);
    if (nextItems.length === entry.appearanceItems.length) return false;
    entry.appearanceItems = nextItems;
    if (temporaryPrimaryReferenceIds.get(getTemporaryPrimaryKey(kind, key)) === normalizedId) {
        temporaryPrimaryReferenceIds.delete(getTemporaryPrimaryKey(kind, key));
    }
    saveSettings();
    return true;
}

function getCharacterAppearanceTextDescription(entry) {
    return (entry?.appearanceItems || [])
        .filter((item) => item.type === 'text' && item.enabled !== false)
        .map((item) => item.description)
        .map(normalizeReferenceDescription)
        .filter(Boolean)
        .join(' ');
}

export function getTemporaryCharacterPrimary(kind, key, settings = getSettings()) {
    const itemId = temporaryPrimaryReferenceIds.get(getTemporaryPrimaryKey(kind, key));
    if (!itemId) return null;
    const entry = getCharacterLibraryEntry(kind, key, settings, { create: false });
    const item = entry?.appearanceItems.find((candidate) => (
        candidate.id === itemId
        && candidate.type === 'image'
        && candidate.enabled !== false
        && normalizeStoredImagePath(candidate.imagePath)
    ));
    if (item) return item;
    temporaryPrimaryReferenceIds.delete(getTemporaryPrimaryKey(kind, key));
    return null;
}

export function setTemporaryCharacterPrimary(kind, key, itemId, settings = getSettings()) {
    const mapKey = getTemporaryPrimaryKey(kind, key);
    const current = temporaryPrimaryReferenceIds.get(mapKey);
    if (!itemId || current === itemId) {
        temporaryPrimaryReferenceIds.delete(mapKey);
        return null;
    }
    const entry = getCharacterLibraryEntry(kind, key, settings, { create: false });
    const item = entry?.appearanceItems.find((candidate) => (
        candidate.id === itemId
        && candidate.type === 'image'
        && candidate.enabled !== false
        && normalizeStoredImagePath(candidate.imagePath)
    ));
    if (!item) return null;
    temporaryPrimaryReferenceIds.set(mapKey, item.id);
    return item;
}

export function recordCharacterGeneration(imagePath, prompt = '', settings = getSettings(), key = getCurrentCharacterReferenceKey()) {
    const normalizedPath = normalizeStoredImagePath(imagePath);
    if (!normalizedPath || key === 'no-character') return null;
    const entry = getCharacterLibraryEntry('char', key, settings);
    const generation = {
        id: makeCharacterLibraryItemId('generation'),
        imagePath: normalizedPath,
        prompt: String(prompt || '').trim(),
        createdAt: Date.now(),
    };
    entry.generations = [
        generation,
        ...entry.generations.filter((item) => item.imagePath !== normalizedPath),
    ].slice(0, MAX_CHARACTER_GENERATIONS);
    saveSettings();
    return generation;
}

export function syncCharacterGenerationHistory(key, imagePaths, settings = getSettings()) {
    const entry = getCharacterLibraryEntry('char', key, settings, { create: false });
    if (!entry) return [];
    const existingByPath = new Map(entry.generations.map((generation) => [generation.imagePath, generation]));
    const seen = new Set();
    entry.generations = (Array.isArray(imagePaths) ? imagePaths : [])
        .map(normalizeStoredImagePath)
        .filter((imagePath) => imagePath && !seen.has(imagePath) && seen.add(imagePath))
        .map((imagePath, index) => existingByPath.get(imagePath) || {
            id: makeCharacterLibraryItemId('generation'),
            imagePath,
            prompt: '',
            createdAt: Date.now() - index,
        })
        .slice(0, MAX_CHARACTER_GENERATIONS);
    saveSettings();
    return entry.generations;
}

export function getCharacterLibraryDescription(kind, key, settings = getSettings()) {
    const entry = getCharacterLibraryEntry(kind, key, settings, { create: false });
    if (!entry) return '';
    return [
        entry.primary.enabled !== false ? entry.primary.description : '',
        getCharacterAppearanceTextDescription(entry),
    ].map(normalizeReferenceDescription).filter(Boolean).join(' ');
}

export async function buildCharacterDescriptionPromptBlock({
    includeChar = false,
    includeUser = false,
    references = [],
    mode = 'as-is',
    referenceContext = null,
} = {}, settings = getSettings()) {
    if (settings.sendRefDescriptions === false || mode === 'none') return '';

    const sentSources = new Set((Array.isArray(references) ? references : [])
        .map(getReferenceSource)
        .filter(Boolean));
    const includeSentSources = mode === 'character-prompt';
    let charDescription = '';
    let userDescription = '';

    if (includeChar && (includeSentSources || !sentSources.has('char'))) {
        const key = referenceContext?.charKey || getCurrentCharacterReferenceKey();
        charDescription = getCharacterLibraryDescription('char', key, settings);
    }

    if (includeUser && (includeSentSources || !sentSources.has('user'))) {
        const key = referenceContext?.userKey || await getCurrentUserReferenceKey(settings);
        userDescription = getCharacterLibraryDescription('user', key, settings);
    }

    if (mode === 'character-prompt') {
        const lines = [userDescription, charDescription]
            .filter(Boolean)
            .map((description) => `\\| ${description}`);
        return lines.join('\n');
    }

    const lines = [];
    if (charDescription) lines.push(`- {{char}}: ${charDescription}`);
    if (userDescription) lines.push(`- {{user}}: ${userDescription}`);
    return lines.length > 0
        ? `Character descriptions:\n${lines.join('\n')}`
        : '';
}

// ----- Загрузка модуля personas (для активного user persona avatar) -----

export async function loadPersonasModule() {
    if (!personasModulePromise) {
        personasModulePromise = (async () => {
            let lastError = null;
            for (const modulePath of PERSONAS_MODULE_PATHS) {
                try {
                    return await import(modulePath);
                } catch (error) {
                    lastError = error;
                }
            }
            throw lastError || new Error('Unable to import personas.js');
        })();
    }
    return await personasModulePromise;
}

export {
    fetchUserAvatars, getCachedUserAvatars, getUserAvatarDropdownConfigs,
    buildUserAvatarSelectedHtml, closeUserAvatarDropdowns, renderUserAvatarDropdownList,
    getActivePersonaAvatarCheckboxes, syncActivePersonaAvatarMode, syncUserAvatarSelection,
    refreshUserAvatarSelects, buildUserAvatarDropdownControl,
} from './avatarPicker.js';

// ----- User avatar URL resolver (persona + selected file) -----

export async function getSelectedUserAvatarUrl(settings = getSettings()) {

    if (settings.useActiveUserPersonaAvatar) {
        try {
            const personasModule = await loadPersonasModule();
            const activeAvatarId = String(personasModule?.user_avatar || '').trim();
            if (!activeAvatarId) {
                console.log('[IIG] No active user persona avatar selected');
                if (!settings.userAvatarFile) {
                    return null;
                }
            } else {
                if (typeof personasModule?.getUserAvatar === 'function') {
                    const resolved = String(personasModule.getUserAvatar(activeAvatarId) || '').trim();
                    if (resolved) {
                        const normalized = resolved.replace(/^\/+/, '');
                        console.log('[IIG] Using active user persona avatar:', normalized);
                        return `/${normalized}`;
                    }
                }

                const fallback = `/User Avatars/${encodeURIComponent(activeAvatarId)}`;
                console.log('[IIG] Falling back to active user persona avatar path:', fallback);
                return fallback;
            }
        } catch (error) {
            console.error('[IIG] Failed to resolve active user persona avatar:', error);
            if (!settings.userAvatarFile) {
                return null;
            }
        }
    }

    if (!settings.userAvatarFile) {
        console.log('[IIG] No user avatar selected in settings');
        return null;
    }

    const avatarUrl = `/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`;
    console.log('[IIG] Using selected user avatar:', avatarUrl);
    return avatarUrl;
}

async function getCurrentCharacterAvatarUrl() {
    try {
        const context = SillyTavern.getContext();
        const characterId = context?.characterId;
        if (characterId === undefined || characterId === null || Number(characterId) < 0) return '';
        if (typeof context.getCharacterAvatar === 'function') {
            const resolved = String(context.getCharacterAvatar(characterId) || '').trim();
            if (resolved) return resolved;
        }
        return characterAvatarUrl(context.characters?.[characterId]);
    } catch (_error) {
        return '';
    }
}

export async function captureReferenceContext(settings, messageId) {
    const charKey = getCurrentCharacterReferenceKey();
    const charAvatar = getCurrentCharacterAvatarUrl();
    const contextUrls = settings.imageContextEnabled
        ? getPreviousGeneratedImageUrls(messageId, settings.imageContextCount, settings) : [];
    const [charAvatarUrl, userKey, userAvatarUrl] = await Promise.all([
        charAvatar, getCurrentUserReferenceKey(settings), getSelectedUserAvatarUrl(settings),
    ]);
    return {
        charKey, charAvatarUrl, userKey, userAvatarUrl, contextUrls,
        temporaryPrimary: {
            char: getTemporaryCharacterPrimary('char', charKey, settings),
            user: getTemporaryCharacterPrimary('user', userKey, settings),
        },
    };
}

export async function* iterateCharacterLibraryReferences(kind, format, settings = getSettings(), referenceContext = null, requestOptions = {}) {
    const isUser = kind === 'user';
    const key = referenceContext
        ? referenceContext[isUser ? 'userKey' : 'charKey']
        : isUser ? await getCurrentUserReferenceKey(settings) : getCurrentCharacterReferenceKey();
    const entry = getCharacterLibraryEntry(kind, key, settings, { create: false });
    const convert = format === 'dataUrl' ? imageUrlToDataUrl : imageUrlToBase64;
    const baseAvatarUrl = referenceContext
        ? referenceContext[isUser ? 'userAvatarUrl' : 'charAvatarUrl']
        : isUser ? await getSelectedUserAvatarUrl(settings) : await getCurrentCharacterAvatarUrl();
    const source = isUser ? 'user' : 'char';
    let hasReference = false;
    const sharedDescription = getCharacterLibraryDescription(kind, key, settings);
    const appearanceDescription = getCharacterAppearanceTextDescription(entry);
    const temporaryPrimary = referenceContext
        ? referenceContext.temporaryPrimary[kind] : getTemporaryCharacterPrimary(kind, key, settings);

    if (temporaryPrimary) {
        const image = await convert(normalizeStoredImagePath(temporaryPrimary.imagePath), requestOptions);
        if (image) {
            yield makeReferenceObject(
                image,
                `${appearanceDescription} ${temporaryPrimary.description}`.trim(),
                source,
            );
            hasReference = true;
        }
    }

    const primary = entry?.primary || { enabled: true, imagePath: '', description: '' };
    if (primary.enabled !== false) {
        const primaryPath = normalizeStoredImagePath(primary.imagePath) || baseAvatarUrl;
        if (primaryPath) {
            const image = await convert(primaryPath, requestOptions);
            if (image) {
                yield makeReferenceObject(
                    image,
                    temporaryPrimary ? primary.description : sharedDescription,
                    source,
                );
                hasReference = true;
            }
        }
    }

    for (const item of entry?.appearanceItems || []) {
        if (item.type !== 'image' || item.enabled === false) continue;
        if (item.id === temporaryPrimary?.id) continue;
        const imagePath = normalizeStoredImagePath(item.imagePath);
        if (!imagePath) continue;
        const image = await convert(imagePath, requestOptions);
        if (image) {
            const description = !hasReference && sharedDescription
                ? `${sharedDescription} ${item.description}`.trim()
                : item.description;
            yield makeReferenceObject(image, description, source);
            hasReference = true;
        }
    }

}

// ----- Previous-message context images -----

export function getPreviousGeneratedImageUrls(messageId, requestedCount, settings = getSettings()) {
    const count = normalizeImageContextCount(requestedCount);
    if (!Number.isInteger(messageId) || messageId <= 0) {
        return [];
    }

    const context = SillyTavern.getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const urls = [];
    const seen = new Set();

    for (let idx = messageId - 1; idx >= 0 && urls.length < count; idx--) {
        const message = chat[idx];
        if (!message || message.is_user || message.is_system) {
            continue;
        }

        const text = getMessageRenderText(message, settings);
        const messageUrls = extractGeneratedImageUrlsFromText(text);
        for (const url of messageUrls) {
            if (seen.has(url)) {
                continue;
            }
            seen.add(url);
            urls.push(url);
            if (urls.length >= count) {
                break;
            }
        }
    }

    return urls;
}

export async function collectPreviousContextReferences(messageId, format, requestedCount, referenceContext = null, requestOptions = {}) {
    const urls = referenceContext
        ? referenceContext.contextUrls.slice(0, requestedCount)
        : getPreviousGeneratedImageUrls(messageId, requestedCount);
    if (urls.length === 0) {
        return [];
    }

    const convert = format === 'dataUrl' ? imageUrlToDataUrl : imageUrlToBase64;
    const converted = await Promise.all(urls.map((url) => convert(url, requestOptions)));
    return converted.filter(Boolean);
}

// ----- Additional references -----

let additionalReferencesSupportImages = true;

export function buildAdditionalReferenceRowsHtml(settings = getSettings(), viewState = {}) {
    const refs = getActiveLorebookReferences(settings);
    const isPowerMode = settings.additionalReferencesMode === 'power';
    const selectedId = String(viewState.selectedId || '');
    const selectedIndex = Math.max(0, refs.findIndex((ref) => ref.id === selectedId));
    const selectedRef = refs[selectedIndex] || null;
    const query = String(viewState.query || '');
    const filter = ['enabled', 'match', 'always'].includes(viewState.filter) ? viewState.filter : 'all';
    const supportsImages = viewState.supportsImageReferences ?? additionalReferencesSupportImages;
    const listRowsHtml = refs.map((ref, index) => {
        const previewSrc = normalizeStoredImagePath(ref.imagePath);
        const isAlways = ref.matchMode === 'always';
        const isEnabled = ref.enabled !== false;
        const previewHtml = previewSrc
            ? `<img src="${sanitizeForHtml(previewSrc)}" alt="${sanitizeForHtml(ref.name || `ref-${index + 1}`)}" class="iig-additional-ref-list-thumb">`
            : `<div class="iig-additional-ref-list-thumb iig-additional-ref-thumb-placeholder"><i class="fa-solid fa-align-left"></i></div>`;
        const title = String(ref.name || '').trim() || t`Untitled reference`;
        const description = String(ref.description || '').replace(/\s+/g, ' ').trim() || t`No description`;
        const searchText = `${ref.name || ''} ${ref.description || ''} ${ref.group || ''}`.toLowerCase();
        return `
            <div
                class="iig-additional-ref-list-row ${ref.id === selectedRef?.id ? 'selected' : ''} ${isEnabled ? '' : 'disabled'}"
                data-ref-index="${index}"
                data-ref-id="${sanitizeForHtml(ref.id)}"
                data-ref-search="${sanitizeForHtml(searchText)}"
                data-ref-enabled="${isEnabled ? 'true' : 'false'}"
                data-ref-match-mode="${isAlways ? 'always' : 'match'}"
            >
                <label class="checkbox_label iig-additional-ref-list-enabled" title="${isEnabled ? t`Disable reference` : t`Enable reference`}">
                    <input type="checkbox" class="iig-additional-ref-enabled" ${isEnabled ? 'checked' : ''}>
                    <span></span>
                </label>
                <button type="button" class="menu_button iig-additional-ref-select" data-ref-select="${sanitizeForHtml(ref.id)}">
                    ${previewHtml}
                    <span class="iig-additional-ref-list-copy">
                        <strong>${sanitizeForHtml(title)}</strong>
                        <small>${sanitizeForHtml(description)}</small>
                    </span>
                    <span class="iig-additional-ref-list-badges">
                        <span class="iig-reference-badge">${isAlways ? t`Always` : t`Match`}</span>
                        ${isPowerMode && ref.useRegex === true ? `<span class="iig-reference-badge">${t`Regex`}</span>` : ''}
                        ${isPowerMode && ref.group ? `<span class="iig-reference-badge">${sanitizeForHtml(ref.group)}</span>` : ''}
                    </span>
                </button>
            </div>`;
    }).join('');

    const selectedPreviewSrc = normalizeStoredImagePath(selectedRef?.imagePath);
    const selectedPreviewHtml = selectedPreviewSrc
        ? `<img src="${sanitizeForHtml(selectedPreviewSrc)}" alt="${sanitizeForHtml(selectedRef?.name || t`Reference`)}" class="iig-additional-ref-editor-thumb">`
        : `<div class="iig-additional-ref-editor-thumb iig-additional-ref-thumb-placeholder"><i class="fa-solid fa-align-left"></i></div>`;
    const editorHtml = selectedRef ? `
        <div class="iig-additional-ref-editor-content" data-ref-index="${selectedIndex}" data-ref-id="${sanitizeForHtml(selectedRef.id)}">
            <div class="iig-additional-ref-editor-heading">
                <div>
                    <strong>${sanitizeForHtml(String(selectedRef.name || '').trim() || t`Untitled reference`)}</strong>
                    <small>${isPowerMode ? t`Advanced editor` : t`Reference editor`}</small>
                </div>
                <label class="checkbox_label" title="${selectedRef.enabled !== false ? t`Disable reference` : t`Enable reference`}">
                    <input type="checkbox" class="iig-additional-ref-enabled" ${selectedRef.enabled !== false ? 'checked' : ''}>
                    <span></span>
                </label>
            </div>

            <div class="iig-additional-ref-editor-main">
                <div class="iig-additional-ref-editor-image">
                    ${selectedPreviewHtml}
                    <fieldset class="iig-additional-ref-image-actions" ${supportsImages ? '' : 'disabled'}>
                        <label class="menu_button iig-additional-ref-upload" title="${t`Upload image`}">
                            <i class="fa-solid fa-upload"></i>
                            <input type="file" accept="image/*" class="iig-additional-ref-file" style="display:none">
                        </label>
                        <button type="button" class="menu_button iig-additional-ref-upload-url" title="${t`Upload image by URL`}">
                            <i class="fa-solid fa-link"></i>
                        </button>
                    </fieldset>
                </div>
                <div class="iig-additional-ref-editor-fields">
                    <label>
                        <span>${t`Name`}</span>
                        <input type="text" class="text_pole iig-additional-ref-name" placeholder="${t`Reference name`}"
                            value="${sanitizeForHtml(selectedRef.name || '')}">
                    </label>
                    <label>
                        <span>${t`Description`}</span>
                        <textarea class="text_pole iig-additional-ref-description" rows="3" placeholder="${t`Reference description`}">${sanitizeForHtml(selectedRef.description || '')}</textarea>
                    </label>
                    <label>
                        <span>${t`Send`}</span>
                        <select class="iig-additional-ref-match-mode">
                            <option value="match" ${selectedRef.matchMode !== 'always' ? 'selected' : ''}>${t`On match`}</option>
                            <option value="always" ${selectedRef.matchMode === 'always' ? 'selected' : ''}>${t`Always`}</option>
                        </select>
                    </label>
                </div>
            </div>

            ${isPowerMode ? `
                <details class="iig-additional-ref-editor-section">
                    <summary><i class="fa-solid fa-code-branch"></i><span>${t`Matching rules`}</span></summary>
                    <div class="iig-additional-ref-editor-section-body">
                        <label class="checkbox_label" title="${t`Interpret the reference name as a JavaScript regular expression`}">
                            <input type="checkbox" class="iig-additional-ref-regex" ${selectedRef.useRegex === true ? 'checked' : ''}>
                            <span>${t`Use regex`}</span>
                        </label>
                        <label>
                            <span>${t`Secondary keys`}</span>
                            <input type="text" class="text_pole iig-additional-ref-secondary" placeholder="${t`AND conditions, comma-separated`}"
                                value="${sanitizeForHtml(selectedRef.secondaryKeys || '')}">
                        </label>
                    </div>
                </details>
                <details class="iig-additional-ref-editor-section">
                    <summary><i class="fa-solid fa-layer-group"></i><span>${t`Organization`}</span></summary>
                    <div class="iig-additional-ref-editor-section-body iig-additional-ref-organization-grid">
                        <label>
                            <span>${t`Group`}</span>
                            <input type="text" class="text_pole iig-additional-ref-group" placeholder="${t`Characters, locations, items`}"
                                value="${sanitizeForHtml(selectedRef.group || '')}">
                        </label>
                        <label>
                            <span>${t`Priority`}</span>
                            <input type="number" class="text_pole iig-additional-ref-priority" step="1"
                                value="${Number.isFinite(selectedRef.priority) ? selectedRef.priority : 0}"
                                title="${t`Higher priority is matched first when provider limits references`}">
                        </label>
                    </div>
                </details>` : ''}

            <div class="iig-additional-ref-editor-actions">
                ${isPowerMode ? `
                    <button type="button" class="menu_button iig-additional-ref-move-up ${selectedIndex === 0 ? 'disabled' : ''}" title="${t`Move up`}" ${selectedIndex === 0 ? 'aria-disabled="true"' : ''}>
                        <i class="fa-solid fa-arrow-up"></i><span>${t`Up`}</span>
                    </button>
                    <button type="button" class="menu_button iig-additional-ref-move-down ${selectedIndex === refs.length - 1 ? 'disabled' : ''}" title="${t`Move down`}" ${selectedIndex === refs.length - 1 ? 'aria-disabled="true"' : ''}>
                        <i class="fa-solid fa-arrow-down"></i><span>${t`Down`}</span>
                    </button>` : ''}
                <button type="button" class="menu_button redWarningBG iig-additional-ref-remove">
                    <i class="fa-solid fa-trash"></i><span>${t`Delete`}</span>
                </button>
            </div>
        </div>` : `<div class="iig-library-empty iig-additional-ref-editor-empty">${t`Add a reference to start editing.`}</div>`;

    return `
        <div class="iig-additional-ref-workspace ${isPowerMode ? 'power' : 'simple'}">
            <div class="iig-additional-ref-browser">
                <div class="iig-additional-ref-tools">
                    <label class="iig-additional-ref-search">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input id="iig_additional_refs_search" class="text_pole" type="search" value="${sanitizeForHtml(query)}" placeholder="${t`Search references`}">
                    </label>
                    <select id="iig_additional_refs_filter" title="${t`Filter references`}">
                        <option value="all" ${filter === 'all' ? 'selected' : ''}>${t`All`}</option>
                        <option value="enabled" ${filter === 'enabled' ? 'selected' : ''}>${t`Enabled`}</option>
                        <option value="match" ${filter === 'match' ? 'selected' : ''}>${t`On match`}</option>
                        <option value="always" ${filter === 'always' ? 'selected' : ''}>${t`Always`}</option>
                    </select>
                </div>
                <div class="iig-additional-ref-compact-list">
                    ${listRowsHtml || `<div class="iig-library-empty">${t`Add a reference with an image, name, and description.`}</div>`}
                </div>
                <div id="iig_additional_refs_no_results" class="iig-library-empty iig-hidden">${t`No references match the current search.`}</div>
            </div>
            <div class="iig-additional-ref-editor">
                ${editorHtml}
            </div>
        </div>`;
}

// Model capabilities affect image controls, not the reference's text or saved switch.
export function syncAdditionalReferenceAvailability(supportsImages) {
    additionalReferencesSupportImages = supportsImages;
    const container = document.getElementById('iig_additional_refs_list');
    if (!container) return;
    for (const image of container.querySelectorAll('img.iig-additional-ref-list-thumb, img.iig-additional-ref-editor-thumb')) {
        image.classList.toggle('iig-reference-image-unavailable', !supportsImages);
        image.title = supportsImages ? '' : t`This model uses text-only references.`;
    }
    const imageActions = container.querySelector('.iig-additional-ref-image-actions');
    if (imageActions) imageActions.disabled = !supportsImages;
}

/**
 * Обновляет только статус-строку под списком, без ре-рендера карточек.
 * Нужно, чтобы при смене провайдера / модели не терять фокус в inputs.
 *
 * `providerMaxRefs` — лимит картинок на один запрос у активного
 * провайдера/модели. 0 — предупреждение не показывается.
 */
export function renderAdditionalReferencesStatus(providerMaxRefs = 0) {
    const status = document.getElementById('iig_additional_refs_status');
    if (!status) return;

    const refs = getActiveLorebookReferences().filter((ref) =>
        String(ref?.name || '').trim()
        && (String(ref?.imagePath || '').trim() || String(ref?.description || '').trim()));
    const enabledRefs = filterPromptReferences(refs, additionalReferencesSupportImages).filter((ref) => ref.enabled !== false);
    const enabledImageCount = enabledRefs.filter((ref) => String(ref.imagePath || '').trim()).length;
    const alwaysCount = enabledRefs.filter((ref) => ref.matchMode === 'always').length;
    const parts = [];
    if (refs.length > 0) {
        parts.push(t`Active additional references: ${enabledRefs.length}/${refs.length}. Always sent: ${alwaysCount}.`);
    }
    if (providerMaxRefs > 0 && enabledImageCount > providerMaxRefs) {
        parts.push(t`Provider accepts up to ${providerMaxRefs} refs per request — extras will be dropped by priority.`);
    }
    status.textContent = parts.join(' ');
}

/**
 * Перерисовывает список ref-карточек + статус-строку.
 *
 * `providerMaxRefs` (optional) — лимит картинок на один запрос у активного
 * провайдера/модели.
 */
export function renderAdditionalReferencesList(providerMaxRefs = 0, viewState = {}) {
    const container = document.getElementById('iig_additional_refs_list');
    if (!container) {
        return;
    }

    additionalReferencesSupportImages = viewState.supportsImageReferences ?? additionalReferencesSupportImages;
    container.innerHTML = buildAdditionalReferenceRowsHtml(getSettings(), viewState);
    syncAdditionalReferenceAvailability(additionalReferencesSupportImages);
    renderAdditionalReferencesStatus(providerMaxRefs);
}

// ----- Lorebook-style macro {{iig-book}} -----

/**
 * Первый alias из `name` (разделитель — запятая) для использования в качестве
 * «триггерного слова» в макросе. Если имя пустое — возвращает пустую строку.
 */
function getPrimaryTrigger(ref) {
    const raw = String(ref?.name || '').trim();
    if (!raw) return '';
    const first = raw.split(',')[0];
    return first.trim();
}

/**
 * Короткое описание для макроса. Пустое description → fallback на имя.
 */
function getBookDescription(ref) {
    const desc = String(ref?.description || '').trim();
    return desc || String(ref?.name || '').trim();
}

/**
 * Форматирует refs одного лорбука в секции по группам.
 * Возвращает пустую строку если все refs пустые/disabled.
 */
function formatLorebookRefsSections(refs) {
    const active = refs.filter((ref) => ref.enabled !== false && String(ref?.name || '').trim());
    if (active.length === 0) return '';

    const groupOrder = [];
    const byGroup = new Map();
    for (const ref of active) {
        const groupName = normalizeGroupName(ref.group) || 'other';
        if (!byGroup.has(groupName)) {
            byGroup.set(groupName, []);
            groupOrder.push(groupName);
        }
        byGroup.get(groupName).push(ref);
    }

    return groupOrder.map((group) => {
        const lines = byGroup.get(group).map((ref) => {
            const trigger = getPrimaryTrigger(ref);
            const desc = getBookDescription(ref);
            return `${ref.name} (${trigger}) — ${desc}`;
        });
        return `[${group}]\n${lines.join('\n')}`;
    }).join('\n\n');
}

/**
 * Рендерит все enabled лорбуки в формат, удобный для LLM-подсказок:
 *
 * ```
 * === My library ===
 * [locations]
 * tavern (tavern) — cozy wooden inn in the mountains
 *
 * [characters]
 * alice (alice) — red-haired mage with green eyes
 *
 * === Fantasy World ===
 * [items]
 * excalibur (excalibur) — legendary sword
 * ```
 *
 * Если enabled только один лорбук — заголовок-разделитель (`=== name ===`)
 * не выводится, чтобы выхлоп выглядел как до D.1 (один лорбук → плоский
 * список групп).
 */
export function renderIigBookMacro(settings = getSettings(), supportsImageReferences = true) {
    const lorebooks = getMatchingLorebooks(settings);
    if (lorebooks.length === 0) return '';

    const blocks = [];
    const showHeader = lorebooks.length > 1;
    for (const lb of lorebooks) {
        const body = formatLorebookRefsSections(filterPromptReferences(lb.refs, supportsImageReferences));
        if (!body) continue;
        blocks.push(showHeader ? `=== ${lb.name} ===\n${body}` : body);
    }

    return blocks.join('\n\n');
}

/**
 * Регистрирует макрос `{{iig-book}}` через ST context. Вызывается один раз
 * из `index.js`. Использует deprecated `context.registerMacro` — для
 * совместимости с текущей фактической версией ST. Если API недоступно —
 * тихо пропускает регистрацию (extension продолжает работать).
 */
export function registerIigBookMacro(getImageReferenceSupport) {
    try {
        const context = SillyTavern.getContext();
        if (typeof context?.registerMacro === 'function') {
            context.registerMacro(
                'iig-book',
                () => renderIigBookMacro(getSettings(), getImageReferenceSupport()),
                'Inline Image Generation: renders additional references grouped by category for LLM hints.',
            );
            console.log('[IIG] Registered {{iig-book}} macro');
        }
    } catch (error) {
        console.warn('[IIG] Failed to register {{iig-book}} macro:', error);
    }
}

// ----- Additional references import modal -----

export function buildReferenceImportModalHtml() {
    return `
        <div id="iig_ref_import_modal" class="iig-modal iig-hidden" aria-hidden="true">
            <div class="iig-modal-backdrop" data-iig-modal-close="true"></div>
            <div class="iig-modal-card" role="dialog" aria-modal="true" aria-labelledby="iig_ref_import_title">
                <div class="iig-modal-header">
                    <h4 id="iig_ref_import_title">${t`Import reference by URL`}</h4>
                    <div id="iig_ref_import_close" class="menu_button" title="${t`Close`}">
                        <i class="fa-solid fa-xmark"></i>
                    </div>
                </div>
                <textarea
                    id="iig_ref_import_urls"
                    class="text_pole iig-modal-textarea"
                    rows="6"
                    placeholder="${t`One URL per line`}"
                ></textarea>
                <div class="iig-modal-actions">
                    <div id="iig_ref_import_submit" class="menu_button iig-button-inline">
                        <i class="fa-solid fa-plus"></i> ${t`Add`}
                    </div>
                </div>
            </div>
        </div>
    `;
}


export async function importAdditionalReferencesFromUrls(rawValue) {
    const settings = getSettings();
    const refs = getActiveLorebookReferences(settings);
    const urls = normalizeReferenceUrlList(rawValue);
    if (urls.length === 0) {
        throw new Error(t`Add at least one URL`);
    }

    const availableSlots = MAX_ADDITIONAL_REFERENCES - refs.length;
    if (availableSlots <= 0) {
        throw new Error(t`Reference limit reached: ${MAX_ADDITIONAL_REFERENCES}`);
    }

    const queue = urls.slice(0, availableSlots);
    const importedNames = [];
    const importedRefs = [];

    for (let index = 0; index < queue.length; index++) {
        const url = queue[index];
        const name = getReferenceNameFromUrl(url, refs.length + index);
        const imagePath = await downloadReferenceImageFromUrl(url, {
            mode: 'additional-reference-import',
            refIndex: refs.length + index,
            refName: name,
        });

        importedRefs.push({
            name,
            description: '',
            imagePath,
            matchMode: 'match',
            enabled: true,
        });
        importedNames.push(name);
    }

    refs.unshift(...importedRefs);

    saveSettings();
    renderAdditionalReferencesList();
    return {
        importedCount: importedNames.length,
        skippedCount: Math.max(0, urls.length - queue.length),
    };
}


export function openReferenceImportModal() {
    const modal = document.getElementById('iig_ref_import_modal');
    const input = document.getElementById('iig_ref_import_urls');
    if (!modal || !input) {
        return;
    }

    modal.classList.remove('iig-hidden');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => input.focus(), 0);
}

export function closeReferenceImportModal() {
    const modal = document.getElementById('iig_ref_import_modal');
    const input = document.getElementById('iig_ref_import_urls');
    if (!modal) {
        return;
    }

    modal.classList.add('iig-hidden');
    modal.setAttribute('aria-hidden', 'true');
    if (input) {
        input.value = '';
    }
}
