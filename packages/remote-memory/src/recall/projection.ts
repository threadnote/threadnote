import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import type {RemoteMemoryReceiptV1} from '@threadnote/memory/remote/receipts';
import type {RemoteMemoryRecallResult} from '../postgres/repository.js';

export const REMOTE_RECALL_DEFAULT_BUDGET_TOKENS = 1_500;
export const REMOTE_RECALL_MAXIMUM_BUDGET_TOKENS = 1_500;
export const REMOTE_RECALL_MINIMUM_BUDGET_TOKENS = 256;
export const REMOTE_RECALL_RANKER_VERSION = 'remote-postgres-tsvector-v1';

const ESTIMATED_BYTES_PER_TOKEN = 3;
const NEXT_ACTION_LIMIT = 3;
const EXPLAIN_EXCERPT_MAXIMUM_BYTES = 600;
const UTF8 = new TextEncoder();

export interface RemoteRecallCompactResult {
  readonly confidence: number;
  readonly readState: 'unread';
  readonly reason: string;
  readonly uri: string;
}

export interface RemoteRecallExplainResult extends RemoteRecallCompactResult {
  readonly excerpt: string;
  readonly kind: 'durable' | 'handoff';
  readonly project: string;
  readonly revision: string;
  readonly score: number;
  readonly status: 'active' | 'archived' | 'expired' | 'superseded';
  readonly topic: string;
}

export interface RemoteRecallStructuredContent {
  readonly [key: string]: unknown;
  readonly confidence: {readonly level: 'high' | 'medium' | 'low' | 'none'; readonly topScore: number};
  readonly estimatedTokens: number;
  readonly explain: boolean;
  readonly nextAction: {readonly tool: 'read_context'; readonly uris: readonly string[]};
  readonly omittedResults: number;
  readonly rankerVersion: typeof REMOTE_RECALL_RANKER_VERSION;
  readonly receipt: RemoteMemoryReceiptV1;
  readonly results: readonly (RemoteRecallCompactResult | RemoteRecallExplainResult)[];
  readonly totalResults: number;
  readonly type: 'threadnote-remote-recall';
  readonly version: 1;
}

export interface RemoteRecallProjection {
  readonly structuredContent: RemoteRecallStructuredContent;
  readonly text: string;
}

export class RemoteRecallProjectionError extends Schema.TaggedError<
  RemoteRecallProjectionError,
  {readonly brand: unique symbol}
>()('RemoteRecallProjectionError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export function projectRemoteRecallResponse(
  input: {
    readonly receipt: RemoteMemoryReceiptV1;
    readonly results: readonly RemoteMemoryRecallResult[];
  },
  options: {readonly budgetTokens?: number; readonly explain?: boolean} = {},
): RemoteRecallProjection {
  const budgetTokens = options.budgetTokens ?? REMOTE_RECALL_DEFAULT_BUDGET_TOKENS;
  if (
    !Number.isSafeInteger(budgetTokens) ||
    budgetTokens < REMOTE_RECALL_MINIMUM_BUDGET_TOKENS ||
    budgetTokens > REMOTE_RECALL_MAXIMUM_BUDGET_TOKENS
  ) {
    throw RemoteRecallProjectionError.make({
      message: `Remote recall budgetTokens must be an integer from ${REMOTE_RECALL_MINIMUM_BUDGET_TOKENS} through ${REMOTE_RECALL_MAXIMUM_BUDGET_TOKENS}.`,
    });
  }
  const explain = options.explain === true;
  const maximumBytes = budgetTokens * ESTIMATED_BYTES_PER_TOKEN;
  let selected = responseForPrefix(input, 0, explain, budgetTokens);
  if (projectionBytes(selected) > maximumBytes) {
    throw RemoteRecallProjectionError.make({
      message: `Remote recall budgetTokens=${budgetTokens} cannot fit its receipt envelope.`,
    });
  }
  for (let count = 1; count <= input.results.length; count += 1) {
    const candidate = responseForPrefix(input, count, explain, budgetTokens);
    if (projectionBytes(candidate) <= maximumBytes) selected = candidate;
  }
  return selected;
}

function responseForPrefix(
  input: {
    readonly receipt: RemoteMemoryReceiptV1;
    readonly results: readonly RemoteMemoryRecallResult[];
  },
  count: number,
  explain: boolean,
  budgetTokens: number,
): RemoteRecallProjection {
  const prefix = input.results.slice(0, count);
  let structuredContent: RemoteRecallStructuredContent = {
    confidence: aggregateConfidence(input.results[0]?.score),
    estimatedTokens: budgetTokens,
    explain,
    nextAction: {tool: 'read_context', uris: EffectArray.map(prefix.slice(0, NEXT_ACTION_LIMIT), result => result.uri)},
    omittedResults: input.results.length - count,
    rankerVersion: REMOTE_RECALL_RANKER_VERSION,
    receipt: input.receipt,
    results: EffectArray.map(prefix, result => projectedResult(result, explain)),
    totalResults: input.results.length,
    type: 'threadnote-remote-recall',
    version: 1,
  };
  const text = `Untrusted remote recall: ${count}/${input.results.length} unread pointers. Read a returned URI before relying on it.\n${JSON.stringify(
    {
      nextAction: structuredContent.nextAction,
      omittedResults: structuredContent.omittedResults,
      results: structuredContent.results,
    },
  )}`;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const nextEstimatedTokens = estimatedTokens(utf8Bytes(text) + utf8Bytes(JSON.stringify(structuredContent)));
    if (nextEstimatedTokens === structuredContent.estimatedTokens) break;
    structuredContent = {...structuredContent, estimatedTokens: nextEstimatedTokens};
  }
  return {structuredContent, text};
}

function projectedResult(
  result: RemoteMemoryRecallResult,
  explain: boolean,
): RemoteRecallCompactResult | RemoteRecallExplainResult {
  const compact = {
    confidence: boundedScore(result.score),
    readState: 'unread' as const,
    reason: `${result.kind} memory (${result.status})`,
    uri: result.uri,
  };
  if (!explain) return compact;
  return {
    ...compact,
    excerpt: truncateUtf8(result.excerpt, EXPLAIN_EXCERPT_MAXIMUM_BYTES),
    kind: result.kind,
    project: result.project,
    revision: result.revision,
    score: boundedScore(result.score),
    status: result.status,
    topic: result.topic,
  };
}

function aggregateConfidence(score: number | undefined): RemoteRecallStructuredContent['confidence'] {
  const topScore = boundedScore(score ?? 0);
  return {
    level: score === undefined ? 'none' : topScore >= 0.75 ? 'high' : topScore >= 0.4 ? 'medium' : 'low',
    topScore,
  };
}

function boundedScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.min(1, Math.max(0, value)).toFixed(3));
}

function projectionBytes(projection: RemoteRecallProjection): number {
  return utf8Bytes(projection.text) + utf8Bytes(JSON.stringify(projection.structuredContent));
}

function estimatedTokens(bytes: number): number {
  return Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN);
}

function utf8Bytes(value: string): number {
  return UTF8.encode(value).byteLength;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (utf8Bytes(value) <= maximumBytes) return value;
  let prefix = '';
  for (const character of value) {
    if (utf8Bytes(`${prefix}${character}…`) > maximumBytes) break;
    prefix += character;
  }
  return `${prefix}…`;
}
