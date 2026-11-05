import { getSettings, saveSettings } from './settings.js';
import {
    addCharacterLibraryAppearanceItem,
    deleteCharacterLibraryEntry,
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
    listCharacterGenerationPaths,
    readFileAsDataUrl,
    sanitizeForHtml,
    saveImageToFile,
} from './utils.js';
import {
    extractGeneratedImageUrlsFromText,
    getMessageRenderText,
} from './parser.js';
import { t } from './i18n.js';
import { downloadReferenceImageFromUrl } from './referenceTransfer.js';
import { fetchUserAvatars, getCachedUserAvatars } from './avatarPicker.js';
import { Popup } from '../../../../popup.js';
import { deleteGenerationImages, planGenerationImageDeletion } from './generationImages.js';
import { observeLibraryImages } from './libraryImages.js';

let selectedKind = 'char';
let selectedKeys = { char: '', user: '' };
let searchQuery = '';
const boundSections = new WeakSet();
let contextEventsBound = false;
let refreshTimer = null;
let searchRenderTimer = null;
let libraryRenderRevision = 0;
let listRenderRevision = 0;
let editorRenderRevision = 0;
let lastContextSignature = '';
let libraryRendered = false;
let generationSelection = { key: '', enabled: false, ids: new Set() };
let generationOperationBusy = false;
let generationProgress = '';
const pendingContextSync = { character: false, user: false };

const MAX_RENDERED_ENTITIES = 80;
const entityCatalogs = { char: null, user: null };
const rowEntities = new WeakMap();

function catalogSignature(activeKey, labels, library) {
    return JSON.stringify([activeKey, labels, Object.entries(library).map(([key, entry]) => [
        key, Boolean(entry), String(entry?.displayName || ''),
    ])]);
}

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

function getPersonaTitle(avatarFile, personas) {
    const configuredName = personas[avatarFile];
    return String(configuredName || avatarFile.replace(/\.[^.]+$/, '') || avatarFile).trim();
}

function getThumbnailUrl(type, file) {
    const value = String(file || '').trim();
    return value ? `/thumbnail?type=${encodeURIComponent(type)}&file=${encodeURIComponent(value)}` : '';
}

function getEntityLibraryMetadata(kind, key, settings) {
    // Lists need display metadata, not normalized copies of each image history.
    const bucket = kind === 'user' ? 'users' : 'characters';
    const entry = settings.characterReferenceLibrary?.[bucket]?.[key];
    return { displayName: String(entry?.displayName || '').trim(), configured: Boolean(entry) };
}

function getCharacterEntities(settings = getSettings()) {
    const context = getContext();
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const activeKey = getCurrentCharacterReferenceKey();
    const library = settings.characterReferenceLibrary?.characters || {};
    const signature = catalogSignature(activeKey, characters.map(character => [character?.name || '', character?.avatar || '']), library);
    if (entityCatalogs.char?.signature === signature) return entityCatalogs.char.entities;
    const entities = new Map();
    characters.forEach((character, index) => {
        const key = getCharacterReferenceKeyForCharacter(character, index);
        const { displayName, configured } = getEntityLibraryMetadata('char', key, settings);
        entities.set(key, {
            kind: 'char',
            key,
            title: displayName || String(character?.name || character?.avatar || t`Character`),
            fallbackTitle: String(character?.name || character?.avatar || t`Character`),
            avatarUrl: getThumbnailUrl('avatar', character?.avatar),
            generationFolder: String(character?.name || '').trim(),
            active: key === activeKey,
            configured,
        });
    });

    for (const key of Object.keys(library)) {
        if (entities.has(key)) continue;
        const { displayName } = getEntityLibraryMetadata('char', key, settings);
        const fallbackTitle = key.replace(/^(avatar|name|id):/, '') || t`Character`;
        entities.set(key, {
            kind: 'char',
            key,
            title: displayName || fallbackTitle,
            fallbackTitle,
            avatarUrl: key.startsWith('avatar:') ? getThumbnailUrl('avatar', key.slice('avatar:'.length)) : '',
            generationFolder: displayName || fallbackTitle.replace(/\.[^.]+$/, ''),
            active: false,
            configured: true,
        });
    }
    entityCatalogs.char = { signature, entities: [...entities.values()].sort((a, b) => a.title.localeCompare(b.title)) };
    return entityCatalogs.char.entities;
}

