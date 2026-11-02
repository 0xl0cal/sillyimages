/** AUTOMATIC1111 / Forge txt2img and server catalogs. */
import { Provider, buildGenerationUrl, throwAsProviderError } from './providerBase.js';
import { getSettings, iigLog } from './settings.js';
import { fetchWithTimeout, ProviderError, isRetryableHttpStatus } from './utils.js';

const A1111_DEFAULT_ENDPOINT = 'http://127.0.0.1:7860';
const A1111_REQUEST_TIMEOUT_MS = 600_000;
const A1111_DEFAULT_SAMPLERS = Object.freeze([
    'Euler a', 'Euler', 'LMS', 'Heun', 'DPM2', 'DPM2 a',
    'DPM++ 2S a', 'DPM++ 2M', 'DPM++ SDE', 'DPM++ 2M SDE',
    'DDIM', 'PLMS', 'UniPC', 'LCM', 'Restart',
]);
const A1111_DEFAULT_SCHEDULERS = Object.freeze([
    'Automatic', 'Karras', 'Exponential', 'SGM Uniform', 'Simple', 'Normal', 'DDIM', 'Beta',
]);

export const A1111_RESOLUTION_PRESETS = Object.freeze([
    { id: '512x512', width: 512, height: 512, name: '512x512 (1:1, SD 1.5)' },
    { id: '768x512', width: 768, height: 512, name: '768x512 (3:2, SD 1.5)' },
    { id: '512x768', width: 512, height: 768, name: '512x768 (2:3, SD 1.5)' },
    { id: '960x540', width: 960, height: 540, name: '960x540 (16:9)' },
    { id: '540x960', width: 540, height: 960, name: '540x960 (9:16)' },
    { id: '1024x1024', width: 1024, height: 1024, name: '1024x1024 (1:1, SDXL)' },
    { id: '1152x896', width: 1152, height: 896, name: '1152x896 (9:7, SDXL)' },
    { id: '896x1152', width: 896, height: 1152, name: '896x1152 (7:9, SDXL)' },
    { id: '1216x832', width: 1216, height: 832, name: '1216x832 (19:13, SDXL)' },
    { id: '832x1216', width: 832, height: 1216, name: '832x1216 (13:19, SDXL)' },
    { id: '1344x768', width: 1344, height: 768, name: '1344x768 (4:3, SDXL)' },
    { id: '768x1344', width: 768, height: 1344, name: '768x1344 (3:4, SDXL)' },
    { id: '1536x640', width: 1536, height: 640, name: '1536x640 (24:10, SDXL)' },
    { id: '640x1536', width: 640, height: 1536, name: '640x1536 (10:24, SDXL)' },
    { id: '1920x1088', width: 1920, height: 1088, name: '1920x1088 (16:9, 1080p)' },
    { id: '1088x1920', width: 1088, height: 1920, name: '1088x1920 (9:16, 1080p)' },
]);

