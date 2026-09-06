/**
 * Центральный pipeline генерации:
 *   - `generateImageWithRetry` — подготовка референсов через активный провайдер,
 *     одиночный вызов с retry'ем, без веток apiType.
 *   - `processMessageTags` — обработка нового сообщения от LLM.
 *   - `regenerateMessageImages` — принудительная перегенерация всех тегов в сообщении.
 *
 * Общий helper `persistGeneratedMedia` убирает дубликат блока сохранения
 * изображения/видео (раньше был в обеих процедурах).
 */

import {
    getSettings,
    iigLog,
    getEffectiveRefInstruction,
    setLastRequestSnapshot,
    normalizeNaisteraModel,
    isNaisteraNovelAIModel,
    normalizeNaisteraCharacterDescriptionsMode,
} from './settings.js';
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
    buildFinalGenerationPrompt,
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
    getReferenceImage,
    recordCharacterGeneration,
    buildCharacterDescriptionPromptBlock,
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

function referenceSource(ref) {
    if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
        return String(ref.source || '').trim();
    }
    return '';
}

function buildAvatarReferenceSnapshotBlock(references = [], settings = getSettings()) {
    if (settings.sendRefDescriptions === false) {
        return '';
    }

    const lines = references
        .map((ref, index) => {
            const source = referenceSource(ref);
            if (source !== 'char' && source !== 'user') {
                return '';
            }
            const description = getReferenceDescription(ref);
            if (!description) {
                return '';
            }
            const label = source === 'char' ? '{{char}} avatar' : '{{user}} avatar';
            return `- Reference ${index + 1} (${label}): ${description}`;
        })
        .filter(Boolean);

    return lines.length > 0
        ? `Character reference descriptions:\n${lines.join('\n')}`
        : '';
}

/**
 * Строит snapshot финального запроса для in-memory отображения в UI.
 * Воспроизводит apiType-зависимую логику сборки prompt'а (refInstruction
 * префикс только для провайдеров из REF_INSTRUCTION_PROVIDERS).
 */
