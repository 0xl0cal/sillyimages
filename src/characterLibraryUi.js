import { getSettings, saveSettings } from './settings.js';
import {
    addCharacterLibraryAppearanceItem,
    deleteCharacterLibraryEntry,
    downloadReferenceImageFromUrl,
    fetchUserAvatars,
    getCachedUserAvatars,
    getCharacterLibraryEntry,
    getCharacterReferenceKeyForCharacter,
    getCurrentCharacterReferenceKey,
    getCurrentUserReferenceKey,
    getTemporaryCharacterPrimary,
    getUserReferenceKeyForAvatar,
    removeCharacterLibraryAppearanceItem,
    setTemporaryCharacterPrimary,
    syncCharacterGenerationHistory,
} from './references.js';
import {
    normalizeStoredImagePath,
    readFileAsDataUrl,
    sanitizeForHtml,
    saveImageToFile,
} from './utils.js';
import {
    extractGeneratedImageUrlsFromText,
    getMessageRenderText,
} from './parser.js';
import { t } from './i18n.js';
import { Popup } from '../../../../popup.js';

let selectedKind = 'char';
let selectedKeys = { char: '', user: '' };
let searchQuery = '';
const boundSections = new WeakSet();
let contextEventsBound = false;
let refreshTimer = null;
let searchRenderTimer = null;
let lastContextSignature = '';
let libraryRendered = false;
const pendingContextSync = { character: false, user: false };

const MAX_RENDERED_ENTITIES = 80;

function emptyLibraryEntry() {
    return {
        displayName: '',
        primary: { enabled: true, imagePath: '', description: '' },
        appearanceItems: [],
        generations: [],
    };
}

function getContext() {
    try {
        return SillyTavern.getContext();
    } catch (_error) {
        return {};
    }
}

function getPersonaTitle(avatarFile) {
    const context = getContext();
    const configuredName = context?.powerUserSettings?.personas?.[avatarFile];
    return String(configuredName || avatarFile.replace(/\.[^.]+$/, '') || avatarFile).trim();
}

function getThumbnailUrl(type, file) {
    const value = String(file || '').trim();
    return value ? `/thumbnail?type=${encodeURIComponent(type)}&file=${encodeURIComponent(value)}` : '';
}

function getCharacterEntities(settings = getSettings()) {
    const context = getContext();
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const entities = new Map();
    characters.forEach((character, index) => {
        const key = getCharacterReferenceKeyForCharacter(character, index);
        const libraryEntry = getCharacterLibraryEntry('char', key, settings, { create: false });
        entities.set(key, {
            kind: 'char',
            key,
            title: libraryEntry?.displayName || String(character?.name || character?.avatar || t`Character`),
            fallbackTitle: String(character?.name || character?.avatar || t`Character`),
            avatarUrl: getThumbnailUrl('avatar', character?.avatar),
            generationFolder: String(character?.name || '').trim(),
            active: key === getCurrentCharacterReferenceKey(),
            configured: Boolean(libraryEntry),
        });
    });

    const library = settings.characterReferenceLibrary?.characters || {};
    for (const key of Object.keys(library)) {
        if (entities.has(key)) continue;
        const entry = getCharacterLibraryEntry('char', key, settings, { create: false });
        const fallbackTitle = key.replace(/^(avatar|name|id):/, '') || t`Character`;
        entities.set(key, {
            kind: 'char',
            key,
            title: entry?.displayName || fallbackTitle,
            fallbackTitle,
            avatarUrl: key.startsWith('avatar:') ? getThumbnailUrl('avatar', key.slice('avatar:'.length)) : '',
            generationFolder: entry?.displayName || fallbackTitle.replace(/\.[^.]+$/, ''),
            active: false,
            configured: true,
        });
    }
    return [...entities.values()].sort((a, b) => a.title.localeCompare(b.title));
}

