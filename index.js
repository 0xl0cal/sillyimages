/**
 * Inline Image Generation Extension for SillyTavern
 * 
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible and Gemini-compatible (nano-banana) endpoints.
 */

const MODULE_NAME = 'inline_image_gen';

// Default settings
const defaultSettings = Object.freeze({
    enabled: true,
    apiType: 'openai', // 'openai' or 'gemini'
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 3,
    retryDelay: 1000,
    // Nano-banana specific
    sendCharAvatar: false,
    sendUserAvatar: false,
});

// Image model detection keywords (from your api_client.py)
const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gemini-3-pro', 'gpt-image', 'wanx', 'qwen'
];

// Video model keywords to exclude
const VIDEO_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo'
];

// We'll parse tags manually since JSON can contain nested braces
// Tag format: [IMG:GEN:{...json...}] or <img src="[IMG:GEN:{...json...}]">

/**
 * Check if model ID is an image generation model
 */
function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    
    // Exclude video models
    for (const kw of VIDEO_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return false;
    }
    
    // Exclude vision models
    if (mid.includes('vision') && mid.includes('preview')) return false;
    
    // Check for image model keywords
    for (const kw of IMAGE_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return true;
    }
    
    return false;
}

/**
 * Check if model is Gemini/nano-banana type
 */
function isGeminiModel(modelId) {
    const mid = modelId.toLowerCase();
    return mid.includes('gemini-3-pro') || mid.includes('nano-banana');
}

/**
 * Get extension settings
 */
function getSettings() {
    const context = SillyTavern.getContext();
    
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    
    // Ensure all default keys exist
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    
    return context.extensionSettings[MODULE_NAME];
}

/**
 * Save settings
 */
function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
}

/**
 * Fetch models list from endpoint
 */
