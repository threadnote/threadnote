import {Array as EffectArray, Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';
import {parseContextBriefRequestV1, type ContextBriefRequestV1} from '../types.js';

export const CONTEXT_BRIEF_NAVIGATION_MODE = 'navigate' as const;
/** Opaque continuation text is client input; this bound applies before any decoding. */
export const NAVIGATION_CONTINUATION_TOKEN_BYTES = 1024;

export interface ContextBriefNavigationContinuationV1 {
  readonly token: string;
  readonly focus: 'effects';
}

/** The navigate lane request. It shares scope, task, budget, anchor and format validation with Context Brief. */
export interface ContextBriefNavigationRequestV1 {
  readonly mode: typeof CONTEXT_BRIEF_NAVIGATION_MODE;
  readonly budgetTokens: number;
  readonly codeRefs: readonly string[];
  readonly responseFormat: 'agent' | 'dual';
  readonly scope: ContextBriefRequestV1['scope'];
  readonly task: string;
  readonly continuation?: ContextBriefNavigationContinuationV1;
}

const NAVIGATION_ONLY_KEYS = new Set(['continuation']);
const UNSUPPORTED_KEYS = ['detail', 'surface'] as const;

function invalid(message: string): Error {
  return new Error(`Invalid Context Brief request: ${message}`);
}

/** True when the request selects the navigate lane; every other request keeps the existing Context Brief path. */
export function isContextBriefNavigationRequest(value: unknown): boolean {
  return Predicate.isObject(value) && 'mode' in value && value.mode === CONTEXT_BRIEF_NAVIGATION_MODE;
}

/** The existing modes reject `continuation`, so their strict request contract does not change. */
export function parseContextBriefNavigationRequestV1(value: unknown): ContextBriefNavigationRequestV1 {
  if (!Predicate.isObject(value) || EffectArray.isArray(value) || !isContextBriefNavigationRequest(value))
    throw invalid('mode must be navigate.');
  const object: Readonly<Record<string, unknown>> = value;
  for (const key of UNSUPPORTED_KEYS)
    if (object[key] !== undefined) throw invalid(`${key} is not supported with mode navigate.`);
  const shared: Record<string, unknown> = {mode: 'brief'};
  for (const [key, item] of EffectRecord.toEntries(object))
    if (key !== 'mode' && !NAVIGATION_ONLY_KEYS.has(key)) shared[key] = item;
  const parsed = parseContextBriefRequestV1(shared);
  const continuation = object.continuation === undefined ? undefined : parseContinuation(object.continuation);
  return {
    mode: CONTEXT_BRIEF_NAVIGATION_MODE,
    budgetTokens: parsed.budgetTokens,
    codeRefs: parsed.codeRefs ?? [],
    responseFormat: parsed.responseFormat ?? 'agent',
    scope: parsed.scope,
    task: parsed.task,
    ...(continuation === undefined ? {} : {continuation}),
  };
}

function parseContinuation(value: unknown): ContextBriefNavigationContinuationV1 {
  if (!Predicate.isObject(value) || EffectArray.isArray(value)) throw invalid('continuation must be an object.');
  const object: Readonly<Record<string, unknown>> = value;
  for (const key of EffectRecord.keys(object))
    if (key !== 'token' && key !== 'focus') throw invalid(`continuation has unsupported key ${key}.`);
  if (object.focus !== 'effects') throw invalid('continuation focus must be effects.');
  const token = object.token;
  if (typeof token !== 'string' || token.length === 0) throw invalid('continuation token must be text.');
  if (Buffer.byteLength(token, 'utf8') > NAVIGATION_CONTINUATION_TOKEN_BYTES)
    throw invalid(`continuation token exceeds ${NAVIGATION_CONTINUATION_TOKEN_BYTES} UTF-8 bytes.`);
  return {token, focus: 'effects'};
}
