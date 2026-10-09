# Inline Image Generation

A SillyTavern extension that catches generation tags in AI messages and renders images through your chosen API.

Supported providers: **OpenAI-compatible**, **xAI Imagine**, **Gemini-compatible**, **OpenRouter**, **Electron Hub**, **Naistera**, **NovelAI**, **AUTOMATIC1111 / Forge**.

Russian version: [README.md](./README.md)

## Tag format

### New format (recommended)

```html
<img data-iig-instruction='{"style":"anime","prompt":"girl with red hair"}' src="[IMG:GEN]">
```

After generation the extension replaces `src="[IMG:GEN]"` with the real path:
```html
<img data-iig-instruction='{"style":"anime","prompt":"..."}' src="/user/images/character/image.jpg">
```

The LLM keeps seeing the same structure but knows: a real path = already generated.

### Legacy format (still supported)

```
[IMG:GEN:{"style":"anime","prompt":"girl with red hair"}]
```

After a successful generation the legacy tag is automatically converted into the new format.

### Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `style` | Style hint (optional) | `"anime"`, `"realistic"` |
| `prompt` | Image description | `"girl with red hair"` |
| `aspect_ratio` | Aspect ratio | `"16:9"`, `"9:16"`, `"1:1"` |
| `image_size` | Resolution (xAI / Gemini / OpenRouter Gemini) | `"1K"`, `"2K"`, `"4K"` |
| `quality` | Quality (xAI / OpenAI / Electron Hub) | `"low"`, `"medium"`, `"high"`, `"hd"` |

## Settings

Open Extensions → Image Generation.

### Connection profiles

At the top of the settings there is a profile dropdown. Each profile is a snapshot of connection fields (API type, endpoint, key, model, size, raw mode, etc.). Buttons: Save (overwrite current), Save As (new), Rename, Remove.

### General

- **API type** — provider selector.
- **Endpoint URL** — base URL. xAI / OpenRouter / Electron Hub / Naistera have defaults, the field can be empty.
- **Raw endpoint** — use the URL as-is, do not append `/v1/images/generations` / `/chat/completions` and so on. In this mode the model name is typed in by hand.
- **API key** — authorization key.
- **Model** — the 🔄 button loads the catalog exposed by the selected provider.

### References

Available for providers and models that support image-to-image:

- **{{char}} avatar** / **{{user}} avatar** — character and user avatars (active persona or manual choice).
- **Image context** — the last N previously generated images in the chat.
- **Lorebooks** — named collections of additional references. Create, rename, import, or delete collections next to the dropdown.
- **Reference instruction** — prompt prefix that tells the model to precisely copy appearance from the reference images. Sent only when at least one ref is actually passed to the provider. Can be disabled or edited.

A ref entry has: name (or a comma-separated list of aliases), description, image (file / URL), mode `Always send` or `Send on match`, group, numeric priority, regex flag (name as a JS regex), secondary keys (AND-list of extra conditions).

**Simple** searches all lorebooks using names and comma-separated aliases as whole words, regardless of case. Each card has its own enable switch and sending mode. **Power** applies lorebook switches, regex, secondary keys, and priority. All secondary keys must occur in the image-generation prompt.

Enabled entries can contain an image, a description, or both. **Send reference descriptions from lorebook** adds descriptions to the final prompt. Models without image-reference support receive descriptions from all matching enabled entries, including entries with images. Image previews appear dimmed and upload controls are disabled; names, descriptions, sending rules and enable switches remain editable. Entries without descriptions are not sent to text-only models. Selecting an image-capable model uses the saved image. The `{{iig-book}}` macro includes descriptions available to the selected model. Image attachments follow the model's reference limit.

### Styles and negative prompts

The **Styles & Negatives** library has two tabs: **Styles** and **Negative prompts**. Each tab has its own active entry, search, editor and enable switch. Opening an entry selects it for editing; **Activate** applies it to generation.

An active negative prompt supplies undesired content for V4.5, V5 High and V5 Curated on NovelAI and Naistera. Disable it to use the custom **Negative prompt** field in **Generation**. Medium uses a fixed negative prompt. Other providers use their own settings.

### Direct NovelAI

Select **NovelAI**, enter a persistent NovelAI API token and choose **V5 Full**, **V5 Full Medium**, **V5 Curated**, **V4.5 Full** or **V4.5 Curated**. The default endpoint is `https://image.novelai.net`.