async function getUserEntities(settings = getSettings()) {
    let avatars = getCachedUserAvatars();
    if (avatars.length === 0) avatars = await fetchUserAvatars();
    const activeKey = await getCurrentUserReferenceKey(settings);
    const entities = new Map();
    for (const avatarFile of avatars) {
        const key = getUserReferenceKeyForAvatar(avatarFile);
        const libraryEntry = getCharacterLibraryEntry('user', key, settings, { create: false });
        const fallbackTitle = getPersonaTitle(avatarFile);
        entities.set(key, {
            kind: 'user',
            key,
            title: libraryEntry?.displayName || fallbackTitle,
            fallbackTitle,
            avatarUrl: getThumbnailUrl('persona', avatarFile),
            generationFolder: '',
            active: key === activeKey,
            configured: Boolean(libraryEntry),
        });
    }

    const library = settings.characterReferenceLibrary?.users || {};
    for (const key of Object.keys(library)) {
        if (entities.has(key)) continue;
        const entry = getCharacterLibraryEntry('user', key, settings, { create: false });
        const avatarFile = key.replace(/^avatar:/, '');
        const fallbackTitle = getPersonaTitle(avatarFile);
        entities.set(key, {
            kind: 'user',
            key,
            title: entry?.displayName || fallbackTitle,
            fallbackTitle,
            avatarUrl: getThumbnailUrl('persona', avatarFile),
            generationFolder: '',
            active: key === activeKey,
            configured: true,
        });
    }
    return [...entities.values()].sort((a, b) => a.title.localeCompare(b.title));
}

async function getEntities(kind = selectedKind, settings = getSettings()) {
    return kind === 'user' ? await getUserEntities(settings) : getCharacterEntities(settings);
}

function buildAvatarHtml(src, fallbackIcon = 'fa-user') {
    const safeSrc = normalizeStoredImagePath(src);
    if (!safeSrc) {
        return `<span class="iig-library-avatar-placeholder"><i class="fa-solid ${fallbackIcon}"></i></span>`;
    }
    return `<img src="${sanitizeForHtml(safeSrc)}" alt="" loading="lazy" decoding="async">`;
}

function buildEntityOptionHtml(entity, selectedKey) {
    const searchable = `${entity.title} ${entity.fallbackTitle} ${entity.key}`.toLowerCase();
    return `
        <button type="button" class="iig-library-entity ${entity.key === selectedKey ? 'selected' : ''}" data-library-kind="${entity.kind}" data-library-key="${sanitizeForHtml(entity.key)}" data-library-search="${sanitizeForHtml(searchable)}">
            <span class="iig-library-entity-avatar">${buildAvatarHtml(entity.avatarUrl, entity.kind === 'char' ? 'fa-user-pen' : 'fa-user')}</span>
            <span class="iig-library-entity-copy">
                <strong>${sanitizeForHtml(entity.title)}</strong>
                <small>${entity.active ? t`Active` : entity.configured ? t`Configured` : ''}</small>
            </span>
        </button>`;
}

