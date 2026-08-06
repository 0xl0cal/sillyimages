/**
 * Thin wrapper поверх встроенного ST i18n (`/public/scripts/i18n.js`).
 *
 * Относительный путь учитывает расположение расширения:
 *   /scripts/extensions/third-party/sillyimages/src/i18n.js → /scripts/i18n.js
 *   = ../../../../i18n.js
 *
 * Импортируется из модулей расширения вместо прямого пути, чтобы:
 *   - единая точка при изменениях структуры ST;
 *   - не засорять каждый модуль длинным относительным путём.
 *
 * Использование:
 *   import { t, translate } from './i18n.js';
 *   toastr.success(t`Saved`);
 *   const label = translate('API Key');
 */

export { t, translate } from '../../../../i18n.js';
