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
    normalizeNaisteraModel,
    normalizeNaisteraVideoFrequency,
    normalizeImageContextCount,
    normalizeConfiguredEndpoint,
    shouldReplaceEndpointForApiType,
    getEndpointPlaceholder,
    MAX_CONTEXT_IMAGES,
    MAX_ADDITIONAL_REFERENCES,
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
} from './references.js';
import { isGeminiModel, fetchModels, resolveActiveProvider } from './providers.js';

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

function buildApiSettingsSectionHtml(settings = getSettings()) {
    const bodyHtml = `
        <div class="iig-settings-card">
            <label class="checkbox_label">
                <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                <span>Включить генерацию картинок</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="iig_external_blocks" ${settings.externalBlocks ? 'checked' : ''}>
                <span>Работа с внешними блоками</span>
            </label>

            <div class="flex-row">
                <label for="iig_api_type">Тип API</label>
                <select id="iig_api_type" class="flex1">
                    <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый (/v1/images/generations)</option>
                    <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini-совместимый (nano-banana)</option>
                    <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>Naistera (naistera.org)</option>
                </select>
                <div></div>
            </div>

            <div class="flex-row">
                <label for="iig_endpoint">URL эндпоинта</label>
                <input type="text" id="iig_endpoint" class="text_pole flex1" value="${settings.endpoint}" placeholder="https://api.example.com">
                <div></div>
            </div>

            <div class="flex-row">
                <label for="iig_api_key">API ключ</label>
                <input type="password" id="iig_api_key" class="text_pole flex1" value="${settings.apiKey}">
                <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть">
                    <i class="fa-solid fa-eye"></i>
                </div>
            </div>

            <p id="iig_naistera_hint" class="hint ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}">Для Naistera: вставьте токен из Telegram бота и выберите модель (grok / grok-pro / nano banana 2 / novelai).</p>

            <div class="flex-row ${settings.apiType === 'naistera' ? 'iig-hidden' : ''}" id="iig_model_row">
                <label for="iig_model">Модель</label>
                <select id="iig_model" class="flex1">
                    ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">-- Выберите модель --</option>'}
                </select>
                <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить список">
                    <i class="fa-solid fa-sync"></i>
                </div>
            </div>

            <div class="flex-row ${settings.apiType !== 'openai' ? 'iig-hidden' : ''}" id="iig_size_row">
                <label for="iig_size">Размер</label>
                <select id="iig_size" class="flex1">
                    <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024x1024 (Квадрат)</option>
                    <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>1792x1024 (Альбомная)</option>
                    <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>1024x1792 (Портретная)</option>
                    <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512x512 (Маленький)</option>
                </select>
                <div></div>
            </div>

            <div class="flex-row ${settings.apiType !== 'openai' ? 'iig-hidden' : ''}" id="iig_quality_row">
                <label for="iig_quality">Качество</label>
                <select id="iig_quality" class="flex1">
                    <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Стандартное</option>
                    <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option>
                </select>
                <div></div>
            </div>

            <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_model_row">
                <label for="iig_naistera_model">Модель</label>
                <select id="iig_naistera_model" class="flex1">
                    <option value="grok" ${normalizeNaisteraModel(settings.naisteraModel) === 'grok' ? 'selected' : ''}>grok</option>
                    <option value="grok-pro" ${normalizeNaisteraModel(settings.naisteraModel) === 'grok-pro' ? 'selected' : ''}>grok-pro</option>
                    <option value="nano banana 2" ${normalizeNaisteraModel(settings.naisteraModel) === 'nano banana 2' ? 'selected' : ''}>nano banana 2</option>
                    <option value="novelai" ${normalizeNaisteraModel(settings.naisteraModel) === 'novelai' ? 'selected' : ''}>novelai</option>
                </select>
                <div></div>
            </div>

            <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_aspect_row">
                <label for="iig_naistera_aspect_ratio">Соотношение сторон</label>
                <select id="iig_naistera_aspect_ratio" class="flex1">
                    <option value="1:1" ${settings.naisteraAspectRatio === '1:1' ? 'selected' : ''}>1:1</option>
                    <option value="16:9" ${settings.naisteraAspectRatio === '16:9' ? 'selected' : ''}>16:9</option>
                    <option value="9:16" ${settings.naisteraAspectRatio === '9:16' ? 'selected' : ''}>9:16</option>
                    <option value="3:2" ${settings.naisteraAspectRatio === '3:2' ? 'selected' : ''}>3:2</option>
                    <option value="2:3" ${settings.naisteraAspectRatio === '2:3' ? 'selected' : ''}>2:3</option>
                </select>
                <div></div>
            </div>

            <div id="iig_avatar_section" class="iig-settings-card-nested ${settings.apiType !== 'gemini' ? 'iig-hidden' : ''}">
                <div class="flex-row">
                    <label for="iig_aspect_ratio">Соотношение сторон</label>
                    <select id="iig_aspect_ratio" class="flex1">
                        <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>1:1 (Квадрат)</option>
                        <option value="2:3" ${settings.aspectRatio === '2:3' ? 'selected' : ''}>2:3 (Портрет)</option>
                        <option value="3:2" ${settings.aspectRatio === '3:2' ? 'selected' : ''}>3:2 (Альбом)</option>
                        <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>3:4 (Портрет)</option>
                        <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>4:3 (Альбом)</option>
                        <option value="4:5" ${settings.aspectRatio === '4:5' ? 'selected' : ''}>4:5 (Портрет)</option>
                        <option value="5:4" ${settings.aspectRatio === '5:4' ? 'selected' : ''}>5:4 (Альбом)</option>
                        <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>9:16 (Вертикальный)</option>
                        <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>16:9 (Широкий)</option>
                        <option value="21:9" ${settings.aspectRatio === '21:9' ? 'selected' : ''}>21:9 (Ультраширокий)</option>
                    </select>
                    <div></div>
                </div>
                <div class="flex-row">
                    <label for="iig_image_size">Разрешение</label>
                    <select id="iig_image_size" class="flex1">
                        <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>1K (по умолчанию)</option>
                        <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K</option>
                        <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K</option>
                    </select>
                    <div></div>
                </div>
            </div>

            <div class="iig-settings-card-nested ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_video_section">
                <h4>Видео</h4>
                <label class="checkbox_label">
                    <input type="checkbox" id="iig_naistera_video_test" ${settings.naisteraVideoTest ? 'checked' : ''}>
                    <span>Включить генерацию видео</span>
                </label>
                <div class="iig-video-frequency-row ${settings.naisteraVideoTest ? '' : 'iig-hidden'}" id="iig_naistera_video_frequency_row">
                    <div class="iig-video-frequency-input">
                        <span>Каждые</span>
                        <input type="number" id="iig_naistera_video_every_n" class="text_pole" min="1" max="999" step="1" value="${normalizeNaisteraVideoFrequency(settings.naisteraVideoEveryN)}">
                        <span>сообщений.</span>
                    </div>
                </div>
            </div>
        </div>
    `;
    return buildSettingsSectionHtml('iig_api_section', 'Настройки API', bodyHtml, true);
}

