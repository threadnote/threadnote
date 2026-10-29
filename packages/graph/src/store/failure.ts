import {Array as EffectArray} from 'effect';
import {
  CodeGraphStoreBusyError,
  CodeGraphStoreCorruptionError,
  CodeGraphStoreError,
  CodeGraphStoreNoSpaceError,
  CodeGraphStorePermissionError,
  CodeGraphStoreSchemaAdditiveError,
  CodeGraphStoreTransientIoError,
  isCodeGraphStoreError,
  type CodeGraphStoreFailure,
  type CodeGraphStoreFailureCode,
} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface CodeGraphStoreAdditiveSchemaPreflight {
  readonly createsOnly: true;
  readonly preservesActivePointers: true;
  readonly preservesSnapshots: true;
}

interface FailureEvidence {
  readonly osErrnos: ReadonlySet<number>;
  readonly sqlitePrimaryCodes: ReadonlySet<number>;
  readonly tags: ReadonlySet<string>;
  readonly tokens: ReadonlySet<string>;
}

const MAXIMUM_CAUSE_DEPTH = 8;
const MAXIMUM_CAUSE_NODES = 32;
const SAFE_OPERATION = /^[a-z][a-z0-9]*(?:[ -][a-z0-9]+){0,15}$/u;
const GENERIC_OPERATION = 'code graph storage';

/** Classify only stable structured evidence. Free-form messages are intentionally never inspected. */
export function classifyCodeGraphStoreFailure(operation: string, cause: unknown): CodeGraphStoreFailure {
  if (isCodeGraphStoreError(cause)) return cause;
  const safeOperation = privacySafeOperation(operation);
  const evidence = collectFailureEvidence(cause);
  const code = classifiedFailureCode(evidence);
  return failureForCode(code, safeOperation);
}

/** Preserve the existing file-lock busy contract without exposing its path-bearing native error. */
export function codeGraphStoreBusyFailure(operation: string): CodeGraphStoreBusyError {
  const safeOperation = privacySafeOperation(operation);
  return CodeGraphStoreBusyError.of(`${safeOperation} deferred because another code graph writer owns this checkout.`, {
    operation: safeOperation,
  });
}

/**
 * Construct additive-schema recovery only from a positive, non-destructive preflight.
 * The generic cause classifier can never select this recovery class.
 */
export function codeGraphStoreSchemaAdditiveRequired(
  operation: string,
  preflight: CodeGraphStoreAdditiveSchemaPreflight,
): CodeGraphStoreSchemaAdditiveError {
  const safeOperation = privacySafeOperation(operation);
  if (!preflight.createsOnly || !preflight.preservesActivePointers || !preflight.preservesSnapshots) {
    throw CodeGraphStoreError.of('Code graph schema preflight did not prove an additive migration.', {
      operation: safeOperation,
    });
  }
  return CodeGraphStoreSchemaAdditiveError.of(
    `${safeOperation} requires a preflight-proven additive schema migration.`,
    {operation: safeOperation},
  );
}

function failureForCode(code: CodeGraphStoreFailureCode, operation: string): CodeGraphStoreFailure {
  const metadata = {operation};
  switch (code) {
    case 'busy':
      return CodeGraphStoreBusyError.of(`${operation} deferred because the code graph database is busy.`, metadata);
    case 'no-space':
      return CodeGraphStoreNoSpaceError.of(`${operation} stopped because storage space is unavailable.`, metadata);
    case 'permission':
      return CodeGraphStorePermissionError.of(`${operation} stopped because storage permission was denied.`, metadata);
    case 'transient-io':
      return CodeGraphStoreTransientIoError.of(`${operation} deferred after a transient storage failure.`, metadata);
    case 'confirmed-corruption':
      return CodeGraphStoreCorruptionError.of(
        `${operation} stopped after SQLite reported confirmed database corruption.`,
        metadata,
      );
    case 'incompatible-schema':
    case 'schema-additive':
      // These states require positive schema inspection and are never inferred
      // from a caught native error.
      return CodeGraphStoreError.of(`${operation} failed with an unclassified storage error.`, metadata);
    case 'unknown':
      return CodeGraphStoreError.of(`${operation} failed with an unclassified storage error.`, metadata);
  }
}

