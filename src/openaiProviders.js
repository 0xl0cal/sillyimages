/** OpenAI-compatible image edits, xAI JSON edits and Electron Hub catalogs. */
import {
    getSettings, iigLog, ENDPOINT_PLACEHOLDERS, MAX_GENERATION_REFERENCE_IMAGES, getEffectiveEndpoint,
    getEffectiveRefInstruction,
} from './settings.js';
import { base64ToBlob, fetchWithTimeout, ProviderError, isRetryableHttpStatus } from './utils.js';
import { buildFinalGenerationPrompt } from './parser.js';
import { t } from './i18n.js';
import { Provider, buildGenerationUrl, throwAsProviderError } from './providerBase.js';
import {
    isImageModel, classifyOpenAIModel, isGptImageFamily, getOpenAIModelMaxReferences, aspectRatioToSize,
    normalizeQualityForModel,
} from './modelCapabilities.js';
import { getReferenceImage, buildAvatarReferencePromptBlock } from './references.js';
import { appendPromptBlock, collectProviderReferences } from './providerReferences.js';
import { parseOpenAIError, extractImageFromResult } from './imageResponse.js';

const OPENAI_REQUEST_TIMEOUT_MS = 600_000;

export class OpenAIProvider extends Provider {
    get id() { return 'openai'; }
    get displayName() { return 'OpenAI'; }

    supportsReferences(settings) {
        // Референсы работают только там, где есть `/v1/images/edits`
        // с multi-image входом: семейство gpt-image-* и flux-1-kontext-*.
        // dall-e-2 формально умеет /edits с одним image, но мы не делаем
        // под него исключение — UI проще.
        const kind = classifyOpenAIModel(settings.model);
        return isGptImageFamily(kind) || kind === 'flux-kontext';
    }

    async collectReferences(ctx) {
        const modelKind = classifyOpenAIModel((ctx.settings || getSettings()).model);
        // Flux Kontext принимает только 1 reference; gpt-image-* — до MAX.
        const maxRefs = getOpenAIModelMaxReferences(modelKind) || MAX_GENERATION_REFERENCE_IMAGES;
        return collectProviderReferences(ctx, maxRefs, 'base64');
    }

    async generate({ prompt, style, references = [], options = {}, settings = getSettings() }) {
        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);
        fullPrompt = appendPromptBlock(fullPrompt, buildAvatarReferencePromptBlock(references, settings));