async function fetchModels() {
    const settings = getSettings();
    
    if (!settings.endpoint || !settings.apiKey) {
        console.warn('[IIG] Cannot fetch models: endpoint or API key not set');
        return [];
    }
    
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/models`;
    
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        const models = data.data || [];
        
        // Filter for image models only
        return models.filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        console.error('[IIG] Failed to fetch models:', error);
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

/**
 * Convert image URL to base64
 */
async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                // Remove data URL prefix to get pure base64
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to base64:', error);
        return null;
    }
}

/**
 * Save base64 image to file via SillyTavern API
 * @param {string} dataUrl - Data URL (data:image/png;base64,...)
 * @returns {Promise<string>} - Relative path to saved file
 */
async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    
    // Extract base64 and format from data URL
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
        throw new Error('Invalid data URL format');
    }
    
    const format = match[1]; // png, jpeg, webp
    const base64Data = match[2];
    
    // Get character name for subfolder
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }
    
    // Generate unique filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `iig_${timestamp}`;
    
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            image: base64Data,
            format: format,
            ch_name: charName,
            filename: filename
        })
    });
    
    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `Upload failed: ${response.status}`);
    }
    
    const result = await response.json();
    console.log('[IIG] Image saved to:', result.path);
    return result.path;
}

/**
 * Get character avatar as base64
 */
async function getCharacterAvatarBase64() {
    try {
        const context = SillyTavern.getContext();
        
        if (context.characterId === undefined || context.characterId === null) {
            console.log('[IIG] No character selected');
            return null;
        }
        
        // Try context method first
        if (typeof context.getCharacterAvatar === 'function') {
            const avatarUrl = context.getCharacterAvatar(context.characterId);
            if (avatarUrl) {
                return await imageUrlToBase64(avatarUrl);
            }
        }
        
        // Fallback: try to get from characters array
        const character = context.characters?.[context.characterId];
        if (character?.avatar) {
            const avatarUrl = `/characters/${encodeURIComponent(character.avatar)}`;
            return await imageUrlToBase64(avatarUrl);
        }
        
        console.log('[IIG] Could not get character avatar');
        return null;
    } catch (error) {
        console.error('[IIG] Error getting character avatar:', error);
        return null;
    }
}

/**
 * Get user avatar as base64
 */
async function getUserAvatarBase64() {
    try {
        const context = SillyTavern.getContext();
        let avatarUrl = null;
        
        // Method 1: Use context.getUserAvatar if available
        if (typeof context.getUserAvatar === 'function') {
            try {
                avatarUrl = context.getUserAvatar();
            } catch (e) { /* ignore */ }
        }
        
        // Method 2: Get from DOM - user avatar block
        if (!avatarUrl) {
            const userAvatarImg = document.querySelector('#user_avatar_block img, .mes.last_mes.default_ch .avatar img');
            if (userAvatarImg?.src && !userAvatarImg.src.includes('default_avatar')) {
                avatarUrl = userAvatarImg.src;
            }
        }
        
        // Method 3: Check persona if available
        if (!avatarUrl && context.persona) {
            avatarUrl = `/User Avatars/${encodeURIComponent(context.persona)}`;
        }
        
        if (!avatarUrl) {
            console.log('[IIG] No user avatar found');
            return null;
        }
        
        console.log('[IIG] Found user avatar:', avatarUrl);
        return await imageUrlToBase64(avatarUrl);
    } catch (error) {
        console.error('[IIG] Error getting user avatar:', error);
        return null;
    }
}

/**
 * Generate image via OpenAI-compatible endpoint
 */
async function generateImageOpenAI(prompt, style, referenceImages = []) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;
    
    // Combine style and prompt
    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    
    const body = {
        model: settings.model,
        prompt: fullPrompt,
        n: 1,
        size: settings.size,
        quality: settings.quality,
        response_format: 'b64_json'
    };
    
    // Add reference image if supported (for models like GPT-Image-1, FLUX)
    if (referenceImages.length > 0) {
        body.image = `data:image/png;base64,${referenceImages[0]}`;
    }
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }
    
    const result = await response.json();
    
    // Parse response - standard OpenAI format
    const dataList = result.data || [];
    if (dataList.length === 0) {
        if (result.url) return result.url;
        throw new Error('No image data in response');
    }
    
    const imageObj = dataList[0];
    const imageData = imageObj.b64_json || imageObj.url;
    
    // Return as data URL if b64_json
    if (imageObj.b64_json) {
        return `data:image/png;base64,${imageObj.b64_json}`;
    }
    
    return imageData;
}

/**
 * Generate image via Gemini-compatible endpoint (nano-banana)
 */
async function generateImageGemini(prompt, style, referenceImages = []) {
    const settings = getSettings();
    const model = settings.model;
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
    
    // Map size to aspect ratio
    let aspectRatio = '1:1';
    if (settings.size === '1024x1792' || settings.size === '768x1344') aspectRatio = '9:16';
    else if (settings.size === '1792x1024' || settings.size === '1344x768') aspectRatio = '16:9';
    
    // Build parts array
    const parts = [];
    
    // Add reference images first (up to 4)
    for (const imgB64 of referenceImages.slice(0, 4)) {
        parts.push({
            inlineData: {
                mimeType: 'image/png',
                data: imgB64
            }
        });
    }
    
    // Add prompt with style
    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;
    parts.push({ text: fullPrompt });
    
    const body = {
        contents: [{
            role: 'user',
            parts: parts
        }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
                aspectRatio: aspectRatio
            }
        }
    };
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }
    
    const result = await response.json();
    
    // Parse Gemini response
    const candidates = result.candidates || [];
    if (candidates.length === 0) {
        throw new Error('No candidates in response');
    }
    
    const responseParts = candidates[0].content?.parts || [];
    
    for (const part of responseParts) {
        // Check both camelCase and snake_case variants
        if (part.inlineData) {
            return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
        if (part.inline_data) {
            return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
        }
    }
    
    throw new Error('No image found in Gemini response');
}

/**
 * Validate settings before generation
 */
function validateSettings() {
    const settings = getSettings();
    const errors = [];
    
    if (!settings.endpoint) {
        errors.push('URL эндпоинта не настроен');
    }
    if (!settings.apiKey) {
        errors.push('API ключ не настроен');
    }
    if (!settings.model) {
        errors.push('Модель не выбрана');
    }
    
    if (errors.length > 0) {
        throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
    }
}

/**
 * Sanitize text for safe HTML display
 */
function sanitizeForHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Generate image with retry logic
 */
async function generateImageWithRetry(prompt, style, onStatusUpdate) {
    // Validate settings first
    validateSettings();
    
    const settings = getSettings();
    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;
    
    // Collect reference images if enabled (for Gemini/nano-banana)
    const referenceImages = [];
    
    if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
        if (settings.sendCharAvatar) {
            const charAvatar = await getCharacterAvatarBase64();
            if (charAvatar) referenceImages.push(charAvatar);
        }
        
        if (settings.sendUserAvatar) {
            const userAvatar = await getUserAvatarBase64();
            if (userAvatar) referenceImages.push(userAvatar);
        }
    }
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${maxRetries})` : ''}...`);
            
            // Choose API based on type or model
            if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
                return await generateImageGemini(prompt, style, referenceImages);
            } else {
                return await generateImageOpenAI(prompt, style, referenceImages);
            }
        } catch (error) {
            lastError = error;
            console.error(`[IIG] Generation attempt ${attempt + 1} failed:`, error);
            
            // Check if retryable
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

/**
 * Parse [IMG:GEN:{json}] tags from message text
 * Handles nested braces in JSON properly
 */
function parseImageTags(text) {
    const tags = [];
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
            // Malformed - no matching brace
            searchStart = jsonStart;
            continue;
        }
        
        const jsonStr = text.substring(jsonStart, jsonEnd);
        
        // Check for closing bracket after JSON
        const afterJson = text.substring(jsonEnd);
        if (!afterJson.startsWith(']')) {
            searchStart = jsonEnd;
            continue;
        }
        
        // The tag itself (without any wrapper)
        const tagOnly = text.substring(markerIndex, jsonEnd + 1); // [IMG:GEN:{...}]
        
        // Check if tag is inside <img src="...">
        const beforeMarker = text.substring(Math.max(0, markerIndex - 100), markerIndex);
        const isInImgSrc = /<img[^>]*src=["']?$/i.test(beforeMarker);
        
        try {
            const data = JSON.parse(jsonStr);
            
            tags.push({
                fullMatch: tagOnly, // Always just the tag itself
                index: markerIndex,
                style: data.style || '',
                prompt: data.prompt || '',
                isInImgSrc: isInImgSrc // Flag for replacement logic
            });
        } catch (e) {
            console.warn('[IIG] Failed to parse tag JSON:', jsonStr, e);
        }
        
        searchStart = fullMatchEnd;
    }
    
    return tags;
}

/**
 * Create loading placeholder element
 */
function createLoadingPlaceholder(tagId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = `
        <div class="iig-spinner"></div>
        <div class="iig-status">Генерация картинки...</div>
    `;
    return placeholder;
}

/**
 * Create error placeholder element
 */
function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-error-placeholder';
    placeholder.dataset.tagId = tagId;
    
    // Sanitize error message to prevent XSS
    const safeErrorMessage = sanitizeForHtml(errorMessage);
    
    placeholder.innerHTML = `
        <div class="iig-error-icon">&#9888;</div>
        <div class="iig-error-text">${safeErrorMessage}</div>
        <button class="iig-retry-btn menu_button">
            <i class="fa-solid fa-rotate-right"></i> Повторить
        </button>
    `;
    
    // Store tag info for retry
    placeholder.dataset.tagInfo = JSON.stringify(tagInfo);
    
    // Add retry handler
    placeholder.querySelector('.iig-retry-btn').addEventListener('click', () => {
        retryGeneration(placeholder, tagInfo);
    });
    
    return placeholder;
}

/**
 * Retry failed generation
 */
async function retryGeneration(placeholder, tagInfo) {
    const tagId = placeholder.dataset.tagId;
    
    // Replace error with loading
    const loadingPlaceholder = createLoadingPlaceholder(tagId);
    placeholder.replaceWith(loadingPlaceholder);
    
    const statusEl = loadingPlaceholder.querySelector('.iig-status');
    
    try {
        const dataUrl = await generateImageWithRetry(
            tagInfo.prompt,
            tagInfo.style,
            (status) => { statusEl.textContent = status; }
        );
        
        // Save image to file
        statusEl.textContent = 'Сохранение...';
        const imagePath = await saveImageToFile(dataUrl);
        
        // Replace with image
        const img = document.createElement('img');
        img.className = 'iig-generated-image';
        img.src = imagePath;
        img.alt = tagInfo.prompt;
        loadingPlaceholder.replaceWith(img);
        
        toastr.success('Картинка сгенерирована!', 'Генерация картинок');
    } catch (error) {
        console.error('[IIG] Retry failed:', error);
        
        // Replace with error
        const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tagInfo);
        loadingPlaceholder.replaceWith(errorPlaceholder);
        
        toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
    }
}

/**
 * Process image tags in a message
 */
async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    
    if (!settings.enabled) return;
    
    const message = context.chat[messageId];
    if (!message || message.is_user) return;
    
    const tags = parseImageTags(message.mes);
    if (tags.length === 0) return;
    
    console.log(`[IIG] Found ${tags.length} image tag(s) in message ${messageId}`);
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
    
    // Process each tag in parallel
    const processTag = async (tag, index) => {
        const tagId = `iig-${messageId}-${index}`;
        
        // Replace tag with loading placeholder in the DOM
        const loadingPlaceholder = createLoadingPlaceholder(tagId);
        
        // Find and replace the tag in the rendered HTML
        const tagEscaped = tag.fullMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const tagRegex = new RegExp(tagEscaped, 'g');
        
        // Insert placeholder marker
        mesTextEl.innerHTML = mesTextEl.innerHTML.replace(
            tagRegex,
            `<span data-iig-placeholder="${tagId}"></span>`
        );
        
        const placeholderSpan = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
        if (placeholderSpan) {
            placeholderSpan.replaceWith(loadingPlaceholder);
        }
        
        const statusEl = loadingPlaceholder.querySelector('.iig-status');
        
        try {
            const dataUrl = await generateImageWithRetry(
                tag.prompt,
                tag.style,
                (status) => { statusEl.textContent = status; }
            );
            
            // Save image to file instead of keeping base64
            statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);
            
            // Replace placeholder with actual image
            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
            
            loadingPlaceholder.replaceWith(img);
            
            // Update message.mes to persist the image
            if (tag.isInImgSrc) {
                // Tag was inside <img src="...">, just replace with URL
                message.mes = message.mes.replace(tag.fullMatch, imagePath);
            } else {
                // Tag was standalone, replace with markdown image
                message.mes = message.mes.replace(tag.fullMatch, `![${tag.prompt}](${imagePath})`);
            }
            
            console.log(`[IIG] Successfully generated image for tag ${index}`);
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            console.error(`[IIG] Failed to generate image for tag ${index}:`, error);
            
            // Replace with error placeholder
            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            loadingPlaceholder.replaceWith(errorPlaceholder);
            
            toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
        }
    };
    
    // Process all tags in parallel
    await Promise.all(tags.map((tag, index) => processTag(tag, index)));
    
    // Save chat to persist changes
    await context.saveChat();
}

/**
 * Handle CHARACTER_MESSAGE_RENDERED event
 * This fires AFTER the message is rendered to DOM
 */
async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    
    await processMessageTags(messageId);
}

/**
 * Create settings UI
 */
function createSettingsUI() {
    const settings = getSettings();
    const context = SillyTavern.getContext();
    
    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.error('[IIG] Settings container not found');
        return;
    }
    
    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Генерация картинок</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <!-- Вкл/Выкл -->
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>
                    
                    <hr>
                    
                    <h4>Настройки API</h4>
                    
                    <!-- Тип эндпоинта -->
                    <div class="flex-row">
                        <label for="iig_api_type">Тип API</label>
                        <select id="iig_api_type" class="flex1">
                            <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый (/v1/images/generations)</option>
                            <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini-совместимый (nano-banana)</option>
                        </select>
                    </div>
                    
                    <!-- URL эндпоинта -->
                    <div class="flex-row">
                        <label for="iig_endpoint">URL эндпоинта</label>
                        <input type="text" id="iig_endpoint" class="text_pole flex1" 
                               value="${settings.endpoint}" 
                               placeholder="https://api.example.com">
                    </div>
                    
                    <!-- API ключ -->
                    <div class="flex-row">
                        <label for="iig_api_key">API ключ</label>
                        <input type="password" id="iig_api_key" class="text_pole flex1" 
                               value="${settings.apiKey}">
                        <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть">
                            <i class="fa-solid fa-eye"></i>
                        </div>
                    </div>
                    
                    <!-- Модель -->
                    <div class="flex-row">
                        <label for="iig_model">Модель</label>
                        <select id="iig_model" class="flex1">
                            ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">-- Выберите модель --</option>'}
                        </select>
                        <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить список">
                            <i class="fa-solid fa-sync"></i>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <h4>Параметры генерации</h4>
                    
                    <!-- Размер -->
                    <div class="flex-row">
                        <label for="iig_size">Размер</label>
                        <select id="iig_size" class="flex1">
                            <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024x1024 (Квадрат)</option>
                            <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>1792x1024 (Альбомная)</option>
                            <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>1024x1792 (Портретная)</option>
                            <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512x512 (Маленький)</option>
                        </select>
                    </div>
                    
                    <!-- Качество -->
                    <div class="flex-row">
                        <label for="iig_quality">Качество</label>
                        <select id="iig_quality" class="flex1">
                            <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Стандартное</option>
                            <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option>
                        </select>
                    </div>
                    
                    <hr>
                    
                    <!-- Опции аватарок для Nano-Banana -->
                    <div id="iig_avatar_section" class="iig-avatar-section ${settings.apiType !== 'gemini' ? 'hidden' : ''}">
                        <h4>Аватарки персонажей (Nano-Banana)</h4>
                        <p class="hint">Отправлять аватарки как референсы для консистентной генерации персонажей.</p>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}>
                            <span>Отправлять аватар {{char}}</span>
                        </label>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}>
                            <span>Отправлять аватар {{user}}</span>
                        </label>
                    </div>
                    
                    <hr>
                    
                    <h4>Обработка ошибок</h4>
                    
                    <!-- Макс. повторов -->
                    <div class="flex-row">
                        <label for="iig_max_retries">Макс. повторов</label>
                        <input type="number" id="iig_max_retries" class="text_pole flex1" 
                               value="${settings.maxRetries}" min="0" max="5">
                    </div>
                    
                    <!-- Задержка -->
                    <div class="flex-row">
                        <label for="iig_retry_delay">Задержка (мс)</label>
                        <input type="number" id="iig_retry_delay" class="text_pole flex1" 
                               value="${settings.retryDelay}" min="500" max="10000" step="500">
                    </div>
                </div>
            </div>
        </div>
    `;
    
    container.insertAdjacentHTML('beforeend', html);
    
    // Bind event handlers
    bindSettingsEvents();
}

