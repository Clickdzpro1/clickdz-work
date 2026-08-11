// ClickDz HERMES — quick-start workflows panel.
//
// A curated, self-contained library of REAL operations workflows the Hermes
// agent can run given its actual tool catalog (shop/ERP reads, Composio app
// actions — Gmail/Sheets/Slack/Notion, the built-in assistant, and
// reporting/digest compositions). Each card carries a concrete, ready-to-run
// goal string; clicking a card injects that goal into the console composer via
// `onPick`. No fetching — purely presentational + inline styles, matching the
// Hermes page palette. prefers-reduced-motion safe (transform/opacity only,
// killed via the .cdz-hermesx-motion guard below).
import type { CSSProperties } from 'react';
import { useState } from 'react';

// ---------------------------------------------------------------------------
// Palette — a local copy of the Hermes page `C` object (each value an
// --affine-* theme var with a hard dark fallback) so this panel reads
// correctly standalone and never depends on a sibling barrel resolving.
// ---------------------------------------------------------------------------
const C = {
  bg: 'var(--affine-background-primary-color, #141414)',
  panel: 'var(--affine-background-secondary-color, #1c1c1e)',
  border: 'var(--affine-border-color, #2a2a2c)',
  text: 'var(--affine-text-primary-color, #ececec)',
  muted: 'var(--affine-text-secondary-color, #9aa0a6)',
  accent: 'var(--affine-primary-color, #1e96eb)',
  accentSoft:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 14%, transparent)',
} as const;

// Page-unique keyframes + reduced-motion opt-out, injected once via a <style>
// tag (same trick the Hermes/Integrations pages use). Card hover lift is a
// 160ms transform/box-shadow transition, disabled for reduced-motion users.
const WORKFLOWS_CSS = `
@keyframes cdz-hermesx-wf-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.cdz-hermesx-wf{animation:cdz-hermesx-wf-in 240ms ease both}
@media (prefers-reduced-motion: reduce){
  .cdz-hermesx-wf{animation:none !important}
  .cdz-hermesx-motion{transition:none !important}
}
`;

interface WorkflowCard {
  title: string;
  desc: string;
  goal: string;
}

interface WorkflowCategory {
  key: string;
  icon: string;
  title: string;
  blurb: string;
  cards: WorkflowCard[];
}

