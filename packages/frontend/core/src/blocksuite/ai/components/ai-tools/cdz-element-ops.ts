/**
 * `cdz-element-ops` — structural element operations on a parsed `Document` for
 * the ClickDz Builder Studio.
 *
 * These helpers operate on a `Document` whose `body.querySelectorAll('*')`
 * order is IDENTICAL to the studio's `walkBody` walk: the studio parses
 * `workingHtml` with `DOMParser` and visits `body`'s descendant elements in
 * document order, assigning an incrementing integer id starting at 0
 * (`index === id`). The `<body>` element itself is never assigned an id — the
 * walk only covers its descendants — so id `0` is the FIRST element inside
 * `<body>`. Every function here resolves an id the exact same way
 * (`body.querySelectorAll('*')[id]`) so the ids in a bridge message line up
 * with the nodes here.
 *
 * Contract (see studio-fixes brief §2):
 *   - Each op MUTATES the passed `Document` in place and returns a boolean
 *     success flag.
 *   - Ids are only valid for the snapshot they were derived from; any mutation
 *     re-derives ids from scratch on the next walk (callers re-walk).
 *   - We do NOT strip `data-cdz-id`; the studio removes bookkeeping ids itself
 *     right before it commits the mutated body.
 *
 * Dependency-free: no `lit`, no third-party deps. It DOES touch the DOM (it
 * operates on `Element`/`Document`), but only through standard DOM APIs
 * (`querySelectorAll`, `cloneNode`, `insertBefore`, `remove`, `contains`,
 * `appendChild`), so it runs unchanged in the browser. For a node self-test,
 * construct a `Document` via `DOMParser` when one is available, or hand-build a
 * minimal element tree; the pure index/cycle logic can also be exercised
 * against a shim (see the harness in the worker summary).
 */

/**
 * Resolve the element the studio walk would have assigned `id` to:
 * `body.querySelectorAll('*')[id]`, in document order. Returns `null` for a
 * missing body, a non-integer / negative id, or an id past the end of the walk.
 *
 * NOTE: the `<body>` element is intentionally NOT reachable by any id — the
 * walk covers only its descendants — mirroring the studio's `walkBody`.
 */
export function elementAt(doc: Document, id: number): Element | null {
  if (!doc) return null;
  // Reject non-integer / negative ids up front (Array index semantics would
  // otherwise silently coerce e.g. 1.5 → undefined, but be explicit).
  if (!Number.isInteger(id) || id < 0) return null;
  const body = doc.body;
  if (!body) return null;
  const all = body.querySelectorAll('*');
  if (id >= all.length) return null;
  return all[id] ?? null;
}

/**
 * Deep-clone the element at `id` and insert the clone RIGHT AFTER it (as its
 * immediate next sibling). The clone keeps every attribute — including any
 * `data-cdz-id` (the studio strips those before commit). Returns `false` if the
 * id is invalid, resolves to `<body>`, or the target has no parent to insert
 * into.
 */
export function duplicateElement(doc: Document, id: number): boolean {
  const el = elementAt(doc, id);
  if (!el) return false;
  // Never duplicate the body (defensive — body has no id) or a detached node.
  if (isBody(doc, el)) return false;
  const parent = el.parentNode;
  if (!parent) return false;

  const clone = el.cloneNode(true) as Element;
  // Insert directly after `el`: before its next sibling, or at the end when it
  // is the last child (nextSibling === null → appended).
  parent.insertBefore(clone, el.nextSibling);
  return true;
}

/**
 * Remove the element at `id` from the tree. Refuses (returns `false`) when the
 * id is missing/invalid or resolves to the `<body>` element itself (removing
 * the body would nuke the whole document). Also refuses a node with no parent
 * (already detached / is the document root).
 */
export function removeElement(doc: Document, id: number): boolean {
  const el = elementAt(doc, id);
  if (!el) return false;
  if (isBody(doc, el)) return false;
  if (!el.parentNode) return false;
  el.remove();
  return true;
}

/**
 * Decide whether `movingId` may be reparented relative to `targetId`.
 *
 * Returns `false` when:
 *   - either id is invalid (does not resolve to an element), or
 *   - they resolve to the SAME node, or
 *   - `target` IS `moving` (redundant with same-node, guarded explicitly), or
 *   - `target` is a DESCENDANT of `moving` — moving a node into its own subtree
 *     would create a cycle / detach the branch, so it is refused, or
 *   - `moving` is the `<body>` element (the body can't be reparented).
 *
 * Uses `Node.contains`, which reports an element as containing itself; the
 * same-node / target===moving checks above already cover that case, so the
 * remaining `contains` test isolates the strict-descendant cycle.
 */
export function canReparent(
  doc: Document,
  movingId: number,
  targetId: number
): boolean {
  const moving = elementAt(doc, movingId);
  const target = elementAt(doc, targetId);
  if (!moving || !target) return false;
  // Same node (covers both "same id" and two ids resolving to one element) and
  // the explicit target===moving guard from the contract.
  if (moving === target) return false;
  // Never reparent the body.
  if (isBody(doc, moving)) return false;
  // Cycle guard: target must NOT live inside moving's subtree. `contains`
  // includes self, but moving===target is already rejected above, so any true
  // here is a strict descendant.
  if (moving.contains(target)) return false;
  return true;
}

/**
 * Reparent `movingId` relative to `targetId`, guarded by {@link canReparent}.
 *
 *   - `'before'`      → insert `moving` immediately BEFORE `target`, within
 *                       `target.parentElement`. Refuses if `target` has no
 *                       parent element (e.g. it is the body/root).
 *   - `'append-into'` → append `moving` as the LAST child of `target`.
 *
 * Mutates the passed doc and returns `true` on success, `false` if the move is
 * disallowed or the target position is unavailable. Moving a node that is
 * already in place (e.g. append-into its current parent as last child, or
 * before its current next position) is still performed and reported as success
 * — the DOM `insertBefore`/`appendChild` calls are no-op-safe when the node is
 * already there.
 */
export function reparentElement(
  doc: Document,
  movingId: number,
  targetId: number,
  mode: 'before' | 'append-into'
): boolean {
  if (!canReparent(doc, movingId, targetId)) return false;
  // canReparent already validated both ids resolve; re-resolve for the nodes.
  const moving = elementAt(doc, movingId);
  const target = elementAt(doc, targetId);
  if (!moving || !target) return false;

  if (mode === 'before') {
    const parent = target.parentElement;
    // No parent element to insert into (target is body/root) → refuse.
    if (!parent) return false;
    // Extra safety: if the resolved parent is inside moving's subtree, the move
    // would still create a cycle. canReparent(moving,target) doesn't cover
    // target's PARENT, so guard it here.
    if (moving.contains(parent)) return false;
    parent.insertBefore(moving, target);
    return true;
  }

  // 'append-into': target becomes moving's parent, moving is its last child.
  target.appendChild(moving);
  return true;
}

/**
 * True when `el` is the document's `<body>` element (or tagged BODY). Kept
 * local so callers don't have to special-case it. Compares against
 * `doc.body` and falls back to a tag check for docs where `doc.body` may be
 * absent/shimmed.
 */
function isBody(doc: Document, el: Element): boolean {
  if (doc && el === doc.body) return true;
  const tag = el.tagName;
  return typeof tag === 'string' && tag.toUpperCase() === 'BODY';
}
