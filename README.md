# Inline Image Generation

Расширение для SillyTavern. Ловит теги генерации в сообщениях ИИ и генерирует картинки через API.

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

После успешной генерации legacy-тег автоматически сохраняется в новый формат:
```html
<img data-iig-instruction='{"style":"anime","prompt":"девушка с красными волосами"}' src="/user/images/character/image.jpg">
```

Во время генерации legacy-тег сначала конвертируется во временный новый тег с `src="[IMG:GEN]"`, а затем в нём подставляется реальный путь.

### Параметры

| Параметр | Описание | Пример |
|----------|----------|--------|
| `style` | Стиль генерации (опционально) | `"anime"`, `"realistic"` |
| `prompt` | Описание картинки | `"девушка с красными волосами"` |
| `aspect_ratio` | Соотношение сторон | `"16:9"`, `"9:16"`, `"1:1"` |
| `image_size` | Разрешение (для nano-banana) | `"1K"`, `"2K"`, `"4K"` |
| `quality` | Качество (для OpenAI) | `"standard"`, `"hd"` |

## Настройки

Открыть Extensions → Генерация картинок

### Основные

- **Тип API**: OpenAI-совместимый, Gemini (nano-banana) или Naistera
- **URL эндпоинта**: базовый URL API
- **API ключ**: ключ авторизации (для Naistera это ваш токен)
- **Модель**: выбрать из списка (кнопка обновления подтягивает модели с `/v1/models`)
- **Размер**: 1024x1024, 1792x1024, 1024x1792, 512x512 (для OpenAI)
- **Качество**: standard / hd (для OpenAI)

### Для nano-banana

- **Соотношение сторон**: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
- **Разрешение**: 1K, 2K, 4K

### Референсы (nano-banana)

Отправка аватарок как референсов для консистентной генерации персонажей:

- **Отправлять аватар {{char}}** — автоматически берётся аватар текущего персонажа
- **Отправлять аватар {{user}}** — выбирается вручную из списка `/User Avatars/`

### Отладка

- **Экспорт логов** — скачать файл с логами для диагностики проблем

## Поддерживаемые API

**OpenAI-совместимый** — `/v1/images/generations`
- DALL-E, Midjourney, Stable Diffusion, FLUX и прочие через различных провайдеров/прокси

**Gemini-совместимый** — `/v1beta/models/{model}:generateContent`
- Nano Banana/Nano Banana Pro через Google/прокси

**Naistera** — `/api/generate`
- Авторизация: `Authorization: Bearer <token>`
- URL эндпоинта в настройках: `https://naistera.org/api/generate` (или `https://naistera.org` — расширение добавит `/api/generate`)
- Тело: `{ "prompt": "...", "model": "grok|nano banana|nano banana pro|nano banana 2", "aspect_ratio": "3:2", "preset": "digital" }`
- Ответ: `{ "data_url": "data:image/png;base64,...", "content_type": "image/png" }`
- В настройках Naistera доступны параметры: `model`, `aspect_ratio` и `preset` (по умолчанию).

## Как работает

1. ИИ пишет сообщение с тегом `<img data-iig-instruction='...' src="[IMG:GEN]">`
2. Расширение парсит тег, показывает спиннер
3. Собирает референсы (если включены)
4. Отправляет запрос на API
5. Заменяет `src="[IMG:GEN]"` на реальный путь к картинке
6. Сохраняет в чат

## Файлы

```
manifest.json  — метаданные расширения
index.js       — логика
style.css      — стили
prompt.md      — пример промпта для ИИ
```
