import type { RouteObject } from 'react-router-dom';

export const workbenchRoutes = [
  {
    path: '/chat',
    lazy: () => import('./pages/workspace/chat/index'),
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
