import {
  type CSSProperties,
  Fragment,
  useCallback,
  useMemo,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// OpenClaw workspace — FileTree
//
// Renders a FLAT list of file paths as a collapsible directory tree. Paths are
// split on '/', folders are synthesised from the path segments, and each level
// is sorted folders-first then alphabetically. A file click calls onOpen(path).
//
// Self-contained: inline styles only (clickdz page idiom), no icon-library
// imports (extension glyphs are plain emoji/text so a missing icon package can
// never break page mount), prefers-reduced-motion safe, no data fetching.
// ---------------------------------------------------------------------------

const monoFamily =
  'var(--affine-font-code-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';

// App-consistent palette: --affine-* theme vars with hard dark fallbacks
// (same idiom as the OpenClaw page's `C` object).
const C = {
  panel: 'var(--affine-background-secondary-color, #1c1c1e)',
  border: 'var(--affine-border-color, #2a2a2c)',
  text: 'var(--affine-text-primary-color, #ececec)',
  muted: 'var(--affine-text-secondary-color, #9aa0a6)',
  accent: 'var(--affine-primary-color, #1e96eb)',
  accentSoft:
    'color-mix(in srgb, var(--affine-primary-color, #1e96eb) 16%, transparent)',
  hover: 'color-mix(in srgb, var(--affine-text-primary-color, #ececec) 7%, transparent)',
} as const;

export interface FileTreeFile {
  path: string;
  bytes?: number;
  language?: string;
}

interface TreeNode {
  name: string;
  path: string; // full path to this node (folder or file)
  isDir: boolean;
  bytes?: number;
  language?: string;
  children: Map<string, TreeNode>;
}

function newDir(name: string, path: string): TreeNode {
  return { name, path, isDir: true, children: new Map() };
}

// Build a nested tree from the flat file list.
function buildTree(files: FileTreeFile[]): TreeNode {
  const root = newDir('', '');
  for (const f of files) {
    if (!f || typeof f.path !== 'string') continue;
    // Normalise: strip leading './' and '/', collapse empty segments.
    const clean = f.path.replace(/^\.?\/+/, '');
    const segments = clean.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    let node = root;
    let acc = '';
    for (let idx = 0; idx < segments.length; idx++) {
      const seg = segments[idx];
      acc = acc ? `${acc}/${seg}` : seg;
      const isLeaf = idx === segments.length - 1;
      let child = node.children.get(seg);
      if (!child) {
        child = isLeaf
          ? {
              name: seg,
              path: acc,
              isDir: false,
              bytes: f.bytes,
              language: f.language,
              children: new Map(),
            }
          : newDir(seg, acc);
        node.children.set(seg, child);
      } else if (isLeaf) {
        // A file at an already-seen path — keep metadata current.
        child.isDir = false;
        child.bytes = f.bytes;
        child.language = f.language;
      }
      node = child;
    }
  }
  return root;
}

// Folders first, then files, each alphabetical (case-insensitive).
function sortedChildren(node: TreeNode): TreeNode[] {
  return Array.from(node.children.values()).sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

// Extension → glyph. Pure text/emoji so nothing can fail to import at boot.
function fileGlyph(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return '🟨';
    case 'json':
      return '🔧';
    case 'py':
      return '🐍';
    case 'md':
    case 'markdown':
    case 'txt':
      return '📄';
    case 'css':
    case 'scss':
    case 'less':
      return '🎨';
    case 'html':
    case 'htm':
      return '🌐';
    case 'sh':
    case 'bash':
    case 'zsh':
      return '⌘';
    case 'yml':
    case 'yaml':
    case 'toml':
    case 'env':
      return '⚙️';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
    case 'ico':
      return '🖼️';
    case 'lock':
      return '🔒';
    default:
      return '📄';
  }
}

function formatBytes(bytes?: number): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const rowBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  boxSizing: 'border-box',
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  fontFamily: monoFamily,
  fontSize: 12.5,
  lineHeight: 1.5,
  color: C.text,
  padding: '3px 8px',
  borderRadius: 6,
  transition: 'background 150ms ease',
};

