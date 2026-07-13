import { getPromptModelsQuery, SubscriptionStatus } from '@affine/graphql';
import {
  createSignalFromObservable,
  type Signal,
} from '@blocksuite/affine/shared/utils';
import { computed, type ReadonlySignal, signal } from '@preact/signals-core';
import { LiveData, Service } from '@toeverything/infra';

import type { GraphQLService, SubscriptionService } from '../../cloud';
import type { GlobalStateService } from '../../storage';

const AI_MODEL_ID_KEY = 'AIModelId';
const AI_PRE_COUNCIL_MODEL_KEY = 'AIPreCouncilModelId';

// cdz-council is a REAL backend model: CDZ AI runs the 3-vendor fan-out +
// synthesis server-side. Membership is fixed there, so the client only needs
// to select the model id (no client-side member picker).
export const COUNCIL_MODEL_ID = 'cdz-council';

const CLICKDZ_FALLBACK_MODELS: AIModel[] = [
  { name: 'CDZ Ultra', id: 'cdz-ultra', category: 'CDZ', version: 'Ultra', isPro: false, isDefault: true },
  { name: 'CDZ Council', id: 'cdz-council', category: 'CDZ', version: 'Council', isPro: false, isDefault: false },
  { name: 'CDZ Sage', id: 'cdz-sage', category: 'CDZ', version: '4.8', isPro: false, isDefault: false },
  { name: 'CDZ Architect', id: 'cdz-architect', category: 'CDZ', version: '5.5', isPro: false, isDefault: false },
  { name: 'CDZ Scholar', id: 'cdz-scholar', category: 'CDZ', version: '3.1', isPro: false, isDefault: false },
  { name: 'CDZ Flash', id: 'cdz-flash', category: 'CDZ', version: '3.5', isPro: false, isDefault: false },
  { name: 'CDZ Polyglot', id: 'cdz-polyglot', category: 'CDZ', version: '5.4', isPro: false, isDefault: false },
  // raw engine models served through the CDZ AI passthrough (Make engine)
  { name: 'Claude Opus 4.8', id: 'claude-opus-4-8', category: 'Claude', version: 'Opus 4.8', isPro: false, isDefault: false },
  { name: 'Gemini 3.1 Pro', id: 'gemini-3.1-pro-preview', category: 'Gemini', version: '3.1 Pro', isPro: false, isDefault: false },
  { name: 'GPT 5.5', id: 'gpt-5.5', category: 'GPT', version: '5.5', isPro: false, isDefault: false },
  { name: 'Claude Sonnet 4.6', id: 'claude-sonnet-4-6', category: 'Claude', version: 'Sonnet 4.6', isPro: false, isDefault: false },
  { name: 'Gemini 3.5 Flash', id: 'gemini-3.5-flash', category: 'Gemini', version: '3.5 Flash', isPro: false, isDefault: false },
  { name: 'GPT 5.4', id: 'gpt-5.4', category: 'GPT', version: '5.4', isPro: false, isDefault: false },
  { name: 'Claude Haiku 4.5', id: 'claude-haiku-4-5', category: 'Claude', version: 'Haiku 4.5', isPro: false, isDefault: false },
  { name: 'GPT 5.4 Mini', id: 'gpt-5.4-mini', category: 'GPT', version: '5.4 Mini', isPro: false, isDefault: false },
];

export interface AIModel {
  name: string;
  id: string;
  version: string;
  category: string;
  isPro: boolean;
  isDefault: boolean;
}

/**
 * Provider profiles can be shadowed by a stale DB override. Always preserve
 * models returned by the server, then fill every missing ClickDz model locally
 * so a partial response never shrinks the picker.
 */
export function mergeClickDzModels(serverModels: AIModel[]): AIModel[] {
  const merged = [...serverModels];
  for (const fallback of CLICKDZ_FALLBACK_MODELS) {
    if (!merged.some(model => model.id === fallback.id)) {
      merged.push({ ...fallback, isDefault: false });
    }
  }
  if (!merged.some(model => model.isDefault)) {
    const defaultId = merged.some(model => model.id === 'cdz-ultra')
      ? 'cdz-ultra'
      : merged[0]?.id;
    return merged.map(model => ({
      ...model,
      isDefault: model.id === defaultId,
    }));
  }
  return merged;
}

/**
 * Pick a sensible default model id from the current list: prefer the model
 * flagged `isDefault`, otherwise fall back to the first model. Returns
 * undefined only when the list is empty.
 */
export function pickDefaultModelId(models: AIModel[]): string | undefined {
  return models.find(model => model.isDefault)?.id ?? models[0]?.id;
}

export class AIModelService extends Service {
  modelId: Signal<string | undefined>;

  models: Signal<AIModel[]> = signal([]);