function buildRequestSnapshot({ prompt, style, references, matchedAdditionalRefs, excludedRefs = [], options, provider, settings, characterDescriptionPromptBlock = '', wrapStyle = true }) {
    let snapshotPrompt = buildFinalGenerationPrompt(
        prompt,
        style,
        matchedAdditionalRefs || [],
        settings,
        { wrapStyle },
    );
    if (settings.apiType === 'openai' || settings.apiType === 'xai' || settings.apiType === 'electronhub') {
        const avatarDescriptions = buildAvatarReferenceSnapshotBlock(references, settings);
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

    const aspectRatio = settings.apiType === 'naistera'
        ? (options?.aspectRatio || settings.naisteraAspectRatio)
        : settings.apiType === 'xai'
            ? (options?.aspectRatio || settings.xaiAspectRatio)
            : (options?.aspectRatio || settings.aspectRatio);

    const matchedRefsInfo = (Array.isArray(matchedAdditionalRefs) ? matchedAdditionalRefs : []).map((ref) => ({
        name: String(ref?.name || ''),
        group: String(ref?.group || ''),
        priority: Number.isFinite(ref?.priority) ? ref.priority : 0,
        lorebookName: String(ref?._lorebookName || ''),
        reason: ref?._matchReason || null,
    }));
    const negativePrompt = settings.apiType === 'naistera' && provider?.supportsNegativePrompt(settings)
        ? String(options?.negativePrompt ?? settings.naisteraNegativePrompt ?? '').trim()
        : '';

    return {
        timestamp: Date.now(),
        prompt: snapshotPrompt,
        matchingPrompt: prompt,
        excludedRefs,
        negativePrompt,
        references: references.map((ref, index) => ({
            dataUrl: refToPreviewDataUrl(ref),
            label: `ref ${index + 1}`,
            description: getReferenceDescription(ref),
            source: referenceSource(ref),
        })),
        matchedRefs: matchedRefsInfo,
        metadata: {
            provider: provider?.displayName || settings.apiType,
            apiType: settings.apiType,
            model,
            aspectRatio,
            imageSize: settings.apiType === 'xai'
                ? (options?.imageSize || settings.xaiResolution || '')
                : (options?.imageSize || settings.imageSize || ''),
            size: settings.size || '',
            quality: settings.apiType === 'xai'
                ? (options?.quality || settings.xaiQuality || '')
                : (options?.quality || settings.quality || ''),
            refInstructionApplied,
        },
    };
}

// Set of messageIds currently being processed (shared between processMessageTags
// and regenerate to prevent double-runs).
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

// ----- Shared helper: сохранение media на сервер (общий для process + regenerate) -----

/**
 * Сохраняет generated media (image или video) на сервер SillyTavern и возвращает
 * пути к файлам. Ранее этот блок дублировался в `processMessageTags` и
 * `regenerateMessageImages`.
 *
 * @param {any} generated — результат provider.generate (string data URL | { kind:'video', ... })
 * @param {HTMLElement} statusEl — DOM-элемент, куда пишем текстовый статус
 * @param {{ messageId: number, tagIndex: number, mode: 'generate' | 'regenerate' }} meta
 * @returns {Promise<{ persistedSrc: string, persistedPosterSrc: string }>}
 */
export async function persistGeneratedMedia(generated, statusEl, meta) {
    const { messageId, tagIndex, mode } = meta;
    const apiType = getSettings().apiType;

    let persistedSrc = '';
    let persistedPosterSrc = '';

    if (isGeneratedVideoResult(generated)) {
        if (statusEl) statusEl.textContent = t`Saving video...`;
        persistedSrc = await saveNaisteraMediaToFile(generated.dataUrl, 'video', {
            messageId,
            tagIndex,
            mode: `${mode}-video`,
            apiType,
        });
        if (generated.posterDataUrl) {
            if (statusEl) statusEl.textContent = t`Saving preview...`;
            persistedPosterSrc = await saveImageToFile(generated.posterDataUrl, {
                messageId,
                tagIndex,
                mode: `${mode}-video-poster`,
                apiType,
            });
        }
    } else {
        if (statusEl) statusEl.textContent = t`Saving...`;
        persistedSrc = await saveImageToFile(generated, {
            messageId,
            tagIndex,
            mode,
            apiType,
        });
    }

    return { persistedSrc, persistedPosterSrc };
}

// ----- Main generate (provider dispatch + retry loop) -----

export async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();

    const settings = getSettings();
    const provider = resolveActiveProvider(settings);
    if (!provider) {
        throw new Error(t`Unknown API: ${settings.apiType}`);
    }

    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;

    const excludedRefs = [];
    const matchedAdditionalRefs = getMatchedAdditionalReferences(prompt, { excluded: excludedRefs });
    if (matchedAdditionalRefs.length > 0) {
        iigLog(
            'INFO',
            `Matched additional refs: ${matchedAdditionalRefs.map((ref) => `${ref.name} [${ref.matchMode}] => ${ref.description || ref.name}`).join(', ')}`
        );
    }

    // Собираем референсы средствами провайдера.
    const references = await provider.collectReferences({
        prompt,
        messageId: options.messageId,
        matchedAdditionalRefs,
        providerOptions: options,
    });
    const naisteraDescriptionMode = normalizeNaisteraCharacterDescriptionsMode(settings.naisteraCharacterDescriptionsMode);
    const characterDescriptionPromptBlock = settings.apiType === 'naistera'
        ? await buildCharacterDescriptionPromptBlock({
            includeChar: true,
            includeUser: true,
            references,
            mode: naisteraDescriptionMode,
        }, settings)
        : '';
    const wrapStyle = !(settings.apiType === 'naistera' && isNaisteraNovelAIModel(settings.naisteraModel));

    iigLog('INFO', `References collected for ${settings.apiType}: ${references.length} ref(s)`);
    for (let i = 0; i < references.length; i++) {
        const ref = references[i];
        const src = referenceSource(ref) || '?';
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
        settings,
        excludedRefs,
        characterDescriptionPromptBlock,
        wrapStyle,
    }));

    let lastError;
    const externalSignal = options.signal || null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (externalSignal?.aborted) {
            throw new ProviderError({
                message: t`Generation stopped by user`,
                code: 'aborted',
                retryable: false,
                providerId: settings.apiType || '',
            });
        }
        try {
            const statusText = attempt > 0
                ? t`Generating (retry ${attempt}/${maxRetries})...`
                : t`Generating...`;
            onStatusUpdate?.(statusText);

            const generated = await provider.generate({
                prompt,
                style,
                references,
                options: {
                    ...options,
                    matchedAdditionalRefs,
                    characterDescriptionPromptBlock,
                    wrapStyle,
                    signal: externalSignal,
                },
            });

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

            // ProviderError даёт `retryable` явно. Для прочих ошибок (напр.
            // всплывших из saveImageToFile / внутренностей JS) — fallback на
            // прежнюю regex-эвристику, чтобы не потерять привычное поведение.
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

// ----- Process message tags (on AI message rendered) -----

export async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    if (!settings.enabled) return;

    if (processingMessages.has(messageId)) {
        iigLog('WARN', `Message ${messageId} is already being processed, skipping`);
        return;
    }

    const message = context.chat[messageId];
    if (!message) return;
    // User messages are processed only when the toggle is on.
    if (message.is_user && !settings.processUserMessages) return;

    const tags = await parseMessageImageTags(message, { checkExistence: true });
    iigLog('INFO', `parseImageTags returned: ${tags.length} tags (message ${messageId}, is_user=${!!message.is_user})`);
    for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        const promptPreview = String(t.prompt || '').substring(0, 60);
        const srcPreview = String(t.existingSrc || '').substring(0, 50);
        iigLog('INFO', `  tag[${i}] prompt="${promptPreview}" newFormat=${!!t.isNewFormat} src="${srcPreview}"`);
    }
    if (tags.length === 0) {
        iigLog('INFO', 'No tags found by parser');
        return;
    }

    processingMessages.add(messageId);
    iigLog('INFO', `Found ${tags.length} image tag(s) in message ${messageId}`);
    toastr.info(t`Tags found: ${tags.length}. Generating...`, t`Image Generation`, { timeOut: 3000 });

    // DOM is ready because we use CHARACTER_MESSAGE_RENDERED event
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        console.error('[IIG] Message element not found for ID:', messageId);
        toastr.error(t`Could not locate message element`, t`Image Generation`);
        processingMessages.delete(messageId);
        return;
    }

    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) {
        processingMessages.delete(messageId);
        return;
    }

    const convertedLegacyTags = convertLegacyTagsToInstructionFormat(message, tags);

    if (convertedLegacyTags > 0) {
        rerenderMessageHtml(context, message, settings, messageId, mesTextEl);
        iigLog('INFO', `Converted ${convertedLegacyTags} legacy tag(s) to instruction tags before processing`);
    }

    const processTag = async (tag, index) => {
        const tagId = `iig-${messageId}-${index}`;
        applyConfiguredStyleToTag(tag, settings);

        iigLog('INFO', `Processing tag ${index}: ${tag.fullMatch.substring(0, 50)}`);

        const loadingPlaceholder = createLoadingPlaceholder(tagId);
        let targetElement = null;

        // NEW FORMAT: <img|video data-iig-instruction='...'> is a real DOM element
        const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction], video[data-iig-instruction]');
        iigLog('INFO', `Searching for media element. Found ${allImgs.length} [data-iig-instruction] elements in DOM`);

        const searchPrompt = tag.prompt.substring(0, 30);
        iigLog('INFO', `Searching for prompt starting with: "${searchPrompt}"`);

        const isPendingDomMedia = (img) => {
            const src = img.getAttribute('src') || '';
            return src.includes('[IMG:GEN]')
                || src.includes('[IMG:ERROR]')
                || src === ''
                || src === '#'
                || (tag.existingSrc && src === tag.existingSrc);
        };

        const decodeEntities = (str) => String(str || '')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&#39;/g, "'")
            .replace(/&#34;/g, '"')
            .replace(/&amp;/g, '&');

        const normalizedSearchPrompt = decodeEntities(searchPrompt);

        const matchesByPrompt = (img) => {
            const instruction = img.getAttribute('data-iig-instruction');
            if (!instruction) return false;
            const decoded = decodeEntities(instruction);
            if (decoded.includes(normalizedSearchPrompt)) return true;
            if (instruction.includes(searchPrompt)) return true;
            try {
                const data = JSON.parse(decoded.replace(/'/g, '"'));
                if (data?.prompt && data.prompt.substring(0, 30) === tag.prompt.substring(0, 30)) return true;
            } catch {}
            return false;
        };

        const indexedCandidate = allImgs[index];
        if (indexedCandidate && isPendingDomMedia(indexedCandidate)) {
            targetElement = indexedCandidate;
            iigLog('INFO', `Found media element via pending DOM index ${index}`);
        }

        if (!targetElement) {
            for (const img of allImgs) {
                if (!matchesByPrompt(img)) continue;
                targetElement = img;
                const src = img.getAttribute('src') || '';
                iigLog('INFO', `Found media element via prompt match (src="${src.substring(0, 60)}", pending=${isPendingDomMedia(img)})`);
                break;
            }
        }

        if (!targetElement && allImgs.length === tags.length) {
            const candidate = allImgs[index];
            if (candidate) {
                targetElement = candidate;
                const src = candidate.getAttribute('src') || '';
                iigLog('INFO', `Found media element via 1-to-1 positional fallback at index ${index} (src="${src.substring(0, 60)}")`);
            }
        }

        if (!targetElement) {
            iigLog('INFO', `Prompt matching failed, trying src marker matching...`);
            for (const img of allImgs) {
                if (isPendingDomMedia(img)) {
                    const src = img.getAttribute('src') || '';
                    iigLog('INFO', `Found img element with generation marker in src: "${src}"`);
                    targetElement = img;
                    break;
                }
            }
        }

        if (!targetElement) {
            iigLog('INFO', `Trying broader media search...`);
            const allImgsInMes = mesTextEl.querySelectorAll('img, video');
            for (const img of allImgsInMes) {
                const src = img.getAttribute('src') || '';
                if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) {
                    iigLog('INFO', `Found img via broad search with marker src: "${src.substring(0, 50)}"`);
                    targetElement = img;
                    break;
                }
            }
        }

        if (targetElement) {
            const parent = targetElement.parentElement;
            if (parent) {
                const parentStyle = window.getComputedStyle(parent);
                if (parentStyle.display === 'flex' || parentStyle.display === 'grid') {
                    loadingPlaceholder.style.alignSelf = 'center';
                }
            }
            targetElement.replaceWith(loadingPlaceholder);
            iigLog('INFO', `Loading placeholder shown (replaced target element)`);
        } else {
            iigLog('WARN', `Could not find target element, appending placeholder as fallback`);
            mesTextEl.appendChild(loadingPlaceholder);
        }

        const statusEl = loadingPlaceholder.querySelector('.iig-status');

        const controller = new AbortController();
        tagAbortControllers.set(tagId, controller);

        try {
            const generated = await generateImageWithRetry(
                tag.prompt,
                tag.style,
                (status) => { statusEl.textContent = status; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, messageId, signal: controller.signal }
            );

            const { persistedSrc, persistedPosterSrc } = await persistGeneratedMedia(
                generated,
                statusEl,
                { messageId, tagIndex: index, mode: 'generate' }
            );
            if (!isGeneratedVideoResult(generated)) {
                recordCharacterGeneration(persistedSrc, tag.prompt, settings);
            }

            const mediaElement = createGeneratedMediaElement(
                isGeneratedVideoResult(generated)
                    ? { ...generated, dataUrl: persistedSrc, posterDataUrl: persistedPosterSrc || generated.posterDataUrl || '' }
                    : persistedSrc,
                tag,
            );

            const instructionValue = getInstructionAttributeValue(tag);
            if (instructionValue) {
                mediaElement.setAttribute('data-iig-instruction', instructionValue);
            }

            loadingPlaceholder.replaceWith(mediaElement);

            const updatedTag = buildPersistedMediaTag(tag, generated, persistedSrc, persistedPosterSrc);
            replaceTagInMessageSource(message, tag, updatedTag);

            iigLog('INFO', `Successfully generated ${isGeneratedVideoResult(generated) ? 'video' : 'image'} for tag ${index}`);
            const readyMsg = isGeneratedVideoResult(generated)
                ? t`Video ${index + 1}/${tags.length} ready`
                : t`Image ${index + 1}/${tags.length} ready`;
            toastr.success(readyMsg, t`Image Generation`, { timeOut: 2000 });
        } catch (error) {
            const wasAborted = error instanceof ProviderError && error.code === 'aborted';
            if (wasAborted) {
                iigLog('INFO', `Generation stopped by user for tag ${index}`);
                const stoppedPlaceholder = createStoppedPlaceholder(tagId, tag);
                loadingPlaceholder.replaceWith(stoppedPlaceholder);
                if (tag.isNewFormat) {
                    const stoppedTag = buildPersistedImageTag(tag, STOPPED_IMAGE_PATH);
                    replaceTagInMessageSource(message, tag, stoppedTag);
                } else {
                    replaceTagInMessageSource(message, tag, `[IMG:STOPPED]`);
                }
                toastr.info(t`Generation stopped`, t`Image Generation`, { timeOut: 2000 });
            } else {
                iigLog('ERROR', `Failed to generate image for tag ${index}:`, error);
                const friendly = formatProviderError(error);

                const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag, friendly);
                loadingPlaceholder.replaceWith(errorPlaceholder);

                if (tag.isNewFormat) {
                    const errorTag = buildPersistedImageTag(tag, ERROR_IMAGE_PATH);
                    replaceTagInMessageSource(message, tag, errorTag);
                } else {
                    const errorMarker = `[IMG:ERROR:${error.message.substring(0, 50)}]`;
                    replaceTagInMessageSource(message, tag, errorMarker);
                }
                iigLog('INFO', `Marked tag as failed in message.mes`);

                toastr.error(friendly.message, friendly.title);
            }
        } finally {
            tagAbortControllers.delete(tagId);
        }
    };

    try {
        // Process in source order so identical tags are persisted to matching slots.
        for (let index = 0; index < tags.length; index++) {
            await processTag(tags[index], index);
        }
    } finally {
        processingMessages.delete(messageId);
        iigLog('INFO', `Finished processing message ${messageId}`);
    }

    await context.saveChat();

    if (typeof context.messageFormatting === 'function') {
        rerenderMessageHtml(context, message, settings, messageId, mesTextEl);
        console.log('[IIG] Message re-rendered via messageFormatting');
    } else {
        const freshMessageEl = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
        if (freshMessageEl && message.mes) {
            console.log('[IIG] Attempting manual refresh...');
        }
    }
}

