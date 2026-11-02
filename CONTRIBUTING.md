# Development

The extension runs as browser ES modules inside SillyTavern. There is no build step or production npm dependency.

## Module Boundaries

- `index.js` initializes settings, events and views.
- `settings.js` owns `extensionSettings.inline_image_gen`, connection profiles, prompt libraries and lorebooks.
- `modelCapabilities.js` classifies model families and normalizes model-dependent parameters without network or DOM access.
- `providers.js` owns provider registration, transports and reference collection policies. Each policy specifies avatar order, format and limits.
- `providerBase.js` owns the common provider contract, generation URL construction and network error classification. `a1111.js` owns AUTOMATIC1111/Forge generation and catalog requests.
- `references.js` owns character/persona libraries, reference descriptions, context images and imports.
- `parser.js` reads message instructions and associates source tags with rendered media.
- `pipeline.js` owns generation locks, retries, cancellation and persistence. New generation, single retry and batch retry share the media lifecycle.
- `ui.js` composes settings sections and binds controls. `promptLibraryUi.js` owns Styles and Negatives selection, filtering and editing.
- `characterLibraryUi.js` owns character library navigation and generation management. `generationImages.js` validates deletion paths and protects reference files.
- `lightbox.js` owns the modal viewer and gesture lifecycle. `imageActions.js` owns inline controls and message image hydration.

## Data And Runtime Contracts

Treat storage keys, profile fields, lorebook entries, character/persona library entries and saved message instructions as public contracts. Retain their names, types and meanings. Runtime refactoring does not introduce schema versions, rewrite stored collections or require an upgrade migration.

Keep provider-specific reference order and limits explicit. Primary avatars precede appearance images; additional references precede context images. Requests and the debug snapshot use the same avatar description builder.

A1111 model catalog failures propagate to the caller. Optional catalogs return their configured fallback on empty, malformed, HTTP or network responses. The connection check only requires a successful HTTP status. Preserve these distinctions when sharing catalog requests.

Bind a rendered image to its source instruction before generation. Preserve tag order for identical instructions. Do not guess between ambiguous media or copy arbitrary source HTML attributes into the rendered DOM. Keep source indexes stable while loading placeholders replace images.

Initial generation persists an error placeholder for retry. A failed regeneration retains the stored image. Cancellation persists a stopped placeholder. Always release generation controllers and locks. Viewer closure releases timers, frames, pointer capture, modal state and scroll locks.

Keep UI IDs, event types, validation and save behavior stable. Update focused editors in place instead of replacing their parent lists on each keystroke.

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
