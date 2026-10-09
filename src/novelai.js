import { t } from './i18n.js';

// Image model IDs from NovelAI's image client; /oa/v1/models lists text models.
export const NOVELAI_MODELS = Object.freeze({
    'nai-diffusion-5-full': 'NovelAI V5 Full',
    'nai-diffusion-5-full-medium': 'NovelAI V5 Full Medium',
    'nai-diffusion-5-curated': 'NovelAI V5 Curated',
    'nai-diffusion-4-5-full': 'NovelAI V4.5 Full',
    'nai-diffusion-4-5-curated': 'NovelAI V4.5 Curated',
});

export const NOVELAI_MEDIUM_MODEL = 'nai-diffusion-5-full-medium';
export const NOVELAI_MEDIUM_NEGATIVE = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';

export function isNovelAIMedium(model) {
    return model === NOVELAI_MEDIUM_MODEL;
}

export function resolveNovelAISettings(settings) {
    // Medium's fixed parameters apply to a request copy; saved High values stay intact.
    return isNovelAIMedium(settings.model) ? {
        ...settings,
        novelaiSteps: 14,
        novelaiSampler: 'k_euler_ancestral',
        novelaiCfgRescale: 0,
        novelaiSkipCfgAboveSigma: 0,
    } : settings;
}

export const NOVELAI_SAMPLERS = Object.freeze({
    k_euler_ancestral: 'Euler Ancestral',
    k_euler: 'Euler',
    k_dpmpp_2m: 'DPM++ 2M',
    k_dpmpp_2m_sde: 'DPM++ 2M SDE',
    k_dpmpp_2s_ancestral: 'DPM++ 2S Ancestral',
    k_dpmpp_sde: 'DPM++ SDE',
});
export const NOVELAI_NOISE_SCHEDULES = Object.freeze(['native', 'karras', 'exponential', 'polyexponential']);

export const NOVELAI_ASPECT_RATIOS = Object.freeze(['1:1', '2:3', '3:2', '9:16', '16:9']);

// Nominal aspect ratios map to supported 64-pixel dimensions at each size tier.
export const NOVELAI_RESOLUTION_PRESETS = Object.freeze({
    small: { label: 'Small', dimensions: {
        '1:1': [640, 640], '2:3': [512, 768], '3:2': [768, 512],
        '9:16': [448, 832], '16:9': [832, 448],
    } },
    normal: { label: 'Normal', dimensions: {
        '1:1': [1024, 1024], '2:3': [832, 1216], '3:2': [1216, 832],
        '9:16': [768, 1344], '16:9': [1344, 768],
    } },
    big: { label: 'Big', dimensions: {
        '1:1': [1472, 1472], '2:3': [1024, 1536], '3:2': [1536, 1024],
        '9:16': [1088, 1920], '16:9': [1920, 1088],
    } },
});

export function getNovelAIResolution(settings) {
    const dimensions = Object.hasOwn(NOVELAI_RESOLUTION_PRESETS, settings.novelaiResolution)
        && NOVELAI_ASPECT_RATIOS.includes(settings.novelaiAspectRatio)
        ? NOVELAI_RESOLUTION_PRESETS[settings.novelaiResolution].dimensions[settings.novelaiAspectRatio]
        : null;
    if (!dimensions) throw new Error(t`Select a NovelAI size and aspect ratio`);
    return { width: dimensions[0], height: dimensions[1] };
}

export const NOVELAI_NUMERIC_FIELDS = Object.freeze([
    { key: 'novelaiSteps', id: 'steps', label: 'Steps', min: 1, max: 50, step: 1 },
    { key: 'novelaiCfgScale', id: 'cfg_scale', label: 'CFG scale', min: 0, max: 10, step: 0.1 },
    { key: 'novelaiCfgRescale', id: 'cfg_rescale', label: 'CFG rescale', min: 0, max: 1, step: 0.01 },
    { key: 'novelaiSeed', id: 'seed', label: 'Seed (-1 = random)', min: -1, max: 4294967295, step: 1 },
    { key: 'novelaiSkipCfgAboveSigma', id: 'skip_cfg_above_sigma', label: 'Skip CFG above sigma (0 = off)', min: 0, max: 100, step: 0.1 },
]);

