/** Provider input references and prompt-description composition. */
import { getSettings, normalizeImageContextCount } from './settings.js';
import { normalizeStoredImagePath, imageUrlToBase64, imageUrlToDataUrl } from './utils.js';
import {
    captureReferenceContext, iterateCharacterLibraryReferences, collectPreviousContextReferences, makeReferenceObject,
} from './references.js';

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

export async function collectProviderReferences({ messageId, matchedAdditionalRefs = [], settings = getSettings(), referenceContext = null }, maxRefs, format = 'base64', avatars = [['char', 'sendCharAvatar'], ['user', 'sendUserAvatar']]) {
    const refs = [];
    if (maxRefs <= 0) return refs;
    referenceContext ||= await captureReferenceContext(settings, messageId);
    const groups = [];
    // The first successful image of each avatar precedes its appearance images.
    for (const [kind, enabledKey] of avatars) {
        if (!settings[enabledKey]) continue;
        const group = iterateCharacterLibraryReferences(kind, format, settings, referenceContext);
        groups.push(group);
        const first = await group.next();
        if (!first.done) refs.push(first.value);
        if (refs.length >= maxRefs) return refs;
    }
    for (const group of groups) {
        for await (const ref of group) {
            refs.push(ref);
            if (refs.length >= maxRefs) return refs;
        }
    }

    for (const ref of matchedAdditionalRefs) {
        if (refs.length >= maxRefs) break;
        const imagePath = normalizeStoredImagePath(ref.imagePath);
        if (!imagePath) continue;
        const image = format === 'dataUrl'
            ? await imageUrlToDataUrl(imagePath)
            : await imageUrlToBase64(imagePath);
        if (image) refs.push(makeReferenceObject(image, additionalReferenceDescription(ref, settings), 'additional'));
    }

    if (settings.imageContextEnabled && refs.length < maxRefs) {
        const contextCount = Math.min(normalizeImageContextCount(settings.imageContextCount), maxRefs - refs.length);
        const contextRefs = await collectPreviousContextReferences(messageId, format, contextCount, referenceContext);
        refs.push(...contextRefs.map((ref) => makeReferenceObject(ref, '', 'context')));
    }

    return refs;
}
