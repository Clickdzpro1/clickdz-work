// ZOOM+ — Post-call meeting résumé panel (AI-generated structured summary).
//
// Mounts inside the ZOOM+ shell. On mount it probes GET /api/v1/zoomplus/
// summary/enabled — if the flag is OFF (or the fetch fails), the panel renders
// null and is completely invisible. The parent can always safely mount it;
// the probe is the gate.
//
// When enabled, it renders a collapsible panel "Résumé de la réunion" with:
//   · a transcript textarea (paste)
//   · a language select (Français / Darija / Arabe / Auto)
//   · an optional title input
//   · a "Générer le résumé" button
// On submit it POSTs to /api/v1/zoomplus/summary, shows a Spinner (can take
// ~30-45s), then renders the structured résumé (summary, decisions, action
// items with owner+task, next steps) or an error Banner.
//
// All inline-styled (C palette, Spinner, Banner). French with curved ’
// apostrophes. dir="auto" on content. Fail-open: any error shows inline.

import { useCallback, useEffect, useState } from 'react';
import { C, Spinner, Banner, miniBtnStyle } from './shoperp-shared';

// ---------------------------------------------------------------------------
// Types — mirror the backend's ZoomPlusStructuredSummary + ZoomPlusSummaryResult.
// ---------------------------------------------------------------------------

interface ActionItem {
  owner: string;
  task: string;
}

interface StructuredSummary {
  summary: string;
  decisions: string[];
  actionItems: ActionItem[];
  nextSteps: string[];
}

