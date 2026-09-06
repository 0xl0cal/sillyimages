/**
 * Работа с референсными изображениями:
 *   - аватары персонажа и пользователя (base64/dataUrl);
 *   - виджет выбора user avatar (двойной dropdown для Gemini и Naistera);
 *   - «Additional references» (ручной список триггер-имя → картинка);
 *   - контекстные картинки из прошлых сообщений (для image-to-image цепочек).
 *
 * Зависит от settings.js, utils.js, parser.js (для извлечения URL из messages).
 */

import {
    getSettings,
    saveSettings,
    getActiveLorebookReferences,
    ensureLorebooks,
    createLorebook,
    normalizeImageContextCount,
    normalizeGroupName,
    MAX_ADDITIONAL_REFERENCES,
} from './settings.js';
import {
    imageUrlToBase64,
    imageUrlToDataUrl,
    saveImageToFile,
    normalizeStoredImagePath,
    sanitizeForHtml,
} from './utils.js';
import {
    extractGeneratedImageUrlsFromText,
    getMessageRenderText,
} from './parser.js';
import { t } from './i18n.js';

// ----- Module state -----

const PERSONAS_MODULE_PATHS = Object.freeze([
    '/scripts/personas.js',
    '../../../personas.js',
]);

let personasModulePromise = null;
let cachedUserAvatars = [];
const temporaryPrimaryReferenceIds = new Map();
const MAX_CHARACTER_GENERATIONS = 48;

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
        bucket[normalizedKey] = normalizeCharacterLibraryEntry({});
    }
    if (!bucket[normalizedKey]) return null;
    bucket[normalizedKey] = normalizeCharacterLibraryEntry(bucket[normalizedKey]);
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

