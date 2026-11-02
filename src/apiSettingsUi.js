/** API settings rendering, model controls and connection-profile events. */
import {
    getSettings, saveSettings, iigLog, normalizeNaisteraModel, normalizeNaisteraVideoFrequency,
    normalizeImageContextCount, normalizeConfiguredEndpoint, shouldReplaceEndpointForApiType, getEndpointPlaceholder,
    ensureConnectionProfiles, getActiveConnectionProfile, createConnectionProfile,
    saveCurrentIntoProfile, loadConnectionProfile, renameConnectionProfile, removeConnectionProfile,
} from './settings.js';
import { sanitizeForHtml } from './utils.js';
import { fetchModels, resolveActiveProvider, A1111_RESOLUTION_PRESETS } from './providers.js';
import {
    NOVELAI_NUMERIC_FIELDS, NOVELAI_SAMPLERS, NOVELAI_NOISE_SCHEDULES, NOVELAI_RESOLUTION_PRESETS,
    NOVELAI_ASPECT_RATIOS, isNovelAIMedium, resolveNovelAISettings,
} from './novelai.js';
import { applyImageActionsStyle } from './imageActions.js';
import { t, translate } from './i18n.js';
import { syncUserAvatarSelection, syncActivePersonaAvatarMode } from './avatarPicker.js';
import { Popup } from '../../../../popup.js';
import { buildSettingsSectionHtml, setSelectValue, setRangePairValue } from './settingsControls.js';
import { syncNegativePromptInputs } from './promptLibraryUi.js';

const A1111_RANGE_FIELDS = Object.freeze([
    ['width', 'a1111Width', parseInt, 512],
    ['height', 'a1111Height', parseInt, 512],
    ['steps', 'a1111Steps', parseInt, 20],
    ['cfg', 'a1111CfgScale', parseFloat, 7],
    ['hr_scale', 'a1111HrScale', parseFloat, 2],
    ['denoising', 'a1111DenoisingStrength', parseFloat, 0.7],
    ['hr_steps', 'a1111HrSecondPassSteps', parseInt, 0],
    ['clip_skip', 'a1111ClipSkip', parseInt, 1],
]);

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

