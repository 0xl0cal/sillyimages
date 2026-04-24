/**
 * Парсер тегов генерации изображений и сборка итогового промпта.
 *
 * Теги двух форматов:
 *   NEW:    <img|video data-iig-instruction='{...}' src="...">
 *   LEGACY: [IMG:GEN:{...}]
 *
 * Также здесь:
 *   - работа с `message.mes` / `message.extra.extblocks` / swipe_info
 *   - блок <STYLE:...> и сборка финального промпта с референс-блоком
 *   - сериализация инструкций (для апгрейда legacy → new и для persist)
 */

import {
    getSettings,
    getActiveStyle,
    ensureAdditionalReferencesArray,
    normalizeGroupName,
    iigLog,
} from './settings.js';
import {
    checkFileExists,
    escapeRegex,
    normalizeStoredImagePath,
    sanitizeForHtml,
    sanitizeForSingleQuotedAttribute,
} from './utils.js';

// ----- Shared message-text helpers -----

export function getMessageRenderText(message, settings = getSettings()) {
    if (!message) return '';
    if (settings.externalBlocks && message.extra?.display_text) {
        return message.extra.display_text;
    }
    return message.mes || '';
}

export async function parseMessageImageTags(message, options = {}) {
    const settings = getSettings();
    const tags = [];

    const mainTags = await parseImageTags(message?.mes || '', options);
    tags.push(...mainTags.map(tag => ({ ...tag, sourceKey: 'mes' })));

    if (settings.externalBlocks && message?.extra?.extblocks) {
        const extTags = await parseImageTags(message.extra.extblocks, options);
        tags.push(...extTags.map(tag => ({ ...tag, sourceKey: 'extblocks' })));
    }

    return tags;
}

export function replaceTagInMessageSource(message, tag, replacement) {
    if (!message || !tag) return;

    if (tag.sourceKey === 'extblocks') {
        if (!message.extra) message.extra = {};
        message.extra.extblocks = (message.extra.extblocks || '').replace(tag.fullMatch, replacement);

        const swipeId = message.swipe_id;
        if (swipeId !== undefined && message.swipe_info?.[swipeId]?.extra?.extblocks) {
            message.swipe_info[swipeId].extra.extblocks =
                message.swipe_info[swipeId].extra.extblocks.replace(tag.fullMatch, replacement);
        }

        if (message.extra.display_text) {
            message.extra.display_text = message.extra.display_text.replace(tag.fullMatch, replacement);
        }
        return;
    }

    message.mes = (message.mes || '').replace(tag.fullMatch, replacement);
    if (message.extra?.display_text) {
        message.extra.display_text = message.extra.display_text.replace(tag.fullMatch, replacement);
    }
}

export function extractGeneratedImageUrlsFromText(text) {
    const urls = [];
    const seen = new Set();
    const rawText = String(text || '');

    const legacyMatches = Array.from(rawText.matchAll(/\[IMG:✓:([^\]]+)\]/g));
    for (let i = legacyMatches.length - 1; i >= 0; i--) {
        const src = String(legacyMatches[i][1] || '').trim();
        if (!src || seen.has(src)) continue;
        seen.add(src);
        urls.push(src);
    }

    if (!rawText.includes('<img')) {
        return urls;
    }

    const template = document.createElement('template');
    template.innerHTML = rawText;
    const imageNodes = Array.from(
        template.content.querySelectorAll('img[data-iig-instruction], video[data-iig-instruction]')
    ).reverse();
    for (const node of imageNodes) {
        const src = String(node.getAttribute('src') || '').trim();
        if (
            !src ||
            src.startsWith('data:') ||
            src.includes('[IMG:') ||
            src.includes('[VID:') ||
            src.endsWith('/error.svg') ||
            seen.has(src)
        ) {
            continue;
        }
        seen.add(src);
        urls.push(src);
    }

    return urls;
}

// ----- Trigger-name matching (используется в references.js) -----

