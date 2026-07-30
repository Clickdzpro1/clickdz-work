// the following import is used to ensure the block suite editor effects are run
import '../blocksuite/block-suite-editor';

import { DebugLogger } from '@affine/debug';
import { DEFAULT_WORKSPACE_NAME } from '@affine/env/constant';
import onboardingUrl from '@affine/templates/onboarding.zip';
import { ZipTransformer } from '@blocksuite/affine/widgets/linked-doc';

import { DocsService } from '../modules/doc';
import { OrganizeService } from '../modules/organize';
import {
  getAFFiNEWorkspaceSchema,
  type WorkspacesService,
} from '../modules/workspace';

/**
 * Create a workspace for a new user.
 *
 * `seedShowcase` controls whether AFFiNE's onboarding.zip is imported. ClickDz
 * CLOUD workspaces pass false: those docs are the upstream "Getting Started" /
 * "How to use folder and Tags" tutorials, in English, about doc and edgeless
 * concepts a merchant never touches — and `ClickDzWorkspaceBoot` trashes them
 * by title at first paint anyway. Importing then immediately binning them made
 * a new merchant's very first screen an English tutorial flickering into the
 * trash. Local/electron workspaces keep the showcase, so the desktop app's
 * offline first-run is unchanged.
 */
export async function buildShowcaseWorkspace(
  workspacesService: WorkspacesService,
  flavour: string,
  workspaceName: string,
  seedShowcase = true
) {
  const meta = await workspacesService.create(flavour, async docCollection => {
    docCollection.meta.initialize();
    docCollection.doc.getMap('meta').set('name', workspaceName);
    if (!seedShowcase) return;
    const blob = await (await fetch(onboardingUrl)).blob();

    await ZipTransformer.importDocs(
      docCollection,
      getAFFiNEWorkspaceSchema(),
      blob
    );
  });

  // Nothing was seeded ⇒ nothing to look up, and no default doc to land on.
  // Skip the open/waitForDocReady round-trip entirely: it is pure latency in
  // front of a merchant who is waiting to see their shop.
  if (!seedShowcase) {
    return { meta, defaultDocId: undefined };
  }

  const { workspace, dispose } = workspacesService.open({ metadata: meta });

  await workspace.engine.doc.waitForDocReady(workspace.id);

  const docsService = workspace.scope.get(DocsService);

  // should jump to "Getting Started"
  const defaultDoc = docsService.list.docs$.value.find(p =>
    p.title$.value.startsWith('Getting Started')
  );
  const folderTutorialDoc = docsService.list.docs$.value.find(p =>
    p.title$.value.startsWith('How to use folder and Tags')
  );

  // create default organize
  if (folderTutorialDoc) {
    const organizeService = workspace.scope.get(OrganizeService);
    const folderId = organizeService.folderTree.rootFolder.createFolder(
      'First Folder',
      organizeService.folderTree.rootFolder.indexAt('after')
    );
    const firstFolderNode =
      organizeService.folderTree.folderNode$(folderId).value;
    firstFolderNode?.createLink(
      'doc',
      folderTutorialDoc.id,
      firstFolderNode.indexAt('after')
    );
  }

  dispose();

  return { meta, defaultDocId: defaultDoc?.id };
}

const logger = new DebugLogger('createFirstAppData');

let firstAppDataPromise:
  | Promise<Awaited<ReturnType<typeof buildShowcaseWorkspace>>>
  | undefined;

export function createFirstAppData(workspacesService: WorkspacesService) {
  if (workspacesService.list.workspaces$.value.length > 0) {
    return;
  }

  if (
    !BUILD_CONFIG.isMobileEdition &&
    localStorage.getItem('is-first-open') !== null
  ) {
    return;
  }

  firstAppDataPromise ??= buildShowcaseWorkspace(
    workspacesService,
    'local',
    DEFAULT_WORKSPACE_NAME
  ).finally(() => {
    firstAppDataPromise = undefined;
  });

  return firstAppDataPromise.then(({ meta, defaultDocId }) => {
    localStorage.setItem('is-first-open', 'false');
    logger.info('create first workspace', defaultDocId);
    return { meta, defaultPageId: defaultDocId };
  });
}
