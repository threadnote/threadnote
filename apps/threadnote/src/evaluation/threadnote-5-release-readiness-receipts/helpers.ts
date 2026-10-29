import {Array as EffectArray, Option as EffectOption} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SOURCE_KINDS} from '../threadnote-5-release-readiness-receipts-contracts.js';
import {THREADNOTE_5_RELEASE_SCENARIOS} from '../threadnote-5-release-readiness-contract.js';
import type {
  Threadnote5LocalReceiptVerificationV1,
  Threadnote5LocalSubsystemReceiptRecordV1,
  Threadnote5LocalSourceKindV1,
} from '../threadnote-5-release-readiness-receipts-contracts.js';
import type {
  Threadnote5MeasurementV1,
  Threadnote5ObservationV1,
  Threadnote5ReleaseScenario,
  Threadnote5SourceV1,
} from '../threadnote-5-release-readiness-contract.js';
import {compareText} from '../threadnote-5-release-readiness-validation.js';

export function unknownFor(
  observations: readonly Threadnote5ObservationV1[],
  reason: Extract<Threadnote5LocalReceiptVerificationV1, {readonly state: 'unknown'}>['reason'],
): Extract<Threadnote5LocalReceiptVerificationV1, {readonly state: 'unknown'}> {
  return {
    reason,
    scenarios: EffectArray.map(observations, observation => ({
      missingKinds: EffectArray.map(observation.attestation.subsystemReceipts, receipt => receipt.kind),
      scenario: observation.scenario,
      state: 'unknown',
      verifiedKinds: [],
    })),
    state: 'unknown',
  };
}

export function contentFreeRecord(record: Threadnote5LocalSubsystemReceiptRecordV1): {
  readonly candidateHash: string;
  readonly digest: string;
  readonly kind: Threadnote5LocalSourceKindV1;
  readonly scenario: Threadnote5ReleaseScenario;
  readonly version: 1;
} {
  return {
    candidateHash: sha256HexSync(canonicalJson(record.candidate)),
    digest: record.digest,
    kind: record.kind,
    scenario: record.scenario,
    version: 1,
  };
}

export function withoutDigest(
  record: Threadnote5LocalSubsystemReceiptRecordV1,
): Omit<Threadnote5LocalSubsystemReceiptRecordV1, 'digest'> {
  const {digest: _, ...rest} = record;
  return rest;
}

export function sameSource(left: Threadnote5SourceV1, right: Threadnote5SourceV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

export function compareMeasurement(left: Threadnote5MeasurementV1, right: Threadnote5MeasurementV1): number {
  return compareText(left.id, right.id);
}

export function isSourceKind(value: unknown): value is Threadnote5LocalSourceKindV1 {
  return typeof value === 'string' && EffectArray.some(SOURCE_KINDS, kind => kind === value);
}

export function releaseScenario(value: unknown): Threadnote5ReleaseScenario {
  const scenario = EffectOption.getOrUndefined(
    EffectArray.findFirst(THREADNOTE_5_RELEASE_SCENARIOS, item => item === value),
  );
  if (scenario === undefined) throw new Error('Subsystem record scenario is invalid.');
  return scenario;
}
