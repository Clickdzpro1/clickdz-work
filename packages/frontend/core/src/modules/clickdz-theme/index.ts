import { type Framework } from '@toeverything/infra';

import { GlobalState } from '../storage';
import { ClickDzThemeService } from './services/clickdz-theme';

export { ClickDzThemeService };
export {
  buildClickDzThemeStylesheet,
  CLICKDZ_THEME_MAP,
  CLICKDZ_THEMES,
  type ClickDzTheme,
  type ClickDzThemeBase,
  type ClickDzThemePalette,
  DEFAULT_CLICKDZ_THEME_ID,
} from './themes';

export function configureClickDzThemeModule(framework: Framework) {
  framework.service(ClickDzThemeService, [GlobalState]);
}
