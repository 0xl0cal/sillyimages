/** Naistera model catalog, generation parameters and job polling. */
import {
    getSettings, iigLog, normalizeNaisteraModel, isNaisteraNovelAIModel,
    normalizeNaisteraCharacterDescriptionsMode, normalizeNaisteraVideoFrequency, getEffectiveEndpoint,
    getEffectiveRefInstruction, getEffectiveNegativePrompt,
} from './settings.js';
import { abortableDelay, ProviderError, isRetryableHttpStatus } from './utils.js';
import { buildFinalGenerationPrompt } from './parser.js';
import { t } from './i18n.js';
import { Provider } from './providerBase.js';
import {
    makeReferenceObject, getReferenceImage, getReferenceDescription, getReferenceSource,
    buildCharacterDescriptionPromptBlock,
} from './references.js';
import { appendPromptBlock, collectProviderReferences } from './providerReferences.js';

// ----- Naistera (custom / grok / nano banana 2 / novelai proxy) -----

export class NaisteraProvider extends Provider {
    constructor() {
        super();
        this.modelCatalog = new Map();
        this.modelCatalogStatus = { authenticated: false, tier: null, publicFallback: false };
    }

    get id() { return 'naistera'; }
    get displayName() { return 'Naistera'; }

    createRequest(settings) {
        const provider = Object.assign(new NaisteraProvider(), this);
        const sameConnection = !this.catalogConnection || this.catalogConnection.endpoint === getEffectiveEndpoint(settings)
            && this.catalogConnection.apiKey === settings.apiKey;
        provider.modelCatalog = new Map(sameConnection ? structuredClone([...this.modelCatalog]) : []);
        provider.requestScoped = true;
        return provider;
    }

    get capabilities() {
        return {
            ...super.capabilities,
            referencesFormat: 'dataUrl',
        };
    }

    validate(settings) {
        const errors = [];
        if (!settings.apiKey) {
            errors.push(t`API key is not configured`);
        }
        const m = normalizeNaisteraModel(settings.naisteraModel);
        if (!m) {
            errors.push(t`Model is not selected`);
        }
        return errors;
    }

    supportsReferences(settings) {
        if (isNaisteraNovelAIModel(settings.naisteraModel)) return false;
        const model = this.modelCatalog.get(normalizeNaisteraModel(settings.naisteraModel));
        return model ? model.references !== false : true;
    }

    supportsNegativePrompt(settings) {
        const model = this.modelCatalog.get(normalizeNaisteraModel(settings.naisteraModel));
        return model?.negativePrompt === true;
    }

    getGenerationParameters(settings) {
        if (!isNaisteraNovelAIModel(settings.naisteraModel)) return null;
        return this.modelCatalog.get(normalizeNaisteraModel(settings.naisteraModel))?.parameters || null;
    }

    getGenerationSettings(settings, options = {}) {
        const rules = this.getGenerationParameters(settings);
        if (!rules) return {};
        const numeric = (key, saved) => {
            const rule = rules[key];
            const raw = options[key] ?? saved;
            const value = raw === null || raw === '' || raw === undefined ? rule.default : Number(raw);
            return Math.min(rule.max, Math.max(rule.min, Number.isFinite(value) ? value : rule.default));
        };
        const requestedSampler = options.sampler ?? settings.naisteraSampler;
        const result = {
            steps: Math.round(numeric('steps', settings.naisteraSteps)),
            sampler: rules.sampler.choices.includes(requestedSampler) ? requestedSampler : rules.sampler.default,
            scale: numeric('scale', settings.naisteraCfgScale),
        };
        if (rules.cfg_rescale) result.cfg_rescale = numeric('cfg_rescale', settings.naisteraCfgRescale);
        return result;
    }

    getModelLabel(modelId) {
        return this.modelCatalog.get(String(modelId || ''))?.name || super.getModelLabel(modelId);
    }

    getModelCatalogStatus() {
        return { ...this.modelCatalogStatus };
    }

