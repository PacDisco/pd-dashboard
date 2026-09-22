// netlify/functions/_shared/field-duplicate.mjs
//
// Working out what a duplicated budget's category tree should be.
//
// The whole risk in copying a budget lives here. Categories are a tree up to
// three deep, stored flat with parent_id, and every row needs a fresh id whose
// parent points at the COPY's parent rather than the original's. Get the order
// wrong and a subcategory is inserted before the row it hangs off; get the
// remap wrong and it silently attaches to last season's budget — which the
// database would happily accept, because the id exists.
//
// So the ordering and the remapping are done here, in one pass, with no
// database in the way: parents first, children after, and a child whose parent
// wasn't copied is an error rather than a row with a dangling reference.
//
// What is NOT copied, and why, is in budget-admin.mjs's handleDuplicate —
// entries never, assignments only on request.

/**
 * @param {Array} cats    the source budget's categories, any order
 * @param {string} budgetId  the new budget's id
 * @param {() => string} makeId  fresh category ids
 * @returns {Array} rows to insert, parents before children
 * @throws if a category names a parent that isn't in the set
 */
export function planCategoryCopy(cats, budgetId, makeId) {
  const source = [...(cats || [])];
  const byId = new Map(source.map((c) => [c.id, c]));

  // Depth by walking up, so the caller's ordering doesn't matter and a bad
  // parent reference is caught rather than assumed away.
  const depthOf = (c, seen = new Set()) => {
    if (!c.parent_id) return 1;
    if (seen.has(c.id)) throw new Error(`Category "${c.name}" is its own ancestor.`);
    const parent = byId.get(c.parent_id);
    if (!parent) throw new Error(`Category "${c.name}" has a parent that is not part of this budget.`);
    seen.add(c.id);
    return depthOf(parent, seen) + 1;
  };

  const ordered = source
    .map((c) => ({ c, depth: depthOf(c) }))
    .sort((a, b) => a.depth - b.depth
      || (a.c.sort_order ?? 0) - (b.c.sort_order ?? 0)
      || String(a.c.id).localeCompare(String(b.c.id)))
    .map((x) => x.c);

  const idMap = new Map();
  return ordered.map((c) => {
    const id = makeId();
    idMap.set(c.id, id);
    const parent_id = c.parent_id ? idMap.get(c.parent_id) : null;
    if (c.parent_id && !parent_id) {
      // Unreachable while `ordered` is parents-first; kept because the cost of
      // being wrong is a category silently attached to the wrong budget.
      throw new Error(`Category "${c.name}" was copied before its parent.`);
    }
    return {
      id,
      budget_id: budgetId,
      name: c.name,
      allocated: c.allocated ?? 0,
      sort_order: c.sort_order ?? 0,
      parent_id,
      // Currency and rates live on the leg only; the database trigger nulls
      // them deeper down anyway, and passing them on would be a second source
      // of truth that happens to agree today.
      currency: c.parent_id ? null : (c.currency ?? null),
      rates: c.parent_id ? {} : (c.rates ?? {}),
    };
  });
}