  /**
   * The model id to actually use. A previously-persisted `modelId` can become
   * stale when the model list changes between releases (a model is renamed or
   * removed); consumers that look it up in `models` then get `undefined` and
   * the picker/request ends up in a broken/empty state. Reconcile here: if the
   * stored id is absent from the current list, fall back to the list default
   * (or first model) instead of the stale id.
   *
   * Inferred as a ReadonlySignal from `computed` (consumers only read `.value`),
   * matching the `computed(...)` pattern already used elsewhere in the AI UI.
   * Assigned in the constructor so it is created after `this.modelId` is set.
   */
  resolvedModelId!: ReadonlySignal<string | undefined>;

  private readonly modelId$ = LiveData.from(
    this.globalStateService.globalState.watch<string>(AI_MODEL_ID_KEY),
    undefined
  );

  constructor(
    private readonly globalStateService: GlobalStateService,
    private readonly gqlService: GraphQLService,
    private readonly subscriptionService: SubscriptionService
  ) {
    super();

    const { signal: modelId, cleanup } = createSignalFromObservable<
      string | undefined
    >(this.modelId$, undefined);
    this.modelId = modelId;
    this.disposables.push(cleanup);

    this.resolvedModelId = computed<string | undefined>(() => {
      const stored = this.modelId.value;
      const models = this.models.value;
      if (stored && models.some(model => model.id === stored)) {
        return stored;
      }
      return pickDefaultModelId(models);
    });

    this.init().catch(err => {
      console.error(err);
    });
  }

  resetModel = () => {
    this.globalStateService.globalState.set(AI_MODEL_ID_KEY, undefined);
  };

  // tracks whether each session is in council or standard mode (for UI only)
  private readonly sessionModes = new Map<string, 'council' | 'standard'>();

  getSessionMode = (sessionId: string) => this.sessionModes.get(sessionId);

  setSessionMode = (sessionId: string, mode: 'council' | 'standard') => {
    this.sessionModes.set(sessionId, mode);
  };

  /** switch between normal chat and council mode, remembering the last model */
  setCouncilMode = (on: boolean) => {
    const currentId = this.modelId.value;
    if (on) {
      if (currentId !== COUNCIL_MODEL_ID) {
        this.globalStateService.globalState.set(
          AI_PRE_COUNCIL_MODEL_KEY,
          currentId
        );
      }
      this.globalStateService.globalState.set(
        AI_MODEL_ID_KEY,
        COUNCIL_MODEL_ID
      );
    } else if (currentId === COUNCIL_MODEL_ID) {
      const previous = this.globalStateService.globalState.get<string>(
        AI_PRE_COUNCIL_MODEL_KEY
      );
      this.globalStateService.globalState.set(
        AI_MODEL_ID_KEY,
        previous && previous !== COUNCIL_MODEL_ID ? previous : undefined
      );
    }
  };

  setModel = (modelId: string) => {
    const isSubscribed =
      this.subscriptionService.subscription.ai$.value?.status ===
      SubscriptionStatus.Active;
    const model = this.models.value.find(model => model.id === modelId);
    if (!isSubscribed && model?.isPro) {
      return;
    }
    this.globalStateService.globalState.set(AI_MODEL_ID_KEY, modelId);
  };

  private readonly init = async () => {
    await this.initModels();

    // subscribe to ai purchase status
    const sub = this.subscriptionService.subscription.ai$.subscribe(
      subscription => {
        const isSubscribed = subscription?.status === SubscriptionStatus.Active;
        const model = this.models.value.find(
          model => model.id === this.modelId.value
        );
        if (!isSubscribed && model?.isPro) {
          this.resetModel();
        }
      }
    );
    this.disposables.push(() => sub.unsubscribe());
  };

  private readonly initModels = async (prompt?: string) => {
    const promptName = prompt || 'Chat With AFFiNE AI';
    let models;
    try {
      models = await this.getModelsByPrompt(promptName);
    } catch (error) {
      // never let a failed models query leave the selector empty —
      // fall through to CLICKDZ_FALLBACK_MODELS below
      console.error(`Failed to load AI models for "${promptName}"`, error);
    }
    if (models) {
      const { defaultModel, optionalModels, proModels } = models;
      const providerModels = [...optionalModels];
      for (const proModel of proModels) {
        if (!providerModels.some(model => model.id === proModel.id)) {
          providerModels.push(proModel);
        }
      }
      const normalized = providerModels.map(model => {
        const [category] = model.name.split(' ');
        const version = model.name.slice(category.length + 1) || category;
        return {
          name: model.name,
          id: model.id,
          version,
          category,
          isPro: false,
          isDefault: model.id === defaultModel,
        };
      });
      this.models.value = mergeClickDzModels(normalized);
    } else {
      this.models.value = mergeClickDzModels([]);
    }
  };

  private readonly getModelsByPrompt = async (promptName: string) => {
    return this.gqlService
      .gql({
        query: getPromptModelsQuery,
        variables: { promptName },
      })
      .then(res => res.currentUser?.copilot?.models);
  };
}