// ----- Styles section -----

function buildStyleListHtml(settings = getSettings()) {
    const styles = ensureStyles(settings);
    const activeId = settings.activeStyleId;

    if (styles.length === 0) {
        return '<p class="hint">Нет стилей. Добавьте стиль и активируйте его.</p>';
    }

    return styles.map((style) => `
        <div class="iig-style-preset-row ${style.id === activeId ? 'iig-style-preset-row-active' : ''}" data-style-id="${style.id}">
            <div class="menu_button iig-style-preset-select" data-style-activate="${style.id}">
                <i class="fa-solid ${style.id === activeId ? 'fa-check-circle' : 'fa-palette'}"></i>
                <span>${sanitizeForHtml(style.name)}</span>
            </div>
            <div class="menu_button iig-style-preset-remove" data-style-remove="${style.id}" title="Удалить стиль">
                <i class="fa-solid fa-trash"></i>
            </div>
        </div>
    `).join('');
}

function buildStyleEditorHtml(settings = getSettings()) {
    const activeStyle = getActiveStyle(settings);
    if (!activeStyle) {
        return '<p class="hint">Активируйте стиль, чтобы редактировать его значение.</p>';
    }

    return `
        <div class="iig-settings-card iig-style-editor-card">
            <h4>Активный стиль: ${sanitizeForHtml(activeStyle.name)}</h4>
            <div class="flex-row">
                <label for="iig_style_name">Название</label>
                <input type="text" id="iig_style_name" class="text_pole flex1" value="${sanitizeForHtml(activeStyle.name)}">
                <div id="iig_style_disable" class="menu_button" title="Выключить стиль">
                    <i class="fa-solid fa-power-off"></i>
                </div>
            </div>
            <div class="flex-row">
                <label for="iig_style_value">Значение</label>
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
                <label for="iig_new_style_name">Новый стиль</label>
                <input type="text" id="iig_new_style_name" class="text_pole flex1" placeholder="Название стиля">
                <div id="iig_style_add" class="menu_button" title="Добавить стиль">
                    <i class="fa-solid fa-plus"></i>
                </div>
            </div>
            <div id="iig_style_presets" class="iig-style-presets"></div>
            <div id="iig_style_editor"></div>
        </div>
    `;
    return buildSettingsSectionHtml('iig_styles_section', 'Стили', bodyHtml, false);
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
                <span>Отправлять аватар {{char}}</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="${sendUserCheckboxId}" ${sendUserEnabled ? 'checked' : ''}>
                <span>Отправлять аватар {{user}}</span>
            </label>
            <label id="${useActivePersonaRowId}" class="checkbox_label ${useActivePersonaRowHidden ? useActivePersonaHiddenClass : ''}">
                <input type="checkbox" id="${useActivePersonaCheckboxId}" ${useActivePersonaEnabled ? 'checked' : ''}>
                <span>Брать аватар из активной персоны {{user}}</span>
            </label>
            <div id="${userAvatarRowId}" class="flex-row ${userAvatarRowHidden ? userAvatarRowHiddenClass : ''}">
                <label>Аватар {{user}}</label>
                ${userAvatarDropdownHtml}
                <div id="${refreshButtonId}" class="menu_button iig-refresh-btn" title="Обновить список">
                    <i class="fa-solid fa-sync"></i>
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
    const commonAvatarRefsVisible = (isGemini || isOpenAI) && refsSupported;
    const naisteraRefsVisible = settings.apiType === 'naistera' && refsSupported;

    const geminiAvatarsBlock = buildAvatarReferencesBlockHtml({
        sectionId: 'iig_avatar_refs_section',
        hiddenClass: 'iig-hidden',
        hidden: !commonAvatarRefsVisible,
        title: isOpenAI ? 'OpenAI / GPT Image' : 'Gemini / nano-banana',
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
                <h4>Контекст картинок</h4>
                <label class="checkbox_label">
                    <input type="checkbox" id="iig_image_context_enabled" ${settings.imageContextEnabled ? 'checked' : ''}>
                    <span>Включить контекст картинок</span>
                </label>
                <div class="iig-video-frequency-row ${settings.imageContextEnabled ? '' : 'iig-hidden'}" id="iig_image_context_count_row">
                    <div class="iig-video-frequency-input">
                        <span>Использовать</span>
                        <input type="number" id="iig_image_context_count" class="text_pole" min="1" max="${MAX_CONTEXT_IMAGES}" step="1" value="${normalizeImageContextCount(settings.imageContextCount)}">
                        <span>предыдущих картинок.</span>
                    </div>
                </div>
            </div>

            <div class="iig-settings-card-nested ${refsSectionVisible ? '' : 'iig-hidden'}" id="iig_additional_refs_section">
                <h4>Дополнительные референсы</h4>
                <div class="iig-additional-ref-actions">
                    <div id="iig_additional_refs_add" class="menu_button iig-button-inline">
                        <i class="fa-solid fa-plus"></i> Добавить референс
                    </div>
                    <div id="iig_additional_refs_import" class="menu_button iig-button-inline">
                        <i class="fa-solid fa-link"></i> Загрузить референс
                    </div>
                </div>
                <div id="iig_additional_refs_status" class="hint" style="margin-bottom: 8px;"></div>
                <div id="iig_additional_refs_list"></div>
            </div>
        </div>
    `;
    return buildSettingsSectionHtml('iig_references_section', 'Референсы', bodyHtml, true);
}

// ----- Debug section -----

function buildDebugSettingsSectionHtml(settings = getSettings()) {
    const bodyHtml = `
        <div class="iig-settings-card">
            <div class="iig-settings-card-nested">
                <div class="flex-row">
                    <label for="iig_max_retries">Макс. повторов</label>
                    <input type="number" id="iig_max_retries" class="text_pole flex1" value="${settings.maxRetries}" min="0" max="5">
                    <div></div>
                </div>
                <div class="flex-row">
                    <label for="iig_retry_delay">Задержка (мс)</label>
                    <input type="number" id="iig_retry_delay" class="text_pole flex1" value="${settings.retryDelay}" min="500" max="10000" step="500">
                    <div></div>
                </div>
            </div>
            <div class="iig-debug-actions">
                <div id="iig_export_logs" class="menu_button iig-button-inline">
                    <i class="fa-solid fa-download"></i> Экспорт логов
                </div>
            </div>
        </div>
    `;
    return buildSettingsSectionHtml('iig_debug_section', 'Отладка', bodyHtml, false);
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

    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value;
        saveSettings();

        // Auto-switch API type based on model
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
        }

        // Модель влияет на поддержку референсов (gpt-image-* vs dall-e-*),
        // поэтому перестраиваем видимость секций при любой смене.
        updateVisibility();
    });

    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');

        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');

            const currentModel = settings.model;

            select.innerHTML = '<option value="">-- Выберите модель --</option>';

            for (const model of models) {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                option.selected = model === currentModel;
                select.appendChild(option);
            }

            toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
        } catch (error) {
            toastr.error('Ошибка загрузки моделей', 'Генерация картинок');
        } finally {
            btn.classList.remove('loading');
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

            toastr.success(`Найдено аватаров: ${avatars.length}`, 'Генерация картинок');
            document.getElementById(userAvatarDropdownId)?.classList.add('open');
        } catch (error) {
            toastr.error('Ошибка загрузки аватаров', 'Генерация картинок');
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

// ----- Additional references events -----

function bindAdditionalReferencesEvents(settings) {
    document.getElementById('iig_additional_refs_add')?.addEventListener('click', () => {
        const refs = ensureAdditionalReferencesArray(settings);
        if (refs.length >= MAX_ADDITIONAL_REFERENCES) {
            toastr.warning(`Максимум дополнительных референсов: ${MAX_ADDITIONAL_REFERENCES}`, 'Генерация картинок');
            return;
        }

        refs.push({ name: '', description: '', imagePath: '', matchMode: 'match', enabled: true });
        saveSettings();
        renderAdditionalReferencesList();
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
            toastr.success(
                `Загружено: ${result.importedCount}${result.skippedCount > 0 ? `, пропущено: ${result.skippedCount}` : ''}`,
                'Генерация картинок'
            );
        } catch (error) {
            toastr.error(`Ошибка импорта: ${error.message || error}`, 'Генерация картинок');
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
        if (!isNameField && !isDescriptionField) {
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

        if (isNameField) {
            refs[index].name = target.value;
        }
        if (isDescriptionField) {
            refs[index].description = target.value;
        }
        saveSettings();
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
            renderAdditionalReferencesList();
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
            renderAdditionalReferencesList();
            toastr.success('Дополнительный референс сохранён', 'Генерация картинок');
        } catch (error) {
            console.error('[IIG] Failed to upload additional reference:', error);
            toastr.error(`Ошибка загрузки референса: ${error.message || error}`, 'Генерация картинок');
        } finally {
            target.value = '';
        }
    });

    document.getElementById('iig_additional_refs_list')?.addEventListener('change', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement) || !target.classList.contains('iig-additional-ref-always')) {
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

        refs[index].matchMode = target.checked ? 'always' : 'match';
        saveSettings();
        renderAdditionalReferencesList();
    });

    document.getElementById('iig_additional_refs_list')?.addEventListener('click', (e) => {
        const target = e.target;
        const button = target instanceof Element ? target.closest('.iig-additional-ref-remove') : null;
        if (!button) {
            return;
        }

        const row = button.closest('.iig-additional-ref-row');
        const index = Number.parseInt(String(row?.getAttribute('data-ref-index') || ''), 10);
        if (!Number.isInteger(index)) {
            return;
        }

        const refs = ensureAdditionalReferencesArray(settings);
        refs.splice(index, 1);
        saveSettings();
        renderAdditionalReferencesList();
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
}

// ----- Visibility recomputation -----

function buildUpdateVisibility(settings) {
    return () => {
        const apiType = settings.apiType;
        const isNaistera = apiType === 'naistera';
        const isGemini = apiType === 'gemini';
        const isOpenAI = apiType === 'openai';

        // Поддерживает ли активный провайдер референсы (учитывая модель).
        const provider = resolveActiveProvider(settings);
        const refsSupported = provider ? provider.supportsReferences(settings) : false;
        const naisteraRefsSupported = isNaistera && refsSupported;

        // «Общий» avatar refs блок (char/user аватар с чекбоксами) — теперь
        // показывается не только для Gemini, но и для любого OpenAI-семейства,
        // которое поддерживает /edits. Naistera использует свой отдельный блок.
        const commonAvatarRefsVisible = (isGemini || isOpenAI) && refsSupported;

        // Model is used for OpenAI and Gemini; Naistera does not need a model.
        document.getElementById('iig_model_row')?.classList.toggle('iig-hidden', isNaistera);
        document.getElementById('iig_image_context_section')?.classList.toggle('iig-hidden', !refsSupported);
        document.getElementById('iig_image_context_count_row')?.classList.toggle('iig-hidden', !(refsSupported && settings.imageContextEnabled));
        document.getElementById('iig_additional_refs_section')?.classList.toggle('iig-hidden', !refsSupported);

        // OpenAI-only params
        document.getElementById('iig_size_row')?.classList.toggle('iig-hidden', !isOpenAI);
        document.getElementById('iig_quality_row')?.classList.toggle('iig-hidden', !isOpenAI);

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

        // Nano-banana-specific params (aspect + image size) — только для Gemini.
        const avatarSection = document.getElementById('iig_avatar_section');
        if (avatarSection) {
            avatarSection.classList.toggle('iig-hidden', !isGemini);
        }

        // «Общий» avatar refs блок — для Gemini и OpenAI-c-refs.
        const avatarRefsSection = document.getElementById('iig_avatar_refs_section');
        if (avatarRefsSection) {
            avatarRefsSection.classList.toggle('iig-hidden', !commonAvatarRefsVisible);

            // Обновляем заголовок при смене провайдера (Gemini ↔ OpenAI).
            const titleEl = avatarRefsSection.querySelector('h4');
            if (titleEl) {
                titleEl.textContent = isOpenAI ? 'OpenAI / GPT Image' : 'Gemini / nano-banana';
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
    bindAdditionalReferencesEvents(settings);
    bindDebugSectionEvents(settings);

    // Apply initial state
    syncUserAvatarSelection(settings.userAvatarFile);
    syncActivePersonaAvatarMode(settings.useActiveUserPersonaAvatar);
    renderAdditionalReferencesList();
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
                <b>Генерация картинок</b>
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