export function recordCharacterGeneration(imagePath, prompt = '', settings = getSettings()) {
    const normalizedPath = normalizeStoredImagePath(imagePath);
    const key = getCurrentCharacterReferenceKey();
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

export function removeCharacterGeneration(key, generationId, settings = getSettings()) {
    const entry = getCharacterLibraryEntry('char', key, settings, { create: false });
    const normalizedId = String(generationId || '').trim();
    if (!entry || !normalizedId) return null;
    const generation = entry.generations.find((item) => item.id === normalizedId) || null;
    if (!generation) return null;
    entry.generations = entry.generations.filter((item) => item.id !== normalizedId);
    saveSettings();
    return generation;
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
} = {}, settings = getSettings()) {
    if (settings.sendRefDescriptions === false || mode === 'none') return '';

    const sentSources = new Set((Array.isArray(references) ? references : [])
        .map(getReferenceSource)
        .filter(Boolean));
    const includeSentSources = mode === 'character-prompt';
    let charDescription = '';
    let userDescription = '';

    if (includeChar && (includeSentSources || !sentSources.has('char'))) {
        const key = getCurrentCharacterReferenceKey();
        charDescription = getCharacterLibraryDescription('char', key, settings);
    }

    if (includeUser && (includeSentSources || !sentSources.has('user'))) {
        const key = await getCurrentUserReferenceKey(settings);
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

// ----- Fetch user avatars from ST -----

export async function fetchUserAvatars() {
    try {
        const context = SillyTavern.getContext();
        const response = await fetch('/api/avatars/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const payload = await response.json();
        const avatars = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.avatars)
                ? payload.avatars
                : Array.isArray(payload?.files)
                    ? payload.files
                    : [];

        cachedUserAvatars = avatars
            .map((avatar) => String(avatar || '').trim())
            .filter(Boolean);

        return cachedUserAvatars;
    } catch (error) {
        console.error('[IIG] Failed to fetch user avatars:', error);
        return [];
    }
}

export function getCachedUserAvatars() {
    return [...cachedUserAvatars];
}

// ----- Avatar dropdown widget (двойной: Gemini + Naistera) -----

export function getUserAvatarSelects() {
    return ['iig_user_avatar_file', 'iig_naistera_user_avatar_file']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
}

export function getUserAvatarDropdownConfigs() {
    return [
        {
            rootId: 'iig_user_avatar_dropdown',
            selectedId: 'iig_user_avatar_dropdown_selected',
            listId: 'iig_user_avatar_dropdown_list',
            refreshId: 'iig_refresh_avatars',
        },
        {
            rootId: 'iig_naistera_user_avatar_dropdown',
            selectedId: 'iig_naistera_user_avatar_dropdown_selected',
            listId: 'iig_naistera_user_avatar_dropdown_list',
            refreshId: 'iig_naistera_refresh_avatars',
        },
    ].filter((config) => document.getElementById(config.selectedId));
}

export function buildUserAvatarSelectedHtml(avatarFile) {
    return avatarFile
        ? `<img class="iig-dropdown-thumb" src="/User Avatars/${encodeURIComponent(avatarFile)}" alt="" onerror="this.style.display='none'">
           <span class="iig-dropdown-text">${sanitizeForHtml(avatarFile)}</span>
           <span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>`
        : `<div class="iig-dropdown-placeholder"><i class="fa-solid fa-user"></i></div>
           <span class="iig-dropdown-text">Выберите аватар</span>
           <span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>`;
}

export function closeUserAvatarDropdowns() {
    for (const { rootId } of getUserAvatarDropdownConfigs()) {
        document.getElementById(rootId)?.classList.remove('open');
    }
}

export function renderUserAvatarDropdownList(listElement, avatars, selectedAvatar) {
    if (!listElement) {
        return;
    }

    listElement.innerHTML = '';

    for (const avatarFile of avatars) {
        const item = document.createElement('div');
        item.className = `iig-avatar-dropdown-item ${selectedAvatar === avatarFile ? 'selected' : ''}`;
        item.dataset.value = avatarFile;
        item.innerHTML = `
            <img class="iig-item-thumb" src="/User Avatars/${encodeURIComponent(avatarFile)}" alt="${sanitizeForHtml(avatarFile)}" loading="lazy" onerror="this.style.display='none'">
            <span class="iig-item-name">${sanitizeForHtml(avatarFile)}</span>`;
        item.addEventListener('click', () => {
            const settings = getSettings();
            settings.userAvatarFile = avatarFile;
            saveSettings();
            syncUserAvatarSelection(avatarFile);
        });
        listElement.appendChild(item);
    }
}

export function getActivePersonaAvatarCheckboxes() {
    return ['iig_use_active_persona_avatar', 'iig_naistera_use_active_persona_avatar']
        .map((id) => document.getElementById(id))
        .filter(Boolean);
}

export function syncActivePersonaAvatarMode(enabled) {
    for (const checkbox of getActivePersonaAvatarCheckboxes()) {
        checkbox.checked = Boolean(enabled);
    }
}

export function syncUserAvatarSelection(selectedAvatar) {
    for (const select of getUserAvatarSelects()) {
        if (selectedAvatar && !Array.from(select.options).some((option) => option.value === selectedAvatar)) {
            const option = document.createElement('option');
            option.value = selectedAvatar;
            option.textContent = selectedAvatar;
            select.appendChild(option);
        }
        select.value = selectedAvatar || '';
    }

    for (const config of getUserAvatarDropdownConfigs()) {
        const selectedElement = document.getElementById(config.selectedId);
        const listElement = document.getElementById(config.listId);
        if (selectedElement) {
            selectedElement.innerHTML = buildUserAvatarSelectedHtml(selectedAvatar);
        }
        if (listElement) {
            renderUserAvatarDropdownList(listElement, cachedUserAvatars, selectedAvatar);
        }
    }

    closeUserAvatarDropdowns();
}

export function populateUserAvatarSelects(avatars, selectedAvatar) {
    for (const select of getUserAvatarSelects()) {
        select.innerHTML = '<option value="">-- Не выбран --</option>';

        for (const avatar of avatars) {
            const option = document.createElement('option');
            option.value = avatar;
            option.textContent = avatar;
            select.appendChild(option);
        }
    }

    for (const config of getUserAvatarDropdownConfigs()) {
        const listElement = document.getElementById(config.listId);
        renderUserAvatarDropdownList(listElement, avatars, selectedAvatar);
    }

    syncUserAvatarSelection(selectedAvatar);
}

export async function refreshUserAvatarSelects() {
    const avatars = await fetchUserAvatars();
    populateUserAvatarSelects(avatars, getSettings().userAvatarFile);
    return avatars;
}

export function buildUserAvatarDropdownControl(prefix, selectedAvatar) {
    return `
        <div id="${prefix}_dropdown" class="iig-avatar-dropdown">
            <div id="${prefix}_dropdown_selected" class="iig-avatar-dropdown-selected">
                ${buildUserAvatarSelectedHtml(selectedAvatar)}
            </div>
            <div id="${prefix}_dropdown_list" class="iig-avatar-dropdown-list"></div>
        </div>
    `;
}

// ----- User avatar URL resolver (persona + selected file) -----

export async function getSelectedUserAvatarUrl() {
    const settings = getSettings();

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

export async function collectCharacterLibraryReferences(kind, format, settings = getSettings()) {
    const isUser = kind === 'user';
    const key = isUser ? await getCurrentUserReferenceKey(settings) : getCurrentCharacterReferenceKey();
    const entry = getCharacterLibraryEntry(kind, key, settings, { create: false });
    const convert = format === 'dataUrl' ? imageUrlToDataUrl : imageUrlToBase64;
    const baseAvatarUrl = isUser ? await getSelectedUserAvatarUrl() : await getCurrentCharacterAvatarUrl();
    const source = isUser ? 'user' : 'char';
    const results = [];
    const sharedDescription = getCharacterLibraryDescription(kind, key, settings);
    const appearanceDescription = getCharacterAppearanceTextDescription(entry);
    const temporaryPrimary = getTemporaryCharacterPrimary(kind, key, settings);

    if (temporaryPrimary) {
        const image = await convert(normalizeStoredImagePath(temporaryPrimary.imagePath));
        if (image) {
            results.push(makeReferenceObject(
                image,
                `${appearanceDescription} ${temporaryPrimary.description}`.trim(),
                source,
            ));
        }
    }

    const primary = entry?.primary || { enabled: true, imagePath: '', description: '' };
    if (primary.enabled !== false) {
        const primaryPath = normalizeStoredImagePath(primary.imagePath) || baseAvatarUrl;
        if (primaryPath) {
            const image = await convert(primaryPath);
            if (image) {
                results.push(makeReferenceObject(
                    image,
                    temporaryPrimary ? primary.description : sharedDescription,
                    source,
                ));
            }
        }
    }

    for (const item of entry?.appearanceItems || []) {
        if (item.type !== 'image' || item.enabled === false) continue;
        if (item.id === temporaryPrimary?.id) continue;
        const imagePath = normalizeStoredImagePath(item.imagePath);
        if (!imagePath) continue;
        const image = await convert(imagePath);
        if (image) {
            const description = results.length === 0 && sharedDescription
                ? `${sharedDescription} ${item.description}`.trim()
                : item.description;
            results.push(makeReferenceObject(image, description, source));
        }
    }

    return results;
}

// ----- Previous-message context images -----

export function getPreviousGeneratedImageUrls(messageId, requestedCount) {
    const count = normalizeImageContextCount(requestedCount);
    if (!Number.isInteger(messageId) || messageId <= 0) {
        return [];
    }

    const settings = getSettings();
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

export async function collectPreviousContextReferences(messageId, format, requestedCount) {
    const urls = getPreviousGeneratedImageUrls(messageId, requestedCount);
    if (urls.length === 0) {
        return [];
    }

    const convert = format === 'dataUrl' ? imageUrlToDataUrl : imageUrlToBase64;
    const converted = await Promise.all(urls.map((url) => convert(url)));
    return converted.filter(Boolean);
}

// ----- Additional references -----

export function buildAdditionalReferenceRowsHtml(settings = getSettings(), viewState = {}) {
    const refs = getActiveLorebookReferences(settings);
    const isPowerMode = settings.additionalReferencesMode === 'power';
    const selectedId = String(viewState.selectedId || '');
    const selectedIndex = Math.max(0, refs.findIndex((ref) => ref.id === selectedId));
    const selectedRef = refs[selectedIndex] || null;
    const query = String(viewState.query || '');
    const filter = ['enabled', 'match', 'always'].includes(viewState.filter) ? viewState.filter : 'all';
    const listRowsHtml = refs.map((ref, index) => {
        const previewSrc = normalizeStoredImagePath(ref.imagePath);
        const isAlways = ref.matchMode === 'always';
        const isEnabled = ref.enabled !== false;
        const previewHtml = previewSrc
            ? `<img src="${sanitizeForHtml(previewSrc)}" alt="${sanitizeForHtml(ref.name || `ref-${index + 1}`)}" class="iig-additional-ref-list-thumb">`
            : `<div class="iig-additional-ref-list-thumb iig-additional-ref-thumb-placeholder"><i class="fa-solid fa-image"></i></div>`;
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
        : `<div class="iig-additional-ref-editor-thumb iig-additional-ref-thumb-placeholder"><i class="fa-solid fa-image"></i></div>`;
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
                    <div class="iig-additional-ref-image-actions">
                        <label class="menu_button iig-additional-ref-upload" title="${t`Upload image`}">
                            <i class="fa-solid fa-upload"></i>
                            <input type="file" accept="image/*" class="iig-additional-ref-file" style="display:none">
                        </label>
                        <button type="button" class="menu_button iig-additional-ref-upload-url" title="${t`Upload image by URL`}">
                            <i class="fa-solid fa-link"></i>
                        </button>
                    </div>
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
    const enabledRefs = refs.filter((ref) => ref.enabled !== false);
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

    container.innerHTML = buildAdditionalReferenceRowsHtml(getSettings(), viewState);
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
export function renderIigBookMacro(settings = getSettings()) {
    const lorebooks = ensureLorebooks(settings).filter((lb) => lb.enabled !== false);
    if (lorebooks.length === 0) return '';

    const blocks = [];
    const showHeader = lorebooks.length > 1;
    for (const lb of lorebooks) {
        const body = formatLorebookRefsSections(lb.refs);
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
export function registerIigBookMacro() {
    try {
        const context = SillyTavern.getContext();
        if (typeof context?.registerMacro === 'function') {
            context.registerMacro(
                'iig-book',
                () => renderIigBookMacro(),
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

export function normalizeReferenceUrlList(rawValue) {
    return String(rawValue || '')
        .split(/\r?\n+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

export function getReferenceNameFromUrl(url, fallbackIndex = 0) {
    try {
        const parsed = new URL(url, window.location.href);
        const pathname = parsed.pathname || '';
        const fileName = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '').trim();
        if (fileName) {
            return fileName;
        }
    } catch (_error) {
        // ignore and fallback
    }
    return `reference-${fallbackIndex + 1}`;
}

/**
 * Скачивает одну картинку с URL и сохраняет её через `saveImageToFile`,
 * возвращая относительный путь на сервере ST. Бросает Error если URL
 * недоступен / не является картинкой.
 *
 * @param {string} url
 * @param {{ mode?: string, refIndex?: number, refName?: string }} [meta]
 * @returns {Promise<string>} нормализованный imagePath
 */
export async function downloadReferenceImageFromUrl(url, meta = {}) {
    const trimmed = String(url || '').trim();
    if (!trimmed) throw new Error(t`Add at least one URL`);

    const dataUrl = await imageUrlToDataUrl(trimmed);
    if (!dataUrl) throw new Error(t`Failed to load image: ${trimmed}`);

    const savedPath = await saveImageToFile(dataUrl, {
        mode: meta.mode || 'additional-reference-import',
        sourceUrl: trimmed,
        refIndex: Number.isFinite(meta.refIndex) ? meta.refIndex : 0,
        refName: String(meta.refName || getReferenceNameFromUrl(trimmed, meta.refIndex || 0)),
    });
    return normalizeStoredImagePath(savedPath);
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

// ----- Lorebook JSON export / import -----

/**
 * Формат JSON-экспорта лорбука, v1.
 *
 * Из ref-записи исключаются:
 *   - `id` — пересоздаётся при импорте (иначе конфликт с чужими лорбуками);
 *   - `imagePath` — локальный путь на машине экспортёра, бесполезен на чужой;
 *   - сама картинка (base64) — не включается, чтобы файл оставался лёгким
 *     и можно было делиться публично без утечек.
 *
 * Вместо них добавляется пустое поле `imageUrl: ''` — юзер вручную вставляет
 * прямые ссылки на картинки, чтобы получатель при импорте смог их скачать.
 */
export function buildLorebookExportJson(lorebook) {
    const refs = Array.isArray(lorebook?.refs) ? lorebook.refs : [];
    return {
        kind: 'iig-lorebook',
        version: 1,
        name: String(lorebook?.name || 'Lorebook'),
        refs: refs.map((ref) => ({
            name: String(ref?.name || ''),
            description: String(ref?.description || ''),
            matchMode: ref?.matchMode === 'always' ? 'always' : 'match',
            enabled: ref?.enabled !== false,
            group: String(ref?.group || ''),
            priority: Number.isFinite(ref?.priority) ? ref.priority : 0,
            useRegex: ref?.useRegex === true,
            secondaryKeys: String(ref?.secondaryKeys || ''),
            imageUrl: '',
        })),
    };
}

/**
 * Нормализует имя лорбука в имя файла. Убирает запрещённые символы,
 * схлопывает пробелы в underscore'ы, обрезает до 64 символов.
 */
export function lorebookFileNameFromTitle(title) {
    const base = String(title || 'lorebook')
        .normalize('NFKD')
        .replace(/[^\w\s.-]+/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 64) || 'lorebook';
    return `${base}.iig.json`;
}

/**
 * Парсит и валидирует JSON-содержимое файла лорбука. Возвращает нормализованный
 * payload `{ kind, version, name, refs }`. Бросает Error с понятным
 * сообщением если формат не подходит.
 */
export function parseLorebookJson(rawText) {
    let payload;
    try {
        payload = JSON.parse(String(rawText || ''));
    } catch (e) {
        throw new Error(t`File is not valid JSON: ${e.message || e}`);
    }
    if (!payload || typeof payload !== 'object') {
        throw new Error(t`Invalid lorebook: top-level must be an object`);
    }
    if (payload.kind !== 'iig-lorebook') {
        throw new Error(t`Invalid lorebook: "kind" field must be "iig-lorebook"`);
    }
    if (payload.version !== 1) {
        throw new Error(t`Unsupported lorebook version: ${payload.version}`);
    }
    if (!Array.isArray(payload.refs)) {
        throw new Error(t`Invalid lorebook: "refs" must be an array`);
    }
    return {
        kind: 'iig-lorebook',
        version: 1,
        name: String(payload.name || 'Imported lorebook'),
        refs: payload.refs,
    };
}

/**
 * Создаёт новый лорбук из провалидированного payload и скачивает картинки
 * для refs с непустым `imageUrl`. Возвращает статистику импорта.
 *
 * @param {{ name: string, refs: Array }} payload
 * @param {{ sourceUrl?: string }} [meta]
 * @returns {Promise<{ lorebookId: string, refsCount: number, imagesDownloaded: number, imagesFailed: number }>}
 */
export async function importLorebookFromPayload(payload, meta = {}) {
    const settings = getSettings();
    const newLorebook = createLorebook(payload.name, settings);
    newLorebook.meta = {
        sourceUrl: String(meta.sourceUrl || '').trim(),
        importedAt: Date.now(),
        version: 1,
    };

    let imagesDownloaded = 0;
    let imagesFailed = 0;

    for (let index = 0; index < payload.refs.length; index++) {
        const raw = payload.refs[index];
        const ref = {
            name: String(raw?.name || '').trim(),
            description: String(raw?.description || '').trim(),
            imagePath: '',
            matchMode: raw?.matchMode === 'always' ? 'always' : 'match',
            enabled: raw?.enabled !== false,
            group: String(raw?.group || '').trim(),
            priority: Number.parseInt(String(raw?.priority ?? 0), 10) || 0,
            useRegex: raw?.useRegex === true,
            secondaryKeys: String(raw?.secondaryKeys || ''),
        };

        const imageUrl = String(raw?.imageUrl || '').trim();
        if (imageUrl) {
            try {
                ref.imagePath = await downloadReferenceImageFromUrl(imageUrl, {
                    mode: 'lorebook-import',
                    refIndex: index,
                    refName: ref.name,
                });
                imagesDownloaded++;
            } catch (error) {
                console.error(`[IIG] Failed to download imageUrl for "${ref.name}":`, error);
                imagesFailed++;
            }
        }

        newLorebook.refs.push(ref);
    }

    saveSettings();
    return {
        lorebookId: newLorebook.id,
        refsCount: payload.refs.length,
        imagesDownloaded,
        imagesFailed,
    };
}

/**
 * Fetches JSON-content по URL, парсит, импортирует. Удобная обёртка.
 */
export async function importLorebookFromUrl(url) {
    const trimmed = String(url || '').trim();
    if (!trimmed) throw new Error(t`URL is empty`);

    let response;
    try {
        response = await fetch(trimmed);
    } catch (e) {
        throw new Error(t`Could not reach URL: ${e.message || e}`);
    }
    if (!response.ok) {
        throw new Error(t`URL returned HTTP ${response.status}`);
    }
    const text = await response.text();
    const payload = parseLorebookJson(text);
    return importLorebookFromPayload(payload, { sourceUrl: trimmed });
}

/**
 * Читает File, парсит, импортирует.
 */
export async function importLorebookFromFile(file) {
    if (!(file instanceof File)) throw new Error(t`No file selected`);
    const text = await file.text();
    const payload = parseLorebookJson(text);
    return importLorebookFromPayload(payload);
}

/**
 * Инициирует скачивание текстового содержимого в браузере.
 * Создаёт Blob → анкер → click → cleanup.
 */
export function triggerBrowserDownload(fileName, content, mimeType = 'application/json') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Небольшая задержка чтобы Safari успел забрать blob — потом revoke.
    setTimeout(() => URL.revokeObjectURL(url), 1500);
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