/** Keep SQLite and filesystem diagnostics useful without exposing local paths or unbounded native output. */
export function sanitizeCodeGraphStoreDiagnostic(value: string): string {
  return Effect.pipe(
    value,
    EffectString.replace(/[\r\n\t]+/g, ' '),
    EffectString.replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)[^'"`<>\r\n]*/g, '<local-path>'),
    EffectString.replace(/\s+/g, ' '),
    EffectString.trim,
    EffectString.slice(0, 300),
  );
}

function classifiedFailureCode(evidence: FailureEvidence): CodeGraphStoreFailureCode {
  if (
    hasToken(evidence, 'SQLITE_FULL') ||
    evidence.tokens.has('ENOSPC') ||
    evidence.osErrnos.has(28) ||
    evidence.sqlitePrimaryCodes.has(13)
  ) {
    return 'no-space';
  }
  if (
    hasAnyToken(evidence, ['SQLITE_AUTH', 'SQLITE_PERM', 'SQLITE_READONLY']) ||
    hasAnyExactToken(evidence, ['EACCES', 'EPERM', 'EROFS']) ||
    hasAnyTag(evidence, ['AuthenticationError', 'AuthorizationError', 'PermissionDenied']) ||
    hasAnyNumber(evidence.osErrnos, [1, 13, 30]) ||
    hasAnyNumber(evidence.sqlitePrimaryCodes, [3, 8, 23])
  ) {
    return 'permission';
  }
  if (
    hasAnyToken(evidence, ['SQLITE_BUSY', 'SQLITE_LOCKED']) ||
    hasAnyExactToken(evidence, ['EBUSY']) ||
    hasAnyTag(evidence, ['Busy', 'DeadlockError', 'LockTimeoutError']) ||
    evidence.osErrnos.has(16) ||
    hasAnyNumber(evidence.sqlitePrimaryCodes, [5, 6])
  ) {
    return 'busy';
  }
  if (
    hasAnyToken(evidence, ['SQLITE_CANTOPEN', 'SQLITE_IOERR']) ||
    hasAnyExactToken(evidence, ['EAGAIN', 'EINTR', 'EIO', 'ESTALE', 'ETIMEDOUT', 'EWOULDBLOCK']) ||
    hasAnyTag(evidence, [
      'ConnectionError',
      'SerializationError',
      'StatementTimeoutError',
      'TimedOut',
      'UnexpectedEof',
      'WouldBlock',
      'WriteZero',
    ]) ||
    hasAnyNumber(evidence.osErrnos, [5, 11, 35, 60, 110, 116]) ||
    hasAnyNumber(evidence.sqlitePrimaryCodes, [10, 14])
  ) {
    return 'transient-io';
  }
  if (
    hasAnyToken(evidence, ['SQLITE_CORRUPT', 'SQLITE_NOTADB']) ||
    hasAnyNumber(evidence.sqlitePrimaryCodes, [11, 26])
  ) {
    return 'confirmed-corruption';
  }
  return 'unknown';
}