async function getUserEntities(settings = getSettings()) {
    let avatars = getCachedUserAvatars();
    if (avatars.length === 0) avatars = await fetchUserAvatars();
    const activeKey = await getCurrentUserReferenceKey(settings);
    const library = settings.characterReferenceLibrary?.users || {};
    const personas = getContext()?.powerUserSettings?.personas || {};
    const labels = avatars.map(file => [file, getPersonaTitle(file, personas)]);
    const signature = catalogSignature(activeKey, labels, library);
    if (entityCatalogs.user?.signature === signature) return entityCatalogs.user.entities;
    const entities = new Map();
    for (const [avatarFile, fallbackTitle] of labels) {
        const key = getUserReferenceKeyForAvatar(avatarFile);
        const { displayName, configured } = getEntityLibraryMetadata('user', key, settings);
        entities.set(key, {
            kind: 'user',
            key,
            title: displayName || fallbackTitle,
            fallbackTitle,
            avatarUrl: getThumbnailUrl('persona', avatarFile),
            generationFolder: '',
            active: key === activeKey,
            configured,
        });
    }

    for (const key of Object.keys(library)) {
        if (entities.has(key)) continue;
        const { displayName } = getEntityLibraryMetadata('user', key, settings);
        const avatarFile = key.replace(/^avatar:/, '');
        const fallbackTitle = getPersonaTitle(avatarFile, personas);
        entities.set(key, {
            kind: 'user',
            key,
            title: displayName || fallbackTitle,
            fallbackTitle,
            avatarUrl: getThumbnailUrl('persona', avatarFile),
            generationFolder: '',
            active: key === activeKey,
            configured: true,
        });
    }
    entityCatalogs.user = { signature, entities: [...entities.values()].sort((a, b) => a.title.localeCompare(b.title)) };
    return entityCatalogs.user.entities;
}

async function getEntities(kind = selectedKind, settings = getSettings()) {
    return kind === 'user' ? await getUserEntities(settings) : getCharacterEntities(settings);
}

function buildAvatarHtml(src, fallbackIcon = 'fa-user') {
    const safeSrc = normalizeStoredImagePath(src);
    if (!safeSrc) {
        return `<span class="iig-library-avatar-placeholder"><i class="fa-solid ${fallbackIcon}"></i></span>`;
    }
    const original = safeSrc.startsWith('/thumbnail?') ? '' : `data-iig-full-src="${sanitizeForHtml(safeSrc)}"`;
    return `<img data-iig-library-src="${sanitizeForHtml(safeSrc)}" ${original} alt="" loading="lazy" decoding="async" fetchpriority="low">`;
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
                const imagePath = normalizeStoredImagePath(generation.imagePath);
                return `<button type="button" class="iig-library-generation-item" data-generation-id="${sanitizeForHtml(generation.id)}" title="${sanitizeForHtml(caption)}" aria-label="${sanitizeForHtml(caption)}">
                    <img data-iig-library-src="${sanitizeForHtml(imagePath)}" data-iig-full-src="${sanitizeForHtml(imagePath)}" alt="" data-iig-lightbox data-iig-lightbox-caption="${sanitizeForHtml(caption)}" data-iig-generation-key="${sanitizeForHtml(key)}" data-iig-generation-id="${sanitizeForHtml(generation.id)}" loading="lazy" decoding="async" fetchpriority="low">
                    <span class="iig-library-generation-check" aria-hidden="true"></span>
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
                        <button type="button" class="menu_button iig-library-generations-select"><i class="fa-solid fa-check-double"></i><span>${t`Select images`}</span></button>
                        <button type="button" class="menu_button iig-library-generations-refresh" title="${t`Refresh generations`}"><i class="fa-solid fa-rotate"></i></button>
                        <button type="button" class="menu_button redWarningBG iig-library-generations-clear" title="${t`Clear character images`}"><i class="fa-solid fa-trash"></i><span>${t`Clear images`}</span></button>
                    </div>
                </div>
                <div class="iig-library-generation-actions" hidden>
                    <span class="iig-library-generations-selected" role="status"></span>
                    <button type="button" class="menu_button iig-library-generations-select-all">${t`Select all`}</button>
                    <button type="button" class="menu_button redWarningBG iig-library-generations-delete-selected"><i class="fa-solid fa-trash"></i><span>${t`Delete selected`}</span></button>
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
            <span class="iig-library-generations-status" role="status" hidden></span>
            <div class="iig-library-layout">
                <div id="iig_library_entities" class="iig-library-entities"></div>
                <div id="iig_library_editor_host" class="iig-library-editor-host"></div>
            </div>
        </div>`;
}

