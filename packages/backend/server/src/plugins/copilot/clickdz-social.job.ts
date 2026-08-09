/**
 * clickdz-social.job.ts — P3 Social Studio: BullMQ delayed-job worker.
 *
 * ClickDzSocialJob drives the scheduled-publish path:
 *  - Jobs are enqueued by the /social/posts controller with a BullMQ `delay`
 *    = scheduledAt - now, deterministic jobId = `social:<userId>:<postId>`.
 *  - The @OnJob('copilot.socialPublish') handler fires when the delay elapses,
 *    re-reads the post row (late edits win), delegates to ClickDzSocialService.
 *  - Result (published/partial/failed) is written back to Redis + appended to
 *    the PublishedLog. Never throws — all failures are captured in the row.
 *
 * Job augmentation: the `declare global` extends the existing `Jobs` interface
 * (same pattern as clickdz-agent-runs.ts / cron.ts). The `copilot` queue is
 * already wired; no new queue registration needed.
 *
 * Plan-B cron sweep: a @Cron(EVERY_10_MINUTES) catches posts whose BullMQ job
 * was silently dropped (e.g. Redis flush). Mirrors Postiz's "check for missing
 * posts" safety net. Re-enqueues with a 0 delay (fires immediately).
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { JobQueue, OnJob } from '../../base';

import { ClickDzSocialService } from './clickdz-social.service';
import type { SocialPost, PublishedLogEntry } from './clickdz-social.service';

// ---------------------------------------------------------------------------
// BullMQ job augmentation — mirrors cron.ts / clickdz-agent-runs.ts pattern.
// `copilot` is an existing Queue (Queue.COPILOT) so `copilot.*` is valid.
// ---------------------------------------------------------------------------

declare global {
  interface Jobs {
    'copilot.socialPublish': {
      userId: string;
      postId: string;
    };
  }
}

// Grace period (ms) after scheduledAt before the Plan-B sweep considers a post
// "missed" (accounts for normal job startup / processing latency).
const MISSED_POST_GRACE_MS = 5 * 60 * 1000; // 5 min

// ---------------------------------------------------------------------------
// ClickDzSocialJob — @Injectable, registered in COPILOT_JOB_PROVIDERS.
// ---------------------------------------------------------------------------

@Injectable()
export class ClickDzSocialJob {
  private readonly logger = new Logger(ClickDzSocialJob.name);

  constructor(
    private readonly jobs: JobQueue,
    private readonly social: ClickDzSocialService
  ) {}

  // =========================================================================
  // @OnJob handler — the delayed-job fire path
  // =========================================================================

  /**
   * Handle a scheduled publish job. Execution model:
   *  1. Re-read the post (late edits + last-minute cancellation win).
   *  2. Guard: if post is gone / already published / cancelled → done (idempotent).
   *  3. Mark status 'publishing' + write.
   *  4. Delegate to ClickDzSocialService.publishPost().
   *  5. Write the updated post back + append PublishedLogEntry.
   *  Never throws — BullMQ marks the job done regardless of per-network outcome.
   */
  @OnJob('copilot.socialPublish')
  async handleSocialPublish(
    params: Jobs['copilot.socialPublish']
  ): Promise<void> {
    const { userId, postId } = params;
    this.logger.log(`[social-job] firing scheduled publish userId=${userId} postId=${postId}`);

    try {
      const post = await this.social.readPost(userId, postId);
      if (!post) {
        this.logger.warn(`[social-job] post not found userId=${userId} postId=${postId} — skipped`);
        return;
      }

      // Idempotency guards: already done or explicitly cancelled.
      if (post.status === 'published' || post.status === 'draft') {
        this.logger.log(`[social-job] post ${postId} already ${post.status} — skipped`);
        return;
      }

      // Mark publishing (in-flight indicator for the queue UI).
      post.status = 'publishing';
      await this.social.writePost(userId, post);

      // Run the shared publish routine (never throws).
      const updated = await this.social.publishPost(post);

      // Write final state.
      await this.social.writePost(userId, updated);

      // Append to published log (best-effort).
      const logEntry: PublishedLogEntry = {
        postId: updated.id,
        publishedAt: updated.publishedAt ?? Date.now(),
        results: updated.targets.map(t => ({
          network: t.network,
          ok: t.status === 'ok',
          externalUrl: t.externalUrl,
        })),
      };
      await this.social.appendPublishedLog(userId, logEntry);

      this.logger.log(
        `[social-job] done postId=${postId} status=${updated.status} ` +
        `ok=${updated.targets.filter(t => t.status === 'ok').length}/${updated.targets.length}`
      );
    } catch (err) {
      // Last-resort catch: log but don't rethrow (BullMQ marks done; avoids
      // infinite auto-retry — we own retry via the manual /retry endpoint).
      this.logger.error(
        `[social-job] unexpected error postId=${postId}: ${(err as Error)?.message ?? err}`
      );
    }
  }

  // =========================================================================
  // Plan-B cron sweep — catches posts whose BullMQ job was lost (Redis flush).
  // =========================================================================

  /**
   * Every 10 minutes: scan ALL social post indexes for posts that are
   * `scheduled`, past their scheduledAt + grace, and have no live BullMQ job.
   * Re-enqueues them with delay=0 (fires immediately).
   *
   * Implementation note: we cannot list all userId keys directly without a
   * Redis SCAN on the `clickdz:social:postindex:*` pattern; the Cache provider
   * wraps a JSON client and doesn't expose SCAN. We therefore keep a lightweight
   * sweep: each user's jobs are self-healing because the next explicit POST /posts
   * or GET /posts call from the FE will surface the orphaned `scheduled` post.
   * This cron runs as a safety net on whatever index keys the worker can reach.
   * For now it is a no-op hook that re-enqueues known missed posts when passed
   * an explicit list — the CronJob-aware operator can ALSO trigger re-enqueue
   * via POST /social/posts/:id/reschedule from the UI (the Queue view shows
   * status:'scheduled' posts with past dates).
   *
   * The actual sweep against a userId set requires either a Prisma table or
   * Redis SCAN (out of P3 scope per the plan). This cron is wired and logged
   * so the operator sees it's alive; posts surface via the UI's retry/reschedule
   * path until the Prisma lift lands.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweepMissedPosts(): Promise<void> {
    // WS17: recover scheduled posts whose BullMQ job was lost (Redis flush /
    // worker restart). Iterate the global schedulers index (maintained at
    // enqueue time), read each user's postindex, and re-enqueue any post that
    // is 'scheduled' and past its scheduledAt + grace. Fail-soft on every step
    // (a Redis hiccup only delays the sweep; the UI retry path still works).
    try {
      const userIds = await this.social.listSchedulerUserIds();
      if (!userIds.length) {
        this.logger.debug('[social-job] Plan-B sweep: no scheduled users');
        return;
      }
      const dueBefore = Date.now() - MISSED_POST_GRACE_MS;
      let reenqueued = 0;
      for (const userId of userIds) {
        const due = await this.social.listScheduledDue(userId, dueBefore);
        for (const postId of due) {
          // Re-enqueue with delay=0 (fires immediately). Idempotent jobId means
          // a duplicate (if the original job is somehow still alive) is a no-op.
          await this.enqueuePublish(userId, postId, Date.now());
          reenqueued++;
        }
      }
      if (reenqueued > 0) {
        this.logger.log(
          `[social-job] Plan-B sweep recovered ${reenqueued} missed post(s) across ${userIds.length} user(s)`
        );
      } else {
        this.logger.debug(
          `[social-job] Plan-B sweep: ${userIds.length} user(s), 0 missed`
        );
      }
    } catch (e) {
      this.logger.warn(
        `[social-job] Plan-B sweep failed: ${(e as Error)?.message ?? e}`
      );
    }
  }

  // =========================================================================
  // Helpers called by the CONTROLLER to enqueue / cancel / reschedule jobs.
  // These are co-located here because they depend on the Jobs type declaration.
  // =========================================================================

  /**
   * Enqueue a delayed publish job.
   * `delay` is max(0, post.scheduledAt - Date.now()).
   * Deterministic jobId = `social:<userId>:<postId>` (idempotent).
   */
  async enqueuePublish(
    userId: string,
    postId: string,
    scheduledAt: number
  ): Promise<string | undefined> {
    const delay = Math.max(0, scheduledAt - Date.now());
    try {
      const job = await this.jobs.add(
        'copilot.socialPublish',
        { userId, postId },
        {
          jobId: `social:${userId}:${postId}`,
          delay,
          attempts: 1,            // we own retry via /retry route (DLQ-style)
          removeOnComplete: true,
          removeOnFail: false,
        }
      );
      // WS17: register this user in the global schedulers index so the Plan-B
      // cron sweep can find their past-due posts if this job is later lost.
      await this.social.registerScheduler(userId).catch(() => {});
      this.logger.log(
        `[social-job] enqueued postId=${postId} delay=${delay}ms jobId=${job?.id}`
      );
      return job?.id?.toString();
    } catch (err) {
      this.logger.warn(
        `[social-job] enqueue failed postId=${postId}: ${(err as Error)?.message ?? err}`
      );
      return undefined;
    }
  }

  /**
   * Remove a scheduled job (cancel or reschedule). Soft-fail: if the job is
   * already gone (completed / never existed) this is a no-op.
   */
  async removeJob(
    userId: string,
    postId: string
  ): Promise<void> {
    const jobId = `social:${userId}:${postId}`;
    try {
      await this.jobs.remove(jobId, 'copilot.socialPublish');
    } catch (err) {
      // Job may already be gone (fired / completed) — not an error.
      this.logger.debug(
        `[social-job] remove jobId=${jobId}: ${(err as Error)?.message ?? 'not found'}`
      );
    }
  }

  /**
   * Reschedule: remove existing job + re-add with new delay.
   * Returns the new job id string (or undefined on failure).
   */
  async reschedulePublish(
    userId: string,
    postId: string,
    newScheduledAt: number
  ): Promise<string | undefined> {
    await this.removeJob(userId, postId);
    return this.enqueuePublish(userId, postId, newScheduledAt);
  }

  /**
   * Fire an immediate publish for a post that is currently 'scheduled'
   * (e.g. manual "publish now" from the queue view on a scheduled post).
   * Removes the pending job, then the controller calls publishPost() inline.
   */
  async cancelAndMarkDraft(
    userId: string,
    postId: string,
    post: SocialPost
  ): Promise<void> {
    await this.removeJob(userId, postId);
    post.status = 'draft';
    post.jobId = undefined;
    await this.social.writePost(userId, post);
  }
}
