/** Generation, retry and persistence scoped to one message and API configuration. */

import {
    getSettings,
    iigLog,
    getEffectiveRefInstruction,
    setLastRequestSnapshot,
    normalizeNaisteraModel,
    isNaisteraNovelAIModel,
    normalizeNaisteraCharacterDescriptionsMode,
    getEffectiveNegativePrompt,
} from './settings.js';
import { getNovelAIResolution, isNovelAIMedium, resolveNovelAISettings, NOVELAI_MEDIUM_NEGATIVE } from './novelai.js';
import {
    saveImageToFile,
    saveNaisteraMediaToFile,
    ERROR_IMAGE_PATH,
    STOPPED_IMAGE_PATH,
    parseImageDataUrl,
    abortableDelay,
    ProviderError,
} from './utils.js';
import {
    applyConfiguredStyleToTag,
    bindRenderedMediaTags,
    buildFinalGenerationPrompt,
    filterPromptReferences,
    buildPersistedImageTag,
    buildPersistedMediaTag,
    convertLegacyTagsToInstructionFormat,
    createGeneratedMediaElement,
    getInstructionAttributeValue,
    getMatchedAdditionalReferences,
    isGeneratedVideoResult,
    parseMessageImageTags,
    replaceTagInMessageSource,
    rerenderMessageHtml,
} from './parser.js';
import {
    resolveActiveProvider,
    validateSettings,
} from './providers.js';
import {
    getReferenceDescription,
    getReferenceSource,
    buildAvatarReferencePromptBlock,
    getReferenceImage,
    recordCharacterGeneration,
    buildCharacterDescriptionPromptBlock,
    captureReferenceContext,
    getCurrentCharacterReferenceKey,
} from './references.js';
import { t } from './i18n.js';

// ----- Friendly error classification -----

/**
 * Классификация ошибки от провайдера в одну из известных категорий.
 * Матчинг идёт по `code` и по подстрокам в `message`. Если ничего не
 * подошло — возвращает `'unknown'`.
 *
 * @param {unknown} error
 * @returns {{ kind: string, raw: string, code: string }}
 */
function classifyProviderError(error) {
    const isProviderError = error instanceof ProviderError;
    const code = String(isProviderError ? (error.code || '') : '').toLowerCase();
    const raw = String(error?.message || '');
    const msg = raw.toLowerCase();
    const status = isProviderError ? (error.status || 0) : 0;

    const codeIsAny = (...list) => list.some((c) => code === c || code.includes(c));
    const msgHas = (...list) => list.some((s) => msg.includes(s));

    // Moderation / цензура — OpenAI, Gemini, OpenRouter.
    if (codeIsAny('moderation_blocked', 'content_policy_violation', 'safety_violation', 'content_filter', 'content_policy')
        || msgHas('rejected by the safety', 'content policy', 'safety filter', 'safety_violation', 'moderation_blocked', 'safety reasons')) {
        return { kind: 'moderation', raw, code };
    }

    // Billing / quota.
    if (codeIsAny('billing_hard_limit_reached', 'insufficient_quota', 'billing_not_active', 'account_deactivated', 'billing')
        || msgHas('billing hard limit', 'insufficient_quota', 'quota', 'billing')) {
        return { kind: 'billing', raw, code };
    }

    // Rate limit.
    if (status === 429
        || codeIsAny('rate_limit_exceeded', 'too_many_requests', 'resource_exhausted')
        || msgHas('rate limit', 'too many requests')) {
        return { kind: 'rate_limit', raw, code };
    }

    // Auth.
    if (status === 401 || status === 403
        || codeIsAny('invalid_api_key', 'authentication_error', 'unauthorized', 'permission_denied', 'forbidden')
        || msgHas('invalid api key', 'unauthorized', 'forbidden')) {
        return { kind: 'auth', raw, code };
    }

    // Model not found / unsupported.
    if (codeIsAny('model_not_found', 'model_not_supported', 'invalid_model')
        || (status === 404 && msgHas('model'))
        || msgHas('model not found', 'model does not exist', 'unsupported model')) {
        return { kind: 'model', raw, code };
    }

    // Timeout / network.
    if (codeIsAny('timeout')) return { kind: 'timeout', raw, code };
    if (codeIsAny('network')) return { kind: 'network', raw, code };

    return { kind: 'unknown', raw, code };
}

