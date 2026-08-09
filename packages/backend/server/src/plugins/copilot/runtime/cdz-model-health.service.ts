// D1 — Model-level circuit breaker for cdz-ai models.
//
// When a model (typically cdz-sage) fails the upstream Make-scenario 502
// repeatedly, the circuit opens and subsequent requests for that model are
// automatically routed to the reliable fallback (cdz-flash) for a cooldown
// period. This prevents cascading failures and gives the upstream scenario
// time to recover.
//
// Configuration:
//   WINDOW_MS         = 60_000   (failure counting window)
//   FAILURE_THRESHOLD = 3        (consecutive failures in window to trip)
//   COOLDOWN_MS       = 90_000   (circuit open duration)
//
// In-memory only (no Redis) — per-instance state. Acceptable because each
// backend instance independently trips its own circuit; the net effect is
// that any instance seeing sustained failures will self-route to flash.

import { Injectable, Logger } from '@nestjs/common';

interface ModelHealthState {
  failures: number[];
  openUntil: number;
}

const WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 90_000;

const FALLBACK_MAP: Record<string, string> = {
  'cdz-sage': 'cdz-flash',
  'cdz-ultra': 'cdz-flash',
  'cdz-council': 'cdz-flash',
  'cdz-architect': 'cdz-flash',
  'cdz-scholar': 'cdz-flash',
};

@Injectable()
export class CdzModelHealthService {
  private readonly logger = new Logger(CdzModelHealthService.name);
  private readonly states = new Map<string, ModelHealthState>();

  /**
   * Returns true when the circuit is currently open for the given model
   * (i.e. the model should be skipped in favor of a fallback).
   */
  isCircuitOpen(modelId: string): boolean {
    const state = this.states.get(modelId);
    if (!state) return false;
    if (state.openUntil > Date.now()) return true;
    // Circuit cooldown expired — reset
    if (state.openUntil > 0) {
      state.openUntil = 0;
      state.failures = [];
    }
    return false;
  }

  /**
   * Record a failure for the given model. When the failure count reaches
   * FAILURE_THRESHOLD within WINDOW_MS, the circuit opens for COOLDOWN_MS.
   */
  recordFailure(modelId: string): void {
    const now = Date.now();
    let state = this.states.get(modelId);
    if (!state) {
      state = { failures: [], openUntil: 0 };
      this.states.set(modelId, state);
    }
    // Prune failures outside the window
    state.failures = state.failures.filter(ts => now - ts < WINDOW_MS);
    state.failures.push(now);

    if (state.failures.length >= FAILURE_THRESHOLD && state.openUntil <= now) {
      state.openUntil = now + COOLDOWN_MS;
      this.logger.warn(
        `[circuit-breaker] circuit OPEN for model ${modelId} — ${state.failures.length} failures in ${WINDOW_MS}ms window, routing to fallback for ${COOLDOWN_MS}ms`
      );
    }
  }

  /**
   * Record a success for the given model. Resets the failure count and
   * closes the circuit if it was open.
   */
  recordSuccess(modelId: string): void {
    const state = this.states.get(modelId);
    if (!state) return;
    state.failures = [];
    state.openUntil = 0;
  }

  /**
   * Returns the fallback model id when the circuit is open for the given
   * model, or undefined when the circuit is closed or no fallback is mapped.
   */
  getFallbackModel(modelId: string): string | undefined {
    if (!this.isCircuitOpen(modelId)) return undefined;
    const fallback = FALLBACK_MAP[modelId];
    if (fallback) {
      this.logger.warn(
        `[circuit-breaker] routing ${modelId} -> ${fallback} (circuit open)`
      );
      return fallback;
    }
    return undefined;
  }
}
