# Inline Image Generation

Расширение для SillyTavern. Ловит теги генерации в сообщениях ИИ и генерирует картинки через выбранный API.

Поддерживаемые провайдеры: **OpenAI-совместимый**, **Gemini**, **OpenRouter**, **Electron Hub**, **Naistera**.

## Формат тега

### Новый формат (рекомендуется)

```html
<img data-iig-instruction='{"style":"anime","prompt":"девушка с красными волосами"}' src="[IMG:GEN]">
```

После генерации расширение заменяет `src="[IMG:GEN]"` на реальный путь:
```html
<img data-iig-instruction='{"style":"anime","prompt":"..."}' src="/user/images/character/image.jpg">
```

LLM видит тот же формат, но понимает: есть реальный путь = уже сгенерировано.

### Legacy формат (поддерживается)

```
[IMG:GEN:{"style":"anime","prompt":"девушка с красными волосами"}]
```

После успешной генерации legacy-тег автоматически конвертируется в новый формат.

### Параметры

| Параметр | Описание | Пример |
|----------|----------|--------|
| `style` | Стиль генерации (опционально) | `"anime"`, `"realistic"` |
| `prompt` | Описание картинки | `"девушка с красными волосами"` |
| `aspect_ratio` | Соотношение сторон | `"16:9"`, `"9:16"`, `"1:1"` |
| `image_size` | Разрешение (Gemini / OpenRouter Gemini) | `"1K"`, `"2K"`, `"4K"` |
| `quality` | Качество (OpenAI / Electron Hub) | `"low"`, `"medium"`, `"high"`, `"hd"` |

## Настройки

Открыть Extensions → Генерация картинок.

### Общие

- **Тип API** — выбор провайдера.
- **URL эндпоинта** — базовый URL. Для OpenRouter / Electron Hub / Naistera есть дефолты, можно оставить пустым.
- **API ключ** — ключ авторизации.
- **Модель** — список подтягивается кнопкой 🔄 из `/v1/models` провайдера.

### Референсы

Доступны для провайдеров и моделей, которые поддерживают image-to-image:

- **Аватар {{char}}** / **Аватар {{user}}** — персонажа и пользователя (активная персона или выбор вручную).
- **Контекст картинок** — последние N сгенерированных картинок из чата.
- **Дополнительные референсы** — загруженные заранее картинки с описанием; подмешиваются в промпт если соответствующее имя встретилось в нём (или всегда, если `Always`).

Максимум референсов зависит от модели:

| Модель / семейство | Max refs |
|--------------------|---------:|
| OpenAI gpt-image-* | 5 |
| OpenAI / Electron Hub flux-1-kontext-* | 1 |
| Gemini 2.5 Flash Image (Nano Banana) | 3 |
| Gemini 3 Pro Image (Nano Banana Pro) | 11 |
| Gemini 3.1 Flash Image (Nano Banana 2) | 14 |
| OpenRouter (Gemini через OR) | = GEMINI-модель |

## Провайдеры

### OpenAI-совместимый

- Endpoint: `https://api.openai.com` (любой OpenAI-совместимый прокси).
- Без референсов → `POST /v1/images/generations` (JSON).
- С референсами → `POST /v1/images/edits` (multipart). Для gpt-image-* несколько референсов отправляются как `image[]`.
- Поддерживаемые модели: gpt-image-1, gpt-image-1.5, gpt-image-2, flux-1-kontext-*, dall-e-2, dall-e-3.

### Gemini

- Endpoint: `https://generativelanguage.googleapis.com` (или прокси с тем же форматом).
- `POST /v1beta/models/{model}:generateContent` — inlineData части для референсов + текст.
- Модели: `gemini-2.5-flash-image`, `gemini-3-pro-image-preview`, `gemini-3.1-flash-image-preview`. Поддерживаются проксирующие алиасы `nano-banana`, `nano-banana-pro`, `nano-banana-2`.
- `image_size` не отправляется для 2.5 Flash (модель параметр не знает).

### OpenRouter

- Endpoint: `https://openrouter.ai/api/v1` (дефолт).
- `POST /chat/completions` с `modalities: ["image", "text"]` (Gemini-модели) или `["image"]` (flux, sourceful).
- Референсы — в `messages[0].content` как `{type:"image_url", image_url:{url: dataURL}}`.
- `image_config: { aspect_ratio, image_size }` (snake_case).
- Список моделей: `GET /models?input_modalities=image,text&output_modalities=image`.

### Electron Hub

- Endpoint: `https://api.electronhub.ai` (дефолт). API-ключи вида `ek-*`.
- Тот же протокол, что и OpenAI (`/v1/images/generations` JSON, `/v1/images/edits` multipart).
- В `/v1/images/edits` только одно поле `image` (не `image[]`): flux-1-kontext-* принимает **один** референс.
- Список моделей: `GET /v1/models` с фильтром по полю `endpoints` (`/images/generations` или `/images/edits`).

### Naistera

- Endpoint: `https://naistera.org` (дефолт). Токен — из Telegram-бота.
- `POST /api/generate`, тело: `{ prompt, model, aspect_ratio, preset?, reference_images? }`.
- Модели: `grok`, `grok-pro`, `nano banana 2`, `novelai`. Референсы поддерживают `grok` и `nano banana 2`.
- Умеет возвращать видео (`media_kind: "video"`) — опция «Включить генерацию видео».

## Как работает генерация

1. ИИ пишет сообщение с тегом `<img data-iig-instruction='...' src="[IMG:GEN]">`.
2. Расширение парсит тег, показывает спиннер вместо картинки.
3. Активный провайдер собирает референсы (char/user/context/additional).
4. Отправляет запрос на API с таймаутом 120с.
5. При сетевой ошибке / 429 / 5xx — автоматический retry (экспоненциальный backoff).
6. Полученная картинка сохраняется на сервер SillyTavern через `/api/images/upload`.
7. `src="[IMG:GEN]"` заменяется на реальный путь, сообщение пересохраняется в чат.

При ошибке показывается `error.svg` с сообщением в tooltip; клик по нему запускает ручную перегенерацию.

## Структура кода

```
manifest.json      — метаданные расширения
index.js           — entry-point (init)
style.css          — стили
prompt.md          — пример системного промпта для LLM
error.svg          — плейсхолдер ошибки
src/
  settings.js      — дефолты, логгер, Naistera helpers, styles, additional refs
  utils.js         — data URL / base64 / upload / ProviderError
  providers.js     — Provider base + OpenAI/Gemini/OpenRouter/ElectronHub/Naistera
  references.js    — аватары персонажа/пользователя, previous-context, additional refs UI
  parser.js        — парсер тегов, JSON-инструкции, построение финального промпта
  pipeline.js      — генерация с retry, обработка сообщения, перегенерация
  ui.js            — отрисовка секций настроек и обработчики
  events.js        — интеграция с SillyTavern (CHARACTER_MESSAGE_RENDERED и т.д.)
```
