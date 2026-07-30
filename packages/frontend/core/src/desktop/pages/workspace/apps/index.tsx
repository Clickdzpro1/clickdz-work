import { ViewBody, ViewIcon, ViewTitle } from '@affine/core/modules/workbench';
import { useCallback } from 'react';

// Side-effect import: registers <clickdz-builder-home>, which in turn registers
// the <clickdz-builder-studio> overlay it hosts.
import '@affine/core/blocksuite/ai/components/ai-tools/clickdz-builder-home';

import { ensureClickDzResponsiveCss } from '@affine/core/clickdz/responsive';

const CdzResponsive = () => {
  ensureClickDzResponsiveCss();
  return null;
};

/**
 * ClickDz Apps (/apps) — the App Builder's front door.
 *
 * Previously the "ClickDz Apps" sidebar entry pointed at `/chat`, the very same
 * route as the plain AI chat item, so a merchant with no projects landed in an
 * empty conversation with no builder in sight; the Builder Studio only mounted
 * after a generation finished inside that chat, and only for users who first
 * found the "🚀 Builder" chip in the composer.
 *
 * This page gives the builder its own destination: a prompt composer, starter
 * briefs, the business-template gallery, and the user's existing projects —
 * all of which open the Builder Studio directly.
 *
 * Thin React shell over the Lit element, mirroring how /chat mounts its own
 * Lit content: the merchant-facing UI lives in the custom element.
 */
export const Component = () => {
  const onContainerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node || node.querySelector('clickdz-builder-home')) return;
    node.append(document.createElement('clickdz-builder-home'));
  }, []);

  return (
    <>
      <ViewTitle title="ClickDz Apps" />
      <ViewIcon icon="ai" />
      <ViewBody>
        <CdzResponsive />
        {/*
          `width: '100%'` is load-bearing, not decorative. ViewBody portals its
          children straight into `viewBodyContainer`, which is a flex row — a
          flex item with no width sizes to max-content, so the element's own
          `max-width: 1000px` would pin the whole page flush-left with dead
          space beside it on any wide monitor. Every sibling page (chat,
          shoperp) sets this for the same reason.

          data-cdz-surface: injects the shared responsive stylesheet. The host
          div is constrained to max-width:100% which the shared sheet enforces
          via [data-cdz-surface]*. The <clickdz-builder-home> Lit element uses
          a shadow root, so the shared stylesheet cannot reach inside it — see
          the report for what remains out of reach and which file owns it.
        */}
        <div
          data-cdz-surface=""
          style={{ height: '100%', width: '100%', maxWidth: '100%', overflow: 'hidden' }}
          ref={onContainerRef}
        />
      </ViewBody>
    </>
  );
};
