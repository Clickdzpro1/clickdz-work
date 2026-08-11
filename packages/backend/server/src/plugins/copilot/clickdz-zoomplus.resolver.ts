// ClickDz Work — ZOOM+ host-controls GraphQL resolver.
//
// Exposes @Admin()-guarded mutations that delegate to ClickDzZoomPlusService
// (LiveKit RoomService). Every mutation returns a structured ZoomPlusResultType
// — on failure the error message is captured and { ok: false } is returned so
// the frontend can display it without a raw 500.
//
// A read-only @Query zoomPlusHostControlsEnabled lets the frontend show/hide
// the host panel based on the feature flag + credential presence.
//
// Registered in CopilotModule alongside ClickDzAdminConfigResolver.

import {
  Args,
  Field,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';

import { Admin } from '../../core/common';
import { CurrentUser } from '../../core/auth';

import { ClickDzZoomPlusService } from './clickdz-zoomplus.service';

// ---------------------------------------------------------------------------
// GraphQL ObjectTypes
// ---------------------------------------------------------------------------

@ObjectType()
export class ZoomPlusParticipantType {
  @Field()
  identity!: string;

  @Field({ nullable: true })
  name?: string;

  @Field({ nullable: true })
  sid?: string;

  @Field(() => Number, { nullable: true })
  joinedAt?: number;

  @Field(() => Boolean, { nullable: true })
  isSpeaking?: boolean;
}

@ObjectType()
export class ZoomPlusResultType {
  @Field()
  ok!: boolean;

  @Field()
  message!: string;

  @Field(() => [ZoomPlusParticipantType], { nullable: true })
  participants?: ZoomPlusParticipantType[];
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

@Admin()
@Resolver()
export class ClickDzZoomPlusResolver {
  constructor(private readonly svc: ClickDzZoomPlusService) {}

  // -------------------------------------------------------------------------
  // Query — feature-flag visibility for the frontend host panel.
  // -------------------------------------------------------------------------

  @Query(() => Boolean, {
    description:
      "Indique si les contrôles hôte ZOOM+ sont activés (flag + identifiants LiveKit).",
  })
  zoomPlusHostControlsEnabled(): boolean {
    return process.env.CDZ_ZOOMPLUS_HOST_CONTROLS_ENABLED === '1';
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  @Mutation(() => ZoomPlusResultType)
  async zoomPlusMuteParticipant(
    @CurrentUser() _user: CurrentUser,
    @Args('roomName') roomName: string,
    @Args('identity') identity: string,
    @Args('trackSid', { type: () => String, nullable: true }) trackSid?: string,
    @Args('muted', { type: () => Boolean, nullable: true }) muted?: boolean
  ): Promise<ZoomPlusResultType> {
    try {
      await this.svc.muteParticipant(
        roomName,
        identity,
        trackSid,
        muted ?? true
      );
      return { ok: true, message: 'Participant muted' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  @Mutation(() => ZoomPlusResultType)
  async zoomPlusMuteAll(
    @CurrentUser() _user: CurrentUser,
    @Args('roomName') roomName: string
  ): Promise<ZoomPlusResultType> {
    try {
      const { muted } = await this.svc.muteAllParticipants(roomName);
      return {
        ok: true,
        message: `Muted ${muted.length} participant(s)`,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  @Mutation(() => ZoomPlusResultType)
  async zoomPlusRemoveParticipant(
    @CurrentUser() _user: CurrentUser,
    @Args('roomName') roomName: string,
    @Args('identity') identity: string
  ): Promise<ZoomPlusResultType> {
    try {
      await this.svc.removeParticipant(roomName, identity);
      return { ok: true, message: 'Participant removed' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  @Mutation(() => ZoomPlusResultType)
  async zoomPlusToggleScreenShare(
    @CurrentUser() _user: CurrentUser,
    @Args('roomName') roomName: string,
    @Args('identity') identity: string,
    @Args('allowed') allowed: boolean
  ): Promise<ZoomPlusResultType> {
    try {
      await this.svc.toggleScreenShare(roomName, identity, allowed);
      return {
        ok: true,
        message: allowed
          ? 'Screen share enabled'
          : 'Screen share disabled',
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  @Mutation(() => ZoomPlusResultType)
  async zoomPlusToggleCamera(
    @CurrentUser() _user: CurrentUser,
    @Args('roomName') roomName: string,
    @Args('identity') identity: string,
    @Args('allowed') allowed: boolean
  ): Promise<ZoomPlusResultType> {
    try {
      await this.svc.toggleCamera(roomName, identity, allowed);
      return {
        ok: true,
        message: allowed
          ? 'Camera enabled'
          : 'Camera disabled',
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  @Mutation(() => ZoomPlusResultType)
  async zoomPlusRenameParticipant(
    @CurrentUser() _user: CurrentUser,
    @Args('roomName') roomName: string,
    @Args('identity') identity: string,
    @Args('name') name: string
  ): Promise<ZoomPlusResultType> {
    try {
      await this.svc.renameParticipant(roomName, identity, name);
      return { ok: true, message: 'Participant renamed' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  @Mutation(() => ZoomPlusResultType)
  async zoomPlusPromoteCoHost(
    @CurrentUser() _user: CurrentUser,
    @Args('roomName') roomName: string,
    @Args('identity') identity: string
  ): Promise<ZoomPlusResultType> {
    try {
      await this.svc.promoteCoHost(roomName, identity);
      return { ok: true, message: 'Participant promoted to co-host' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  @Mutation(() => ZoomPlusResultType)
  async zoomPlusListParticipants(
    @CurrentUser() _user: CurrentUser,
    @Args('roomName') roomName: string
  ): Promise<ZoomPlusResultType> {
    try {
      const { participants } = await this.svc.listParticipants(roomName);
      return {
        ok: true,
        message: `${participants.length} participant(s)`,
        participants: participants.map(p => ({
          identity: p.identity,
          name: p.name,
          sid: p.sid,
          joinedAt: p.joinedAt,
          isSpeaking: p.isSpeaking,
        })),
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  @Mutation(() => ZoomPlusResultType)
  async zoomPlusEndMeeting(
    @CurrentUser() _user: CurrentUser,
    @Args('roomName') roomName: string
  ): Promise<ZoomPlusResultType> {
    try {
      await this.svc.endMeeting(roomName);
      return { ok: true, message: 'Meeting ended' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}