        // Префикс refInstruction — только когда реально уходит хотя бы один
        // ref в /v1/images/edits. Без рефов /generations не нуждается в нём.
        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) {
                fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
            }
        }

        const modelKind = classifyOpenAIModel(settings.model);
        const requestedSize = options.aspectRatio
            ? (aspectRatioToSize(options.aspectRatio, modelKind) || settings.size)
            : settings.size;
        const quality = normalizeQualityForModel(options.quality || settings.quality, modelKind);

        iigLog(
            'INFO',
            `OpenAI generate: model=${settings.model} kind=${modelKind} refs=${references.length} size=${requestedSize} quality=${quality} raw=${!!settings.rawEndpoint}`
        );

        const signal = options.signal || null;

        // Роутинг: есть референсы → /v1/images/edits (multipart),
        // иначе → /v1/images/generations (JSON). В raw-режиме оба пути шлются
        // на один URL (settings.endpoint целиком) — юзер сам отвечает за
        // корректность настройки.
        if (references.length > 0) {
            return await this._generateWithEdits({
                url: buildGenerationUrl(settings, '/v1/images/edits'),
                apiKey: settings.apiKey,
                model: settings.model,
                modelKind,
                prompt: fullPrompt,
                size: requestedSize,
                quality,
                references,
                signal,
            });
        }

        return await this._generateWithGenerations({
            url: buildGenerationUrl(settings, '/v1/images/generations'),
            apiKey: settings.apiKey,
            model: settings.model,
            modelKind,
            prompt: fullPrompt,
            size: requestedSize,
            quality,
            signal,
        });
    }

    async _generateWithGenerations({ url, apiKey, model, modelKind, prompt, size, quality, signal = null }) {

        const body = {
            model,
            prompt,
            n: 1,
        };
        if (size) body.size = size;
        if (quality) body.quality = quality;

        // response_format=b64_json поддерживается dall-e-*. Для gpt-image-* OpenAI
        // возвращает b64 всегда, параметр игнорируется/отклоняется — не отправляем
        // его для семейства gpt-image-*, чтобы не словить 400 на строгих прокси.
        if (!isGptImageFamily(modelKind)) {
            body.response_format = 'b64_json';
        }

        // moderation: 'low' поддерживает gpt-image-1 family. dall-e-* не знает
        // этот параметр — строгие прокси отдают 400.
        if (isGptImageFamily(modelKind)) {
            body.moderation = 'low';
        }

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }, OPENAI_REQUEST_TIMEOUT_MS, signal);
        } catch (error) {
            throwAsProviderError(error, `OpenAI /v1/images/generations (${url})`, 'openai', signal);
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenAIError(response);
            throw new ProviderError({
                message: `OpenAI /generations ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'openai',
            });
        }

        const result = await response.json();
        return extractImageFromResult(result);
    }

    async _generateWithEdits({ url, apiKey, model, modelKind, prompt, size, quality, references, signal = null }) {
        const form = new FormData();

        form.append('model', model);
        form.append('prompt', prompt);
        form.append('n', '1');
        if (size) form.append('size', size);
        if (quality) form.append('quality', quality);
        // moderation поддерживает только gpt-image-1 family (см. _generateWithGenerations).
        if (isGptImageFamily(modelKind)) form.append('moderation', 'low');

        // GPT Image family: поле `image[]` для множественных референсов
        // (OpenAI gpt-image-1 / 1.5 / 2 поддерживает multi-image edit).
        // Остальные (dall-e-2, unknown): одиночный `image`.
        if (isGptImageFamily(modelKind) && references.length > 1) {
            references.forEach((ref, idx) => {
                const blob = base64ToBlob(getReferenceImage(ref), 'image/png');
                // OpenAI принимает повторный `image[]` как массив.
                form.append('image[]', blob, `reference-${idx}.png`);
            });
        } else {
            const blob = base64ToBlob(getReferenceImage(references[0]), 'image/png');
            form.append('image', blob, 'reference-0.png');
        }

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    // Content-Type с boundary FormData проставит сам.
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: form,
            }, OPENAI_REQUEST_TIMEOUT_MS, signal);
        } catch (error) {
            throwAsProviderError(error, `OpenAI /v1/images/edits (${url})`, 'openai', signal);
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenAIError(response);
            throw new ProviderError({
                message: `OpenAI /edits ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'openai',
            });
        }

        const result = await response.json();
        return extractImageFromResult(result);
    }
}

// ----- xAI Imagine -----

const XAI_MAX_REFERENCE_IMAGES = 3;
const XAI_ASPECT_RATIOS = new Set([
    'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
    '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20',
]);

function normalizeXAIAspectRatio(value) {
    const normalized = String(value || '').trim();
    return XAI_ASPECT_RATIOS.has(normalized) ? normalized : '1:1';
}

function normalizeXAIResolution(value) {
    return String(value || '').trim().toLowerCase() === '2k' ? '2k' : '1k';
}

function normalizeXAIQuality(value) {
    return String(value || '').trim().toLowerCase() === 'low' ? 'low' : 'medium';
}

function makeXAIImageInput(reference) {
    const source = getReferenceImage(reference);
    const url = source.startsWith('data:') ? source : `data:image/png;base64,${source}`;
    return { type: 'image_url', url };
}

export class XAIProvider extends Provider {
    get id() { return 'xai'; }
    get displayName() { return 'xAI'; }

    get capabilities() {
        return {
            endpointPlaceholder: ENDPOINT_PLACEHOLDERS.xai,
            requiresApiKey: true,
            referencesMaxCount: XAI_MAX_REFERENCE_IMAGES,
            referencesFormat: 'dataUrl',
        };
    }

    supportsReferences(settings) {
        return String(settings.model || '').toLowerCase().includes('grok-imagine-image');
    }

    async collectReferences(ctx) {
        return collectProviderReferences(
            ctx,
            XAI_MAX_REFERENCE_IMAGES,
            'dataUrl',
        );
    }

