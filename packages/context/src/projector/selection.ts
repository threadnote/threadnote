import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import {measureAgentToolResponse} from '@threadnote/protocol/agent-response';
/** A finite policy-owned ordering. Selection never assumes rendered sizes are monotone. */
export interface ProjectionItem<Lane extends string = string> {
  readonly id: string;
  readonly lane: Lane;
  readonly laneRank: number;
  readonly priority: number;
}
export function projectionItemKey(item: ProjectionItem): string {
  return `${item.lane}\u0000${item.id}`;
}
export function uniqueProjectionItems<T extends ProjectionItem>(items: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  return EffectArray.filter(items, item => {
    const key = projectionItemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function laneOrderedItems<T extends ProjectionItem>(items: readonly T[], lane: string): readonly T[] {
  return EffectArray.filter(items, item => item.lane === lane).sort(
    (left, right) => left.laneRank - right.laneRank || compareText(left.id, right.id),
  );
}
export function laneStableOptionalProjectionItems<T extends ProjectionItem>(
  items: readonly T[],
  lanes: readonly string[],
): readonly T[] {
  const originalOrder = new Map(EffectArray.map(items, (item, index) => [projectionItemKey(item), index]));
  const groups = EffectArray.map(lanes, lane => laneOrderedItems(items, lane));
  const offsets = EffectArray.map(groups, () => 0);
  const ordered: T[] = [];
  while (ordered.length < items.length) {
    let selectedLane = -1;
    let selectedOrder = Number.POSITIVE_INFINITY;
    for (const [laneIndex, group] of groups.entries()) {
      const item = group[offsets[laneIndex] ?? 0];
      if (item === undefined) continue;
      const order = originalOrder.get(projectionItemKey(item)) ?? Number.POSITIVE_INFINITY;
      if (order < selectedOrder) {
        selectedLane = laneIndex;
        selectedOrder = order;
      }
    }
    if (selectedLane < 0) break;
    ordered.push(groups[selectedLane][offsets[selectedLane]]);
    offsets[selectedLane] = (offsets[selectedLane] ?? 0) + 1;
  }
  return ordered;
}
/** Normalize selected IDs once, before either channel constructs its dictionary or receipts. */
export function selectedProjectionIds<Lane extends string>(items: readonly ProjectionItem<Lane>[]) {
  const result = new Map<Lane, Set<string>>();
  for (const item of items) {
    const ids = result.get(item.lane) ?? new Set<string>();
    ids.add(item.id);
    result.set(item.lane, ids);
  }
  return result;
}
/** Dictionary closure in the evidence owner's existing order, including sparse-array semantics. */
export function selectProjectionDictionary<T>(
  items: readonly T[],
  ids: ReadonlySet<string> | undefined,
  key: (item: T) => string | undefined,
): T[] {
  return ids === undefined
    ? []
    : EffectArray.filter(items, (item, index) => {
        if (!(index in items)) return false;
        const id = key(item);
        return typeof id === 'string' && ids.has(id);
      });
}
export function projectionOmissionCount(omissions: Readonly<Record<string, number>>): number {
  return EffectArray.reduce(EffectRecord.values(omissions), 0, (total, count) => total + count);
}
export function renderProjectionChannels<T>(value: T, format: 'agent' | 'dual', renderText: (value: T) => string) {
  const text = renderText(value);
  const measurement = measureAgentToolResponse(format === 'agent' ? {text} : {structuredContent: value, text});
  return {measurement, structuredContent: value, text};
}
export function selectFiniteProjection<TItem, TValue>(input: {
  readonly required: readonly TItem[];
  readonly optional: readonly TItem[];
  readonly maximumBytes: number;
  readonly format: 'agent' | 'dual';
  readonly render: (selected: readonly TItem[]) => TValue;
  readonly renderText: (value: TValue) => string;
}) {
  let selected:
    | (ReturnType<typeof renderProjectionChannels<TValue>> & {
        readonly count: number;
      })
    | undefined;
  for (let count = 0; count <= input.optional.length; count += 1) {
    const candidate = renderProjectionChannels(
      input.render([...input.required, ...input.optional.slice(0, count)]),
      input.format,
      input.renderText,
    );
    if (candidate.measurement.totalBytes <= input.maximumBytes) selected = {...candidate, count};
  }
  return selected;
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