function buildAppearanceItemsHtml(entry) {
    if (entry.appearanceItems.length === 0) {
        return `<div class="iig-library-empty">${t`No appearance details.`}</div>`;
    }
    return entry.appearanceItems.map((item) => {
        const isImage = item.type === 'image';
        const preview = isImage ? normalizeStoredImagePath(item.imagePath) : '';
        const temporaryPrimary = isImage && item.id === entry.temporaryPrimaryId;
        return `
            <div class="iig-library-appearance-row ${isImage ? 'image' : 'text'} ${item.enabled === false ? 'disabled' : ''}" data-appearance-id="${sanitizeForHtml(item.id)}" data-appearance-type="${item.type}">
                <label class="checkbox_label iig-library-enable" title="${isImage ? t`Use image reference` : t`Use text description`}">
                    <input type="checkbox" class="iig-library-appearance-enabled" ${item.enabled !== false ? 'checked' : ''}>
                    <span></span>
                </label>
                <div class="iig-library-appearance-preview">
                    ${isImage ? buildAvatarHtml(preview, 'fa-image') : '<span class="iig-library-appearance-text-icon"><i class="fa-solid fa-align-left"></i></span>'}
                </div>
                <div class="iig-library-appearance-fields">
                    <textarea class="text_pole iig-library-appearance-description" rows="2" placeholder="${isImage ? t`Reference description` : t`Appearance description`}">${sanitizeForHtml(item.description)}</textarea>
                </div>
                <div class="iig-library-row-actions">
                    ${isImage ? `<button type="button" class="menu_button iig-library-appearance-primary ${temporaryPrimary ? 'selected' : ''}" title="${temporaryPrimary ? t`Use saved main reference` : t`Use as temporary main reference`}"><i class="fa-solid fa-thumbtack"></i></button>
                    <label class="menu_button" title="${t`Choose image`}">
                        <i class="fa-solid fa-upload"></i>
                        <input type="file" accept="image/*" class="iig-library-appearance-file" hidden>
                    </label>
                    <button type="button" class="menu_button iig-library-appearance-url" title="${t`Load image by URL`}"><i class="fa-solid fa-link"></i></button>` : ''}
                    <button type="button" class="menu_button iig-library-appearance-remove" title="${t`Delete`}"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>`;
    }).join('');
}

function buildGenerationsHtml(entry, key) {
    const generations = Array.isArray(entry.generations) ? entry.generations : [];
    if (generations.length === 0) {
        return `<div class="iig-library-empty">${t`No generations for this character.`}</div>`;
    }
    return `
        <div class="iig-library-generation-gallery" data-iig-lightbox-gallery>
            ${generations.map((generation) => {
                const prompt = String(generation.prompt || '').trim();
                const caption = prompt || t`Generated image`;
                return `<button type="button" class="iig-library-generation-item" title="${sanitizeForHtml(caption)}">
                    <img src="${sanitizeForHtml(normalizeStoredImagePath(generation.imagePath))}" alt="${sanitizeForHtml(caption)}" data-iig-lightbox data-iig-lightbox-caption="${sanitizeForHtml(caption)}" data-iig-generation-key="${sanitizeForHtml(key)}" data-iig-generation-id="${sanitizeForHtml(generation.id)}" loading="lazy" decoding="async">
                </button>`;
            }).join('')}
        </div>`;
}