    async generate({ prompt, style, references = [], options = {}, settings = getSettings() }) {
        let fullPrompt = buildFinalGenerationPrompt(prompt, style, options.matchedAdditionalRefs || [], settings);
        fullPrompt = appendPromptBlock(fullPrompt, buildAvatarReferencePromptBlock(references, settings));

        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
        }

        const body = {
            model: settings.model,
            prompt: fullPrompt,
            n: 1,
            response_format: 'b64_json',
            aspect_ratio: normalizeXAIAspectRatio(options.aspectRatio || settings.xaiAspectRatio),
            resolution: normalizeXAIResolution(options.imageSize || settings.xaiResolution),
        };
        if (String(settings.model || '').toLowerCase().includes('grok-imagine-image-2.0')) {
            body.quality = normalizeXAIQuality(options.quality || settings.xaiQuality);
        }

        if (references.length === 1) {
            body.image = makeXAIImageInput(references[0]);
        } else if (references.length > 1) {
            body.images = references.slice(0, XAI_MAX_REFERENCE_IMAGES).map(makeXAIImageInput);
        }

        const path = references.length > 0 ? '/v1/images/edits' : '/v1/images/generations';
        const url = buildGenerationUrl(settings, path);
        const signal = options.signal || null;
        iigLog('INFO', `xAI generate: model=${settings.model} refs=${references.length} aspect=${body.aspect_ratio} resolution=${body.resolution} quality=${body.quality}`);

        let response;
        try {
            response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }, OPENAI_REQUEST_TIMEOUT_MS, signal);
        } catch (error) {
            throwAsProviderError(error, `xAI ${path} (${url})`, 'xai', signal);
        }

        if (!response.ok) {
            const { message, code, status } = await parseOpenAIError(response);
            throw new ProviderError({
                message: `xAI ${path} ${status} ${code}: ${message}`,
                code,
                status,
                retryable: isRetryableHttpStatus(status),
                providerId: 'xai',
            });
        }

        return extractImageFromResult(await response.json(), 'image/jpeg');
    }
}

// ----- Electron Hub (OpenAI-совместимый агрегатор, flux-1-kontext-*) -----

const ELECTRONHUB_DEFAULT_ENDPOINT = 'https://api.electronhub.ai';

/**
 * Electron Hub — OpenAI-совместимый прокси с 200+ моделями. Отличия:
 *   - `/v1/images/edits` принимает только один `image` (без `image[]`),
 *     так что flux-1-kontext-* маршрутизируется через /edits с 1 референсом;
 *   - `/v1/models` возвращает модели со всеми типами (chat/image/embeddings),
 *     у image-моделей в поле `endpoints` есть `/v1/images/generations`
 *     и/или `/v1/images/edits` — фильтруем именно по ним.
 *
 * Всё остальное наследуется от OpenAIProvider (classifier / aspect / quality
 * / _generateWithEdits / _generateWithGenerations / error parsing).
 */
export class ElectronHubProvider extends OpenAIProvider {
    get id() { return 'electronhub'; }
    get displayName() { return 'Electron Hub'; }

    /**
     * Валидация: endpoint опционален (есть дефолт в normalizeConfiguredEndpoint),
     * apiKey обязателен.
     */
    validate(settings) {
        const errors = [];
        if (!settings.apiKey) {
            errors.push(t`API key is not configured`);
        }
        return errors;
    }

    /**
     * Список image-моделей через фильтр по полю `endpoints`. Если поле
     * отсутствует в ответе — фолбэк на keyword-based isImageModel.
     */
    async fetchModels() {
        const settings = getSettings();
        const endpoint = (getEffectiveEndpoint(settings) || ELECTRONHUB_DEFAULT_ENDPOINT).replace(/\/$/, '');

        if (!settings.apiKey) {
            console.warn('[IIG] Electron Hub fetchModels: API key not set');
            return [];
        }

        const url = `${endpoint}/v1/models`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const models = Array.isArray(data?.data) ? data.data : [];

        return models.filter((m) => {
            const eps = Array.isArray(m?.endpoints) ? m.endpoints.map(String) : null;
            if (eps && eps.length > 0) {
                return eps.some((e) =>
                    e.includes('/images/generations') || e.includes('/images/edits'),
                );
            }
            return isImageModel(m.id);
        }).map((m) => m.id).filter(Boolean);
    }
}