/**
 * Превращает ошибку в human-friendly пару `{ title, message, detail }`.
 * `detail` — сырой текст для отладки (first 400 chars), кладётся в tooltip
 * error-placeholder'а и в логи.
 */
function formatProviderError(error) {
    const { kind, raw, code } = classifyProviderError(error);
    const detail = String(raw || '').slice(0, 400);

    switch (kind) {
        case 'moderation':
            return {
                title: t`Content moderation`,
                message: t`Request was blocked by the provider safety filter. Try again or edit the prompt.`,
                detail,
            };
        case 'billing':
            return {
                title: t`Billing limit`,
                message: t`Your account has reached a billing or quota limit. Check your provider dashboard.`,
                detail,
            };
        case 'rate_limit':
            return {
                title: t`Rate limit`,
                message: t`Provider is rate-limiting requests. Wait a moment and try again.`,
                detail,
            };
        case 'auth':
            return {
                title: t`Authentication error`,
                message: t`API key is invalid or unauthorized.`,
                detail,
            };
        case 'model':
            return {
                title: t`Model error`,
                message: t`Selected model is unavailable or not found.`,
                detail,
            };
        case 'network':
            return {
                title: t`Network error`,
                message: t`Could not reach the provider. Check your connection.`,
                detail,
            };
        case 'timeout':
            return {
                title: t`Timeout`,
                message: t`Provider took too long to respond. Try again.`,
                detail,
            };
        default:
            return {
                title: t`Generation error`,
                message: detail || t`Unknown error`,
                detail: code ? `${code}: ${detail}` : detail,
            };
    }
}

// ----- Last request snapshot builder -----

/**
 * Провайдеры, которые префиксуют final prompt через `refInstruction`
 * когда references.length > 0. Покрывает все провайдеры с поддержкой
 * reference images — OpenAI / ElectronHub (/v1/images/edits), Gemini,
 * OpenRouter, Naistera.
 */
const REF_INSTRUCTION_PROVIDERS = new Set(['openai', 'xai', 'electronhub', 'gemini', 'openrouter', 'naistera']);

/**
 * Приводит любой представление референса (base64 строка или data URL)
 * к data URL для превью в модалке.
 */
function refToPreviewDataUrl(ref) {
    const value = getReferenceImage(ref);
    if (!value) return '';
    return value.startsWith('data:') ? value : `data:image/png;base64,${value}`;
}


/**
 * Строит snapshot финального запроса для in-memory отображения в UI.
 * Воспроизводит apiType-зависимую логику сборки prompt'а (refInstruction
 * префикс только для провайдеров из REF_INSTRUCTION_PROVIDERS).
 */
