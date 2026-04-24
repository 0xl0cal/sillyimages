/**
 * Рендеринг секций настроек и биндинг всех UI-обработчиков.
 *
 * Разделено на секции:
 *   - API (провайдер / endpoint / apiKey / model / параметры генерации)
 *   - Стили
 *   - Референсы (avatar-виджеты и additional references)
 *   - Отладка (retries / export logs)
 *
 * Фабрика `bindAvatarSectionEvents` заменяет дубликат обработчиков Gemini
 * и Naistera (раньше было два блока идентичного кода).
 */

import {
    getSettings,
    saveSettings,
    exportLogs,
    iigLog,
    ensureStyles,
    getActiveStyle,
    createStyle,
    updateStyle,
    removeStyle,
    ensureAdditionalReferencesArray,
    ensureLorebooks,
    getActiveLorebook,
    createLorebook,
    renameLorebook,
    removeLorebook,
    setLorebookEnabled,
    setActiveLorebook,
    DEFAULT_REF_INSTRUCTION,
    getLastRequestSnapshot,
    normalizeNaisteraModel,
    normalizeNaisteraVideoFrequency,
    normalizeImageContextCount,
    normalizeConfiguredEndpoint,
    shouldReplaceEndpointForApiType,
    getEndpointPlaceholder,
    MAX_CONTEXT_IMAGES,
    MAX_ADDITIONAL_REFERENCES,
    ensureConnectionProfiles,
    getActiveConnectionProfile,
    createConnectionProfile,
    saveCurrentIntoProfile,
    loadConnectionProfile,
    renameConnectionProfile,
    removeConnectionProfile,
} from './settings.js';
import {
    normalizeStoredImagePath,
    readFileAsDataUrl,
    saveImageToFile,
    sanitizeForHtml,
} from './utils.js';
import {
    buildAdditionalReferenceRowsHtml,
    renderAdditionalReferencesList,
    renderAdditionalReferencesStatus,
    buildUserAvatarDropdownControl,
    buildReferenceImportModalHtml,
    syncUserAvatarSelection,
    syncActivePersonaAvatarMode,
    refreshUserAvatarSelects,
    getUserAvatarDropdownConfigs,
    closeUserAvatarDropdowns,
    openReferenceImportModal,
    closeReferenceImportModal,
    importAdditionalReferencesFromUrls,
    downloadReferenceImageFromUrl,
    buildLorebookExportJson,
    lorebookFileNameFromTitle,
    triggerBrowserDownload,
    importLorebookFromUrl,
    importLorebookFromFile,
} from './references.js';
import { isGeminiModel, fetchModels, resolveActiveProvider, getActiveProviderMaxReferences } from './providers.js';
import { t } from './i18n.js';
// Относительный путь: /scripts/extensions/third-party/sillyimages/src/ui.js → /scripts/popup.js
import { Popup } from '../../../../popup.js';

// ----- Section wrapper -----

function buildSettingsSectionHtml(sectionId, title, bodyHtml, expanded = true) {
    return `
        <div class="iig-section" data-section-id="${sectionId}">
            <div class="iig-section-toggle" data-section-toggle="${sectionId}">
                <span class="iig-section-title">${title}</span>
                <i class="fa-solid fa-chevron-down iig-section-chevron ${expanded ? '' : 'iig-section-chevron-collapsed'}"></i>
            </div>
            <div class="iig-section-body ${expanded ? '' : 'iig-hidden'}" id="${sectionId}">
                ${bodyHtml}
            </div>
        </div>
    `;
}

// ----- API section -----

