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
    ensureAdditionalReferencesArray,
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

// ----- Модульное состояние (раньше были module-level let) -----

const PERSONAS_MODULE_PATHS = Object.freeze([
    '/scripts/personas.js',
    '../../../personas.js',
]);

let personasModulePromise = null;
let cachedUserAvatars = [];

function ensureCharacterReferenceDescriptionStore(settings = getSettings()) {
    if (!settings.characterReferenceDescriptions || typeof settings.characterReferenceDescriptions !== 'object') {
        settings.characterReferenceDescriptions = {};
    }
    if (!settings.characterReferenceDescriptions.characters || typeof settings.characterReferenceDescriptions.characters !== 'object') {
        settings.characterReferenceDescriptions.characters = {};
    }
    if (!settings.characterReferenceDescriptions.users || typeof settings.characterReferenceDescriptions.users !== 'object') {
        settings.characterReferenceDescriptions.users = {};
    }
    if (!settings.characterReferenceDescriptions.displayNames || typeof settings.characterReferenceDescriptions.displayNames !== 'object') {
        settings.characterReferenceDescriptions.displayNames = {};
    }
    if (!settings.characterReferenceDescriptions.displayNames.characters || typeof settings.characterReferenceDescriptions.displayNames.characters !== 'object') {
        settings.characterReferenceDescriptions.displayNames.characters = {};
    }
    if (!settings.characterReferenceDescriptions.displayNames.users || typeof settings.characterReferenceDescriptions.displayNames.users !== 'object') {
        settings.characterReferenceDescriptions.displayNames.users = {};
    }
    return settings.characterReferenceDescriptions;
}

function normalizeReferenceDescription(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

export function getCharacterReferenceDescriptionStore(settings = getSettings()) {
    return ensureCharacterReferenceDescriptionStore(settings);
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
        if (characterId === undefined || characterId === null) {
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
            if (activeAvatarId) return `persona:${activeAvatarId}`;
        } catch (_error) {
            // Fall back to selected avatar below.
        }
    }
    const avatarFile = String(settings.userAvatarFile || '').trim();
    return getUserReferenceKeyForAvatar(avatarFile);
}

export function getCharacterReferenceDescription(settings = getSettings()) {
    const store = ensureCharacterReferenceDescriptionStore(settings);
    return String(store.characters[getCurrentCharacterReferenceKey()] || '');
}

export function setCharacterReferenceDescription(value, settings = getSettings()) {
    setCharacterReferenceDescriptionForKey(getCurrentCharacterReferenceKey(), value, settings);
}

export function setCharacterReferenceDescriptionForKey(key, value, settings = getSettings()) {
    const store = ensureCharacterReferenceDescriptionStore(settings);
    store.characters[String(key || 'no-character')] = String(value || '');
    saveSettings();
}

export async function getUserReferenceDescription(settings = getSettings()) {
    const store = ensureCharacterReferenceDescriptionStore(settings);
    const key = await getCurrentUserReferenceKey(settings);
    return String(store.users[key] || '');
}

export async function setUserReferenceDescription(value, settings = getSettings()) {
    const key = await getCurrentUserReferenceKey(settings);
    setUserReferenceDescriptionForKey(key, value, settings);
}

