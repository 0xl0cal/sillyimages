/**
 * Рендеринг секций настроек и биндинг всех UI-обработчиков.
 *
 * Разделено на секции:
 *   - API (провайдер / endpoint / apiKey / model / параметры генерации)
 *   - Стили
 *   - Референсы (avatar-виджеты и additional references)
 *   - Отладка (retries / export logs)
 *
 * `bindAvatarSectionEvents` configures the shared Gemini and Naistera controls.
 */

import {
    getSettings, saveSettings, exportLogs, getActiveLorebookReferences, ensureLorebooks,
    getActiveLorebook, createLorebook, renameLorebook, removeLorebook, setLorebookEnabled,
    setActiveLorebook, DEFAULT_REF_INSTRUCTION, getLastRequestSnapshot, normalizeImageContextCount,
    MAX_CONTEXT_IMAGES, MAX_ADDITIONAL_REFERENCES,
} from './settings.js';
import { normalizeStoredImagePath, readFileAsDataUrl, saveImageToFile, sanitizeForHtml } from './utils.js';
import {
    renderAdditionalReferencesList, renderAdditionalReferencesStatus,
    syncAdditionalReferenceAvailability, buildReferenceImportModalHtml, openReferenceImportModal,
    closeReferenceImportModal, importAdditionalReferencesFromUrls, renderIigBookMacro,
} from './references.js';
import { resolveActiveProvider, getActiveProviderMaxReferences } from './providers.js';
import { t } from './i18n.js';
import { buildSettingsSectionHtml } from './settingsControls.js';
import {
    buildApiSettingsSectionHtml, bindApiSectionEvents, bindConnectionProfilesEvents, buildUpdateVisibility,
} from './apiSettingsUi.js';
import {
    downloadReferenceImageFromUrl, buildLorebookExportJson, lorebookFileNameFromTitle,
    triggerBrowserDownload, importLorebookFromUrl, importLorebookFromFile,
} from './referenceTransfer.js';
import {
    buildUserAvatarDropdownControl, syncUserAvatarSelection, syncActivePersonaAvatarMode,
    refreshUserAvatarSelects, getUserAvatarDropdownConfigs, closeUserAvatarDropdowns,
} from './avatarPicker.js';
import { renderStyleSettings, bindStylesSectionEvents } from './promptLibraryUi.js';
export { renderStyleSettings } from './promptLibraryUi.js';
import {
    buildCharacterLibraryBodyHtml, bindCharacterLibraryEvents, clearAllGenerationImages,
    refreshIfContextChanged,
} from './characterLibraryUi.js';
// Относительный путь: /scripts/extensions/third-party/sillyimages/src/ui.js → /scripts/popup.js
import { Popup } from '../../../../popup.js';

// ----- Styles section -----


function buildStylesSettingsSectionHtml() {
    const bodyHtml = `
        <div class="iig-library-tabs iig-prompt-library-tabs" role="tablist">
            <button type="button" class="menu_button iig-library-tab selected" role="tab" data-style-library="styles" aria-selected="true"><i class="fa-solid fa-palette"></i><span>${t`Styles`}</span></button>
            <button type="button" class="menu_button iig-library-tab" role="tab" data-style-library="negativePrompts" aria-selected="false"><i class="fa-solid fa-ban"></i><span>${t`Negatives`}</span></button>
        </div>
        <div class="iig-style-workspace">
            <div class="iig-settings-group iig-style-library">
                <div class="iig-settings-group-title iig-style-library-head">
                    <i class="fa-solid fa-swatchbook"></i>
                    <span id="iig_prompt_library_title">${t`Style library`}</span>
                    <button type="button" id="iig_style_add" class="menu_button iig-button-inline"><i class="fa-solid fa-plus"></i><span>${t`New style`}</span></button>
                </div>
                <div id="iig_style_presets"></div>
            </div>
            <div class="iig-settings-group iig-style-editor-group">
                <div class="iig-settings-group-title"><i class="fa-solid fa-pen-to-square"></i><span>${t`Editor`}</span></div>
                <div id="iig_style_editor"></div>
            </div>
        </div>
    `;
    return buildSettingsSectionHtml('iig_styles_section', t`Styles & Negatives`, bodyHtml, false);
}

