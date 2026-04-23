/**
 * Inline Image Generation — entry point.
 *
 * Catches `[IMG:GEN:{json}]` tags in AI messages and `<img data-iig-instruction>`
 * and generates images via configured API.
 *
 * Вся логика вынесена в `src/`. Этот файл — только импорт + init.
 */

import { getSettings } from './src/settings.js';
import { createSettingsUI } from './src/ui.js';
import { addButtonsToExistingMessages, subscribeEvents } from './src/events.js';

(function init() {
    const context = SillyTavern.getContext();

    // Load/seed settings eagerly so getSettings() сразу возвращает валидный объект.
    getSettings();

    // Create settings UI when app is ready.
    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        // Add buttons to any messages already in chat.
        addButtonsToExistingMessages();
        console.log('[IIG] Inline Image Generation extension loaded');
    });

    subscribeEvents();

    console.log('[IIG] Inline Image Generation extension initialized');
})();
