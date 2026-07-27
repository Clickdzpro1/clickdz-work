import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';

import { EventBus, JobQueue, OnJob } from '../../base';
import { StorageRuntimeProvider } from '../storage-runtime';

// Queue keys are persisted API; keep the legacy backendRuntime.* names while
// StorageBlobJob and StorageRuntimeProvider own the implementation.
declare global {
  interface Jobs {
    'backendRuntime.backfillMissingBlobMetadata': {
      workspaceId: string;
      limit?: number;
    };
    'backendRuntime.backfillMissingBlobMetadataBySid': {
      lastSid?: number;
      workspaceLimit?: number;
      objectLimit?: number;
    };
    'backendRuntime.rebuildWorkspaceDocBlobRefs': {
      workspaceId: string;
      limit?: number;
    };
    'backendRuntime.rebuildWorkspaceDocBlobRefsBySid': {
      lastSid?: number;
      workspaceLimit?: number;
      docLimit?: number;
    };
    'backendRuntime.planUnreferencedWorkspaceBlobs': {
      workspaceId: string;
      gracePeriodDays?: number;
      limit?: number;
    };
    'backendRuntime.planUnreferencedWorkspaceBlobsBySid': {
      lastSid?: number;
      workspaceLimit?: number;
      gracePeriodDays?: number;
      limit?: number;
    };
    'backendRuntime.executeBlobCleanupCandidates': {
      runId: string;
      gracePeriodDays?: number;
      limit?: number;
    };
    'backendRuntime.executeBlobCleanupCandidatesByMarkedRuns': {
      runLimit?: number;
      gracePeriodDays?: number;
      candidateLimit?: number;
    };
  }
}

@Injectable()
export class StorageBlobJob {
  private readonly logger = new Logger(StorageBlobJob.name);

  constructor(
    private readonly rt: StorageRuntimeProvider,
    private readonly event: EventBus,
    private readonly queue: JobQueue,
    private readonly db: PrismaClient
  ) {}

  async enqueueBackfillMissingBlobMetadata(workspaceId: string, limit = 1000) {
    await this.queue.add('backendRuntime.backfillMissingBlobMetadata', {
      workspaceId,
      limit,
    });
  }

  async enqueueBackfillMissingBlobMetadataBySid(
    lastSid = 0,
    workspaceLimit = 100,
    objectLimit = 1000
  ) {
    await this.queue.add('backendRuntime.backfillMissingBlobMetadataBySid', {
      lastSid,
      workspaceLimit,
      objectLimit,
    });
  }

  async enqueueRebuildWorkspaceDocBlobRefs(workspaceId: string, limit = 1000) {
    await this.queue.add('backendRuntime.rebuildWorkspaceDocBlobRefs', {
      workspaceId,
      limit,
    });
  }

  async enqueueRebuildWorkspaceDocBlobRefsBySid(
    lastSid = 0,
    workspaceLimit = 100,
    docLimit = 1000
  ) {
    await this.queue.add('backendRuntime.rebuildWorkspaceDocBlobRefsBySid', {
      lastSid,
      workspaceLimit,
      docLimit,
    });
  }

  @OnJob('backendRuntime.backfillMissingBlobMetadataBySid')
  async backfillMissingBlobMetadataBySid({
    lastSid = 0,
    workspaceLimit = 100,
    objectLimit = 1000,
  }: Jobs['backendRuntime.backfillMissingBlobMetadataBySid']) {
    if (!(await this.hasObjectStorage('blob metadata backfill sweep'))) {
      return;
    }

    const workspaces = await this.db.workspace.findMany({
      where: { sid: { gt: lastSid } },
      orderBy: { sid: 'asc' },
      select: { id: true, sid: true },
      take: workspaceLimit,
    });

    for (const workspace of workspaces) {
      try {
        await this.drainBlobMetadataBackfill(workspace.id, objectLimit, {
          sid: workspace.sid,
        });
      } catch (err) {
        await this.handleSweepFailure(
          'blob metadata backfill',
          workspace.id,
          workspace.sid,
          err
        );
      }
    }

    const nextSid = workspaces.at(-1)?.sid;
    if (nextSid !== undefined && workspaces.length === workspaceLimit) {
      await this.enqueueBackfillMissingBlobMetadataBySid(
        nextSid,
        workspaceLimit,
        objectLimit
      );
    }
  }

