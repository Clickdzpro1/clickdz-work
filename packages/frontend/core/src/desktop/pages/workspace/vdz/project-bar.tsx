import { useCallback, useEffect, useRef, useState } from 'react';

import type { VdzTimeline } from '../../../../modules/vdz';
import {
  useVdzProjects,
  type VdzProjectSummary,
} from '../../../../modules/vdz/use-vdz-projects';
import { useVdzShare } from '../../../../modules/vdz/use-vdz-share';
import * as chrome from './chrome-studio.css';
import * as styles from './project-bar.css';
import { ProjectBrowser } from './project-browser';
import { TemplateGallery } from './template-gallery';

/**
 * Vdz Studio — the header ProjectBar.
 *
 * Owns everything about project persistence in the header's RIGHT zone: the
 * inline-editable project name, Save (⌘S) + Save As, and an "Open" button that
 * toggles the ProjectBrowser popover (list / open / delete / new). It is the
 * SINGLE caller of useVdzProjects, so all request lifecycle lives here.
 *
 * Timeline state itself still lives in index.tsx (useVdzHistory). This component
 * is handed the current `timeline`, plus three callbacks the host wires to the
 * history hook:
 *   · onLoadTimeline(timeline) → history.reset(timeline)   (open / new baseline)
 *   · onRename(name)           → history.run(renameTimeline){name}  (undoable)
 *   · newTimeline()            → a fresh sample/blank VdzTimeline factory
 *
 * PERSISTENCE MODEL
 *  - `projectId`: the id of the currently-open stored project, or null for an
 *    unsaved (never-saved) working timeline. Persisted to localStorage as the
 *    "last open" id and reopened on mount.
 *  - Dirty tracking: we snapshot the last-saved serialized timeline; the bar is
 *    "dirty" when the current serialization differs. Save is only meaningful
 *    when dirty (or when there is no projectId yet).
 *  - AUTOSAVE: once a project HAS an id, edits debounce-save after 2s. We never
 *    autosave a timeline that has no id (the untouched sample), and we never
 *    autosave when not dirty — so opening a project or sitting idle issues no
 *    writes (respecting the route's `strict` throttle).
 */

const LAST_OPEN_KEY = 'vdz:last-open-project-id';
const AUTOSAVE_DEBOUNCE_MS = 2000;
/** First-run flag: once set, the welcome gallery never auto-opens again. */
const ONBOARDED_KEY = 'vdz:onboarded:v1';

function readOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    // No storage (private mode / SSR) → treat as onboarded: never nag.
    return true;
  }
}

function writeOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, '1');
  } catch {
    // non-fatal
  }
}

interface ProjectBarProps {
  /** The live working timeline (from useVdzHistory). */
  timeline: VdzTimeline;
  /** Load a timeline as a fresh history baseline (open / new). */
  onLoadTimeline: (timeline: VdzTimeline) => void;
  /** Rename the working timeline through the undoable op path. */
  onRename: (name: string) => void;
  /** Produce a brand-new working timeline (sample or blank). */
  newTimeline: () => VdzTimeline;
}

/** Stable JSON of a timeline for cheap dirty comparison (order is stable). */
function serialize(timeline: VdzTimeline): string {
  try {
    return JSON.stringify(timeline);
  } catch {
    return '';
  }
}

function readLastOpenId(): string | null {
  try {
    const raw = localStorage.getItem(LAST_OPEN_KEY);
    return raw && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

function writeLastOpenId(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_OPEN_KEY, id);
    else localStorage.removeItem(LAST_OPEN_KEY);
  } catch {
    // localStorage may be unavailable (private mode / SSR) — non-fatal.
  }
}