function buildConnectionProfilesBlockHtml(settings = getSettings()) {
    const profiles = ensureConnectionProfiles(settings);
    const activeId = settings.activeConnectionProfileId;
    const optionsHtml = profiles.map((p) =>
        `<option value="${sanitizeForHtml(p.id)}" ${p.id === activeId ? 'selected' : ''}>${sanitizeForHtml(p.name)}</option>`,
    ).join('');
    return `
        <div class="iig-settings-card-nested iig-profile-bar">
            <div class="flex-row">
                <label for="iig_profile_select">${t`Profile`}</label>
                <select id="iig_profile_select" class="flex1">
                    ${optionsHtml || `<option value="">${t`(no profiles)`}</option>`}
                </select>
                <div class="iig-profile-buttons">
                    <div id="iig_profile_save" class="menu_button" title="${t`Save current settings into active profile`}">
                        <i class="fa-solid fa-floppy-disk"></i>
                    </div>
                    <div id="iig_profile_save_as" class="menu_button" title="${t`Save as new profile`}">
                        <i class="fa-solid fa-plus"></i>
                    </div>
                    <div id="iig_profile_rename" class="menu_button" title="${t`Rename active profile`}">
                        <i class="fa-solid fa-pen"></i>
                    </div>
                    <div id="iig_profile_remove" class="menu_button" title="${t`Delete active profile`}">
                        <i class="fa-solid fa-trash"></i>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function buildApiSettingsSectionHtml(settings = getSettings()) {
    const profilesHtml = buildConnectionProfilesBlockHtml(settings);
    const bodyHtml = `
        <div class="iig-settings-card">
            ${profilesHtml}
            <label class="checkbox_label">
                <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                <span>${t`Enable image generation`}</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="iig_external_blocks" ${settings.externalBlocks ? 'checked' : ''}>
                <span>${t`Process external blocks`}</span>
            </label>

            <div class="flex-row">
                <label for="iig_api_type">${t`API type`}</label>
                <select id="iig_api_type" class="flex1">
                    <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>${t`OpenAI-compatible (/v1/images/generations)`}</option>
                    <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>${t`Gemini-compatible (nano-banana)`}</option>
                    <option value="openrouter" ${settings.apiType === 'openrouter' ? 'selected' : ''}>${t`OpenRouter (chat/completions)`}</option>
                    <option value="electronhub" ${settings.apiType === 'electronhub' ? 'selected' : ''}>${t`Electron Hub (/v1/images/*)`}</option>
                    <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>${t`Naistera (naistera.org)`}</option>
                </select>
                <div></div>
            </div>

            <div class="flex-row">
                <label for="iig_endpoint">${t`Endpoint URL`}</label>
                <input type="text" id="iig_endpoint" class="text_pole flex1" value="${settings.endpoint}" placeholder="https://api.example.com">
                <div></div>
            </div>

            <label class="checkbox_label" title="${t`Use endpoint URL as-is: do not append /v1/images/generations, /chat/completions, etc. Model list refresh is disabled — enter model name manually.`}">
                <input type="checkbox" id="iig_raw_endpoint" ${settings.rawEndpoint ? 'checked' : ''}>
                <span>${t`Raw endpoint (do not append paths)`}</span>
            </label>

            <div class="flex-row">
                <label for="iig_api_key">${t`API key`}</label>
                <input type="password" id="iig_api_key" class="text_pole flex1" value="${settings.apiKey}">
                <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="${t`Show / hide`}">
                    <i class="fa-solid fa-eye"></i>
                </div>
            </div>

            <p id="iig_naistera_hint" class="hint ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}">${t`For Naistera: paste the token from the Telegram bot and pick a model (grok / grok-pro / nano banana 2 / novelai).`}</p>

            <div class="flex-row ${settings.apiType === 'naistera' ? 'iig-hidden' : ''}" id="iig_model_row">
                <label for="iig_model">${t`Model`}</label>
                <input type="text" id="iig_model" class="text_pole flex1" list="iig_model_list" value="${sanitizeForHtml(settings.model || '')}" placeholder="${t`-- Select or type a model --`}">
                <datalist id="iig_model_list"></datalist>
                <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="${t`Refresh list`}">
                    <i class="fa-solid fa-sync"></i>
                </div>
            </div>

            <div class="flex-row ${settings.apiType !== 'openai' && settings.apiType !== 'electronhub' ? 'iig-hidden' : ''}" id="iig_size_row">
                <label for="iig_size">${t`Size`}</label>
                <select id="iig_size" class="flex1">
                    <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>${t`1024x1024 (Square)`}</option>
                    <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>${t`1792x1024 (Landscape)`}</option>
                    <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>${t`1024x1792 (Portrait)`}</option>
                    <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>${t`512x512 (Small)`}</option>
                </select>
                <div></div>
            </div>

            <div class="flex-row ${settings.apiType !== 'openai' && settings.apiType !== 'electronhub' ? 'iig-hidden' : ''}" id="iig_quality_row">
                <label for="iig_quality">${t`Quality`}</label>
                <select id="iig_quality" class="flex1">
                    <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>${t`Standard`}</option>
                    <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>${t`HD`}</option>
                </select>
                <div></div>
            </div>

            <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_model_row">
                <label for="iig_naistera_model">${t`Model`}</label>
                <select id="iig_naistera_model" class="flex1">
                    <option value="grok" ${normalizeNaisteraModel(settings.naisteraModel) === 'grok' ? 'selected' : ''}>grok</option>
                    <option value="grok-pro" ${normalizeNaisteraModel(settings.naisteraModel) === 'grok-pro' ? 'selected' : ''}>grok-pro</option>
                    <option value="nano banana 2" ${normalizeNaisteraModel(settings.naisteraModel) === 'nano banana 2' ? 'selected' : ''}>nano banana 2</option>
                    <option value="novelai" ${normalizeNaisteraModel(settings.naisteraModel) === 'novelai' ? 'selected' : ''}>novelai</option>
                </select>
                <div></div>
            </div>

            <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_aspect_row">
                <label for="iig_naistera_aspect_ratio">${t`Aspect ratio`}</label>
                <select id="iig_naistera_aspect_ratio" class="flex1">
                    <option value="1:1" ${settings.naisteraAspectRatio === '1:1' ? 'selected' : ''}>1:1</option>
                    <option value="16:9" ${settings.naisteraAspectRatio === '16:9' ? 'selected' : ''}>16:9</option>
                    <option value="9:16" ${settings.naisteraAspectRatio === '9:16' ? 'selected' : ''}>9:16</option>
                    <option value="3:2" ${settings.naisteraAspectRatio === '3:2' ? 'selected' : ''}>3:2</option>
                    <option value="2:3" ${settings.naisteraAspectRatio === '2:3' ? 'selected' : ''}>2:3</option>
                </select>
                <div></div>
            </div>

            <div id="iig_avatar_section" class="iig-settings-card-nested ${settings.apiType !== 'gemini' && settings.apiType !== 'openrouter' ? 'iig-hidden' : ''}">
                <div class="flex-row">
                    <label for="iig_aspect_ratio">${t`Aspect ratio`}</label>
                    <select id="iig_aspect_ratio" class="flex1">
                        <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>${t`1:1 (Square)`}</option>
                        <option value="2:3" ${settings.aspectRatio === '2:3' ? 'selected' : ''}>${t`2:3 (Portrait)`}</option>
                        <option value="3:2" ${settings.aspectRatio === '3:2' ? 'selected' : ''}>${t`3:2 (Landscape)`}</option>
                        <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>${t`3:4 (Portrait)`}</option>
                        <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>${t`4:3 (Landscape)`}</option>
                        <option value="4:5" ${settings.aspectRatio === '4:5' ? 'selected' : ''}>${t`4:5 (Portrait)`}</option>
                        <option value="5:4" ${settings.aspectRatio === '5:4' ? 'selected' : ''}>${t`5:4 (Landscape)`}</option>
                        <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>${t`9:16 (Vertical)`}</option>
                        <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>${t`16:9 (Wide)`}</option>
                        <option value="21:9" ${settings.aspectRatio === '21:9' ? 'selected' : ''}>${t`21:9 (Ultra-wide)`}</option>
                    </select>
                    <div></div>
                </div>
                <div class="flex-row">
                    <label for="iig_image_size">${t`Resolution`}</label>
                    <select id="iig_image_size" class="flex1">
                        <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>${t`1K (default)`}</option>
                        <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K</option>
                        <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K</option>
                    </select>
                    <div></div>
                </div>
            </div>

            <div class="iig-settings-card-nested ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_video_section">
                <h4>${t`Video`}</h4>
                <label class="checkbox_label">
                    <input type="checkbox" id="iig_naistera_video_test" ${settings.naisteraVideoTest ? 'checked' : ''}>
                    <span>${t`Enable video generation`}</span>
                </label>
                <div class="iig-video-frequency-row ${settings.naisteraVideoTest ? '' : 'iig-hidden'}" id="iig_naistera_video_frequency_row">
                    <div class="iig-video-frequency-input">
                        <span>${t`Every`}</span>
                        <input type="number" id="iig_naistera_video_every_n" class="text_pole" min="1" max="999" step="1" value="${normalizeNaisteraVideoFrequency(settings.naisteraVideoEveryN)}">
                        <span>${t`messages.`}</span>
                    </div>
                </div>
            </div>
        </div>
    `;
    return buildSettingsSectionHtml('iig_api_section', t`API settings`, bodyHtml, true);
}

// ----- Styles section -----

function buildStyleListHtml(settings = getSettings()) {
    const styles = ensureStyles(settings);
    const activeId = settings.activeStyleId;

    if (styles.length === 0) {
        return `<p class="hint">${t`No styles. Add a style and activate it.`}</p>`;
    }

    return styles.map((style) => `
        <div class="iig-style-preset-row ${style.id === activeId ? 'iig-style-preset-row-active' : ''}" data-style-id="${style.id}">
            <div class="menu_button iig-style-preset-select" data-style-activate="${style.id}">
                <i class="fa-solid ${style.id === activeId ? 'fa-check-circle' : 'fa-palette'}"></i>
                <span>${sanitizeForHtml(style.name)}</span>
            </div>
            <div class="menu_button iig-style-preset-remove" data-style-remove="${style.id}" title="${t`Delete style`}">
                <i class="fa-solid fa-trash"></i>
            </div>
        </div>
    `).join('');
}

function buildStyleEditorHtml(settings = getSettings()) {
    const activeStyle = getActiveStyle(settings);
    if (!activeStyle) {
        return `<p class="hint">${t`Activate a style to edit its value.`}</p>`;
    }

    return `
        <div class="iig-settings-card iig-style-editor-card">
            <h4>${t`Active style`}: ${sanitizeForHtml(activeStyle.name)}</h4>
            <div class="flex-row">
                <label for="iig_style_name">${t`Name`}</label>
                <input type="text" id="iig_style_name" class="text_pole flex1" value="${sanitizeForHtml(activeStyle.name)}">
                <div id="iig_style_disable" class="menu_button" title="${t`Disable style`}">
                    <i class="fa-solid fa-power-off"></i>
                </div>
            </div>
            <div class="flex-row">
                <label for="iig_style_value">${t`Value`}</label>
                <textarea id="iig_style_value" class="text_pole flex1 iig-settings-textarea" rows="3" placeholder="masterpiece, cinematic lighting, painterly">${sanitizeForHtml(activeStyle.value)}</textarea>
                <div></div>
            </div>
        </div>
    `;
}

export function renderStyleSettings() {
    const settings = getSettings();
    const listContainer = document.getElementById('iig_style_presets');
    const editorContainer = document.getElementById('iig_style_editor');
    if (listContainer) {
        listContainer.innerHTML = buildStyleListHtml(settings);
    }
    if (editorContainer) {
        editorContainer.innerHTML = buildStyleEditorHtml(settings);
    }
}

function buildStylesSettingsSectionHtml() {
    const bodyHtml = `
        <div class="iig-settings-card">
            <div class="flex-row">
                <label for="iig_new_style_name">${t`New style`}</label>
                <input type="text" id="iig_new_style_name" class="text_pole flex1" placeholder="${t`Style name`}">
                <div id="iig_style_add" class="menu_button" title="${t`Add style`}">
                    <i class="fa-solid fa-plus"></i>
                </div>
            </div>
            <div id="iig_style_presets" class="iig-style-presets"></div>
            <div id="iig_style_editor"></div>
        </div>
    `;
    return buildSettingsSectionHtml('iig_styles_section', t`Styles`, bodyHtml, false);
}

// ----- References section -----

/**
 * Общая разметка одной "avatar references" подсекции.
 * Раньше в buildReferencesSettingsSectionHtml был дубликат этого блока
 * для Gemini и для Naistera. Теперь — одна фабрика.
 */
function buildAvatarReferencesBlockHtml({
    sectionId,
    hiddenClass,
    hidden,
    title,
    sendCharCheckboxId,
    sendCharEnabled,
    sendUserCheckboxId,
    sendUserEnabled,
    useActivePersonaRowId,
    useActivePersonaCheckboxId,
    useActivePersonaRowHidden,
    useActivePersonaHiddenClass,
    useActivePersonaEnabled,
    userAvatarRowId,
    userAvatarRowHidden,
    userAvatarRowHiddenClass,
    userAvatarDropdownHtml,
    refreshButtonId,
}) {
    return `
        <div id="${sectionId}" class="iig-settings-card-nested ${hidden ? hiddenClass : ''}">
            <h4>${title}</h4>
            <label class="checkbox_label">
                <input type="checkbox" id="${sendCharCheckboxId}" ${sendCharEnabled ? 'checked' : ''}>
                <span>${t`Send {{char}} avatar`}</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="${sendUserCheckboxId}" ${sendUserEnabled ? 'checked' : ''}>
                <span>${t`Send {{user}} avatar`}</span>
            </label>
            <label id="${useActivePersonaRowId}" class="checkbox_label ${useActivePersonaRowHidden ? useActivePersonaHiddenClass : ''}">
                <input type="checkbox" id="${useActivePersonaCheckboxId}" ${useActivePersonaEnabled ? 'checked' : ''}>
                <span>${t`Use avatar from active {{user}} persona`}</span>
            </label>
            <div id="${userAvatarRowId}" class="flex-row ${userAvatarRowHidden ? userAvatarRowHiddenClass : ''}">
                <label>${t`{{user}} avatar`}</label>
                ${userAvatarDropdownHtml}
                <div id="${refreshButtonId}" class="menu_button iig-refresh-btn" title="${t`Refresh list`}">
                    <i class="fa-solid fa-sync"></i>
                </div>
            </div>
        </div>
    `;
}

function buildLorebookBarHtml(settings = getSettings()) {
    const lorebooks = ensureLorebooks(settings);
    const activeId = settings.activeLorebookId;
    const active = getActiveLorebook(settings);
    const optionsHtml = lorebooks.map((lb) =>
        `<option value="${sanitizeForHtml(lb.id)}" ${lb.id === activeId ? 'selected' : ''}>${sanitizeForHtml(lb.name)}${lb.enabled === false ? ' ' + t`(off)` : ''}</option>`,
    ).join('');
    return `
        <div class="iig-lorebook-bar">
            <div class="flex-row">
                <label for="iig_lorebook_select">${t`Lorebook`}</label>
                <select id="iig_lorebook_select" class="flex1">
                    ${optionsHtml}
                </select>
                <div class="iig-lorebook-buttons">
                    <label class="checkbox_label" title="${t`Include this lorebook in matching`}">
                        <input type="checkbox" id="iig_lorebook_enabled" ${active?.enabled !== false ? 'checked' : ''}>
                        <span>${t`On`}</span>
                    </label>
                    <div id="iig_lorebook_add" class="menu_button" title="${t`Create new lorebook`}">
                        <i class="fa-solid fa-plus"></i>
                    </div>
                    <div id="iig_lorebook_rename" class="menu_button" title="${t`Rename lorebook`}">
                        <i class="fa-solid fa-pen"></i>
                    </div>
                    <div id="iig_lorebook_import_url" class="menu_button" title="${t`Import lorebook from URL`}">
                        <i class="fa-solid fa-link"></i>
                    </div>
                    <label class="menu_button iig-lorebook-import-file" title="${t`Import lorebook from local file`}">
                        <i class="fa-solid fa-file-arrow-down"></i>
                        <input type="file" accept="application/json,.json" id="iig_lorebook_import_file_input" style="display:none">
                    </label>
                    <div id="iig_lorebook_export" class="menu_button" title="${t`Export current lorebook as JSON`}">
                        <i class="fa-solid fa-file-arrow-up"></i>
                    </div>
                    <div id="iig_lorebook_remove" class="menu_button" title="${t`Delete lorebook`}">
                        <i class="fa-solid fa-trash"></i>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function buildReferencesSettingsSectionHtml(settings = getSettings()) {
    const provider = resolveActiveProvider(settings);
    const refsSupported = provider ? provider.supportsReferences(settings) : false;
    const isGemini = settings.apiType === 'gemini';
    const isOpenAI = settings.apiType === 'openai';
    const isOpenRouter = settings.apiType === 'openrouter';
    const isElectronHub = settings.apiType === 'electronhub';
    const commonAvatarRefsVisible = (isGemini || isOpenAI || isOpenRouter || isElectronHub) && refsSupported;
    const naisteraRefsVisible = settings.apiType === 'naistera' && refsSupported;

    // Заголовок секции аватаров — по активному провайдеру. Provider-brand
    // имена не локализуются.
    let avatarRefsTitle;
    if (isOpenRouter) avatarRefsTitle = 'OpenRouter';
    else if (isElectronHub) avatarRefsTitle = 'Electron Hub';
    else if (isOpenAI) avatarRefsTitle = 'OpenAI / GPT Image';
    else avatarRefsTitle = 'Gemini / nano-banana';

    const geminiAvatarsBlock = buildAvatarReferencesBlockHtml({
        sectionId: 'iig_avatar_refs_section',
        hiddenClass: 'iig-hidden',
        hidden: !commonAvatarRefsVisible,
        title: avatarRefsTitle,
        sendCharCheckboxId: 'iig_send_char_avatar',
        sendCharEnabled: settings.sendCharAvatar,
        sendUserCheckboxId: 'iig_send_user_avatar',
        sendUserEnabled: settings.sendUserAvatar,
        useActivePersonaRowId: 'iig_use_active_persona_avatar_row',
        useActivePersonaCheckboxId: 'iig_use_active_persona_avatar',
        useActivePersonaRowHidden: !settings.sendUserAvatar,
        useActivePersonaHiddenClass: 'iig-hidden',
        useActivePersonaEnabled: settings.useActiveUserPersonaAvatar,
        userAvatarRowId: 'iig_user_avatar_row',
        userAvatarRowHidden: !settings.sendUserAvatar || settings.useActiveUserPersonaAvatar,
        userAvatarRowHiddenClass: 'iig-hidden',
        userAvatarDropdownHtml: buildUserAvatarDropdownControl('iig_user_avatar', settings.userAvatarFile),
        refreshButtonId: 'iig_refresh_avatars',
    });

    const naisteraAvatarsBlock = buildAvatarReferencesBlockHtml({
        sectionId: 'iig_naistera_refs_section',
        hiddenClass: 'iig-hidden',
        hidden: !naisteraRefsVisible,
        title: 'Naistera',
        sendCharCheckboxId: 'iig_naistera_send_char_avatar',
        sendCharEnabled: settings.naisteraSendCharAvatar,
        sendUserCheckboxId: 'iig_naistera_send_user_avatar',
        sendUserEnabled: settings.naisteraSendUserAvatar,
        useActivePersonaRowId: 'iig_naistera_use_active_persona_avatar_row',
        useActivePersonaCheckboxId: 'iig_naistera_use_active_persona_avatar',
        useActivePersonaRowHidden: !settings.naisteraSendUserAvatar,
        useActivePersonaHiddenClass: 'iig-hidden',
        useActivePersonaEnabled: settings.useActiveUserPersonaAvatar,
        userAvatarRowId: 'iig_naistera_user_avatar_row',
        userAvatarRowHidden: !settings.naisteraSendUserAvatar || settings.useActiveUserPersonaAvatar,
        userAvatarRowHiddenClass: 'iig-hidden',
        userAvatarDropdownHtml: buildUserAvatarDropdownControl('iig_naistera_user_avatar', settings.userAvatarFile),
        refreshButtonId: 'iig_naistera_refresh_avatars',
    });

    const refsSectionVisible = refsSupported;

    const bodyHtml = `
        <div class="iig-settings-card">
            ${geminiAvatarsBlock}
            ${naisteraAvatarsBlock}

            <div class="iig-settings-card-nested ${refsSectionVisible ? '' : 'iig-hidden'}" id="iig_image_context_section">
                <h4>${t`Image context`}</h4>
                <label class="checkbox_label">
                    <input type="checkbox" id="iig_image_context_enabled" ${settings.imageContextEnabled ? 'checked' : ''}>
                    <span>${t`Enable image context`}</span>
                </label>
                <div class="iig-video-frequency-row ${settings.imageContextEnabled ? '' : 'iig-hidden'}" id="iig_image_context_count_row">
                    <div class="iig-video-frequency-input">
                        <span>${t`Use`}</span>
                        <input type="number" id="iig_image_context_count" class="text_pole" min="1" max="${MAX_CONTEXT_IMAGES}" step="1" value="${normalizeImageContextCount(settings.imageContextCount)}">
                        <span>${t`previous images.`}</span>
                    </div>
                </div>
            </div>

            <div class="iig-settings-card-nested ${refsSectionVisible ? '' : 'iig-hidden'}" id="iig_additional_refs_section">
                <h4>${t`Additional references`}</h4>

                ${buildLorebookBarHtml(settings)}

                <div class="iig-additional-ref-actions">
                    <div id="iig_additional_refs_add" class="menu_button iig-button-inline">
                        <i class="fa-solid fa-plus"></i> ${t`Add reference`}
                    </div>
                    <div id="iig_additional_refs_import" class="menu_button iig-button-inline">
                        <i class="fa-solid fa-link"></i> ${t`Import reference`}
                    </div>
                </div>
                <div id="iig_additional_refs_status" class="hint" style="margin-bottom: 8px;"></div>
                <div id="iig_additional_refs_list"></div>
            </div>

            <div class="iig-settings-card-nested ${refsSectionVisible ? '' : 'iig-hidden'}" id="iig_ref_instruction_section">
                <h4>${t`Reference instruction`}</h4>
                <p class="hint">${t`Prepended to the prompt whenever at least one reference image is sent to the provider. Helps the model copy appearance from refs.`}</p>
                <label class="checkbox_label">
                    <input type="checkbox" id="iig_ref_instruction_enabled" ${settings.refInstructionEnabled !== false ? 'checked' : ''}>
                    <span>${t`Send reference instruction`}</span>
                </label>
                <textarea
                    id="iig_ref_instruction"
                    class="text_pole flex1 iig-settings-textarea"
                    rows="4"
                    placeholder="${sanitizeForHtml(DEFAULT_REF_INSTRUCTION)}"
                    ${settings.refInstructionEnabled === false ? 'disabled' : ''}
                >${sanitizeForHtml(settings.refInstruction ?? DEFAULT_REF_INSTRUCTION)}</textarea>
                <div class="iig-debug-actions">
                    <div id="iig_ref_instruction_reset" class="menu_button iig-button-inline" title="${t`Restore default text`}">
                        <i class="fa-solid fa-rotate-left"></i> ${t`Reset to default`}
                    </div>
                </div>
            </div>
        </div>
    `;
    return buildSettingsSectionHtml('iig_references_section', t`References`, bodyHtml, true);
}

// ----- Debug section -----

function buildDebugSettingsSectionHtml(settings = getSettings()) {
    const bodyHtml = `
        <div class="iig-settings-card">
            <div class="iig-settings-card-nested">
                <div class="flex-row">
                    <label for="iig_max_retries">${t`Max retries`}</label>
                    <input type="number" id="iig_max_retries" class="text_pole flex1" value="${settings.maxRetries}" min="0" max="5">
                    <div></div>
                </div>
                <div class="flex-row">
                    <label for="iig_retry_delay">${t`Retry delay (ms)`}</label>
                    <input type="number" id="iig_retry_delay" class="text_pole flex1" value="${settings.retryDelay}" min="500" max="10000" step="500">
                    <div></div>
                </div>
            </div>
            <div class="iig-debug-actions">
                <div id="iig_export_logs" class="menu_button iig-button-inline">
                    <i class="fa-solid fa-download"></i> ${t`Export logs`}
                </div>
                <div id="iig_show_last_request" class="menu_button iig-button-inline" title="${t`View prompt and references sent in the most recent generation`}">
                    <i class="fa-solid fa-magnifying-glass"></i> ${t`Show last request`}
                </div>
            </div>
        </div>
    `;
    return buildSettingsSectionHtml('iig_debug_section', t`Debug`, bodyHtml, false);
}

// ----- Last request popup -----

function formatTimestampLocal(ts) {
    if (!Number.isFinite(ts)) return '';
    try {
        return new Date(ts).toLocaleString();
    } catch (_e) {
        return new Date(ts).toISOString();
    }
}

function buildLastRequestPopupHtml(snapshot) {
    const meta = snapshot.metadata || {};
    const rows = [];
    const pushRow = (labelText, value) => {
        if (value === undefined || value === null || value === '') return;
        rows.push(`<div class="iig-last-req-meta-row"><span class="iig-last-req-meta-label">${sanitizeForHtml(labelText)}</span><span class="iig-last-req-meta-value">${sanitizeForHtml(String(value))}</span></div>`);
    };
    pushRow(t`Time`, formatTimestampLocal(snapshot.timestamp));
    pushRow(t`Provider`, meta.provider);
    pushRow(t`API type`, meta.apiType);
    pushRow(t`Model`, meta.model);
    pushRow(t`Aspect ratio`, meta.aspectRatio);
    pushRow(t`Resolution`, meta.imageSize);
    pushRow(t`Size`, meta.size);
    pushRow(t`Quality`, meta.quality);
    pushRow(t`Reference instruction applied`, meta.refInstructionApplied ? t`yes` : t`no`);

    const refsHtml = Array.isArray(snapshot.references) && snapshot.references.length > 0
        ? snapshot.references.map((ref) => `
            <div class="iig-last-req-ref">
                <img class="iig-last-req-ref-thumb" src="${sanitizeForHtml(ref.dataUrl)}" alt="${sanitizeForHtml(ref.label || '')}">
                <span class="iig-last-req-ref-label">${sanitizeForHtml(ref.label || '')}</span>
            </div>`).join('')
        : `<p class="hint">${t`No references were sent.`}</p>`;

    return `
        <div class="iig-last-req">
            <div class="iig-last-req-meta">${rows.join('')}</div>
            <h4>${t`Final prompt sent to provider`}</h4>
            <pre class="iig-last-req-prompt">${sanitizeForHtml(snapshot.prompt || '')}</pre>
            <h4>${t`References`} (${Array.isArray(snapshot.references) ? snapshot.references.length : 0})</h4>
            <div class="iig-last-req-refs">${refsHtml}</div>
        </div>
    `;
}

async function showLastRequestPopup() {
    const snapshot = getLastRequestSnapshot();
    if (!snapshot) {
        toastr.info(t`No request recorded yet. Generate an image first.`, t`Image Generation`);
        return;
    }
    const html = buildLastRequestPopupHtml(snapshot);
    await Popup.show.text(t`Last generation request`, html, { allowVerticalScrolling: true, wide: true });
}

// ----- Section toggles -----

function bindSectionToggles() {
    document.querySelectorAll('[data-section-toggle]').forEach((toggle) => {
        toggle.addEventListener('click', () => {
            const sectionId = toggle.getAttribute('data-section-toggle');
            const body = sectionId ? document.getElementById(sectionId) : null;
            const chevron = toggle.querySelector('.iig-section-chevron');
            if (!body) {
                return;
            }

            body.classList.toggle('iig-hidden');
            chevron?.classList.toggle('iig-section-chevron-collapsed', body.classList.contains('iig-hidden'));
        });
    });
}

// ----- Connection profiles -----

/**
 * После `loadConnectionProfile` в settings подменены все connection-поля.
 * Эта функция синхронизирует значения в уже отрисованных DOM-элементах
 * (input / select / checkbox), чтобы юзер увидел актуальное состояние
 * без полного re-render'а секции.
 */
function applyProfileValuesToInputs(settings) {
    const setVal = (id, value) => {
        const el = document.getElementById(id);
        if (el && 'value' in el) el.value = value ?? '';
    };
    const setChk = (id, value) => {
        const el = document.getElementById(id);
        if (el && 'checked' in el) el.checked = Boolean(value);
    };

    setVal('iig_api_type', settings.apiType);
    setVal('iig_endpoint', settings.endpoint);
    setChk('iig_raw_endpoint', settings.rawEndpoint);
    setVal('iig_api_key', settings.apiKey);
    setVal('iig_model', settings.model);
    setVal('iig_size', settings.size);
    setVal('iig_quality', settings.quality);
    setVal('iig_aspect_ratio', settings.aspectRatio);
    setVal('iig_image_size', settings.imageSize);
    setVal('iig_naistera_model', normalizeNaisteraModel(settings.naisteraModel));
    setVal('iig_naistera_aspect_ratio', settings.naisteraAspectRatio);
    setChk('iig_naistera_video_test', settings.naisteraVideoTest);
    setVal('iig_naistera_video_every_n', settings.naisteraVideoEveryN);
    setChk('iig_send_char_avatar', settings.sendCharAvatar);
    setChk('iig_send_user_avatar', settings.sendUserAvatar);
    setChk('iig_use_active_persona_avatar', settings.useActiveUserPersonaAvatar);
    setChk('iig_naistera_send_char_avatar', settings.naisteraSendCharAvatar);
    setChk('iig_naistera_send_user_avatar', settings.naisteraSendUserAvatar);
    setChk('iig_naistera_use_active_persona_avatar', settings.useActiveUserPersonaAvatar);

    // Пересинхронизация avatar-дропдаунов (custom-элемент, не <select>).
    syncUserAvatarSelection(settings.userAvatarFile);
    syncActivePersonaAvatarMode(settings.useActiveUserPersonaAvatar);
}

function refreshProfileSelectOptions(settings) {
    const select = document.getElementById('iig_profile_select');
    if (!(select instanceof HTMLSelectElement)) return;
    const profiles = ensureConnectionProfiles(settings);
    select.innerHTML = profiles.map((p) =>
        `<option value="${p.id}" ${p.id === settings.activeConnectionProfileId ? 'selected' : ''}>${sanitizeForHtml(p.name)}</option>`,
    ).join('') || `<option value="">${t`(no profiles)`}</option>`;
}

function bindConnectionProfilesEvents(settings, updateVisibility) {
    document.getElementById('iig_profile_select')?.addEventListener('change', (e) => {
        const id = e.target instanceof HTMLSelectElement ? e.target.value : '';
        if (!id) return;
        const profile = loadConnectionProfile(id, settings);
        if (!profile) return;
        saveSettings();
        applyProfileValuesToInputs(settings);
        updateVisibility();
        iigLog('INFO', `Loaded connection profile: ${profile.name} (${profile.apiType})`);
    });

    document.getElementById('iig_profile_save')?.addEventListener('click', () => {
        const profile = saveCurrentIntoProfile(null, settings);
        if (!profile) {
            toastr.warning(t`No active profile`, t`Image Generation`);
            return;
        }
        saveSettings();
        toastr.success(t`Profile "${profile.name}" saved`, t`Image Generation`, { timeOut: 1500 });
    });

    document.getElementById('iig_profile_save_as')?.addEventListener('click', async () => {
        const name = await Popup.show.input(t`New profile`, t`Enter a name for the new profile:`);
        if (!name) return;
        const profile = createConnectionProfile(name, settings);
        saveSettings();
        refreshProfileSelectOptions(settings);
        toastr.success(t`Created profile "${profile.name}"`, t`Image Generation`, { timeOut: 1500 });
    });

    document.getElementById('iig_profile_rename')?.addEventListener('click', async () => {
        const profile = getActiveConnectionProfile(settings);
        if (!profile) {
            toastr.warning(t`No active profile`, t`Image Generation`);
            return;
        }
        const newName = await Popup.show.input(t`Rename profile`, t`Enter a new name:`, profile.name);
        if (!newName) return;
        renameConnectionProfile(profile.id, newName, settings);
        saveSettings();
        refreshProfileSelectOptions(settings);
    });

    document.getElementById('iig_profile_remove')?.addEventListener('click', async () => {
        const profile = getActiveConnectionProfile(settings);
        if (!profile) return;
        const confirmed = await Popup.show.confirm(t`Delete profile`, t`Delete profile "${profile.name}"? This cannot be undone.`);
        if (!confirmed) return;
        const ok = removeConnectionProfile(profile.id, settings);
        if (!ok) {
            toastr.warning(t`Cannot delete the last profile`, t`Image Generation`);
            return;
        }
        // Загружаем новый активный в settings чтобы синхронизировать DOM.
        if (settings.activeConnectionProfileId) {
            loadConnectionProfile(settings.activeConnectionProfileId, settings);
        }
        saveSettings();
        refreshProfileSelectOptions(settings);
        applyProfileValuesToInputs(settings);
        updateVisibility();
    });
}

// ----- API section events -----

function bindApiSectionEvents(settings, updateVisibility) {
    document.getElementById('iig_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_external_blocks')?.addEventListener('change', (e) => {
        settings.externalBlocks = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_image_context_enabled')?.addEventListener('change', (e) => {
        settings.imageContextEnabled = e.target.checked;
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_image_context_count')?.addEventListener('input', (e) => {
        const normalized = normalizeImageContextCount(e.target.value);
        settings.imageContextCount = normalized;
        e.target.value = String(normalized);
        saveSettings();
    });

    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        const nextApiType = e.target.value;
        const endpointInput = document.getElementById('iig_endpoint');
        if (shouldReplaceEndpointForApiType(nextApiType, settings.endpoint)) {
            settings.endpoint = normalizeConfiguredEndpoint(nextApiType, '');
            if (endpointInput) {
                endpointInput.value = settings.endpoint;
            }
        } else if (nextApiType === 'naistera') {
            settings.endpoint = normalizeConfiguredEndpoint(nextApiType, settings.endpoint);
            if (endpointInput) {
                endpointInput.value = settings.endpoint;
            }
        }
        settings.apiType = nextApiType;
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => {
        settings.endpoint = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_api_key')?.addEventListener('input', (e) => {
        settings.apiKey = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.replace('fa-eye', 'fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.replace('fa-eye-slash', 'fa-eye');
        }
    });

    // iig_model теперь <input type="text" list="iig_model_list"> — даёт
    // автокомплит из datalist И возможность ввести любое имя вручную
    // (нужно для raw endpoint mode и редких моделей вне /v1/models).
    const modelApplyChange = (value) => {
        settings.model = value;
        saveSettings();

        // Auto-switch API type на 'gemini' применим только если сейчас
        // выбран OpenAI (legacy — когда юзер через OpenAI endpoint выбрал
        // nano-banana). Для openrouter/gemini/naistera не трогаем.
        if (settings.apiType === 'openai' && isGeminiModel(value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
        }

        // Модель влияет на поддержку референсов (gpt-image-* vs dall-e-*),
        // поэтому перестраиваем видимость секций при любой смене.
        updateVisibility();
    };
    document.getElementById('iig_model')?.addEventListener('change', (e) => modelApplyChange(e.target.value));
    document.getElementById('iig_model')?.addEventListener('input', (e) => modelApplyChange(e.target.value));

    /**
     * Обновляет datalist `iig_model_list` — либо через provider.fetchModels,
     * либо чистит (raw-режим / нет провайдера). `announce` контролирует
     * показ toastr'а с количеством найденных моделей.
     */
    async function reloadModelList({ announce = false } = {}) {
        const list = document.getElementById('iig_model_list');
        const btn = document.getElementById('iig_refresh_models');
        btn?.classList.add('loading');
        try {
            const models = await fetchModels();
            if (list instanceof HTMLDataListElement) {
                list.innerHTML = models
                    .map((m) => `<option value="${sanitizeForHtml(m)}"></option>`)
                    .join('');
            }
            if (announce && models.length > 0) {
                toastr.success(t`Models found: ${models.length}`, t`Image Generation`);
            }
            return models;
        } catch (error) {
            if (announce) {
                toastr.error(t`Failed to load models`, t`Image Generation`);
            }
            return [];
        } finally {
            btn?.classList.remove('loading');
        }
    }

    document.getElementById('iig_refresh_models')?.addEventListener('click', () => {
        reloadModelList({ announce: true });
    });

    document.getElementById('iig_raw_endpoint')?.addEventListener('change', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        settings.rawEndpoint = e.target.checked;
        saveSettings();

        const list = document.getElementById('iig_model_list');
        if (settings.rawEndpoint) {
            // Чистим datalist — в raw-режиме подсказки неактуальны, иначе
            // после выключения рядом с полем будут висеть устаревшие опции.
            if (list instanceof HTMLDataListElement) list.innerHTML = '';
        } else {
            // Выключили raw → юзер ожидает что поле снова станет dropdown'ом.
            // Автоматически подтягиваем список моделей — не заставляем его
            // жать Refresh руками.
            reloadModelList({ announce: true });
        }
    });

    document.getElementById('iig_size')?.addEventListener('change', (e) => {
        settings.size = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_quality')?.addEventListener('change', (e) => {
        settings.quality = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => {
        settings.aspectRatio = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_image_size')?.addEventListener('change', (e) => {
        settings.imageSize = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_naistera_model')?.addEventListener('change', (e) => {
        settings.naisteraModel = normalizeNaisteraModel(e.target.value);
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_naistera_aspect_ratio')?.addEventListener('change', (e) => {
        settings.naisteraAspectRatio = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_naistera_video_test')?.addEventListener('change', (e) => {
        settings.naisteraVideoTest = e.target.checked;
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_naistera_video_every_n')?.addEventListener('input', (e) => {
        const normalized = normalizeNaisteraVideoFrequency(e.target.value);
        settings.naisteraVideoEveryN = normalized;
        e.target.value = String(normalized);
        saveSettings();
    });
}

// ----- Avatar section events (общая фабрика для Gemini и Naistera) -----

/**
 * Вешает обработчики на пару аватар-чекбоксов + на refresh.
 * Раньше этот код был продублирован для `iig_*` и `iig_naistera_*`.
 */
function bindAvatarSectionEvents(settings, updateVisibility, config) {
    const {
        sendCharCheckboxId,
        sendCharKey,
        sendUserCheckboxId,
        sendUserKey,
        useActivePersonaCheckboxId,
        userAvatarSelectId,
        refreshButtonId,
        userAvatarDropdownId,
    } = config;

    document.getElementById(sendCharCheckboxId)?.addEventListener('change', (e) => {
        settings[sendCharKey] = e.target.checked;
        saveSettings();
    });

    document.getElementById(sendUserCheckboxId)?.addEventListener('change', (e) => {
        settings[sendUserKey] = e.target.checked;
        saveSettings();
        updateVisibility();
    });

    document.getElementById(useActivePersonaCheckboxId)?.addEventListener('change', (e) => {
        settings.useActiveUserPersonaAvatar = e.target.checked;
        syncActivePersonaAvatarMode(settings.useActiveUserPersonaAvatar);
        saveSettings();
        updateVisibility();
    });

    document.getElementById(userAvatarSelectId)?.addEventListener('change', (e) => {
        settings.userAvatarFile = e.target.value;
        syncUserAvatarSelection(settings.userAvatarFile);
        saveSettings();
    });

    document.getElementById(refreshButtonId)?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        btn.classList.add('loading');

        try {
            const avatars = await refreshUserAvatarSelects();

            toastr.success(t`Avatars found: ${avatars.length}`, t`Image Generation`);
            document.getElementById(userAvatarDropdownId)?.classList.add('open');
        } catch (error) {
            toastr.error(t`Failed to load avatars`, t`Image Generation`);
        } finally {
            btn.classList.remove('loading');
        }
    });
}

