import { useCatchEventCallback } from '@affine/core/components/hooks/use-catch-event-hook';
import { ServerService } from '@affine/core/modules/cloud';
import { track } from '@affine/track';
import { CloseIcon, DownloadIcon } from '@blocksuite/icons/rc';
import { useService } from '@toeverything/infra';
import clsx from 'clsx';
import { useCallback, useState } from 'react';

import * as styles from './index.css';

// Branded desktop download page (served by the ClickDz server, see
// clickdz-releases.controller.ts). Ultimate fallback for unknown platforms or
// when the release feed is unreachable.
const DOWNLOAD_PAGE_FALLBACK = 'https://work.clickdz.ai/download';

// Versionless permalink asset suffixes published on every release (see the
// artifact naming contract in publish-desktop-release.yml, mirrored by the
// /download page). Matched by lowercased name suffix, shortest name wins.
const PLATFORM_ASSET_SUFFIX: Record<string, string> = {
  windows: 'windows-x64.exe',
  macos: 'macos-arm64.dmg',
  linux: 'linux-x64.appimage',
};

interface ReleaseAsset {
  name?: string;
  url?: string;
}
interface Release {
  assets?: ReleaseAsset[];
}

function detectPlatform(): 'windows' | 'macos' | 'linux' | null {
  if (environment.isWindows) return 'windows';
  if (environment.isMacOs) return 'macos';
  if (environment.isLinux) return 'linux';
  return null;
}

function pickAsset(assets: ReleaseAsset[], suffix: string): string | null {
  const matches = assets
    .filter(a => String(a.name ?? '').toLowerCase().endsWith(suffix))
    .sort((a, b) => (a.name?.length ?? 0) - (b.name?.length ?? 0));
  return matches[0]?.url ?? null;
}

// Trigger a browser download without navigating away from the app.
function triggerDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function AppDownloadButton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  const [show, setShow] = useState(true);
  const serverService = useService(ServerService);

  const handleClose = useCatchEventCallback(() => {
    setShow(false);
  }, []);

  const resolveDownloadBase = useCallback(() => {
    // The web app is served by the ClickDz server, which also serves
    // /api/releases and /download — so the connected server's origin is the
    // right host for both.
    try {
      return new URL(serverService.server.baseUrl).origin;
    } catch {
      return 'https://work.clickdz.ai';
    }
  }, [serverService]);

  const handleClick = useCallback(() => {
    track.$.navigationPanel.bottomButtons.downloadApp();

    const base = resolveDownloadBase();
    const downloadPage = `${base}/download`;
    const platform = detectPlatform();
    const suffix = platform ? PLATFORM_ASSET_SUFFIX[platform] : undefined;

    // Unknown platform: open the branded picker page directly.
    if (!suffix) {
      open(downloadPage, '_blank', 'noopener');
      return;
    }

    // Known platform: resolve the direct installer for this OS from the live
    // release feed and stream it. Any failure falls back to the picker page.
    fetch(`${base}/api/releases?channel=stable&minimal=true`)
      .then(r => {
        if (!r.ok) throw new Error(`feed ${r.status}`);
        return r.json() as Promise<Release[]>;
      })
      .then(releases => {
        const assets = releases?.[0]?.assets ?? [];
        const assetUrl = assets.length ? pickAsset(assets, suffix) : null;
        if (assetUrl) {
          triggerDownload(assetUrl);
        } else {
          open(downloadPage, '_blank', 'noopener');
        }
      })
      .catch(() => {
        open(downloadPage, '_blank', 'noopener');
      });
  }, [resolveDownloadBase]);

  if (!show) {
    return null;
  }
  return (
    <button
      style={style}
      className={clsx([styles.root, styles.rootPadding, className])}
      onClick={handleClick}
    >
      <div className={clsx([styles.label])}>
        <DownloadIcon className={styles.icon} />
        <span className={styles.ellipsisTextOverflow}>Download App</span>
      </div>
      <div className={styles.closeIcon} onClick={handleClose}>
        <CloseIcon />
      </div>
      <div className={styles.particles} aria-hidden="true"></div>
      <span className={styles.halo} aria-hidden="true"></span>
    </button>
  );
}
