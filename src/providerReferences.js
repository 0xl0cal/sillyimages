/** Provider input references and prompt-description composition. */
import { getSettings, normalizeImageContextCount } from './settings.js';
import { normalizeStoredImagePath, imageUrlToBase64, imageUrlToDataUrl } from './utils.js';
import {
    collectCharacterLibraryReferences, collectPreviousContextReferences, makeReferenceObject,
} from './references.js';

function appendAvatarReferenceGroups(target, groups) {
    for (const group of groups) {
        if (group[0]) target.push(group[0]);
    }
    for (const group of groups) {
        if (group.length > 1) target.push(...group.slice(1));
    }
}

export function referenceTextLabel(index, description) {
    const text = String(description || '').replace(/\s+/g, ' ').trim();
    return text ? `Reference ${index}: ${text}` : '';
}

export function geminiImageLabel(index, description) {
    const text = String(description || '').replace(/\s+/g, ' ').trim();
    return text ? `IMAGE_${index}: ${text}` : '';
}

function additionalReferenceDescription(ref, settings = getSettings()) {
    if (settings.sendRefDescriptions === false) {
        return '';
    }
    return String(ref?.description || ref?.name || '').trim();
}

export function appendPromptBlock(prompt, block) {
    const text = String(block || '').trim();
    return text ? `${prompt}\n\n${text}`.trim() : prompt;
}

export async function collectProviderReferences({ messageId, matchedAdditionalRefs = [] }, maxRefs, format = 'base64', avatars = [['char', 'sendCharAvatar'], ['user', 'sendUserAvatar']]) {
    const settings = getSettings();
    const refs = [];
    const groups = [];
    // Both primary avatars precede appearance images; provider order is explicit.
    for (const [kind, enabledKey] of avatars) {
        groups.push(settings[enabledKey] ? await collectCharacterLibraryReferences(kind, format, settings) : []);
    }
    appendAvatarReferenceGroups(refs, groups);

    for (const ref of matchedAdditionalRefs) {
        if (refs.length >= maxRefs) break;
        const imagePath = normalizeStoredImagePath(ref.imagePath);
        if (!imagePath) continue;
        const image = format === 'dataUrl'
            ? await imageUrlToDataUrl(imagePath)
            : await imageUrlToBase64(imagePath);
        if (image) refs.push(makeReferenceObject(image, additionalReferenceDescription(ref, settings), 'additional'));
    }

    if (settings.imageContextEnabled) {
        const contextCount = normalizeImageContextCount(settings.imageContextCount);
        const contextRefs = await collectPreviousContextReferences(messageId, format, contextCount);
        refs.push(...contextRefs.map((ref) => makeReferenceObject(ref, '', 'context')));
    }

    if (refs.length > maxRefs) {
        refs.length = maxRefs;
    }
    return refs;
}
