# Development

The extension runs as browser ES modules inside SillyTavern. There is no build step or production npm dependency.

## Module Boundaries

- `index.js` initializes settings, events and views.
- `settings.js` owns `extensionSettings.inline_image_gen`, connection profiles, prompt libraries and lorebooks.
- `modelCapabilities.js` classifies model families and normalizes model-dependent parameters without network or DOM access.
- `providers.js` owns provider registration, active capabilities and shared UI entry points. Registration order and public exports are stable.
- `openaiProviders.js`, `geminiProvider.js`, `openrouterProvider.js`, `naisteraProvider.js` and `novelaiProvider.js` own protocol-specific transport behavior. OpenAI, xAI and Electron Hub share one module for compatible image edit workflows.
- `providerReferences.js` owns input reference order, format, limits and prompt descriptions. `imageResponse.js` decodes compatible image response envelopes.
- `providerBase.js` owns the common provider contract, generation URL construction and network error classification. `a1111.js` owns AUTOMATIC1111/Forge generation and catalog requests.
- `references.js` owns character/persona libraries, reference descriptions, context images and imports.
- `referenceTransfer.js` owns image downloads, the `iig-lorebook` v1 interchange format, file/URL imports and browser downloads. Local file paths, record IDs and image data do not belong in exported lorebooks.
- `avatarPicker.js` owns the avatar catalog and synchronized provider dropdowns. Concurrent catalog reads share one pending request; settled requests do not prevent an explicit refresh. Selection updates classes on existing rows, and catalog changes replace the rows in one batch.
- `parser.js` reads message instructions and associates source tags with rendered media.
- `pipeline.js` owns generation locks, retries, cancellation and persistence. New generation, single retry and batch retry share the media lifecycle.
- `ui.js` composes settings sections and reference controls. `apiSettingsUi.js` owns API controls, provider visibility, model catalogs and connection-profile actions. `settingsControls.js` provides section markup and synchronized select/range controls.
- `promptLibraryUi.js` owns Styles and Negatives selection, filtering and editing.
- `characterLibraryUi.js` owns character library navigation and generation management. `generationImages.js` validates deletion paths and protects reference files.
- `libraryImages.js` owns viewport-scoped previews, a sequential decode queue and a 96-entry/4-megapixel thumbnail cache. Gallery original URLs remain separate from display URLs. Collapse retains ready previews within that cache; stale decodes cannot update removed editors. Preview failure displays the original.
- `lightbox.js` owns the modal viewer and gesture lifecycle. `imageActions.js` owns inline controls and message image hydration.

## Data And Runtime Contracts

Treat storage keys, profile fields, lorebook entries, character/persona library entries and saved message instructions as public contracts. Retain their names, types and meanings. Runtime refactoring does not introduce schema versions, rewrite stored collections or require an upgrade migration.

Keep provider-specific reference order and limits explicit. Primary avatars precede appearance images; additional references precede context images. Requests and the debug snapshot use the same avatar description builder.

A1111 model catalog failures propagate to the caller. Optional catalogs return their configured fallback on empty, malformed, HTTP or network responses. The connection check only requires a successful HTTP status. Preserve these distinctions when sharing catalog requests.

Bind a rendered image to its source instruction before generation. Preserve tag order for identical instructions. Do not guess between ambiguous media or copy arbitrary source HTML attributes into the rendered DOM. Keep source indexes stable while loading placeholders replace images.

Initial generation persists an error placeholder for retry. A failed regeneration retains the stored image. Cancellation persists a stopped placeholder. Always release generation controllers and locks. Viewer closure releases timers, frames, pointer capture, modal state and scroll locks.

Acquire generation ownership by message identity before parsing and retain it through saving. Chat replacement, source edits and swipes cancel stale work without writing to another chat. Each request owns its API settings, prompt libraries, matched references and selected appearances; generation histories and connection profiles stay outside the snapshot. Retries reuse that configuration. Naistera catalog metadata is request-owned, while NovelAI allowance checks share one serialized queue.

Viewer and library deletion use the same path plan and protection check. Deleting a file removes its links from every character/persona history. Reference paths are indexed per operation and settings revision. Call `saveSettings()` after reference edits so asynchronous deletion observes the new protections. Revisions and ownership state live only in memory.

Viewer geometry is sampled at gesture start, image load and viewport resize. Pointer/wheel movement uses cached dimensions and batches transforms into animation frames. Original image files and viewer sources are not resized or recompressed.

The library prepares the first visible gallery original after 500 ms without input. A matching loaded original passes directly to the viewer cache. Unused preparations are released during editing, when the candidate leaves view, the section collapses or the page leaves. The viewer retains at most four original resources and 32 megapixels to reuse decodes during navigation, and releases them on library collapse or pagehide. Library previews retain their viewport resources under the modal and reconcile deferred visibility entries after it closes. Stable previews keep their observer subscriptions during list edits.

Avatar sources are assigned when their cards enter the viewport margin. Loaded server thumbnails leave visibility tracking and use the browser decoder without canvas processing or resize subscriptions. Custom previews track card size only within that margin. Full tab replacements and collapse disconnect observers in one batch. Collapsed rows retain their loaded server thumbnails and committed preview sources whose URLs remain in the LRU cache. The cache retains at most 96 entries and four megapixels. Unfinished upgrades are canceled, and removed rows release their ownership even while collapsed.

