import { getSettings, saveSettings } from './settings.js';
import {
    addCharacterLibraryDescription,
    addCharacterLibraryReference,
    deleteCharacterLibraryEntry,
    downloadReferenceImageFromUrl,
    fetchUserAvatars,
    getCachedUserAvatars,
    getCharacterLibraryEntry,
    getCharacterReferenceKeyForCharacter,
    getCurrentCharacterReferenceKey,
    getCurrentUserReferenceKey,
    getReferenceNameFromUrl,
    getUserReferenceKeyForAvatar,
} from './references.js';
import {
    normalizeStoredImagePath,
    readFileAsDataUrl,
    sanitizeForHtml,
    saveImageToFile,
} from './utils.js';
import { t } from './i18n.js';
import { Popup } from '../../../../popup.js';

let selectedKind = 'char';
let selectedKeys = { char: '', user: '' };
let searchQuery = '';
let eventsBound = false;
let refreshTimer = null;
let searchRenderTimer = null;
let lastContextSignature = '';
let libraryRendered = false;

const MAX_RENDERED_ENTITIES = 80;

function emptyLibraryEntry() {
    return {
        displayName: '',
        primary: { enabled: true, imagePath: '', description: '' },
        descriptions: [],
        references: [],
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

function buildDescriptionRowsHtml(entry) {
    if (entry.descriptions.length === 0) {
        return `<div class="iig-library-empty">${t`No appearance descriptions.`}</div>`;
    }
    return entry.descriptions.map((description) => `
        <div class="iig-library-description-row ${description.enabled === false ? 'disabled' : ''}" data-description-id="${sanitizeForHtml(description.id)}">
            <label class="checkbox_label iig-library-enable" title="${t`Use description`}">
                <input type="checkbox" class="iig-library-description-enabled" ${description.enabled !== false ? 'checked' : ''}>
                <span></span>
            </label>
            <textarea class="text_pole iig-library-description-text" rows="2" placeholder="${t`Appearance description`}">${sanitizeForHtml(description.text)}</textarea>
            <button type="button" class="menu_button iig-library-description-remove" title="${t`Delete description`}"><i class="fa-solid fa-trash"></i></button>
        </div>`).join('');
}

function buildImageReferenceRowsHtml(entry) {
    if (entry.references.length === 0) {
        return `<div class="iig-library-empty">${t`No additional character references.`}</div>`;
    }
    return entry.references.map((reference) => {
        const preview = normalizeStoredImagePath(reference.imagePath);
        return `
            <div class="iig-library-reference-row ${reference.enabled === false ? 'disabled' : ''}" data-reference-id="${sanitizeForHtml(reference.id)}">
                <div class="iig-library-reference-preview">${buildAvatarHtml(preview, 'fa-image')}</div>
                <label class="checkbox_label iig-library-enable" title="${t`Use reference`}">
                    <input type="checkbox" class="iig-library-reference-enabled" ${reference.enabled !== false ? 'checked' : ''}>
                    <span></span>
                </label>
                <div class="iig-library-reference-fields">
                    <input type="text" class="text_pole iig-library-reference-name" value="${sanitizeForHtml(reference.name)}" placeholder="${t`Reference name`}">
                    <textarea class="text_pole iig-library-reference-description" rows="2" placeholder="${t`Reference description`}">${sanitizeForHtml(reference.description)}</textarea>
                </div>
                <div class="iig-library-row-actions">
                    <label class="menu_button" title="${t`Choose image`}">
                        <i class="fa-solid fa-upload"></i>
                        <input type="file" accept="image/*" class="iig-library-reference-file" hidden>
                    </label>
                    <button type="button" class="menu_button iig-library-reference-url" title="${t`Load image by URL`}"><i class="fa-solid fa-link"></i></button>
                    <button type="button" class="menu_button iig-library-reference-remove" title="${t`Delete reference`}"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>`;
    }).join('');
}

function buildEditorHtml(entity, entry) {
    if (!entity) {
        return `<div class="iig-library-empty iig-library-empty-editor">${t`Select a character or persona.`}</div>`;
    }
    const primaryPreview = normalizeStoredImagePath(entry.primary.imagePath) || entity.avatarUrl;
    const hasReplacement = Boolean(normalizeStoredImagePath(entry.primary.imagePath));
    return `
        <div class="iig-library-editor" data-library-kind="${entity.kind}" data-library-key="${sanitizeForHtml(entity.key)}">
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
                    <strong>${t`Appearance descriptions`}</strong>
                    <button type="button" class="menu_button iig-library-description-add"><i class="fa-solid fa-plus"></i><span>${t`Add description`}</span></button>
                </div>
                <div class="iig-library-description-list">${buildDescriptionRowsHtml(entry)}</div>
            </section>

            <section class="iig-library-editor-section">
                <div class="iig-library-section-head">
                    <strong>${t`Additional references`}</strong>
                    <button type="button" class="menu_button iig-library-reference-add"><i class="fa-solid fa-plus"></i><span>${t`Add reference`}</span></button>
                </div>
                <div class="iig-library-reference-list">${buildImageReferenceRowsHtml(entry)}</div>
            </section>
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
    const reference = findById(editorState.entry.references, target);
    if (reference) reference.imagePath = imagePath;
}

async function handleFileUpload(input, settings) {
    const file = input.files?.[0];
    if (!file) return;
    const state = getActiveEditor(settings);
    if (!state) return;
    const referenceRow = input.closest('.iig-library-reference-row');
    const target = referenceRow?.getAttribute('data-reference-id') || 'primary';
    try {
        const path = await saveUploadedImage(file, {
            mode: target === 'primary' ? 'character-primary-reference' : 'character-additional-reference',
            entityKind: state.kind,
            entityKey: state.key,
            referenceId: target,
        });
        await replaceReferenceImage(state, target, path);
        if (target !== 'primary') {
            const reference = findById(state.entry.references, target);
            if (reference && !reference.name) reference.name = file.name.replace(/\.[^.]+$/, '');
        }
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
        if (target !== 'primary') {
            const reference = findById(state.entry.references, target);
            if (reference && !reference.name) reference.name = getReferenceNameFromUrl(trimmed);
        }
        saveSettings();
        await renderCharacterLibrary(settings);
        toastr.success(t`Reference saved`, t`Image Generation`);
    } catch (error) {
        console.error('[IIG] Failed to load character reference:', error);
        toastr.error(t`Reference upload failed: ${error.message || error}`, t`Image Generation`);
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

async function refreshIfContextChanged(settings = getSettings()) {
    const details = document.getElementById('iig_characters_section')?.closest('details');
    if (details && !details.open) {
        lastContextSignature = '';
        libraryRendered = false;
        return;
    }
    const signature = await getContextSignature(settings);
    if (signature === lastContextSignature) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('#iig_characters_section')) return;
    await renderCharacterLibrary(settings);
}

function scheduleRefresh(settings = getSettings()) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshIfContextChanged(settings).catch((error) => {
        console.warn('[IIG] Failed to refresh character library:', error);
    }), 120);
}

function bindContextRefresh(settings) {
    const context = getContext();
    const eventNames = ['CHAT_CHANGED', 'CHARACTER_SELECTED', 'CHARACTER_EDITED', 'CHARACTER_DELETED', 'CHARACTER_ADDED', 'USER_AVATAR_CHANGED', 'PERSONA_CHANGED'];
    if (typeof context?.eventSource?.on === 'function') {
        for (const name of eventNames) {
            const eventName = context?.event_types?.[name];
            if (eventName) context.eventSource.on(eventName, () => scheduleRefresh(settings));
        }
    }
}

export function bindCharacterLibraryEvents(settings = getSettings()) {
    if (eventsBound) return;
    eventsBound = true;
    const section = document.getElementById('iig_characters_section');
    if (!section) return;
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

        const descriptionRow = target.closest('.iig-library-description-row');
        const description = findById(state.entry.descriptions, String(descriptionRow?.getAttribute('data-description-id') || ''));
        if (description && target.classList.contains('iig-library-description-text')) description.text = target.value;

        const referenceRow = target.closest('.iig-library-reference-row');
        const reference = findById(state.entry.references, String(referenceRow?.getAttribute('data-reference-id') || ''));
        if (reference && target.classList.contains('iig-library-reference-name')) reference.name = target.value;
        if (reference && target.classList.contains('iig-library-reference-description')) reference.description = target.value;
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
        const descriptionRow = target.closest('.iig-library-description-row');
        const description = findById(state.entry.descriptions, String(descriptionRow?.getAttribute('data-description-id') || ''));
        if (description && target.classList.contains('iig-library-description-enabled')) description.enabled = target.checked;
        const referenceRow = target.closest('.iig-library-reference-row');
        const reference = findById(state.entry.references, String(referenceRow?.getAttribute('data-reference-id') || ''));
        if (reference && target.classList.contains('iig-library-reference-enabled')) reference.enabled = target.checked;
        saveSettings();
        target.closest('.iig-library-primary-row, .iig-library-description-row, .iig-library-reference-row')?.classList.toggle('disabled', !target.checked);
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
        if (target.closest('.iig-library-description-add')) {
            addCharacterLibraryDescription(state.kind, state.key, settings);
            await renderEditor(settings);
            return;
        }
        if (target.closest('.iig-library-reference-add')) {
            addCharacterLibraryReference(state.kind, state.key, settings);
            await renderEditor(settings);
            return;
        }
        const descriptionRow = target.closest('.iig-library-description-row');
        if (target.closest('.iig-library-description-remove') && descriptionRow) {
            const id = String(descriptionRow.getAttribute('data-description-id') || '');
            state.entry.descriptions = state.entry.descriptions.filter((item) => item.id !== id);
            saveSettings();
            await renderEditor(settings);
            return;
        }
        const referenceRow = target.closest('.iig-library-reference-row');
        if (target.closest('.iig-library-reference-remove') && referenceRow) {
            const id = String(referenceRow.getAttribute('data-reference-id') || '');
            state.entry.references = state.entry.references.filter((item) => item.id !== id);
            saveSettings();
            await renderEditor(settings);
            return;
        }
        const referenceUrl = target.closest('.iig-library-reference-url');
        if (referenceUrl && referenceRow) {
            await handleUrlUpload(String(referenceRow.getAttribute('data-reference-id') || ''), settings);
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
