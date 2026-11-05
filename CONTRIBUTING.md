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

## Stored Data

Treat storage keys, profile fields, lorebook entries, character/persona library entries and saved message instructions as public contracts. Retain their names, types and meanings. Runtime refactoring does not introduce schema versions, rewrite stored collections or require an upgrade migration.

Normalize prompt-library arrays, character/persona entries and appearance items once on first read after creation, import or replacement. Keep their identities stable during editing. Histories are normalized only when their entry is used, not while searching names.

Keep UI IDs, event types, validation and save behavior stable. Loading a connection profile synchronizes every provider's controls, including range/number pairs, custom select values and polling fields, without emitting input/change events or triggering extra saves.

## Generation And Requests

Keep provider-specific reference order and limits explicit. Collect the first successful image from each enabled avatar in provider order, then appearance images, additional references and context images. Fetch and encode only the remaining image budget. Requests and the debug snapshot use the same avatar description builder.

A1111 model catalog failures propagate to the caller. Optional catalogs return their configured fallback on empty, malformed, HTTP or network responses. The connection check only requires a successful HTTP status. Preserve these distinctions when sharing catalog requests.

Bind a rendered image to its source instruction before generation. Preserve tag order for identical instructions. Do not guess between ambiguous media or copy arbitrary source HTML attributes into the rendered DOM. Keep source indexes stable while loading placeholders replace images.

Initial generation persists an error placeholder for retry. A failed regeneration retains the stored image. Cancellation persists a stopped placeholder. Always release generation controllers and locks.

Acquire generation ownership by message identity before parsing and retain it through saving. Chat replacement, source edits and swipes cancel stale work without writing to another chat. Each request owns its API settings, prompt libraries, matched references and selected appearances; generation histories and connection profiles stay outside the snapshot. Retries reuse that configuration. Naistera catalog metadata is request-owned, while NovelAI allowance checks share one serialized queue.

`fetchWithTimeout` owns the response consumer and the HTTP request. Consume JSON, text or blobs inside its callback so deadlines and cancellation cover decoding; each exit releases listeners and closes the request. Reference downloads and avatar catalogs use a 15-second deadline. Reference FileReaders share the generation signal. Naistera discovery uses 15 seconds, generation uses 10 minutes, and polling requests consume their remaining deadline. Failed avatar refreshes retain the cached list and release the shared request for retry.

Catalog responses and error notifications apply only to the current request and connection identity. Profile selection refreshes its catalog; Naistera capability metadata uses the same connection ownership.

Message hydration caches parsed instructions by source and external-block mode; class-only image updates refresh controls without rebinding. Ordinary messages skip generation snapshots.

## Library Updates

Character/persona catalogs reuse sorted entities while names, avatars, configured titles and active keys match their metadata signature. Persona catalogs read the name map once after avatar/context reads and use those labels for signatures and row data. Searches read display metadata only. Toggling active-persona mode leaves a collapsed library unloaded.

Reconcile rows by kind and reference key, retaining matching rows and avatars. Parse new rows in the live document without root-level whitespace nodes. Replace a complete tab and its search note in one HTML assignment; partial searches insert missing rows and remove unmatched ones. Reconcile image ownership once after a complete list/editor render.

List and editor renders capture their kind and revision before asynchronous reads. Reference uploads resolve the current entry and item by key after saving the file; deleted targets stay deleted. Update matching previews and focused editor fields in place.

Generation discovery captures the selected character's chat URLs before network requests. Its result can replace only the same entry and history array: a newer generation or replacement entry takes precedence. Completion updates that character's visible gallery and count in place, preserving editor fields and focus.

Viewer and library deletion share a path plan and reference protection check. Deleting a file removes its links from every history. Call `saveSettings()` after reference edits so asynchronous deletion observes the new protections; ownership and revision state stay in memory.

Outside clicks close only open avatar menus inside the settings root. Preserve closed menus' class attributes to avoid waking DOM observers. Escape HTML text and quoted attributes as strings, including non-breaking spaces, without temporary DOM elements.

## Image Ownership

Original files and viewer sources retain their resolution and encoding. The preview cache owns at most 96 entries and four megapixels; the viewer owns at most four decoded originals and 32 megapixels. The first visible gallery original is prepared after visible previews finish and 500 ms without input, then transfers directly to the viewer cache on a matching load. Release unused preparation during editing, new preview downloads, collapse and page departure.

Assign avatar sources within the viewport margin. Loaded server thumbnails use the native decoder and leave visibility tracking. Custom previews track card size only within that margin; upgrade size buckets for larger cards or higher pixel density, retaining the displayed preview until replacement. Shrinking cards keeps their current bucket.

Offscreen rows retain decoded previews while their URLs belong to the bounded cache. Returning to a row renews its cache priority without rewriting its source. Eviction releases offscreen owners; visible owners keep an evicted URL until exit or replacement. Leaving the viewport cancels unfinished upgrades while preserving any cached preview. Fallback originals remain viewport-owned, and their URLs belong to the original source owner.

Stable rows retain observer subscriptions. Full tab replacements and collapse disconnect observers in one batch. Collapse retains loaded server thumbnails and committed previews in the bounded cache, cancels unfinished upgrades and releases viewer originals. Removed rows release sources even while collapsed. Page departure releases all sources and cache URLs; a canceled departure restores observation. Visibility-only toggles reuse membership for the same section; mutations and replacements reconcile it fully.

At most three preview jobs download or wait for the single decoder. Process downloads in completion order; duplicate source/size requests share the resulting cache entry. Cached rows bypass pending downloads and decoding. The library observer owns deferred loading; assigned previews load eagerly at normal priority and decode asynchronously.

Preview jobs wait at decode, raster and display boundaries while the viewer is open; queued downloads stay parked. Retain visible previews beneath the modal and reconcile deferred visibility on close. Resume work after 150 ms without another close; queued close events cannot resume it under a reopened viewer. Collapse and page departure cancel that timer. Cancellation releases parked bitmaps and waiters; completed jobs release sources without aborting finished controllers.

Preview encoding uses temporary readback-oriented canvases. Fallback decoders own binary Blob URLs until decoding exits; clear sources and revoke URLs on success, failure and cancellation. Preview requests time out after 15 seconds.

## Viewer Interaction

Sample geometry at gesture start, image load and viewport resize. Pointer/wheel movement uses cached dimensions and batches transforms into animation frames. The scrollable entity list and fixed-size viewer contain layout and style, without size or paint containment. List height follows its contents; the editor stays outside that boundary. Only an open viewer requests a transform layer.

Prepare controls, caption and accessibility state before `showModal()`, which focuses Close through `autofocus`. Start original decoding in the visible modal. Opening uses the closed identity transform without a forced reset layout; navigation immediately resets zoom even during an active reset animation. Closing releases the displayed source, transform hint, timers, frames, pointer capture, modal state and scroll locks. Gallery mutations reconcile image ownership at the mutation site, including viewer deletion.

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