export function buildUpdateVisibility(settings, updateReferenceAvailability) {
    return () => {
        const apiType = settings.apiType;
        const isNaistera = apiType === 'naistera';
        const isNovelAI = apiType === 'novelai';
        const isGemini = apiType === 'gemini';
        const isOpenAI = apiType === 'openai';
        const isXAI = apiType === 'xai';
        const isOpenRouter = apiType === 'openrouter';
        const isElectronHub = apiType === 'electronhub';
        const isA1111 = apiType === 'a1111';

        // Поддерживает ли активный провайдер референсы (учитывая модель).
        const provider = resolveActiveProvider(settings);
        const refsSupported = provider ? provider.supportsReferences(settings) : false;
        const naisteraRefsSupported = isNaistera && refsSupported;
        const naisteraNegativePromptSupported = isNaistera && provider?.supportsNegativePrompt(settings) === true;

        // Shared avatar controls are visible for providers that accept references.
        const commonAvatarRefsVisible = (isGemini || isOpenAI || isXAI || isOpenRouter || isElectronHub) && refsSupported;

        // Naistera has a separate model picker.
        document.getElementById('iig_model_row')?.classList.toggle('iig-hidden', isNaistera);
        document.getElementById('iig_image_context_section')?.classList.toggle('iig-hidden', !refsSupported);
        document.getElementById('iig_image_context_count_row')?.classList.toggle('iig-hidden', !(refsSupported && settings.imageContextEnabled));
        document.getElementById('iig_ref_instruction_section')?.classList.toggle('iig-hidden', !refsSupported);
        updateReferenceAvailability(refsSupported);

        // OpenAI + Electron Hub params (size / quality) — Electron Hub
        // принимает тот же формат JSON на /v1/images/{generations,edits}.
        document.getElementById('iig_size_row')?.classList.toggle('iig-hidden', !(isOpenAI || isElectronHub));
        document.getElementById('iig_quality_row')?.classList.toggle('iig-hidden', !(isOpenAI || isElectronHub));
        document.getElementById('iig_xai_options')?.classList.toggle('iig-hidden', !isXAI);

        // Naistera-only params
        document.getElementById('iig_naistera_model_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_negative_prompt_row')?.classList.toggle('iig-hidden', !naisteraNegativePromptSupported);
        const generationRules = isNaistera ? provider?.getGenerationParameters(settings) : null;
        document.getElementById('iig_naistera_generation_options')?.classList.toggle('iig-hidden', !generationRules);
        if (generationRules) {
            const values = provider.getGenerationSettings(settings);
            for (const [id, key] of [['steps', 'steps'], ['cfg_scale', 'scale'], ['cfg_rescale', 'cfg_rescale']]) {
                const input = document.getElementById(`iig_naistera_${id}`);
                const rule = generationRules[key];
                if (!input || !rule) continue;
                input.min = rule.min;
                input.max = rule.max;
                input.value = values[key];
                input.disabled = rule.min === rule.max;
            }
            const sampler = document.getElementById('iig_naistera_sampler');
            sampler.replaceChildren(...generationRules.sampler.choices.map(value =>
                new Option(NOVELAI_SAMPLERS[value] || value, value)));
            sampler.value = values.sampler;
            sampler.disabled = generationRules.sampler.choices.length === 1;
            document.getElementById('iig_naistera_cfg_rescale_row')?.classList.toggle('iig-hidden', !generationRules.cfg_rescale);
        }
        document.getElementById('iig_novelai_options')?.classList.toggle('iig-hidden', !isNovelAI);
        const isNovelAIV5 = settings.model?.startsWith('nai-diffusion-5-');
        const isMedium = isNovelAIMedium(settings.model);
        const effectiveNovelAI = resolveNovelAISettings(settings);
        const protectedGeneration = settings.novelaiNeverSpendAnlas !== false;
        const novelaiResolution = document.getElementById('iig_novelai_resolution');
        if (novelaiResolution) {
            novelaiResolution.value = effectiveNovelAI.novelaiResolution;
            novelaiResolution.disabled = protectedGeneration;
        }
        const novelaiSteps = document.getElementById('iig_novelai_steps');
        if (novelaiSteps) {
            novelaiSteps.min = isMedium || protectedGeneration ? effectiveNovelAI.novelaiSteps : 1;
            novelaiSteps.max = isMedium || protectedGeneration ? effectiveNovelAI.novelaiSteps : 50;
            novelaiSteps.value = effectiveNovelAI.novelaiSteps;
            novelaiSteps.disabled = isMedium || protectedGeneration;
        }
        const novelaiSampler = document.getElementById('iig_novelai_sampler');
        if (novelaiSampler) {
            novelaiSampler.value = effectiveNovelAI.novelaiSampler;
            novelaiSampler.disabled = isMedium;
        }
        document.getElementById('iig_novelai_cfg_rescale_row')?.classList.toggle('iig-hidden', isMedium);
        document.getElementById('iig_novelai_negative_prompt_row')?.classList.toggle('iig-hidden', isMedium);
        document.getElementById('iig_novelai_skip_cfg_above_sigma_row')?.classList.toggle('iig-hidden', isNovelAIV5);
        document.getElementById('iig_novelai_noise_schedule_row')?.classList.toggle('iig-hidden', isNovelAIV5);
        document.getElementById('iig_novelai_hint')?.classList.toggle('iig-hidden', !isNovelAI);
        syncNegativePromptInputs(settings);
        document.getElementById('iig_naistera_character_descriptions_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_aspect_row')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_video_section')?.classList.toggle('iig-hidden', !isNaistera);
        document.getElementById('iig_naistera_polling_row')?.classList.toggle('iig-hidden', !(isNaistera && settings.naisteraPolling));
        document.getElementById('iig_naistera_video_frequency_row')?.classList.toggle('iig-hidden', !(isNaistera && settings.naisteraVideoTest));
        document.getElementById('iig_naistera_refs_section')?.classList.toggle('iig-hidden', !naisteraRefsSupported);
        document.getElementById('iig_naistera_use_active_persona_avatar_row')?.classList.toggle('iig-hidden', !(naisteraRefsSupported && settings.naisteraSendUserAvatar));
        document.getElementById('iig_naistera_user_avatar_row')?.classList.toggle(
            'iig-hidden',
            !(naisteraRefsSupported && settings.naisteraSendUserAvatar && !settings.useActiveUserPersonaAvatar)
        );

        document.getElementById('iig_naistera_hint')?.classList.toggle('iig-hidden', !isNaistera);

        // A1111-only block
        document.getElementById('iig_a1111_section')?.classList.toggle('iig-hidden', !isA1111);

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
                else if (isXAI) titleEl.textContent = 'xAI Imagine';
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

function buildNovelAISettingsHtml(settings) {
    const selectHtml = (id, label, key, options) => `
        <div class="flex-row" id="iig_novelai_${id}_row">
            <label for="iig_novelai_${id}">${label}</label>
            <select id="iig_novelai_${id}" class="flex1">${Object.entries(options).map(([value, name]) => `<option value="${value}" ${settings[key] === value ? 'selected' : ''}>${name}</option>`).join('')}</select>
            <div></div>
        </div>`;
    return `
        <div id="iig_novelai_options" class="iig-settings-card-nested ${settings.apiType === 'novelai' ? '' : 'iig-hidden'}">
            <label class="checkbox_label" title="${t`Requires active Opus and available free generations.`}">
                <input type="checkbox" id="iig_novelai_never_spend_anlas" ${settings.novelaiNeverSpendAnlas !== false ? 'checked' : ''}>
                <span>${t`Never spend Anlas`}</span>
            </label>
            ${selectHtml('resolution', t`Size`, 'novelaiResolution', Object.fromEntries(Object.entries(NOVELAI_RESOLUTION_PRESETS).map(([value, preset]) => [value, translate(preset.label)])))}
            ${selectHtml('aspect_ratio', t`Aspect ratio`, 'novelaiAspectRatio', Object.fromEntries(NOVELAI_ASPECT_RATIOS.map(ratio => [ratio, ratio])))}
            ${NOVELAI_NUMERIC_FIELDS.map(field => `
                <div class="flex-row" id="iig_novelai_${field.id}_row">
                    <label for="iig_novelai_${field.id}">${translate(field.label)}</label>
                    <input id="iig_novelai_${field.id}" class="text_pole flex1" type="number" min="${field.min}" max="${field.max}" step="${field.step}" value="${settings[field.key]}">
                    <div></div>
                </div>`).join('')}
            ${selectHtml('sampler', t`Sampler`, 'novelaiSampler', NOVELAI_SAMPLERS)}
            ${selectHtml('noise_schedule', t`Noise schedule`, 'novelaiNoiseSchedule', Object.fromEntries(NOVELAI_NOISE_SCHEDULES.map(name => [name, name])))}
            ${selectHtml('character_descriptions_mode', t`Send character descriptions`, 'novelaiCharacterDescriptionsMode', {
                none: t`Do not send`, 'as-is': t`Send as-is`, 'character-prompt': t`Send as character prompt`,
            })}
            <div class="flex-row" id="iig_novelai_negative_prompt_row">
                <label for="iig_novelai_negative_prompt">${t`Negative prompt`}</label>
                <textarea id="iig_novelai_negative_prompt" class="text_pole textarea_compact flex1" rows="2">${sanitizeForHtml(settings.novelaiNegativePrompt)}</textarea>
                <div></div>
            </div>
        </div>`;
}

export function buildApiSettingsSectionHtml(settings = getSettings()) {
    const profilesHtml = buildConnectionProfilesBlockHtml(settings);
    const bodyHtml = `
        <div class="iig-settings-card">
            <div class="iig-settings-group">
                <div class="iig-settings-group-title"><i class="fa-solid fa-toggle-on"></i><span>${t`Extension`}</span></div>
            <label class="checkbox_label">
                <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                <span>${t`Enable image generation`}</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="iig_external_blocks" ${settings.externalBlocks ? 'checked' : ''}>
                <span>${t`Process external blocks`}</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="iig_process_user_messages" ${settings.processUserMessages ? 'checked' : ''}>
                <span>${t`Also process user messages`}</span>
            </label>

            <label class="checkbox_label">
                <input type="checkbox" id="iig_image_actions_enabled" ${settings.imageActionsEnabled !== false ? 'checked' : ''}>
                <span>${t`Show inline image action buttons (download / regenerate)`}</span>
            </label>

            <div class="flex-row" id="iig_image_actions_opacity_row" style="${settings.imageActionsEnabled !== false ? '' : 'display:none;'}">
                <label for="iig_image_actions_opacity">${t`Inline buttons opacity`}</label>
                <input type="range" id="iig_image_actions_opacity" class="flex1" min="0" max="100" step="1" value="${Number.isFinite(Number(settings.imageActionsOpacity)) ? Number(settings.imageActionsOpacity) : 80}">
                <div id="iig_image_actions_opacity_value" style="min-width:42px;text-align:right;">${Number.isFinite(Number(settings.imageActionsOpacity)) ? Number(settings.imageActionsOpacity) : 80}%</div>
            </div>
            </div>

            <div class="iig-settings-group">
                <div class="iig-settings-group-title"><i class="fa-solid fa-server"></i><span>${t`Connection`}</span></div>
            ${profilesHtml}
            <div class="flex-row">
                <label for="iig_api_type">${t`API type`}</label>
                <select id="iig_api_type" class="flex1">
                    <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>${t`OpenAI-compatible (/v1/images/generations)`}</option>
                    <option value="xai" ${settings.apiType === 'xai' ? 'selected' : ''}>xAI Imagine</option>
                    <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>${t`Gemini-compatible (nano-banana)`}</option>
                    <option value="openrouter" ${settings.apiType === 'openrouter' ? 'selected' : ''}>${t`OpenRouter (chat/completions)`}</option>
                    <option value="electronhub" ${settings.apiType === 'electronhub' ? 'selected' : ''}>${t`Electron Hub (/v1/images/*)`}</option>
                    <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>${t`Naistera (naistera.org)`}</option>
                    <option value="novelai" ${settings.apiType === 'novelai' ? 'selected' : ''}>NovelAI</option>
                    <option value="a1111" ${settings.apiType === 'a1111' ? 'selected' : ''}>${t`AUTOMATIC1111 / Forge (local)`}</option>
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

            <p id="iig_naistera_hint" class="hint ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}">${t`For Naistera: paste the token from the Telegram bot. Available models are loaded from the API.`}</p>
            <p id="iig_novelai_hint" class="hint ${settings.apiType === 'novelai' ? '' : 'iig-hidden'}">${t`Use a NovelAI persistent API token. Image references are not sent.`}</p>

            <div class="flex-row ${settings.apiType === 'naistera' ? 'iig-hidden' : ''}" id="iig_model_row">
                <label for="iig_model_select">${t`Model`}</label>
                <select id="iig_model_select" class="flex1 ${settings.rawEndpoint ? 'iig-hidden' : ''}">
                    ${settings.model ? `<option value="${sanitizeForHtml(settings.model)}" selected>${sanitizeForHtml(settings.model)}</option>` : `<option value="" selected disabled>${t`-- Select a model --`}</option>`}
                </select>
                <input type="text" id="iig_model" class="text_pole flex1 ${settings.rawEndpoint ? '' : 'iig-hidden'}" value="${sanitizeForHtml(settings.model || '')}" placeholder="${t`Enter model name`}">
                <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="${t`Refresh list`}">
                    <i class="fa-solid fa-sync"></i>
                </div>
            </div>
            </div>

            <div class="iig-settings-group">
                <div class="iig-settings-group-title"><i class="fa-solid fa-wand-magic-sparkles"></i><span>${t`Generation`}</span></div>
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

            <div id="iig_xai_options" class="iig-settings-card-nested ${settings.apiType === 'xai' ? '' : 'iig-hidden'}">
                <div class="flex-row">
                    <label for="iig_xai_aspect_ratio">${t`Aspect ratio`}</label>
                    <select id="iig_xai_aspect_ratio" class="flex1">
                        <option value="auto" ${settings.xaiAspectRatio === 'auto' ? 'selected' : ''}>Auto</option>
                        <option value="1:1" ${settings.xaiAspectRatio === '1:1' ? 'selected' : ''}>1:1</option>
                        <option value="16:9" ${settings.xaiAspectRatio === '16:9' ? 'selected' : ''}>16:9</option>
                        <option value="9:16" ${settings.xaiAspectRatio === '9:16' ? 'selected' : ''}>9:16</option>
                        <option value="4:3" ${settings.xaiAspectRatio === '4:3' ? 'selected' : ''}>4:3</option>
                        <option value="3:4" ${settings.xaiAspectRatio === '3:4' ? 'selected' : ''}>3:4</option>
                        <option value="3:2" ${settings.xaiAspectRatio === '3:2' ? 'selected' : ''}>3:2</option>
                        <option value="2:3" ${settings.xaiAspectRatio === '2:3' ? 'selected' : ''}>2:3</option>
                        <option value="2:1" ${settings.xaiAspectRatio === '2:1' ? 'selected' : ''}>2:1</option>
                        <option value="1:2" ${settings.xaiAspectRatio === '1:2' ? 'selected' : ''}>1:2</option>
                        <option value="19.5:9" ${settings.xaiAspectRatio === '19.5:9' ? 'selected' : ''}>19.5:9</option>
                        <option value="9:19.5" ${settings.xaiAspectRatio === '9:19.5' ? 'selected' : ''}>9:19.5</option>
                        <option value="20:9" ${settings.xaiAspectRatio === '20:9' ? 'selected' : ''}>20:9</option>
                        <option value="9:20" ${settings.xaiAspectRatio === '9:20' ? 'selected' : ''}>9:20</option>
                    </select>
                    <div></div>
                </div>
                <div class="flex-row">
                    <label for="iig_xai_resolution">${t`Resolution`}</label>
                    <select id="iig_xai_resolution" class="flex1">
                        <option value="1k" ${settings.xaiResolution === '1k' ? 'selected' : ''}>1K</option>
                        <option value="2k" ${settings.xaiResolution === '2k' ? 'selected' : ''}>2K</option>
                    </select>
                    <div></div>
                </div>
                <div class="flex-row">
                    <label for="iig_xai_quality">${t`Quality`}</label>
                    <select id="iig_xai_quality" class="flex1">
                        <option value="medium" ${settings.xaiQuality === 'medium' ? 'selected' : ''}>${t`Medium`}</option>
                        <option value="low" ${settings.xaiQuality === 'low' ? 'selected' : ''}>${t`Low`}</option>
                    </select>
                    <div></div>
                </div>
            </div>

            <div class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}" id="iig_naistera_model_row">
                <label for="iig_naistera_model">${t`Model`}</label>
                <select id="iig_naistera_model" class="flex1">
                    ${settings.naisteraModel
                        ? `<option value="${sanitizeForHtml(settings.naisteraModel)}" selected>${sanitizeForHtml(settings.naisteraModel)}</option>`
                        : `<option value="" selected disabled>${t`-- Select a model --`}</option>`}
                </select>
                <div id="iig_refresh_naistera_models" class="menu_button iig-refresh-btn" title="${t`Refresh list`}">
                    <i class="fa-solid fa-sync"></i>
                </div>
            </div>

            <div id="iig_naistera_character_descriptions_row" class="flex-row ${settings.apiType === 'naistera' ? '' : 'iig-hidden'}">
                <label for="iig_naistera_character_descriptions_mode">${t`Send character descriptions`}</label>
                <select id="iig_naistera_character_descriptions_mode" class="flex1">
                    <option value="none" ${settings.naisteraCharacterDescriptionsMode === 'none' ? 'selected' : ''}>${t`Do not send`}</option>
                    <option value="as-is" ${settings.naisteraCharacterDescriptionsMode === 'as-is' ? 'selected' : ''}>${t`Send as-is`}</option>
                    <option value="character-prompt" ${settings.naisteraCharacterDescriptionsMode === 'character-prompt' ? 'selected' : ''}>${t`Send as character prompt`}</option>
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

            <div class="flex-row iig-hidden" id="iig_naistera_negative_prompt_row">
                <label for="iig_naistera_negative_prompt">${t`Negative prompt`}</label>
                <textarea id="iig_naistera_negative_prompt" class="text_pole textarea_compact flex1" rows="2" placeholder="${t`(empty)`}">${sanitizeForHtml(settings.naisteraNegativePrompt || '')}</textarea>
                <div></div>
            </div>

            <div id="iig_naistera_generation_options" class="iig-hidden">
                <div class="flex-row">
                    <label for="iig_naistera_steps">${t`Steps`}</label>
                    <input id="iig_naistera_steps" class="text_pole flex1" type="number" min="1" max="28" step="1">
                    <div></div>
                </div>
                <div class="flex-row">
                    <label for="iig_naistera_sampler">${t`Sampler`}</label>
                    <select id="iig_naistera_sampler" class="flex1"></select>
                    <div></div>
                </div>
                <div class="flex-row">
                    <label for="iig_naistera_cfg_scale">${t`Guidance`}</label>
                    <input id="iig_naistera_cfg_scale" class="text_pole flex1" type="number" min="0" max="10" step="0.1">
                    <div></div>
                </div>
                <div class="flex-row" id="iig_naistera_cfg_rescale_row">
                    <label for="iig_naistera_cfg_rescale">${t`Guidance rescale`}</label>
                    <input id="iig_naistera_cfg_rescale" class="text_pole flex1" type="number" min="0" max="1" step="0.05">
                    <div></div>
                </div>
            </div>

            ${buildNovelAISettingsHtml(settings)}

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
                <h4>${t`Polling`}</h4>
                <label class="checkbox_label">
                    <input type="checkbox" id="iig_naistera_polling" ${settings.naisteraPolling ? 'checked' : ''}>
                    <span>${t`Use job polling API`}</span>
                </label>
                <div class="flex-container ${settings.naisteraPolling ? '' : 'iig-hidden'}" id="iig_naistera_polling_row">
                    <div class="flex1">
                        <label for="iig_naistera_poll_interval">${t`Poll interval (ms)`}</label>
                        <input type="number" id="iig_naistera_poll_interval" class="text_pole" min="1000" max="30000" step="500" value="${Number(settings.naisteraPollIntervalMs) || 3000}">
                    </div>
                    <div class="flex1">
                        <label for="iig_naistera_poll_timeout">${t`Poll timeout (ms)`}</label>
                        <input type="number" id="iig_naistera_poll_timeout" class="text_pole" min="30000" max="900000" step="10000" value="${Number(settings.naisteraPollTimeoutMs) || 600000}">
                    </div>
                </div>

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

            <div class="iig-settings-card-nested ${settings.apiType === 'a1111' ? '' : 'iig-hidden'}" id="iig_a1111_section">
                <p class="hint"><b>${t`Important:`}</b> ${t`run Stable Diffusion with the`} <tt>--api</tt> ${t`flag. The server must be reachable from the SillyTavern host.`}</p>

                <div>
                    <button id="iig_a1111_validate" class="menu_button iig-button-inline" type="button">
                        <i class="fa-solid fa-check"></i> ${t`Validate connection`}
                    </button>
                </div>

                <div class="flex-container">
                    <div class="flex1">
                        <label for="iig_a1111_sampler">${t`Sampling method`}</label>
                        <select id="iig_a1111_sampler" class="text_pole">
                            <option value="${sanitizeForHtml(settings.a1111Sampler || 'Euler a')}" selected>${sanitizeForHtml(settings.a1111Sampler || 'Euler a')}</option>
                        </select>
                    </div>
                    <div class="flex1">
                        <label for="iig_a1111_scheduler">${t`Scheduler`}</label>
                        <select id="iig_a1111_scheduler" class="text_pole">
                            <option value="${sanitizeForHtml(settings.a1111Scheduler || 'Automatic')}" selected>${sanitizeForHtml(settings.a1111Scheduler || 'Automatic')}</option>
                        </select>
                    </div>
                    <div id="iig_a1111_refresh_samplers" class="menu_button iig-a1111-end-btn" title="${t`Refresh list`}">
                        <i class="fa-solid fa-sync"></i>
                    </div>
                </div>

                <div class="flex-container">
                    <div class="flex1">
                        <label for="iig_a1111_vae">VAE</label>
                        <select id="iig_a1111_vae" class="text_pole">
                            <option value="${sanitizeForHtml(settings.a1111Vae || '')}" selected>${sanitizeForHtml(settings.a1111Vae || 'N/A')}</option>
                        </select>
                    </div>
                    <div class="flex1">
                        <label for="iig_a1111_hr_upscaler">${t`Upscaler`}</label>
                        <select id="iig_a1111_hr_upscaler" class="text_pole">
                            <option value="${sanitizeForHtml(settings.a1111HrUpscaler || '')}" selected>${sanitizeForHtml(settings.a1111HrUpscaler || '—')}</option>
                        </select>
                    </div>
                    <div id="iig_a1111_refresh_vae_upscalers" class="menu_button iig-a1111-end-btn" title="${t`Refresh list`}">
                        <i class="fa-solid fa-sync"></i>
                    </div>
                </div>

                <div>
                    <label for="iig_a1111_resolution">${t`Resolution preset`}</label>
                    <select id="iig_a1111_resolution" class="text_pole">
                        <option value="" ${!settings.a1111Resolution ? 'selected' : ''}>${t`(custom — set width/height below)`}</option>
                        ${A1111_RESOLUTION_PRESETS.map((p) =>
                            `<option value="${sanitizeForHtml(p.id)}" ${settings.a1111Resolution === p.id ? 'selected' : ''}>${sanitizeForHtml(p.name)}</option>`,
                        ).join('')}
                    </select>
                </div>

                <div class="flex-container">
                    <div class="alignitemscenter flex-container flexFlowColumn flexGrow flexShrink gap0 flexBasis48p">
                        <small><span>${t`Sampling steps`}</span></small>
                        <input class="neo-range-slider" type="range" id="iig_a1111_steps" min="1" max="150" step="1" value="${settings.a1111Steps}">
                        <input class="neo-range-input" type="number" id="iig_a1111_steps_value" data-for="iig_a1111_steps" min="1" max="150" step="1" value="${settings.a1111Steps}">
                    </div>
                    <div class="alignitemscenter flex-container flexFlowColumn flexGrow flexShrink gap0 flexBasis48p">
                        <small><span>${t`CFG scale`}</span></small>
                        <input class="neo-range-slider" type="range" id="iig_a1111_cfg" min="1" max="30" step="0.5" value="${settings.a1111CfgScale}">
                        <input class="neo-range-input" type="number" id="iig_a1111_cfg_value" data-for="iig_a1111_cfg" min="1" max="30" step="0.5" value="${settings.a1111CfgScale}">
                    </div>
                </div>

                <div class="flex-container">
                    <div class="alignitemscenter flex-container flexFlowColumn flexGrow flexShrink gap0 flexBasis48p">
                        <small><span>${t`Width`}</span></small>
                        <input class="neo-range-slider" type="range" id="iig_a1111_width" min="64" max="2048" step="8" value="${settings.a1111Width}">
                        <input class="neo-range-input" type="number" id="iig_a1111_width_value" data-for="iig_a1111_width" min="64" max="2048" step="8" value="${settings.a1111Width}">
                    </div>
                    <div class="alignitemscenter flex-container flexFlowColumn flexGrow flexShrink gap0 flexBasis48p">
                        <small><span>${t`Height`}</span></small>
                        <input class="neo-range-slider" type="range" id="iig_a1111_height" min="64" max="2048" step="8" value="${settings.a1111Height}">
                        <input class="neo-range-input" type="number" id="iig_a1111_height_value" data-for="iig_a1111_height" min="64" max="2048" step="8" value="${settings.a1111Height}">
                    </div>
                    <div id="iig_a1111_swap" class="menu_button iig-a1111-end-btn" title="${t`Swap width and height`}">
                        <i class="fa-solid fa-arrow-right-arrow-left"></i>
                    </div>
                </div>

                <div class="flex-container">
                    <div class="alignitemscenter flex-container flexFlowColumn flexGrow flexShrink gap0 flexBasis48p">
                        <small><span>${t`Upscale by`}</span></small>
                        <input class="neo-range-slider" type="range" id="iig_a1111_hr_scale" min="1" max="4" step="0.05" value="${settings.a1111HrScale}">
                        <input class="neo-range-input" type="number" id="iig_a1111_hr_scale_value" data-for="iig_a1111_hr_scale" min="1" max="4" step="0.05" value="${settings.a1111HrScale}">
                    </div>
                    <div class="alignitemscenter flex-container flexFlowColumn flexGrow flexShrink gap0 flexBasis48p">
                        <small><span>${t`Denoising strength`}</span></small>
                        <input class="neo-range-slider" type="range" id="iig_a1111_denoising" min="0" max="1" step="0.01" value="${settings.a1111DenoisingStrength}">
                        <input class="neo-range-input" type="number" id="iig_a1111_denoising_value" data-for="iig_a1111_denoising" min="0" max="1" step="0.01" value="${settings.a1111DenoisingStrength}">
                    </div>
                </div>

                <div class="flex-container">
                    <div class="alignitemscenter flex-container flexFlowColumn flexGrow flexShrink gap0 flexBasis48p">
                        <small><span>${t`Hires steps (2nd pass, 0 = same as steps)`}</span></small>
                        <input class="neo-range-slider" type="range" id="iig_a1111_hr_steps" min="0" max="150" step="1" value="${settings.a1111HrSecondPassSteps}">
                        <input class="neo-range-input" type="number" id="iig_a1111_hr_steps_value" data-for="iig_a1111_hr_steps" min="0" max="150" step="1" value="${settings.a1111HrSecondPassSteps}">
                    </div>
                    <div class="alignitemscenter flex-container flexFlowColumn flexGrow flexShrink gap0 flexBasis48p">
                        <small><span>CLIP Skip</span></small>
                        <input class="neo-range-slider" type="range" id="iig_a1111_clip_skip" min="1" max="12" step="1" value="${settings.a1111ClipSkip}">
                        <input class="neo-range-input" type="number" id="iig_a1111_clip_skip_value" data-for="iig_a1111_clip_skip" min="1" max="12" step="1" value="${settings.a1111ClipSkip}">
                    </div>
                </div>

                <div class="flex-container">
                    <label class="flex1 checkbox_label">
                        <input id="iig_a1111_restore_faces" type="checkbox" ${settings.a1111RestoreFaces ? 'checked' : ''}>
                        <span>${t`Restore Faces`}</span>
                    </label>
                    <label class="flex1 checkbox_label">
                        <input id="iig_a1111_enable_hr" type="checkbox" ${settings.a1111EnableHr ? 'checked' : ''}>
                        <span>Hires. Fix</span>
                    </label>
                </div>
                <div>
                    <label class="checkbox_label">
                        <input id="iig_a1111_adetailer_face" type="checkbox" ${settings.a1111AdetailerFace ? 'checked' : ''}>
                        <span>${t`Use ADetailer (face)`}</span>
                    </label>
                </div>

                <div>
                    <label for="iig_a1111_seed">${t`Seed (-1 = random)`}</label>
                    <input id="iig_a1111_seed" type="number" class="text_pole" min="-1" step="1" value="${settings.a1111Seed}">
                </div>

                <div>
                    <label for="iig_a1111_prompt_prefix">${t`Fixed prompt prefix`}</label>
                    <textarea id="iig_a1111_prompt_prefix" class="text_pole textarea_compact" rows="2" placeholder="${t`(empty)`}">${sanitizeForHtml(settings.a1111PromptPrefix || '')}</textarea>
                </div>

                <div>
                    <label for="iig_a1111_negative">${t`Fixed negative prompt prefix`}</label>
                    <textarea id="iig_a1111_negative" class="text_pole textarea_compact" rows="2" placeholder="${t`(empty)`}">${sanitizeForHtml(settings.a1111NegativePrompt || '')}</textarea>
                </div>
            </div>
            </div>
        </div>
    `;
    return buildSettingsSectionHtml('iig_api_section', t`API settings`, bodyHtml, false);
}

// ----- Connection profiles -----

// Profiles update existing controls without rebuilding editors or emitting save events.
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
    setSelectValue(document.getElementById('iig_model_select'), settings.model);
    setVal('iig_size', settings.size);
    setVal('iig_quality', settings.quality);
    setVal('iig_aspect_ratio', settings.aspectRatio);
    setVal('iig_image_size', settings.imageSize);
    setVal('iig_xai_aspect_ratio', settings.xaiAspectRatio);
    setVal('iig_xai_resolution', settings.xaiResolution);
    setVal('iig_xai_quality', settings.xaiQuality);
    const naisteraModel = normalizeNaisteraModel(settings.naisteraModel);
    setSelectValue(document.getElementById('iig_naistera_model'), naisteraModel);
    setVal('iig_naistera_negative_prompt', settings.naisteraNegativePrompt);
    for (const field of NOVELAI_NUMERIC_FIELDS) setVal(`iig_novelai_${field.id}`, settings[field.key]);
    setVal('iig_novelai_sampler', settings.novelaiSampler);
    setVal('iig_novelai_noise_schedule', settings.novelaiNoiseSchedule);
    setVal('iig_novelai_character_descriptions_mode', settings.novelaiCharacterDescriptionsMode);
    setVal('iig_novelai_negative_prompt', settings.novelaiNegativePrompt);
    setVal('iig_novelai_resolution', settings.novelaiResolution);
    setChk('iig_novelai_never_spend_anlas', settings.novelaiNeverSpendAnlas !== false);
    setVal('iig_novelai_aspect_ratio', settings.novelaiAspectRatio);
    setVal('iig_naistera_character_descriptions_mode', settings.naisteraCharacterDescriptionsMode);
    setVal('iig_naistera_aspect_ratio', settings.naisteraAspectRatio);
    setChk('iig_naistera_video_test', settings.naisteraVideoTest);
    setVal('iig_naistera_video_every_n', settings.naisteraVideoEveryN);
    setChk('iig_naistera_polling', settings.naisteraPolling);
    setVal('iig_naistera_poll_interval', settings.naisteraPollIntervalMs);
    setVal('iig_naistera_poll_timeout', settings.naisteraPollTimeoutMs);
    for (const [id, key] of [['steps', 'naisteraSteps'], ['cfg_scale', 'naisteraCfgScale'], ['cfg_rescale', 'naisteraCfgRescale'], ['sampler', 'naisteraSampler']]) {
        setVal(`iig_naistera_${id}`, settings[key]);
    }
    for (const [id, key] of A1111_RANGE_FIELDS) setRangePairValue(`iig_a1111_${id}`, settings[key]);
    for (const [id, key] of [['seed', 'a1111Seed'], ['prompt_prefix', 'a1111PromptPrefix'], ['negative', 'a1111NegativePrompt']]) {
        setVal(`iig_a1111_${id}`, settings[key]);
    }
    for (const [id, key] of [['resolution', 'a1111Resolution'], ['sampler', 'a1111Sampler'], ['scheduler', 'a1111Scheduler'], ['vae', 'a1111Vae'], ['hr_upscaler', 'a1111HrUpscaler']]) {
        setSelectValue(document.getElementById(`iig_a1111_${id}`), settings[key]);
    }
    for (const [id, key] of [['restore_faces', 'a1111RestoreFaces'], ['enable_hr', 'a1111EnableHr'], ['adetailer_face', 'a1111AdetailerFace']]) {
        setChk(`iig_a1111_${id}`, settings[key]);
    }
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

export function bindConnectionProfilesEvents(settings, updateVisibility, reloadModels) {
    document.getElementById('iig_profile_select')?.addEventListener('change', (e) => {
        const id = e.target instanceof HTMLSelectElement ? e.target.value : '';
        if (!id) return;
        const profile = loadConnectionProfile(id, settings);
        if (!profile) return;
        saveSettings();
        applyProfileValuesToInputs(settings);
        updateVisibility();
        reloadModels();
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
        reloadModels();
    });
}

// ----- API section events -----

export function bindApiSectionEvents(settings, updateVisibility) {
    let modelRequest = 0;
    const modelLoads = new WeakMap();
    const modelContext = () => [settings.apiType, settings.endpoint, settings.apiKey, settings.rawEndpoint, settings.activeConnectionProfileId];
    for (const [id, event, key, property] of [
        ['iig_enabled', 'change', 'enabled', 'checked'],
        ['iig_process_user_messages', 'change', 'processUserMessages', 'checked'],
        ['iig_external_blocks', 'change', 'externalBlocks', 'checked'],
        ['iig_endpoint', 'input', 'endpoint', 'value'],
        ['iig_api_key', 'input', 'apiKey', 'value'],
        ['iig_size', 'change', 'size', 'value'],
        ['iig_quality', 'change', 'quality', 'value'],
        ['iig_aspect_ratio', 'change', 'aspectRatio', 'value'],
        ['iig_image_size', 'change', 'imageSize', 'value'],
        ['iig_xai_aspect_ratio', 'change', 'xaiAspectRatio', 'value'],
        ['iig_xai_resolution', 'change', 'xaiResolution', 'value'],
        ['iig_xai_quality', 'change', 'xaiQuality', 'value'],
        ['iig_naistera_negative_prompt', 'input', 'naisteraNegativePrompt', 'value'],
        ['iig_naistera_sampler', 'change', 'naisteraSampler', 'value'],
        ['iig_novelai_negative_prompt', 'input', 'novelaiNegativePrompt', 'value'],
        ['iig_naistera_character_descriptions_mode', 'change', 'naisteraCharacterDescriptionsMode', 'value'],
        ['iig_naistera_aspect_ratio', 'change', 'naisteraAspectRatio', 'value'],
        ['iig_a1111_prompt_prefix', 'input', 'a1111PromptPrefix', 'value'],
        ['iig_a1111_vae', 'change', 'a1111Vae', 'value'],
        ['iig_a1111_hr_upscaler', 'change', 'a1111HrUpscaler', 'value'],
        ['iig_a1111_restore_faces', 'change', 'a1111RestoreFaces', 'checked'],
        ['iig_a1111_enable_hr', 'change', 'a1111EnableHr', 'checked'],
        ['iig_a1111_adetailer_face', 'change', 'a1111AdetailerFace', 'checked'],
        ['iig_a1111_sampler', 'change', 'a1111Sampler', 'value'],
        ['iig_a1111_scheduler', 'change', 'a1111Scheduler', 'value'],
        ['iig_a1111_negative', 'input', 'a1111NegativePrompt', 'value'],
    ]) {
        document.getElementById(id)?.addEventListener(event, e => {
            settings[key] = e.target[property];
            saveSettings();
        });
    }

    document.getElementById('iig_image_actions_enabled')?.addEventListener('change', (e) => {
        settings.imageActionsEnabled = e.target.checked;
        const opacityRow = document.getElementById('iig_image_actions_opacity_row');
        if (opacityRow) {
            opacityRow.style.display = e.target.checked ? '' : 'none';
        }
        applyImageActionsStyle(settings);
        saveSettings();
    });

    document.getElementById('iig_image_actions_opacity')?.addEventListener('input', (e) => {
        const raw = Number(e.target.value);
        const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 80;
        settings.imageActionsOpacity = clamped;
        const valueLabel = document.getElementById('iig_image_actions_opacity_value');
        if (valueLabel) valueLabel.textContent = `${clamped}%`;
        applyImageActionsStyle(settings);
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

        // Load the selected provider's catalog. Naistera keeps its own picker,
        // while other providers use the shared model selector.
        if (!settings.rawEndpoint || nextApiType === 'naistera') {
            reloadModelList({ announce: false }).catch(() => { /* silent */ });
        }
    });

    document.getElementById('iig_api_key')?.addEventListener('change', () => {
        if (settings.apiType === 'naistera') {
            reloadModelList({ announce: false }).catch(() => { /* handled by fetchModels */ });
        }
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

    // Две формы ввода модели: <select> для обычного режима (с fetchModels)
    // и <input> для raw-режима (свободный ввод). Видимость переключается
    // по rawEndpoint. Оба держим синхронно, чтобы юзер не терял значение
    // при переключении.
    const syncModelInputs = (value) => {
        const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('iig_model_select'));
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById('iig_model'));
        if (input && input.value !== value) input.value = value ?? '';
        setSelectValue(select, value, `${value} ${t`(custom)`}`);
    };

    const modelApplyChange = (value) => {
        settings.model = value;
        saveSettings();
        syncModelInputs(value);
        updateVisibility();
    };
    document.getElementById('iig_model_select')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLSelectElement) modelApplyChange(e.target.value);
    });
    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLInputElement) modelApplyChange(e.target.value);
    });
    document.getElementById('iig_model')?.addEventListener('input', (e) => {
        if (e.target instanceof HTMLInputElement) modelApplyChange(e.target.value);
    });

    /**
     * Populates the model <select> from provider.fetchModels. Preserves the
     * currently selected value: if settings.model is not in the fetched list,
     * it is appended as a "(custom)" option so the user doesn't lose it.
     * announce=true shows a toastr with model count / error.
     */
    async function reloadModelList({ announce = false } = {}) {
        const request = ++modelRequest;
        const context = modelContext();
        if (settings.rawEndpoint && settings.apiType !== 'naistera') return [];
        const isCurrent = () => {
            const current = modelContext();
            return request === modelRequest && context.every((value, index) => value === current[index]);
        };
        const isNaistera = settings.apiType === 'naistera';
        const select = /** @type {HTMLSelectElement|null} */ (document.getElementById(
            isNaistera ? 'iig_naistera_model' : 'iig_model_select',
        ));
        const btn = document.getElementById(isNaistera ? 'iig_refresh_naistera_models' : 'iig_refresh_models');
        if (btn) modelLoads.set(btn, request);
        btn?.classList.add('loading');
        try {
            const models = await fetchModels({ isCurrent });
            if (!isCurrent()) return [];
            if (select) {
                let current = isNaistera ? normalizeNaisteraModel(settings.naisteraModel) : (settings.model || '');
                if ((isNaistera || settings.apiType === 'novelai') && models.length > 0 && !models.includes(current)) {
                    current = models[0];
                    settings[isNaistera ? 'naisteraModel' : 'model'] = current;
                    if (!isNaistera) syncModelInputs(current);
                    saveSettings();
                }
                const provider = resolveActiveProvider(settings);
                const inList = current && models.includes(current);
                const optionsHtml = [
                    ...models.map((m) => `<option value="${sanitizeForHtml(m)}" ${m === current ? 'selected' : ''}>${sanitizeForHtml(provider?.getModelLabel(m) || m)}</option>`),
                    ...(!inList && current ? [`<option value="${sanitizeForHtml(current)}" selected>${sanitizeForHtml(current)}${isNaistera ? '' : ` ${t`(custom)`}`}</option>`] : []),
                    ...(models.length === 0 && !current ? [`<option value="" selected disabled>${t`-- Select a model --`}</option>`] : []),
                ];
                select.innerHTML = optionsHtml.join('');
            }
            updateVisibility();
            if (announce && models.length > 0) {
                toastr.success(t`Models found: ${models.length}`, t`Image Generation`);
                const provider = resolveActiveProvider(settings);
                if (isNaistera && settings.apiKey && provider?.getModelCatalogStatus?.().authenticated !== true) {
                    toastr.warning(t`Models were loaded from the public catalog. Account-specific models may be unavailable.`, t`Image Generation`);
                }
            } else if (announce && models.length === 0) {
                toastr.warning(t`No models returned by endpoint`, t`Image Generation`);
            }
            return models;
        } catch (error) {
            if (announce && isCurrent()) {
                toastr.error(t`Failed to load models`, t`Image Generation`);
            }
            return [];
        } finally {
            if (btn && modelLoads.get(btn) === request) {
                btn.classList.remove('loading');
                modelLoads.delete(btn);
            }
        }
    }

    document.getElementById('iig_refresh_models')?.addEventListener('click', () => {
        reloadModelList({ announce: true });
    });

    document.getElementById('iig_refresh_naistera_models')?.addEventListener('click', () => {
        reloadModelList({ announce: true });
    });

    document.getElementById('iig_raw_endpoint')?.addEventListener('change', (e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        settings.rawEndpoint = e.target.checked;
        saveSettings();

        const select = document.getElementById('iig_model_select');
        const input = document.getElementById('iig_model');
        if (settings.rawEndpoint) {
            // Raw: скрываем select (его опции неактуальны для произвольного
            // эндпоинта), показываем свободный input.
            select?.classList.add('iig-hidden');
            input?.classList.remove('iig-hidden');
        } else {
            // Обратно в режим provider → показываем select, прячем input,
            // и автоматически подтягиваем модели, чтобы юзер не жал Refresh
            // руками.
            select?.classList.remove('iig-hidden');
            input?.classList.add('iig-hidden');
            reloadModelList({ announce: true });
        }
    });

    document.getElementById('iig_naistera_model')?.addEventListener('change', (e) => {
        settings.naisteraModel = normalizeNaisteraModel(e.target.value);
        saveSettings();
        updateVisibility();
    });

    for (const [id, key] of [
        ['steps', 'naisteraSteps'], ['cfg_scale', 'naisteraCfgScale'], ['cfg_rescale', 'naisteraCfgRescale'],
    ]) {
        document.getElementById(`iig_naistera_${id}`)?.addEventListener('input', (event) => {
            settings[key] = event.target.value === '' ? null : Number(event.target.value);
            saveSettings();
        });
    }

    document.getElementById('iig_novelai_never_spend_anlas')?.addEventListener('change', (event) => {
        settings.novelaiNeverSpendAnlas = event.target.checked;
        saveSettings();
        updateVisibility();
    });
    for (const field of NOVELAI_NUMERIC_FIELDS) {
        document.getElementById(`iig_novelai_${field.id}`)?.addEventListener('input', (event) => {
            settings[field.key] = event.target.value === '' ? '' : Number(event.target.value);
            saveSettings();
        });
    }
    for (const [id, key] of [
        ['resolution', 'novelaiResolution'], ['aspect_ratio', 'novelaiAspectRatio'],
        ['sampler', 'novelaiSampler'], ['noise_schedule', 'novelaiNoiseSchedule'],
        ['character_descriptions_mode', 'novelaiCharacterDescriptionsMode'],
    ]) {
        document.getElementById(`iig_novelai_${id}`)?.addEventListener('change', (event) => {
            settings[key] = event.target.value;
            saveSettings();
        });
    }

    document.getElementById('iig_naistera_video_test')?.addEventListener('change', (e) => {
        settings.naisteraVideoTest = e.target.checked;
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_naistera_polling')?.addEventListener('change', (e) => {
        settings.naisteraPolling = e.target.checked;
        saveSettings();
        updateVisibility();
    });

    document.getElementById('iig_naistera_poll_interval')?.addEventListener('input', (e) => {
        const value = parseInt(e.target.value, 10);
        settings.naisteraPollIntervalMs = Number.isFinite(value) ? Math.max(1000, Math.min(30000, value)) : 3000;
        e.target.value = String(settings.naisteraPollIntervalMs);
        saveSettings();
    });

    document.getElementById('iig_naistera_poll_timeout')?.addEventListener('input', (e) => {
        const value = parseInt(e.target.value, 10);
        settings.naisteraPollTimeoutMs = Number.isFinite(value) ? Math.max(30000, Math.min(900000, value)) : 600000;
        e.target.value = String(settings.naisteraPollTimeoutMs);
        saveSettings();
    });

    document.getElementById('iig_naistera_video_every_n')?.addEventListener('input', (e) => {
        const normalized = normalizeNaisteraVideoFrequency(e.target.value);
        settings.naisteraVideoEveryN = normalized;
        e.target.value = String(normalized);
        saveSettings();
    });

    // A1111 params: range + number pairs (synced both ways)
    const bindRangePair = (rangeId, numberId, key, parser) => {
        const range = document.getElementById(rangeId);
        const number = document.getElementById(numberId);
        if (!range || !number) return;
        const sync = (raw) => {
            const v = parser(raw);
            setRangePairValue(rangeId, v);
            settings[key] = v;
            saveSettings();
        };
        range.addEventListener('input', (e) => sync(e.target.value));
        number.addEventListener('input', (e) => sync(e.target.value));
    };
    for (const [id, key, parse, fallback] of A1111_RANGE_FIELDS) {
        bindRangePair(`iig_a1111_${id}`, `iig_a1111_${id}_value`, key, value => parse(value, 10) || fallback);
    }

    document.getElementById('iig_a1111_seed')?.addEventListener('input', (e) => {
        settings.a1111Seed = parseInt(e.target.value, 10) || -1;
        saveSettings();
    });

    // Resolution preset → fills width/height
    document.getElementById('iig_a1111_resolution')?.addEventListener('change', (e) => {
        const id = e.target.value;
        settings.a1111Resolution = id;
        const preset = A1111_RESOLUTION_PRESETS.find((p) => p.id === id);
        if (preset) {
            settings.a1111Width = preset.width;
            settings.a1111Height = preset.height;
            setRangePairValue('iig_a1111_width', settings.a1111Width);
            setRangePairValue('iig_a1111_height', settings.a1111Height);
        }
        saveSettings();
    });

    // Validate connection (ping)
    document.getElementById('iig_a1111_validate')?.addEventListener('click', async () => {
        const btn = document.getElementById('iig_a1111_validate');
        btn?.classList.add('loading');
        try {
            const provider = resolveActiveProvider(getSettings());
            if (provider?.id !== 'a1111') return;
            await provider.ping();
            toastr.success(t`A1111 server is reachable`, t`Image Generation`);
        } catch (err) {
            iigLog('ERROR', 'A1111 validate failed:', err);
            toastr.error(t`Cannot reach A1111: ${err.message || err}`, t`Image Generation`);
        } finally {
            btn?.classList.remove('loading');
        }
    });

    // Refresh VAE + Upscalers list
    document.getElementById('iig_a1111_refresh_vae_upscalers')?.addEventListener('click', async () => {
        const btn = document.getElementById('iig_a1111_refresh_vae_upscalers');
        btn?.classList.add('loading');
        try {
            const provider = resolveActiveProvider(getSettings());
            if (provider?.id !== 'a1111') return;
            const [vaes, upscalers] = await Promise.all([provider.fetchVaes(), provider.fetchUpscalers()]);
            const vaeSelect = document.getElementById('iig_a1111_vae');
            const upSelect = document.getElementById('iig_a1111_hr_upscaler');
            if (vaeSelect instanceof HTMLSelectElement) {
                const cur = settings.a1111Vae || '';
                const opts = ['', ...vaes];
                vaeSelect.innerHTML = opts
                    .map((v) => `<option value="${sanitizeForHtml(v)}" ${v === cur ? 'selected' : ''}>${sanitizeForHtml(v || 'N/A')}</option>`)
                    .join('');
            }
            if (upSelect instanceof HTMLSelectElement) {
                const cur = settings.a1111HrUpscaler || '';
                const opts = ['', ...upscalers];
                upSelect.innerHTML = opts
                    .map((u) => `<option value="${sanitizeForHtml(u)}" ${u === cur ? 'selected' : ''}>${sanitizeForHtml(u || '—')}</option>`)
                    .join('');
            }
            toastr.success(t`VAEs/upscalers updated`, t`Image Generation`);
        } catch (err) {
            iigLog('ERROR', 'A1111 refresh VAE/upscalers failed:', err);
            toastr.error(t`Failed to fetch VAEs/upscalers`, t`Image Generation`);
        } finally {
            btn?.classList.remove('loading');
        }
    });

    // Swap width <-> height
    document.getElementById('iig_a1111_swap')?.addEventListener('click', () => {
        const w = settings.a1111Width;
        const h = settings.a1111Height;
        settings.a1111Width = h;
        settings.a1111Height = w;
        saveSettings();
        setRangePairValue('iig_a1111_width', settings.a1111Width);
        setRangePairValue('iig_a1111_height', settings.a1111Height);
    });

    // Refresh A1111 samplers + schedulers from /sdapi/v1/samplers and /sdapi/v1/schedulers
    document.getElementById('iig_a1111_refresh_samplers')?.addEventListener('click', async () => {
        const btn = document.getElementById('iig_a1111_refresh_samplers');
        btn?.classList.add('loading');
        try {
            const provider = resolveActiveProvider(getSettings());
            if (provider?.id !== 'a1111') return;
            const [samplers, schedulers] = await Promise.all([
                provider.fetchSamplers(),
                provider.fetchSchedulers(),
            ]);
            const samplerSelect = document.getElementById('iig_a1111_sampler');
            const schedulerSelect = document.getElementById('iig_a1111_scheduler');
            if (samplerSelect instanceof HTMLSelectElement) {
                const cur = settings.a1111Sampler || 'Euler a';
                samplerSelect.innerHTML = samplers
                    .map((s) => `<option value="${sanitizeForHtml(s)}" ${s === cur ? 'selected' : ''}>${sanitizeForHtml(s)}</option>`)
                    .join('');
                if (!samplers.includes(cur) && cur) {
                    samplerSelect.innerHTML += `<option value="${sanitizeForHtml(cur)}" selected>${sanitizeForHtml(cur)} ${t`(custom)`}</option>`;
                }
            }
            if (schedulerSelect instanceof HTMLSelectElement) {
                const cur = settings.a1111Scheduler || 'Automatic';
                schedulerSelect.innerHTML = schedulers
                    .map((s) => `<option value="${sanitizeForHtml(s)}" ${s === cur ? 'selected' : ''}>${sanitizeForHtml(s)}</option>`)
                    .join('');
                if (!schedulers.includes(cur) && cur) {
                    schedulerSelect.innerHTML += `<option value="${sanitizeForHtml(cur)}" selected>${sanitizeForHtml(cur)} ${t`(custom)`}</option>`;
                }
            }
            toastr.success(t`Samplers/schedulers updated`, t`Image Generation`);
        } catch (err) {
            iigLog('ERROR', 'A1111 refresh samplers failed:', err);
            toastr.error(t`Failed to fetch samplers`, t`Image Generation`);
        } finally {
            btn?.classList.remove('loading');
        }
    });

    // Auto-populate the active provider's model picker on init.
    if (!settings.rawEndpoint || settings.apiType === 'naistera') {
        reloadModelList({ announce: false }).catch(() => { /* silent on init */ });
    }
    return reloadModelList;
}