/**
 * Bind settings event handlers
 */
function bindSettingsEvents() {
    const settings = getSettings();
    
    // Enable toggle
    document.getElementById('iig_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
    });
    
    // API Type
    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value;
        saveSettings();
        
        // Show/hide avatar section
        const avatarSection = document.getElementById('iig_avatar_section');
        if (avatarSection) {
            avatarSection.classList.toggle('hidden', e.target.value !== 'gemini');
        }
    });
    
    // Endpoint
    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => {
        settings.endpoint = e.target.value;
        saveSettings();
    });
    
    // API Key
    document.getElementById('iig_api_key')?.addEventListener('input', (e) => {
        settings.apiKey = e.target.value;
        saveSettings();
    });
    
    // API Key toggle visibility
    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.replace('fa-eye', 'fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.replace('fa-eye-slash', 'fa-eye');
        }
    });
    
    // Model
    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value;
        saveSettings();
        
        // Auto-switch API type based on model
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
            document.getElementById('iig_avatar_section')?.classList.remove('hidden');
        }
    });
    
    // Refresh models
    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            
            // Keep current selection if it exists in new list
            const currentModel = settings.model;
            
            select.innerHTML = '<option value="">-- Выберите модель --</option>';
            
            for (const model of models) {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                option.selected = model === currentModel;
                select.appendChild(option);
            }
            
            toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
        } catch (error) {
            toastr.error('Ошибка загрузки моделей', 'Генерация картинок');
        } finally {
            btn.classList.remove('loading');
        }
    });
    
    // Size
    document.getElementById('iig_size')?.addEventListener('change', (e) => {
        settings.size = e.target.value;
        saveSettings();
    });
    
    // Quality
    document.getElementById('iig_quality')?.addEventListener('change', (e) => {
        settings.quality = e.target.value;
        saveSettings();
    });
    
    // Send char avatar
    document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => {
        settings.sendCharAvatar = e.target.checked;
        saveSettings();
    });
    
    // Send user avatar
    document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
        settings.sendUserAvatar = e.target.checked;
        saveSettings();
    });
    
    // Max retries
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => {
        settings.maxRetries = parseInt(e.target.value) || 3;
        saveSettings();
    });
    
    // Retry delay
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => {
        settings.retryDelay = parseInt(e.target.value) || 1000;
        saveSettings();
    });
}

/**
 * Initialize extension
 */
(function init() {
    const context = SillyTavern.getContext();
    
    // Load settings
    getSettings();
    
    // Create settings UI when app is ready
    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        console.log('[IIG] Inline Image Generation extension loaded');
    });
    
    // Listen for new messages AFTER they're rendered in DOM
    // CHARACTER_MESSAGE_RENDERED fires after addOneMessage() completes
    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
    
    console.log('[IIG] Inline Image Generation extension initialized');
})();
