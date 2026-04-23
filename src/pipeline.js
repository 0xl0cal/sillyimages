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
} from './settings.js';
import {
    saveImageToFile,
    saveNaisteraMediaToFile,
    ERROR_IMAGE_PATH,
    parseImageDataUrl,
} from './utils.js';
import {
    applyConfiguredStyleToTag,
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
        <div class="iig-status">Генерация картинки...</div>
    `;
    return placeholder;
}

export function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = `Ошибка: ${errorMessage}`;
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
        if (statusEl) statusEl.textContent = 'Сохранение видео...';
        persistedSrc = await saveNaisteraMediaToFile(generated.dataUrl, 'video', {
            messageId,
            tagIndex,
            mode: `${mode}-video`,
            apiType,
        });
        if (generated.posterDataUrl) {
            if (statusEl) statusEl.textContent = 'Сохранение превью...';
            persistedPosterSrc = await saveImageToFile(generated.posterDataUrl, {
                messageId,
                tagIndex,
                mode: `${mode}-video-poster`,
                apiType,
            });
        }
    } else {
        if (statusEl) statusEl.textContent = 'Сохранение...';
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
        throw new Error(`Неизвестный API: ${settings.apiType}`);
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

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${maxRetries})` : ''}...`);

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

            const isRetryable = error.message?.includes('429') ||
                               error.message?.includes('503') ||
                               error.message?.includes('502') ||
                               error.message?.includes('504') ||
                               error.message?.includes('timeout') ||
                               error.message?.includes('network');

            if (!isRetryable || attempt === maxRetries) {
                break;
            }

            const delay = baseDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
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
    toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });

    // DOM is ready because we use CHARACTER_MESSAGE_RENDERED event
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        console.error('[IIG] Message element not found for ID:', messageId);
        toastr.error('Не удалось найти элемент сообщения', 'Генерация картинок');
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
            toastr.success(
                `${isGeneratedVideoResult(generated) ? 'Видео' : 'Картинка'} ${index + 1}/${tags.length} готов${isGeneratedVideoResult(generated) ? 'о' : 'а'}`,
                'Генерация картинок',
                { timeOut: 2000 }
            );
        } catch (error) {
            iigLog('ERROR', `Failed to generate image for tag ${index}:`, error.message);

            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
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

            toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
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
        toastr.error('Сообщение не найдено', 'Генерация картинок');
        return;
    }

    const tags = await parseMessageImageTags(message, { forceAll: true });

    if (tags.length === 0) {
        toastr.warning('Нет тегов для перегенерации', 'Генерация картинок');
        return;
    }

    iigLog('INFO', `Regenerating ${tags.length} images in message ${messageId}`);
    toastr.info(`Перегенерация ${tags.length} картинок...`, 'Генерация картинок');

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

                toastr.success(
                    `${isGeneratedVideoResult(generated) ? 'Видео' : 'Картинка'} ${index + 1}/${tags.length} готов${isGeneratedVideoResult(generated) ? 'о' : 'а'}`,
                    'Генерация картинок',
                    { timeOut: 2000 }
                );
            }
        } catch (error) {
            iigLog('ERROR', `Regeneration failed for tag ${index}:`, error.message);
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
        }
    }

    processingMessages.delete(messageId);
    await context.saveChat();
    rerenderMessageHtml(context, message, settings, messageId, mesTextEl);
    iigLog('INFO', `Regeneration complete for message ${messageId}`);
}