function buildEditorHtml(entity, entry) {
    if (!entity) {
        return `<div class="iig-library-empty iig-library-empty-editor">${t`Select a character or persona.`}</div>`;
    }
    const primaryPreview = normalizeStoredImagePath(entry.primary.imagePath) || entity.avatarUrl;
    const hasReplacement = Boolean(normalizeStoredImagePath(entry.primary.imagePath));
    const temporaryPrimary = getTemporaryCharacterPrimary(entity.kind, entity.key);
    entry.temporaryPrimaryId = temporaryPrimary?.id || '';
    return `
        <div class="iig-library-editor" data-library-kind="${entity.kind}" data-library-key="${sanitizeForHtml(entity.key)}" data-generation-folder="${sanitizeForHtml(entity.generationFolder || '')}">
            <div class="iig-library-editor-head">
                <span class="iig-library-editor-avatar">${buildAvatarHtml(primaryPreview, entity.kind === 'char' ? 'fa-user-pen' : 'fa-user')}</span>
                <label class="iig-library-name-field">
                    <span>${entity.kind === 'char' ? t`Character` : t`Persona`}</span>
                    <input type="text" class="text_pole iig-library-display-name" value="${sanitizeForHtml(entry.displayName)}" placeholder="${sanitizeForHtml(entity.fallbackTitle)}">
                </label>
                <button type="button" class="menu_button redWarningBG iig-library-entry-delete" title="${t`Clear reference settings`}"><i class="fa-solid fa-trash"></i></button>
            </div>

            <section class="iig-library-editor-section">
                <div class="iig-library-section-head">
                    <strong>${t`Main reference`}</strong>
                    <div class="iig-library-row-actions">
                        <label class="menu_button" title="${t`Replace main reference`}">
                            <i class="fa-solid fa-upload"></i><span>${t`Replace`}</span>
                            <input type="file" accept="image/*" class="iig-library-primary-file" hidden>
                        </label>
                        <button type="button" class="menu_button iig-library-primary-url" title="${t`Load image by URL`}"><i class="fa-solid fa-link"></i></button>
                        <button type="button" class="menu_button iig-library-primary-reset ${hasReplacement ? '' : 'iig-hidden'}" title="${t`Use avatar`}"><i class="fa-solid fa-rotate-left"></i></button>
                    </div>
                </div>
                <div class="iig-library-primary-row ${entry.primary.enabled === false ? 'disabled' : ''}">
                    <span class="iig-library-primary-preview">${buildAvatarHtml(primaryPreview, 'fa-image')}</span>
                    <label class="checkbox_label iig-library-enable" title="${t`Use main reference`}">
                        <input type="checkbox" class="iig-library-primary-enabled" ${entry.primary.enabled !== false ? 'checked' : ''}>
                        <span></span>
                    </label>
                    <textarea class="text_pole iig-library-primary-description" rows="3" placeholder="${t`Main reference description`}">${sanitizeForHtml(entry.primary.description)}</textarea>
                </div>
            </section>

            <section class="iig-library-editor-section">
                <div class="iig-library-section-head">
                    <strong>${t`Appearance details`}</strong>
                    <div class="iig-library-row-actions iig-library-appearance-add-actions">
                        <button type="button" class="menu_button iig-library-appearance-add" data-appearance-type="text"><i class="fa-solid fa-plus"></i><span>${t`Add description`}</span></button>
                        <button type="button" class="menu_button iig-library-appearance-add" data-appearance-type="image"><i class="fa-solid fa-plus"></i><span>${t`Add reference`}</span></button>
                    </div>
                </div>
                <div class="iig-library-appearance-list">${buildAppearanceItemsHtml(entry)}</div>
            </section>

            ${entity.kind === 'char' ? `<section class="iig-library-editor-section">
                <div class="iig-library-section-head">
                    <strong>${t`Generations`}</strong>
                    <div class="iig-library-row-actions">
                        <span class="iig-library-section-count">${entry.generations.length}</span>
                        <button type="button" class="menu_button iig-library-generations-refresh" title="${t`Refresh generations`}"><i class="fa-solid fa-rotate"></i></button>
                    </div>
                </div>
                ${buildGenerationsHtml(entry, entity.key)}
            </section>` : ''}
        </div>`;
}

export function buildCharacterLibraryBodyHtml() {
    return `
        <div class="iig-character-library">
            <div class="iig-library-toolbar">
                <div class="iig-library-tabs" role="tablist">
                    <button type="button" class="menu_button iig-library-tab selected" data-library-tab="char"><i class="fa-solid fa-address-card"></i><span>${t`Characters`}</span></button>
                    <button type="button" class="menu_button iig-library-tab" data-library-tab="user"><i class="fa-solid fa-user"></i><span>${t`Personas`}</span></button>
                </div>
                <label class="iig-library-search-wrap">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input id="iig_library_search" class="text_pole" type="search" placeholder="${t`Search characters and personas`}">
                </label>
            </div>
            <div class="iig-library-layout">
                <div id="iig_library_entities" class="iig-library-entities"></div>
                <div id="iig_library_editor_host" class="iig-library-editor-host"></div>
            </div>
        </div>`;
}