async function renderEntityList(settings = getSettings(), providedEntities = null) {
    const host = document.getElementById('iig_library_entities');
    if (!host) return [];
    const kind = selectedKind;
    const revision = ++listRenderRevision;
    const entities = providedEntities || await getEntities(kind, settings);
    if (revision !== listRenderRevision || kind !== selectedKind) return null;
    const currentSelection = selectedKeys[kind];
    if (!currentSelection || !entities.some((entity) => entity.key === currentSelection)) {
        selectedKeys[kind] = entities.find((entity) => entity.active)?.key || entities[0]?.key || '';
    }
    const query = searchQuery.trim().toLowerCase();
    const matchedEntities = query
        ? entities.filter((entity) => `${entity.title} ${entity.fallbackTitle} ${entity.key}`.toLowerCase().includes(query))
        : entities;
    const visibleEntities = matchedEntities.slice(0, MAX_RENDERED_ENTITIES);
    const note = !visibleEntities.length
        ? (kind === 'char' ? t`No characters found.` : t`No personas found.`)
        : matchedEntities.length > visibleEntities.length
            ? t`Showing ${visibleEntities.length} of ${matchedEntities.length}. Use search to narrow the list.` : '';
    const keyOf = (kind, key) => `${kind}:${key}`;
    const rows = new Map(host.firstElementChild?.dataset.libraryKind === kind
        ? [...host.querySelectorAll('.iig-library-entity')].map(row => [keyOf(row.dataset.libraryKind, row.dataset.libraryKey), row]) : []);
    const missing = rows.size ? visibleEntities.filter(entity => !rows.has(keyOf(entity.kind, entity.key))) : visibleEntities;
    if (missing.length && missing.length === visibleEntities.length) {
        host.innerHTML = visibleEntities.map(entity => buildEntityOptionHtml(entity, selectedKeys[kind]).trim()).join('')
            + (note ? `<div class="iig-library-list-note">${sanitizeForHtml(note)}</div>` : '');
        visibleEntities.forEach((entity, index) => rowEntities.set(host.children[index], entity));
        if (!providedEntities) observeLibraryImages();
        return entities;
    }
    const fresh = new Set();
    if (missing.length) {
        const html = missing.map(entity => buildEntityOptionHtml(entity, selectedKeys[kind]).trim()).join('');
        host.insertAdjacentHTML('beforeend', html);
        for (const row of host.querySelectorAll('.iig-library-entity')) {
            const key = keyOf(row.dataset.libraryKind, row.dataset.libraryKey);
            if (rows.get(key) === row) continue;
            rows.set(key, row);
            fresh.add(row);
        }
    }
    const keep = new Set();
    let cursor = host.firstElementChild;
    const place = row => {
        keep.add(row);
        if (row === cursor) cursor = cursor.nextElementSibling;
        else host.insertBefore(row, cursor);
    };
    for (const entity of visibleEntities) {
        const row = rows.get(keyOf(entity.kind, entity.key));
        const selected = entity.key === selectedKeys[kind];
        if (!fresh.has(row) && row.classList.contains('selected') !== selected) row.classList.toggle('selected', selected);
        if (fresh.has(row) || rowEntities.get(row) === entity) {
            rowEntities.set(row, entity);
            place(row);
            continue;
        }
        const searchable = `${entity.title} ${entity.fallbackTitle} ${entity.key}`.toLowerCase();
        if (row.dataset.librarySearch !== searchable) row.dataset.librarySearch = searchable;
        const title = row.querySelector('strong'), status = row.querySelector('small');
        if (title.textContent !== entity.title) title.textContent = entity.title;
        const statusText = entity.active ? t`Active` : entity.configured ? t`Configured` : '';
        if (status.textContent !== statusText) status.textContent = statusText;
        const avatar = row.querySelector('.iig-library-entity-avatar');
        if ((avatar.querySelector('img')?.getAttribute('data-iig-library-src') || '') !== normalizeStoredImagePath(entity.avatarUrl)) {
            avatar.innerHTML = buildAvatarHtml(entity.avatarUrl, entity.kind === 'char' ? 'fa-user-pen' : 'fa-user');
        }
        rowEntities.set(row, entity);
        place(row);
    }
    if (note) {
        const className = visibleEntities.length ? 'iig-library-list-note' : 'iig-library-empty';
        const element = host.querySelector(`:scope > .${className}`) || document.createElement('div');
        element.className = className;
        if (element.textContent !== note) element.textContent = note;
        place(element);
    }
    for (const row of [...host.children]) if (!keep.has(row)) row.remove();
    // A full render reconciles images after committing its editor as well.
    if (!providedEntities) observeLibraryImages();
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
    const kind = selectedKind, key = selectedKeys[kind];
    const revision = ++editorRenderRevision;
    const available = entities || await getEntities(kind, settings);
    if (revision !== editorRenderRevision || kind !== selectedKind || key !== selectedKeys[kind]) return;
    const entity = available.find((item) => item.kind === kind && item.key === key);
    const entry = entity
        ? getCharacterLibraryEntry(kind, entity.key, settings, { create: false }) || emptyLibraryEntry()
        : emptyLibraryEntry();
    host.innerHTML = buildEditorHtml(entity, entry);
    updateGenerationControls();
    observeLibraryImages();
}

