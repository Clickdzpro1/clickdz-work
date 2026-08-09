import { useCallback, useEffect, useRef, useState } from 'react';

import type { VdzProjectSummary } from '../../../../modules/vdz/use-vdz-projects';
import * as styles from './project-bar.css';

/**
 * Vdz Studio — projects popover.
 *
 * A dropdown anchored under the ProjectBar's "Open" button listing the signed-in
 * user's saved projects (name + a tiny updated-at meta). Each row Opens on click
 * and has a Delete affordance; a "New" action creates a blank/sample project.
 * Self-contained (no Radix / theme deps), closing on outside-click / Escape, to
 * match the shell's palette-locked surface — the same pattern as VdzViewMenu.
 *
 * It is a PRESENTATION component: it never touches the CRUD hook directly. The
 * ProjectBar owns the hook + open/new/delete handlers and passes them in, so all
 * request lifecycle (loading / error / in-flight guard) lives in one place.
 */

interface ProjectBrowserProps {
  open: boolean;
  onRequestClose: () => void;
  /** Loaded project rows (newest first), or null before the first fetch. */
  projects: VdzProjectSummary[] | null;
  loading: boolean;
  error: string | null;
  /** The currently-open project id (marked in the list), if any. */
  currentId: string | null;
  /** Re-fetch the list (also used as an error retry). */
  onRefresh: () => void;
  onOpenProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onNewProject: () => void;
}

/** Format an ISO timestamp as a compact "just now / Nm / Nh / date" meta. */
function formatUpdatedAt(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffMs = Date.now() - then;
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return 'Modifié à l’instant';
  if (min < 60) return `Modifié il y a ${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `Modifié il y a ${hr} h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `Modifié il y a ${day} j`;
  return `Modifié le ${new Date(then).toLocaleDateString()}`;
}

export function ProjectBrowser({
  open,
  onRequestClose,
  projects,
  loading,
  error,
  currentId,
  onRefresh,
  onOpenProject,
  onDeleteProject,
  onNewProject,
}: ProjectBrowserProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Which row is awaiting delete confirmation (two-click delete so a stray
  // click never destroys a project). Reset when the popover closes.
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // Close on outside pointerdown / Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onRequestClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onRequestClose();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onRequestClose]);

  // Reset any pending delete confirmation whenever the popover closes.
  useEffect(() => {
    if (!open) setConfirmId(null);
  }, [open]);

  const handleDeleteClick = useCallback(
    (id: string) => () => {
      // First click arms the confirm; second click (row shows "Delete?") fires.
      setConfirmId(prev => {
        if (prev === id) {
          onDeleteProject(id);
          return null;
        }
        return id;
      });
    },
    [onDeleteProject]
  );

  if (!open) return null;

  const hasProjects = projects != null && projects.length > 0;

  return (
    <div className={styles.browserMenu} role="menu" ref={rootRef}>
      <div className={styles.browserHeader}>
        <span className={styles.browserTitle}>Projets</span>
        <button
          type="button"
          className={styles.browserAction}
          onClick={onRefresh}
          disabled={loading}
          title="Recharger la liste des projets"
        >
          {loading ? 'Chargement…' : 'Actualiser'}
        </button>
        <button
          type="button"
          className={styles.browserAction}
          onClick={onNewProject}
          title="Créer un nouveau projet"
        >
          + Nouveau
        </button>
      </div>

      <div className={styles.browserList}>
        {hasProjects ? (
          projects.map(project => {
            const armed = confirmId === project.id;
            return (
              <div
                key={project.id}
                className={styles.projectRow}
                data-current={project.id === currentId}
              >
                <button
                  type="button"
                  className={styles.projectOpen}
                  onClick={() => onOpenProject(project.id)}
                  title={`Ouvrir ${project.name}`}
                >
                  <span className={styles.projectName}>
                    {project.name || 'Sans titre'}
                  </span>
                  <span className={styles.projectMeta}>
                    {formatUpdatedAt(project.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.projectDelete}
                  onClick={handleDeleteClick(project.id)}
                  disabled={loading}
                  title={armed ? 'Cliquez à nouveau pour supprimer' : 'Supprimer le projet'}
                  aria-label={`Supprimer ${project.name}`}
                >
                  {armed ? '✓' : '🗑'}
                </button>
              </div>
            );
          })
        ) : (
          <div className={styles.browserEmpty}>
            {loading
              ? 'Chargement des projets…'
              : projects == null
                ? 'Ouvrez pour charger vos projets enregistrés.'
                : "Aucun projet enregistré. Modifiez la chronologie et appuyez sur Enregistrer (⌘S) pour conserver votre travail."}
          </div>
        )}
      </div>

      {error ? <div className={styles.browserError}>{error}</div> : null}
    </div>
  );
}