// ----- Character reference library -----

function buildCharactersSettingsSectionHtml(settings = getSettings()) {
    return buildSettingsSectionHtml('iig_characters_section', t`Character library`, buildCharacterLibraryBodyHtml(settings), false);
}

// ----- References section -----

/**
 * Shared markup for an avatar reference subsection.
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
        <div id="${sectionId}" class="iig-settings-group ${hidden ? hiddenClass : ''}">
            <div class="iig-settings-group-title"><i class="fa-solid fa-user-group"></i><span>${title}</span></div>
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
    const isPowerMode = settings.additionalReferencesMode === 'power';
    const activeId = settings.activeLorebookId;
    const active = getActiveLorebook(settings);
    const optionsHtml = lorebooks.map((lb) =>
        `<option value="${sanitizeForHtml(lb.id)}" ${lb.id === activeId ? 'selected' : ''}>${sanitizeForHtml(lb.name)}${isPowerMode && lb.enabled === false ? ' ' + t`(off)` : ''}</option>`,
    ).join('');
    return `
        <div class="iig-lorebook-bar">
            <div class="flex-row">
                <label for="iig_lorebook_select">${t`Lorebook`}</label>
                <select id="iig_lorebook_select" class="flex1">
                    ${optionsHtml}
                </select>
                <div class="iig-lorebook-buttons">
                    ${isPowerMode ? `<label class="checkbox_label" title="${t`Include this lorebook in matching`}">
                        <input type="checkbox" id="iig_lorebook_enabled" ${active?.enabled !== false ? 'checked' : ''}>
                        <span>${t`On`}</span>
                    </label>` : ''}
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
    const isXAI = settings.apiType === 'xai';
    const isOpenRouter = settings.apiType === 'openrouter';
    const isElectronHub = settings.apiType === 'electronhub';
    const commonAvatarRefsVisible = (isGemini || isOpenAI || isXAI || isOpenRouter || isElectronHub) && refsSupported;
    const naisteraRefsVisible = settings.apiType === 'naistera' && refsSupported;

    // Заголовок секции аватаров — по активному провайдеру. Provider-brand
    // имена не локализуются.
    let avatarRefsTitle;
    if (isOpenRouter) avatarRefsTitle = 'OpenRouter';
    else if (isElectronHub) avatarRefsTitle = 'Electron Hub';
    else if (isXAI) avatarRefsTitle = 'xAI Imagine';
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

            <div class="iig-settings-group ${refsSectionVisible ? '' : 'iig-hidden'}" id="iig_image_context_section">
                <div class="iig-settings-group-title"><i class="fa-solid fa-clock-rotate-left"></i><span>${t`Image context`}</span></div>
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

            <div class="iig-settings-group" id="iig_additional_refs_section">
                <div class="iig-settings-group-title"><i class="fa-solid fa-images"></i><span>${t`Additional references`}</span></div>

                <details class="iig-reference-library-settings">
                    <summary><i class="fa-solid fa-book"></i><span>${t`Reference libraries`}</span></summary>
                    <div class="iig-reference-library-settings-body">
                        ${buildLorebookBarHtml(settings)}
                    </div>
                </details>

                <div class="iig-additional-ref-toolbar">
                    <div class="iig-ref-mode-toggle" role="group" aria-label="${t`Reference list mode`}">
                        <label>
                            <input type="radio" name="iig_additional_refs_mode" value="simple" ${settings.additionalReferencesMode !== 'power' ? 'checked' : ''}>
                            <span>${t`Simple`}</span>
                        </label>
                        <label>
                            <input type="radio" name="iig_additional_refs_mode" value="power" ${settings.additionalReferencesMode === 'power' ? 'checked' : ''}>
                            <span>${t`Power users`}</span>
                        </label>
                    </div>
                    <div class="iig-additional-ref-actions">
                        <button type="button" id="iig_additional_refs_add" class="menu_button iig-button-inline">
                            <i class="fa-solid fa-plus"></i><span>${t`Add reference`}</span>
                        </button>
                        <button type="button" id="iig_additional_refs_import" class="menu_button iig-button-inline">
                            <i class="fa-solid fa-link"></i><span>${t`Load reference`}</span>
                        </button>
                    </div>
                </div>
                <label class="checkbox_label">
                    <input type="checkbox" id="iig_send_ref_descriptions" ${settings.sendRefDescriptions !== false ? 'checked' : ''}>
                    <span>${t`Send reference descriptions from lorebook`}</span>
                </label>
                <div id="iig_additional_refs_status" class="hint" style="margin-bottom: 8px;"></div>
                <div id="iig_additional_refs_list"></div>
            </div>

            <div class="iig-settings-group ${refsSectionVisible ? '' : 'iig-hidden'}" id="iig_ref_instruction_section">
                <div class="iig-settings-group-title"><i class="fa-solid fa-terminal"></i><span>${t`Reference instruction`}</span></div>
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
    return buildSettingsSectionHtml('iig_references_section', t`References`, bodyHtml, false);
}

// ----- Debug section -----

function buildDebugSettingsSectionHtml(settings = getSettings()) {
    const bodyHtml = `
        <div class="iig-settings-card">
            <div class="iig-settings-group">
                <div class="iig-settings-group-title"><i class="fa-solid fa-arrows-rotate"></i><span>${t`Retries`}</span></div>
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
            <div class="iig-settings-group">
                <div class="iig-settings-group-title"><i class="fa-solid fa-magnifying-glass"></i><span>${t`Diagnostics`}</span></div>
                <div class="iig-debug-actions">
                    <div id="iig_show_last_request" class="menu_button iig-button-inline" title="${t`View prompt and references sent in the most recent generation`}">
                        <i class="fa-solid fa-magnifying-glass"></i> ${t`Show last request`}
                    </div>
                    <div id="iig_show_book_macro" class="menu_button iig-button-inline" title="${t`Preview the rendered {{iig-book}} macro as the LLM will see it`}">
                        <i class="fa-solid fa-book"></i> ${t`Show {{iig-book}} preview`}
                    </div>
                </div>
            </div>
            <div class="iig-settings-group">
                <div class="iig-settings-group-title"><i class="fa-solid fa-file-arrow-down"></i><span>${t`Logs`}</span></div>
                <div class="iig-debug-actions">
                    <div id="iig_export_logs" class="menu_button iig-button-inline">
                        <i class="fa-solid fa-download"></i> ${t`Export logs`}
                    </div>
                </div>
            </div>
            <div class="iig-settings-group">
                <div class="iig-settings-group-title"><i class="fa-solid fa-images"></i><span>${t`Generations`}</span></div>
                <div class="iig-library-generation-management">
                    <button type="button" class="menu_button redWarningBG iig-library-generations-clear-all"><i class="fa-solid fa-trash"></i><span>${t`Clear all images`}</span></button>
                    <span class="iig-library-generations-status" role="status" hidden></span>
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

function formatMatchReason(reason) {
    if (!reason || typeof reason !== 'object') return '';
    switch (reason.kind) {
        case 'always':
            return t`always`;
        case 'primary':
            return t`alias: ${reason.detail || ''}`;
        case 'regex':
            return t`regex: ${reason.detail || ''}`;
        case 'regex-fallback':
            return t`invalid regex, fell back to literal: ${reason.detail || ''}`;
        default:
            return reason.kind || '';
    }
}

function buildMatchedRefsSectionHtml(matched) {
    if (!Array.isArray(matched) || matched.length === 0) {
        return `<p class="hint">${t`No additional references were matched in this request.`}</p>`;
    }
    const rows = matched.map((m) => {
        const primary = String(m.name || '').split(',')[0].trim();
        const metaBits = [];
        if (m.lorebookName) metaBits.push(sanitizeForHtml(m.lorebookName));
        if (m.group) metaBits.push(`[${sanitizeForHtml(m.group)}]`);
        if (Number.isFinite(m.priority) && m.priority !== 0) metaBits.push(`p=${m.priority}`);
        const reasonText = sanitizeForHtml(formatMatchReason(m.reason));
        return `
            <div class="iig-matched-ref-row">
                <span class="iig-matched-ref-name">${sanitizeForHtml(primary || m.name || '')}</span>
                ${metaBits.length > 0 ? `<span class="iig-matched-ref-meta">${metaBits.join(' · ')}</span>` : ''}
                ${reasonText ? `<span class="iig-matched-ref-reason">${reasonText}</span>` : ''}
            </div>
        `;
    });
    return `<div class="iig-matched-refs">${rows.join('')}</div>`;
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
    pushRow(t`Steps`, meta.steps);
    pushRow(t`CFG scale`, meta.cfgScale);
    pushRow(t`CFG rescale`, meta.cfgRescale);
    pushRow(t`Sampler`, meta.sampler);
    pushRow(t`Noise schedule`, meta.noiseSchedule);
    pushRow(t`Seed`, meta.seed);
    pushRow(t`Reference instruction applied`, meta.refInstructionApplied ? t`yes` : t`no`);

    const refsHtml = Array.isArray(snapshot.references) && snapshot.references.length > 0
        ? snapshot.references.map((ref) => `
            <div class="iig-last-req-ref">
                <img class="iig-last-req-ref-thumb" src="${sanitizeForHtml(ref.dataUrl)}" alt="${sanitizeForHtml(ref.label || '')}">
                <span class="iig-last-req-ref-label">${sanitizeForHtml(ref.label || '')}</span>
            </div>`).join('')
        : `<p class="hint">${t`No references were sent.`}</p>`;

    const matchedCount = Array.isArray(snapshot.matchedRefs) ? snapshot.matchedRefs.length : 0;

    return `
        <div class="iig-last-req">
            <div class="iig-last-req-meta">${rows.join('')}</div>
            <h4>${t`Matched references`} (${matchedCount})</h4>
            ${buildMatchedRefsSectionHtml(snapshot.matchedRefs || [])}
            <h4>${t`Final prompt sent to provider`}</h4>
            <pre class="iig-last-req-prompt">${sanitizeForHtml(snapshot.prompt || '')}</pre>
            ${snapshot.negativePrompt ? `<h4>${t`Negative prompt`}</h4><pre class="iig-last-req-prompt">${sanitizeForHtml(snapshot.negativePrompt)}</pre>` : ''}
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

// ----- {{iig-book}} macro preview popup -----

async function showIigBookPreviewPopup() {
    const rendered = renderIigBookMacro(getSettings(), resolveActiveProvider()?.supportsReferences(getSettings()) === true);
    const hintHtml = `<p class="hint">${t`Paste {{iig-book}} into a character card or preset to inject this text into the LLM's context. Only enabled lorebooks with active references are included.`}</p>`;
    const bodyHtml = rendered
        ? `${hintHtml}<pre class="iig-last-req-prompt">${sanitizeForHtml(rendered)}</pre>`
        : `${hintHtml}<p class="hint">${t`The macro is currently empty: no enabled lorebook has any references with a name.`}</p>`;
    await Popup.show.text(t`{{iig-book}} preview`, bodyHtml, { allowVerticalScrolling: true, wide: true });
}

// ----- Section toggles -----

// ----- Avatar section events (общая фабрика для Gemini и Naistera) -----

/**
 * Configures one provider-specific avatar reference block.
 */