function bindAvatarDropdownToggles() {
    for (const { rootId, selectedId, listId } of getUserAvatarDropdownConfigs()) {
        document.getElementById(selectedId)?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const dropdown = document.getElementById(rootId);
            if (!dropdown) {
                return;
            }

            const willOpen = !dropdown.classList.contains('open');
            closeUserAvatarDropdowns();
            dropdown.classList.toggle('open', willOpen);

            if (willOpen) {
                const list = document.getElementById(listId);
                if (list && list.children.length === 0) {
                    await refreshUserAvatarSelects();
                }
            }
        });
    }

    document.addEventListener('click', (e) => {
        const clickedInsideDropdown = getUserAvatarDropdownConfigs().some(({ rootId }) => {
            const root = document.getElementById(rootId);
            return root?.contains(e.target);
        });
        if (!clickedInsideDropdown) {
            closeUserAvatarDropdowns();
        }
    });
}

// ----- Styles section events -----

function bindStylesSectionEvents(settings) {
    document.getElementById('iig_style_add')?.addEventListener('click', () => {
        const input = document.getElementById('iig_new_style_name');
        const style = createStyle(input?.value || '');
        if (input) {
            input.value = '';
        }
        saveSettings();
        renderStyleSettings();
        iigLog('INFO', `Created style: ${style.name}`);
    });

    document.getElementById('iig_new_style_name')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('iig_style_add')?.click();
        }
    });

    document.getElementById('iig_style_presets')?.addEventListener('click', (e) => {
        const activateButton = e.target instanceof Element ? e.target.closest('[data-style-activate]') : null;
        if (activateButton) {
            settings.activeStyleId = activateButton.getAttribute('data-style-activate') || '';
            saveSettings();
            renderStyleSettings();
            return;
        }

        const removeButton = e.target instanceof Element ? e.target.closest('[data-style-remove]') : null;
        if (!removeButton) {
            return;
        }

        const styleId = removeButton.getAttribute('data-style-remove') || '';
        removeStyle(styleId);
        saveSettings();
        renderStyleSettings();
    });

    document.getElementById('iig_style_editor')?.addEventListener('input', (e) => {
        const activeStyle = getActiveStyle(settings);
        if (!activeStyle) {
            return;
        }

        const target = e.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
            return;
        }

        if (target.id === 'iig_style_name') {
            updateStyle(activeStyle.id, { name: target.value });
            saveSettings();
            const activeButton = document.querySelector(`[data-style-activate="${activeStyle.id}"] span`);
            if (activeButton) {
                activeButton.textContent = getActiveStyle(settings)?.name || target.value.trim() || activeStyle.name;
            }
            return;
        }
        if (target.id === 'iig_style_value') {
            updateStyle(activeStyle.id, { value: target.value });
            saveSettings();
            return;
        }
    });

    document.getElementById('iig_style_editor')?.addEventListener('click', (e) => {
        const disableButton = e.target instanceof Element ? e.target.closest('#iig_style_disable') : null;
        if (!disableButton) {
            return;
        }

        settings.activeStyleId = '';
        saveSettings();
        renderStyleSettings();
    });
}

