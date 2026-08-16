// SlidePro — legacy shoperp panel shim.
//
// The old SlidePro was a broken cross-site integration that iframed an external
// presenton fork (auto-provisioned via /api/v1/apps/provision + a login shim).
// It has been DELETED and replaced by a fully native in-house studio that lives
// under ../slidepro/ and reuses the app's own copilot AI gateway + image routes.
//
// This file is kept ONLY as a thin compatibility re-export: the historical
// public symbol from this module was `SlideProPanel({ slug, readOnly, ... })`,
// consumed by ../slidepro/index.tsx (and previously by the ERP dashboard tab,
// removed in WS12). Rather than delete the module and risk a dangling import
// from code edited in parallel, it now forwards to the native studio. The
// `slug` prop maps to the studio's `workspaceId` (the same per-workspace scope
// the panel always used as its storage key); the write callbacks are accepted
// for signature-compatibility and are no-ops (the native studio autosaves to
// localStorage and never mutates workspace docs).

import { SlideProStudio } from '../slidepro/SlideProStudio';

export interface SlideProPanelProps {
  /** Per-workspace scope — used as the native studio's storage namespace. */
  slug: string;
  readOnly?: boolean;
  onWritesBlocked?: () => void;
  onMutated?: () => void;
}

export const SlideProPanel = ({ slug, readOnly = false }: SlideProPanelProps) => {
  return <SlideProStudio workspaceId={slug} readOnly={readOnly} />;
};