function buildRequestSnapshot({ prompt, style, references, matchedAdditionalRefs, options, provider, settings, characterDescriptionPromptBlock = '', wrapStyle = true }) {
    let snapshotPrompt = buildFinalGenerationPrompt(
        prompt,
        style,
        matchedAdditionalRefs || [],
        settings,
        { wrapStyle },
    );
    if (settings.apiType === 'openai' || settings.apiType === 'xai' || settings.apiType === 'electronhub') {
        const avatarDescriptions = buildAvatarReferencePromptBlock(references, settings);
        if (avatarDescriptions) {
            snapshotPrompt = `${snapshotPrompt}\n\n${avatarDescriptions}`.trim();
        }
    }
    if (characterDescriptionPromptBlock) {
        snapshotPrompt = `${snapshotPrompt}\n\n${characterDescriptionPromptBlock}`.trim();
    }
    let refInstructionApplied = false;

    if (references.length > 0 && REF_INSTRUCTION_PROVIDERS.has(settings.apiType)) {
        const refInstr = getEffectiveRefInstruction(settings);
        if (refInstr) {
            snapshotPrompt = `${refInstr}\n\n${snapshotPrompt}`;
            refInstructionApplied = true;
        }
    }

    const model = settings.apiType === 'naistera'
        ? normalizeNaisteraModel(settings.naisteraModel)
        : (settings.model || '');

    const aspectRatio = settings.apiType === 'novelai'
        ? (options?.aspectRatio || settings.novelaiAspectRatio)
        : settings.apiType === 'naistera'
        ? (options?.aspectRatio || settings.naisteraAspectRatio)
        : settings.apiType === 'xai'
            ? (options?.aspectRatio || settings.xaiAspectRatio)
            : (options?.aspectRatio || settings.aspectRatio);
    const nativeSettings = settings.apiType === 'novelai' ? resolveNovelAISettings(settings) : null;
    const novelaiResolution = nativeSettings
        ? getNovelAIResolution({ ...nativeSettings, novelaiAspectRatio: aspectRatio }) : null;

    const matchedRefsInfo = (Array.isArray(matchedAdditionalRefs) ? matchedAdditionalRefs : []).map((ref) => ({
        name: String(ref?.name || ''),
        group: String(ref?.group || ''),
        priority: Number.isFinite(ref?.priority) ? ref.priority : 0,
        lorebookName: String(ref?._lorebookName || ''),
        reason: ref?._matchReason || null,
    }));
    const negativePrompt = nativeSettings && isNovelAIMedium(nativeSettings.model)
        ? NOVELAI_MEDIUM_NEGATIVE
        : provider?.supportsNegativePrompt(settings)
        ? String(options?.negativePrompt ?? getEffectiveNegativePrompt(
            settings.apiType === 'novelai' ? settings.novelaiNegativePrompt : settings.naisteraNegativePrompt, settings,
        )).trim()
        : '';
    const naisteraParameters = settings.apiType === 'naistera'
        ? provider?.getGenerationSettings?.({ ...settings, naisteraModel: model }, options) || {}
        : {};

    return {
        timestamp: Date.now(),
        prompt: snapshotPrompt,
        negativePrompt,
        references: references.map((ref, index) => ({
            dataUrl: refToPreviewDataUrl(ref),
            label: `ref ${index + 1}`,
            description: getReferenceDescription(ref),
            source: getReferenceSource(ref),
        })),
        matchedRefs: matchedRefsInfo,
        metadata: {
            provider: provider?.displayName || settings.apiType,
            apiType: settings.apiType,
            model,
            aspectRatio,
            imageSize: nativeSettings ? nativeSettings.novelaiResolution : settings.apiType === 'xai'
                ? (options?.imageSize || settings.xaiResolution || '')
                : (options?.imageSize || settings.imageSize || ''),
            size: novelaiResolution ? `${novelaiResolution.width}x${novelaiResolution.height}` : settings.size || '',
            quality: settings.apiType === 'novelai' ? '' : settings.apiType === 'xai'
                ? (options?.quality || settings.xaiQuality || '')
                : (options?.quality || settings.quality || ''),
            refInstructionApplied,
            ...(Object.keys(naisteraParameters).length ? {
                steps: naisteraParameters.steps,
                sampler: naisteraParameters.sampler,
                cfgScale: naisteraParameters.scale,
                cfgRescale: naisteraParameters.cfg_rescale,
            } : {}),
            ...(settings.apiType === 'novelai' ? {
                steps: nativeSettings.novelaiSteps,
                cfgScale: nativeSettings.novelaiCfgScale,
                cfgRescale: nativeSettings.novelaiCfgRescale,
                sampler: nativeSettings.novelaiSampler,
                noiseSchedule: settings.model.startsWith('nai-diffusion-5-') ? '' : settings.novelaiNoiseSchedule,
                seed: settings.novelaiSeed,
            } : {}),
        },
    };
}

// Message objects retain ownership across parsing, dispatch and saving.
export const processingMessages = new Set();

const tagAbortControllers = new Map();

export function abortGenerationForTag(tagId) {
    const controller = tagAbortControllers.get(String(tagId || ''));
    if (controller) {
        controller.abort('user-cancel');
        return true;
    }
    return false;
}