// ----- Lorebook bar events -----

function refreshLorebookBar(settings) {
    const bar = document.querySelector('.iig-lorebook-bar');
    if (!bar) return;
    bar.outerHTML = buildLorebookBarHtml(settings);
    // После replace — элемент в DOM заменился, перевешиваем обработчики.
    bindLorebookBarEvents(settings);
}

function bindLorebookBarEvents(settings) {
    document.getElementById('iig_lorebook_select')?.addEventListener('change', (e) => {
        const id = e.target instanceof HTMLSelectElement ? e.target.value : '';
        if (!id) return;
        const lb = setActiveLorebook(id, settings);
        if (!lb) return;
        saveSettings();
        refreshLorebookBar(settings);
        refreshAdditionalReferencesList();
    });

    document.getElementById('iig_lorebook_enabled')?.addEventListener('change', (e) => {
        const active = getActiveLorebook(settings);
        if (!active || !(e.target instanceof HTMLInputElement)) return;
        setLorebookEnabled(active.id, e.target.checked, settings);
        saveSettings();
        refreshLorebookBar(settings);
    });

    document.getElementById('iig_lorebook_add')?.addEventListener('click', async () => {
        const name = await Popup.show.input(t`New lorebook`, t`Enter a name for the new lorebook:`);
        if (!name) return;
        const lb = createLorebook(name, settings);
        saveSettings();
        refreshLorebookBar(settings);
        refreshAdditionalReferencesList();
        toastr.success(t`Lorebook "${lb.name}" created`, t`Image Generation`, { timeOut: 1500 });
    });

    document.getElementById('iig_lorebook_rename')?.addEventListener('click', async () => {
        const active = getActiveLorebook(settings);
        if (!active) return;
        const newName = await Popup.show.input(t`Rename lorebook`, t`Enter a new name:`, active.name);
        if (!newName) return;
        renameLorebook(active.id, newName, settings);
        saveSettings();
        refreshLorebookBar(settings);
    });

    async function afterLorebookImport(stats) {
        refreshLorebookBar(settings);
        refreshAdditionalReferencesList();
        const tail = stats.imagesFailed > 0
            ? ` (${t`${stats.imagesFailed} images failed to download`})`
            : '';
        toastr.success(
            t`Imported ${stats.refsCount} refs, ${stats.imagesDownloaded} images downloaded${tail}`,
            t`Image Generation`,
            { timeOut: 4000 },
        );
    }

    document.getElementById('iig_lorebook_import_url')?.addEventListener('click', async () => {
        const url = await Popup.show.input(
            t`Import lorebook from URL`,
            t`Paste a direct URL to a JSON lorebook file:`,
        );
        if (typeof url !== 'string') return;
        const trimmed = url.trim();
        if (!trimmed) return;
        try {
            const stats = await importLorebookFromUrl(trimmed);
            await afterLorebookImport(stats);
        } catch (error) {
            console.error('[IIG] Lorebook import failed:', error);
            toastr.error(t`Import error: ${error.message || error}`, t`Image Generation`);
        }
    });

    document.getElementById('iig_lorebook_import_file_input')?.addEventListener('change', async (e) => {
        const input = e.target;
        if (!(input instanceof HTMLInputElement)) return;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        try {
            const stats = await importLorebookFromFile(file);
            await afterLorebookImport(stats);
        } catch (error) {
            console.error('[IIG] Lorebook import failed:', error);
            toastr.error(t`Import error: ${error.message || error}`, t`Image Generation`);
        }
    });

    document.getElementById('iig_lorebook_export')?.addEventListener('click', async () => {
        const active = getActiveLorebook(settings);
        if (!active) return;

        // Перед скачиванием показываем предупреждение про картинки.
        const proceed = await Popup.show.confirm(
            t`Export lorebook`,
            t`Images are NOT included in the JSON. To share this lorebook, fill the empty "imageUrl" field of each reference with a direct link to its image. Continue?`,
        );
        if (!proceed) return;

        const payload = buildLorebookExportJson(active);
        const json = JSON.stringify(payload, null, 2);
        const fileName = lorebookFileNameFromTitle(active.name);
        triggerBrowserDownload(fileName, json);
        toastr.success(t`Lorebook "${active.name}" exported`, t`Image Generation`, { timeOut: 2000 });
    });

    document.getElementById('iig_lorebook_remove')?.addEventListener('click', async () => {
        const active = getActiveLorebook(settings);
        if (!active) return;
        const confirmed = await Popup.show.confirm(
            t`Delete lorebook`,
            t`Delete lorebook "${active.name}"? All its references will be lost. This cannot be undone.`,
        );
        if (!confirmed) return;
        const ok = removeLorebook(active.id, settings);
        if (!ok) {
            toastr.warning(t`Cannot delete the last lorebook`, t`Image Generation`);
            return;
        }
        saveSettings();
        refreshLorebookBar(settings);
        refreshAdditionalReferencesList();
    });
}

