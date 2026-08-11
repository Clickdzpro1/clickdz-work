// ClickDz Work — ZOOM+ meeting-summary GraphQL resolver.
//
// Exposes the ZOOM+ post-call "résumé de réunion" flow as a code-first GraphQL
// mutation + a feature-flag probe query. The mutation is callable by the
// meeting HOST (any authenticated user via @CurrentUser — NOT @Admin-gated,
// because hosts need to summarize their own meetings); the actual gate lives
// inside the service (CDZ_ZOOMPLUS_ENABLED + CDZ_AI_KEY). The query lets the
// frontend show/hide the "Summarize" button without attempting the call.
//
// NestJS code-first GraphQL — NO manual schema.gql edits. The ObjectTypes mirror
// the service's result interfaces exactly. @Throttle('strict') caps the paid
// model call. Fail-closed: the service returns {ok:false,error} and the resolver
// passes it through — it never throws a 500.

import {
  Args,
  Field,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';

import { Throttle } from '../../base';
import { CurrentUser } from '../../core/auth';
import {
  ClickDzZoomPlusSummaryService,
  type ZoomPlusActionItem,
  type ZoomPlusStructuredSummary,
  type ZoomPlusSummaryResult,
} from './clickdz-zoomplus-summary.service';
import type { ZoomPlusLang } from './clickdz-zoomplus-prompt';

// ---------------------------------------------------------------------------
// GraphQL ObjectTypes — mirror the service result interfaces.
// ---------------------------------------------------------------------------

@ObjectType()
export class ZoomPlusActionItemType implements ZoomPlusActionItem {
  @Field()
  owner!: string;

  @Field()
  task!: string;
}

@ObjectType()
export class ZoomPlusStructuredSummaryType
  implements ZoomPlusStructuredSummary
{
  @Field()
  summary!: string;

  @Field(() => [String])
  decisions!: string[];

  @Field(() => [ZoomPlusActionItemType])
  actionItems!: ZoomPlusActionItemType[];

  @Field(() => [String])
  nextSteps!: string[];
}

@ObjectType()
export class ZoomPlusSummaryResultType {
  @Field()
  ok!: boolean;

  @Field(() => String, { nullable: true })
  error?: string;

  @Field(() => ZoomPlusStructuredSummaryType, { nullable: true })
  summary?: ZoomPlusStructuredSummaryType;

  @Field(() => String, { nullable: true })
  model?: string;

  @Field(() => String, { nullable: true })
  lang?: string;

  @Field(() => Boolean, { nullable: true })
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

@Resolver()
export class ClickDzZoomPlusSummaryResolver {
  constructor(private readonly svc: ClickDzZoomPlusSummaryService) {}

  /**
   * Summarize a meeting transcript. Session-authed (global guard — no @Public,
   * so a signed-in user is required), @Throttle('strict') (a paid model call),
   * gated inside the service by CDZ_ZOOMPLUS_ENABLED + CDZ_AI_KEY. The host
   * (any authenticated user) can summarize their own meetings — NOT @Admin-gated.
   */
  @Throttle('strict')
  @Mutation(() => ZoomPlusSummaryResultType, {
    description:
      "ZOOM+ — génère un résumé structuré de réunion (résumé, décisions, actions, prochaines étapes) à partir d'une transcription.",
  })
  async zoomPlusSummarizeMeeting(
    @CurrentUser() _user: CurrentUser,
    @Args('transcript') transcript: string,
    @Args('lang') lang: string,
    @Args('title', { nullable: true }) title?: string
  ): Promise<ZoomPlusSummaryResult> {
    return await this.svc.summarizeMeeting({
      transcript,
      lang: lang as ZoomPlusLang,
      title,
    });
  }

  /**
   * Feature-flag probe — returns true only when CDZ_ZOOMPLUS_ENABLED=1 AND a
   * CDZ_AI_KEY is present. Lets the frontend show/hide the "Summarize" button
   * without attempting the (paid) mutation.
   */
  @Query(() => Boolean, {
    description:
      "Indique si le résumé de réunion ZOOM+ est activé (CDZ_ZOOMPLUS_ENABLED=1 + CDZ_AI_KEY).",
  })
  zoomPlusSummaryEnabled(): boolean {
    return process.env.CDZ_ZOOMPLUS_ENABLED === '1' && !!process.env.CDZ_AI_KEY;
  }
}