// ----- Placeholder DOM helpers -----

let timerIntervalId = null;

function formatElapsed(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function tickTimers() {
    const placeholders = document.querySelectorAll('.iig-loading-placeholder[data-iig-start]');
    if (placeholders.length === 0) {
        clearInterval(timerIntervalId);
        timerIntervalId = null;
        return;
    }
    const now = Date.now();
    for (const ph of placeholders) {
        const start = Number(ph.dataset.iigStart);
        if (!start) continue;
        const timerEl = ph.querySelector('.iig-timer');
        if (timerEl) timerEl.textContent = formatElapsed(now - start);
    }
}

function ensureTimerInterval() {
    if (timerIntervalId === null) {
        timerIntervalId = setInterval(tickTimers, 1000);
    }
}

export function createLoadingPlaceholder(tagId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.dataset.iigStart = String(Date.now());
    placeholder.innerHTML = `
        <div class="iig-spinner"></div>
        <div class="iig-status">${t`Generating image...`}</div>
        <div class="iig-timer">0:00</div>
        <button type="button" class="iig-stop-btn" title="${t`Stop generation`}" aria-label="${t`Stop generation`}">
            <i class="fa-solid fa-stop"></i>
            <span>${t`Stop`}</span>
        </button>
    `;
    const stopBtn = placeholder.querySelector('.iig-stop-btn');
    if (stopBtn instanceof HTMLButtonElement) {
        stopBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            stopBtn.disabled = true;
            stopBtn.querySelector('span').textContent = t`Stopping...`;
            abortGenerationForTag(tagId);
        });
    }
    ensureTimerInterval();
    return placeholder;
}

export function createStoppedPlaceholder(tagId, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image iig-stopped-image';
    img.src = STOPPED_IMAGE_PATH;
    img.alt = t`Generation stopped`;
    img.title = t`Generation stopped by user. Click to retry.`;
    img.dataset.tagId = tagId;
    if (tagInfo?.fullMatch) {
        const instructionMatch = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instructionMatch) {
            img.setAttribute('data-iig-instruction', instructionMatch[2]);
        }
    }
    return img;
}

export function createErrorPlaceholder(tagId, errorMessage, tagInfo, friendlyInfo = null) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = friendlyInfo?.title || t`Generation error`;
    // Tooltip: дружелюбный заголовок + сырой текст для отладки.
    const tooltip = friendlyInfo
        ? `${friendlyInfo.title}: ${friendlyInfo.message}${friendlyInfo.detail ? `\n\n${friendlyInfo.detail}` : ''}`
        : t`Error: ${errorMessage}`;
    img.title = tooltip;
    img.dataset.tagId = tagId;

    // Preserve data-iig-instruction for regenerate button functionality
    if (tagInfo.fullMatch) {
        const instructionMatch = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instructionMatch) {
            img.setAttribute('data-iig-instruction', instructionMatch[2]);
        }
    }

    return img;
}

// ----- Media persistence -----

/**
 * Saves generated images/video to SillyTavern and returns their stored paths.
 *
 * @param {any} generated — результат provider.generate (string data URL | { kind:'video', ... })
 * @param {HTMLElement} statusEl — DOM-элемент, куда пишем текстовый статус
 * @param {{ messageId: number, tagIndex: number, mode: 'generate' | 'regenerate' }} meta
 * @returns {Promise<{ persistedSrc: string, persistedPosterSrc: string }>}
 */
export async function persistGeneratedMedia(generated, statusEl, meta) {
    const { messageId, tagIndex, mode } = meta;
    const { apiType = getSettings().apiType, characterName } = meta;

    let persistedSrc = '';
    let persistedPosterSrc = '';

    if (isGeneratedVideoResult(generated)) {
        if (statusEl) statusEl.textContent = t`Saving video...`;
        persistedSrc = await saveNaisteraMediaToFile(generated.dataUrl, 'video', {
            messageId,
            tagIndex,
            mode: `${mode}-video`,
            apiType,
            characterName,
        });
        if (generated.posterDataUrl) {
            if (statusEl) statusEl.textContent = t`Saving preview...`;
            persistedPosterSrc = await saveImageToFile(generated.posterDataUrl, {
                messageId,
                tagIndex,
                mode: `${mode}-video-poster`,
                apiType,
                characterName,
            });
        }
    } else {
        if (statusEl) statusEl.textContent = t`Saving...`;
        persistedSrc = await saveImageToFile(generated, {
            messageId,
            tagIndex,
            mode,
            apiType,
            characterName,
        });
    }

    return { persistedSrc, persistedPosterSrc };
}