// ----- Additional references events -----

/**
 * Обёртка над `renderAdditionalReferencesList`, пробрасывающая текущий
 * provider-лимит референсов. Нужна чтобы references.js не зависел от
 * providers.js (иначе ESM-цикл).
 */
function refreshAdditionalReferencesList() {
    const maxRefs = getActiveProviderMaxReferences(getSettings());
    renderAdditionalReferencesList(maxRefs);
}

function bindAdditionalReferencesEvents(settings) {
    document.getElementById('iig_additional_refs_add')?.addEventListener('click', () => {
        const refs = ensureAdditionalReferencesArray(settings);
        if (refs.length >= MAX_ADDITIONAL_REFERENCES) {
            toastr.warning(t`Maximum additional references: ${MAX_ADDITIONAL_REFERENCES}`, t`Image Generation`);
            return;
        }

        refs.push({
            name: '',
            description: '',
            imagePath: '',
            matchMode: 'match',
            enabled: true,
            group: '',
            priority: 0,
            useRegex: false,
            secondaryKeys: '',
        });
        saveSettings();
        refreshAdditionalReferencesList();
    });

    document.getElementById('iig_additional_refs_import')?.addEventListener('click', () => {
        openReferenceImportModal();
    });

    document.getElementById('iig_ref_import_close')?.addEventListener('click', () => {
        closeReferenceImportModal();
    });

    document.querySelector('#iig_ref_import_modal [data-iig-modal-close="true"]')?.addEventListener('click', () => {
        closeReferenceImportModal();
    });

    document.getElementById('iig_ref_import_submit')?.addEventListener('click', async () => {
        const button = document.getElementById('iig_ref_import_submit');
        const input = document.getElementById('iig_ref_import_urls');
        if (!(button instanceof HTMLDivElement) || !(input instanceof HTMLTextAreaElement)) {
            return;
        }

        button.classList.add('loading');
        try {
            const result = await importAdditionalReferencesFromUrls(input.value);
            closeReferenceImportModal();
            const tail = result.skippedCount > 0 ? t`, skipped: ${result.skippedCount}` : '';
            toastr.success(t`Imported: ${result.importedCount}` + tail, t`Image Generation`);
        } catch (error) {
            toastr.error(t`Import error: ${error.message || error}`, t`Image Generation`);
        } finally {
            button.classList.remove('loading');
        }
    });

    document.getElementById('iig_ref_import_urls')?.addEventListener('keydown', async (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('iig_ref_import_submit')?.click();
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            closeReferenceImportModal();
        }
    });

    document.getElementById('iig_additional_refs_list')?.addEventListener('input', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
            return;
        }

        const isNameField = target.classList.contains('iig-additional-ref-name');
        const isDescriptionField = target.classList.contains('iig-additional-ref-description');
        const isGroupField = target.classList.contains('iig-additional-ref-group');
        const isSecondaryField = target.classList.contains('iig-additional-ref-secondary');
        const isPriorityField = target.classList.contains('iig-additional-ref-priority');
        if (!isNameField && !isDescriptionField && !isGroupField && !isSecondaryField && !isPriorityField) {
            return;
        }

        const row = target.closest('.iig-additional-ref-row');
        const index = Number.parseInt(String(row?.getAttribute('data-ref-index') || ''), 10);
        if (!Number.isInteger(index)) {
            return;
        }

        const refs = ensureAdditionalReferencesArray(settings);
        if (!refs[index]) {
            return;
        }

        if (isNameField) refs[index].name = target.value;
        if (isDescriptionField) refs[index].description = target.value;
        if (isGroupField) refs[index].group = target.value;
        if (isSecondaryField) refs[index].secondaryKeys = target.value;
        if (isPriorityField) {
            const parsed = Number.parseInt(target.value, 10);
            refs[index].priority = Number.isFinite(parsed) ? parsed : 0;
        }
        saveSettings();
        // Обновляем только статус (ссылок на provider-limit warning), не
        // ре-рендерим карточки — иначе слетает фокус.
        renderAdditionalReferencesStatus(getActiveProviderMaxReferences(settings));
    });

    document.getElementById('iig_additional_refs_list')?.addEventListener('change', async (e) => {
        const target = e.target;
        if (target instanceof HTMLInputElement && target.classList.contains('iig-additional-ref-enabled')) {
            const row = target.closest('.iig-additional-ref-row');
            const index = Number.parseInt(String(row?.getAttribute('data-ref-index') || ''), 10);
            if (!Number.isInteger(index)) {
                return;
            }

            const refs = ensureAdditionalReferencesArray(settings);
            if (!refs[index]) {
                return;
            }

            refs[index].enabled = target.checked;
            saveSettings();
            refreshAdditionalReferencesList();
            return;
        }

        if (!(target instanceof HTMLInputElement) || !target.classList.contains('iig-additional-ref-file')) {
            return;
        }

        const row = target.closest('.iig-additional-ref-row');
        const index = Number.parseInt(String(row?.getAttribute('data-ref-index') || ''), 10);
        if (!Number.isInteger(index)) {
            target.value = '';
            return;
        }

        const file = target.files?.[0];
        if (!file) {
            target.value = '';
            return;
        }

        const refs = ensureAdditionalReferencesArray(settings);
        if (!refs[index]) {
            target.value = '';
            return;
        }

        try {
            if (!refs[index].name) {
                refs[index].name = file.name.replace(/\.[^.]+$/, '');
            }

            const dataUrl = await readFileAsDataUrl(file);
            const savedPath = await saveImageToFile(dataUrl, {
                mode: 'additional-reference-upload',
                refIndex: index,
                refName: refs[index].name,
            });

            refs[index].imagePath = normalizeStoredImagePath(savedPath);
            saveSettings();
            refreshAdditionalReferencesList();
            toastr.success(t`Additional reference saved`, t`Image Generation`);
        } catch (error) {
            console.error('[IIG] Failed to upload additional reference:', error);
            toastr.error(t`Reference upload failed: ${error.message || error}`, t`Image Generation`);
        } finally {
            target.value = '';
        }
    });

    document.getElementById('iig_additional_refs_list')?.addEventListener('change', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement)) return;

        const isAlways = target.classList.contains('iig-additional-ref-always');
        const isRegex = target.classList.contains('iig-additional-ref-regex');
        if (!isAlways && !isRegex) return;

        const row = target.closest('.iig-additional-ref-row');
        const index = Number.parseInt(String(row?.getAttribute('data-ref-index') || ''), 10);
        if (!Number.isInteger(index)) return;

        const refs = ensureAdditionalReferencesArray(settings);
        if (!refs[index]) return;

        if (isAlways) refs[index].matchMode = target.checked ? 'always' : 'match';
        if (isRegex) refs[index].useRegex = target.checked;
        saveSettings();
        refreshAdditionalReferencesList();
    });

    document.getElementById('iig_additional_refs_list')?.addEventListener('click', async (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;

        const urlBtn = target.closest('.iig-additional-ref-upload-url');
        const removeBtn = !urlBtn ? target.closest('.iig-additional-ref-remove') : null;
        const upBtn = !urlBtn && !removeBtn ? target.closest('.iig-additional-ref-move-up') : null;
        const downBtn = !urlBtn && !removeBtn && !upBtn ? target.closest('.iig-additional-ref-move-down') : null;
        const button = urlBtn || removeBtn || upBtn || downBtn;
        if (!button) return;

        const row = button.closest('.iig-additional-ref-row');
        const index = Number.parseInt(String(row?.getAttribute('data-ref-index') || ''), 10);
        if (!Number.isInteger(index)) return;

        const refs = ensureAdditionalReferencesArray(settings);
        if (urlBtn) {
            if (!refs[index]) return;
            const url = await Popup.show.input(t`Upload image by URL`, t`Paste a direct link to the image:`);
            const trimmed = String(url || '').trim();
            if (!trimmed) return;
            try {
                const savedPath = await downloadReferenceImageFromUrl(trimmed, {
                    mode: 'additional-reference-upload-url',
                    refIndex: index,
                    refName: refs[index].name,
                });
                refs[index].imagePath = savedPath;
                saveSettings();
                refreshAdditionalReferencesList();
                toastr.success(t`Additional reference saved`, t`Image Generation`);
            } catch (error) {
                console.error('[IIG] Failed to upload reference by URL:', error);
                toastr.error(t`Reference upload failed: ${error.message || error}`, t`Image Generation`);
            }
            return;
        }

        if (removeBtn) {
            const name = String(refs[index]?.name || '').trim() || t`Reference ${index + 1}`;
            const confirmed = await Popup.show.confirm(
                t`Delete reference`,
                t`Delete reference "${name}"? This cannot be undone.`,
            );
            if (!confirmed) return;
            refs.splice(index, 1);
        } else if (upBtn && index > 0) {
            [refs[index - 1], refs[index]] = [refs[index], refs[index - 1]];
        } else if (downBtn && index < refs.length - 1) {
            [refs[index], refs[index + 1]] = [refs[index + 1], refs[index]];
        } else {
            return; // no-op (edge)
        }
        saveSettings();
        refreshAdditionalReferencesList();
    });
}

