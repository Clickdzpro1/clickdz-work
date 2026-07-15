import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';

import { cdzApiUrl } from '../provider';

/**
 * ClickDz Pulse — reasoning-animation ticker (shared Lit surface).
 *
 * While a slow generation runs, a fast model streams request-tailored
 * "reasoning" lines ("Analyzing your brief…", "Choosing a palette…") that this
 * element reveals one-by-one on a jittered timer. It mirrors the vdz React
 * ticker's look (see `ai-pulse-ticker.css.ts`): a soft pulsing brand dot + a
 * single crossfading line, in a self-contained dark palette (literal hex, no
 * theme tokens) so it drops into any busy surface without wiring.
 *
 * Usage (host owns `active`; flip it true when the real request fires):
 *   <cdz-pulse-ticker .task=${prompt} surface="app" ?active=${busy}></cdz-pulse-ticker>
 *
 * Contract: purely cosmetic. Every network hop is wrapped so a failed/aborted
 * pulse request degrades silently to nothing — it can never break the host UI.
 * Renders nothing until at least one line is ready.
 */

// Palette mirrored from ai-pulse-ticker.css.ts (inlined literal hex below in the
// static css, dark aesthetic):
//   raised #12151d · border #232838 · accent #5b8cff→#a06bff · text #e7eaf3

// Instant local fallbacks per surface — shown the moment `active` flips, so the
// row never blinks empty before the tailored lines land (and if the fetch
// fails, these carry the whole animation on their own).
const FALLBACKS: Record<string, string[]> = {
  app: [
    'Reading your brief…',
    'Sketching the layout…',
    'Wiring up the components…',
    'Polishing the details…',
  ],
  image: [
    'Reading your prompt…',
    'Composing the scene…',
    'Choosing a palette…',
    'Rendering the details…',
  ],
  chat: [
    'Thinking it through…',
    'Gathering the context…',
    'Weighing the options…',
    'Drafting a response…',
  ],
  video: [
    'Reading your brief…',
    'Blocking the shots…',
    'Timing the motion…',
    'Rendering frames…',
  ],
};

const genericFallback = ['Thinking it through…', 'Working on it…'];

@customElement('cdz-pulse-ticker')
export class CdzPulseTicker extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      min-height: 44px;
      padding: 10px 14px;
      box-sizing: border-box;
      border-radius: 12px;
      border: 1px solid #232838;
      background: #12151d;
      color: #e7eaf3;
      font-family:
        system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial,
        sans-serif;
      overflow: hidden;
    }
    .dot {
      flex-shrink: 0;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background-image: linear-gradient(135deg, #5b8cff, #a06bff);
      animation: cdz-pulse 1.4s ease-in-out infinite;
    }
    .line-wrap {
      position: relative;
      flex: 1;
      min-width: 0;
      height: 20px;
      line-height: 20px;
    }
    .line {
      display: block;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 13px;
      font-weight: 500;
      letter-spacing: -0.005em;
      color: #e7eaf3;
      animation: cdz-line-in 320ms ease;
    }
    .line.tail {
      opacity: 0.72;
    }
    @keyframes cdz-pulse {
      0%,
      100% {
        transform: scale(0.82);
        box-shadow: 0 0 0 0 rgba(91, 140, 255, 0.55);
        opacity: 0.85;
      }
      50% {
        transform: scale(1.12);
        box-shadow: 0 0 10px 3px rgba(160, 107, 255, 0.45);
        opacity: 1;
      }
    }
    @keyframes cdz-line-in {
      from {
        opacity: 0;
        transform: translateY(4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .dot {
        animation: none;
        opacity: 0.9;
      }
      .line {
        animation: none;
      }
    }
  `;

  /** One-line summary of the user's request (trimmed to ≤2k server-side). */
  @property({ attribute: false })
  accessor task = '';

  /** Which busy surface this ticker decorates. */
  @property()
  accessor surface: 'app' | 'image' | 'chat' | 'video' = 'chat';

  /** Host flips this true while the real (slow) request is in flight. */
  @property({ type: Boolean })
  accessor active = false;

  @state()
  private accessor _line = '';

  // True once we've looped past the fetched script into its repeating tail.
  @state()
  private accessor _tail = false;

  private _lines: string[] = [];
  private _idx = 0;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _runId = 0;

  override updated(changed: Map<string, unknown>) {
    if (changed.has('active')) {
      if (this.active) this._begin();
      else this._end();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._end();
  }

  private _begin() {
    const runId = ++this._runId;
    // Seed with local fallbacks so the row animates instantly.
    this._lines = (FALLBACKS[this.surface] ?? genericFallback).slice();
    this._idx = 0;
    this._tail = false;
    this._line = this._lines[0] ?? '';
    this._schedule();
    // Swap in tailored lines when they land; never gate on them.
    void this._fetch(runId);
  }

  private _end() {
    this._runId++;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._line = '';
    this._lines = [];
    this._idx = 0;
    this._tail = false;
  }

  private async _fetch(runId: number) {
    try {
      const res = await fetch(cdzApiUrl('/api/v1/ai/pulse'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: (this.task || '').slice(0, 2000),
          surface: this.surface,
        }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { lines?: unknown };
      // Ignore if the run was stopped/restarted while we awaited.
      if (runId !== this._runId) return;
      const lines = Array.isArray(data?.lines)
        ? data.lines.filter((l): l is string => typeof l === 'string' && !!l)
        : [];
      if (!lines.length) return;
      // Splice tailored lines in after whatever's already shown, so the reveal
      // stays smooth rather than snapping back to the top.
      this._lines = lines;
      this._idx = Math.min(this._idx, lines.length - 1);
      this._tail = false;
      this._line = this._lines[this._idx] ?? this._line;
    } catch {
      // Cosmetic route — degrade silently to the local fallbacks already running.
    }
  }

  private _schedule() {
    if (this._timer) clearTimeout(this._timer);
    // Jittered 1.8–3s cadence, matching the vdz reveal feel.
    const delay = 1800 + Math.floor(Math.random() * 1200);
    this._timer = setTimeout(() => this._advance(), delay);
  }

  private _advance() {
    if (!this.active || !this._lines.length) return;
    const next = this._idx + 1;
    if (next < this._lines.length) {
      this._idx = next;
    } else {
      // Outlived the script: loop over the last 3 lines as a "still working" tail.
      this._tail = true;
      const tailStart = Math.max(0, this._lines.length - 3);
      const span = this._lines.length - tailStart;
      this._idx = tailStart + ((this._idx + 1 - tailStart) % span);
    }
    this._line = this._lines[this._idx] ?? this._line;
    this._schedule();
  }

  override render() {
    if (!this.active || !this._line) return nothing;
    return html`<div class="row" role="status" aria-live="polite">
      <span class="dot" aria-hidden="true"></span>
      <span class="line-wrap">
        ${keyed(
          this._line,
          html`<span class="line ${this._tail ? 'tail' : ''}"
            >${this._line}</span
          >`
        )}
      </span>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cdz-pulse-ticker': CdzPulseTicker;
  }
}
