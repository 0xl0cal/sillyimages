/**
 * Подписки на события SillyTavern и кнопка "regenerate" в меню сообщения.
 */

import { getSettings, iigLog } from './settings.js';
import { processMessageTags, regenerateMessageImages } from './pipeline.js';
import { t } from './i18n.js';

// ----- Regenerate button (three-dots menu) -----

export function addRegenerateButton(messageElement, messageId) {
    // Check if button already exists
    if (messageElement.querySelector('.iig-regenerate-btn')) return;

    // Find the extraMesButtons container (three dots menu)
    const extraMesButtons = messageElement.querySelector('.extraMesButtons');
    if (!extraMesButtons) return;

    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = t`Regenerate images`;
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await regenerateMessageImages(messageId);
    });

    extraMesButtons.appendChild(btn);

    // ST hides the "..." hint button on user messages by default. Once we
    // attach our button, force the hint visible so user can actually open it.
    const hint = messageElement.querySelector('.extraMesButtonsHint');
    if (hint instanceof HTMLElement) {
        hint.style.display = '';
        hint.style.opacity = '';
    }
}

export function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;
    const settings = getSettings();

    const messageElements = document.querySelectorAll('#chat .mes');
    let addedCount = 0;

    for (const messageElement of messageElements) {
        const mesId = messageElement.getAttribute('mesid');
        if (mesId === null) continue;

        const messageId = parseInt(mesId, 10);
        const message = context.chat[messageId];
        if (!message) continue;

        // AI messages always; user messages only if processUserMessages is on.
        if (message.is_user && !settings.processUserMessages) continue;

        addRegenerateButton(messageElement, messageId);
        addedCount++;
    }

    iigLog('INFO', `Added regenerate buttons to ${addedCount} existing messages`);
}

// ----- Message rendered handlers -----

export async function onMessageReceived(messageId) {
    iigLog('INFO', `onMessageReceived: ${messageId}`);

    const settings = getSettings();
    if (!settings.enabled) {
        iigLog('INFO', 'Extension disabled, skipping');
        return;
    }

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;

    addRegenerateButton(messageElement, messageId);
    await processMessageTags(messageId);
}

export async function onUserMessageRendered(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (!settings.processUserMessages) return;

    iigLog('INFO', `onUserMessageRendered: ${messageId}`);
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;

    addRegenerateButton(messageElement, messageId);
    await processMessageTags(messageId);
}

// ----- Subscription helper (called from index.js init) -----

export function subscribeEvents() {
    const context = SillyTavern.getContext();

    console.log('[IIG] Available event_types:', context.event_types);
    console.log('[IIG] CHARACTER_MESSAGE_RENDERED:', context.event_types.CHARACTER_MESSAGE_RENDERED);
    console.log('[IIG] MESSAGE_SWIPED:', context.event_types.MESSAGE_SWIPED);

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        iigLog('INFO', 'CHAT_CHANGED event - adding buttons to existing messages');
        setTimeout(() => addButtonsToExistingMessages(), 100);
    });

    const handleMessage = async (messageId) => {
        console.log('[IIG] Event triggered for message:', messageId);
        await onMessageReceived(messageId);
    };

    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);

    // User-message processing is opt-in via processUserMessages — handler early-exits when off.
    if (context.event_types.USER_MESSAGE_RENDERED) {
        context.eventSource.makeLast(context.event_types.USER_MESSAGE_RENDERED, async (messageId) => {
            console.log('[IIG] USER_MESSAGE_RENDERED:', messageId);
            await onUserMessageRendered(messageId);
        });
    }

    // NOTE: We intentionally DO NOT handle MESSAGE_SWIPED or MESSAGE_UPDATED.
    // Swipe = user wants NEW content, not to retry old error images.
    // If user wants to retry failed images, they use the regenerate button in menu.
}