    async fetchModels(config = getSettings()) {
        const settings = { ...config };
        const requestId = this.catalogRequestId = (this.catalogRequestId || 0) + 1;
        const endpoint = getEffectiveEndpoint(settings).replace(/\/$/, '');
        const url = `${endpoint}/api/models`;
        const request = async (authenticated) => {
            const headers = { 'Accept': 'application/json' };
            if (authenticated && settings.apiKey) {
                headers.Authorization = `Bearer ${settings.apiKey}`;
            }
            return await fetch(url, { method: 'GET', headers });
        };

        let response;
        let publicFallback = false;
        try {
            response = await request(true);
        } catch (error) {
            if (!settings.apiKey || error?.name !== 'TypeError') throw error;
            iigLog('WARN', 'Naistera authenticated model discovery was blocked; retrying the public catalog');
            publicFallback = true;
            response = await request(false);
        }

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Naistera /api/models ${response.status}: ${String(detail).slice(0, 500)}`);
        }

        const payload = await response.json();
        const models = (Array.isArray(payload?.models) ? payload.models : [])
            .filter((model) => model?.id && model.visible !== false && model.deprecated !== true)
            .map((model) => ({
                id: String(model.id),
                name: String(model.name || model.id),
                references: model.references !== false,
                negativePrompt: model.negative_prompt === true,
                parameters: model.parameters || null,
            }));

        const current = getSettings();
        if (requestId !== this.catalogRequestId || (!this.requestScoped
            && (current.apiKey !== settings.apiKey || getEffectiveEndpoint(current).replace(/\/$/, '') !== endpoint))) {
            return models.map(model => model.id);
        }
        this.modelCatalog = new Map(models.map((model) => [model.id, model]));
        this.catalogConnection = { endpoint, apiKey: settings.apiKey };
        this.modelCatalogStatus = {
            authenticated: payload?.authenticated === true,
            tier: payload?.tier || null,
            publicFallback,
        };
        iigLog('INFO', `Naistera models loaded: ${models.length}; authenticated=${payload?.authenticated === true}; tier=${payload?.tier || 'public'}`);
        return models.map((model) => model.id);
    }

    async pollJob(endpoint, jobId, settings, signal = null) {
        const base = endpoint.replace(/\/api\/generate\/?$/i, '').replace(/\/$/, '');
        const url = `${base}/api/generate/jobs/${encodeURIComponent(jobId)}`;
        const intervalMs = Math.max(1000, Math.min(30000, Number(settings.naisteraPollIntervalMs) || 3000));
        const timeoutMs = Math.max(30000, Math.min(900000, Number(settings.naisteraPollTimeoutMs) || 600000));
        const started = Date.now();
        const abortedByUser = () => signal?.aborted
            && (signal.reason === 'user-cancel' || signal.reason?.message === 'user-cancel');
        const throwAborted = () => {
            throw new ProviderError({
                message: t`Generation stopped by user`,
                code: 'aborted',
                retryable: false,
                providerId: 'naistera',
            });
        };
        while (Date.now() - started < timeoutMs) {
            if (abortedByUser()) throwAborted();
            let response;
            try {
                response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${settings.apiKey}`,
                        'Accept': 'application/json',
                    },
                    signal,
                });
            } catch (error) {
                if (error?.name === 'AbortError' && abortedByUser()) throwAborted();
                throw error;
            }
            const text = await response.text().catch(() => '');
            let result = null;
            try {
                result = text ? JSON.parse(text) : null;
            } catch (_err) {
                result = null;
            }
            if (!response.ok) {
                throw new ProviderError({
                    message: `Polling API Error (${response.status}): ${String(text).slice(0, 800)}`,
                    code: String(response.status),
                    status: response.status,
                    retryable: isRetryableHttpStatus(response.status),
                    providerId: 'naistera',
                });
            }
            const status = String(result?.status || '').toLowerCase();
            if (status === 'completed' || result?.data_url) return result;
            if (status === 'failed' || result?.error) {
                throw new ProviderError({
                    message: `Generation failed: ${result?.detail || result?.error?.detail || 'Unknown Error'}`,
                    code: String(result?.error?.status_code || 'failed'),
                    status: Number(result?.error?.status_code) || 0,
                    retryable: isRetryableHttpStatus(Number(result?.error?.status_code) || 0),
                    providerId: 'naistera',
                });
            }
            // Abort-aware wait so Stop is responsive instead of blocking a full interval.
            await abortableDelay(intervalMs, signal);
            if (abortedByUser()) throwAborted();
        }
        throw new ProviderError({
            message: `Naistera polling timed out after ${Math.round(timeoutMs / 1000)}s`,
            code: 'timeout',
            retryable: true,
            providerId: 'naistera',
        });
    }

    async collectReferences({ prompt: _prompt, messageId, matchedAdditionalRefs = [], providerOptions = {}, settings = getSettings(), referenceContext = null }) {
        const normalizedModel = normalizeNaisteraModel(providerOptions.model || settings.naisteraModel);
        if (!this.modelCatalog.has(normalizedModel)) {
            await this.fetchModels(settings).catch((error) => {
                iigLog('WARN', `Naistera model metadata unavailable: ${error?.message || error}`);
            });
        }
        if (!this.supportsReferences({ ...settings, naisteraModel: normalizedModel })) {
            return [];
        }
        const refs = await collectProviderReferences({ messageId, matchedAdditionalRefs, settings, referenceContext }, Infinity, 'dataUrl', [
            ['user', 'naisteraSendUserAvatar'], ['char', 'naisteraSendCharAvatar'],
        ]);

        const descriptionMode = normalizeNaisteraCharacterDescriptionsMode(settings.naisteraCharacterDescriptionsMode);
        if (descriptionMode !== 'as-is') {
            return refs.map((ref) => {
                const source = getReferenceSource(ref);
                return source === 'char' || source === 'user'
                    ? makeReferenceObject(getReferenceImage(ref), '', source)
                    : ref;
            });
        }
        return refs;
    }

    async generate({ prompt, style, references = [], options = {}, settings = getSettings() }) {
        const endpoint = getEffectiveEndpoint(settings);
        const url = endpoint.endsWith('/api/generate') ? endpoint : `${endpoint}/api/generate`;

        const aspectRatio = options.aspectRatio || settings.naisteraAspectRatio || '1:1';
        const model = normalizeNaisteraModel(options.model || settings.naisteraModel);
        if (!this.modelCatalog.has(model)) await this.fetchModels(settings);
        if (!this.supportsReferences({ ...settings, naisteraModel: model })) references = [];
        const preset = options.preset || null;
        const wantsVideoTest = Boolean(options.videoTestMode);
        const videoEveryN = normalizeNaisteraVideoFrequency(options.videoEveryN ?? settings.naisteraVideoEveryN);
        const wrapStyle = options.wrapStyle ?? !isNaisteraNovelAIModel(model);
        let fullPrompt = buildFinalGenerationPrompt(
            prompt,
            style,
            options.matchedAdditionalRefs || [],
            settings,
            { wrapStyle, supportsImageReferences: this.supportsReferences({ ...settings, naisteraModel: model }) },
        );
        const descriptionMode = normalizeNaisteraCharacterDescriptionsMode(settings.naisteraCharacterDescriptionsMode);
        const characterDescriptionPromptBlock = options.characterDescriptionPromptBlock
            ?? await buildCharacterDescriptionPromptBlock({
                includeChar: true,
                includeUser: true,
                references,
                mode: descriptionMode,
            }, settings);
        fullPrompt = appendPromptBlock(fullPrompt, characterDescriptionPromptBlock);

        if (references.length > 0) {
            const refInstruction = getEffectiveRefInstruction(settings);
            if (refInstruction) {
                fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
            }
        }

        const body = {
            prompt: fullPrompt,
            aspect_ratio: aspectRatio,
            model,
            ...this.getGenerationSettings({ ...settings, naisteraModel: model }, options),
        };
        const negativePrompt = String(options.negativePrompt ?? getEffectiveNegativePrompt(
            settings.naisteraNegativePrompt, { ...settings, naisteraModel: model },
        )).trim();
        if (negativePrompt && this.supportsNegativePrompt({ ...settings, naisteraModel: model })) {
            body.negative_prompt = negativePrompt;
        }
        if (preset) body.preset = preset;
        if (references.length > 0) {
            body.reference_objects = references
                .map((ref) => ({
                    image: getReferenceImage(ref),
                    description: getReferenceDescription(ref),
                }))
                .filter((ref) => ref.image);
        }
        if (wantsVideoTest) {
            body.video_test_mode = true;
            body.video_test_every_n_messages = videoEveryN;
        }
        if (settings.naisteraPolling) {
            body.sync = false;
        }

        const signal = options.signal || null;
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal,
            });
        } catch (error) {
            if (error?.name === 'AbortError' && signal?.aborted && (signal.reason === 'user-cancel' || signal.reason?.message === 'user-cancel')) {
                throw new ProviderError({
                    message: t`Generation stopped by user`,
                    code: 'aborted',
                    retryable: false,
                    providerId: 'naistera',
                    cause: error,
                });
            }
            const pageOrigin = window.location.origin;
            let endpointOrigin = endpoint;
            try {
                endpointOrigin = new URL(url, window.location.href).origin;
            } catch (parseErr) {
                console.warn('[IIG] Failed to parse Naistera endpoint origin:', parseErr);
            }
            const rawMessage = String(error?.message || '').trim() || 'Failed to fetch';
            throw new ProviderError({
                message: `Network/CORS error while requesting ${endpointOrigin} from ${pageOrigin}. `
                    + `The browser blocked access to the response before the API could return JSON. `
                    + `Original error: ${rawMessage}`,
                code: 'network',
                retryable: true,
                providerId: 'naistera',
                cause: error,
            });
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new ProviderError({
                message: `API Error (${response.status}): ${String(text).slice(0, 800)}`,
                code: String(response.status),
                status: response.status,
                retryable: isRetryableHttpStatus(response.status),
                providerId: 'naistera',
            });
        }

        let result = await response.json();
        if (result?.job_id && !result?.data_url) {
            result = await this.pollJob(endpoint, result.job_id, settings, signal);
        }
        if (!result?.data_url) {
            throw new ProviderError({
                message: 'No data_url in response',
                code: 'empty_response',
                retryable: false,
                providerId: 'naistera',
            });
        }
        if (result.media_kind === 'video') {
            return {
                kind: 'video',
                dataUrl: result.data_url,
                posterDataUrl: result.poster_data_url || '',
                contentType: result.content_type || 'video/mp4',
            };
        }
        return result.data_url;
    }
}
