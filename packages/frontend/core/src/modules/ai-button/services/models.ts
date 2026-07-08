import { getPromptModelsQuery, SubscriptionStatus } from '@affine/graphql';
import {
  createSignalFromObservable,
  type Signal,
} from '@blocksuite/affine/shared/utils';
import { signal } from '@preact/signals-core';
import { LiveData, Service } from '@toeverything/infra';

import type { GraphQLService, SubscriptionService } from '../../cloud';
import type { GlobalStateService } from '../../storage';

const AI_MODEL_ID_KEY = 'AIModelId';
const AI_COUNCIL_MEMBERS_KEY = 'AICouncilMembers';
const AI_PRE_COUNCIL_MODEL_KEY = 'AIPreCouncilModelId';

export const COUNCIL_MODEL_ID = 'clickdz-council';
export const COUNCIL_SEATS = 3;
export const DEFAULT_COUNCIL_MEMBERS = [
  'claude-opus-4-8',
  'gemini-3.1-pro-preview',
  'gpt-5.5',
];

const CLICKDZ_FALLBACK_MODELS: AIModel[] = [
  { name: 'ClickDz Smart', id: 'clickdz-smart', category: 'ClickDz', version: 'Smart', isPro: false, isDefault: true },
  { name: 'ClickDz Council', id: 'clickdz-council', category: 'ClickDz', version: 'Council', isPro: false, isDefault: false },
  { name: 'ClickDz Fast', id: 'clickdz-fast', category: 'ClickDz', version: 'Fast', isPro: false, isDefault: false },
  { name: 'ClickDz Arabic', id: 'clickdz-arabic', category: 'ClickDz', version: 'Arabic', isPro: false, isDefault: false },
  { name: 'Claude Sonnet', id: 'claude-sonnet-5', category: 'Claude', version: 'Sonnet', isPro: false, isDefault: false },
  { name: 'Gemini Pro', id: 'gemini-2.5-pro', category: 'Gemini', version: 'Pro', isPro: false, isDefault: false },
];

export interface AIModel {
  name: string;
  id: string;
  version: string;
  category: string;
  isPro: boolean;
  isDefault: boolean;
}

export class AIModelService extends Service {
  modelId: Signal<string | undefined>;

  models: Signal<AIModel[]> = signal([]);

  private readonly modelId$ = LiveData.from(
    this.globalStateService.globalState.watch<string>(AI_MODEL_ID_KEY),
    undefined
  );

  councilMembers: Signal<string[] | undefined>;

  private readonly councilMembers$ = LiveData.from(
    this.globalStateService.globalState.watch<string[]>(
      AI_COUNCIL_MEMBERS_KEY
    ),
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

    const { signal: councilMembers, cleanup: councilCleanup } =
      createSignalFromObservable<string[] | undefined>(
        this.councilMembers$,
        undefined
      );
    this.councilMembers = councilMembers;
    this.disposables.push(councilCleanup);

    this.init().catch(err => {
      console.error(err);
    });
  }

  resetModel = () => {
    this.globalStateService.globalState.set(AI_MODEL_ID_KEY, undefined);
  };

  /** the 3 council member model ids (falls back to the default trio) */
  getCouncilMembers = (): string[] => {
    const stored = this.councilMembers.value;
    const members = (stored?.length ? stored : DEFAULT_COUNCIL_MEMBERS).slice(
      0,
      COUNCIL_SEATS
    );
    while (members.length < COUNCIL_SEATS) {
      const filler = DEFAULT_COUNCIL_MEMBERS.find(id => !members.includes(id));
      if (!filler) break;
      members.push(filler);
    }
    return members;
  };

  /** toggle a model in/out of the council; oldest member rotates out at 3 */
  toggleCouncilMember = (modelId: string): string[] => {
    const current = this.getCouncilMembers();
    let next: string[];
    if (current.includes(modelId)) {
      next = current.filter(id => id !== modelId);
    } else {
      next = [...current, modelId];
      while (next.length > COUNCIL_SEATS) next.shift();
    }
    this.globalStateService.globalState.set(AI_COUNCIL_MEMBERS_KEY, next);
    return next;
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
      const merged = [...optionalModels];
      for (const proModel of proModels) {
        if (!merged.some(model => model.id === proModel.id)) merged.push(proModel);
      }
      this.models.value = merged.map(model => {
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
    }
    if (!this.models.value.length) {
      this.models.value = CLICKDZ_FALLBACK_MODELS;
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