function updateGenerationControls() {
    const editor = document.querySelector('#iig_library_editor_host .iig-library-editor');
    const key = editor?.getAttribute('data-library-kind') === 'char' ? editor.getAttribute('data-library-key') : '';
    if (key !== generationSelection.key) generationSelection = { key, enabled: false, ids: new Set() };
    const cards = [...(editor?.querySelectorAll('.iig-library-generation-item') || [])];
    const available = new Set(cards.map(card => card.getAttribute('data-generation-id')));
    generationSelection.ids = new Set([...generationSelection.ids].filter(id => available.has(id)));
    if (cards.length === 0) generationSelection.enabled = false;
    for (const card of cards) {
        card.disabled = generationOperationBusy;
        if (generationSelection.enabled) card.setAttribute('aria-pressed', String(generationSelection.ids.has(card.getAttribute('data-generation-id'))));
        else card.removeAttribute('aria-pressed');
    }
    const gallery = editor?.querySelector('[data-iig-lightbox-gallery]');
    if (gallery) gallery.setAttribute('data-iig-selection-mode', String(generationSelection.enabled || generationOperationBusy));
    const actions = editor?.querySelector('.iig-library-generation-actions');
    if (actions) actions.hidden = !generationSelection.enabled;
    const selected = editor?.querySelector('.iig-library-generations-selected');
    if (selected) selected.textContent = t`Selected: ${generationSelection.ids.size}`;
    const select = editor?.querySelector('.iig-library-generations-select');
    if (select) {
        select.querySelector('span').textContent = generationSelection.enabled ? t`Done` : t`Select images`;
        select.setAttribute('aria-pressed', String(generationSelection.enabled));
    }
    const selectAll = editor?.querySelector('.iig-library-generations-select-all');
    if (selectAll) selectAll.textContent = cards.length && generationSelection.ids.size === cards.length ? t`Deselect all` : t`Select all`;
    document.querySelectorAll('.iig-character-library [class*="iig-library-generations-"], #iig_debug_section .iig-library-generations-clear-all').forEach(button => {
        if (!(button instanceof HTMLButtonElement)) return;
        button.disabled = generationOperationBusy
            || (button.classList.contains('iig-library-generations-delete-selected') && generationSelection.ids.size === 0)
            || (button.classList.contains('iig-library-generations-select') && cards.length === 0)
            || (button.classList.contains('iig-library-generations-select-all') && cards.length === 0);
    });
    document.querySelectorAll('.iig-library-generations-status').forEach(status => {
        status.textContent = generationProgress;
        status.hidden = !generationProgress;
    });
}

