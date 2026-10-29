import {Array as EffectArray} from 'effect';
import {parseRemoteMemoryReceiptV1, type RemoteMemoryReceiptV1} from '@threadnote/memory/remote/receipts';
import {RemoteMemoryError, remoteMemoryError, type RemoteMemoryErrorCode} from './errors.js';

interface StoredOperationRejectionV1 {
  readonly error: {
    readonly code: RemoteMemoryErrorCode;
    readonly details: Readonly<Record<string, boolean | number | string>>;
    readonly message: string;
  };
  readonly kind: 'rejected';
  readonly version: 1;
}

export function isRetryableProposalOperationOutcome(value: unknown): boolean {
  return isStoredOperationRejection(value) && value.error.code === 'service_unavailable';
}

export function readStoredOperationOutcome(
  outcome: unknown,
  requestId: string,
): RemoteMemoryReceiptV1 | RemoteMemoryError {
  if (isStoredOperationRejection(outcome)) {
    return remoteMemoryError(outcome.error.code, outcome.error.message, outcome.error.details);
  }
  return {...parseRemoteMemoryReceiptV1(outcome), requestId};
}

export function storedOperationRejection(error: RemoteMemoryError): StoredOperationRejectionV1 {
  return {
    error: {code: error.code, details: error.details, message: error.message},
    kind: 'rejected',
    version: 1,
  };
}

function isStoredOperationRejection(value: unknown): value is StoredOperationRejectionV1 {
  if (typeof value !== 'object' || value === null || EffectArray.isArray(value)) return false;
  const error = 'error' in value ? value.error : undefined;
  return (
    'kind' in value &&
    value.kind === 'rejected' &&
    'version' in value &&
    value.version === 1 &&
    typeof error === 'object' &&
    error !== null &&
    !EffectArray.isArray(error) &&
    'code' in error &&
    isRemoteMemoryErrorCode(error.code) &&
    'message' in error &&
    typeof error.message === 'string' &&
    'details' in error &&
    typeof error.details === 'object' &&
    error.details !== null &&
    !EffectArray.isArray(error.details)
  );
}

function isRemoteMemoryErrorCode(value: unknown): value is RemoteMemoryErrorCode {
  return (
    value === 'attestation_required' ||
    value === 'conflict' ||
    value === 'forbidden' ||
    value === 'idempotency_mismatch' ||
    value === 'invalid_request' ||
    value === 'not_found' ||
    value === 'rate_limited' ||
    value === 'service_unavailable' ||
    value === 'unauthorized'
  );
}