// ----- Main generate (provider dispatch + retry loop) -----

function snapshotGenerationSettings(source = getSettings()) {
    const settings = Object.fromEntries(Object.entries(source).filter(([, value]) => value === null || typeof value !== 'object'));
    for (const key of ['styles', 'negativePrompts', 'lorebooks']) settings[key] = structuredClone(source[key] || []);
    const copyEntry = entry => structuredClone({ primary: entry?.primary, appearanceItems: entry?.appearanceItems || [], generations: [] });
    const charKey = getCurrentCharacterReferenceKey();
    const library = source.characterReferenceLibrary || {};
    settings.characterReferenceLibrary = {
        characters: library.characters?.[charKey] ? { [charKey]: copyEntry(library.characters[charKey]) } : {},
        users: Object.fromEntries(Object.entries(library.users || {}).map(([key, entry]) => [key, copyEntry(entry)])),
    };
    return settings;
}

function checkGenerationOwnership(options) {
    if (options.signal?.aborted || options.isCurrent?.() === false) {
        throw new ProviderError({ message: t`Generation stopped by user`, code: 'aborted', retryable: false });
    }
}

export async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    const settings = options.settings || snapshotGenerationSettings();
    validateSettings(settings);
    checkGenerationOwnership(options);

    const provider = resolveActiveProvider(settings)?.createRequest(settings);
    if (!provider) {
        throw new Error(t`Unknown API: ${settings.apiType}`);
    }

    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;

    let matchedAdditionalRefs = getMatchedAdditionalReferences(prompt, settings);
    if (matchedAdditionalRefs.length > 0) {
        iigLog(
            'INFO',
            `Matched additional refs: ${matchedAdditionalRefs.map((ref) => `${ref.name} [${ref.matchMode}] => ${ref.description || ref.name}`).join(', ')}`
        );
    }

    // Собираем референсы средствами провайдера.
    const referenceContext = await captureReferenceContext(settings, options.messageId);
    checkGenerationOwnership(options);
    const references = await provider.collectReferences({
        prompt,
        messageId: options.messageId,
        matchedAdditionalRefs,
        providerOptions: options,
        settings,
        referenceContext,
    });
    checkGenerationOwnership(options);
    const effectiveModelSettings = options.model
        ? { ...settings, [settings.apiType === 'naistera' ? 'naisteraModel' : 'model']: options.model }
        : settings;
    matchedAdditionalRefs = filterPromptReferences(matchedAdditionalRefs, provider.supportsReferences(effectiveModelSettings));
    const naisteraDescriptionMode = normalizeNaisteraCharacterDescriptionsMode(settings.naisteraCharacterDescriptionsMode);
    const characterDescriptionPromptBlock = settings.apiType === 'naistera' || settings.apiType === 'novelai'
        ? await buildCharacterDescriptionPromptBlock({
            includeChar: true,
            includeUser: true,
            references,
            referenceContext,
            mode: settings.apiType === 'novelai' ? settings.novelaiCharacterDescriptionsMode : naisteraDescriptionMode,
        }, settings)
        : '';
    const wrapStyle = !(settings.apiType === 'novelai' || (settings.apiType === 'naistera' && isNaisteraNovelAIModel(effectiveModelSettings.naisteraModel)));
    checkGenerationOwnership(options);

    iigLog('INFO', `References collected for ${settings.apiType}: ${references.length} ref(s)`);
    for (let i = 0; i < references.length; i++) {
        const ref = references[i];
        const src = getReferenceSource(ref) || '?';
        const desc = getReferenceDescription(ref);
        const img = getReferenceImage(ref);
        const imgInfo = img.startsWith('data:')
            ? `data-url(${img.length} chars)`
            : (img ? `base64(${img.length} chars)` : 'EMPTY');
        const descPreview = desc ? `"${desc.substring(0, 100)}${desc.length > 100 ? '…' : ''}"` : '(no description)';
        iigLog('INFO', `  ref[${i}] source=${src} desc=${descPreview} img=${imgInfo}`);
    }
    iigLog(
        'INFO',
        `Prompt: ${prompt.length} chars, style="${style || ''}", options=${JSON.stringify({
            aspectRatio: options.aspectRatio,
            imageSize: options.imageSize,
            quality: options.quality,
            preset: options.preset,
            messageId: options.messageId,
        })}`
    );

    // Записываем snapshot (in-memory, перезатирается на каждой генерации) для
    // кнопки «Show last request» в настройках. Делаем до generate, чтобы
    // snapshot был доступен даже если провайдер упадёт.
    setLastRequestSnapshot(buildRequestSnapshot({
        prompt,
        style,
        references,
        matchedAdditionalRefs,
        options,
        provider,
        settings: effectiveModelSettings,
        characterDescriptionPromptBlock,
        wrapStyle,
    }));

    let lastError;
    const externalSignal = options.signal || null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        checkGenerationOwnership(options);
        try {
            const statusText = attempt > 0
                ? t`Generating (retry ${attempt}/${maxRetries})...`
                : t`Generating...`;
            onStatusUpdate?.(statusText);

            const generated = await provider.generate({
                prompt,
                style,
                references,
                settings: effectiveModelSettings,
                options: {
                    ...options,
                    matchedAdditionalRefs,
                    characterDescriptionPromptBlock,
                    wrapStyle,
                    signal: externalSignal,
                },
            });
            checkGenerationOwnership(options);

            if (generated && typeof generated === 'object' && generated.kind === 'video') {
                iigLog(
                    'INFO',
                    `Generation result: apiType=${settings.apiType} kind=video mime=${generated.contentType} poster=${generated.posterDataUrl ? 'yes' : 'no'}`
                );
            } else if (typeof generated === 'string' && generated.startsWith('data:')) {
                try {
                    const parsed = parseImageDataUrl(generated);
                    iigLog(
                        'INFO',
                        `Generation result: apiType=${settings.apiType} mime=${parsed.mimeType} subtype=${parsed.subtype} b64len=${parsed.base64Data.length}`
                    );
                } catch (parseErr) {
                    iigLog(
                        'WARN',
                        `Generation result has unparsable data URL: ${parseErr.message}; prefix=${generated.slice(0, 120)}`
                    );
                }
            } else {
                iigLog(
                    'INFO',
                    `Generation result is non-data-url: apiType=${settings.apiType} value=${String(generated).slice(0, 160)}`
                );
            }
            return generated;
        } catch (error) {
            lastError = error;
            iigLog('ERROR', `Generation attempt ${attempt + 1} failed:`, error);

            // Provider errors declare retryability; transport errors use message hints.
            let isRetryable;
            if (error instanceof ProviderError) {
                isRetryable = error.retryable;
            } else {
                isRetryable = error.message?.includes('429') ||
                              error.message?.includes('503') ||
                              error.message?.includes('502') ||
                              error.message?.includes('504') ||
                              error.message?.includes('timeout') ||
                              error.message?.includes('network');
            }

            if (!isRetryable || attempt === maxRetries) {
                break;
            }

            const delay = baseDelay * Math.pow(2, attempt);
            onStatusUpdate?.(t`Retry in ${delay / 1000}s...`);
            await abortableDelay(delay, externalSignal);
        }
    }

    throw lastError;
}

