import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export type CanonicalJsonValue =
  boolean | null | number | string | readonly CanonicalJsonValue[] | {readonly [key: string]: CanonicalJsonValue};

/** Narrows an already-normalized JSON value to its plain object variant. */
export function isCanonicalJsonRecord(
  value: CanonicalJsonValue,
): value is Readonly<Record<string, CanonicalJsonValue>> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

const HASH = /^[0-9a-f]{64}$/u;
const MAXIMUM_TEXT_BYTES = 1_024 * 1_024;
const UTF8 = new TextEncoder();

export function normalizeJsonValue(value: unknown, label: string, depth = 0): CanonicalJsonValue {
  if (depth > 64) invalid(`${label} exceeds the maximum nesting depth`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${label} contains a non-finite number`);
    return value;
  }
  if (EffectArray.isArray(value)) {
    if (value.length > 10_000) invalid(`${label} array is too large`);
    return EffectArray.map(value, entry => normalizeJsonValue(entry, label, depth + 1));
  }
  if (!isPlainRecord(value)) {
    invalid(`${label} must contain only JSON values`);
  }
  const object = value;
  const keys = EffectRecord.keys(object).sort(compareStrings);
  if (keys.length > 10_000) invalid(`${label} object is too large`);
  return EffectRecord.fromEntries(
    EffectArray.map(keys, key => [key, normalizeJsonValue(object[key], label, depth + 1)]),
  );
}

export function validateCodeMemoryLinkThreadSettingsUpdateV1(value: unknown, threadId: string): void {
  const params = record(value, 'thread/settings/updated params');
  matchingIdentifier(params.threadId, threadId, 'thread/settings/updated thread id');
  const settings = record(params.threadSettings, 'thread/settings/updated settings');
  const sandbox = record(settings.sandboxPolicy, 'thread/settings/updated sandbox');
  if (
    settings.approvalPolicy !== 'untrusted' ||
    settings.approvalsReviewer !== 'user' ||
    settings.activePermissionProfile !== null ||
    sandbox.type !== 'workspaceWrite' ||
    !EffectArray.isArray(sandbox.writableRoots) ||
    sandbox.writableRoots.length !== 0 ||
    sandbox.networkAccess !== false ||
    sandbox.excludeTmpdirEnvVar !== true ||
    sandbox.excludeSlashTmp !== true
  ) {
    invalid('thread/settings/updated differs from the sealed workspace policy');
  }
  boundedText(settings.cwd, 'thread/settings/updated cwd', 4_096);
}

export function assertSyntheticArtifactContent(
  artifact: {readonly content: string; readonly mediaType: 'application/json' | 'text/plain'},
  label: string,
): void {
  if (artifact.mediaType === 'text/plain') return assertSyntheticText(artifact.content, `${label} content`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact.content);
  } catch {
    invalid(`${label} is not valid JSON`);
  }
  const normalized = normalizeJsonValue(parsed, label);
  assertSyntheticJsonValue(normalized, label);
  if (artifact.content !== JSON.stringify(normalized)) {
    invalid(`${label} JSON must use the canonical privacy-safe serialization`);
  }
}

export function assertSyntheticText(value: string, label: string): void {
  if (!/^(?:[A-Za-z0-9_.:-]+(?:=[A-Za-z0-9_.:-]+)?(?:\n|$))*$/u.test(value)) {
    invalid(`${label} must contain only privacy-safe synthetic tokens`);
  }
}

const isCanonicalJsonArray = (value: CanonicalJsonValue): value is readonly CanonicalJsonValue[] =>
  EffectArray.isArray(value);

export function assertSyntheticJsonValue(value: CanonicalJsonValue, label: string): void {
  if (typeof value === 'string') {
    if (!/^[A-Za-z0-9_.:-]{0,256}$/u.test(value)) invalid(`${label} contains non-synthetic text`);
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (isCanonicalJsonArray(value))
    return void EffectArray.forEach(value, entry => assertSyntheticJsonValue(entry, label));
  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(key)) invalid(`${label} contains a non-synthetic key`);
    assertSyntheticJsonValue(entry, label);
  }
}

export function parseStepTokenBudget(value: unknown): {readonly steps: number; readonly tokens: number} {
  const budget = record(value, 'task budget');
  exactKeys(budget, ['steps', 'tokens'], 'task budget');
  const steps = positiveInteger(budget.steps, 'task step budget');
  const tokens = positiveInteger(budget.tokens, 'task token budget');
  if (tokens > 1_000_000 || steps > 10_000) invalid('task budget exceeds the protocol maximum');
  return {steps, tokens};
}

export function normalizeContextBriefProxyRequest(value: unknown, prompt: string): Readonly<Record<string, unknown>> {
  const request = record(value, 'Context Brief proxy request');
  exactKeys(
    request,
    ['budgetTokens', 'callerCwd', 'codeRefs', 'mode', 'project', 'task', 'workset'],
    'Context Brief proxy request',
    true,
  );
  if (request.task !== prompt) invalid('Context Brief proxy request must use the exact sealed task prompt');
  let codeRefs: readonly string[] | undefined;
  if (request.codeRefs !== undefined) {
    if (!EffectArray.isArray(request.codeRefs) || request.codeRefs.length > 8) {
      invalid('Context Brief proxy codeRefs must be an array with at most eight values');
    }
    codeRefs = EffectArray.map(request.codeRefs, (entry, index) =>
      boundedText(entry, `Context Brief proxy codeRefs[${index}]`, 4_096),
    );
    unique(codeRefs, 'Context Brief proxy codeRefs');
  }
  const budgetTokens =
    request.budgetTokens === undefined
      ? undefined
      : positiveInteger(request.budgetTokens, 'Context Brief token budget');
  if (budgetTokens !== undefined && budgetTokens > 1_000_000) invalid('Context Brief token budget exceeds the maximum');
  return {
    ...(budgetTokens === undefined ? {} : {budgetTokens}),
    ...(request.callerCwd === undefined ? {} : {callerCwd: boundedText(request.callerCwd, 'callerCwd', 16_384)}),
    ...(codeRefs === undefined ? {} : {codeRefs}),
    ...(request.mode === undefined
      ? {}
      : {
          mode: literal(request.mode, ['brief', 'explain', 'impact', 'locate', 'trace'] as const, 'Context Brief mode'),
        }),
    ...(request.project === undefined ? {} : {project: boundedText(request.project, 'project', 128)}),
    task: prompt,
    ...(request.workset === undefined ? {} : {workset: boundedText(request.workset, 'workset', 128)}),
  };
}

export function hashArray(value: unknown, label: string, maximum: number): readonly string[] {
  if (!EffectArray.isArray(value) || value.length > maximum) {
    invalid(`${label} must be an array with at most ${maximum} entries`);
  }
  const hashes = EffectArray.map(value, (entry, index) => matchingHash(entry, `${label} ${index + 1}`));
  canonicalUnique(hashes, label);
  return hashes;
}

export function literalArray<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): readonly T[number][] {
  if (!EffectArray.isArray(value)) invalid(`${label} must be an array`);
  const entries = EffectArray.map(value, entry => literal(entry, allowed, label));
  canonicalUnique(entries, label);
  return entries;
}

export function matchingIdentifier(value: unknown, expected: string, label: string): void {
  if (boundedText(value, label, 256) !== expected) invalid(`${label} does not match the active trial`);
}

export function matchingHash(value: unknown, label: string): string {
  return matchingText(value, HASH, `${label} hash`);
}

export function matchingText(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

export function boundedText(value: unknown, label: string, maximumBytes: number, normalize = true): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  const text = normalize ? Effect.pipe(value, EffectString.normalize('NFKC'), EffectString.trim) : value;
  if (
    !Effect.pipe(text, EffectString.trim) ||
    UTF8.encode(text).byteLength > Math.min(maximumBytes, MAXIMUM_TEXT_BYTES) ||
    containsUnsupportedControl(text)
  ) {
    invalid(`${label} must be non-empty bounded text without control characters`);
  }
  return text;
}

export function boundedUtf8Content(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  if (UTF8.encode(value).byteLength > maximumBytes || containsUnsupportedControl(value)) {
    invalid(`${label} must be bounded UTF-8 text without unsupported control characters`);
  }
  return value;
}

export function protocolVersion(value: unknown, label: string): 1 {
  if (value !== 1) invalid(`${label} version must be 1`);
  return 1;
}

export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalid(`${label} must be a positive safe integer`);
  }
  return value;
}

export function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  return value;
}

export function literal<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    invalid(`${label} must be one of ${EffectArray.join(allowed, ', ')}`);
  }
  return value;
}

export function canonicalUnique(values: readonly string[], label: string): void {
  unique(values, label);
  if (EffectArray.some(values, (value, index) => index > 0 && value <= values[index - 1])) {
    invalid(`${label} must use canonical ascending order`);
  }
}

export function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

export function uniqueMap<T>(values: readonly T[], key: (value: T) => string, label: string): ReadonlyMap<string, T> {
  const entries = EffectArray.map(values, value => [key(value), value] as const);
  unique(
    EffectArray.map(entries, ([entryKey]) => entryKey),
    label,
  );
  return new Map(entries);
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Predicate.isObject(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  optional = false,
): void {
  const actual = EffectRecord.keys(value).sort(compareStrings);
  const expected = [...keys].sort(compareStrings);
  if (optional) {
    const unexpected = EffectArray.filter(actual, key => !expected.includes(key));
    if (unexpected.length > 0) invalid(`${label} has unsupported field ${unexpected[0]}`);
    return;
  }
  if (actual.length !== expected.length || EffectArray.some(actual, (key, index) => key !== expected[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

export function boundedRequestId(value: unknown, label: string): string | number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string') return boundedText(value, label, 256);
  return invalid(`${label} is invalid`);
}

export function validateResolvedServerRequestV1(params: Record<string, unknown>, threadId: string): void {
  exactKeys(params, ['requestId', 'threadId'], 'resolved server request');
  matchingIdentifier(params.threadId, threadId, 'resolved server request thread id');
  boundedRequestId(params.requestId, 'resolved server request id');
}

export function protocolDigest(domain: string, value: unknown): string {
  return sha256HexSync(`code-memory-link-agent-protocol-v1\0${domain}\0${JSON.stringify(value)}\n`);
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link real-agent protocol: ${message}.`);
}

function containsUnsupportedControl(value: string): boolean {
  return EffectArray.some([...value], character => {
    const code =
      Effect.pipe(
        character,
        EffectString.codePointAt(0),
        Effect.Option.getOrElse(() => undefined),
      ) ?? 0;
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
  });
}
