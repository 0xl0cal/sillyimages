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
    normalizeImageContextCount,
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

// ----- Модульное состояние (раньше были module-level let) -----

const PERSONAS_MODULE_PATHS = Object.freeze([
    '/scripts/personas.js',
    '../../../personas.js',
]);

let personasModulePromise = null;
let cachedUserAvatars = [];

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

    return refs.map((ref, index) => {
        const previewSrc = normalizeStoredImagePath(ref.imagePath);
        const isAlways = ref.matchMode === 'always';
        const isEnabled = ref.enabled !== false;
        const previewHtml = previewSrc
            ? `<img src="${sanitizeForHtml(previewSrc)}" alt="${sanitizeForHtml(ref.name || `ref-${index + 1}`)}" class="iig-additional-ref-thumb">`
            : '<div class="iig-additional-ref-thumb iig-additional-ref-thumb-placeholder">нет</div>';

        return `
            <div class="iig-additional-ref-row ${isEnabled ? '' : 'iig-additional-ref-row-disabled'}" data-ref-index="${index}">
                <div class="iig-additional-ref-content">
                    <div class="iig-additional-ref-preview">
                        ${previewHtml}
                        <label class="checkbox_label iig-additional-ref-enabled-toggle" title="${isEnabled ? 'Выключить референс' : 'Включить референс'}">
                            <input type="checkbox" class="iig-additional-ref-enabled" ${isEnabled ? 'checked' : ''}>
                            <span></span>
                        </label>
                    </div>
                    <div class="iig-additional-ref-main">
                        <div class="iig-additional-ref-header">
                            <input
                                type="text"
                                class="text_pole flex1 iig-additional-ref-name"
                                placeholder="Имя референса"
                                value="${sanitizeForHtml(ref.name || '')}"
                            >
                            <label class="menu_button iig-additional-ref-upload" title="Загрузить картинку">
                                <i class="fa-solid fa-upload"></i>
                                <input type="file" accept="image/*" class="iig-additional-ref-file" style="display:none">
                            </label>
                            <div class="menu_button iig-additional-ref-remove" title="Удалить">
                                <i class="fa-solid fa-trash"></i>
                            </div>
                        </div>
                        <textarea
                            class="text_pole flex1 iig-additional-ref-description"
                            rows="2"
                            placeholder="Описание референса"
                        >${sanitizeForHtml(ref.description || '')}</textarea>
                        <div class="iig-additional-ref-footer">
                            <label class="checkbox_label">
                                <input type="checkbox" class="iig-additional-ref-always" ${isAlways ? 'checked' : ''}>
                                <span>${isAlways ? 'Отправлять всегда' : 'Отправлять по совпадению'}</span>
                            </label>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

export function renderAdditionalReferencesList() {
    const container = document.getElementById('iig_additional_refs_list');
    if (!container) {
        return;
    }

    container.innerHTML = buildAdditionalReferenceRowsHtml();

    const status = document.getElementById('iig_additional_refs_status');
    if (status) {
        const refs = ensureAdditionalReferencesArray().filter((ref) => String(ref?.name || '').trim() && String(ref?.imagePath || '').trim());
        const enabledRefs = refs.filter((ref) => ref.enabled !== false);
        const alwaysCount = enabledRefs.filter((ref) => ref.matchMode === 'always').length;
        status.textContent = refs.length > 0
            ? `Активных доп. референсов: ${enabledRefs.length}/${refs.length}. Всегда отправляются: ${alwaysCount}.`
            : '';
    }
}

// ----- Additional references import modal -----

export function buildReferenceImportModalHtml() {
    return `
        <div id="iig_ref_import_modal" class="iig-modal iig-hidden" aria-hidden="true">
            <div class="iig-modal-backdrop" data-iig-modal-close="true"></div>
            <div class="iig-modal-card" role="dialog" aria-modal="true" aria-labelledby="iig_ref_import_title">
                <div class="iig-modal-header">
                    <h4 id="iig_ref_import_title">Загрузить референс по ссылке</h4>
                    <div id="iig_ref_import_close" class="menu_button" title="Закрыть">
                        <i class="fa-solid fa-xmark"></i>
                    </div>
                </div>
                <textarea
                    id="iig_ref_import_urls"
                    class="text_pole iig-modal-textarea"
                    rows="6"
                    placeholder="Одна ссылка на строку"
                ></textarea>
                <div class="iig-modal-actions">
                    <div id="iig_ref_import_submit" class="menu_button iig-button-inline">
                        <i class="fa-solid fa-plus"></i> Добавить
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

export async function importAdditionalReferencesFromUrls(rawValue) {
    const settings = getSettings();
    const refs = ensureAdditionalReferencesArray(settings);
    const urls = normalizeReferenceUrlList(rawValue);
    if (urls.length === 0) {
        throw new Error('Добавьте хотя бы одну ссылку');
    }

    const availableSlots = MAX_ADDITIONAL_REFERENCES - refs.length;
    if (availableSlots <= 0) {
        throw new Error(`Достигнут лимит референсов: ${MAX_ADDITIONAL_REFERENCES}`);
    }

    const queue = urls.slice(0, availableSlots);
    const importedNames = [];

    for (let index = 0; index < queue.length; index++) {
        const url = queue[index];
        const dataUrl = await imageUrlToDataUrl(url);
        if (!dataUrl) {
            throw new Error(`Не удалось загрузить изображение: ${url}`);
        }

        const name = getReferenceNameFromUrl(url, refs.length + index);
        const savedPath = await saveImageToFile(dataUrl, {
            mode: 'additional-reference-import',
            sourceUrl: url,
            refIndex: refs.length + index,
            refName: name,
        });

        refs.push({
            name,
            description: '',
            imagePath: normalizeStoredImagePath(savedPath),
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