// ----- Regenerate (user-triggered) -----

/**
 * Regenerate a single image identified by (messageId, tagIndex).
 * tagIndex matches the order of tags returned by parseMessageImageTags.
 */
export async function regenerateSingleTag(messageId, tagIndex) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const message = context.chat[messageId];

    if (!message) {
        toastr.error(t`Message not found`, t`Image Generation`);
        return;
    }

    const tags = await parseMessageImageTags(message, { forceAll: true });
    if (tagIndex < 0 || tagIndex >= tags.length) {
        toastr.warning(t`Tag not found`, t`Image Generation`);
        return;
    }

    if (processingMessages.has(messageId)) {
        toastr.info(t`Message is already being processed`, t`Image Generation`);
        return;
    }
    processingMessages.add(messageId);

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    const mesTextEl = messageElement?.querySelector('.mes_text');
    if (!mesTextEl) {
        processingMessages.delete(messageId);
        return;
    }

    const convertedLegacyTags = convertLegacyTagsToInstructionFormat(message, tags);
    if (convertedLegacyTags > 0) {
        rerenderMessageHtml(context, message, settings, messageId, mesTextEl);
    }

    const tag = tags[tagIndex];
    const tagId = `iig-regen-${messageId}-${tagIndex}`;
    applyConfiguredStyleToTag(tag, settings);

    let loadingPlaceholder = null;
    const controller = new AbortController();
    tagAbortControllers.set(tagId, controller);

    try {
        const existingMediaList = Array.from(
            mesTextEl.querySelectorAll('img[data-iig-instruction], video[data-iig-instruction]')
        );
        const existingMedia = existingMediaList[tagIndex] || null;
        if (!existingMedia) {
            throw new Error(`Media element at index ${tagIndex} not found in DOM`);
        }
        const instruction = existingMedia.getAttribute('data-iig-instruction');

        loadingPlaceholder = createLoadingPlaceholder(tagId);
        existingMedia.replaceWith(loadingPlaceholder);
        const statusEl = loadingPlaceholder.querySelector('.iig-status');

        const generated = await generateImageWithRetry(
            tag.prompt,
            tag.style,
            (status) => { statusEl.textContent = status; },
            { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, messageId, signal: controller.signal }
        );

        const { persistedSrc, persistedPosterSrc } = await persistGeneratedMedia(
            generated,
            statusEl,
            { messageId, tagIndex, mode: 'regenerate' }
        );
        if (!isGeneratedVideoResult(generated)) {
            recordCharacterGeneration(persistedSrc, tag.prompt, settings);
        }

        const mediaElement = createGeneratedMediaElement(
            isGeneratedVideoResult(generated)
                ? { ...generated, dataUrl: persistedSrc, posterDataUrl: persistedPosterSrc || generated.posterDataUrl || '' }
                : persistedSrc,
            tag,
        );
        if (instruction) {
            mediaElement.setAttribute('data-iig-instruction', instruction);
        }
        loadingPlaceholder.replaceWith(mediaElement);

        const updatedTag = buildPersistedMediaTag(tag, generated, persistedSrc, persistedPosterSrc);
        replaceTagInMessageSource(message, tag, updatedTag);

        const readyMsg = isGeneratedVideoResult(generated)
            ? t`Video ready`
            : t`Image ready`;
        toastr.success(readyMsg, t`Image Generation`, { timeOut: 2000 });
    } catch (error) {
        const wasAborted = error instanceof ProviderError && error.code === 'aborted';
        if (wasAborted) {
            iigLog('INFO', `Single-tag regeneration stopped by user for tag ${tagIndex}`);
            if (loadingPlaceholder) {
                const stoppedPlaceholder = createStoppedPlaceholder(tagId, tag);
                loadingPlaceholder.replaceWith(stoppedPlaceholder);
            }
            if (tag.isNewFormat) {
                const stoppedTag = buildPersistedImageTag(tag, STOPPED_IMAGE_PATH);
                replaceTagInMessageSource(message, tag, stoppedTag);
            } else {
                replaceTagInMessageSource(message, tag, `[IMG:STOPPED]`);
            }
            toastr.info(t`Generation stopped`, t`Image Generation`, { timeOut: 2000 });
        } else {
            iigLog('ERROR', `Single-tag regeneration failed for tag ${tagIndex}:`, error);
            const friendly = formatProviderError(error);
            toastr.error(friendly.message, friendly.title);
        }
    } finally {
        tagAbortControllers.delete(tagId);
        processingMessages.delete(messageId);
        await context.saveChat();
        rerenderMessageHtml(context, message, settings, messageId, mesTextEl);
    }
}