function bindAvatarSectionEvents(settings, updateVisibility, config) {
    const {
        sendCharCheckboxId,
        sendCharKey,
        sendUserCheckboxId,
        sendUserKey,
        useActivePersonaCheckboxId,
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
        refreshIfContextChanged(settings).catch(() => {});
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

    async function importAndRenderLorebook(importer, source) {
        try {
            const stats = await importer(source);
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
        } catch (error) {
            console.error('[IIG] Lorebook import failed:', error);
            toastr.error(t`Import error: ${error.message || error}`, t`Image Generation`);
        }
    }

    document.getElementById('iig_lorebook_import_url')?.addEventListener('click', async () => {
        const url = await Popup.show.input(
            t`Import lorebook from URL`,
            t`Paste a direct URL to a JSON lorebook file:`,
        );
        if (typeof url !== 'string') return;
        const trimmed = url.trim();
        if (!trimmed) return;
        await importAndRenderLorebook(importLorebookFromUrl, trimmed);
    });

    document.getElementById('iig_lorebook_import_file_input')?.addEventListener('change', async (e) => {
        const input = e.target;
        if (!(input instanceof HTMLInputElement)) return;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        await importAndRenderLorebook(importLorebookFromFile, file);
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

let selectedAdditionalReferenceId = '';
let additionalReferenceSearchQuery = '';
let additionalReferenceFilter = 'all';

function getAdditionalReferenceIndex(element) {
    const container = element?.closest?.('[data-ref-index]');
    const index = Number.parseInt(String(container?.getAttribute('data-ref-index') || ''), 10);
    return Number.isInteger(index) ? index : -1;
}

function filterAdditionalReferenceRows() {
    const query = additionalReferenceSearchQuery.trim().toLowerCase();
    const rows = [...document.querySelectorAll('.iig-additional-ref-list-row')];
    let visibleCount = 0;
    for (const row of rows) {
        const matchesQuery = !query || String(row.getAttribute('data-ref-search') || '').includes(query);
        const matchesFilter = additionalReferenceFilter === 'all'
            || (additionalReferenceFilter === 'enabled' && row.getAttribute('data-ref-enabled') === 'true')
            || row.getAttribute('data-ref-match-mode') === additionalReferenceFilter;
        const visible = matchesQuery && matchesFilter;
        row.classList.toggle('iig-hidden', !visible);
        if (visible) visibleCount += 1;
    }
    document.getElementById('iig_additional_refs_no_results')?.classList.toggle(
        'iig-hidden',
        rows.length === 0 || visibleCount > 0,
    );
}

function refreshAdditionalReferencesList() {
    const settings = getSettings();
    const refs = getActiveLorebookReferences(settings);
    if (!refs.some((ref) => ref.id === selectedAdditionalReferenceId)) {
        selectedAdditionalReferenceId = refs[0]?.id || '';
    }
    renderAdditionalReferencesList(getActiveProviderMaxReferences(settings), {
        selectedId: selectedAdditionalReferenceId,
        query: additionalReferenceSearchQuery,
        filter: additionalReferenceFilter,
        supportsImageReferences: resolveActiveProvider(settings)?.supportsReferences(settings) === true,
    });
    filterAdditionalReferenceRows();
}

function updateAdditionalReferenceListPreview(ref) {
    const row = [...document.querySelectorAll('.iig-additional-ref-list-row')]
        .find((item) => item.getAttribute('data-ref-id') === ref.id);
    if (!row) return;
    const title = String(ref.name || '').trim() || t`Untitled reference`;
    const description = String(ref.description || '').replace(/\s+/g, ' ').trim() || t`No description`;
    const titleElement = row.querySelector('.iig-additional-ref-list-copy strong');
    const descriptionElement = row.querySelector('.iig-additional-ref-list-copy small');
    if (titleElement) titleElement.textContent = title;
    if (descriptionElement) descriptionElement.textContent = description;
    row.setAttribute('data-ref-search', `${ref.name || ''} ${ref.description || ''} ${ref.group || ''}`.toLowerCase());
    const editorTitle = document.querySelector('.iig-additional-ref-editor-heading strong');
    if (editorTitle) editorTitle.textContent = title;
    filterAdditionalReferenceRows();
}

function bindAdditionalReferencesEvents(settings) {
    document.querySelectorAll('input[name="iig_additional_refs_mode"]').forEach((input) => {
        input.addEventListener('change', (e) => {
            if (!(e.target instanceof HTMLInputElement) || !e.target.checked) return;
            settings.additionalReferencesMode = e.target.value === 'power' ? 'power' : 'simple';
            saveSettings();
            refreshLorebookBar(settings);
            refreshAdditionalReferencesList();
        });
    });

    document.getElementById('iig_additional_refs_add')?.addEventListener('click', () => {
        const refs = getActiveLorebookReferences(settings);
        if (refs.length >= MAX_ADDITIONAL_REFERENCES) {
            toastr.warning(t`Maximum additional references: ${MAX_ADDITIONAL_REFERENCES}`, t`Image Generation`);
            return;
        }

        refs.unshift({
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
        selectedAdditionalReferenceId = getActiveLorebookReferences(settings)[0]?.id || '';
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
            refreshAdditionalReferencesList();
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
        if (target.closest('[disabled]')) return;

        if (target.id === 'iig_additional_refs_search') {
            additionalReferenceSearchQuery = target.value;
            filterAdditionalReferenceRows();
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

        const index = getAdditionalReferenceIndex(target);
        if (index < 0) return;

        const refs = getActiveLorebookReferences(settings);
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
        updateAdditionalReferenceListPreview(refs[index]);
        renderAdditionalReferencesStatus(getActiveProviderMaxReferences(settings));
    });

    document.getElementById('iig_additional_refs_list')?.addEventListener('change', async (e) => {
        const target = e.target;
        if (target instanceof Element && target.closest('[disabled]')) return;
        if (target instanceof HTMLSelectElement && target.id === 'iig_additional_refs_filter') {
            additionalReferenceFilter = ['enabled', 'match', 'always'].includes(target.value) ? target.value : 'all';
            filterAdditionalReferenceRows();
            return;
        }

        if (target instanceof HTMLInputElement && target.classList.contains('iig-additional-ref-enabled')) {
            const index = getAdditionalReferenceIndex(target);
            if (index < 0) return;

            const refs = getActiveLorebookReferences(settings);
            if (!refs[index]) {
                return;
            }

            refs[index].enabled = target.checked;
            saveSettings();
            refreshAdditionalReferencesList();
            return;
        }

        if (target instanceof HTMLSelectElement && target.classList.contains('iig-additional-ref-match-mode')) {
            const index = getAdditionalReferenceIndex(target);
            const refs = getActiveLorebookReferences(settings);
            if (index < 0 || !refs[index]) return;
            refs[index].matchMode = target.value === 'always' ? 'always' : 'match';
            saveSettings();
            refreshAdditionalReferencesList();
            return;
        }

        if (target instanceof HTMLInputElement && target.classList.contains('iig-additional-ref-regex')) {
            const index = getAdditionalReferenceIndex(target);
            const refs = getActiveLorebookReferences(settings);
            if (index < 0 || !refs[index]) return;
            refs[index].useRegex = target.checked;
            saveSettings();
            refreshAdditionalReferencesList();
            return;
        }

        if (!(target instanceof HTMLInputElement) || !target.classList.contains('iig-additional-ref-file')) {
            return;
        }

        const index = getAdditionalReferenceIndex(target);
        if (index < 0) {
            target.value = '';
            return;
        }

        const file = target.files?.[0];
        if (!file) {
            target.value = '';
            return;
        }

        const refs = getActiveLorebookReferences(settings);
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

    document.getElementById('iig_additional_refs_list')?.addEventListener('click', async (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;
        if (target.closest('[disabled]')) return;

        const selectButton = target.closest('[data-ref-select]');
        if (selectButton) {
            selectedAdditionalReferenceId = String(selectButton.getAttribute('data-ref-select') || '');
            refreshAdditionalReferencesList();
            return;
        }

        const urlBtn = target.closest('.iig-additional-ref-upload-url');
        const removeBtn = !urlBtn ? target.closest('.iig-additional-ref-remove') : null;
        const upBtn = !urlBtn && !removeBtn ? target.closest('.iig-additional-ref-move-up') : null;
        const downBtn = !urlBtn && !removeBtn && !upBtn ? target.closest('.iig-additional-ref-move-down') : null;
        const button = urlBtn || removeBtn || upBtn || downBtn;
        if (!button) return;

        const index = getAdditionalReferenceIndex(button);
        if (index < 0) return;

        const refs = getActiveLorebookReferences(settings);
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
            selectedAdditionalReferenceId = refs[index]?.id || refs[index - 1]?.id || '';
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

    document.getElementById('iig_send_ref_descriptions')?.addEventListener('change', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        settings.sendRefDescriptions = e.target.checked;
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
    document.querySelector('#iig_debug_section .iig-library-generations-clear-all')?.addEventListener('click', () => {
        clearAllGenerationImages(settings);
    });

    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => {
        const n = parseInt(e.target.value, 10);
        settings.maxRetries = Number.isFinite(n) && n >= 0 ? n : 3;
        saveSettings();
    });

    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => {
        const n = parseInt(e.target.value, 10);
        settings.retryDelay = Number.isFinite(n) && n >= 0 ? n : 1000;
        saveSettings();
    });

    document.getElementById('iig_export_logs')?.addEventListener('click', () => {
        exportLogs();
    });

    document.getElementById('iig_show_last_request')?.addEventListener('click', () => {
        showLastRequestPopup();
    });

    document.getElementById('iig_show_book_macro')?.addEventListener('click', () => {
        showIigBookPreviewPopup();
    });
}

// ----- Main bind -----

function bindSettingsEvents() {
    const settings = getSettings();
    const updateVisibility = buildUpdateVisibility(settings, refsSupported => {
        syncAdditionalReferenceAvailability(refsSupported);
        filterAdditionalReferenceRows();
        document.getElementById('iig_additional_refs_import').disabled = !refsSupported;
        const addLabel = document.querySelector('#iig_additional_refs_add span');
        if (addLabel) addLabel.textContent = refsSupported ? t`Add reference` : t`Add description`;

        // Обновляем provider-limit warning в status-строке без ре-рендера
        // карточек (чтобы не терять фокус в inputs).
        renderAdditionalReferencesStatus(getActiveProviderMaxReferences(settings));
    });

    const reloadModels = bindApiSectionEvents(settings, updateVisibility);
    bindConnectionProfilesEvents(settings, updateVisibility, reloadModels);

    // Gemini avatar section
    bindAvatarSectionEvents(settings, updateVisibility, {
        sendCharCheckboxId: 'iig_send_char_avatar',
        sendCharKey: 'sendCharAvatar',
        sendUserCheckboxId: 'iig_send_user_avatar',
        sendUserKey: 'sendUserAvatar',
        useActivePersonaCheckboxId: 'iig_use_active_persona_avatar',
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
        refreshButtonId: 'iig_naistera_refresh_avatars',
        userAvatarDropdownId: 'iig_naistera_user_avatar_dropdown',
    });

    bindAvatarDropdownToggles();
    bindStylesSectionEvents(settings);
    bindLorebookBarEvents(settings);
    bindAdditionalReferencesEvents(settings);
    bindCharacterLibraryEvents(settings);
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

    if (document.getElementById('iig_settings_root')) {
        bindCharacterLibraryEvents(settings);
        return;
    }

    const html = `
        <div id="iig_settings_root" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${t`Image Generation`}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    ${buildApiSettingsSectionHtml(settings)}
                    ${buildStylesSettingsSectionHtml(settings)}
                    ${buildCharactersSettingsSectionHtml(settings)}
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