async function generateTagMedia({
    tag, tagIndex, messageId, message, settings, loadingPlaceholder, signal, owner,
    instruction = getInstructionAttributeValue(tag), mode = 'regenerate',
}) {
    const statusEl = loadingPlaceholder.querySelector('.iig-status');
    const generated = await generateImageWithRetry(
        tag.prompt, tag.style,
        status => { statusEl.textContent = status; },
        { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, messageId, signal, settings, isCurrent: owner.isCurrent },
    );
    checkGenerationOwnership({ signal, isCurrent: owner.isCurrent });
    const { persistedSrc, persistedPosterSrc } = await persistGeneratedMedia(generated, statusEl, {
        messageId, tagIndex, mode, apiType: settings.apiType, characterName: owner.characterName,
    });
    checkGenerationOwnership({ signal, isCurrent: owner.isCurrent });
    if (!isGeneratedVideoResult(generated)) recordCharacterGeneration(persistedSrc, tag.prompt, owner.liveSettings, owner.characterKey);
    const media = createGeneratedMediaElement(isGeneratedVideoResult(generated)
        ? { ...generated, dataUrl: persistedSrc, posterDataUrl: persistedPosterSrc || generated.posterDataUrl || '' }
        : persistedSrc, tag);
    if (instruction) media.setAttribute('data-iig-instruction', instruction);
    loadingPlaceholder.replaceWith(media);
    replaceTagInMessageSource(message, tag, buildPersistedMediaTag(tag, generated, persistedSrc, persistedPosterSrc));
    owner.capture();
    return generated;
}