interface SummaryResult {
  ok: boolean;
  error?: string;
  summary?: StructuredSummary;
  model?: string;
  lang?: string;
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// API helpers — plain fetch, AbortSignal.timeout, fail-open.
// ---------------------------------------------------------------------------

async function fetchEnabled(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/zoomplus/summary/enabled', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { enabled?: boolean } | null;
    return !!data?.enabled;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Recordings — server-side LiveKit Egress recordings for this room. Fail-open:
// null on any error (egress unconfigured, host controls off, network). The
// panel renders the list only when there is something to show.
// ---------------------------------------------------------------------------

interface RecordingFile {
  filename?: string;
  location?: string;
  size?: number;
  duration?: number;
}
interface RecordingItem {
  egressId: string;
  status: string;
  startedAt?: number;
  endedAt?: number;
  files: RecordingFile[];
}

async function fetchRecordings(room: string): Promise<RecordingItem[] | null> {
  try {
    const res = await fetch(
      `/api/v1/zoomplus/host/recordings?room=${encodeURIComponent(room)}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; recordings?: RecordingItem[] }
      | null;
    if (!data || data.ok === false) return null;
    return Array.isArray(data.recordings) ? data.recordings : [];
  } catch {
    return null;
  }
}

function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '';
  const mb = n / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} Go`;
  return `${mb.toFixed(1)} Mo`;
}

function fmtDuration(ns?: number): string {
  // LiveKit reports duration in nanoseconds.
  if (!ns || ns <= 0) return '';
  const totalSec = Math.round(ns / 1e9);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

async function postSummary(body: {
  transcript: string;
  lang: string;
  title?: string;
}): Promise<SummaryResult> {
  try {
    const res = await fetch('/api/v1/zoomplus/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // The model call can take ~30-45s; allow a generous timeout.
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: text || `Erreur ${res.status}` };
    }
    const data = (await res.json().catch(() => null)) as SummaryResult | null;
    if (!data) return { ok: false, error: "Réponse vide du serveur." };
    return data;
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.name === 'TimeoutError'
            ? "Délai dépassé — le résumé prend trop de temps. Réessayez."
            : err.message
          : "Erreur réseau",
    };
  }
}

// ---------------------------------------------------------------------------
// Language options
// ---------------------------------------------------------------------------

const LANG_OPTIONS: { value: string; label: string }[] = [
  { value: 'fr', label: 'Français' },
  { value: 'darija', label: 'Darija' },
  { value: 'ar', label: 'Arabe' },
  { value: 'auto', label: 'Auto' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ZoomPlusSummaryPanel = ({ room }: { room: string }) => {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [lang, setLang] = useState('auto');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SummaryResult | null>(null);
  // Server-side recordings for this room (null = not loaded / unavailable).
  const [recordings, setRecordings] = useState<RecordingItem[] | null>(null);
  const [recLoading, setRecLoading] = useState(false);

  // --- Probe on mount ---
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ok = await fetchEnabled();
      if (!cancelled) setEnabled(ok);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Load recordings when the panel is opened (and a room is set) ---
  const loadRecordings = useCallback(async () => {
    if (!room) return;
    setRecLoading(true);
    const list = await fetchRecordings(room);
    setRecLoading(false);
    setRecordings(list);
  }, [room]);

  useEffect(() => {
    if (expanded && room) void loadRecordings();
  }, [expanded, room, loadRecordings]);

  // --- Submit ---
  const handleSubmit = useCallback(async () => {
    const text = transcript.trim();
    if (!text) return;
    setLoading(true);
    setResult(null);
    const res = await postSummary({
      transcript: text,
      lang,
      title: title.trim() || undefined,
    });
    setLoading(false);
    setResult(res);
  }, [transcript, lang, title]);

  // --- Render ---
  // Probe not yet resolved — render nothing (fail-open, invisible).
  if (enabled === null) return null;
  // Flag is off — render nothing (invisible until the owner flips it).
  if (!enabled) return null;

  const panelStyle = {
    background: C.panel,
    borderBottom: `1px solid ${C.border}`,
    fontSize: 13,
  } as const;

  const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 16px',
    cursor: 'pointer',
    userSelect: 'none' as const,
  };

  const bodyStyle = {
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  };

  const textareaStyle = {
    width: '100%',
    boxSizing: 'border-box' as const,
    minHeight: 100,
    padding: '9px 12px',
    borderRadius: 10,
    fontSize: 13,
    fontFamily: 'inherit',
    lineHeight: 1.5,
    color: C.text,
    background: C.bg,
    border: `1px solid ${C.border}`,
    outline: 'none',
    resize: 'vertical' as const,
  };

  const inputStyle = {
    width: '100%',
    boxSizing: 'border-box' as const,
    padding: '9px 12px',
    borderRadius: 10,
    fontSize: 13,
    fontFamily: 'inherit',
    color: C.text,
    background: C.bg,
    border: `1px solid ${C.border}`,
    outline: 'none',
  };

  const selectStyle = {
    ...inputStyle,
    cursor: 'pointer',
    appearance: 'auto' as const,
  };

  const labelStyle = {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    color: C.muted,
  };

  const cardStyle = {
    background: C.panel2,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: '10px 14px',
  };

  const cardTitleStyle = {
    fontSize: 12,
    fontWeight: 700,
    color: C.muted,
    marginBottom: 6,
    letterSpacing: '0.03em',
  };

  const bulletStyle = {
    fontSize: 13,
    lineHeight: 1.6,
    color: C.text,
    margin: 0,
    paddingLeft: 20,
  };

  const summary = result?.ok ? result.summary : null;

  return (
    <div data-cdz-zoomplus-summary="" style={panelStyle}>
      {/* Header / collapse toggle */}
      <div
        style={headerStyle}
        onClick={() => setExpanded(prev => !prev)}
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(prev => !prev);
          }
        }}
      >
        <span style={{ fontSize: 15 }}>📝</span>
        <span style={{ fontWeight: 800, color: C.text, flex: 1 }}>
          Résumé de la réunion
        </span>
        <span style={{ fontSize: 13, color: C.muted }}>
          {expanded ? '▾' : '▸'}
        </span>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={bodyStyle}>
          {/* Server-side recordings (LiveKit Egress). Shown only when there are
              finished recordings for this room; the source of the transcript. */}
          {recordings && recordings.length > 0 && (
            <div style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ ...cardTitleStyle, marginBottom: 0, flex: 1 }}>🎞️ Enregistrements</div>
                <button
                  style={miniBtnStyle('secondary', recLoading)}
                  disabled={recLoading}
                  onClick={() => void loadRecordings()}
                  title="Rafraîchir"
                >
                  {recLoading ? <Spinner /> : '↻'}
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {recordings.map((r, i) => {
                  const file = r.files[0];
                  const started = r.startedAt
                    ? new Date(r.startedAt / 1e6).toLocaleString('fr-FR')
                    : '';
                  const meta = [fmtDuration(file?.duration), fmtBytes(file?.size)]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <div
                      key={r.egressId || i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 12,
                        color: C.text,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{started || `Enregistrement ${i + 1}`}</span>
                      {meta && <span style={{ color: C.muted }}>{meta}</span>}
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 700,
                          padding: '1px 7px',
                          borderRadius: 999,
                          color: C.muted,
                          background: C.bg,
                          border: `1px solid ${C.border}`,
                        }}
                      >
                        {r.status.replace(/^EGRESS_/, '').toLowerCase() || 'terminé'}
                      </span>
                      {file?.location && (
                        <span style={{ fontSize: 11, color: C.muted, fontFamily: 'monospace', wordBreak: 'break-all', flexBasis: '100%' }}>
                          {file.location}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.4 }}>
                Les fichiers sont stockés sur le stockage configuré du serveur. Générez un résumé en
                collant la transcription ci-dessous.
              </div>
            </div>
          )}

          {/* Title input */}
          <div>
            <div style={labelStyle}>Titre (optionnel)</div>
            <input
              style={inputStyle}
              value={title}
              dir="auto"
              onChange={e => setTitle(e.target.value)}
              placeholder="Ex : Réunion équipe commerciale"
            />
          </div>

          {/* Transcript textarea */}
          <div>
            <div style={labelStyle}>Transcript de la réunion</div>
            <textarea
              style={textareaStyle}
              value={transcript}
              dir="auto"
              onChange={e => setTranscript(e.target.value)}
              placeholder="Collez ici le transcript de votre réunion…"
            />
          </div>

          {/* Language select */}
          <div>
            <div style={labelStyle}>Langue du résumé</div>
            <select
              style={selectStyle}
              value={lang}
              onChange={e => setLang(e.target.value)}
            >
              {LANG_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/* Submit button */}
          <button
            style={miniBtnStyle('primary', loading || !transcript.trim())}
            disabled={loading || !transcript.trim()}
            onClick={() => void handleSubmit()}
          >
            {loading ? (
              <>
                <Spinner /> Génération…
              </>
            ) : (
              "✨ Générer le résumé"
            )}
          </button>

          {/* Truncation warning */}
          {result?.truncated && result.ok && (
            <div style={{ fontSize: 11.5, color: C.muted }}>
              ⚠️ Le transcript a été tronqué (trop long). Le résumé couvre la
              première partie uniquement.
            </div>
          )}

          {/* Error */}
          {result && !result.ok && (
            <Banner tone="error">{result.error || "Échec du résumé."}</Banner>
          )}

          {/* Structured summary result */}
          {summary && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                marginTop: 4,
              }}
            >
              {/* Summary paragraph */}
              <div style={cardStyle}>
                <div style={cardTitleStyle}>📋 Résumé</div>
                <p
                  style={{
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: C.text,
                    margin: 0,
                  }}
                  dir="auto"
                >
                  {summary.summary}
                </p>
              </div>

              {/* Decisions */}
              {summary.decisions.length > 0 && (
                <div style={cardStyle}>
                  <div style={cardTitleStyle}>✅ Décisions</div>
                  <ul style={bulletStyle} dir="auto">
                    {summary.decisions.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Action items */}
              {summary.actionItems.length > 0 && (
                <div style={cardStyle}>
                  <div style={cardTitleStyle}>🎯 Actions à mener</div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    {summary.actionItems.map((a, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          gap: 8,
                          alignItems: 'flex-start',
                          fontSize: 13,
                          lineHeight: 1.5,
                          color: C.text,
                        }}
                        dir="auto"
                      >
                        <span
                          style={{
                            flexShrink: 0,
                            fontWeight: 700,
                            color: C.accent,
                            minWidth: 80,
                          }}
                        >
                          {a.owner || '—'}
                        </span>
                        <span>{a.task}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Next steps */}
              {summary.nextSteps.length > 0 && (
                <div style={cardStyle}>
                  <div style={cardTitleStyle}>➡️ Prochaines étapes</div>
                  <ul style={bulletStyle} dir="auto">
                    {summary.nextSteps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Model attribution */}
              {result?.model && (
                <div
                  style={{
                    fontSize: 11,
                    color: C.muted,
                    textAlign: 'right',
                  }}
                >
                  Généré par {result.model}
                  {result.lang ? ` · ${result.lang}` : ''}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