// The curated library. Every goal is phrased the way a user would ask Hermes,
// and is achievable with the live tool catalog (shops_list / shop_erp_summary /
// composio_discover / composio_execute / make_agent_run). Kept concrete and
// genuinely useful — no filler.
const CATEGORIES: WorkflowCategory[] = [
  {
    key: 'orders',
    icon: '🛒',
    title: 'Orders & shop operations',
    blurb: 'Read your live shop/ERP data and turn it into action.',
    cards: [
      {
        title: 'Daily orders digest',
        desc: 'Summarize today’s orders across all your shops.',
        goal: 'List all my shops, then summarize today’s orders across them: total count, revenue, and a breakdown by status. Call out anything that needs attention.',
      },
      {
        title: 'Pending-order chase list',
        desc: 'Find unfulfilled orders and draft a customer follow-up.',
        goal: 'Find all pending and unfulfilled orders across my shops and draft a short, friendly WhatsApp broadcast asking those customers to confirm their order.',
      },
      {
        title: 'Low-stock alert',
        desc: 'Flag products running low before they sell out.',
        goal: 'Check the ERP summary for each of my shops and list every product that is low or out of stock, grouped by shop, with a suggested reorder note.',
      },
      {
        title: 'Revenue this month',
        desc: 'Month-to-date revenue and order health per shop.',
        goal: 'For each of my shops, report month-to-date revenue, number of orders, and the split of orders by status so I can see which store is performing best.',
      },
    ],
  },
  {
    key: 'reporting',
    icon: '📈',
    title: 'Reporting & digests',
    blurb: 'Compose readable summaries and briefings you can forward.',
    cards: [
      {
        title: 'Morning operations brief',
        desc: 'One tidy briefing covering orders, revenue and stock.',
        goal: 'Build me a morning operations brief across all my shops: today’s orders and revenue, pending fulfilment, and any low-stock products. Keep it to a short bulleted summary I can read in 30 seconds.',
      },
      {
        title: 'Weekly performance recap',
        desc: 'A week-over-week rollup of the key numbers.',
        goal: 'Prepare a weekly performance recap for my shops: total orders, revenue, top-selling products, and anything that changed notably versus what the data shows. End with two or three concrete suggestions.',
      },
      {
        title: 'Per-shop health check',
        desc: 'Deep-dive one store and grade its current state.',
        goal: 'Pick my busiest shop, read its full ERP summary, and give me a health check: what’s going well, what needs attention, and the single most important thing to fix this week.',
      },
    ],
  },
  {
    key: 'apps',
    icon: '🔗',
    title: 'Connected apps (Composio)',
    blurb: 'Send email, update sheets and post to chat with your tools.',
    cards: [
      {
        title: 'Email today’s summary',
        desc: 'Draft & send the daily digest over Gmail.',
        goal: 'Summarize today’s orders across my shops, then use Gmail to draft an email with that summary. Show me the draft before sending it.',
      },
      {
        title: 'Log orders to a spreadsheet',
        desc: 'Append today’s order totals to Google Sheets.',
        goal: 'Read today’s order totals for each of my shops and append a dated row per shop to my Google Sheet. Tell me the columns you plan to write first.',
      },
      {
        title: 'Post a Slack update',
        desc: 'Share a short ops update to your team channel.',
        goal: 'Compose a concise operations update — today’s orders, revenue, and anything pending — and post it to my team’s Slack channel.',
      },
      {
        title: 'Discover what an app can do',
        desc: 'See the actions available for a connected toolkit.',
        goal: 'Discover the available Composio tools for Gmail and list what actions I can automate with it, plus the inputs each one needs.',
      },
    ],
  },
  {
    key: 'automation',
    icon: '🤖',
    title: 'Automations & drafting',
    blurb: 'Hand longer reasoning or drafting to your agent — it runs right here.',
    cards: [
      {
        title: 'Draft a customer reply',
        desc: 'Have a polished response drafted for you.',
        goal: 'Draft a warm, professional reply to a customer asking where their order is, leaving placeholders for the order number and expected date.',
      },
      {
        title: 'Write product descriptions',
        desc: 'Generate copy for items that need it.',
        goal: 'List products in my shop that are missing a description, then draft a short, persuasive description for each one.',
      },
      {
        title: 'Plan a promotion',
        desc: 'Turn your numbers into a campaign outline.',
        goal: 'Look at my recent order and product data, then outline a one-week promotion — which products to feature, a discount idea, and a WhatsApp broadcast message.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 22,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const headerTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 700,
  color: C.text,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const headerSubStyle: CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  color: C.muted,
  lineHeight: 1.5,
};

const categoryTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 700,
  color: C.text,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const categoryBlurbStyle: CSSProperties = {
  margin: 0,
  fontSize: 11.5,
  color: C.muted,
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 10,
  marginTop: 10,
};

const cardTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: C.text,
};

const cardDescStyle: CSSProperties = {
  margin: 0,
  fontSize: 11.5,
  color: C.muted,
  lineHeight: 1.45,
};

const cardCtaStyle: CSSProperties = {
  marginTop: 'auto',
  fontSize: 11,
  fontWeight: 600,
  color: C.accent,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
};

// A single clickable workflow card. Hover lift is handled with local state so
// the whole styling stays inline (no external CSS beyond the keyframes above).
const Card = ({ card, onPick }: { card: WorkflowCard; onPick: (goal: string) => void }) => {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      className="cdz-hermesx-motion"
      onClick={() => onPick(card.goal)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      title={card.goal}
      style={{
        appearance: 'none',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 108,
        padding: '13px 14px',
        borderRadius: 12,
        background: hover ? C.accentSoft : C.panel,
        border: `1px solid ${hover ? C.accent : C.border}`,
        color: C.text,
        transform: hover ? 'translateY(-2px)' : 'none',
        boxShadow: hover ? '0 6px 18px rgba(0,0,0,0.28)' : 'none',
        transition: 'transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, background 160ms ease',
      }}
    >
      <p style={cardTitleStyle}>{card.title}</p>
      <p style={cardDescStyle}>{card.desc}</p>
      <span style={{ ...cardCtaStyle, opacity: hover ? 1 : 0.7 }}>
        Run this →
      </span>
    </button>
  );
};

/**
 * HermesWorkflowsPanel — curated quick-start library. Clicking any card calls
 * `onPick(goal)` with a concrete, ready-to-run goal string for the composer.
 */
export function HermesWorkflowsPanel({
  onPick,
}: {
  onPick: (goal: string) => void;
}) {
  return (
    <div className="cdz-hermesx-wf" style={rootStyle}>
      <style>{WORKFLOWS_CSS}</style>

      <div style={headerStyle}>
        <h2 style={headerTitleStyle}>
          <span
            aria-hidden
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              background: `linear-gradient(135deg, ${C.accent}, color-mix(in srgb, ${C.accent} 65%, #000))`,
              flexShrink: 0,
            }}
          >
            ⚡
          </span>{' '}
          Quick-start workflows
        </h2>
        <p style={headerSubStyle}>
          Pick a task to load it into the composer — then run, tweak, or ask
          Hermes to keep going. Everything here uses your live shops and
          connected tools.
        </p>
      </div>

      {CATEGORIES.map(cat => (
        <section key={cat.key} style={{ display: 'flex', flexDirection: 'column' }}>
          <h3 style={categoryTitleStyle}>
            <span aria-hidden>{cat.icon}</span> {cat.title}
          </h3>
          <p style={categoryBlurbStyle}>{cat.blurb}</p>
          <div style={gridStyle}>
            {cat.cards.map(card => (
              <Card key={card.title} card={card} onPick={onPick} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default HermesWorkflowsPanel;