async function renderEntityList(settings = getSettings()) {
    const host = document.getElementById('iig_library_entities');
    if (!host) return [];
    const entities = await getEntities(selectedKind, settings);
    const currentSelection = selectedKeys[selectedKind];
    if (!currentSelection || !entities.some((entity) => entity.key === currentSelection)) {
        selectedKeys[selectedKind] = entities.find((entity) => entity.active)?.key || entities[0]?.key || '';
    }
    const query = searchQuery.trim().toLowerCase();
    const matchedEntities = query
        ? entities.filter((entity) => `${entity.title} ${entity.fallbackTitle} ${entity.key}`.toLowerCase().includes(query))
        : entities;
    const visibleEntities = matchedEntities.slice(0, MAX_RENDERED_ENTITIES);
    const limitNote = matchedEntities.length > visibleEntities.length
        ? `<div class="iig-library-list-note">${t`Showing ${visibleEntities.length} of ${matchedEntities.length}. Use search to narrow the list.`}</div>`
        : '';
    host.innerHTML = visibleEntities.length
        ? visibleEntities.map((entity) => buildEntityOptionHtml(entity, selectedKeys[selectedKind])).join('') + limitNote
        : `<div class="iig-library-empty">${selectedKind === 'char' ? t`No characters found.` : t`No personas found.`}</div>`;
    return entities;
}

function scheduleSearchRender(settings) {
    clearTimeout(searchRenderTimer);
    searchRenderTimer = setTimeout(() => {
        renderEntityList(settings).catch((error) => console.warn('[IIG] Failed to filter character library:', error));
    }, 60);
}

async function renderEditor(settings = getSettings(), entities = null) {
    const host = document.getElementById('iig_library_editor_host');
    if (!host) return;
    const available = entities || await getEntities(selectedKind, settings);
    const entity = available.find((item) => item.key === selectedKeys[selectedKind]);
    const entry = entity
        ? getCharacterLibraryEntry(selectedKind, entity.key, settings, { create: false }) || emptyLibraryEntry()
        : emptyLibraryEntry();
    host.innerHTML = buildEditorHtml(entity, entry);
}

export async function renderCharacterLibrary(settings = getSettings()) {
    document.querySelectorAll('.iig-library-tab').forEach((tab) => {
        tab.classList.toggle('selected', tab.getAttribute('data-library-tab') === selectedKind);
    });
    const search = document.getElementById('iig_library_search');
    if (search instanceof HTMLInputElement && search.value !== searchQuery) search.value = searchQuery;
    const entities = await renderEntityList(settings);
    await renderEditor(settings, entities);
    lastContextSignature = await getContextSignature(settings);
    libraryRendered = true;
}

function getActiveEditor(settings = getSettings()) {
    const editor = document.querySelector('#iig_library_editor_host .iig-library-editor');
    if (!(editor instanceof HTMLElement)) return null;
    const kind = editor.getAttribute('data-library-kind') === 'user' ? 'user' : 'char';
    const key = String(editor.getAttribute('data-library-key') || '');
    const entry = getCharacterLibraryEntry(kind, key, settings);
    return { editor, kind, key, entry };
}

function findById(items, id) {
    return items.find((item) => item.id === id) || null;
}

async function saveUploadedImage(file, meta) {
    const dataUrl = await readFileAsDataUrl(file);
    return normalizeStoredImagePath(await saveImageToFile(dataUrl, meta));
}

async function replaceReferenceImage(editorState, target, imagePath) {
    if (target === 'primary') {
        editorState.entry.primary.imagePath = imagePath;
        return;
    }
    const item = findById(editorState.entry.appearanceItems, target);
    if (item?.type === 'image') item.imagePath = imagePath;
}

async function handleFileUpload(input, settings) {
    const file = input.files?.[0];
    if (!file) return;
    const state = getActiveEditor(settings);
    if (!state) return;
    const appearanceRow = input.closest('.iig-library-appearance-row.image');
    const target = appearanceRow?.getAttribute('data-appearance-id') || 'primary';
    try {
        const path = await saveUploadedImage(file, {
            mode: target === 'primary' ? 'character-primary-reference' : 'character-additional-reference',
            entityKind: state.kind,
            entityKey: state.key,
            referenceId: target,
        });
        await replaceReferenceImage(state, target, path);
        saveSettings();
        await renderCharacterLibrary(settings);
        toastr.success(t`Reference saved`, t`Image Generation`);
    } catch (error) {
        console.error('[IIG] Failed to save character reference:', error);
        toastr.error(t`Reference upload failed: ${error.message || error}`, t`Image Generation`);
    } finally {
        input.value = '';
    }
}