export function setUserReferenceDescriptionForKey(key, value, settings = getSettings()) {
    const store = ensureCharacterReferenceDescriptionStore(settings);
    store.users[String(key || 'no-user-avatar')] = String(value || '');
    saveSettings();
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

// ----- Character avatar (base64 / dataUrl) -----

export async function getCharacterAvatarBase64() {
    try {
        const context = SillyTavern.getContext();

        console.log('[IIG] Getting character avatar, characterId:', context.characterId);

        if (context.characterId === undefined || context.characterId === null) {
            console.log('[IIG] No character selected');
            return null;
        }

        // Try context method first
        if (typeof context.getCharacterAvatar === 'function') {
            const avatarUrl = context.getCharacterAvatar(context.characterId);
            console.log('[IIG] getCharacterAvatar returned:', avatarUrl);
            if (avatarUrl) {
                return await imageUrlToBase64(avatarUrl);
            }
        }

        // Fallback: try to get from characters array
        const character = context.characters?.[context.characterId];
        console.log('[IIG] Character from array:', character?.name, 'avatar:', character?.avatar);
        if (character?.avatar) {
            const avatarUrl = `/characters/${encodeURIComponent(character.avatar)}`;
            console.log('[IIG] Found character avatar:', avatarUrl);
            return await imageUrlToBase64(avatarUrl);
        }

        console.log('[IIG] Could not get character avatar');
        return null;
    } catch (error) {
        console.error('[IIG] Error getting character avatar:', error);
        return null;
    }
}

export async function getCharacterAvatarDataUrl() {
    try {
        const context = SillyTavern.getContext();

        if (context.characterId === undefined || context.characterId === null) {
            return null;
        }

        if (typeof context.getCharacterAvatar === 'function') {
            const avatarUrl = context.getCharacterAvatar(context.characterId);
            if (avatarUrl) {
                return await imageUrlToDataUrl(avatarUrl);
            }
        }

        const character = context.characters?.[context.characterId];
        if (character?.avatar) {
            const avatarUrl = `/characters/${encodeURIComponent(character.avatar)}`;
            return await imageUrlToDataUrl(avatarUrl);
        }

        return null;
    } catch (error) {
        console.error('[IIG] Error getting character avatar data URL:', error);
        return null;
    }
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

export async function getUserAvatarBase64() {
    try {
        const avatarUrl = await getSelectedUserAvatarUrl();
        if (!avatarUrl) {
            return null;
        }
        return await imageUrlToBase64(avatarUrl);
    } catch (error) {
        console.error('[IIG] Error getting user avatar:', error);
        return null;
    }
}

export async function getUserAvatarDataUrl() {
    try {
        const avatarUrl = await getSelectedUserAvatarUrl();
        if (!avatarUrl) {
            return null;
        }
        return await imageUrlToDataUrl(avatarUrl);
    } catch (error) {
        console.error('[IIG] Error getting user avatar data URL:', error);
        return null;
    }
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

export function buildAdditionalReferenceRowsHtml(settings = getSettings()) {
    const refs = ensureAdditionalReferencesArray(settings);

    if (refs.length === 0) {
        return '<p class="hint">Пока пусто. Добавь референс с именем-триггером и картинкой.</p>';
    }

    const lastIndex = refs.length - 1;
    return refs.map((ref, index) => {
        const previewSrc = normalizeStoredImagePath(ref.imagePath);
        const isAlways = ref.matchMode === 'always';
        const isEnabled = ref.enabled !== false;
        const useRegex = ref.useRegex === true;
        const previewHtml = previewSrc
            ? `<img src="${sanitizeForHtml(previewSrc)}" alt="${sanitizeForHtml(ref.name || `ref-${index + 1}`)}" class="iig-additional-ref-thumb">`
            : `<div class="iig-additional-ref-thumb iig-additional-ref-thumb-placeholder">${t`none`}</div>`;

        const isFirst = index === 0;
        const isLast = index === lastIndex;

        return `
            <div class="iig-additional-ref-row ${isEnabled ? '' : 'iig-additional-ref-row-disabled'}" data-ref-index="${index}">
                <div class="iig-additional-ref-content">
                    <div class="iig-additional-ref-preview">
                        ${previewHtml}
                        <label class="checkbox_label iig-additional-ref-enabled-toggle" title="${isEnabled ? t`Disable reference` : t`Enable reference`}">
                            <input type="checkbox" class="iig-additional-ref-enabled" ${isEnabled ? 'checked' : ''}>
                            <span></span>
                        </label>
                    </div>
                    <div class="iig-additional-ref-main">
                        <div class="iig-additional-ref-header">
                            <input
                                type="text"
                                class="text_pole flex1 iig-additional-ref-name"
                                placeholder="${t`Trigger name (or regex)`}"
                                value="${sanitizeForHtml(ref.name || '')}"
                            >
                            <label class="menu_button iig-additional-ref-upload" title="${t`Upload image`}">
                                <i class="fa-solid fa-upload"></i>
                                <input type="file" accept="image/*" class="iig-additional-ref-file" style="display:none">
                            </label>
                            <div class="menu_button iig-additional-ref-upload-url" title="${t`Upload image by URL`}">
                                <i class="fa-solid fa-link"></i>
                            </div>
                            <div class="menu_button iig-additional-ref-remove" title="${t`Delete`}">
                                <i class="fa-solid fa-trash"></i>
                            </div>
                        </div>
                        <textarea
                            class="text_pole flex1 iig-additional-ref-description"
                            rows="2"
                            placeholder="${t`Reference description`}"
                        >${sanitizeForHtml(ref.description || '')}</textarea>
                        <div class="iig-additional-ref-lorebook-grid">
                            <input
                                type="text"
                                class="text_pole iig-additional-ref-group"
                                placeholder="${t`Group (e.g. characters, locations)`}"
                                value="${sanitizeForHtml(ref.group || '')}"
                            >
                            <input
                                type="text"
                                class="text_pole iig-additional-ref-secondary"
                                placeholder="${t`Secondary keys (AND, comma-separated)`}"
                                value="${sanitizeForHtml(ref.secondaryKeys || '')}"
                            >
                            <input
                                type="number"
                                class="text_pole iig-additional-ref-priority"
                                placeholder="${t`Priority`}"
                                step="1"
                                value="${Number.isFinite(ref.priority) ? ref.priority : 0}"
                                title="${t`Higher priority is matched first when provider limits references`}"
                            >
                        </div>
                        <div class="iig-additional-ref-footer">
                            <label class="checkbox_label">
                                <input type="checkbox" class="iig-additional-ref-always" ${isAlways ? 'checked' : ''}>
                                <span>${isAlways ? t`Always send` : t`Send on match`}</span>
                            </label>
                            <label class="checkbox_label" title="${t`Interpret trigger as JS regex (e.g. /cat|kitten/i). Secondary keys remain literal.`}">
                                <input type="checkbox" class="iig-additional-ref-regex" ${useRegex ? 'checked' : ''}>
                                <span>${t`Regex`}</span>
                            </label>
                            <div class="iig-additional-ref-move">
                                <div class="menu_button iig-additional-ref-move-up ${isFirst ? 'disabled' : ''}" title="${t`Move up`}" ${isFirst ? 'aria-disabled="true"' : ''}>
                                    <i class="fa-solid fa-arrow-up"></i>
                                </div>
                                <div class="menu_button iig-additional-ref-move-down ${isLast ? 'disabled' : ''}" title="${t`Move down`}" ${isLast ? 'aria-disabled="true"' : ''}>
                                    <i class="fa-solid fa-arrow-down"></i>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
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

    const refs = ensureAdditionalReferencesArray().filter((ref) => String(ref?.name || '').trim() && String(ref?.imagePath || '').trim());
    const enabledRefs = refs.filter((ref) => ref.enabled !== false);
    const alwaysCount = enabledRefs.filter((ref) => ref.matchMode === 'always').length;
    const parts = [];
    if (refs.length > 0) {
        parts.push(t`Active additional references: ${enabledRefs.length}/${refs.length}. Always sent: ${alwaysCount}.`);
    }
    if (providerMaxRefs > 0 && enabledRefs.length > providerMaxRefs) {
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
export function renderAdditionalReferencesList(providerMaxRefs = 0) {
    const container = document.getElementById('iig_additional_refs_list');
    if (!container) {
        return;
    }

    container.innerHTML = buildAdditionalReferenceRowsHtml();
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
    const refs = ensureAdditionalReferencesArray(settings);
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

    for (let index = 0; index < queue.length; index++) {
        const url = queue[index];
        const name = getReferenceNameFromUrl(url, refs.length + index);
        const imagePath = await downloadReferenceImageFromUrl(url, {
            mode: 'additional-reference-import',
            refIndex: refs.length + index,
            refName: name,
        });

        refs.push({
            name,
            description: '',
            imagePath,
            matchMode: 'match',
            enabled: true,
        });
        importedNames.push(name);
    }

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