export async function clearAllGenerationImages(settings = getSettings()) {
    await deleteLibraryImages('all', null, settings);
}

async function deleteLibraryImages(scope, state, settings) {
    if (generationOperationBusy) return;
    generationOperationBusy = true;
    generationProgress = t`Counting images...`;
    updateGenerationControls();
    let deleted = false;
    try {
        const plan = await planGenerationImageDeletion({
            scope, key: state?.key,
            folder: state?.editor.getAttribute('data-generation-folder') || '',
            ids: [...generationSelection.ids],
        }, settings);
        if (!plan.length) {
            toastr.info(t`No images to delete.`, t`Image Generation`);
            return;
        }
        const name = state?.entry.displayName || state?.editor.querySelector('.iig-library-display-name')?.placeholder || '';
        const question = scope === 'all' ? t`Delete all ${plan.length} generated images?`
            : scope === 'character' ? t`Delete ${plan.length} images for "${name}"?`
                : t`Delete ${plan.length} selected images?`;
        generationProgress = '';
        updateGenerationControls();
        const confirmed = await Popup.show.confirm(
            t`Delete images`,
            `<p>${sanitizeForHtml(question)}</p><p>${t`Saved files will be permanently deleted and will no longer display in chats. Reference images are kept.`}</p>`,
            // Enter cancels; deletion requires choosing the Delete button.
            { okButton: t`Delete`, cancelButton: t`Cancel`, defaultResult: 0 },
        );
        if (!confirmed) return;
        const result = await deleteGenerationImages(plan, settings, (done, total) => {
            generationProgress = t`Deleting images: ${done}/${total}`;
            document.querySelectorAll('.iig-library-generations-status').forEach(status => {
                status.textContent = generationProgress;
                status.hidden = false;
            });
        });
        deleted = result.deleted > 0;
        if (result.failed.length || result.skipped) {
            toastr.warning(t`Deleted: ${result.deleted}. Failed: ${result.failed.length}. Kept as references: ${result.skipped}.`, t`Image Generation`);
        } else toastr.success(t`Images deleted: ${result.deleted}`, t`Image Generation`);
    } catch (error) {
        console.error('[IIG] Failed to delete library images:', error);
        toastr.error(t`Could not delete images: ${error.message || error}`, t`Image Generation`);
    } finally {
        generationOperationBusy = false;
        generationProgress = '';
        if (deleted) await renderEditor(settings);
        else updateGenerationControls();
    }
}