async function handleUrlUpload(target, settings) {
    const state = getActiveEditor(settings);
    if (!state) return;
    const url = await Popup.show.input(t`Load reference by URL`, t`Paste a direct link to the image:`);
    const trimmed = String(url || '').trim();
    if (!trimmed) return;
    try {
        const path = await downloadReferenceImageFromUrl(trimmed, {
            mode: target === 'primary' ? 'character-primary-reference-url' : 'character-additional-reference-url',
            entityKind: state.kind,
            entityKey: state.key,
            referenceId: target,
        });
        await replaceReferenceImage(state, target, path);
        saveSettings();
        await renderCharacterLibrary(settings);
        toastr.success(t`Reference saved`, t`Image Generation`);
    } catch (error) {
        console.error('[IIG] Failed to load character reference:', error);
        toastr.error(t`Reference upload failed: ${error.message || error}`, t`Image Generation`);
    }
}

async function refreshCharacterGenerations(state, button, settings) {
    const folder = String(state.editor.getAttribute('data-generation-folder') || '').trim();
    if (!folder) {
        toastr.warning(t`Character image folder is unavailable`, t`Image Generation`);
        return;
    }
    button.disabled = true;
    button.querySelector('i')?.classList.add('fa-spin');
    try {
        const context = getContext();
        const response = await fetch('/api/images/list', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({
                folder,
                sortField: 'date',
                sortOrder: 'desc',
            }),
        });
        if (!response.ok) {
            throw new Error((await response.text().catch(() => '')) || `HTTP ${response.status}`);
        }
        const files = await response.json();
        const folderImagePaths = (Array.isArray(files) ? files : [])
            .map((file) => String(file || '').trim())
            .filter((file) => /^iig_/i.test(file))
            .map((file) => `/user/images/${folder}/${file}`);
        const contextChatCandidates = state.key === getCurrentCharacterReferenceKey()
            ? [...new Set([...(Array.isArray(context.chat) ? context.chat : [])]
                .reverse()
                .flatMap((message) => extractGeneratedImageUrlsFromText(getMessageRenderText(message, settings)))
                .filter((path) => /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(path)))]
            : [];
        const contextChatPaths = (await Promise.all(contextChatCandidates.map(async (path) => {
            try {
                const imageResponse = await fetch(path, { method: 'HEAD' });
                return imageResponse.ok ? path : '';
            } catch (_error) {
                return '';
            }
        }))).filter(Boolean);
        const generations = syncCharacterGenerationHistory(
            state.key,
            [...contextChatPaths, ...folderImagePaths],
            settings,
        );
        await renderEditor(settings);
        toastr.success(t`Generations found: ${generations.length}`, t`Image Generation`);
    } catch (error) {
        console.error('[IIG] Failed to refresh character generations:', error);
        toastr.error(t`Failed to refresh generations: ${error.message || error}`, t`Image Generation`);
    } finally {
        button.disabled = false;
        button.querySelector('i')?.classList.remove('fa-spin');
    }
}

async function getContextSignature(settings = getSettings()) {
    const context = getContext();
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const activeUserKey = await getCurrentUserReferenceKey(settings);
    return JSON.stringify({
        characterId: context?.characterId ?? null,
        characters: characters.map((character) => [character?.name || '', character?.avatar || '']),
        activeUserKey,
        userAvatarFile: settings.userAvatarFile || '',
        useActiveUserPersonaAvatar: Boolean(settings.useActiveUserPersonaAvatar),
    });
}