  async enqueuePlanUnreferencedWorkspaceBlobs(
    workspaceId: string,
    gracePeriodDays = 30,
    limit = 1000
  ) {
    await this.queue.add('backendRuntime.planUnreferencedWorkspaceBlobs', {
      workspaceId,
      gracePeriodDays,
      limit,
    });
  }

  async enqueuePlanUnreferencedWorkspaceBlobsBySid(
    lastSid = 0,
    workspaceLimit = 100,
    gracePeriodDays = 30,
    limit = 1000
  ) {
    await this.queue.add('backendRuntime.planUnreferencedWorkspaceBlobsBySid', {
      lastSid,
      workspaceLimit,
      gracePeriodDays,
      limit,
    });
  }

  async enqueueExecuteBlobCleanupCandidates(
    runId: string,
    gracePeriodDays = 30,
    limit = 1000
  ) {
    await this.queue.add('backendRuntime.executeBlobCleanupCandidates', {
      runId,
      gracePeriodDays,
      limit,
    });
  }

  async enqueueExecuteBlobCleanupCandidatesByMarkedRuns(
    runLimit = 10,
    gracePeriodDays = 30,
    candidateLimit = 1000
  ) {
    await this.queue.add(
      'backendRuntime.executeBlobCleanupCandidatesByMarkedRuns',
      {
        runLimit,
        gracePeriodDays,
        candidateLimit,
      }
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async dailyBlobMetadataBackfill() {
    await this.queue.add(
      'backendRuntime.backfillMissingBlobMetadataBySid',
      {},
      { jobId: 'daily-backend-runtime-blob-metadata-backfill' }
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async dailyDocBlobRefsRebuild() {
    await this.queue.add(
      'backendRuntime.rebuildWorkspaceDocBlobRefsBySid',
      {},
      { jobId: 'daily-backend-runtime-doc-blob-refs-rebuild' }
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async dailyBlobCleanupPlanning() {
    await this.queue.add(
      'backendRuntime.planUnreferencedWorkspaceBlobsBySid',
      {},
      { jobId: 'daily-backend-runtime-blob-cleanup-planning' }
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async dailyBlobCleanupExecution() {
    await this.queue.add(
      'backendRuntime.executeBlobCleanupCandidatesByMarkedRuns',
      {},
      { jobId: 'daily-backend-runtime-blob-cleanup-execution' }
    );
  }

  @OnJob('backendRuntime.backfillMissingBlobMetadata')
  async backfillMissingBlobMetadata({
    workspaceId,
    limit = 1000,
  }: Jobs['backendRuntime.backfillMissingBlobMetadata']) {
    if (!(await this.hasObjectStorage('blob metadata backfill'))) {
      return;
    }

    await this.drainBlobMetadataBackfill(workspaceId, limit);
  }

  @OnJob('backendRuntime.rebuildWorkspaceDocBlobRefs')
  async rebuildWorkspaceDocBlobRefs({
    workspaceId,
    limit = 1000,
  }: Jobs['backendRuntime.rebuildWorkspaceDocBlobRefs']) {
    await this.drainWorkspaceDocBlobRefs(workspaceId, limit);
  }

  @OnJob('backendRuntime.rebuildWorkspaceDocBlobRefsBySid')
  async rebuildWorkspaceDocBlobRefsBySid({
    lastSid = 0,
    workspaceLimit = 100,
    docLimit = 1000,
  }: Jobs['backendRuntime.rebuildWorkspaceDocBlobRefsBySid']) {
    const workspaces = await this.db.workspace.findMany({
      where: {
        sid: {
          gt: lastSid,
        },
      },
      orderBy: {
        sid: 'asc',
      },
      select: {
        id: true,
        sid: true,
      },
      take: workspaceLimit,
    });

    for (const workspace of workspaces) {
      try {
        await this.drainWorkspaceDocBlobRefs(workspace.id, docLimit, {
          sid: workspace.sid,
        });
      } catch (err) {
        await this.handleSweepFailure(
          'doc blob refs rebuild',
          workspace.id,
          workspace.sid,
          err
        );
      }
    }

    const nextSid = workspaces.at(-1)?.sid;
    if (nextSid !== undefined && workspaces.length === workspaceLimit) {
      await this.enqueueRebuildWorkspaceDocBlobRefsBySid(
        nextSid,
        workspaceLimit,
        docLimit
      );
    }
  }

  @OnJob('backendRuntime.planUnreferencedWorkspaceBlobs')
  async planUnreferencedWorkspaceBlobs({
    workspaceId,
    gracePeriodDays = 30,
    limit = 1000,
  }: Jobs['backendRuntime.planUnreferencedWorkspaceBlobs']) {
    if (!(await this.hasObjectStorage('blob cleanup planning'))) {
      return;
    }

    await this.drainBlobCleanupPlanning(workspaceId, gracePeriodDays, limit);
  }

  @OnJob('backendRuntime.planUnreferencedWorkspaceBlobsBySid')
  async planUnreferencedWorkspaceBlobsBySid({
    lastSid = 0,
    workspaceLimit = 100,
    gracePeriodDays = 30,
    limit = 1000,
  }: Jobs['backendRuntime.planUnreferencedWorkspaceBlobsBySid']) {
    if (!(await this.hasObjectStorage('blob cleanup planning sweep'))) {
      return;
    }

    const workspaces = await this.db.workspace.findMany({
      where: {
        sid: {
          gt: lastSid,
        },
      },
      orderBy: {
        sid: 'asc',
      },
      select: {
        id: true,
        sid: true,
      },
      take: workspaceLimit,
    });

    for (const workspace of workspaces) {
      try {
        await this.drainBlobCleanupPlanning(
          workspace.id,
          gracePeriodDays,
          limit,
          { sid: workspace.sid }
        );
      } catch (err) {
        await this.handleSweepFailure(
          'blob cleanup planning',
          workspace.id,
          workspace.sid,
          err
        );
      }
    }

    const nextSid = workspaces.at(-1)?.sid;
    if (nextSid !== undefined && workspaces.length === workspaceLimit) {
      await this.enqueuePlanUnreferencedWorkspaceBlobsBySid(
        nextSid,
        workspaceLimit,
        gracePeriodDays,
        limit
      );
    }
  }

  @OnJob('backendRuntime.executeBlobCleanupCandidates')
  async executeBlobCleanupCandidates({
    runId,
    gracePeriodDays = 30,
    limit = 1000,
  }: Jobs['backendRuntime.executeBlobCleanupCandidates']) {
    if (!(await this.hasObjectStorage('blob cleanup execution'))) {
      return;
    }

    const result = await this.rt.executeBlobCleanupCandidates(
      runId,
      gracePeriodDays,
      limit
    );
    await Promise.all(
      result.workspaceIds.map((workspaceId: string) =>
        this.event.emitAsync('workspace.blobs.updated', { workspaceId })
      )
    );
    this.logger.log(
      `executed blob cleanup run=${runId} deleted=${result.deletedObjects} skipped=${result.skippedStillReferenced} failed=${result.failed}`
    );
  }

  @OnJob('backendRuntime.executeBlobCleanupCandidatesByMarkedRuns')
  async executeBlobCleanupCandidatesByMarkedRuns({
    runLimit = 10,
    gracePeriodDays = 30,
    candidateLimit = 1000,
  }: Jobs['backendRuntime.executeBlobCleanupCandidatesByMarkedRuns']) {
    if (!(await this.hasObjectStorage('blob cleanup execution sweep'))) {
      return;
    }

    const normalizedRunLimit = Math.max(1, runLimit);
    const normalizedCandidateLimit = Math.max(1, candidateLimit);
    const runIds = await this.loadPendingBlobCleanupRunIds(normalizedRunLimit);
    let hadDrainError = false;
    for (const runId of runIds) {
      try {
        await this.drainBlobCleanupExecution(
          runId,
          gracePeriodDays,
          normalizedCandidateLimit
        );
      } catch (err) {
        hadDrainError = true;
        if (this.isPoolTimeoutError(err)) {
          this.logger.warn(
            `blob cleanup execution stalled on pool timeout run=${runId} — will retry on next sweep`,
            err
          );
          await this.recoverFromPoolPressure();
        } else {
          this.logger.error(`blob cleanup execution failed run=${runId}`, err);
        }
      }
    }

    if (
      !hadDrainError &&
      runIds.length === normalizedRunLimit &&
      (await this.hasMarkedBlobCleanupCandidates())
    ) {
      await this.enqueueExecuteBlobCleanupCandidatesByMarkedRuns(
        normalizedRunLimit,
        gracePeriodDays,
        normalizedCandidateLimit
      );
    }
  }

  private async drainBlobMetadataBackfill(
    workspaceId: string,
    limit: number,
    context: { sid?: number } = {}
  ) {
    for (;;) {
      const result = await this.rt.backfillMissingBlobMetadata(
        workspaceId,
        limit
      );
      await Promise.all(
        result.workspaceIds.map((workspaceId: string) =>
          this.event.emitAsync('workspace.blobs.updated', { workspaceId })
        )
      );
      this.logger.log(
        `backfilled blob metadata workspace=${workspaceId}${context.sid === undefined ? '' : ` sid=${context.sid}`} upserted=${result.upsertedMetadata} scanned=${result.scannedObjects}`
      );
      if (!result.nextCursor) {
        break;
      }
    }
  }

  private async drainWorkspaceDocBlobRefs(
    workspaceId: string,
    limit: number,
    context: { sid?: number } = {}
  ) {
    for (;;) {
      const result = await this.rt.rebuildWorkspaceDocBlobRefs(
        workspaceId,
        limit
      );
      this.logger.log(
        `rebuilt doc blob refs workspace=${workspaceId}${context.sid === undefined ? '' : ` sid=${context.sid}`} parsed=${result.parsedDocs} failed=${result.failedDocs}`
      );
      if (!result.nextCursor) {
        break;
      }
    }
  }

  private async drainBlobCleanupPlanning(
    workspaceId: string,
    gracePeriodDays: number,
    limit: number,
    context: { sid?: number } = {}
  ) {
    for (;;) {
      const result = await this.rt.planUnreferencedWorkspaceBlobs(
        workspaceId,
        gracePeriodDays,
        limit
      );
      this.logger.log(
        `planned blob cleanup workspace=${workspaceId}${context.sid === undefined ? '' : ` sid=${context.sid}`} run=${result.runId} candidates=${result.candidatesMarked} scanned=${result.scannedBlobs}`
      );
      if (!result.nextCursor) {
        break;
      }
    }
  }

  private async drainBlobCleanupExecution(
    runId: string,
    gracePeriodDays: number,
    limit: number
  ) {
    for (;;) {
      const result = await this.rt.executeBlobCleanupCandidates(
        runId,
        gracePeriodDays,
        limit
      );
      await Promise.all(
        result.workspaceIds.map((workspaceId: string) =>
          this.event.emitAsync('workspace.blobs.updated', { workspaceId })
        )
      );
      this.logger.log(
        `executed blob cleanup run=${runId} deleted=${result.deletedObjects} skipped=${result.skippedStillReferenced} failed=${result.failed}`
      );

      const progressed =
        result.deletedMetadata > 0 || result.skippedStillReferenced > 0;
      if (result.scannedCandidates < limit || !progressed) {
        break;
      }
    }
  }

  private async loadPendingBlobCleanupRunIds(limit: number) {
    const rows = await this.db.$queryRaw<{ runId: string }[]>`
      SELECT run_id::text AS "runId"
      FROM blob_cleanup_candidates
      WHERE status IN ('marked', 'failed')
      GROUP BY run_id
      ORDER BY
        CASE WHEN BOOL_OR(status = 'marked') THEN 0 ELSE 1 END ASC,
        MIN(planned_at) ASC
      LIMIT ${limit}
    `;
    return rows.map(row => row.runId);
  }

  private async hasMarkedBlobCleanupCandidates() {
    const rows = await this.db.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1
        FROM blob_cleanup_candidates
        WHERE status = 'marked'
      ) AS "exists"
    `;
    return rows[0]?.exists ?? false;
  }

  private async hasObjectStorage(operation: string) {
    const health = await this.rt.health();
    if (health.provider) {
      return true;
    }

    this.logger.warn(
      `skip ${operation}: StorageRuntime provider is not configured`
    );
    return false;
  }

  // ── Pool-pressure resilience ───────────────────────────────────────────
  // The nightly blob sweeps iterate workspaces sequentially and open Prisma
  // transactions per workspace. When the connection pool is undersized (or a
  // transaction holds a connection too long), Prisma throws
  // "pool timed out while waiting for an open connection" (code P1004). That
  // is a transient, non-fatal condition: the sweep catches it per-workspace
  // and moves on, and the job re-enqueues itself for the next day. Logging it
  // at `error` with a full stack per workspace (sid=3, 4, 5, 6, 7, 8...) was
  // noisy and alarmed without cause. These helpers detect pool timeouts,
  // downgrade them to `warn`, and pause briefly so the pool can release the
  // stuck connection before the next workspace is attempted — preventing one
  // slow workspace from immediately starving the next.

  /**
   * True when an error is a Prisma/DB connection-pool timeout (P1004 or the
   * "pool timed out while waiting for an open connection" message). Matches
   * loosely so it also catches wrapped/driver-level variants.
   */
  private isPoolTimeoutError(err: unknown): boolean {
    if (!err) return false;
    const anyErr = err as { code?: string; message?: string };
    const code = String(anyErr.code ?? '').toUpperCase();
    const message = String(anyErr.message ?? err ?? '').toLowerCase();
    if (code === 'P1004') return true;
    return (
      message.includes('pool timed out') ||
      (message.includes('timed out') && message.includes('pool'))
    );
  }

  /**
   * Brief pause after a pool-timeout so the connection can be released before
   * the next workspace/run is attempted. Keeps the sweep sequential (no extra
   * concurrency) and is a no-op on non-timeout failures.
   */
  private async recoverFromPoolPressure(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  /**
   * Shared per-workspace failure handler for the BySid sweep loops. Downgrades
   * pool timeouts to `warn` (with a short backoff so the next workspace isn't
   * immediately starved) and keeps all other failures as `error` exactly as
   * before, preserving the original log shape for non-pool errors.
   */
  private async handleSweepFailure(
    operation: string,
    workspaceId: string,
    workspaceSid: number,
    err: unknown
  ): Promise<void> {
    if (this.isPoolTimeoutError(err)) {
      this.logger.warn(
        `${operation} stalled on pool timeout workspace=${workspaceId} sid=${workspaceSid} — will retry on next sweep`,
        err
      );
      await this.recoverFromPoolPressure();
    } else {
      this.logger.error(
        `${operation} failed workspace=${workspaceId} sid=${workspaceSid}`,
        err
      );
    }
  }
}
