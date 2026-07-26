import { AppThemeService } from '@affine/core/modules/theme';
import { useService } from '@toeverything/infra';
import { ThemeProvider as NextThemeProvider, useTheme } from 'next-themes';
import type { PropsWithChildren } from 'react';
import { useEffect } from 'react';

const themes = ['dark', 'light'];

function ThemeObserver() {
  const { resolvedTheme } = useTheme();
  const service = useService(AppThemeService);

  useEffect(() => {
    service.appTheme.theme$.next(resolvedTheme);
  }, [resolvedTheme, service.appTheme.theme$]);

  return null;
}

export const ThemeProvider = ({ children }: PropsWithChildren) => {
  return (
    // ClickDz Work defaults to LIGHT rather than next-themes' built-in
    // 'system'. Merchants run this on mid-range Android phones — frequently
    // outdoors or under bright shop lighting — where a light surface is more
    // legible, and where the OS-level dark mode is often on by default for
    // battery reasons rather than as a deliberate preference for this app.
    //
    // This only sets the value used when NOTHING is persisted yet. next-themes
    // still writes the user's explicit pick to storage, so 'System' / 'Dark'
    // remain fully selectable in Settings → Appearance and any existing choice
    // is honoured untouched.
    <NextThemeProvider themes={themes} enableSystem={true} defaultTheme="light">
      {children}
      <ThemeObserver />
    </NextThemeProvider>
  );
};
