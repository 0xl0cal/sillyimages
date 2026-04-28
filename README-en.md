# Inline Image Generation

A SillyTavern extension that catches generation tags in AI messages and renders images through your chosen API.

Supported providers: **OpenAI-compatible**, **Gemini-compatible**, **OpenRouter**, **Electron Hub**, **Naistera**.

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
| `image_size` | Resolution (Gemini / OpenRouter Gemini) | `"1K"`, `"2K"`, `"4K"` |
| `quality` | Quality (OpenAI / Electron Hub) | `"low"`, `"medium"`, `"high"`, `"hd"` |

## Settings

Open Extensions → Image Generation.

### Connection profiles

At the top of the settings there is a profile dropdown. Each profile is a snapshot of connection fields (API type, endpoint, key, model, size, raw mode, etc.). Buttons: Save (overwrite current), Save As (new), Rename, Remove.

### General

- **API type** — provider selector.
- **Endpoint URL** — base URL. OpenRouter / Electron Hub / Naistera have defaults, the field can be empty.
- **Raw endpoint** — use the URL as-is, do not append `/v1/images/generations` / `/chat/completions` and so on. In this mode the model name is typed in by hand.
- **API key** — authorization key.
- **Model** — list is fetched via the 🔄 button from the provider's `/v1/models`.

### References

Available for providers and models that support image-to-image:

- **{{char}} avatar** / **{{user}} avatar** — character and user avatars (active persona or manual choice).
- **Image context** — the last N previously generated images in the chat.
- **Lorebooks** — named collections of additional references. Create / Rename / Delete / Enable-toggle next to the dropdown. The matcher aggregates refs across all enabled lorebooks.
- **Reference instruction** — prompt prefix that tells the model to precisely copy appearance from the reference images. Sent only when at least one ref is actually passed to the provider. Can be disabled or edited.

A ref entry has: name (or a comma-separated list of aliases), description, image (file / URL), mode `Always send` or `Send on match`, group, numeric priority, regex flag (name as a JS regex), secondary keys (AND-list of extra conditions).

Matched refs are sorted by `priority desc`. If there are more matches than the provider accepts — the surplus is dropped, a warning is shown in the status line.

Per-request reference limits depend on the model:

| Model / family | Max refs |
|----------------|---------:|
| OpenAI gpt-image-* | 5 |
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
- `POST /api/generate`, body: `{ prompt, model, aspect_ratio, preset?, reference_images? }`.
- Models: `grok`, `grok-pro`, `nano banana 2`, `novelai`. References supported by `grok` and `nano banana 2`.
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
  providers.js     — Provider base + OpenAI/Gemini/OpenRouter/ElectronHub/Naistera
  references.js    — avatars, previous context, lorebook UI, macro, import/export
  parser.js        — tag parser, JSON instructions, matcher
  pipeline.js      — generation with retry, message processing, regeneration
  ui.js            — settings section rendering and handlers
  events.js        — SillyTavern integration
  i18n.js          — re-export of t/translate
```
