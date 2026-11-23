import { flagRevision, matchFlag, MAX_FLAGS, type Flag, type FlagReference, type GraphLike } from '../session/flow.ts';

export interface FlagScope { id: string; nodeIds: string[] }
export interface FlagSelection { scopes: FlagScope[]; independent: string[] }
export interface ResolvedFlag extends FlagReference { note: string }

export function readFlagSelection(scopes: unknown, independent: unknown, ids: string[], backfill: string[]): FlagSelection {
  if (scopes === undefined && independent === undefined) return { scopes: [], independent: ids };
  const selected = new Set(ids);
  const subset = (list: unknown): list is string[] => Array.isArray(list) && list.length <= ids.length &&
    list.every(id => typeof id === 'string' && selected.has(id)) && new Set(list).size === list.length;
  if (!subset(independent) || !backfill.every(id => independent.includes(id)) || !Array.isArray(scopes) || scopes.length > MAX_FLAGS) {
    throw new Error('Invalid flag or independent selection. Refresh the picker.');
  }
  const seen = new Set<string>(), covered = new Set(independent);
  for (const scope of scopes) {
    if (!scope || typeof scope.id !== 'string' || !scope.id || seen.has(scope.id) || !subset(scope.nodeIds) || !scope.nodeIds.length) {
      throw new Error('Invalid or duplicate flag scope. Refresh the picker.');
    }
    seen.add(scope.id);
    for (const id of scope.nodeIds) covered.add(id);
  }
  if (covered.size !== ids.length) throw new Error('Each selected idea must belong to a flag scope or be independently selected.');
  return { scopes: scopes.map(({ id, nodeIds }) => ({ id, nodeIds })), independent };
}

export function resolveFlags(scopes: FlagScope[], flags: readonly Flag[], graph: GraphLike): ResolvedFlag[] {
  return scopes.map(scope => {
    const flag = flags.find(f => f.id === scope.id);
    const matches = flag && new Set(matchFlag(flag, graph));
    if (!flag || !matches || scope.nodeIds.some(id => !matches.has(id))) {
      throw new Error('A selected flag or its ideas changed. Refresh and select the flag again.');
    }
    return { ...scope, revision: flagRevision(flag), note: flag.note };
  });
}

/** A shared candidate joins the requests: it must not be sent to two workers. */
export function noteComponents(flags: ResolvedFlag[]): ResolvedFlag[][] {
  const notes = flags.filter(f => f.note);
  const parent = notes.map((_, index) => index);
  const root = (index: number) => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  const owner = new Map<string, number>();
  notes.forEach((flag, i) => {
    for (const id of flag.nodeIds) {
      const j = owner.get(id);
      if (j === undefined) owner.set(id, i);
      else parent[root(i)] = root(j);
    }
  });
  const groups = new Map<number, ResolvedFlag[]>();
  notes.forEach((flag, i) => {
    const r = root(i), group = groups.get(r) ?? [];
    group.push(flag); groups.set(r, group);
  });
  return [...groups.values()];
}
