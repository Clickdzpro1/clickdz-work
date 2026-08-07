import type { RouteObject } from 'react-router-dom';

export const workbenchRoutes = [
  {
    path: '/chat',
    lazy: () => import('./pages/workspace/chat/index'),
  },
  {
    // ClickDz Apps — the App Builder's own front door. Previously the "ClickDz
    // Apps" studio pointed at '/chat', making it byte-identical to the plain AI
    // entry and leaving zero-project merchants with no builder in sight.
    path: '/apps',
    lazy: () => import('./pages/workspace/apps/index'),
  },
  {
    path: '/all',
    lazy: () => import('./pages/workspace/all-page/all-page'),
  },
  {
    path: '/collection',
    lazy: () => import('./pages/workspace/all-collection'),
  },
  {
    path: '/collection/:collectionId',
    lazy: () => import('./pages/workspace/collection/index'),
  },
  {
    path: '/tag',
    lazy: () => import('./pages/workspace/all-tag'),
  },
  {
    path: '/tag/:tagId',
    lazy: () => import('./pages/workspace/tag'),
  },
  {
    path: '/trash',
    lazy: () => import('./pages/workspace/trash-page'),
  },
  {
    path: '/:pageId',
    lazy: () => import('./pages/workspace/detail-page/detail-page'),
  },
  {
    path: '/:pageId/attachments/:attachmentId',
    lazy: () => import('./pages/workspace/attachment/index'),
  },
  {
    path: '/journals',
    lazy: () => import('./pages/workspace/journals'),
  },
  {
    path: '/vdz',
    lazy: () => import('./pages/workspace/vdz/index'),
  },
  {
    path: '/vpic',
    lazy: () => import('./pages/workspace/vpic/index'),
  },
  {
    // WS14 — WhatsappMax studio. Route stays registered unconditionally (like
    // /vpic); only the sidebar VISIBILITY is gated (caps.whatsappmaxEnabled), so a
    // bookmarked/deep-linked /whatsappmax works even before the entry appears.
    path: '/whatsappmax',
    lazy: () => import('./pages/workspace/whatsappmax/index'),
  },
  {
    path: '/voice',
    lazy: () => import('./pages/workspace/voice/index'),
  },
  {
    path: '/integrations',
    lazy: () => import('./pages/workspace/integrations/index'),
  },
  {
    path: '/shoperp',
    lazy: () => import('./pages/workspace/shoperp/index'),
  },
  {
    // Promoted out of the ERP dashboard's tab strip to a top-level sidebar
    // entry — see modules/studio/registry.ts. The tab still exists in
    // shoperp/dashboard.tsx too.
    path: '/slidepro',
    lazy: () => import('./pages/workspace/slidepro/index'),
  },
  {
    path: '/coursepro',
    lazy: () => import('./pages/workspace/coursepro/index'),
  },
  {
    path: '/socialplus',
    lazy: () => import('./pages/workspace/socialplus/index'),
  },
  {
    path: '/zoomplus',
    lazy: () => import('./pages/workspace/zoomplus/index'),
  },
  {
    path: '/hermes',
    lazy: () => import('./pages/workspace/hermes/index'),
  },
  {
    path: '/openclaw',
    lazy: () => import('./pages/workspace/openclaw/index'),
  },
  {
    path: '/agents',
    lazy: () => import('./pages/workspace/agents/index'),
  },
  {
    path: '/agents/new',
    lazy: () => import('./pages/workspace/agents/create-agent'),
  },
  {
    path: '/agents/runs',
    lazy: () => import('./pages/workspace/agents/runs'),
  },
  {
    path: '/agents/run/:id',
    lazy: () => import('./pages/workspace/agents/run'),
  },
  {
    path: '/agents/connections',
    lazy: () => import('./pages/workspace/agents/connections'),
  },
  {
    path: '/agents/triggers',
    lazy: () => import('./pages/workspace/agents/triggers'),
  },
  {
    path: '/agents/artifacts',
    lazy: () => import('./pages/workspace/agents/artifacts'),
  },
  {
    path: '/settings',
    lazy: () => import('./pages/workspace/settings'),
  },
  {
    path: '*',
    lazy: () => import('./pages/404'),
  },
] satisfies RouteObject[];
