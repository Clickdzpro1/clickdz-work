/**
 * `cdz-export` — device-preview presets + HTML export helpers for the ClickDz
 * Builder Studio.
 *
 * Two flavours of API live here, kept together because the studio's Export /
 * responsive-preview UI consumes them as a unit:
 *
 *   - PURE + testable: {@link CDZ_DEVICE_PRESETS} (data) and
 *     {@link htmlFilename} (a deterministic string→string sanitizer). No DOM,
 *     no globals — safe to call anywhere, exercised by a node self-test.
 *   - BROWSER-ONLY: {@link downloadHtml} (Blob + object-URL + a synthetic
 *     `<a download>` click) and {@link copyToClipboard}
 *     (`navigator.clipboard.writeText`). These touch `document`, `window`,
 *     `Blob`, `URL`, and `navigator`, but ONLY from inside the function body —
 *     never at module top level — so a bare `import` of this file never crashes
 *     in a non-DOM environment (node self-test, SSR). Each guards the globals it
 *     needs and fails soft rather than throwing.
 *
 * Dependency-free: no `lit`, no third-party deps. TS strict.
 *
 * Contract: see studio-preview-export brief §1.
 */

/**
 * A selectable width for the responsive preview. `width` is the pixel cap
 * applied to the iframe wrapper (`max-width`); `null` means "full / fit" — the
 * preview fills its container at 100% width with no cap.
 */
export interface CdzDevicePreset {
  /** Stable id used as the studio's `previewDevice` state value. */
  id: string;
  /** Human-readable label for the segmented control. */
  label: string;
  /** Max width in CSS px, or `null` for full-width / fit-to-container. */
  width: number | null;
}

/**
 * The device presets offered by the preview's segmented control, ordered
 * desktop → tablet → mobile. `desktop` is the default (`width: null` = full /
 * fit). The tablet (820) and mobile (390) widths are common portrait viewport
 * widths (~iPad portrait content width and a modern ~6" phone, respectively),
 * chosen to give a representative narrow layout without matching one exact
 * device. `as const` freezes the shape while still satisfying
 * `CdzDevicePreset[]`.
 */
export const CDZ_DEVICE_PRESETS: readonly CdzDevicePreset[] = [
  { id: 'desktop', label: 'Desktop', width: null },
  { id: 'tablet', label: 'Tablet', width: 820 },
  { id: 'mobile', label: 'Mobile', width: 390 },
] as const;

/**
 * Build a safe, deterministic download filename from an app slug.
 *
 * PURE — no DOM, no globals. Sanitization rules (applied in order):
 *   1. Coerce a nullish / non-string / whitespace-only slug to the literal
 *      `'app'` (so `undefined`, `null`, `''`, `'   '` → `'app.html'`).
 *   2. Lowercase.
 *   3. Replace every run of characters that are NOT `[a-z0-9]` with a single
 *      hyphen (spaces, punctuation, `/`, `.`, unicode, `!` … all collapse).
 *   4. Trim leading/trailing hyphens.
 *   5. If nothing survives (the slug was e.g. `'!!!'`), fall back to `'app'`.
 *   6. Append the `.html` extension.
 *
 * The result therefore always matches `^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.html$`
 * and can never contain a path separator, so it is safe to hand to a
 * `<a download>` attribute. Examples: `'My App!'` → `'my-app.html'`,
 * `'foo/bar.txt'` → `'foo-bar-txt.html'`, `''` → `'app.html'`.
 */
export function htmlFilename(slug: string): string {
  const raw = typeof slug === 'string' ? slug : '';
  const base = raw.trim() === '' ? 'app' : raw;
  const cleaned = base
    .toLowerCase()
    // Any non [a-z0-9] run → single hyphen.
    .replace(/[^a-z0-9]+/g, '-')
    // Strip leading/trailing hyphens left by the collapse above.
    .replace(/^-+|-+$/g, '');
  const safe = cleaned === '' ? 'app' : cleaned;
  return `${safe}.html`;
}

/**
 * Trigger a browser download of `html` as a standalone `.html` file named
 * `filename`.
 *
 * BROWSER-ONLY. Wraps the HTML in a `text/html` `Blob`, mints an object URL,
 * clicks a detached `<a download>`, then revokes the URL (on the next macrotask
 * so the click has committed). No-ops silently when the required globals
 * (`document`, `Blob`, `URL.createObjectURL`) are unavailable — e.g. during the
 * node self-test — instead of throwing, so a bare import stays safe.
 */
export function downloadHtml(html: string, filename: string): void {
  // Guard every global we touch; bail without throwing when any is missing.
  if (
    typeof document === 'undefined' ||
    typeof Blob === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return;
  }

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // Keep it out of layout/flow; some engines want it connected to fire.
    a.style.display = 'none';
    a.rel = 'noopener';
    document.body?.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke after the click has been processed. setTimeout(0) is enough; guard
    // in case the environment lacks a timer.
    if (typeof setTimeout === 'function') {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } else {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Copy `text` to the system clipboard via the async Clipboard API.
 *
 * BROWSER-ONLY, but never throws: resolves `true` on a successful write and
 * `false` on ANY failure — missing `navigator.clipboard` (unsupported browser,
 * insecure context, or node self-test), a rejected write promise, or a
 * synchronous throw. Callers can branch on the boolean to show a
 * "Copied ✓" / "Copy failed" hint.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== 'function'
    ) {
      return false;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Rejected write (e.g. permission denied, not focused) or any throw.
    return false;
  }
}
