import { NextFunction, Request, Response } from 'express';

// SEC-6 — baseline security response headers (verified missing in production:
// no Content-Security-Policy, no Strict-Transport-Security, no
// X-Frame-Options on work.clickdz.ai).
//
// Deliberately conservative so it cannot break the SPA or the published-app
// serve routes:
//   • The default CSP does NOT restrict script/style/img sources (the studio
//     bundle relies on inline styles and dynamic chunks) — it only forbids
//     plugin content, pins <base>, and limits who may FRAME us (clickjacking).
//     Operators can tighten it via CDZ_CSP without a code change.
//   • HSTS is emitted in production only (never on plain-http local dev) and
//     without includeSubDomains (other subdomains of the zone are not ours to
//     commit). CDZ_HSTS=0 turns just it off.
//   • CDZ_SECURITY_HEADERS=0 disables the whole middleware (escape hatch).
//   • Every header is set only when the route has not already set it, so a
//     future route-level override always wins.
//
// House shape mirrors ./timing.ts: a plain exported express middleware, wired
// once in server.ts.

const HEADERS_OFF = process.env.CDZ_SECURITY_HEADERS === '0';
const HSTS_OFF = process.env.CDZ_HSTS === '0';
/** Override the default policy wholesale via env (single-line CSP). */
const CSP_VALUE =
  process.env.CDZ_CSP ||
  "object-src 'none'; base-uri 'self'; frame-ancestors 'self'";
/** 180 days — long enough for preload-less HSTS to matter, short enough to undo. */
const HSTS_VALUE = 'max-age=15552000';

const setIfAbsent = (res: Response, name: string, value: string) => {
  if (!res.getHeader(name)) res.setHeader(name, value);
};

export const securityHeaders = (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  if (HEADERS_OFF) {
    next();
    return;
  }
  setIfAbsent(res, 'Content-Security-Policy', CSP_VALUE);
  setIfAbsent(res, 'X-Frame-Options', 'SAMEORIGIN');
  setIfAbsent(res, 'X-Content-Type-Options', 'nosniff');
  setIfAbsent(res, 'Referrer-Policy', 'strict-origin-when-cross-origin');
  if (env.prod && !HSTS_OFF) {
    setIfAbsent(res, 'Strict-Transport-Security', HSTS_VALUE);
  }
  next();
};
