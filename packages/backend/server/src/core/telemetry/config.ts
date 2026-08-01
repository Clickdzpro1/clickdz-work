import { defineModuleConfig } from '../../base';

export interface TelemetryConfig {
  allowedOrigin: ConfigItem<string[]>;
  ga4: {
    measurementId: ConfigItem<string>;
    apiSecret: ConfigItem<string>;
  };
  dedupe: {
    ttlHours: ConfigItem<number>;
    maxEntries: ConfigItem<number>;
  };
  batch: {
    maxEvents: ConfigItem<number>;
  };
  posthog: {
    key: ConfigItem<string>;
    host: ConfigItem<string>;
  };
}

declare global {
  interface AppConfigSchema {
    telemetry: TelemetryConfig;
  }
}

defineModuleConfig('telemetry', {
  allowedOrigin: {
    desc: 'Allowed origins for telemetry collection.',
    default: ['localhost', '127.0.0.1'],
  },
  'ga4.measurementId': {
    desc: 'GA4 Measurement ID for Measurement Protocol.',
    default: '',
    env: 'GA4_MEASUREMENT_ID',
  },
  'ga4.apiSecret': {
    desc: 'GA4 API secret for Measurement Protocol.',
    default: '',
    env: 'GA4_API_SECRET',
  },
  'dedupe.ttlHours': {
    desc: 'Telemetry dedupe TTL in hours.',
    default: 24,
  },
  'dedupe.maxEntries': {
    desc: 'Telemetry dedupe max entries.',
    default: 100000,
  },
  'batch.maxEvents': {
    desc: 'Max events per telemetry batch.',
    default: 25,
  },
  'posthog.key': {
    desc: 'PostHog project API key (phc_…) for server-side capture. Empty = PostHog forwarding disabled.',
    default: '',
    env: 'CDZ_POSTHOG_KEY',
  },
  'posthog.host': {
    desc: 'PostHog capture host, e.g. https://eu.i.posthog.com (EU Cloud), https://us.i.posthog.com, or a self-hosted instance URL.',
    default: '',
    env: 'CDZ_POSTHOG_HOST',
  },
});
