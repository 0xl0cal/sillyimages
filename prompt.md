[HTML CSS]
Your task is to enhance the narrative by embedding a unique visual artifact into every response. You must vary its placement: at the beginning, between paragraphs, or at the end. Each artifact must be a clickable, interactive element built with HTML and CSS, integrating images. These artifacts must embody the context of the current scene through objects, portraits, locations, or emotional atmospheres.

Technical requirements for HTML and CSS:
- Do NOT use markdown code blocks like triple backticks.
- Do NOT use JavaScript.{{setvar::ru_html_language::
- HTML Visuals: - All visible text inside the artifact must be in language that indicated in **Russian** only.}}{{setvar::ua_html_language::
- HTML Visuals: - All visible text inside the artifact must be in language that indicated in **Ukrainian** only.}}
- The code must be fully responsive and optimized for smartphone browsers using mobile-first principles.
- Placement: In the middle of the message between paragraphs.
- Use viewport units (vw, vh, vmin) to ensure the artifact fits perfectly on any mobile screen.
- Every artifact must be fundamentally different from previous ones in shape, logic, and execution.
- Clickable areas must be at least 44x44px for touch accessibility.
- Use a unique wrapper div with a specific ID for each artifact to prevent style conflicts.
Advanced CSS Interaction Logic:
- Cycle through different interaction methods for each response:
- The Input Hack. Use hidden radio buttons or checkboxes with the sibling selector (~) to create multi-step interfaces or state-switching (e.g., opening a chest or changing a character's expression).
- 3D Transforms. Use perspective and rotateY properties to create flipping cards, unfolding letters, or rotating objects.
- Masking and Clipping. Use clip-path to create non-rectangular shapes, like broken glass, stars, or a "flashlight" effect over an image.
- Pure CSS Overlays. Use the :active pseudo-class or focus states to trigger modal-like expansions or zoom effects.
- Keyframe Animation. Create "living" scenes with parallax scrolling or floating elements that respond to the user's presence.

Image generation:
- Each artifact must contain 1 to 5 images.
- CRITICAL: Use SINGLE QUOTES for the data-iig-instruction attribute value, and DOUBLE QUOTES inside JSON!
- Format: `<img data-iig-instruction='{"style":"[STYLE]","prompt":"[DESC]","aspect_ratio":"[RATIO]","image_size":"[SIZE]"}' src="[IMG:GEN]">`
- WRONG: `data-iig-instruction="{ "style": "..." }"` (double quotes conflict!)
- CORRECT: `data-iig-instruction='{"style":"...","prompt":"..."}'` (single quotes wrap JSON)
- [STYLE]: Use a known game engine, animation studio style, cinematic look, or real-world medium.
- [DESC]: A detailed prompt of 100+ english words describing the image.
- [RATIO]: Aspect ratio - "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9". Choose based on scene composition.
- [SIZE]: Image resolution - "1K" (default), "2K", "4K" for higher quality.
- Famous Characters: Use their names (e.g., Krul Tepes) and provide a detailed physical description.
- Original Characters or User: Describe details including gender, physique, eye and hair color, unique features (e.g., fangs, gradient cat ears with specific colors), clothing, and current emotions.
- CRITICAL RULE FOR IMAGES:
  * `src="[IMG:GEN]"` = Image needs to be generated (USE THIS FOR ALL NEW IMAGES)
  * `src="/user/images/..."` or any path in history = Image already exists, DO NOT COPY THIS
  * In EVERY new message, create NEW images with `src="[IMG:GEN]"`
  * NEVER reuse or copy src paths from chat history
  * Each response needs FRESH image generation with `src="[IMG:GEN]"`
  * If you see an existing path in src, that's a COMPLETED image - make a NEW one with [IMG:GEN]
{{setvar::largecothtml::
- HTML Visuals: What additional HTML element could be added that would fit the story? Is the new element varied and different from those used previously?}}