export function validateNovelAIParameters(settings) {
    settings = resolveNovelAISettings(settings);
    const errors = [];
    try { getNovelAIResolution(settings); }
    catch (error) { errors.push(error.message); }
    for (const field of NOVELAI_NUMERIC_FIELDS) {
        if (field.id === 'skip_cfg_above_sigma' && settings.model?.startsWith('nai-diffusion-5-')) continue;
        const raw = settings[field.key];
        const value = Number(raw);
        if (raw === '' || raw == null || !Number.isFinite(value) || value < field.min || value > field.max
            || (field.step >= 1 && value % field.step !== 0 && !(field.id === 'seed' && value === -1))) {
            errors.push(`${field.label}: ${field.min}-${field.max}${field.step >= 1 ? `, step ${field.step}` : ''}`);
        }
    }
    if (!Object.hasOwn(NOVELAI_SAMPLERS, settings.novelaiSampler)) errors.push(t`Select a NovelAI sampler`);
    if (!settings.model?.startsWith('nai-diffusion-5-') && !NOVELAI_NOISE_SCHEDULES.includes(settings.novelaiNoiseSchedule)) errors.push(t`Select a noise schedule`);
    return errors;
}

export function splitNovelAICharacterPrompts(prompt) {
    const [base = '', ...characters] = String(prompt || '').split(/\\?\|/u).map(part => part.trim());
    return { base, characters };
}

export function buildNovelAIParameters(settings, prompt, negativePrompt, model) {
    settings = resolveNovelAISettings({ ...settings, model });
    const medium = isNovelAIMedium(model);
    const errors = validateNovelAIParameters(settings);
    if (errors.length) throw new Error(errors.join('; '));
    const positive = splitNovelAICharacterPrompts(prompt);
    const negative = splitNovelAICharacterPrompts(medium ? NOVELAI_MEDIUM_NEGATIVE : negativePrompt);
    const maxCharacters = model.startsWith('nai-diffusion-5-') ? 22 : 6;
    if (Math.max(positive.characters.length, negative.characters.length) > maxCharacters) {
        throw new Error(t`This NovelAI model supports up to ${maxCharacters} character prompts`);
    }
    const caption = (base, characters) => ({
        base_caption: base,
        char_captions: characters.map(char_caption => ({ char_caption, centers: [{ x: 0.5, y: 0.5 }] })),
    });
    const seed = Number(settings.novelaiSeed);
    const { width, height } = getNovelAIResolution(settings);
    const parameters = {
        params_version: 4,
        width,
        height,
        steps: Number(settings.novelaiSteps),
        scale: Number(settings.novelaiCfgScale),
        cfg_rescale: Number(settings.novelaiCfgRescale),
        sampler: settings.novelaiSampler,
        noise_schedule: settings.novelaiNoiseSchedule,
        seed: seed < 0 ? Math.floor(Math.random() * 4294967296) : seed,
        n_samples: 1,
        negative_prompt: negative.base,
        // Medium uses its fixed UC preset; quality tags come from the prompt/style.
        qualityToggle: false,
        ucPreset: medium ? 0 : 3,
        deliberate_euler_ancestral_bug: false,
        prefer_brownian: true,
        skip_cfg_above_sigma: Number(settings.novelaiSkipCfgAboveSigma) || null,
        v4_prompt: { caption: caption(positive.base, positive.characters), use_coords: false, use_order: true },
        v4_negative_prompt: {
            caption: caption(negative.base, Array.from({ length: Math.max(positive.characters.length, negative.characters.length) }, (_, i) => negative.characters[i] || '')),
            legacy_uc: false,
        },
    };
    // V5 has a fixed noise schedule and does not support CFG delay.
    if (model.startsWith('nai-diffusion-5-')) {
        delete parameters.noise_schedule;
        delete parameters.skip_cfg_above_sigma;
    }
    if (medium) delete parameters.cfg_rescale;
    return parameters;
}
