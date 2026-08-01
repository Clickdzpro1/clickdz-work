import { Logger } from '@nestjs/common';

import { CleanedTelemetryEvent } from './cleaner';

export type PostHogCaptureInput = {
  event: string;
  /** PostHog distinct_id — typically the authed user id. */
  distinctId: string;
  properties?: Record<string, unknown>;
  timestamp?: Date;
};

type PostHogCaptureEvent = {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp?: string;
};

type PostHogCapturePayload = {
  api_key: string;
  historical_migration?: boolean;
  batch: PostHogCaptureEvent[];
};

/**
 * Server-side PostHog capture client (ClickDz).
 *
 * Forwards cleaned telemetry events to PostHog's public capture API
 * (`POST {host}/batch/`, falling back shape-compatible with `/capture/`) using
 * the PROJECT api key. Configured entirely by env vars read through the config
 * module (see config.ts):
 *
 *   CDZ_POSTHOG_KEY — PostHog project api key (`phc_…`)
 *   CDZ_POSTHOG_HOST — e.g. https://eu.i.posthog.com (EU Cloud),
 *                      https://us.i.posthog.com, or a self-hosted instance
 *
 * When either is empty the client is a NO-OP (`send` returns immediately).
 */
export class PostHogClient {
  private readonly logger = new Logger(PostHogClient.name);

  constructor(
    private readonly apiKey: string,
    private readonly host: string,
    private readonly maxEvents: number
  ) {}

  get enabled(): boolean {
    return Boolean(this.apiKey && this.host);
  }

  async send(events: CleanedTelemetryEvent[]) {
    if (!events.length || !this.enabled) {
      return;
    }

    for (const chunk of chunkEvents(events, this.maxEvents)) {
      const payload: PostHogCapturePayload = {
        api_key: this.apiKey,
        batch: chunk.map(event => toCaptureEvent(event)),
      };
      try {
        await this.post(payload);
      } catch (error) {
        // Analytics forwarding must never fail the telemetry pipeline:
        // log and continue with the next chunk.
        this.logger.warn(
          `Failed to send ${chunk.length} event(s) to PostHog: ${
            (error as Error)?.message ?? 'unknown error'
          }`
        );
      }
    }
  }

  /**
   * Capture a single server-side event directly (bypasses the telemetry-batch
   * path). Used by other modules — e.g. the app-provision controller firing
   * `user_provisioned_app` — that don't ride the frontend telemetry pipeline.
   * Fire-and-forget safe: logs on failure, never throws.
   */
  async capture(input: PostHogCaptureInput): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const payload: PostHogCapturePayload = {
      api_key: this.apiKey,
      batch: [
        {
          event: input.event,
          distinct_id: input.distinctId,
          properties: {
            ...input.properties,
            source: 'clickdz_server',
          },
          timestamp: (input.timestamp ?? new Date()).toISOString(),
        },
      ],
    };
    try {
      await this.post(payload);
    } catch (error) {
      this.logger.warn(
        `Failed to capture PostHog event "${input.event}": ${
          (error as Error)?.message ?? 'unknown error'
        }`
      );
    }
  }

  private async post(payload: PostHogCapturePayload) {
    const url = new URL(
      '/batch/',
      this.host.endsWith('/') ? this.host : `${this.host}/`
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `PostHog request failed with ${response.status}: ${body || 'unknown error'}`
      );
    }
  }
}

/**
 * Build a client from raw values. Prefer `createPostHogClientFromEnv()` when
 * no Config service is in scope (e.g. plugin controllers that read env
 * directly). When key/host are empty the returned client is a no-op.
 */
export function createPostHogClient(
  apiKey?: string,
  host?: string,
  maxEvents = 25
): PostHogClient {
  return new PostHogClient(apiKey ?? '', host ?? '', maxEvents);
}

/**
 * Build a client straight from `CDZ_POSTHOG_KEY` / `CDZ_POSTHOG_HOST` env
 * vars — the same names the telemetry config module maps. Returns a no-op
 * client when either is unset.
 */
export function createPostHogClientFromEnv(): PostHogClient {
  return createPostHogClient(
    process.env.CDZ_POSTHOG_KEY,
    process.env.CDZ_POSTHOG_HOST
  );
}

function toCaptureEvent(event: CleanedTelemetryEvent): PostHogCaptureEvent {
  return {
    event: event.eventName,
    // PostHog groups events by distinct_id: prefer the authed user id, fall
    // back to the anonymous client id.
    distinct_id: event.userId || event.clientId,
    properties: {
      ...event.params,
      ...(Object.keys(event.userProperties).length
        ? { $set: event.userProperties }
        : {}),
      // Preserve the anonymous id so anonymous → authed journeys stay linked
      // once PostHog merges on identify.
      clickdz_client_id: event.clientId,
      clickdz_event_id: event.eventId,
      source: 'clickdz_server',
    },
    timestamp: new Date(event.timestampMicros / 1000).toISOString(),
  };
}

function chunkEvents<T>(events: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < events.length; i += size) {
    chunks.push(events.slice(i, i + size));
  }
  return chunks;
}
