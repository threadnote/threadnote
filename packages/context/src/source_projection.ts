import {isSafeInteger as checkedIsSafeInteger} from '@threadnote/platform/validation';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Predicate} from 'effect';
import {
  CONTEXT_BRIEF_SOURCE_MAXIMUM_COVERED_REFS,
  type ContextBriefLogicalResultV1,
  type ContextBriefSourceExcerptV1,
  type ContextBriefV1,
} from './types.js';
import * as EffectRecord from 'effect/Record';

type ProjectionItemLike = {
  readonly id: string;
  readonly lane: string;
  readonly laneRank: number;
  readonly priority: number;
};

type SourceProjectionItem = ProjectionItemLike & {readonly lane: 'source-excerpt'};

export const CONTEXT_BRIEF_SOURCE_EXCERPT_BUDGET_GAP = 'graph-source-excerpt-omitted-for-budget';

export const CONTEXT_BRIEF_AGENT_VIEW_SOURCE_EXCERPT_FIELD_POLICY = {
  content: 'agent-view',
  coveredGraphRefs: 'agent-view',
  endLine: 'agent-view',
  evidenceKind: 'agent-view',
  freshness: 'agent-view',
  id: 'represented',
  path: 'agent-view',
  repositoryKey: 'agent-view',
  snapshotIdentity: 'agent-view',
  startLine: 'agent-view',
  truncated: 'agent-view',
} as const satisfies Readonly<Record<keyof ContextBriefSourceExcerptV1, 'agent-view' | 'audit-only' | 'represented'>>;

export function contextBriefAnswerWithSourceReadSignal(
  brief: ContextBriefV1,
  answer: string,
  utf8Prefix: (value: string, maximumBytes: number) => string,
): string {
  return (brief.graph.sources?.length ?? 0) === 0
    ? answer
    : utf8Prefix(`${answer} Source excerpts are included and already read.`, 192);
}

export function contextBriefSourceProjectionItems(
  logical: ContextBriefLogicalResultV1,
): readonly SourceProjectionItem[] {
  return EffectArray.map(logical.graph.sourceExcerpts ?? [], source => ({
    id: source.id,
    lane: 'source-excerpt',
    laneRank: Math.min(
      ...EffectArray.map(
        source.coveredGraphRefs,
        ref =>
          EffectOption.getOrUndefined(EffectArray.findFirst(logical.graph.cards, card => card.ref === ref))?.rank ??
          source.startLine,
      ),
    ),
    priority: 0,
  }));
}

export function requiredContextBriefSourceProjectionItems<T extends ProjectionItemLike>(
  logical: ContextBriefLogicalResultV1,
  items: readonly T[],
): readonly T[] {
  const source = logical.graph.sourceExcerpts?.[0];
  if (source === undefined) return [];
  const sourceItem = EffectOption.getOrUndefined(
    EffectArray.findFirst(items, item => item.lane === 'source-excerpt' && item.id === source.id),
  );
  if (sourceItem === undefined) return [];
  const card = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      logical.graph.cards,
      __effectArrayValue => !!(candidate => source.coveredGraphRefs.includes(candidate.ref))(__effectArrayValue),
    ),
  );
  const contract = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      logical.graph.contracts,
      __effectArrayValue =>
        !!(candidate =>
          source.coveredGraphRefs.includes(candidate.sourceRef) ||
          source.coveredGraphRefs.includes(candidate.targetRef))(__effectArrayValue),
    ),
  );
  const evidenceItem =
    card === undefined
      ? contract === undefined
        ? undefined
        : EffectOption.getOrUndefined(
            EffectArray.findFirst(items, item => item.lane === 'graph-contract' && item.id === contract.id),
          )
      : EffectOption.getOrUndefined(
          EffectArray.findFirst(items, item => item.lane === 'graph-card' && item.id === card.id),
        );
  return evidenceItem === undefined ? [] : [evidenceItem, sourceItem];
}

export function selectContextBriefProjectedSources(
  logical: ContextBriefLogicalResultV1,
  selectedSourceIds: ReadonlySet<string> | undefined,
  retainedGraphRefs: ReadonlySet<string>,
): readonly ContextBriefSourceExcerptV1[] {
  const sourceExcerpts = logical.graph.sourceExcerpts ?? [];
  return EffectArray.filter(
    sourceExcerpts,
    (source, __effectArrayIndex) =>
      __effectArrayIndex in sourceExcerpts &&
      selectedSourceIds?.has(source.id) === true &&
      EffectArray.some(source.coveredGraphRefs, ref => retainedGraphRefs.has(ref)),
  );
}

export function withAdjustedContextBriefSourceExcerpt(
  logical: ContextBriefLogicalResultV1,
  sourceId: string,
  source: ContextBriefSourceExcerptV1,
): ContextBriefLogicalResultV1 {
  return {
    ...logical,
    graph: {
      ...logical.graph,
      sourceExcerpts: EffectArray.map(logical.graph.sourceExcerpts ?? [], candidate =>
        candidate.id === sourceId ? source : candidate,
      ),
    },
  };
}

export function contextBriefSourceExcerptOmissionCount(logical: ContextBriefLogicalResultV1, returned = 0): number {
  return (
    (logical.graph.sourceExcerpts?.length ?? 0) -
    returned +
    (logical.coverage.gaps.includes(CONTEXT_BRIEF_SOURCE_EXCERPT_BUDGET_GAP) ? 1 : 0)
  );
}

export function validateContextBriefSourceExcerpt(value: unknown, index: number): void {
  const label = `graph.sources[${index}]`;
  if (!Predicate.isObject(value)) throw invalid(`${label} must be an object`);
  assertKeys(
    value,
    [
      'content',
      'coveredGraphRefs',
      'endLine',
      'evidenceKind',
      'freshness',
      'id',
      'path',
      'repositoryKey',
      'snapshotIdentity',
      'startLine',
      'truncated',
    ],
    label,
  );
  if (
    typeof value.content !== 'string' ||
    !stringArray(value.coveredGraphRefs) ||
    value.coveredGraphRefs.length === 0 ||
    value.coveredGraphRefs.length > CONTEXT_BRIEF_SOURCE_MAXIMUM_COVERED_REFS ||
    !EffectArray.every(value.coveredGraphRefs, ref => /^cgs_(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/u.test(ref)) ||
    !positiveInteger(value.startLine) ||
    !positiveInteger(value.endLine) ||
    value.endLine < value.startLine ||
    !['current-dirty-overlay', 'graph-snapshot'].includes(String(value.evidenceKind)) ||
    value.freshness !== 'fresh' ||
    typeof value.id !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.repositoryKey !== 'string' ||
    !['current-clean', 'current-dirty-overlay'].includes(String(value.snapshotIdentity)) ||
    typeof value.truncated !== 'boolean'
  ) {
    throw invalid(`${label} is invalid`);
  }
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unsupported = EffectArray.filter(EffectRecord.keys(value), key => !allowedKeys.has(key));
  if (unsupported.length > 0) throw invalid(`${label} has unsupported field ${JSON.stringify(unsupported.sort()[0])}`);
}

function positiveInteger(value: unknown): value is number {
  return checkedIsSafeInteger(value) && value > 0;
}

function stringArray(value: unknown): value is readonly string[] {
  return EffectArray.isArray(value) && EffectArray.every(value, item => typeof item === 'string');
}

function invalid(message: string): Error {
  return new Error(`Invalid Context Brief projection: ${message}.`);
}
