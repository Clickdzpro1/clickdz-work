import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import z from 'zod';

import { BaseModel } from './base';

declare global {
  interface Events {
    'user.settings.updated': {
      userId: string;
    };
  }
}

// E2: Zod mirror of CdzOnboardingProfile (frontend clickdz/niches.ts).
// No migration: the payload column is JSON — adding an optional field is
// non-breaking. All fields are optional so existing rows parse cleanly.
const CdzOnboardingProfileSchema = z
  .object({
    v: z.literal(1),
    lang: z.enum(['fr', 'en', 'ar']),
    brandName: z.string(),
    bizOneLiner: z.string().optional(),
    niches: z.array(z.string()),
    goals: z.array(z.string()),
    level: z.enum(['beginner', 'intermediate', 'pro']).optional(),
    updatedAt: z.string(),
  })
  .optional();

export const UserSettingsSchema = z.object({
  receiveInvitationEmail: z.boolean().default(true),
  receiveMentionEmail: z.boolean().default(true),
  receiveCommentEmail: z.boolean().default(true),
  // E2 — per-user personalization profile (optional, no migration required)
  clickdzProfile: CdzOnboardingProfileSchema,
});

export type UserSettingsInput = z.input<typeof UserSettingsSchema>;
export type UserSettings = z.infer<typeof UserSettingsSchema>;

/**
 * UserSettings Model
 */
@Injectable()
export class UserSettingsModel extends BaseModel {
  @Transactional()
  async set(userId: string, setting: UserSettingsInput) {
    const existsSetting = await this.get(userId);
    const payload = UserSettingsSchema.parse({
      ...existsSetting,
      ...setting,
    });
    await this.db.userSettings.upsert({
      where: {
        userId,
      },
      update: {
        payload,
      },
      create: {
        userId,
        payload,
      },
    });
    this.logger.debug(`UserSettings updated for user ${userId}`);
    return payload;
  }

  async get(userId: string): Promise<UserSettings> {
    const row = await this.db.userSettings.findUnique({
      where: {
        userId,
      },
    });
    return UserSettingsSchema.parse(row?.payload ?? {});
  }
}
