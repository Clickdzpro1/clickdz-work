/**
 * ClickDz Artifact Store — workspace-scoped in-memory + localStorage shelf.
 * Ensures image/app/doc artifacts survive panel Close (the core UX bug).
 */

export type CdzArtifactType = 'image' | 'app' | 'doc' | 'code' | 'file';

/**
 * Kind of an `app` artifact created by the one-click Ready Shop flow. Plain
 * app-builder outputs leave this undefined; only the paired shop/ERP apps set
 * it so the shelf can label/group them ("shop" is the storefront, "erp" the
 * linked back-office dashboard).
 */
export type CdzArtifactKind = 'shop' | 'erp';

export type CdzArtifact = {
  id: string;
  type: CdzArtifactType;
  title: string;
  /** Image URL, HTML string, markdown, etc. */
  payload: string;
  mimeType?: string;
  sessionId?: string;
  messageId?: string;
  prompt?: string;
  /** App-specific identity and published URL, when applicable. */
  slug?: string;
  url?: string;
  /**
   * Shared storefront slug that pairs a Ready-Shop storefront with its linked
   * ERP dashboard (both carry the same `storeSlug`). Absent on plain apps and
   * on records written before the Ready Shop flow shipped (back-compat: these
   * legacy records simply parse with `storeSlug === undefined`).
   */
  storeSlug?: string;
  /** Ready-Shop role of this app artifact; see {@link CdzArtifactKind}. */
  kind?: CdzArtifactKind;
  createdAt: number;
  updatedAt: number;
};

type Listener = (artifacts: CdzArtifact[]) => void;

const STORAGE_KEY = 'clickdz.artifacts.v1';
const MAX_ITEMS = 200;
// Stay below common 5 MB localStorage quotas; newest artifacts win.
const MAX_STORAGE_CHARS = 4_000_000;

function loadAll(): CdzArtifact[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CdzArtifact[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAll(items: CdzArtifact[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    const persisted: CdzArtifact[] = [];
    let size = 2; // []
    for (const item of items.slice(0, MAX_ITEMS)) {
      const serialized = JSON.stringify(item);
      if (size + serialized.length + 1 > MAX_STORAGE_CHARS) break;
      persisted.push(item);
      size += serialized.length + 1;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // quota / private mode — keep memory only
  }
}

class ArtifactStoreImpl {
  private items: CdzArtifact[] = loadAll();
  private listeners = new Set<Listener>();

  list(sessionId?: string): CdzArtifact[] {
    const items = sessionId
      ? this.items.filter(item => item.sessionId === sessionId)
      : this.items;
    return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): CdzArtifact | undefined {
    return this.items.find(a => a.id === id);
  }

  upsert(
    input: Omit<CdzArtifact, 'createdAt' | 'updatedAt'> & {
      createdAt?: number;
      updatedAt?: number;
    }
  ): CdzArtifact {
    const now = Date.now();
    const existing = this.items.findIndex(a => a.id === input.id);
    let record: CdzArtifact;
    if (existing >= 0) {
      record = {
        ...this.items[existing],
        ...input,
        updatedAt: now,
      };
      this.items[existing] = record;
    } else {
      record = {
        ...input,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      };
      this.items.unshift(record);
    }
    if (this.items.length > MAX_ITEMS) {
      this.items = this.items.slice(0, MAX_ITEMS);
    }
    saveAll(this.items);
    this.emit();
    return record;
  }

  remove(id: string) {
    this.items = this.items.filter(a => a.id !== id);
    saveAll(this.items);
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    const snapshot = this.list();
    for (const l of this.listeners) l(snapshot);
  }
}

/** Singleton shelf for the browser session / workspace. */
export const artifactStore = new ArtifactStoreImpl();

export function newArtifactId(prefix = 'art'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Shared app-draft persist path (WS1). Both studio hosts — the chat card
 * (clickdz-app-result.ts) and the /apps page (clickdz-builder-home.ts) — must
 * persist studio edits identically so the two paths can never drift again
 * (the /apps host historically only mutated an in-memory field, losing edits
 * on refetch/reload). Upserts the `app_${slug}` shelf record, preserving any
 * existing metadata (createdAt, kind, storeSlug, url) while refreshing the
 * working HTML and title. Returns the stored record, or null when there is no
 * slug to key on.
 */
export function persistAppDraft(input: {
  slug: string;
  html: string;
  title: string;
  url?: string;
  prompt?: string;
}): CdzArtifact | null {
  const slug = input.slug?.trim();
  if (!slug) return null;
  const id = `app_${slug}`;
  const existing = artifactStore.get(id);
  return artifactStore.upsert({
    ...(existing ?? {
      id,
      type: 'app' as CdzArtifactType,
      title: input.title,
      prompt: input.prompt ?? input.title,
      sessionId: 'draft',
      slug,
      mimeType: 'text/html',
    }),
    // Always reflect the latest (possibly renamed) title + working HTML.
    title: input.title,
    payload: input.html,
    url: input.url ?? existing?.url,
  });
}