NovelAI and NovelAI through Naistera default to 23 steps, guidance 7, rescale 0 and Euler Ancestral. **V5 Full Medium** uses 14 steps, Euler Ancestral and a fixed negative prompt. Guidance is adjustable. High settings are retained when switching models.

In **Generation**, choose **Small / Normal / Big** and a default aspect ratio. A request's aspect ratio takes priority for that generation; requests without one use the setting. Size comes from settings. The extension converts this pair to width and height when sending the request:

| Aspect ratio | Small | Normal | Big |
| --- | --- | --- | --- |
| 1:1 | 640x640 | 1024x1024 | 1472x1472 |
| 2:3 | 512x768 | 832x1216 | 1024x1536 |
| 3:2 | 768x512 | 1216x832 | 1536x1024 |
| 9:16 | 448x832 | 768x1344 | 1088x1920 |
| 16:9 | 832x448 | 1344x768 | 1920x1088 |

Aspect ratios are nominal: dimensions use NovelAI presets and a 64-pixel grid. See [NovelAI image sizes](https://docs.novelai.net/en/image/#image-resolution). Steps, CFG scale, CFG rescale, seed and sampler are also available. V4.5 accepts noise schedule and **Skip CFG above sigma** (`0` disables it). Seed `-1` chooses a random seed. These settings are saved in connection profiles.

Separate character prompts with `|` or `\|`: `scene | 1boy | 1girl`. **Send character descriptions** controls descriptions from the character/persona library; **Send as character prompt** adds them as separate character captions. Direct NovelAI generates from text and does not attach avatars, image references or image context.

Requests use [`POST /ai/generate-image`](https://image.novelai.net/docs/index.html) with a JSON response. Steps and resolution can affect Anlas usage; check [NovelAI's guidance](https://docs.novelai.net/en/image/stepsguidance/) before raising them.

### Browser checks

With Playwright available to Node (use `NODE_PATH` for an external installation), run `node tests/novelai-e2e.cjs` and `node tests/naistera-parameters-e2e.cjs`. Set `IIG_BROWSER_CHANNEL=msedge` to use installed Edge. The tests open the real settings UI and generation pipeline with simulated Tavern state and provider responses. Reports and desktop/mobile screenshots are written to `tests/artifacts/novelai` and `tests/artifacts/naistera-parameters`.

Run matching and request tests with `node --experimental-vm-modules --test tests/reference-matching.test.cjs`. Tests use an in-memory configuration and simulated HTTP responses.

Simple mode uses library order; power mode uses descending priority. Image attachments are selected within the provider's reference limit.

Per-request reference limits depend on the model:

| Model / family | Max refs |
|----------------|---------:|
| OpenAI gpt-image-* | 5 |
| xAI Grok Imagine Image | 3 |
| OpenAI / Electron Hub flux-1-kontext-* | 1 |
| Gemini 2.5 Flash Image (Nano Banana) | 3 |
| Gemini 3 Pro Image (Nano Banana Pro) | 11 |
| Gemini 3.1 Flash Image (Nano Banana 2) | 14 |
| OpenRouter (Gemini via OR) | = GEMINI model |

### Import / export lorebooks

Next to the lorebook dropdown: Import from URL (🔗), Import from file (⬇), Export (⬆).

Format is JSON:

```json
{
  "kind": "iig-lorebook",
  "version": 1,
  "name": "My library",
  "refs": [
    { "name": "alice", "description": "red-haired mage",
      "group": "characters", "matchMode": "match", "enabled": true,
      "priority": 0, "useRegex": false, "secondaryKeys": "",
      "imageUrl": "" }
  ]
}
```

Images are **not** included in the export. To let someone reuse your lorebook, fill the `imageUrl` field of each ref with a direct link — images will be downloaded automatically on import.

### `{{iig-book}}` macro

Paste it into a character card or preset. It expands into a list of all enabled lorebooks with groups, so the LLM can see which triggers are available:

```
=== My library ===
[characters]
alice, the red mage (alice) — red-haired mage with green eyes

[locations]
tavern (tavern) — cozy wooden inn
```

Line format: `full-name (primary-trigger) — description`. If only one lorebook is enabled the `=== name ===` header is omitted.

### Debug

- **Show last request** — popup with the final prompt, matched refs (which alias/regex fired, which lorebook it came from), previews of the sent images and request metadata.
- **Show `{{iig-book}}` preview** — current render of the macro.
- **Export logs** — download the extension's log file.

## Providers

### OpenAI-compatible

- Endpoint: `https://api.openai.com` (or any OpenAI-compatible proxy).
- Without references → `POST /v1/images/generations` (JSON).
- With references → `POST /v1/images/edits` (multipart). For gpt-image-* several references are sent as `image[]`.
- Supported models: gpt-image-1, gpt-image-1.5, flux-1-kontext-*, dall-e-2, dall-e-3.

### xAI Imagine

- Endpoint: `https://api.x.ai` (default).
- Without references → `POST /v1/images/generations` (JSON).
- With references → `POST /v1/images/edits` (JSON). The `image` field is used for one image and `images` for two or three.
- `grok-imagine-image-2.0` supports aspect ratio, `1k` / `2k` resolution, and `low` / `medium` quality.

### Gemini

- Endpoint: `https://generativelanguage.googleapis.com` (or a proxy with the same format).
- `POST /v1beta/models/{model}:generateContent` — inlineData parts for references + text.
- Models: `gemini-2.5-flash-image`, `gemini-3-pro-image-preview`, `gemini-3.1-flash-image-preview`. Proxy aliases `nano-banana`, `nano-banana-pro`, `nano-banana-2` are supported.
- `image_size` is omitted for 2.5 Flash (the model does not know the parameter).

### OpenRouter

- Endpoint: `https://openrouter.ai/api/v1` (default).
- `POST /chat/completions` with `modalities: ["image", "text"]` (Gemini models) or `["image"]` (flux, sourceful).
- References are placed into `messages[0].content` as `{type:"image_url", image_url:{url: dataURL}}`.
- `image_config: { aspect_ratio, image_size }` (snake_case).
- Model list: `GET /models?input_modalities=image,text&output_modalities=image`.

### Electron Hub

- Endpoint: `https://api.electronhub.ai` (default). Keys look like `ek-*`.
- Same protocol as OpenAI (`/v1/images/generations` JSON, `/v1/images/edits` multipart).
- `/v1/images/edits` takes a single `image` field (not `image[]`): flux-1-kontext-* accepts **one** reference.
- Model list: `GET /v1/models` filtered by the `endpoints` field (`/images/generations` or `/images/edits`).

### Naistera

- Endpoint: `https://naistera.org` (default). Token comes from the Telegram bot.
- `POST /api/generate`, body: `{ prompt, negative_prompt?, model, aspect_ratio, preset?, reference_images? }`.
- Can use polling: send `sync: false`, receive `job_id`, then read
  `GET /api/generate/jobs/{job_id}` with the same Bearer token.
- Available models are loaded from `GET /api/models` using the configured token. Model names, reference support, and negative prompt support come from the API response.
- **Send character descriptions** can omit descriptions, add the regular description block, or append persona and character to the end of the prompt as `\| description` lines. Images are sent only to models that support references.
- For NovelAI models, the selected style is added as a plain prefix without the `[STYLE: ...]` wrapper.
- Can return video (`media_kind: "video"`) — the "Enable video generation" option.

## How generation works

1. The AI writes a message with `<img data-iig-instruction='...' src="[IMG:GEN]">`.
2. The extension parses the tag and shows a spinner instead of the image.
3. The active provider collects references (char/user/context/additional).
4. Sends a request to the API with a 600s (10 minute) timeout.
5. On network error / 429 / 5xx — automatic retry (exponential backoff).
6. The image is saved on the SillyTavern server via `/api/images/upload`.
7. `src="[IMG:GEN]"` is replaced with the real path, the message is persisted to the chat.

On error an `error.svg` with a tooltip is shown; clicking it triggers manual regeneration. Known errors (moderation, billing, rate-limit, invalid key, unavailable model, timeout) are mapped to human-readable messages.

## Localization

Built-in UI language is English. Translations: `ru-ru`, `uk-ua` in the `i18n/` folder. Wired up via `manifest.json` → `i18n`.

## Code layout

```
manifest.json      — extension metadata
index.js           — entry point (init)
style.css          — styles
prompt.md          — example system prompt for the LLM
error.svg          — error placeholder
i18n/*.json        — translations
src/
  settings.js      — defaults, logger, profiles, lorebooks, styles
  utils.js         — data URL / base64 / upload / ProviderError
  providers.js     — Provider base + OpenAI/xAI/Gemini/OpenRouter/ElectronHub/Naistera
  references.js    — avatars, previous context, lorebook UI, macro, import/export
  parser.js        — tag parser, JSON instructions, matcher
  pipeline.js      — generation with retry, message processing, regeneration
  ui.js            — settings section rendering and handlers
  events.js        — SillyTavern integration
  i18n.js          — re-export of t/translate
```