export function normalizeReferenceTriggerText(text) {
    return String(text || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

export function promptContainsReferenceName(prompt, name) {
    const normalizedPrompt = normalizeReferenceTriggerText(prompt);
    const normalizedName = normalizeReferenceTriggerText(name);

    if (!normalizedPrompt || !normalizedName) {
        return false;
    }

    const pattern = escapeRegex(normalizedName).replace(/\s+/g, '\\s+');
    try {
        const regex = new RegExp(`(^|[^\\p{L}\\p{N}_])${pattern}(?=$|[^\\p{L}\\p{N}_])`, 'iu');
        return regex.test(normalizedPrompt);
    } catch (_error) {
        return normalizedPrompt.includes(normalizedName);
    }
}

export function parseReferenceAliases(name) {
    return String(name || '')
        .split(',')
        .map((alias) => normalizeReferenceTriggerText(alias))
        .filter(Boolean);
}

/**
 * Проверяет, матчится ли primary-ключ в prompt с учётом regex-режима.
 * В regex-режиме `name` интерпретируется как строка JS-regex: поддерживаются
 * `/pattern/flags` и просто `pattern` (flags по умолчанию — 'iu'). Если regex
 * не парсится — fallback на literal-match.
 */
export function promptMatchesPrimaryKey(prompt, name, useRegex) {
    if (!useRegex) {
        const aliases = parseReferenceAliases(name);
        return aliases.some((alias) => promptContainsReferenceName(prompt, alias));
    }

    const raw = String(name || '').trim();
    if (!raw) return false;

    let pattern = raw;
    let flags = 'iu';
    const slashMatch = raw.match(/^\/(.+)\/([gimsuvy]*)$/);
    if (slashMatch) {
        pattern = slashMatch[1];
        flags = slashMatch[2] || 'iu';
    }

    try {
        const regex = new RegExp(pattern, flags);
        return regex.test(String(prompt || ''));
    } catch (_error) {
        // Broken regex — fallback на literal contains, чтобы юзер хоть как-то
        // видел срабатывание и понял где ошибка.
        return String(prompt || '').toLowerCase().includes(pattern.toLowerCase());
    }
}

/**
 * Secondary keys — comma-separated список, каждый ключ должен встретиться в
 * prompt. Secondary keys ВСЕГДА literal (не regex), чтобы юзеру было проще.
 */
export function promptMatchesAllSecondaryKeys(prompt, secondaryKeysRaw) {
    const keys = String(secondaryKeysRaw || '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
    if (keys.length === 0) return true;
    return keys.every((key) => promptContainsReferenceName(prompt, key));
}

// ----- Style block / prompt assembly -----

const STYLE_BLOCK_RE = /\[\s*style\s*:\s*[^\]]*\]/gi;

export function injectStyleBlock(prompt, styleValue) {
    const normalizedPrompt = String(prompt || '').trim();
    const normalizedStyle = String(styleValue || '').trim();
    if (!normalizedStyle) {
        return normalizedPrompt;
    }

    const styleBlock = `[STYLE: ${normalizedStyle}]`;
    if (!normalizedPrompt) {
        return styleBlock;
    }

    STYLE_BLOCK_RE.lastIndex = 0;
    if (STYLE_BLOCK_RE.test(normalizedPrompt)) {
        STYLE_BLOCK_RE.lastIndex = 0;
        let replacedFirst = false;
        return normalizedPrompt.replace(STYLE_BLOCK_RE, () => {
            if (replacedFirst) {
                return '';
            }
            replacedFirst = true;
            return styleBlock;
        }).trim();
    }

    return `${styleBlock}\n\n${normalizedPrompt}`.trim();
}

export function resolveEffectiveStyle(tagStyle = '', settings = getSettings()) {
    const activeStyle = getActiveStyle(settings);
    const extensionStyleValue = String(activeStyle?.value || '').trim();
    const originalStyle = String(tagStyle || '').trim();
    return extensionStyleValue || originalStyle;
}

export function buildAdditionalReferencesPromptBlock(matchedRefs = []) {
    const items = matchedRefs
        .map((ref) => String(ref?.description || ref?.name || '').trim())
        .filter(Boolean);

    if (items.length === 0) {
        return '';
    }

    return `Additional References:\n${items.map((item) => `- ${item}`).join('\n')}`;
}

export function buildFinalGenerationPrompt(prompt, style, matchedAdditionalRefs = [], settings = getSettings()) {
    const effectiveStyle = resolveEffectiveStyle(style, settings);
    let fullPrompt = injectStyleBlock(prompt, effectiveStyle);

    const additionalReferencesBlock = buildAdditionalReferencesPromptBlock(matchedAdditionalRefs);
    if (additionalReferencesBlock) {
        fullPrompt = `${fullPrompt}\n\n${additionalReferencesBlock}`.trim();
    }

    return fullPrompt;
}

export function getMatchedAdditionalReferences(prompt) {
    const refs = ensureAdditionalReferencesArray()
        .map((ref) => ({
            id: String(ref?.id || '').trim(),
            name: String(ref?.name || '').trim(),
            description: String(ref?.description || '').trim(),
            imagePath: normalizeStoredImagePath(ref?.imagePath || ''),
            matchMode: ref?.matchMode === 'always' ? 'always' : 'match',
            enabled: ref?.enabled !== false,
            group: normalizeGroupName(ref?.group),
            priority: Number.isFinite(ref?.priority) ? ref.priority : 0,
            useRegex: ref?.useRegex === true,
            secondaryKeys: String(ref?.secondaryKeys || ''),
        }))
        .filter((ref) => ref.enabled && ref.name && ref.imagePath);

    const matched = [];
    const seenKeys = new Set();

    for (const ref of refs) {
        let isMatched = ref.matchMode === 'always';
        if (!isMatched) {
            isMatched = promptMatchesPrimaryKey(prompt, ref.name, ref.useRegex);
        }
        if (!isMatched) continue;

        // Secondary keys — AND-фильтр (все ключи должны встретиться). Для
        // режима 'always' тоже применяем — позволяет делать условно-always
        // записи вида «отправляй всегда, но только если в промпте есть X».
        if (!promptMatchesAllSecondaryKeys(prompt, ref.secondaryKeys)) {
            continue;
        }

        const dedupeKey = `${ref.name}::${ref.imagePath}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        matched.push(ref);
    }

    // Сортировка по priority (desc). При равном priority — сохраняем порядок
    // из исходного массива (stable sort в современных движках).
    matched.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    return matched;
}

export function applyConfiguredStyleToTag(tag, settings = getSettings()) {
    if (!tag) {
        return tag;
    }

    const effectiveStyle = resolveEffectiveStyle(tag.style, settings);
    tag.style = effectiveStyle;
    return tag;
}

// ----- Instruction payload parsing -----

const INSTRUCTION_FIELD_NAMES = Object.freeze([
    'style',
    'prompt',
    'aspect_ratio',
    'aspectRatio',
    'preset',
    'image_size',
    'imageSize',
    'quality',
]);

export function normalizeInstructionPayload(text) {
    return String(text || '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#34;/g, '"')
        .replace(/&amp;/g, '&');
}

function decodeRelaxedInstructionValue(value) {
    return String(value || '')
        .trim()
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
}

function parseRelaxedInstructionObject(payload) {
    const normalized = normalizeInstructionPayload(payload);
    const keyRegex = /(["'])(style|prompt|aspect_ratio|aspectRatio|preset|image_size|imageSize|quality)\1\s*:\s*(["'])/g;
    const matches = Array.from(normalized.matchAll(keyRegex));
    if (matches.length === 0) {
        return null;
    }

    const result = {};

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const key = match[2];
        const valueQuote = match[3];
        const valueStart = match.index + match[0].length;
        const nextKeyIndex = i + 1 < matches.length ? matches[i + 1].index : normalized.lastIndexOf('}');
        const rawValue = normalized.substring(
            valueStart,
            nextKeyIndex === -1 ? normalized.length : nextKeyIndex
        );

        let value = rawValue.trim();
        if (value.endsWith(',')) {
            value = value.slice(0, -1).trimEnd();
        }
        if (value.endsWith(valueQuote)) {
            value = value.slice(0, -1);
        }

        result[key] = decodeRelaxedInstructionValue(value);
    }

    return Object.keys(result).length > 0 ? result : null;
}

export function parseInstructionObject(payload) {
    const normalized = normalizeInstructionPayload(payload);

    try {
        return JSON.parse(normalized);
    } catch (error) {
        const relaxed = parseRelaxedInstructionObject(normalized);
        if (relaxed) {
            return relaxed;
        }
        throw error;
    }
}

// ----- Instruction → HTML serializer (для upgrade и persist) -----

export function buildInstructionData(tag) {
    const data = {};

    if (tag.style) data.style = tag.style;
    if (tag.prompt) data.prompt = tag.prompt;
    if (tag.aspectRatio) data.aspect_ratio = tag.aspectRatio;
    if (tag.preset) data.preset = tag.preset;
    if (tag.imageSize) data.image_size = tag.imageSize;
    if (tag.quality) data.quality = tag.quality;

    return data;
}

export function getInstructionAttributeValue(tag) {
    if (tag.isNewFormat && tag.fullMatch) {
        const instructionMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instructionMatch) {
            return instructionMatch[2];
        }
    }

    return JSON.stringify(buildInstructionData(tag));
}

export function isGeneratedVideoResult(value) {
    return Boolean(value) && typeof value === 'object' && value.kind === 'video' && typeof value.dataUrl === 'string';
}

export function createGeneratedMediaElement(result, tag) {
    if (isGeneratedVideoResult(result)) {
        const video = document.createElement('video');
        video.className = 'iig-generated-video';
        video.src = result.dataUrl;
        video.controls = true;
        video.autoplay = true;
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        video.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
        if (result.posterDataUrl) {
            video.poster = result.posterDataUrl;
        }
        return video;
    }

    const img = document.createElement('img');
    img.className = 'iig-generated-image';
    img.src = result;
    img.alt = tag.prompt;
    img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
    return img;
}

export function buildPersistedVideoTag(templateHtml, persistedSrc, posterSrc = '') {
    let html = String(templateHtml || '').trim()
        .replace(/^<(?:img|video)\b/i, '<video controls autoplay loop muted playsinline')
        .replace(/<\/video>\s*$/i, '')
        .replace(/\/?>\s*$/i, '')
        .replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${persistedSrc}"`);
    html = html.replace(/\s+poster\s*=\s*(['"])[\s\S]*?\1/i, '');
    if (posterSrc) {
        html = html.replace(/^<video\b/i, `<video poster="${sanitizeForHtml(posterSrc)}"`);
    }
    return `${html}></video>`;
}

export function buildPendingLegacyTag(tag) {
    const instruction = sanitizeForSingleQuotedAttribute(getInstructionAttributeValue(tag));
    return `<img data-iig-instruction='${instruction}' src="[IMG:GEN]">`;
}

export function buildPersistedImageTag(tag, persistedSrc) {
    const templateHtml = tag?.isNewFormat ? tag.fullMatch : buildPendingLegacyTag(tag);
    return String(templateHtml || '').replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${persistedSrc}"`);
}

export function buildPersistedMediaTag(tag, generated, persistedSrc, posterSrc = '') {
    return isGeneratedVideoResult(generated)
        ? buildPersistedVideoTag(tag?.fullMatch, persistedSrc, posterSrc)
        : buildPersistedImageTag(tag, persistedSrc);
}

export function convertLegacyTagsToInstructionFormat(message, tags) {
    let convertedLegacyTags = 0;

    for (const tag of tags) {
        if (tag.isNewFormat) {
            continue;
        }

        const pendingTag = buildPendingLegacyTag(tag);
        replaceTagInMessageSource(message, tag, pendingTag);
        tag.fullMatch = pendingTag;
        tag.isNewFormat = true;
        convertedLegacyTags += 1;
    }

    return convertedLegacyTags;
}

export function rerenderMessageHtml(context, message, settings, messageId, mesTextEl) {
    if (!mesTextEl) {
        return;
    }

    const formattedMessage = typeof context.messageFormatting === 'function'
        ? context.messageFormatting(
            getMessageRenderText(message, settings),
            message.name,
            message.is_system,
            message.is_user,
            messageId
        )
        : getMessageRenderText(message, settings);

    mesTextEl.innerHTML = formattedMessage;
}

// ----- Core tag parser -----

/**
 * Parse image generation tags from message text.
 * Supports two formats:
 *   NEW:    <img|video data-iig-instruction='{"style":"...","prompt":"..."}' src="...">
 *   LEGACY: [IMG:GEN:{"style":"...","prompt":"..."}]
 *
 * @param {string} text - Message text
 * @param {object} options
 * @param {boolean} [options.checkExistence=false] - Проверять существование файлов по указанному `src` (детект галлюцинаций LLM).
 * @param {boolean} [options.forceAll=false] - Включать все теги с инструкциями даже если src выглядит валидным (режим regenerate).
 */
export async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];

    // === NEW FORMAT: <img|video data-iig-instruction="{...}" src="..."> ===
    // LLM часто генерирует ломаный HTML с неэкранированными кавычками — парсим вручную.
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;

    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;

        // Find the start of the media tag.
        const imgStart = text.lastIndexOf('<img', markerPos);
        const videoStart = text.lastIndexOf('<video', markerPos);
        const mediaStart = Math.max(imgStart, videoStart);
        const isVideoTag = mediaStart === videoStart && videoStart !== -1;
        const tagName = isVideoTag ? 'video' : 'img';
        if (mediaStart === -1 || markerPos - mediaStart > 800) {
            searchPos = markerPos + 1;
            continue;
        }

        // Find the JSON start (first { after the marker)
        const afterMarker = markerPos + imgTagMarker.length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) {
            searchPos = markerPos + 1;
            continue;
        }

        // Find matching closing brace using brace counting
        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;

        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];

            if (escapeNext) {
                escapeNext = false;
                continue;
            }

            if (char === '\\' && inString) {
                escapeNext = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }

        if (jsonEnd === -1) {
            searchPos = markerPos + 1;
            continue;
        }

        // Find the end of the media tag.
        let mediaEnd = -1;
        if (isVideoTag) {
            mediaEnd = text.indexOf('</video>', jsonEnd);
            if (mediaEnd !== -1) {
                mediaEnd += '</video>'.length;
            }
        } else {
            mediaEnd = text.indexOf('>', jsonEnd);
            if (mediaEnd !== -1) {
                mediaEnd += 1;
            }
        }
        if (mediaEnd === -1) {
            searchPos = markerPos + 1;
            continue;
        }

        const fullImgTag = text.substring(mediaStart, mediaEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);

        // Check if src needs generation
        const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
        const srcValue = srcMatch ? srcMatch[1] : '';

        // Determine if this needs generation
        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg'); // Our error placeholder - NO auto-retry
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;

        // Skip error images - user must click to retry manually (prevents conflict on swipe)
        if (hasErrorImage && !forceAll) {
            iigLog('INFO', `Skipping error image (click to retry): ${srcValue.substring(0, 50)}`);
            searchPos = mediaEnd;
            continue;
        }

        if (forceAll) {
            // Regeneration mode: include all tags with instruction (user-triggered)
            needsGeneration = true;
            iigLog('INFO', `Force regeneration mode: including ${srcValue.substring(0, 30)}`);
        } else if (hasMarker || !srcValue) {
            // Explicit marker or empty src = needs generation
            needsGeneration = true;
        } else if (hasPath && checkExistence) {
            // Has a path - check if file actually exists
            const exists = await checkFileExists(srcValue);
            if (!exists) {
                // File doesn't exist = LLM hallucinated the path
                iigLog('WARN', `File does not exist (LLM hallucination?): ${srcValue}`);
                needsGeneration = true;
            } else {
                iigLog('INFO', `Skipping existing image: ${srcValue.substring(0, 50)}`);
            }
        } else if (hasPath) {
            // Has path but not checking existence - skip
            iigLog('INFO', `Skipping path (no existence check): ${srcValue.substring(0, 50)}`);
            searchPos = mediaEnd;
            continue;
        }

        if (!needsGeneration) {
            searchPos = mediaEnd;
            continue;
        }

        try {
            const data = parseInstructionObject(instructionJson);

            tags.push({
                fullMatch: fullImgTag,
                index: mediaStart,
                style: data.style || '',
                prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: true,
                mediaTagName: tagName,
                existingSrc: hasPath ? srcValue : null, // Store existing src for logging
            });

            iigLog('INFO', `Found NEW format tag: ${data.prompt?.substring(0, 50)}`);
        } catch (e) {
            iigLog('WARN', `Failed to parse instruction JSON: ${instructionJson.substring(0, 100)}`, e.message);
        }

        searchPos = mediaEnd;
    }

    // === LEGACY FORMAT: [IMG:GEN:{...}] ===
    const marker = '[IMG:GEN:';
    let searchStart = 0;

    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;

        const jsonStart = markerIndex + marker.length;

        // Find the matching closing brace for JSON
        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;

        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];

            if (escapeNext) {
                escapeNext = false;
                continue;
            }

            if (char === '\\' && inString) {
                escapeNext = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }

        if (jsonEnd === -1) {
            searchStart = jsonStart;
            continue;
        }

        const jsonStr = text.substring(jsonStart, jsonEnd);

        const afterJson = text.substring(jsonEnd);
        if (!afterJson.startsWith(']')) {
            searchStart = jsonEnd;
            continue;
        }

        const tagOnly = text.substring(markerIndex, jsonEnd + 1);

        try {
            const data = parseInstructionObject(jsonStr);

            tags.push({
                fullMatch: tagOnly,
                index: markerIndex,
                style: data.style || '',
                prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                preset: data.preset || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: false,
            });

            iigLog('INFO', `Found LEGACY format tag: ${data.prompt?.substring(0, 50)}`);
        } catch (e) {
            iigLog('WARN', `Failed to parse legacy tag JSON: ${jsonStr.substring(0, 100)}`, e.message);
        }

        searchStart = jsonEnd + 1;
    }

    return tags;
}
