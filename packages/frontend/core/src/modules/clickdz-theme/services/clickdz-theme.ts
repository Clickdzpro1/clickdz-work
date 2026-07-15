import { LiveData, Service } from '@toeverything/infra';
import { map } from 'rxjs';

import type { GlobalState } from '../../storage';
import {
  CLICKDZ_THEME_MAP,
  type ClickDzTheme,
  DEFAULT_CLICKDZ_THEME_ID,
} from '../themes';

/**
 * Persists and exposes the currently-selected ClickDz theme preset.
 *
 * Storage mirrors {@link ThemeEditorService}: a single `GlobalState` key,
 * persisted across sessions via the same GlobalState/localStorage backend the
 * rest of the app uses. The DOM side-effects (injecting the stylesheet, setting
 * `data-cdz-theme`, switching the light/dark base) live in the
 * `ClickDzThemeModifier` React component so this service stays render-free.
 */
export class ClickDzThemeService extends Service {
  constructor(public readonly globalState: GlobalState) {
    super();
  }

  private readonly _key = 'clickdz-theme';

  /** Selected theme id, falling back to the default when unset/invalid. */
  themeId$ = LiveData.from<string>(
    this.globalState
      .watch<string>(this._key)
      .pipe(
        map(value =>
          value && CLICKDZ_THEME_MAP[value]
            ? value
            : DEFAULT_CLICKDZ_THEME_ID
        )
      ),
    DEFAULT_CLICKDZ_THEME_ID
  );

  /**
   * Whether a valid preset is actually persisted (vs. falling back to the
   * default). Used by the applier to only enforce a preset's light/dark base
   * once the user has explicitly picked one — so we never yank an existing
   * user's mode on first load.
   */
  explicitlySet$ = LiveData.from<boolean>(
    this.globalState
      .watch<string>(this._key)
      .pipe(map(value => !!value && !!CLICKDZ_THEME_MAP[value])),
    false
  );

  /** Resolved theme definition for the current selection. */
  theme$ = this.themeId$.map(
    (id): ClickDzTheme =>
      CLICKDZ_THEME_MAP[id] ?? CLICKDZ_THEME_MAP[DEFAULT_CLICKDZ_THEME_ID]
  );

  get themeId() {
    return this.themeId$.value;
  }

  setTheme(id: string) {
    if (!CLICKDZ_THEME_MAP[id]) return;
    this.globalState.set(this._key, id);
  }
}
