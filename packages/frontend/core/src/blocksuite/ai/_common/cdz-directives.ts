/**
 * CDZ hidden directives — instructions (worker skills, plan mode, …) that
 * must reach the MODEL alongside a user message but must NEVER render in the
 * transcript, tab titles, or session history.
 *
 * When the composer injects a directive it wraps it in explicit markers:
 *
 *   [[cdz:directive kind="worker" icon="🧰" label="Growth Hacker"]]
 *   …instruction text for the model…
 *   [[/cdz:directive]]
 *
 *   <the user's own words>
 *
 * Renderers call `stripCdzDirectives` on user-message content before showing
 * it: every marked block is removed and reported as a compact badge (so the
 * UI can show a subtle mode chip instead of a wall of prompt text). The
 * stripper also recognises the legacy, unmarked worker/plan prefixes that
 * shipped before markers existed, so existing history is cleaned up too.
 */

export interface CdzDirectiveBadge {
  kind: string;
  icon?: string;
  label?: string;
}

export interface CdzStrippedContent {
  /** the user-visible text with all directives removed */
  text: string;
  /** one badge per stripped directive (worker name, plan, …) */
  badges: CdzDirectiveBadge[];
}

const BLOCK_RE =
  /\[\[cdz:directive([^\]]*)\]\]\r?\n?[\s\S]*?\[\[\/cdz:directive\]\]\r?\n*/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;

// Legacy (pre-marker) formats already stored in old session history.
const LEGACY_WORKER_RE =
  /^\[ClickDz Worker: ([^\]]*)\]\r?\nAct as this specialist\.[\s\S]*?\r?\n---\r?\n/;
const LEGACY_PLAN_RE =
  /^\[Plan mode\]\r?\n[\s\S]{0,400}?over speed\.\r?\n\r?\n/;

const sanitizeAttr = (value: string) => value.replace(/["\]\n\r]/g, ' ').trim();

/**
 * Wrap a directive body in hidden-directive markers. The returned block ends
 * with a blank line so it can be prepended directly to the user input.
 */
export function wrapCdzDirective(
  badge: CdzDirectiveBadge,
  body: string
): string {
  const attrs = [
    `kind="${sanitizeAttr(badge.kind)}"`,
    badge.icon ? `icon="${sanitizeAttr(badge.icon)}"` : '',
    badge.label ? `label="${sanitizeAttr(badge.label)}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `[[cdz:directive ${attrs}]]\n${body.trim()}\n[[/cdz:directive]]\n\n`;
}

/**
 * Remove every hidden directive (marked or legacy) from user-message content
 * and report what was stripped as badges.
 */
export function stripCdzDirectives(content: string): CdzStrippedContent {
  if (!content) return { text: content ?? '', badges: [] };
  const badges: CdzDirectiveBadge[] = [];
  let text = content;

  if (text.includes('[[cdz:directive')) {
    text = text.replace(BLOCK_RE, (_match, rawAttrs: string) => {
      const badge: CdzDirectiveBadge = { kind: 'directive' };
      for (const [, key, value] of rawAttrs.matchAll(ATTR_RE)) {
        if (key === 'kind') badge.kind = value;
        else if (key === 'icon') badge.icon = value;
        else if (key === 'label') badge.label = value;
      }
      badges.push(badge);
      return '';
    });
  }

  // legacy plan wraps legacy worker (plan was prepended last), so strip the
  // plan prefix first, then the worker prefix — loop covers both orders.
  for (let i = 0; i < 2; i++) {
    const plan = text.match(LEGACY_PLAN_RE);
    if (plan) {
      badges.push({ kind: 'plan', icon: '🧭', label: 'Plan' });
      text = text.slice(plan[0].length);
      continue;
    }
    const worker = text.match(LEGACY_WORKER_RE);
    if (worker) {
      const [name, category] = worker[1].split('—').map(s => s.trim());
      badges.push({
        kind: 'worker',
        icon: '🧰',
        label: category ? `${name} · ${category}` : name,
      });
      text = text.slice(worker[0].length);
    }
  }

  return { text: badges.length ? text.replace(/^\s+/, '') : text, badges };
}

/** Convenience: stripped text only (tab titles, previews, rich text). */
export function stripCdzDirectivesToText(content: string): string {
  return stripCdzDirectives(content).text;
}