export async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const message = context.chat[messageId];

    if (!message) {
        toastr.error(t`Message not found`, t`Image Generation`);
        return;
    }

    if (processingMessages.has(messageId)) {
        toastr.info(t`Message is already being processed`, t`Image Generation`);
        return;
    }

    processingMessages.add(messageId);

    try {
        const tags = await parseMessageImageTags(message, { forceAll: true });

        iigLog('INFO', `regenerateMessageImages(messageId=${messageId}): parser found ${tags.length} tag(s)`);
        for (let i = 0; i < tags.length; i++) {
            iigLog('INFO', `  tag[${i}] prompt: "${String(tags[i].prompt || '').substring(0, 60)}"`);
        }

        if (tags.length === 0) {
            toastr.warning(t`No tags to regenerate`, t`Image Generation`);
            return;
        }

        iigLog('INFO', `Regenerating ${tags.length} images in message ${messageId}`);
        toastr.info(t`Regenerating ${tags.length} images...`, t`Image Generation`);

        const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!messageElement) {
            iigLog('WARN', `regenerateMessageImages: .mes[mesid="${messageId}"] not found in DOM`);
            return;
        }

        const mesTextEl = messageElement.querySelector('.mes_text');
        if (!mesTextEl) {
            iigLog('WARN', `regenerateMessageImages: .mes_text not found inside message ${messageId}`);
            return;
        }

        const convertedLegacyTags = convertLegacyTagsToInstructionFormat(message, tags);
        if (convertedLegacyTags > 0) {
            rerenderMessageHtml(context, message, settings, messageId, mesTextEl);
            iigLog('INFO', `Converted ${convertedLegacyTags} legacy tag(s) to instruction tags before regeneration`);
        }

        for (let index = 0; index < tags.length; index++) {
            const tag = tags[index];
            const tagId = `iig-regen-${messageId}-${index}`;
            applyConfiguredStyleToTag(tag, settings);
            iigLog('INFO', `regen iter[${index}/${tags.length - 1}] start: prompt="${String(tag.prompt || '').substring(0, 40)}"`);

            let loadingPlaceholder = null;
            const controller = new AbortController();
            tagAbortControllers.set(tagId, controller);

            try {
                const existingMediaList = Array.from(
                    mesTextEl.querySelectorAll('img[data-iig-instruction], video[data-iig-instruction]')
                );
                const existingMedia = existingMediaList[index] || existingMediaList[0] || null;
                iigLog('INFO', `regen iter[${index}] DOM media count=${existingMediaList.length}, picked=${existingMedia ? (existingMediaList[index] === existingMedia ? `[${index}]` : '[0]-fallback') : 'NONE'}`);
                if (existingMedia) {
                    const instruction = existingMedia.getAttribute('data-iig-instruction');

                    loadingPlaceholder = createLoadingPlaceholder(tagId);
                    existingMedia.replaceWith(loadingPlaceholder);

                    const statusEl = loadingPlaceholder.querySelector('.iig-status');

                    const generated = await generateImageWithRetry(
                        tag.prompt,
                        tag.style,
                        (status) => { statusEl.textContent = status; },
                        { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, messageId, signal: controller.signal }
                    );

                    const { persistedSrc, persistedPosterSrc } = await persistGeneratedMedia(
                        generated,
                        statusEl,
                        { messageId, tagIndex: index, mode: 'regenerate' }
                    );
                    if (!isGeneratedVideoResult(generated)) {
                        recordCharacterGeneration(persistedSrc, tag.prompt, settings);
                    }

                    const mediaElement = createGeneratedMediaElement(
                        isGeneratedVideoResult(generated)
                            ? { ...generated, dataUrl: persistedSrc, posterDataUrl: persistedPosterSrc || generated.posterDataUrl || '' }
                            : persistedSrc,
                        tag,
                    );
                    if (instruction) {
                        mediaElement.setAttribute('data-iig-instruction', instruction);
                    }
                    loadingPlaceholder.replaceWith(mediaElement);

                    const updatedTag = buildPersistedMediaTag(tag, generated, persistedSrc, persistedPosterSrc);
                    replaceTagInMessageSource(message, tag, updatedTag);

                    const readyMsg = isGeneratedVideoResult(generated)
                        ? t`Video ${index + 1}/${tags.length} ready`
                        : t`Image ${index + 1}/${tags.length} ready`;
                    toastr.success(readyMsg, t`Image Generation`, { timeOut: 2000 });
                    iigLog('INFO', `regen iter[${index}] complete`);
                } else {
                    iigLog('WARN', `regen iter[${index}] skipped: no DOM element found`);
                }
            } catch (error) {
                const wasAborted = error instanceof ProviderError && error.code === 'aborted';
                if (wasAborted) {
                    iigLog('INFO', `regen iter[${index}] stopped by user`);
                    if (loadingPlaceholder) {
                        const stoppedPlaceholder = createStoppedPlaceholder(tagId, tag);
                        loadingPlaceholder.replaceWith(stoppedPlaceholder);
                    }
                    if (tag.isNewFormat) {
                        const stoppedTag = buildPersistedImageTag(tag, STOPPED_IMAGE_PATH);
                        replaceTagInMessageSource(message, tag, stoppedTag);
                    } else {
                        replaceTagInMessageSource(message, tag, `[IMG:STOPPED]`);
                    }
                    toastr.info(t`Generation stopped`, t`Image Generation`, { timeOut: 2000 });
                } else {
                    iigLog('ERROR', `Regeneration failed for tag ${index}:`, error);
                    const friendly = formatProviderError(error);
                    toastr.error(friendly.message, friendly.title);
                }
            } finally {
                tagAbortControllers.delete(tagId);
            }
        }

        await context.saveChat();
        rerenderMessageHtml(context, message, settings, messageId, mesTextEl);
        iigLog('INFO', `Regeneration complete for message ${messageId}`);
    } finally {
        processingMessages.delete(messageId);
    }
}