async function refreshIfContextChanged(settings = getSettings(), { force = false } = {}) {
    const details = document.getElementById('iig_characters_section')?.closest('details');
    if (details && !details.open) {
        lastContextSignature = '';
        libraryRendered = false;
        return;
    }
    const signature = await getContextSignature(settings);
    if (!force && signature === lastContextSignature) return;
    const active = document.activeElement;
    if (!force && active instanceof HTMLElement && active.closest('#iig_characters_section')) return;
    await renderCharacterLibrary(settings);
}

async function syncLibrarySelectionToContext(settings, sync) {
    if (sync.character) {
        const characterKey = getCurrentCharacterReferenceKey();
        selectedKeys.char = characterKey === 'no-character' ? '' : characterKey;
    }
    if (sync.user) {
        selectedKeys.user = await getCurrentUserReferenceKey(settings);
    }
}

function scheduleRefresh(settings = getSettings(), sync = {}) {
    pendingContextSync.character ||= Boolean(sync.character);
    pendingContextSync.user ||= Boolean(sync.user);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
        const requestedSync = {
            character: pendingContextSync.character,
            user: pendingContextSync.user,
        };
        pendingContextSync.character = false;
        pendingContextSync.user = false;
        try {
            await syncLibrarySelectionToContext(settings, requestedSync);
            await refreshIfContextChanged(settings, {
                force: (requestedSync.character && selectedKind === 'char')
                    || (requestedSync.user && selectedKind === 'user'),
            });
        } catch (error) {
            console.warn('[IIG] Failed to refresh character library:', error);
        }
    }, 120);
}

function bindContextRefresh(settings) {
    if (contextEventsBound) return;
    const context = getContext();
    const eventNames = ['CHAT_CHANGED', 'CHARACTER_SELECTED', 'CHARACTER_EDITED', 'CHARACTER_DELETED', 'CHARACTER_ADDED', 'USER_AVATAR_CHANGED', 'PERSONA_CHANGED'];
    if (typeof context?.eventSource?.on === 'function') {
        contextEventsBound = true;
        for (const name of eventNames) {
            const eventName = context?.event_types?.[name];
            if (!eventName) continue;
            const sync = {
                character: ['CHAT_CHANGED', 'CHARACTER_SELECTED', 'CHARACTER_EDITED'].includes(name),
                user: ['CHAT_CHANGED', 'USER_AVATAR_CHANGED', 'PERSONA_CHANGED'].includes(name),
            };
            context.eventSource.on(eventName, () => scheduleRefresh(settings, sync));
        }
    }
}

