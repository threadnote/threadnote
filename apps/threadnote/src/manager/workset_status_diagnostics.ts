import {Console, Effect} from 'effect';
import * as SqlError from 'effect/sql/SqlError';
import {runtimeIsProxy} from '@threadnote/platform/system';
import {CodeGraphWorksetCatalogError} from '@threadnote/graph/workset_catalog/types';

type ManagerWorksetDiagnosticCauseTag =
  | 'SqlError'
  | 'ConnectionError'
  | 'AuthenticationError'
  | 'AuthorizationError'
  | 'SqlSyntaxError'
  | 'UniqueViolation'
  | 'ConstraintError'
  | 'DeadlockError'
  | 'SerializationError'
  | 'LockTimeoutError'
  | 'StatementTimeoutError'
  | 'UnknownError'
  | 'unknown';

interface ManagerWorksetFailureDiagnostic {
  readonly boundary: 'catalog-status';
  readonly causeCode: 'unknown';
  readonly causeTag: ManagerWorksetDiagnosticCauseTag;
  readonly catalogReason: CodeGraphWorksetCatalogError['reason'] | 'unknown';
  readonly marker: 'manager-workset-failure-v1';
}

const WORKSET_DIAGNOSTIC_CAUSE_PROTOTYPES: ReadonlyArray<readonly [object, ManagerWorksetDiagnosticCauseTag]> = [
  [SqlError.SqlError.prototype, 'SqlError'],
  [SqlError.ConnectionError.prototype, 'ConnectionError'],
  [SqlError.AuthenticationError.prototype, 'AuthenticationError'],
  [SqlError.AuthorizationError.prototype, 'AuthorizationError'],
  [SqlError.SqlSyntaxError.prototype, 'SqlSyntaxError'],
  [SqlError.UniqueViolation.prototype, 'UniqueViolation'],
  [SqlError.ConstraintError.prototype, 'ConstraintError'],
  [SqlError.DeadlockError.prototype, 'DeadlockError'],
  [SqlError.SerializationError.prototype, 'SerializationError'],
  [SqlError.LockTimeoutError.prototype, 'LockTimeoutError'],
  [SqlError.StatementTimeoutError.prototype, 'StatementTimeoutError'],
  [SqlError.UnknownError.prototype, 'UnknownError'],
];

function ownDataValue(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || runtimeIsProxy(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function hasOnlyDataProperty(value: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor === undefined || 'value' in descriptor;
}

function managerWorksetDiagnosticTypedCauseTag(cause: unknown): ManagerWorksetDiagnosticCauseTag {
  try {
    if ((typeof cause !== 'object' && typeof cause !== 'function') || cause === null || runtimeIsProxy(cause)) {
      return 'unknown';
    }
    const tag = ownDataValue(cause, '_tag');
    if (typeof tag !== 'string') return 'unknown';
    const prototype = Object.getPrototypeOf(cause);
    for (const [expectedPrototype, expectedTag] of WORKSET_DIAGNOSTIC_CAUSE_PROTOTYPES) {
      if (tag !== expectedTag || prototype !== expectedPrototype) continue;
      if (expectedTag === 'SqlError') return expectedTag;
      return hasOnlyDataProperty(cause, 'cause') && ownDataValue(cause, 'cause') !== undefined
        ? expectedTag
        : 'unknown';
    }
  } catch {
    // Unexpected proxy behavior is rejected by the runtime proxy check; failures also fall back to unknown.
  }
  return 'unknown';
}

function managerWorksetDiagnosticCauseTag(cause: unknown): ManagerWorksetDiagnosticCauseTag {
  const tag = managerWorksetDiagnosticTypedCauseTag(cause);
  if (tag !== 'SqlError') return tag;
  const reason = ownDataValue(cause, 'reason');
  const reasonTag = managerWorksetDiagnosticTypedCauseTag(reason);
  return reasonTag !== 'unknown' && reasonTag !== 'SqlError' ? 'SqlError' : 'unknown';
}

const WORKSET_CATALOG_REASONS: ReadonlySet<string> = new Set([
  'busy',
  'capacity',
  'corrupt',
  'expired',
  'incompatible',
  'invalid-input',
  'missing',
  'stale',
  'storage',
]);

function managerWorksetDiagnosticCatalogReason(value: unknown): CodeGraphWorksetCatalogError['reason'] | undefined {
  if (typeof value !== 'string' || !WORKSET_CATALOG_REASONS.has(value)) return undefined;
  switch (value) {
    case 'busy':
    case 'capacity':
    case 'corrupt':
    case 'expired':
    case 'incompatible':
    case 'invalid-input':
    case 'missing':
    case 'stale':
    case 'storage':
      return value;
  }
}

export function managerWorksetFailureDiagnostic(error: unknown): ManagerWorksetFailureDiagnostic {
  try {
    if (
      (typeof error === 'object' || typeof error === 'function') &&
      error !== null &&
      !runtimeIsProxy(error) &&
      Object.getPrototypeOf(error) === CodeGraphWorksetCatalogError.prototype &&
      ownDataValue(error, '_tag') === 'CodeGraphWorksetCatalogError' &&
      hasOnlyDataProperty(error, 'cause')
    ) {
      const reason = managerWorksetDiagnosticCatalogReason(ownDataValue(error, 'reason'));
      if (reason === undefined) return unknownManagerWorksetDiagnostic();
      return {
        boundary: 'catalog-status',
        causeCode: 'unknown',
        causeTag: managerWorksetDiagnosticCauseTag(ownDataValue(error, 'cause')),
        catalogReason: reason,
        marker: 'manager-workset-failure-v1',
      };
    }
  } catch {
    // Own data descriptors avoid invoking accessors; unknown shapes are intentionally omitted.
  }
  return unknownManagerWorksetDiagnostic();
}

function unknownManagerWorksetDiagnostic(): ManagerWorksetFailureDiagnostic {
  return {
    boundary: 'catalog-status',
    causeCode: 'unknown',
    causeTag: 'unknown',
    catalogReason: 'unknown',
    marker: 'manager-workset-failure-v1',
  };
}

export function managerWorksetFailureDiagnosticEffect(error: unknown): Effect.Effect<void> {
  const diagnostic = managerWorksetFailureDiagnostic(error);
  return diagnostic.catalogReason === 'unknown'
    ? Effect.void
    : Effect.exit(
        Console.consoleWith(current => Effect.sync(() => current.error(`[${JSON.stringify(diagnostic)}]`))),
      ).pipe(Effect.asVoid);
}