function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}
function clampFloat(v, min, max, fallback) {
    const n = parseFloat(v);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

export class A1111Provider extends Provider {
    get id() { return 'a1111'; }
    get displayName() { return 'AUTOMATIC1111 / Forge / reForge'; }

    get capabilities() {
        return {
            ...super.capabilities,
            requiresApiKey: false,
            referencesFormat: null,
        };
    }

    supportsReferences(_settings) {
        return false;
    }

    validate(_settings) {
        // No validation needed: endpoint falls back to A1111_DEFAULT_ENDPOINT;
        // API key optional (only for --api-auth setups).
        return [];
    }

    async collectReferences(_ctx) {
        return [];
    }

    async generate({ prompt, options = {}, settings = getSettings() }) {
        const url = buildGenerationUrl(settings, '/sdapi/v1/txt2img');

        // SDXL/A1111 ждёт comma-separated tag-style промпт, не natural language.
        // Поэтому пропускаем `[STYLE: ...]` injection и `Additional References:`
        // блок из buildFinalGenerationPrompt — тег-промпт идёт чистым,
        // юзер задаёт свой tag-style префикс через a1111PromptPrefix.
        // (style-параметр игнорируем: наша styles-секция заточена под LLM.)
        const rawPrompt = String(prompt || '').trim();
        const positive = settings.a1111PromptPrefix
            ? `${String(settings.a1111PromptPrefix).trim()}, ${rawPrompt}`.replace(/^,\s*|,\s*$/g, '').trim()
            : rawPrompt;

        const overrideSettings = {
            CLIP_stop_at_last_layers: clampInt(settings.a1111ClipSkip, 1, 12, 1),
        };
        if (settings.model) overrideSettings.sd_model_checkpoint = settings.model;
        const isValidVae = settings.a1111Vae && !['N/A', '', 'None'].includes(String(settings.a1111Vae));
        if (isValidVae) overrideSettings.sd_vae = settings.a1111Vae;

        const body = {
            prompt: positive,
            negative_prompt: String(settings.a1111NegativePrompt || ''),
            steps: clampInt(settings.a1111Steps, 1, 150, 20),
            cfg_scale: clampFloat(settings.a1111CfgScale, 1, 30, 7),
            width: clampInt(settings.a1111Width, 64, 4096, 512),
            height: clampInt(settings.a1111Height, 64, 4096, 512),
            sampler_name: String(settings.a1111Sampler || 'Euler a'),
            scheduler: String(settings.a1111Scheduler || 'Automatic'),
            seed: clampInt(settings.a1111Seed, -1, 2 ** 31 - 1, -1),
            n_iter: 1,
            batch_size: 1,
            restore_faces: !!settings.a1111RestoreFaces,
            enable_hr: !!settings.a1111EnableHr,
            hr_upscaler: settings.a1111HrUpscaler || undefined,
            hr_scale: clampFloat(settings.a1111HrScale, 1, 4, 2),
            denoising_strength: clampFloat(settings.a1111DenoisingStrength, 0, 1, 0.7),
            hr_second_pass_steps: clampInt(settings.a1111HrSecondPassSteps, 0, 150, 0),
            clip_skip: clampInt(settings.a1111ClipSkip, 1, 12, 1),
            override_settings: overrideSettings,
            override_settings_restore_afterwards: false,
            save_images: true,
            send_images: true,
        };

        if (settings.a1111AdetailerFace) {
            body.alwayson_scripts = {
                ADetailer: {
                    args: [true, true, { ad_model: 'face_yolov8n.pt' }],
                },
            };
        }

        const headers = { 'Content-Type': 'application/json' };
        if (settings.apiKey) {
            headers.Authorization = `Basic ${btoa(settings.apiKey)}`;
        }

        iigLog('INFO', `A1111 request: model=${settings.model || '(default)'} steps=${body.steps} cfg=${body.cfg_scale} ${body.width}x${body.height} sampler=${body.sampler_name} hires=${body.enable_hr}`);

        const signal = options.signal || null;
        let result;
        try {
            result = await fetchWithTimeout(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            }, A1111_REQUEST_TIMEOUT_MS, signal, async response => {
                if (!response.ok) {
                    const text = await response.text().catch(() => '');
                    throw new ProviderError({
                        message: `A1111 ${response.status}: ${String(text).slice(0, 800)}`,
                        code: String(response.status),
                        status: response.status,
                        retryable: isRetryableHttpStatus(response.status),
                        providerId: 'a1111',
                    });
                }
                return response.json();
            });
        } catch (error) {
            throwAsProviderError(error, 'A1111', 'a1111', signal);
        }
        const b64 = Array.isArray(result?.images) ? result.images[0] : null;
        if (!b64 || typeof b64 !== 'string') {
            iigLog('ERROR', 'A1111 no-image response:', result);
            throw new ProviderError({
                message: `No image in A1111 response. Top-level keys: ${Object.keys(result || {}).join(',')}`,
                code: 'no_image',
                retryable: false,
                providerId: 'a1111',
            });
        }
        return `data:image/png;base64,${b64}`;
    }

    async requestCatalog(path, options = {}) {
        const settings = getSettings();
        const endpoint = (String(settings.endpoint || '').trim() || A1111_DEFAULT_ENDPOINT).replace(/\/$/, '');
        const headers = {};
        if (settings.apiKey) headers.Authorization = `Basic ${btoa(settings.apiKey)}`;
        const response = await fetch(`${endpoint}/sdapi/v1/${path}`, { headers, ...options });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response;
    }

    async readCatalog(path, select, fallback = []) {
        try {
            const data = await (await this.requestCatalog(path)).json();
            const values = Array.isArray(data) ? data.map(select).filter(Boolean) : [];
            return values.length ? values : Array.from(fallback);
        } catch {
            return Array.from(fallback);
        }
    }

    async fetchModels() {
        const data = await (await this.requestCatalog('sd-models', { method: 'GET' })).json();
        return Array.isArray(data) ? data.map(model => model?.title || model?.model_name).filter(Boolean) : [];
    }

    fetchSamplers() {
        return this.readCatalog('samplers', item => item?.name, A1111_DEFAULT_SAMPLERS);
    }

    fetchSchedulers() {
        return this.readCatalog('schedulers', item => item?.label || item?.name, A1111_DEFAULT_SCHEDULERS);
    }

    fetchVaes() {
        return this.readCatalog('sd-vae', item => item?.model_name);
    }

    fetchUpscalers() {
        return this.readCatalog('upscalers', item => item?.name);
    }

    async ping() {
        // A reachable HTTP endpoint is enough; catalog JSON is irrelevant here.
        await this.requestCatalog('sd-models');
        return true;
    }
}
