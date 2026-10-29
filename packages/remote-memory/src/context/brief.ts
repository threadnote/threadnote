import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {deriveRecallCodeLinkSelectorDigest} from '@threadnote/recall/code_links';
import type {RemoteMemoryReceiptV1} from '@threadnote/memory/remote/receipts';
import type {RemoteMemoryRecallResult} from '../postgres/repository.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const REMOTE_CONTEXT_BRIEF_MINIMUM_BUDGET_TOKENS = 800;
export const REMOTE_CONTEXT_BRIEF_DEFAULT_BUDGET_TOKENS = 1_250;
export const REMOTE_CONTEXT_BRIEF_MAXIMUM_BUDGET_TOKENS = 1_500;
export const REMOTE_CONTEXT_BRIEF_MAXIMUM_ANCHORS = 8;

const RepositoryId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Path = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
  Schema.makeFilter(value =>
    isCanonicalRepositoryPath(value) ? undefined : 'Expected one canonical repository-relative path.',
  ),
);

export const RemoteContextBriefAnchorSchemaV1 = Schema.Struct({
  path: Path,
  repositoryId: RepositoryId,
});

export type RemoteContextBriefAnchorV1 = typeof RemoteContextBriefAnchorSchemaV1.Type;

export interface RemoteContextBriefInputV1 {
  readonly anchors?: readonly RemoteContextBriefAnchorV1[];
  readonly budgetTokens: number;
  readonly project: string;
  readonly task: string;
  readonly version: 1;
}

export interface RemoteContextBriefAnchorSelector {
  readonly anchorOrdinal: number;
  readonly selectorDigest: string;
}