Page departure releases all library sources and cached preview URLs, including retained collapsed rows. Full-size original resources are released on the transition to a collapsed library, not on subsequent reconciliation of an already closed section.

The preview queue finishes its active job when the viewer opens and defers queued decodes until the viewer closes. A stale close event does not resume work under a reopened viewer.

Preview canvases request readback-oriented 2D contexts for PNG encoding. The canvas is temporary and is not composited into the page; original image files remain separate from its output.

Fallback image decoders own a temporary Blob URL until decoding exits. Clear the image source and revoke that URL on success, failure and cancellation. Keep image data binary during preview preparation.

Keep UI IDs, event types, validation and save behavior stable. Update focused editors in place instead of replacing their parent lists on each keystroke.

Outside clicks close only open avatar menus inside the settings root. Closed menus retain their class attributes so unrelated section clicks do not wake DOM observers.

HTML text and quoted attributes use string escaping without temporary DOM elements. Preserve entity encoding, including non-breaking spaces, and test rendered names and descriptions with markup characters.

Loading a connection profile synchronizes every provider's rendered controls, including range/number pairs, custom select values and polling fields. Synchronization does not emit input/change events or trigger extra saves.

Catalog responses apply only to the current request and connection identity. Profile selection refreshes its catalog; Naistera capability metadata uses the same connection ownership. Preview network requests time out after 15 seconds, and canceled departures restore observation in the active document.

Catalog error notifications use the same request ownership as catalog data. Library list and editor renders capture their kind and revision before asynchronous reads. Reference uploads resolve the current entry and item by key after saving the file; deleted targets are not recreated. Completion updates the matching preview in place and preserves editor input and focus.

Character/persona searches read display metadata only. Normalize created, imported or replaced entries once on first read; keep entry, item and history identities stable during editing. Do not traverse generation histories to filter names or load a collapsed library when toggling active-persona mode.

Reference collection consumes images lazily up to the provider limit. Take the first successful image from each enabled avatar in provider order, then appearance images, additional references and context images. Do not fetch or encode images beyond the remaining budget.

`fetchWithTimeout` owns the response consumer as well as the HTTP request. Consume JSON, text or blobs inside its callback; the deadline and abort signal stay attached through decoding. Each exit releases listeners and closes the request. Reference downloads use a 15-second deadline, and their HTTP requests and FileReaders share the generation signal. Naistera discovery uses 15 seconds, generation uses 10 minutes, and polling requests consume only their remaining deadline.

Styles and negatives retain array and record identity after normalization. Character/persona catalogs reuse sorted entities while their names, avatars, configured titles and active keys match the current metadata signature. Message hydration caches parsed instructions by source and external-block mode; class-only image updates refresh controls without rebinding. Ordinary messages skip generation snapshots, and image requests copy only the selected character/persona appearances.

Character list rows are reconciled by kind and reference key. Matching rows and avatars retain their DOM identity; filtering removes unmatched rows. Visible previews upgrade when card dimensions or pixel density require a larger size bucket, keeping the displayed image until its replacement is ready. Shrinking a card does not trigger a lower-resolution decode.

New character/persona rows are parsed in the live document. A wholesale replacement commits rows and its search note in one HTML assignment, without reconciling detached rows from the other tab. Partial searches append only missing rows and preserve matching nodes. A full list/editor render reconciles image ownership once after both updates. Root-level row markup has no whitespace nodes to accumulate between filter passes.

## Verification

Make Playwright available to Node, using `NODE_PATH` for an external installation. Set `IIG_BROWSER_CHANNEL=msedge` to use installed Edge for Chromium checks. Install the Playwright WebKit runtime for WebKit checks.

```powershell
node tests/run-e2e.cjs chromium
node tests/run-e2e.cjs webkit
node --experimental-vm-modules --test tests/reference-matching.test.cjs
git diff --check
```

The runner writes suite results, logs, source hashes and Git state to `tests/artifacts/suite-<engine>/`. Individual suites write synthetic request details and desktop/mobile screenshots to their own artifact directories. A failing suite stops the run. Provider HTTP responses and Tavern storage are simulated; no account credits or real images are consumed or deleted.

Before changing complex behavior, extend the browser scenarios and run them against the current implementation. Exercise supported input formats, partial failures, cancellation, repeated actions, disabled controls, and narrow viewports. Keep assertions independent of implementation details. Use synthetic prompts and credentials in fixtures and artifacts.

Validate daily use in a separate Tavern instance with a copy of settings and chat data: load profiles, switch models, edit both prompt libraries, change chats/personas, generate and retry individual/batched images, stop and retry, reopen the viewer, and manage gallery selections. A desktop browser fixture does not verify other extensions' formatting or native iPhone pinch/swipe behavior.

## License

Contributions are licensed under GNU AGPL v3.0 only (`AGPL-3.0-only`). Preserve copyright notices and provide corresponding source as required by [LICENSE](LICENSE).
