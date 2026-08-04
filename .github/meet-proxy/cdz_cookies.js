// CHIPS cookie hardening for ZOOM+ (La Suite Meet) served in a cross-site
// iframe on work.clickdz.ai.
//
// Meet's Django backend sets `sessionid` / `csrftoken` cookies on the
// meet-frontend origin, which is THIRD-PARTY to the top-level work.clickdz.ai
// site. nginx's `proxy_cookie_flags` can force `SameSite=None; Secure` but it
// CANNOT emit the `Partitioned` attribute (CHIPS). Modern Chromium blocks
// non-partitioned third-party cookies, so the session cookie is dropped inside
// the iframe and the SPA keeps showing "Login" even after a successful OIDC
// round-trip.
//
// This njs response header-filter appends `; Partitioned` (and normalizes
// SameSite=None; Secure) to every Set-Cookie the backend emits through the
// proxy. This is the exact mechanism that already makes SlidePro/Postiz work
// through the Node app-shim — done here in-image so no extra service and NO
// OIDC/redirect_uri changes are required (everything stays first-party-to-
// itself on the meet-frontend origin; only the cookie partitioning changes).
function partitionCookies(r) {
  var sc = r.headersOut['Set-Cookie'];
  if (!sc) return;
  if (!Array.isArray(sc)) sc = [sc];
  r.headersOut['Set-Cookie'] = sc.map(function (c) {
    var lc = c.toLowerCase();
    if (lc.indexOf('partitioned') !== -1) return c; // already partitioned
    // Force SameSite=None (strip Lax/Strict if present).
    if (lc.indexOf('samesite=none') === -1) {
      c = c.replace(/;\s*SameSite=(Lax|Strict|None)/i, '');
      c += '; SameSite=None';
    }
    // Partitioned cookies MUST be Secure.
    if (!/;\s*Secure/i.test(c)) c += '; Secure';
    c += '; Partitioned';
    return c;
  });
}

export default { partitionCookies };
