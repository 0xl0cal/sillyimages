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
} from './settings.js';
import {
    saveImageToFile,
    saveNaisteraMediaToFile,
    ERROR_IMAGE_PATH,
    parseImageDataUrl,
    ProviderError,
} from './utils.js';
import {
    applyConfiguredStyleToTag,
    buildFinalGenerationPrompt,
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
const REF_INSTRUCTION_PROVIDERS = new Set(['openai', 'electronhub', 'gemini', 'openrouter', 'naistera']);

/**
 * Приводит любой представление референса (base64 строка или data URL)
 * к data URL для превью в модалке.
 */
function refToPreviewDataUrl(ref) {
    const value = String(ref || '');
    if (!value) return '';
    return value.startsWith('data:') ? value : `data:image/png;base64,${value}`;
}

/**
 * Строит snapshot финального запроса для in-memory отображения в UI.
 * Воспроизводит apiType-зависимую логику сборки prompt'а (refInstruction
 * префикс только для провайдеров из REF_INSTRUCTION_PROVIDERS).
 */
function buildRequestSnapshot({ prompt, style, references, matchedAdditionalRefs, options, provider, settings }) {
    let snapshotPrompt = buildFinalGenerationPrompt(prompt, style, matchedAdditionalRefs || [], settings);
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
        : (options?.aspectRatio || settings.aspectRatio);

    const matchedRefsInfo = (Array.isArray(matchedAdditionalRefs) ? matchedAdditionalRefs : []).map((ref) => ({
        name: String(ref?.name || ''),
        group: String(ref?.group || ''),
        priority: Number.isFinite(ref?.priority) ? ref.priority : 0,
        lorebookName: String(ref?._lorebookName || ''),
        reason: ref?._matchReason || null,
    }));

    return {
        timestamp: Date.now(),
        prompt: snapshotPrompt,
        references: references.map((ref, index) => ({
            dataUrl: refToPreviewDataUrl(ref),
            label: `ref ${index + 1}`,
        })),
        matchedRefs: matchedRefsInfo,
        metadata: {
            provider: provider?.displayName || settings.apiType,
            apiType: settings.apiType,
            model,
            aspectRatio,
            imageSize: options?.imageSize || settings.imageSize || '',
            size: settings.size || '',
            quality: options?.quality || settings.quality || '',
            refInstructionApplied,
        },
    };
}

// Set of messageIds currently being processed (shared between processMessageTags
// and regenerate to prevent double-runs).
export const processingMessages = new Set();

// ----- Placeholder DOM helpers -----

export function createLoadingPlaceholder(tagId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = `
        <div class="iig-spinner"></div>
        <div class="iig-status">${t`Generating image...`}</div>
    `;
    return placeholder;
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
            persistedSrc = await saveImageToFile(generated.posterDataUrl, {
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

    const matchedAdditionalRefs = getMatchedAdditionalReferences(prompt);
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
    }));

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
            console.error(`[IIG] Generation attempt ${attempt + 1} failed:`, error);

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
            await new Promise(resolve => setTimeout(resolve, delay));
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
    if (!message || message.is_user) return;

    const tags = await parseMessageImageTags(message, { checkExistence: true });
    iigLog('INFO', `parseImageTags returned: ${tags.length} tags`);
    if (tags.length > 0) {
        iigLog('INFO', `First tag: ${JSON.stringify(tags[0]).substring(0, 200)}`);
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
        return;
    }

    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) return;

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

        for (const img of allImgs) {
            const instruction = img.getAttribute('data-iig-instruction');
            const src = img.getAttribute('src') || '';
            iigLog('INFO', `DOM img - src: "${src.substring(0, 50)}", instruction (first 100): "${instruction?.substring(0, 100)}"`);

            if (instruction) {
                // Strategy 1: Decode HTML entities and normalize quotes, then match
                const decodedInstruction = instruction
                    .replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'")
                    .replace(/&#39;/g, "'")
                    .replace(/&#34;/g, '"')
                    .replace(/&amp;/g, '&');

                const normalizedSearchPrompt = searchPrompt
                    .replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'")
                    .replace(/&#39;/g, "'")
                    .replace(/&#34;/g, '"')
                    .replace(/&amp;/g, '&');

                if (decodedInstruction.includes(normalizedSearchPrompt)) {
                    iigLog('INFO', `Found img element via decoded instruction match`);
                    targetElement = img;
                    break;
                }

                // Strategy 2: Try to parse the instruction as JSON and compare prompts
                try {
                    const normalizedJson = decodedInstruction.replace(/'/g, '"');
                    const instructionData = JSON.parse(normalizedJson);
                    if (instructionData.prompt && instructionData.prompt.substring(0, 30) === tag.prompt.substring(0, 30)) {
                        iigLog('INFO', `Found img element via JSON prompt match`);
                        targetElement = img;
                        break;
                    }
                } catch (e) {
                    // JSON parse failed, continue with other strategies
                }

                // Strategy 3: Raw instruction contains raw search prompt (original approach)
                if (instruction.includes(searchPrompt)) {
                    iigLog('INFO', `Found img element via raw instruction match`);
                    targetElement = img;
                    break;
                }
            }
        }

        // Alternative: find by src containing markers (when prompt matching fails)
        if (!targetElement) {
            iigLog('INFO', `Prompt matching failed, trying src marker matching...`);
            for (const img of allImgs) {
                const src = img.getAttribute('src') || '';
                if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') {
                    iigLog('INFO', `Found img element with generation marker in src: "${src}"`);
                    targetElement = img;
                    break;
                }
            }
        }

        // Strategy 4: If still not found, try looking at all media nodes
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

        try {
            const generated = await generateImageWithRetry(
                tag.prompt,
                tag.style,
                (status) => { statusEl.textContent = status; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, messageId }
            );

            const { persistedSrc, persistedPosterSrc } = await persistGeneratedMedia(
                generated,
                statusEl,
                { messageId, tagIndex: index, mode: 'generate' }
            );

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
            iigLog('ERROR', `Failed to generate image for tag ${index}:`, error.message);
            const friendly = formatProviderError(error);

            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag, friendly);
            loadingPlaceholder.replaceWith(errorPlaceholder);

            // IMPORTANT: Mark tag as failed in message.mes so it displays after swipe.
            if (tag.isNewFormat) {
                const errorTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`);
                replaceTagInMessageSource(message, tag, errorTag);
            } else {
                const errorMarker = `[IMG:ERROR:${error.message.substring(0, 50)}]`;
                replaceTagInMessageSource(message, tag, errorMarker);
            }
            iigLog('INFO', `Marked tag as failed in message.mes`);

            toastr.error(friendly.message, friendly.title);
        }
    };

    try {
        // Process all tags in parallel
        await Promise.all(tags.map((tag, index) => processTag(tag, index)));
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

export async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const message = context.chat[messageId];

    if (!message) {
        toastr.error(t`Message not found`, t`Image Generation`);
        return;
    }

    const tags = await parseMessageImageTags(message, { forceAll: true });

    if (tags.length === 0) {
        toastr.warning(t`No tags to regenerate`, t`Image Generation`);
        return;
    }

    iigLog('INFO', `Regenerating ${tags.length} images in message ${messageId}`);
    toastr.info(t`Regenerating ${tags.length} images...`, t`Image Generation`);

    processingMessages.add(messageId);

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
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
        iigLog('INFO', `Converted ${convertedLegacyTags} legacy tag(s) to instruction tags before regeneration`);
    }

    for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const tagId = `iig-regen-${messageId}-${index}`;
        applyConfiguredStyleToTag(tag, settings);

        try {
            // Find the existing rendered media element with data-iig-instruction
            const existingMediaList = Array.from(
                mesTextEl.querySelectorAll('img[data-iig-instruction], video[data-iig-instruction]')
            );
            const existingMedia = existingMediaList[index] || existingMediaList[0] || null;
            if (existingMedia) {
                // Preserve the instruction for future regenerations
                const instruction = existingMedia.getAttribute('data-iig-instruction');

                const loadingPlaceholder = createLoadingPlaceholder(tagId);
                existingMedia.replaceWith(loadingPlaceholder);

                const statusEl = loadingPlaceholder.querySelector('.iig-status');

                const generated = await generateImageWithRetry(
                    tag.prompt,
                    tag.style,
                    (status) => { statusEl.textContent = status; },
                    { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, messageId }
                );

                const { persistedSrc, persistedPosterSrc } = await persistGeneratedMedia(
                    generated,
                    statusEl,
                    { messageId, tagIndex: index, mode: 'regenerate' }
                );

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
            }
        } catch (error) {
            iigLog('ERROR', `Regeneration failed for tag ${index}:`, error.message);
            const friendly = formatProviderError(error);
            toastr.error(friendly.message, friendly.title);
        }
    }

    processingMessages.delete(messageId);
    await context.saveChat();
    rerenderMessageHtml(context, message, settings, messageId, mesTextEl);
    iigLog('INFO', `Regeneration complete for message ${messageId}`);
}
