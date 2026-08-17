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

// WS14: chat rides the Vercel AI Gateway and serves exactly ONE model today —
// alibaba/qwen3.7-flash. The old multi-vendor roster (CDZ Ultra/Sage/Architect/
// Scholar/Flash/Polyglot + raw Claude/Gemini/GPT ids + the `cdz-council`
// fan-out) is gone: those ids no longer resolve through the Gateway allowlist
// (see CLICKDZ_PROVIDER_MODELS in provider-registry.ts / CDZ_MODELS in
// scripts/cdz-ai-config.mjs), so surfacing them only produced a picker full of
// dead choices. Keep this list in lockstep with that backend allowlist — the
// `id` MUST match verbatim what the Gateway serves.
//
// `category` doubles as the picker's group label (Rapide / Équilibré /
// Puissant), so the single list still renders under a clean, tiered heading.
const CLICKDZ_FALLBACK_MODELS: AIModel[] = [
  {
    name: 'ClickDz Flash',
    id: 'alibaba/qwen3.7-flash',
    category: 'Rapide',
    version: 'Flash',
    isPro: false,
    isDefault: true,
  },
];

// Frontend allowlist — the ONLY model ids the picker may show, regardless of
// what a stale server prompt catalog returns from getPromptModelsQuery. The
// backend prompt catalog (built-in.json) can still advertise the retired
// roster (cdz-ultra/cdz-council/…); clamping here guarantees the picker never
// surfaces a model the Gateway won't actually serve. Keep in lockstep with
// CLICKDZ_FALLBACK_MODELS above and the backend Gateway allowlist.
const CLICKDZ_ALLOWED_MODEL_IDS: ReadonlySet<string> = new Set(
  CLICKDZ_FALLBACK_MODELS.map(model => model.id)
);

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
    // Prefer the known chat model when nothing is flagged default; otherwise
    // fall back to the first model so the picker never has an empty selection.
    const defaultId = merged.some(
      model => model.id === 'alibaba/qwen3.7-flash'
    )
      ? 'alibaba/qwen3.7-flash'
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
      const normalized = providerModels
        // Clamp to the curated allowlist so a stale server prompt catalog can
        // never re-introduce the retired multi-vendor roster into the picker.
        .filter(model => CLICKDZ_ALLOWED_MODEL_IDS.has(model.id))
        .map(model => {
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
