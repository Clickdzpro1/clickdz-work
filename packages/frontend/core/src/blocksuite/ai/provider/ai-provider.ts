import type { EditorHost } from '@blocksuite/affine/std';

import type { ChatContextValue } from '../components/ai-chat-content';

export interface AIUserInfo {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface AIChatParams {
  host: EditorHost;
  input?: string;
  mode?: 'page' | 'edgeless';
  // Auto select and append selection to input via `Continue in AI Chat` action.
  autoSelect?: boolean;
  context?: Partial<ChatContextValue | null>;
  fromAnswer?: boolean;
}

export interface AISendParams {
  host: EditorHost;
  input: string;
  context?: Partial<ChatContextValue | null>;
}

export interface AIEmbeddingStatus {
  embedded: number;
  total: number;
}

export type ActionEventType =
  | 'started'
  | 'finished'
  | 'error'
  | 'aborted:paywall'
  | 'aborted:login-required'
  | 'aborted:server-error'
  | 'aborted:stop'
  | 'aborted:timeout'
  | 'result:insert'
  | 'result:replace'
  | 'result:use-as-caption'
  | 'result:add-page'
  | 'result:add-note'
  | 'result:continue-in-chat'
  | 'result:discard'
  | 'result:retry';

/**
 * AI provider for the block suite
 *
 * To use it, downstream (affine) has to provide AI actions implementation,
 * user info etc
 *
 * TODO: breakdown into different parts?
 */
export class AIProvider {
  static get userInfo() {
    return AIProvider.instance.userInfoFn();
  }

  static get photoEngine() {
    return AIProvider.instance.photoEngine;
  }

  static get toggleGeneralAIOnboarding() {
    return AIProvider.instance.toggleGeneralAIOnboarding;
  }

  /**
   * Base URL of the currently-connected server (the same one GraphQL/SSE use).
   * Empty on web builds where the app is same-origin with the server; set on
   * desktop/native builds whose renderer origin (assets://.) differs from the
   * cloud server, so relative `/api/...` paths must be made absolute.
   */
  static get serverBaseUrl() {
    return AIProvider.instance.serverBaseUrlFn();
  }

  private static readonly instance = new AIProvider();

  private photoEngine: BlockSuitePresets.AIPhotoEngineService | null = null;

  private toggleGeneralAIOnboarding: ((value: boolean) => void) | null = null;

  private serverBaseUrlFn: () => string = () => '';

  private userInfoFn: () => AIUserInfo | Promise<AIUserInfo> | null = () =>
    null;

  static provide(
    id: 'userInfo',
    fn: () => AIUserInfo | Promise<AIUserInfo> | null
  ): void;

  static provide(
    id: 'photoEngine',
    engine: BlockSuitePresets.AIPhotoEngineService
  ): void;

  static provide(id: 'onboarding', fn: (value: boolean) => void): void;

  static provide(id: 'serverBaseUrl', fn: () => string): void;

  static provide(id: unknown, action: unknown) {
    if (id === 'userInfo') {
      AIProvider.instance.userInfoFn = action as () => AIUserInfo;
    } else if (id === 'photoEngine') {
      AIProvider.instance.photoEngine =
        action as BlockSuitePresets.AIPhotoEngineService;
    } else if (id === 'onboarding') {
      AIProvider.instance.toggleGeneralAIOnboarding = action as (
        value: boolean
      ) => void;
    } else if (id === 'serverBaseUrl') {
      AIProvider.instance.serverBaseUrlFn = action as () => string;
    }
  }
}

/**
 * Resolve a ClickDz backend API path to a fetchable URL.
 *
 * On web the app is same-origin with the server, so the relative path is
 * returned unchanged. On desktop/native the renderer origin is `assets://.`
 * (or `file://`), where a relative `/api/...` would resolve against the app
 * bundle and fail — so we prefix the connected server's base URL, mirroring how
 * FetchService/GraphQL/SSE already resolve their requests.
 */
export function cdzApiUrl(path: string): string {
  const base = AIProvider.serverBaseUrl;
  if (!base) return path;
  try {
    return new URL(path, base).toString();
  } catch {
    return path;
  }
}