/** Normalization is order-stable and keeps the first requested occurrence. */
export function normalizeRemoteContextBriefAnchors(
  anchors: readonly RemoteContextBriefAnchorV1[] | undefined,
): readonly RemoteContextBriefAnchorV1[] | undefined {
  if (anchors === undefined) return undefined;
  const parsed = Schema.decodeSync(
    Schema.Array(RemoteContextBriefAnchorSchemaV1).check(Schema.isMaxLength(REMOTE_CONTEXT_BRIEF_MAXIMUM_ANCHORS)),
    {errors: 'all', onExcessProperty: 'error'},
  )(anchors);
  const seen = new Set<string>();
  return EffectArray.filter(parsed, anchor => {
    const key = `${anchor.repositoryId}\n${anchor.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function remoteContextBriefAnchorSelectors(
  anchors: readonly RemoteContextBriefAnchorV1[] | undefined,
): readonly RemoteContextBriefAnchorSelector[] {
  return EffectArray.map(normalizeRemoteContextBriefAnchors(anchors) ?? [], (anchor, anchorOrdinal) => ({
    anchorOrdinal,
    selectorDigest: deriveRecallCodeLinkSelectorDigest({
      repositoryId: anchor.repositoryId,
      repositoryIdentityKind: 'remote',
      selectorKind: 'file-path',
      value: anchor.path,
    }),
  }));
}

export interface RemoteContextBriefResult extends RemoteMemoryRecallResult {
  readonly anchorOrdinals?: readonly number[];
  readonly evidence: 'anchor' | 'lexical';
}

export interface RemoteContextBriefProjection {
  readonly structuredContent: Readonly<Record<string, unknown>>;
  readonly text: string;
}

const UTF8 = new TextEncoder();
const BYTES_PER_TOKEN = 3;

/**
 * Remote projection deliberately reports capture-time provenance only. The
 * remote service never sees a caller checkout and cannot validate graph state.
 */
export function projectRemoteContextBrief(input: {
  readonly anchors: readonly RemoteContextBriefAnchorV1[];
  readonly directSearchComplete: boolean;
  readonly directSearchTruncated: boolean;
  readonly receipt: RemoteMemoryReceiptV1;
  readonly results: readonly RemoteContextBriefResult[];
  readonly matchedAnchorOrdinals: readonly number[];
  readonly task: string;
  readonly budgetTokens: number;
}): RemoteContextBriefProjection {
  if (
    !Number.isSafeInteger(input.budgetTokens) ||
    input.budgetTokens < REMOTE_CONTEXT_BRIEF_MINIMUM_BUDGET_TOKENS ||
    input.budgetTokens > REMOTE_CONTEXT_BRIEF_MAXIMUM_BUDGET_TOKENS
  ) {
    throw new TypeError(
      `Remote Context Brief budgetTokens must be an integer from ${REMOTE_CONTEXT_BRIEF_MINIMUM_BUDGET_TOKENS} through ${REMOTE_CONTEXT_BRIEF_MAXIMUM_BUDGET_TOKENS}.`,
    );
  }
  const maximumBytes = input.budgetTokens * BYTES_PER_TOKEN;
  let selected: RemoteContextBriefProjection | undefined;
  for (let count = 0; count <= input.results.length; count += 1) {
    const candidate = responseForPrefix(input, count);
    if (bytes(candidate) <= maximumBytes) selected = candidate;
  }
  if (!selected) throw new TypeError('Remote Context Brief budget cannot fit its safety envelope.');
  return selected;
}

function responseForPrefix(
  input: Parameters<typeof projectRemoteContextBrief>[0],
  count: number,
): RemoteContextBriefProjection {
  const prefix = input.results.slice(0, count);
  const returnedAnchorOrdinals = uniqueOrdinals(EffectArray.flatMap(prefix, result => result.anchorOrdinals ?? []));
  const matchedAnchorOrdinals = uniqueOrdinals(input.matchedAnchorOrdinals);
  const lane = (kind: 'durable' | 'handoff') =>
    EffectArray.map(
      EffectArray.filter(prefix, result => result.kind === kind),
      result => ({
        ...(result.anchorOrdinals === undefined ? {} : {anchorOrdinals: result.anchorOrdinals}),
        evidence: result.evidence,
        readState: 'unread',
        reason:
          result.evidence === 'anchor' ? 'capture-time citation matched supplied anchor' : 'lexical remote recall',
        uri: result.uri,
      }),
    );
  const coverage = {
    directSearchComplete: input.directSearchComplete,
    directSearchTruncated: input.directSearchTruncated,
    matchedAnchorOrdinals,
    omittedMatchedAnchorOrdinals: EffectArray.filter(
      matchedAnchorOrdinals,
      ordinal => !returnedAnchorOrdinals.includes(ordinal),
    ),
    returnedAnchorOrdinals,
    supplied: input.anchors.length,
    unmatchedAnchorOrdinals: input.directSearchComplete
      ? EffectArray.filter(
          EffectArray.map(input.anchors, (_, index) => index),
          index => !matchedAnchorOrdinals.includes(index),
        )
      : [],
    unresolvedAnchorOrdinals: input.directSearchComplete
      ? []
      : EffectArray.filter(
          EffectArray.map(input.anchors, (_, index) => index),
          index => !matchedAnchorOrdinals.includes(index),
        ),
  };
  const task = boundedTask(input.task);
  const structuredContent: Readonly<Record<string, unknown>> = {
    anchors: {coverage, provenance: 'capture-time-only'},
    durable: lane('durable'),
    estimatedTokens: input.budgetTokens,
    nextAction: {
      readCanonicalMemories: EffectArray.map(prefix.slice(0, 3), result => result.uri),
      validateLocally:
        'Use threadnote-local inspect_code_graph or local Context Brief to validate cited graph references against the current checkout.',
    },
    activeHandoffs: lane('handoff'),
    omittedResults: input.results.length - count,
    receipt: input.receipt,
    task,
    totalResults: input.results.length,
    type: 'threadnote-remote-context-brief',
    version: 1,
  };
  const pointers = EffectArray.join(
    EffectArray.map(prefix, result => `${result.evidence} ${result.uri}`),
    '\n',
  );
  const text = EffectArray.join(
    EffectArray.filter(
      [
        `Remote Context Brief: ${count}/${input.results.length} authorized memories.`,
        pointers,
        'Citation links are capture-time provenance; validate graph references on threadnote-local before relying on them.',
      ],
      Boolean,
    ),
    '\n',
  );
  const estimatedTokens = Math.ceil(bytes({structuredContent, text}) / BYTES_PER_TOKEN);
  return {structuredContent: {...structuredContent, estimatedTokens}, text};
}

function bytes(value: RemoteContextBriefProjection): number {
  return UTF8.encode(value.text).byteLength + UTF8.encode(JSON.stringify(value.structuredContent)).byteLength;
}

function uniqueOrdinals(ordinals: readonly number[]): readonly number[] {
  return [...new Set(ordinals)].sort((left, right) => left - right);
}

function boundedTask(task: string): {readonly summary: string; readonly truncated: boolean} {
  const maximumBytes = 256;
  if (UTF8.encode(task).byteLength <= maximumBytes) return {summary: task, truncated: false};
  let summary = '';
  for (const character of task) {
    if (UTF8.encode(`${summary}${character}…`).byteLength > maximumBytes) break;
    summary += character;
  }
  return {summary: `${summary}…`, truncated: true};
}

function isCanonicalRepositoryPath(value: string): boolean {
  return (
    !Effect.pipe(value, EffectString.startsWith('/')) &&
    !Effect.pipe(value, EffectString.includes('\\')) &&
    !Effect.pipe(value, EffectString.includes('\0')) &&
    EffectArray.every(
      Effect.pipe(value, EffectString.split('/')),
      segment => segment.length > 0 && segment !== '.' && segment !== '..',
    )
  );
}
