/** Shared provider contract, URL construction and transport error mapping. */
import { getSettings, getEffectiveEndpoint, ENDPOINT_PLACEHOLDERS, MAX_GENERATION_REFERENCE_IMAGES } from './settings.js';
import { ProviderError } from './utils.js';
import { isImageModel } from './modelCapabilities.js';
import { t } from './i18n.js';

export class Provider {
    get id() { throw new Error('Provider.id not implemented'); }
    get displayName() { return this.id; }
    get capabilities() {
        return {
            endpointPlaceholder: ENDPOINT_PLACEHOLDERS[this.id] || 'https://api.example.com',
            requiresApiKey: true,
            referencesMaxCount: MAX_GENERATION_REFERENCE_IMAGES,
            referencesFormat: 'base64',
        };
    }

    validate(settings) {
        const errors = [];
        const caps = this.capabilities;
        if (!settings.endpoint && this.id !== 'naistera') {
            errors.push(t`Endpoint URL is not configured`);
        }
        if (caps.requiresApiKey && !settings.apiKey) {
            errors.push(t`API key is not configured`);
        }
        return errors;
    }

    supportsReferences(_settings) {
        return true;
    }

    supportsNegativePrompt(_settings) {
        return false;
    }

    async collectReferences(_ctx) {
        return [];
    }

    async generate(_request) {
        throw new Error(`Provider[${this.id}].generate() not implemented`);
    }

    getModelLabel(modelId) {
        return String(modelId || '');
    }

    async fetchModels() {
        const settings = getSettings();
        const endpoint = getEffectiveEndpoint(settings);

        if (!endpoint || !settings.apiKey) {
            console.warn('[IIG] Cannot fetch models: endpoint or API key not set');
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
        const models = data.data || [];
        return models.filter(m => isImageModel(m.id)).map(m => m.id);
    }
}

export function buildGenerationUrl(settings, pathSuffix) {
    const base = (getEffectiveEndpoint(settings) || String(settings.endpoint || '')).replace(/\/$/, '');
    if (settings.rawEndpoint) {
        return base;
    }
    return `${base}${pathSuffix}`;
}

export function throwAsProviderError(error, endpointLabel, providerId, signal = null) {
    if (error instanceof ProviderError) throw error;
    const fail = (message, code, retryable) => {
        throw new ProviderError({ message, code, retryable, providerId, cause: error });
    };
    if (error?.name === 'AbortError') {
        const reason = signal?.reason;
        if (signal?.aborted && (reason === 'user-cancel' || reason?.message === 'user-cancel')) {
            fail(t`Generation stopped by user`, 'aborted', false);
        }
        fail(t`Request to ${endpointLabel} timed out. Check your connection and try regenerating.`, 'timeout', true);
    }
    if (error?.name === 'TypeError') {
        fail(t`Connection problem with ${endpointLabel}. Server is unreachable or blocked. Try regenerating.`, 'network', true);
    }
    fail(String(error?.message || error) || 'Unknown provider error', 'unknown', false);
}
