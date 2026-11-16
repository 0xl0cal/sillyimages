import { user_avatar } from '../../../../personas.js';
import { getSettings } from './settings.js';
import {
    getCharacterLibraryEntry,
    getCurrentCharacterReferenceKey,
    getUserReferenceKeyForAvatar,
} from './references.js';

function renderDescription(kind, key, settings) {
    if (key === 'no-character' || key === 'no-user-avatar') return '';
    const entry = getCharacterLibraryEntry(kind, key, settings, { create: false });
    if (!entry) return '';

    // Each enabled record contributes once, including a temporary main reference.
    return [entry.primary, ...entry.appearanceItems]
        .filter(item => item.enabled !== false)
        .map(item => String(item.description || '').trim())
        .filter(Boolean)
        .join('\n');
}

export function registerIigDescriptionMacros() {
    const context = SillyTavern.getContext();
    context.registerMacro(
        'iig_char_description',
        () => renderDescription('char', getCurrentCharacterReferenceKey(), getSettings()),
        'SillyImages: enabled Character library descriptions for the current character.',
    );
    context.registerMacro(
        'iig_user_description',
        () => renderDescription('user', getUserReferenceKeyForAvatar(user_avatar), getSettings()),
        'SillyImages: enabled Character library descriptions for the active Tavern persona.',
    );
}