export async function renderCharacterLibrary(settings = getSettings()) {
    const kind = selectedKind;
    const revision = ++libraryRenderRevision;
    clearTimeout(searchRenderTimer);
    document.querySelectorAll('[data-library-tab]').forEach((tab) => {
        tab.classList.toggle('selected', tab.getAttribute('data-library-tab') === selectedKind);
    });
    const search = document.getElementById('iig_library_search');
    if (search instanceof HTMLInputElement && search.value !== searchQuery) search.value = searchQuery;
    const entities = await getEntities(kind, settings);
    if (revision !== libraryRenderRevision || kind !== selectedKind) return;
    await renderEntityList(settings, entities);
    if (revision !== libraryRenderRevision || kind !== selectedKind) return;
    await renderEditor(settings, entities);
    const signature = await getContextSignature(settings);
    if (revision !== libraryRenderRevision || kind !== selectedKind) return;
    lastContextSignature = signature;
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

function replaceReferenceImage(editorState, target, imagePath, settings) {
    // Editors normalize entries during input; resolve the live owner after the upload.
    const entry = getCharacterLibraryEntry(editorState.kind, editorState.key, settings, { create: false });
    if (!entry) throw new Error(t`Reference not found`);
    let preview;
    if (target === 'primary') {
        entry.primary.imagePath = imagePath;
        preview = editorState.editor.querySelector('.iig-library-primary-preview');
    } else {
        const item = findById(entry.appearanceItems, target);
        if (item?.type !== 'image') throw new Error(t`Reference not found`);
        item.imagePath = imagePath;
        const row = [...editorState.editor.querySelectorAll('.iig-library-appearance-row')].find(row => row.getAttribute('data-appearance-id') === target);
        preview = row?.querySelector('.iig-library-appearance-preview');
    }
    if (document.querySelector('#iig_library_editor_host .iig-library-editor') !== editorState.editor) return;
    if (preview) preview.innerHTML = buildAvatarHtml(imagePath, 'fa-image');
    if (target === 'primary') {
        editorState.editor.querySelector('.iig-library-primary-reset')?.classList.remove('iig-hidden');
        const avatar = editorState.editor.querySelector('.iig-library-editor-avatar');
        if (avatar) avatar.innerHTML = buildAvatarHtml(imagePath, 'fa-image');
    }
    observeLibraryImages();
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
        replaceReferenceImage(state, target, path, settings);
        saveSettings();
        await renderEntityList(settings);
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
        replaceReferenceImage(state, target, path, settings);
        saveSettings();
        await renderEntityList(settings);
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
        const history = state.entry.generations;
        const isCurrent = () => getCharacterLibraryEntry('char', state.key, settings, { create: false }) === state.entry
            && state.entry.generations === history;
        // Capture chat URLs before I/O; completion may only replace the history it started with.
        const contextChatCandidates = state.key === getCurrentCharacterReferenceKey()
            ? [...new Set([...(Array.isArray(context.chat) ? context.chat : [])]
                .reverse()
                .flatMap((message) => extractGeneratedImageUrlsFromText(getMessageRenderText(message, settings)))
                .filter((path) => /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(path)))]
            : [];
        const folderImagePaths = await listCharacterGenerationPaths(folder);
        if (!isCurrent()) return;
        const contextChatPaths = (await Promise.all(contextChatCandidates.map(async (path) => {
            try {
                const imageResponse = await fetch(path, { method: 'HEAD' });
                return imageResponse.ok ? path : '';
            } catch (_error) {
                return '';
            }
        }))).filter(Boolean);
        if (!isCurrent()) return;
        const generations = syncCharacterGenerationHistory(
            state.key,
            [...contextChatPaths, ...folderImagePaths],
            settings,
        );
        const editor = document.querySelector('#iig_library_editor_host .iig-library-editor');
        if (editor?.dataset.libraryKind === 'char' && editor.dataset.libraryKey === state.key) {
            const section = editor.querySelector('.iig-library-generations-refresh').closest('.iig-library-editor-section');
            section.querySelector('.iig-library-section-count').textContent = String(generations.length);
            section.querySelector('.iig-library-generation-gallery, .iig-library-empty').outerHTML = buildGenerationsHtml(state.entry, state.key);
            updateGenerationControls();
            observeLibraryImages();
        }
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

export async function refreshIfContextChanged(settings = getSettings(), { force = false } = {}) {
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
        observeLibraryImages({ visibilityOnly: libraryRendered });
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
        if (target.closest('.iig-library-generations-select')) {
            if (generationOperationBusy) return;
            generationSelection.enabled = !generationSelection.enabled;
            generationSelection.ids.clear();
            updateGenerationControls();
            return;
        }
        if (target.closest('.iig-library-generations-select-all')) {
            if (generationOperationBusy) return;
            const ids = [...state.editor.querySelectorAll('.iig-library-generation-item')].map(card => card.getAttribute('data-generation-id'));
            generationSelection.ids = generationSelection.ids.size === ids.length ? new Set() : new Set(ids);
            updateGenerationControls();
            return;
        }
        if (target.closest('.iig-library-generations-delete-selected')) {
            await deleteLibraryImages('selected', state, settings);
            return;
        }
        if (target.closest('.iig-library-generations-clear')) {
            await deleteLibraryImages('character', state, settings);
            return;
        }
        const generationCard = target.closest('.iig-library-generation-item');
        if (generationCard) {
            if (generationOperationBusy) return;
            if (generationSelection.enabled) {
                const id = generationCard.getAttribute('data-generation-id');
                if (!generationSelection.ids.delete(id)) generationSelection.ids.add(id);
                updateGenerationControls();
            } else if (!target.closest('img')) generationCard.querySelector('img')?.click();
            return;
        }
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