export function ProjectBar({
  timeline,
  onLoadTimeline,
  onRename,
  newTimeline,
}: ProjectBarProps) {
  const projects = useVdzProjects();

  // The currently-open stored project id (null = unsaved working timeline).
  const [projectId, setProjectId] = useState<string | null>(null);
  // The serialization at last successful save (baseline for dirty tracking).
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  // The browser popover + its (lazily-loaded) list.
  const [browserOpen, setBrowserOpen] = useState(false);
  const [list, setList] = useState<VdzProjectSummary[] | null>(null);
  // Inline name editing.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const currentJson = serialize(timeline);
  const dirty = savedSnapshot !== null && currentJson !== savedSnapshot;

  // A ref mirror of the fields the debounced autosave + the ⌘S handler read, so
  // their effects don't re-subscribe on every timeline keystroke.
  const stateRef = useRef({ projectId, dirty, timeline, currentJson });
  stateRef.current = { projectId, dirty, timeline, currentJson };

  // ---- List loading (lazy: only when the browser is opened / refreshed) ---
  const refreshList = useCallback(async () => {
    try {
      const rows = await projects.list();
      setList(rows);
    } catch {
      // error is surfaced via projects.error in the popover; keep old rows.
    }
  }, [projects]);

  // ---- Core save (shared by ⌘S, autosave, Save As) ------------------------
  // Persists the current timeline. `forceNew` (Save As) always creates a new
  // project (id omitted) so the original stays intact. Returns the stored id.
  const doSave = useCallback(
    async (opts?: { forceNew?: boolean }): Promise<string | null> => {
      const { timeline: tl } = stateRef.current;
      const id = opts?.forceNew ? undefined : (stateRef.current.projectId ?? undefined);
      const name = tl.name?.trim() || 'Untitled Vdz project';
      try {
        const savedId = await projects.save({ id, name, timeline: tl });
        setProjectId(savedId);
        writeLastOpenId(savedId);
        // The snapshot is what we just sent — mark clean against exactly that.
        setSavedSnapshot(serialize(tl));
        // Keep the open list fresh if it's been loaded.
        if (list) void refreshList();
        return savedId;
      } catch {
        // projects.error carries the message (shown in the popover / could be
        // surfaced by the host); leave dirty state so the user can retry.
        return null;
      }
    },
    [projects, list, refreshList]
  );

  const handleSave = useCallback(() => {
    if (!stateRef.current.dirty && stateRef.current.projectId) return;
    void doSave();
  }, [doSave]);

  const handleSaveAs = useCallback(() => {
    void doSave({ forceNew: true });
  }, [doSave]);

  // ---- Open / New / Delete (wired into the browser) -----------------------
  const handleOpenProject = useCallback(
    async (id: string) => {
      try {
        const doc = await projects.load(id);
        onLoadTimeline(doc.timeline);
        setProjectId(doc.id);
        writeLastOpenId(doc.id);
        setSavedSnapshot(serialize(doc.timeline));
        setBrowserOpen(false);
      } catch {
        // error surfaced in the popover; stay open so the user can retry.
      }
    },
    [projects, onLoadTimeline]
  );

  // Load ANY timeline as a fresh unsaved working project (New / template pick):
  // no id, no clean snapshot (reads dirty; autosave stays OFF until the user
  // explicitly Saves — we never persist a starting point on their behalf).
  const loadFresh = useCallback(
    (fresh: VdzTimeline) => {
      onLoadTimeline(fresh);
      setProjectId(null);
      setSavedSnapshot(null);
      writeLastOpenId(null);
      setBrowserOpen(false);
    },
    [onLoadTimeline]
  );

  const handleNewProject = useCallback(() => {
    loadFresh(newTimeline());
  }, [newTimeline, loadFresh]);

  const handleDeleteProject = useCallback(
    async (id: string) => {
      try {
        await projects.remove(id);
        // Drop it from the visible list immediately.
        setList(prev => (prev ? prev.filter(p => p.id !== id) : prev));
        // If we deleted the open project, detach (keep the timeline on-screen
        // as an unsaved working copy the user can re-Save).
        if (stateRef.current.projectId === id) {
          setProjectId(null);
          setSavedSnapshot(null);
          writeLastOpenId(null);
        }
      } catch {
        // error surfaced in the popover.
      }
    },
    [projects]
  );

  const toggleBrowser = useCallback(() => {
    setBrowserOpen(prev => {
      const next = !prev;
      // Fetch (or refresh) the list on open.
      if (next) void refreshList();
      return next;
    });
  }, [refreshList]);

  // ---- Inline name editing ------------------------------------------------
  const beginRename = useCallback(() => {
    setNameDraft(timeline.name ?? '');
    setEditingName(true);
  }, [timeline.name]);

  const commitRename = useCallback(() => {
    setEditingName(false);
    const next = nameDraft.trim();
    if (next && next !== timeline.name) onRename(next);
  }, [nameDraft, timeline.name, onRename]);

  const onNameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitRename();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setEditingName(false);
      }
    },
    [commitRename]
  );

  // ---- ⌘S / Ctrl+S — save from anywhere in the studio ---------------------
  // Bound to window (capture) so it wins over the browser's native Save dialog
  // even when focus is inside an input; guarded to the vdz page being mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (e.shiftKey) handleSaveAs();
        else handleSave();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () =>
      window.removeEventListener('keydown', onKey, { capture: true });
  }, [handleSave, handleSaveAs]);

  // ---- Autosave: debounce 2s after edits, only for a saved project --------
  // Re-armed on every serialization change. GUARDS: needs an id (never saves
  // the untouched sample) AND must be dirty. Because the timer reads the ref,
  // rapid edits keep pushing the deadline out (true debounce) and a save
  // committed by ⌘S in the meantime clears `dirty` so the timer no-ops.
  useEffect(() => {
    if (!projectId || !dirty) return;
    const timer = setTimeout(() => {
      if (stateRef.current.projectId && stateRef.current.dirty) {
        void doSave();
      }
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [projectId, dirty, currentJson, doSave]);

  // ---- Templates + first-run welcome (C5) ---------------------------------
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryWelcome, setGalleryWelcome] = useState(false);

  const closeGallery = useCallback(() => {
    setGalleryOpen(false);
    // Seeing the gallery once (however it closes) counts as onboarded.
    writeOnboarded();
  }, []);

  const handlePickTemplate = useCallback(
    (timeline: VdzTimeline) => {
      loadFresh(timeline);
      setGalleryOpen(false);
      writeOnboarded();
    },
    [loadFresh]
  );

  const handlePickBlank = useCallback(() => {
    loadFresh(newTimeline());
    setGalleryOpen(false);
    writeOnboarded();
  }, [loadFresh, newTimeline]);

  // ---- Reopen the last-open project on mount ------------------------------
  // One-shot: read the persisted id and load it. If it 404s (expired / deleted)
  // we silently clear it and stay on the working sample.
  const didReopenRef = useRef(false);
  useEffect(() => {
    if (didReopenRef.current) return;
    didReopenRef.current = true;
    const lastId = readLastOpenId();
    if (!lastId) {
      // TRUE first run only: no saved work AND never onboarded → welcome
      // gallery. Existing users (who predate the flag) have a last-open id
      // and are quietly marked onboarded instead.
      if (!readOnboarded()) {
        setGalleryWelcome(true);
        setGalleryOpen(true);
      }
      return;
    }
    writeOnboarded();
    void (async () => {
      try {
        const doc = await projects.load(lastId);
        onLoadTimeline(doc.timeline);
        setProjectId(doc.id);
        setSavedSnapshot(serialize(doc.timeline));
      } catch {
        // Stale / unreachable id — forget it, keep the sample.
        writeLastOpenId(null);
      }
    })();
    // Intentionally mount-only: reopen exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveDisabled = projects.loading || (!dirty && !!projectId);

  // ---- Public share link (C4) ---------------------------------------------
  // Sharing needs a SAVED project (the share hangs off the project id). The
  // popover creates/updates the snapshot link, copies it, or revokes it.
  const shareApi = useVdzShare();
  const [shareOpen, setShareOpen] = useState(false);
  // The ⋯ overflow menu (Save As / Templates / Share) — top-bar fix.
  const [moreOpen, setMoreOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareSkipped, setShareSkipped] = useState(0);
  const [copied, setCopied] = useState(false);

  const handleCreateShare = useCallback(async () => {
    const id = stateRef.current.projectId;
    if (!id) return;
    setCopied(false);
    try {
      // Share the LAST-SAVED state: save first when dirty so the link matches
      // what the user sees (one extra save is cheaper than a stale share).
      if (stateRef.current.dirty) await doSave();
      const result = await shareApi.share(id, stateRef.current.timeline);
      setShareUrl(result.url);
      setShareSkipped(result.skipped.length);
    } catch {
      // shareApi.error carries the message shown in the popover.
    }
  }, [shareApi, doSave]);

  const handleCopyShare = useCallback(() => {
    if (!shareUrl) return;
    navigator.clipboard
      ?.writeText(shareUrl)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, [shareUrl]);

  const handleRevokeShare = useCallback(async () => {
    const id = stateRef.current.projectId;
    if (!id) return;
    try {
      await shareApi.revoke(id);
      setShareUrl(null);
      setShareSkipped(0);
      setCopied(false);
    } catch {
      // shareApi.error surfaces below.
    }
  }, [shareApi]);

  return (
    <div className={styles.bar}>
      {editingName ? (
        <input
          className={styles.nameInput}
          value={nameDraft}
          onChange={e => setNameDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={onNameKeyDown}
          autoFocus
          spellCheck={false}
          aria-label="Project name"
          maxLength={200}
        />
      ) : (
        <span
          className={styles.nameField}
          title={`${timeline.name || 'Untitled'} — click to rename`}
          role="textbox"
          tabIndex={0}
          aria-label="Project name"
          onClick={beginRename}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              beginRename();
            }
          }}
        >
          {timeline.name || 'Untitled'}
        </span>
      )}

      <span className={styles.barDivider} aria-hidden="true" />

      {/* Save. The unsaved-changes indicator is a dot INSIDE this button when
          the working timeline is dirty (dirty is knowable from savedSnapshot),
          so "there are changes to save" reads right where you'd act on it. */}
      <button
        type="button"
        className={styles.barButton}
        data-primary="true"
        onClick={handleSave}
        disabled={saveDisabled}
        title={dirty ? 'Save project — unsaved changes' : 'Save project'}
      >
        {dirty ? (
          <span
            className={styles.saveDot}
            aria-hidden="true"
            title="Unsaved changes"
          />
        ) : null}
        {projects.loading ? 'Saving…' : dirty || !projectId ? 'Save' : 'Saved'}
        <span className={styles.shortcutHint}>⌘S</span>
      </button>

      <div className={styles.browserRoot}>
        <button
          type="button"
          className={styles.barButton}
          data-open={browserOpen}
          aria-haspopup="menu"
          aria-expanded={browserOpen}
          onClick={toggleBrowser}
          title="Open a saved project"
        >
          Open
        </button>
        <ProjectBrowser
          open={browserOpen}
          onRequestClose={() => setBrowserOpen(false)}
          projects={list}
          loading={projects.loading}
          error={projects.error}
          currentId={projectId}
          onRefresh={() => void refreshList()}
          onOpenProject={id => void handleOpenProject(id)}
          onDeleteProject={id => void handleDeleteProject(id)}
          onNewProject={handleNewProject}
        />
      </div>

      {/* ---- ⋯ overflow: Save As / Templates / Share (top-bar fix: the
           header-right was overflowing and buttons overlapped — the bar now
           always fits: Name · Save · Open · ⋯). The Share popover stays
           anchored to this wrapper. ---- */}
      <div className={styles.browserRoot}>
        <button
          type="button"
          className={styles.barButton}
          data-open={moreOpen}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => {
            setMoreOpen(prev => !prev);
            setShareOpen(false);
          }}
          title="More project actions"
          aria-label="More project actions"
        >
          ⋯
        </button>
        {moreOpen ? (
          <div className={chrome.overflowMenu} role="menu">
            {[
              {
                icon: '💾',
                label: 'Save As…',
                disabled: projects.loading,
                run: () => handleSaveAs(),
              },
              {
                icon: '✨',
                label: 'Templates…',
                disabled: false,
                run: () => {
                  setGalleryWelcome(false);
                  setGalleryOpen(true);
                },
              },
              {
                icon: '🔗',
                label: 'Share…',
                disabled: !projectId,
                run: () => {
                  setShareOpen(true);
                  shareApi.clearError();
                  setCopied(false);
                },
              },
            ].map(item => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={styles.barButton}
                style={{ justifyContent: 'flex-start', width: '100%' }}
                disabled={item.disabled}
                onClick={() => {
                  setMoreOpen(false);
                  item.run();
                }}
              >
                <span className={chrome.overflowIcon} aria-hidden="true">
                  {item.icon}
                </span>
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
        {shareOpen ? (
          <div
            role="dialog"
            aria-label="Share project"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              right: 0,
              zIndex: 60,
              width: 300,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 12,
              borderRadius: 10,
              border: '1px solid var(--vdz-border, #262a35)',
              background: 'var(--vdz-panel, #12141a)',
              color: 'var(--vdz-text, #e6e9f0)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
              fontSize: 12,
            }}
          >
            <div style={{ fontWeight: 600 }}>Public view-only link</div>
            <div style={{ color: 'var(--vdz-muted, #8a90a0)', lineHeight: 1.5 }}>
              Anyone with the link can watch a snapshot of this project. Edits
              stay private until you share again.
            </div>
            {shareUrl ? (
              <>
                <input
                  readOnly
                  value={shareUrl}
                  aria-label="Share URL"
                  onFocus={e => e.currentTarget.select()}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    borderRadius: 7,
                    border: '1px solid var(--vdz-border, #262a35)',
                    background: 'var(--vdz-bg, #0b0d12)',
                    color: 'var(--vdz-text, #e6e9f0)',
                    fontSize: 11,
                  }}
                />
                {shareSkipped > 0 ? (
                  <div style={{ color: 'var(--vdz-muted, #8a90a0)' }}>
                    {shareSkipped} media file(s) could not be embedded — those
                    clips show placeholders for viewers.
                  </div>
                ) : null}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className={styles.barButton}
                    data-primary="true"
                    onClick={handleCopyShare}
                  >
                    {copied ? 'Copied ✓' : 'Copy link'}
                  </button>
                  <button
                    type="button"
                    className={styles.barButton}
                    onClick={() => void handleCreateShare()}
                    disabled={shareApi.busy}
                  >
                    {shareApi.busy ? 'Updating…' : 'Update'}
                  </button>
                  <button
                    type="button"
                    className={styles.barButton}
                    onClick={() => void handleRevokeShare()}
                    disabled={shareApi.busy}
                  >
                    Revoke
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                className={styles.barButton}
                data-primary="true"
                onClick={() => void handleCreateShare()}
                disabled={shareApi.busy}
              >
                {shareApi.busy ? 'Creating…' : 'Create share link'}
              </button>
            )}
            {shareApi.error ? (
              <div style={{ color: '#ff6b6b' }}>{shareApi.error}</div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ---- Template gallery / first-run welcome ---- */}
      <TemplateGallery
        open={galleryOpen}
        welcome={galleryWelcome}
        onClose={closeGallery}
        onPick={handlePickTemplate}
        onBlank={handlePickBlank}
      />
    </div>
  );
}
