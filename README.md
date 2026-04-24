# Inline Image Generation

Расширение для SillyTavern. Ловит теги генерации в сообщениях ИИ и генерирует картинки через выбранный API.

Поддерживаемые провайдеры: **OpenAI-совместимый**, **Gemini**, **OpenRouter**, **Electron Hub**, **Naistera**.

Текущий релиз: **v2.0.0-beta** (ветка `v2.0-beta`).

## Что нового в v2.0

- **Лорбуки** — множественные именованные коллекции референсов с переключением, enable/disable, CRUD и миграцией старых refs в лорбук «My library».
- **Группы / приоритет / regex / secondary keys** — каждая запись имеет категорию, числовой приоритет, опциональный regex-режим для имени и AND-список вторичных ключей.
- **Макрос `{{iig-book}}`** — вставляется в карточку персонажа / пресет и раскрывается в структурированный список всех enabled-лорбуков (с группами), чтобы LLM видела какие триггеры доступны. В Debug-секции есть кнопка «Show `{{iig-book}}` preview».
- **Export / Import лорбуков** — JSON с полями кроме картинок; перед экспортом — предупреждение «заполните `imageUrl` вручную, чтобы получатель мог их скачать». Импорт — из URL или локального файла, автоматически скачивает картинки из `imageUrl`.
- **Connection profiles** — именованные снапшоты настроек подключения (apiType / endpoint / key / model / size / raw / …) с Save / Save As / Rename / Remove.
- **Редактируемая Reference instruction** — «критический» префикс prompt'а, который заставляет модель копировать внешность с референсов. Можно выключить полностью или отредактировать; работает для всех провайдеров с refs.
- **Show last request** — в Debug popup с финальным промптом, matched references (какое имя/alias/regex сработало, из какого лорбука, с какой группой и приоритетом), превью отправленных картинок и метаданными.
- **Raw endpoint** — галочка «использовать URL как есть», не дописывая `/v1/images/generations` и т.д. Для прокси с нестандартным путём.
- **Friendly errors** — моды `moderation_blocked`, `billing_hard_limit_reached`, rate-limit, auth, model-not-found, network, timeout показываются читаемыми сообщениями.
- **i18n** — встроенный English + переводы `ru-ru`, `uk-ua` (~236 ключей).

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
- **Лорбуки** — именованные коллекции дополнительных референсов. Каждая запись имеет:
  - имя / список алиасов через запятую,
  - описание,
  - картинку (загрузка файла, загрузка по URL через кнопку 🔗, или путь из импортированного лорбука),
  - matchMode: `Always send` (вне зависимости от prompt) или `Send on match`,
  - group — категория для макроса `{{iig-book}}`,
  - priority — число, высокий приоритет идёт раньше при усечении по лимиту провайдера,
  - regex — опциональный флаг: имя трактуется как JS-regex (`/pattern/flags` или просто `pattern` с флагами `iu` по умолчанию),
  - secondary keys — comma-separated AND-список дополнительных условий (все должны встретиться в prompt).

Matcher идёт по всем enabled-лорбукам сразу, сортирует найденные refs по `priority desc`. Если сматченных refs больше, чем принимает провайдер — в status-строке появится предупреждение, лишние отбрасываются по приоритету.

Максимум референсов на один запрос зависит от модели:

| Модель / семейство | Max refs |
|--------------------|---------:|
| OpenAI gpt-image-* | 5 |
| OpenAI / Electron Hub flux-1-kontext-* | 1 |
| Gemini 2.5 Flash Image (Nano Banana) | 3 |
| Gemini 3 Pro Image (Nano Banana Pro) | 11 |
| Gemini 3.1 Flash Image (Nano Banana 2) | 14 |
| OpenRouter (Gemini через OR) | = GEMINI-модель |

### Макрос `{{iig-book}}`

Вставляется в текстовое поле карточки персонажа или пресета. При генерации сообщения LLM получает развёрнутый список всех enabled-лорбуков, например:

```
=== My library ===
[characters]
alice, the red mage (alice) — red-haired mage with green eyes

[locations]
tavern (tavern) — cozy wooden inn

=== Fantasy World ===
[items]
excalibur (excalibur) — legendary sword
```

Формат строки: `full-name (primary-trigger) — description`. Если enabled только один лорбук — заголовок `=== name ===` не выводится. Debug → «Show `{{iig-book}}` preview» покажет актуальный рендер.

### Reference instruction

Глобальный префикс prompt'а, применяемый только когда провайдеру отправляется хотя бы один reference image. Дефолтный текст — строгая инструкция копировать внешность с референсов. Редактируется в секции References → Reference instruction, выключается галочкой, сбрасывается к дефолту кнопкой Reset to default. Применяется ко всем провайдерам с refs (OpenAI /edits, ElectronHub /edits, Gemini, OpenRouter, Naistera).

### Connection profiles

В верхней части настроек — dropdown с профилями подключения. Каждый профиль — снапшот полей: `apiType`, `endpoint`, `apiKey`, `model`, `size`, `quality`, `aspectRatio`, `imageSize`, `naisteraModel`, `naisteraAspectRatio`, `rawEndpoint`. Кнопки: Save (перезапись активного) / Save As (новый) / Rename / Remove.

### Формат экспорта лорбука

```json
{
  "kind": "iig-lorebook",
  "version": 1,
  "name": "My library",
  "refs": [
    {
      "name": "alice, the red mage",
      "description": "red-haired mage with green eyes",
      "matchMode": "match",
      "enabled": true,
      "group": "characters",
      "priority": 0,
      "useRegex": false,
      "secondaryKeys": "",
      "imageUrl": ""
    }
  ]
}
```

Картинки **не** включаются в экспорт (base64 раздул бы файл и утек бы приватный контент). Перед шарингом заполни поле `imageUrl` у каждого нужного ref прямой ссылкой на картинку — при импорте они скачаются автоматически.

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
manifest.json      — метаданные расширения + i18n-маппинг
index.js           — entry-point (init, миграции, регистрация {{iig-book}})
style.css          — стили
prompt.md          — пример системного промпта для LLM
error.svg          — плейсхолдер ошибки
i18n/
  ru-ru.json       — перевод на русский
  uk-ua.json       — перевод на украинский
src/
  settings.js      — defaults, логгер, стили, refInstruction, lorebooks,
                     connection profiles, миграции, last-request snapshot
  utils.js         — data URL / base64 / upload / ProviderError / fetchWithTimeout
  providers.js     — Provider base + OpenAI/Gemini/OpenRouter/ElectronHub/Naistera,
                     capabilities, raw-endpoint, max-refs helper
  references.js    — аватары, previous-context, lorebook UI HTML,
                     {{iig-book}} render + register, JSON import/export
  parser.js        — парсер тегов, JSON-инструкции, matcher
                     (regex / secondary keys / priority / lorebook-aggregation),
                     построение финального промпта
  pipeline.js      — генерация с retry, обработка сообщения, перегенерация,
                     snapshot builder, friendly error classifier
  ui.js            — отрисовка секций настроек и обработчики (connection profiles,
                     lorebook bar, refs, styles, debug, popups)
  events.js        — интеграция с SillyTavern (CHARACTER_MESSAGE_RENDERED и т.д.)
  i18n.js          — реэкспорт { t, translate } из ST's i18n
```