// ----- Reference instruction events -----

function bindRefInstructionEvents(settings) {
    const checkbox = document.getElementById('iig_ref_instruction_enabled');
    const textarea = document.getElementById('iig_ref_instruction');
    const resetBtn = document.getElementById('iig_ref_instruction_reset');

    checkbox?.addEventListener('change', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        settings.refInstructionEnabled = e.target.checked;
        if (textarea instanceof HTMLTextAreaElement) {
            textarea.disabled = !e.target.checked;
        }
        saveSettings();
    });

    textarea?.addEventListener('input', (e) => {
        if (!(e.target instanceof HTMLTextAreaElement)) return;
        settings.refInstruction = e.target.value;
        saveSettings();
    });

    resetBtn?.addEventListener('click', () => {
        if (!(textarea instanceof HTMLTextAreaElement)) return;
        textarea.value = DEFAULT_REF_INSTRUCTION;
        settings.refInstruction = DEFAULT_REF_INSTRUCTION;
        saveSettings();
        toastr.success(t`Reference instruction reset to default`, t`Image Generation`, { timeOut: 1500 });
    });
}

// ----- Debug section events -----

function bindDebugSectionEvents(settings) {
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => {
        settings.maxRetries = parseInt(e.target.value) || 3;
        saveSettings();
    });

    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => {
        settings.retryDelay = parseInt(e.target.value) || 1000;
        saveSettings();
    });

    document.getElementById('iig_export_logs')?.addEventListener('click', () => {
        exportLogs();
    });

    document.getElementById('iig_show_last_request')?.addEventListener('click', () => {
        showLastRequestPopup();
    });
}

