// ----- Section wrapper -----

const SETTINGS_SECTION_ICONS = Object.freeze({
    iig_api_section: 'fa-plug',
    iig_styles_section: 'fa-palette',
    iig_characters_section: 'fa-address-book',
    iig_references_section: 'fa-images',
    iig_debug_section: 'fa-bug',
});

export function buildSettingsSectionHtml(sectionId, title, bodyHtml, expanded = true) {
    const icon = SETTINGS_SECTION_ICONS[sectionId] || 'fa-sliders';
    return `
        <details class="iig-section" data-section-id="${sectionId}" ${expanded ? 'open' : ''}>
            <summary class="iig-section-toggle">
                <i class="fa-solid ${icon}"></i>
                <span class="iig-section-title">${title}</span>
            </summary>
            <div class="iig-section-body" id="${sectionId}">
                ${bodyHtml}
            </div>
        </details>
    `;
}

export function setSelectValue(select, value, label = value) {
    if (!(select instanceof HTMLSelectElement)) return;
    if (value && !Array.from(select.options).some(option => option.value === String(value))) {
        select.add(new Option(String(label), String(value)));
    }
    select.value = value ?? '';
}

export function setRangePairValue(id, value) {
    const text = String(value);
    for (const inputId of [id, `${id}_value`]) {
        const input = document.getElementById(inputId);
        if (input && input.value !== text) input.value = text;
    }
}
