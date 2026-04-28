# Inline Image Generation

Расширение для SillyTavern. Ловит теги генерации в сообщениях ИИ и генерирует картинки через выбранный API.

Поддерживаемые провайдеры: **OpenAI-совместимый**, **Gemini-совместимый**, **OpenRouter**, **Electron Hub**, **Naistera**.

English version: [README-en.md](./README-en.md)

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

### Профили подключения

В верхней части настроек — dropdown с профилями. Каждый профиль хранит снапшот полей подключения (тип API, endpoint, ключ, модель, размер, raw-режим и т.д.). Кнопки: Save (перезаписать активный), Save As (новый), Rename, Remove.

### Общие

- **Тип API** — выбор провайдера.
- **URL эндпоинта** — базовый URL. Для OpenRouter / Electron Hub / Naistera есть дефолты, можно оставить пустым.
- **Raw endpoint** — использовать URL как есть, не дописывая `/v1/images/generations` / `/chat/completions` и т.п. В этом режиме имя модели вводится вручную.
- **API ключ** — ключ авторизации.
- **Модель** — список подтягивается кнопкой 🔄 из `/v1/models` провайдера.

### Референсы

Доступны для провайдеров и моделей, которые поддерживают image-to-image:

- **Аватар {{char}}** / **Аватар {{user}}** — персонажа и пользователя (активная персона или выбор вручную).
- **Контекст картинок** — последние N сгенерированных картинок из чата.
- **Лорбуки** — именованные коллекции дополнительных референсов. Доступны создание / переименование / удаление / enable-toggle через кнопки рядом с dropdown списком. Matcher собирает референсы изо всех включенных лорбуков.
- **Reference instruction** — префикс prompt'а, который заставляет модель точно копировать внешность с референсов. Отправляется только когда хотя бы один ref уходит провайдеру. Можно выключить или отредактировать.

Запись ref'а содержит: имя (или список алиасов через запятую), описание, картинку (файл / URL), режим `Always send` или `Send on match`, группу, числовой приоритет, флаг regex (имя как JS-regex), secondary keys (AND-список дополнительных условий).

Сматченные refs сортируются по `priority desc`. Если их больше, чем принимает провайдер — лишние отбрасываются, в status-строке показывается предупреждение.

Максимум референсов на один запрос зависит от модели:

| Модель / семейство | Max refs |
|--------------------|---------:|
| OpenAI gpt-image-* | 5 |
| OpenAI / Electron Hub flux-1-kontext-* | 1 |
| Gemini 2.5 Flash Image (Nano Banana) | 3 |
| Gemini 3 Pro Image (Nano Banana Pro) | 11 |
| Gemini 3.1 Flash Image (Nano Banana 2) | 14 |
| OpenRouter (Gemini через OR) | = GEMINI-модель |

### Импорт / экспорт лорбуков

Рядом с dropdown'ом лорбука — кнопки Import from URL (🔗), Import from file (⬇), Export (⬆).

Формат — JSON:

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

Картинки в экспорт **не включаются**. Чтобы получатель лорбука смог их подтянуть, заполни поле `imageUrl` у каждого нужного ref прямой ссылкой — при импорте они скачаются автоматически.

### Макрос `{{iig-book}}`

Вставляется в карточку персонажа или пресет. Раскрывается в список всех enabled-лорбуков с группами — чтобы LLM видела, какие триггеры доступны:

```
=== My library ===
[characters]
alice, the red mage (alice) — red-haired mage with green eyes

[locations]
tavern (tavern) — cozy wooden inn
```

Формат строки: `full-name (primary-trigger) — description`. Если enabled один лорбук — заголовок `=== name ===` не выводится.

### Debug

- **Show last request** — popup с финальным промптом, сматченными refs (какое имя/alias/regex сработало, из какого лорбука), превью отправленных картинок и метаданными запроса.
- **Show `{{iig-book}}` preview** — актуальный рендер макроса.
- **Export logs** — скачать лог расширения.

## Провайдеры

### OpenAI-совместимый

- Endpoint: `https://api.openai.com` (любой OpenAI-совместимый прокси).
- Без референсов → `POST /v1/images/generations` (JSON).
- С референсами → `POST /v1/images/edits` (multipart). Для gpt-image-* несколько референсов отправляются как `image[]`.
- Поддерживаемые модели: gpt-image-1, gpt-image-1.5, flux-1-kontext-*, dall-e-2, dall-e-3.

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
4. Отправляет запрос на API с таймаутом 600с (10 минут).
5. При сетевой ошибке / 429 / 5xx — автоматический retry (экспоненциальный backoff).
6. Полученная картинка сохраняется на сервер SillyTavern через `/api/images/upload`.
7. `src="[IMG:GEN]"` заменяется на реальный путь, сообщение пересохраняется в чат.

При ошибке показывается `error.svg` с сообщением в tooltip; клик по нему запускает ручную перегенерацию. Известные ошибки (цензура, биллинг, rate-limit, невалидный ключ, недоступная модель, timeout) показываются читаемыми сообщениями.

## Локализация

Встроенный язык интерфейса — English. Переводы: `ru-ru`, `uk-ua` в папке `i18n/`. Подключение — через `manifest.json` → `i18n`.

## Структура кода

```
manifest.json      — метаданные расширения
index.js           — entry-point (init)
style.css          — стили
prompt.md          — пример системного промпта для LLM
error.svg          — плейсхолдер ошибки
i18n/*.json        — переводы
src/
  settings.js      — дефолты, логгер, профили, лорбуки, стили
  utils.js         — data URL / base64 / upload / ProviderError
  providers.js     — Provider base + OpenAI/Gemini/OpenRouter/ElectronHub/Naistera
  references.js    — аватары, previous-context, лорбук UI, макрос, import/export
  parser.js        — парсер тегов, JSON-инструкции, matcher
  pipeline.js      — генерация с retry, обработка сообщения, перегенерация
  ui.js            — отрисовка секций настроек и обработчики
  events.js        — интеграция с SillyTavern
  i18n.js          — реэкспорт t/translate
```