// ----- Visibility recomputation -----

function buildUpdateVisibility(settings) {
    return () => {
        const apiType = settings.apiType;
        const isNaistera = apiType === 'naistera';
        const isGemini = apiType === 'gemini';
        const isOpenAI = apiType === 'openai';
        const isOpenRouter = apiType === 'openrouter';
        const isElectronHub = apiType === 'electronhub';

        // Поддерживает ли активный провайдер референсы (учитывая модель).
        const provider = resolveActiveProvider(settings);
        const refsSupported = provider ? provider.supportsReferences(settings) : false;
        const naisteraRefsSupported = isNaistera && refsSupported;

        // «Общий» avatar refs блок (char/user аватар с чекбоксами) — теперь
        // показывается не только для Gemini, но и для любого OpenAI-семейства,
        // которое поддерживает /edits, и для OpenRouter/Electron Hub. Naistera
        // использует свой отдельный блок.
        const commonAvatarRefsVisible = (isGemini || isOpenAI || isOpenRouter || isElectronHub) && refsSupported;

        // Model is used for OpenAI and Gemini; Naistera does not need a model.
        document.getElementById('iig_model_row')?.classList.toggle('iig-hidden', isNaistera);
        document.getElementById('iig_image_context_section')?.classList.toggle('iig-hidden', !refsSupported);
        document.getElementById('iig_image_context_count_row')?.classList.toggle('iig-hidden', !(refsSupported && settings.imageContextEnabled));
        document.getElementById('iig_additional_refs_section')?.classList.toggle('iig-hidden', !refsSupported);
        document.getElementById('iig_ref_instruction_section')?.classList.toggle('iig-hidden', !refsSupported);

        // Обновляем provider-limit warning в status-строке без ре-рендера
        // карточек (чтобы не терять фокус в inputs).
        renderAdditionalReferencesStatus(getActiveProviderMaxReferences(settings));

        // OpenAI + Electron Hub params (size / quality) — Electron Hub
        // принимает тот же формат JSON на /v1/images/{generations,edits}.
        document.getElementById('iig_size_row')?.classList.toggle('iig-hidden', !(isOpenAI || isElectronHub));
        document.getElementById('iig_quality_row')?.classList.toggle('iig-hidden', !(isOpenAI || isElectronHub));

        // Naistera-only params
        document.getElementById('iig_naistera_model_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_aspect_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_video_section')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_video_frequency_row')?.classList.toggle('iig-hidden', !(isNaistera && settings.naisteraVideoTest));
        document.getElementById('iig_naistera_refs_section')?.classList.toggle('iig-hidden', !naisteraRefsSupported);
        document.getElementById('iig_naistera_use_active_persona_avatar_row')?.classList.toggle('iig-hidden', !(naisteraRefsSupported && settings.naisteraSendUserAvatar));
        document.getElementById('iig_naistera_user_avatar_row')?.classList.toggle(
            'iig-hidden',
            !(naisteraRefsSupported && settings.naisteraSendUserAvatar && !settings.useActiveUserPersonaAvatar)
        );

        document.getElementById('iig_naistera_hint')?.classList.toggle('iig-hidden', !isNaistera);

        const endpointInput = document.getElementById('iig_endpoint');
        if (endpointInput) {
            endpointInput.placeholder = getEndpointPlaceholder(apiType);
        }

        // Aspect + image size — для Gemini и OpenRouter. В OpenAI размер
        // задаётся другим селектором (#iig_size), в Naistera — своим.
        const avatarSection = document.getElementById('iig_avatar_section');
        if (avatarSection) {
            avatarSection.classList.toggle('iig-hidden', !(isGemini || isOpenRouter));
        }

        // «Общий» avatar refs блок — для Gemini / OpenAI-c-refs / OpenRouter.
        const avatarRefsSection = document.getElementById('iig_avatar_refs_section');
        if (avatarRefsSection) {
            avatarRefsSection.classList.toggle('iig-hidden', !commonAvatarRefsVisible);

            // Обновляем заголовок при смене провайдера.
            const titleEl = avatarRefsSection.querySelector('h4');
            if (titleEl) {
                if (isOpenRouter) titleEl.textContent = 'OpenRouter';
                else if (isElectronHub) titleEl.textContent = 'Electron Hub';
                else if (isOpenAI) titleEl.textContent = 'OpenAI / GPT Image';
                else titleEl.textContent = 'Gemini / nano-banana';
            }
        }
        document.getElementById('iig_use_active_persona_avatar_row')?.classList.toggle(
            'iig-hidden',
            !(commonAvatarRefsVisible && settings.sendUserAvatar),
        );
        document.getElementById('iig_user_avatar_row')?.classList.toggle(
            'iig-hidden',
            !(commonAvatarRefsVisible && settings.sendUserAvatar && !settings.useActiveUserPersonaAvatar),
        );
    };
}