function collectFailureEvidence(root: unknown): FailureEvidence {
  const tokens = new Set<string>();
  const tags = new Set<string>();
  const sqlitePrimaryCodes = new Set<number>();
  const osErrnos = new Set<number>();
  const seen = new WeakSet<object>();
  const pending: Array<{readonly depth: number; readonly value: unknown}> = [{depth: 0, value: root}];
  let visited = 0;
  const enqueue = (value: unknown, depth: number) => {
    if (depth > MAXIMUM_CAUSE_DEPTH || visited + pending.length >= MAXIMUM_CAUSE_NODES) return;
    pending.push({depth, value});
  };
  while (pending.length > 0 && visited < MAXIMUM_CAUSE_NODES) {
    const current = pending.shift();
    if (!current || current.depth > MAXIMUM_CAUSE_DEPTH) continue;
    const value = current.value;
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    visited += 1;
    if (EffectArray.isArray(value)) {
      const maximum = Math.min(safeArrayLength(value), MAXIMUM_CAUSE_NODES - visited - pending.length);
      for (let index = 0; index < maximum; index += 1) {
        enqueue(safeArrayElement(value, index), current.depth + 1);
      }
      continue;
    }
    const code = safeField(value, 'code');
    const errno = safeField(value, 'errno');
    const name = safeField(value, 'name');
    const tag = safeField(value, '_tag');
    const normalizedCode = stableToken(code);
    const normalizedErrno = stableToken(errno);
    if (normalizedCode) tokens.add(normalizedCode);
    if (normalizedErrno) tokens.add(normalizedErrno);
    if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(name)) tags.add(name);
    if (typeof tag === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(tag)) tags.add(tag);
    if (typeof code === 'number' && Number.isSafeInteger(code) && code >= 0) {
      sqlitePrimaryCodes.add(code & 0xff);
    }
    if (typeof errno === 'number' && Number.isSafeInteger(errno)) {
      if (
        Effect.pipe(normalizedCode, effectOptionalString =>
          effectOptionalString == null
            ? undefined
            : Effect.pipe(effectOptionalString, EffectString.startsWith('SQLITE_')),
        ) ||
        name === 'SQLiteError'
      ) {
        sqlitePrimaryCodes.add(Math.abs(errno) & 0xff);
      } else osErrnos.add(Math.abs(errno));
    }
    for (const field of ['cause', 'reason'] as const) {
      enqueue(safeField(value, field), current.depth + 1);
    }
    const errors = safeField(value, 'errors');
    if (EffectArray.isArray(errors)) enqueue(errors, current.depth + 1);
  }
  return {osErrnos, sqlitePrimaryCodes, tags, tokens};
}

function privacySafeOperation(operation: string): string {
  const normalized = Effect.pipe(operation, EffectString.trim, EffectString.replaceAll(/\s+/gu, ' '));
  return normalized.length <= 120 && SAFE_OPERATION.test(normalized) ? normalized : GENERIC_OPERATION;
}

function stableToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = Effect.pipe(value, EffectString.toUpperCase);
  return /^[A-Z][A-Z0-9_]{0,79}$/u.test(normalized) ? normalized : undefined;
}

function safeField(value: object, field: string): unknown {
  try {
    return field in value ? Reflect.get(value, field) : undefined;
  } catch {
    return undefined;
  }
}

function safeArrayLength(value: readonly unknown[]): number {
  try {
    return Number.isSafeInteger(value.length) && value.length > 0 ? value.length : 0;
  } catch {
    return 0;
  }
}

function safeArrayElement(value: readonly unknown[], index: number): unknown {
  try {
    return value[index];
  } catch {
    return undefined;
  }
}

function hasToken(evidence: FailureEvidence, base: string): boolean {
  for (const token of evidence.tokens) {
    if (token === base || Effect.pipe(token, EffectString.startsWith(`${base}_`))) return true;
  }
  return false;
}

function hasAnyToken(evidence: FailureEvidence, bases: readonly string[]): boolean {
  return EffectArray.some(bases, base => hasToken(evidence, base));
}

function hasAnyExactToken(evidence: FailureEvidence, tokens: readonly string[]): boolean {
  return EffectArray.some(tokens, token => evidence.tokens.has(token));
}

function hasAnyTag(evidence: FailureEvidence, tags: readonly string[]): boolean {
  return EffectArray.some(tags, tag => evidence.tags.has(tag));
}

function hasAnyNumber(values: ReadonlySet<number>, candidates: readonly number[]): boolean {
  return EffectArray.some(candidates, candidate => values.has(candidate));
}
