/** Avatar catalog requests and synchronized provider picker controls. */
import { getSettings, saveSettings } from './settings.js';
import { fetchWithTimeout, sanitizeForHtml } from './utils.js';

let cachedUserAvatars = [];
let userAvatarsRequest = null;

// ----- Fetch user avatars from ST -----

export function fetchUserAvatars() {
    if (!userAvatarsRequest) {
        userAvatarsRequest = requestUserAvatars().finally(() => { userAvatarsRequest = null; });
    }
    return userAvatarsRequest;
}

async function requestUserAvatars() {
    try {
        const context = SillyTavern.getContext();
        const payload = await fetchWithTimeout('/api/avatars/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
        }, 15000, null, response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        });
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
    // Even redundant class writes wake DOM observers on unrelated settings clicks.
    for (const dropdown of document.querySelectorAll('#iig_settings_root .iig-avatar-dropdown.open')) {
        dropdown.classList.remove('open');
    }
}

export function renderUserAvatarDropdownList(listElement, avatars, selectedAvatar) {
    if (!listElement) {
        return;
    }

    const items = Array.from(listElement.children);
    if (items.length === avatars.length && items.every((item, index) => (
        item.classList.contains('iig-avatar-dropdown-item') && item.dataset.value === avatars[index]
    ))) {
        for (const item of items) {
            const selected = item.dataset.value === selectedAvatar;
            if (item.classList.contains('selected') !== selected) item.classList.toggle('selected', selected);
        }
        return;
    }

    const fragment = document.createDocumentFragment();
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
        fragment.appendChild(item);
    }
    listElement.replaceChildren(fragment);
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

export async function refreshUserAvatarSelects() {
    const avatars = await fetchUserAvatars();
    syncUserAvatarSelection(getSettings().userAvatarFile);
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