function stopTagGeneration(message, tag, tagId, loadingPlaceholder) {
    loadingPlaceholder?.replaceWith(createStoppedPlaceholder(tagId, tag));
    replaceTagInMessageSource(message, tag, tag.isNewFormat
        ? buildPersistedImageTag(tag, STOPPED_IMAGE_PATH) : '[IMG:STOPPED]');
    toastr.info(t`Generation stopped`, t`Image Generation`, { timeOut: 2000 });
}

// Message identity scopes locks to the owning chat, not its numeric row index.
const activeOperations = new Set();
let operationId = 0;

export function cancelStaleMessageGenerations() {
    for (const owner of activeOperations) {
        if (!owner.isCurrent()) for (const controller of owner.controllers) controller.abort('user-cancel');
    }
}

async function runMessageGeneration(messageId, { forceAll = false, tagIndex = null } = {}) {
    const context = SillyTavern.getContext();
    const liveSettings = getSettings();
    if (!forceAll && !liveSettings.enabled) return;
    const chat = context.chat;
    const message = chat[messageId];
    if (!message) {
        if (forceAll) toastr.error(t`Message not found`, t`Image Generation`);
        return;
    }
    if (!forceAll && message.is_user && !liveSettings.processUserMessages) return;
    if (processingMessages.has(message)) {
        if (forceAll) toastr.info(t`Message is already being processed`, t`Image Generation`);
        return;
    }

    const settings = snapshotGenerationSettings(liveSettings);
    const characterKey = getCurrentCharacterReferenceKey();
    const characterName = context.characters?.[context.characterId]?.name || 'generated';
    const id = ++operationId;
    let source, externalSource, swipe;
    const owner = {
        controllers: new Set(), liveSettings, characterKey, characterName,
        capture() { source = message.mes; externalSource = message.extra?.extblocks; swipe = message.swipe_id; },
        isCurrent() {
            const current = SillyTavern.getContext();
            return current.chat === chat && current.chat[messageId] === message
                && getCurrentCharacterReferenceKey() === characterKey
                && message.mes === source && message.extra?.extblocks === externalSource && message.swipe_id === swipe;
        },
    };
    owner.capture();
    // Acquire before parsing or any other await; retain ownership through saving.
    processingMessages.add(message);
    activeOperations.add(owner);
    let mesTextEl;
    let dirty = false;
    try {
        const tags = await parseMessageImageTags(message, { forceAll, checkExistence: !forceAll, settings });
        if (!owner.isCurrent()) return;
        if (!tags.length) {
            if (forceAll) toastr.warning(t`No tags to regenerate`, t`Image Generation`);
            return;
        }
        if (tagIndex !== null && (tagIndex < 0 || tagIndex >= tags.length)) {
            toastr.warning(t`Tag not found`, t`Image Generation`);
            return;
        }
        mesTextEl = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
        if (!mesTextEl) {
            toastr.error(t`Could not locate message element`, t`Image Generation`);
            return;
        }
        dirty = convertLegacyTagsToInstructionFormat(message, tags) > 0;
        owner.capture();
        if (dirty) rerenderMessageHtml(context, message, settings, messageId, mesTextEl);
        const renderedMedia = bindRenderedMediaTags(mesTextEl, tags);
        const indices = tagIndex === null ? tags.map((_, index) => index) : [tagIndex];
        if (forceAll && tagIndex === null) toastr.info(t`Regenerating ${tags.length} images...`, t`Image Generation`);
        else if (!forceAll) toastr.info(t`Tags found: ${tags.length}. Generating...`, t`Image Generation`, { timeOut: 3000 });

        for (const index of indices) {
            if (!owner.isCurrent()) break;
            const tag = tags[index];
            const tagId = 'iig-' + id + '-' + messageId + '-' + index;
            const controller = new AbortController();
            owner.controllers.add(controller);
            tagAbortControllers.set(tagId, controller);
            let loadingPlaceholder = null;
            try {
                applyConfiguredStyleToTag(tag, settings);
                const existingMedia = renderedMedia[index];
                if (forceAll && !existingMedia) throw new Error(t`Could not find image in this message. Reopen the chat and try again.`);
                const instruction = existingMedia?.getAttribute('data-iig-instruction') || getInstructionAttributeValue(tag);
                loadingPlaceholder = createLoadingPlaceholder(tagId);
                if (existingMedia) {
                    const parent = existingMedia.parentElement;
                    if (parent && ['flex', 'grid'].includes(getComputedStyle(parent).display)) loadingPlaceholder.style.alignSelf = 'center';
                    existingMedia.replaceWith(loadingPlaceholder);
                } else mesTextEl.appendChild(loadingPlaceholder);
                const generated = await generateTagMedia({
                    tag, tagIndex: index, messageId, message, settings, loadingPlaceholder, owner,
                    signal: controller.signal, instruction, mode: forceAll ? 'regenerate' : 'generate',
                });
                dirty = true;
                const ready = tagIndex !== null
                    ? (isGeneratedVideoResult(generated) ? t`Video ready` : t`Image ready`)
                    : (isGeneratedVideoResult(generated) ? t`Video ${index + 1}/${tags.length} ready` : t`Image ${index + 1}/${tags.length} ready`);
                toastr.success(ready, t`Image Generation`, { timeOut: 2000 });
            } catch (error) {
                if (!owner.isCurrent()) break;
                if (error instanceof ProviderError && error.code === 'aborted') {
                    stopTagGeneration(message, tag, tagId, loadingPlaceholder);
                    dirty = true;
                } else {
                    iigLog('ERROR', 'Generation failed for tag ' + index + ':', error);
                    const friendly = formatProviderError(error);
                    if (!forceAll) {
                        loadingPlaceholder?.replaceWith(createErrorPlaceholder(tagId, error.message, tag, friendly));
                        replaceTagInMessageSource(message, tag, tag.isNewFormat
                            ? buildPersistedImageTag(tag, ERROR_IMAGE_PATH)
                            : '[IMG:ERROR:' + String(error.message).substring(0, 50) + ']');
                        dirty = true;
                    }
                    toastr.error(friendly.message, friendly.title);
                }
                owner.capture();
            } finally {
                tagAbortControllers.delete(tagId);
                owner.controllers.delete(controller);
            }
        }
        if (owner.isCurrent()) {
            if (dirty) await context.saveChat();
            if (owner.isCurrent()) rerenderMessageHtml(context, message, settings, messageId, mesTextEl);
        }
    } finally {
        activeOperations.delete(owner);
        processingMessages.delete(message);
    }
}

export function processMessageTags(messageId) {
    return runMessageGeneration(messageId);
}

export function regenerateSingleTag(messageId, tagIndex) {
    return runMessageGeneration(messageId, { forceAll: true, tagIndex });
}

export function regenerateMessageImages(messageId) {
    return runMessageGeneration(messageId, { forceAll: true });
}