const Row = ({
  node,
  depth,
  activePath,
  onOpen,
  expanded,
  toggle,
}: {
  node: TreeNode;
  depth: number;
  activePath?: string;
  onOpen: (path: string) => void;
  expanded: Set<string>;
  toggle: (path: string) => void;
}) => {
  const [hover, setHover] = useState(false);
  const isOpen = expanded.has(node.path);
  const isActive = !node.isDir && node.path === activePath;
  const indent = 8 + depth * 14;

  const onClick = useCallback(() => {
    if (node.isDir) toggle(node.path);
    else onOpen(node.path);
  }, [node.isDir, node.path, onOpen, toggle]);

  const sizeLabel = node.isDir ? null : formatBytes(node.bytes);

  return (
    <Fragment>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={node.path || node.name}
        aria-expanded={node.isDir ? isOpen : undefined}
        style={{
          ...rowBase,
          paddingLeft: indent,
          color: isActive ? C.accent : C.text,
          fontWeight: isActive ? 600 : 400,
          background: isActive
            ? C.accentSoft
            : hover
              ? C.hover
              : 'transparent',
        }}
      >
        {node.isDir ? (
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 10,
              fontSize: 9,
              color: C.muted,
              transform: isOpen ? 'rotate(90deg)' : 'none',
              transition: 'transform 150ms ease',
            }}
          >
            ▶
          </span>
        ) : (
          <span aria-hidden style={{ display: 'inline-block', width: 10 }} />
        )}
        <span aria-hidden style={{ fontSize: 12 }}>
          {node.isDir ? (isOpen ? '📂' : '📁') : fileGlyph(node.name)}
        </span>
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {node.name}
        </span>
        {sizeLabel ? (
          <span
            style={{
              fontSize: 10.5,
              color: C.muted,
              flexShrink: 0,
              opacity: hover || isActive ? 1 : 0.7,
            }}
          >
            {sizeLabel}
          </span>
        ) : null}
      </button>
      {node.isDir && isOpen
        ? sortedChildren(node).map(child => (
            <Row
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onOpen={onOpen}
              expanded={expanded}
              toggle={toggle}
            />
          ))
        : null}
    </Fragment>
  );
};

export function FileTree({
  files,
  activePath,
  onOpen,
}: {
  files: FileTreeFile[];
  activePath?: string;
  onOpen: (path: string) => void;
}) {
  const root = useMemo(() => buildTree(files ?? []), [files]);

  // Collect every folder path so we can default-expand all of them; the tree is
  // for a freshly generated app, so showing files immediately is the useful
  // default. User toggles are then tracked in `expanded`.
  const allDirs = useMemo(() => {
    const dirs: string[] = [];
    const walk = (n: TreeNode) => {
      for (const child of n.children.values()) {
        if (child.isDir) {
          dirs.push(child.path);
          walk(child);
        }
      }
    };
    walk(root);
    return dirs;
  }, [root]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const expanded = useMemo(() => {
    const s = new Set<string>();
    for (const d of allDirs) if (!collapsed.has(d)) s.add(d);
    return s;
  }, [allDirs, collapsed]);

  const toggle = useCallback((path: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const topLevel = sortedChildren(root);
  const fileCount = (files ?? []).filter(
    f => f && typeof f.path === 'string' && f.path.trim()
  ).length;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: C.panel,
      }}
    >
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: C.muted,
          }}
        >
          Files
        </span>
        {fileCount > 0 ? (
          <span style={{ fontSize: 11, color: C.muted }}>{fileCount}</span>
        ) : null}
      </div>

      {topLevel.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: 24,
            color: C.muted,
            textAlign: 'center',
          }}
        >
          <span aria-hidden style={{ fontSize: 26, opacity: 0.6 }}>
            📁
          </span>
          <span style={{ fontSize: 12.5 }}>No files yet</span>
          <span style={{ fontSize: 11, opacity: 0.8 }}>
            Files the agent writes appear here.
          </span>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            padding: '6px 4px 10px',
          }}
        >
          {topLevel.map(child => (
            <Row
              key={child.path}
              node={child}
              depth={0}
              activePath={activePath}
              onOpen={onOpen}
              expanded={expanded}
              toggle={toggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