// ----- Main bind -----

function bindSettingsEvents() {
    const settings = getSettings();
    const updateVisibility = buildUpdateVisibility(settings);

    bindSectionToggles();
    bindConnectionProfilesEvents(settings, updateVisibility);
    bindApiSectionEvents(settings, updateVisibility);

    // Gemini avatar section
    bindAvatarSectionEvents(settings, updateVisibility, {
        sendCharCheckboxId: 'iig_send_char_avatar',
        sendCharKey: 'sendCharAvatar',
        sendUserCheckboxId: 'iig_send_user_avatar',
        sendUserKey: 'sendUserAvatar',
        useActivePersonaCheckboxId: 'iig_use_active_persona_avatar',
        userAvatarSelectId: 'iig_user_avatar_file',
        refreshButtonId: 'iig_refresh_avatars',
        userAvatarDropdownId: 'iig_user_avatar_dropdown',
    });

    // Naistera avatar section
    bindAvatarSectionEvents(settings, updateVisibility, {
        sendCharCheckboxId: 'iig_naistera_send_char_avatar',
        sendCharKey: 'naisteraSendCharAvatar',
        sendUserCheckboxId: 'iig_naistera_send_user_avatar',
        sendUserKey: 'naisteraSendUserAvatar',
        useActivePersonaCheckboxId: 'iig_naistera_use_active_persona_avatar',
        userAvatarSelectId: 'iig_naistera_user_avatar_file',
        refreshButtonId: 'iig_naistera_refresh_avatars',
        userAvatarDropdownId: 'iig_naistera_user_avatar_dropdown',
    });

    bindAvatarDropdownToggles();
    bindStylesSectionEvents(settings);
    bindLorebookBarEvents(settings);
    bindAdditionalReferencesEvents(settings);
    bindRefInstructionEvents(settings);
    bindDebugSectionEvents(settings);

    // Apply initial state
    syncUserAvatarSelection(settings.userAvatarFile);
    syncActivePersonaAvatarMode(settings.useActiveUserPersonaAvatar);
    refreshAdditionalReferencesList();
    updateVisibility();
}

// ----- Public entry -----

export function createSettingsUI() {
    const settings = getSettings();

    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.error('[IIG] Settings container not found');
        return;
    }

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${t`Image Generation`}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    ${buildApiSettingsSectionHtml(settings)}
                    ${buildStylesSettingsSectionHtml(settings)}
                    ${buildReferencesSettingsSectionHtml(settings)}
                    ${buildDebugSettingsSectionHtml(settings)}
                </div>
            </div>
        </div>
        ${buildReferenceImportModalHtml()}
    `;

    container.insertAdjacentHTML('beforeend', html);

    bindSettingsEvents();
    renderStyleSettings();
}
