// D1 — Shared upstream-scenario-failed detector.
//
// The cdz-ai upstream (Make.com scenario) intermittently returns 502 / engine
// errors that surface as thrown Errors inside stream consumption loops. This
// utility centralises the detection regex so the turn-orchestrator,
// action-stream-host, and SSE controller all use the same matching logic.
//
// Expanded beyond the original inline check to also catch:
//   - explicit 503/504 status codes
//   - "524 timeout" (Cloudflare-style)
//   - ECONNRESET / ECONNREFUSED / ETIMEDOUT / socket hang up
//   - generic "upstream" / "gateway" error mentions
//   - nested error.cause.message and error.body when present

const PATTERNS: RegExp[] = [
  /Scenario failed to complete/i,
  /engine error|scenario (failed|error|timeout)/i,
  /status[:\s]*(502|503|504)/i,
  /\b(502|503|504)\b.*\b(bad\s*gateway|service|timeout|upstream|scenario)/i,
  /524.*timeout|timeout.*524/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i,
  /upstream.*(error|failed|unavailable)/i,
  /gateway.*(error|timeout|unavailable)/i,
];

function extractRawMessage(error: unknown): string {
  if (error instanceof Error) {
    // Check error.message
    if (error.message) return error.message;
    // Some errors nest the real message in .cause
    const cause = (error as any).cause;
    if (cause && cause instanceof Error && cause.message) return cause.message;
    // Some errors carry a .body (e.g. fetch Response text)
    const body = (error as any).body;
    if (typeof body === 'string' && body) return body;
  }
  if (typeof error === 'string' && error) return error;
  return '';
}

/**
 * Returns true when the error matches one of the upstream-scenario-failed
 * patterns (502/503/504, engine error, scenario timeout, connection resets,
 * gateway/upstream errors). Safe to call with any unknown value.
 */
export function isUpstreamScenarioFailed(error: unknown): boolean {
  const raw = extractRawMessage(error);
  if (!raw) return false;
  return PATTERNS.some(pattern => pattern.test(raw));
}
