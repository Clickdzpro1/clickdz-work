import { STUDIOS } from '@affine/core/modules/studio/registry';
import type { useI18n } from '@affine/i18n';
import type { createStore } from 'jotai';

import type { WorkbenchService } from '../modules/workbench';
import { registerAffineCommand } from './registry';

export function registerClickDzStudioCommands({
  workbenchService,
}: {
  t: ReturnType<typeof useI18n>;
  workbenchService: WorkbenchService;
  store?: ReturnType<typeof createStore>;
}) {
  const workbench = workbenchService.workbench;
  const unsubs: Array<() => void> = [];

  // Icons come from the boot-safe registry only (no direct @blocksuite/icons/rc
  // import here — a missing rc icon would crash at boot).
  const iconFor = (id: string) => STUDIOS.find(s => s.id === id)?.icon();

  // ---- studio navigation commands (one per registry entry, kept in sync) ----
  for (const studio of STUDIOS) {
    unsubs.push(
      registerAffineCommand({
        id: `clickdz:goto-${studio.id}`,
        category: 'affine:navigation',
        icon: studio.icon(),
        label: `Ouvrir ${studio.label}`,
        run() {
          workbench.open(studio.route);
        },
      })
    );
  }

  // ---- creation actions (land on the studio route; the page opens the action UI) ----
  unsubs.push(
    registerAffineCommand({
      id: 'clickdz:new-hermes-run',
      category: 'affine:creation',
      icon: iconFor('hermes'),
      label: 'New Hermes run',
      run() {
        workbench.open('/hermes');
      },
    })
  );

  unsubs.push(
    registerAffineCommand({
      id: 'clickdz:new-openclaw-task',
      category: 'affine:creation',
      icon: iconFor('openclaw'),
      label: 'New OpenClaw task',
      run() {
        workbench.open('/openclaw');
      },
    })
  );

  unsubs.push(
    registerAffineCommand({
      id: 'clickdz:open-shop-dashboard',
      category: 'affine:creation',
      icon: iconFor('shoperp'),
      label: 'Open Shop dashboard',
      run() {
        workbench.open('/shoperp');
      },
    })
  );

  return () => {
    unsubs.forEach(unsub => unsub());
  };
}