export function bindCharacterLibraryEvents(settings = getSettings()) {
    const section = document.getElementById('iig_characters_section');
    if (!section || boundSections.has(section)) return;
    boundSections.add(section);
    const details = section.closest('details');

    details?.addEventListener('toggle', () => {
        if (details.open && !libraryRendered) {
            renderCharacterLibrary(settings).catch((error) => console.warn('[IIG] Failed to render character library:', error));
        }
    });

    section.addEventListener('input', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
        if (target.id === 'iig_library_search') {
            searchQuery = target.value;
            scheduleSearchRender(settings);
            return;
        }
        const state = getActiveEditor(settings);
        if (!state) return;
        if (target.classList.contains('iig-library-display-name')) state.entry.displayName = target.value;
        if (target.classList.contains('iig-library-primary-description')) state.entry.primary.description = target.value;

        const appearanceRow = target.closest('.iig-library-appearance-row');
        const item = findById(state.entry.appearanceItems, String(appearanceRow?.getAttribute('data-appearance-id') || ''));
        if (item && target.classList.contains('iig-library-appearance-description')) item.description = target.value;
        saveSettings();
        if (target.classList.contains('iig-library-display-name')) renderEntityList(settings).catch(() => {});
    });

    section.addEventListener('change', async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (target.type === 'file') {
            await handleFileUpload(target, settings);
            return;
        }
        const state = getActiveEditor(settings);
        if (!state) return;
        if (target.classList.contains('iig-library-primary-enabled')) state.entry.primary.enabled = target.checked;
        const appearanceRow = target.closest('.iig-library-appearance-row');
        const item = findById(state.entry.appearanceItems, String(appearanceRow?.getAttribute('data-appearance-id') || ''));
        if (item && target.classList.contains('iig-library-appearance-enabled')) {
            item.enabled = target.checked;
            if (!target.checked && getTemporaryCharacterPrimary(state.kind, state.key, settings)?.id === item.id) {
                setTemporaryCharacterPrimary(state.kind, state.key, '', settings);
                saveSettings();
                await renderEditor(settings);
                return;
            }
        }
        saveSettings();
        target.closest('.iig-library-primary-row, .iig-library-appearance-row')?.classList.toggle('disabled', !target.checked);
    });

    section.addEventListener('click', async (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const tab = target.closest('.iig-library-tab');
        if (tab) {
            selectedKind = tab.getAttribute('data-library-tab') === 'user' ? 'user' : 'char';
            await renderCharacterLibrary(settings);
            return;
        }
        const entityButton = target.closest('.iig-library-entity');
        if (entityButton) {
            selectedKind = entityButton.getAttribute('data-library-kind') === 'user' ? 'user' : 'char';
            selectedKeys[selectedKind] = String(entityButton.getAttribute('data-library-key') || '');
            await renderCharacterLibrary(settings);
            return;
        }

        const state = getActiveEditor(settings);
        if (!state) return;
        const generationsRefresh = target.closest('.iig-library-generations-refresh');
        if (generationsRefresh instanceof HTMLButtonElement && state.kind === 'char') {
            await refreshCharacterGenerations(state, generationsRefresh, settings);
            return;
        }
        const addAppearanceButton = target.closest('.iig-library-appearance-add');
        if (addAppearanceButton) {
            const type = addAppearanceButton.getAttribute('data-appearance-type') === 'image' ? 'image' : 'text';
            addCharacterLibraryAppearanceItem(state.kind, state.key, type, settings);
            await renderEditor(settings);
            return;
        }
        const appearanceRow = target.closest('.iig-library-appearance-row');
        const appearancePrimary = target.closest('.iig-library-appearance-primary');
        if (appearancePrimary && appearanceRow?.getAttribute('data-appearance-type') === 'image') {
            const id = String(appearanceRow.getAttribute('data-appearance-id') || '');
            setTemporaryCharacterPrimary(state.kind, state.key, id, settings);
            await renderEditor(settings);
            return;
        }
        if (target.closest('.iig-library-appearance-remove') && appearanceRow) {
            const id = String(appearanceRow.getAttribute('data-appearance-id') || '');
            const removed = removeCharacterLibraryAppearanceItem(state.kind, state.key, id, settings);
            if (!removed) {
                console.warn('[IIG] Appearance item was not found for deletion:', id);
                return;
            }
            await renderEditor(settings);
            return;
        }
        const appearanceUrl = target.closest('.iig-library-appearance-url');
        if (appearanceUrl && appearanceRow?.getAttribute('data-appearance-type') === 'image') {
            await handleUrlUpload(String(appearanceRow.getAttribute('data-appearance-id') || ''), settings);
            return;
        }
        if (target.closest('.iig-library-primary-url')) {
            await handleUrlUpload('primary', settings);
            return;
        }
        if (target.closest('.iig-library-primary-reset')) {
            state.entry.primary.imagePath = '';
            saveSettings();
            await renderCharacterLibrary(settings);
            return;
        }
        if (target.closest('.iig-library-entry-delete')) {
            const confirmed = await Popup.show.confirm(t`Clear all reference settings for this entry?`, t`Confirm`);
            if (!confirmed) return;
            deleteCharacterLibraryEntry(state.kind, state.key, settings);
            await renderCharacterLibrary(settings);
        }
    });

    bindContextRefresh(settings);
    if (details?.open) {
        renderCharacterLibrary(settings).catch((error) => console.warn('[IIG] Failed to render character library:', error));
    }
}
