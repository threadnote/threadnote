import {Array as EffectArray} from 'effect';
import approvalData from './code-memory-link-approvals.json' with {type: 'json'};
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';

const HASH = /^[0-9a-f]{64}$/u;
const APPROVAL_KEYS = [
  'agentAbEvidenceHashes',
  'agentAbManifestHashes',
  'dogfoodEvidenceHashes',
  'retainedEvidenceBundleHashes',
  'version',
] as const;

interface CodeMemoryLinkApprovalsV1 {
  readonly agentAbEvidenceHashes: readonly string[];
  readonly agentAbManifestHashes: readonly string[];
  readonly dogfoodEvidenceHashes: readonly string[];
  readonly retainedEvidenceBundleHashes: readonly string[];
  readonly version: 1;
}

function parseApprovalData(value: unknown): CodeMemoryLinkApprovalsV1 {
  if (!Predicate.isObject(value)) {
    throw new Error('Code Memory Link approvals must be a JSON object.');
  }
  const record = value;
  const keys = EffectRecord.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...APPROVAL_KEYS].sort())) {
    throw new Error(`Code Memory Link approvals must contain exactly: ${EffectArray.join(APPROVAL_KEYS, ', ')}.`);
  }
  if (record.version !== 1) throw new Error('Code Memory Link approvals version must be 1.');
  return Object.freeze({
    agentAbEvidenceHashes: parseHashes(record.agentAbEvidenceHashes, 'agentAbEvidenceHashes'),
    agentAbManifestHashes: parseHashes(record.agentAbManifestHashes, 'agentAbManifestHashes'),
    dogfoodEvidenceHashes: parseHashes(record.dogfoodEvidenceHashes, 'dogfoodEvidenceHashes'),
    retainedEvidenceBundleHashes: parseHashes(record.retainedEvidenceBundleHashes, 'retainedEvidenceBundleHashes'),
    version: 1,
  });
}

const isHashArray = (value: unknown): value is readonly string[] =>
  EffectArray.isArray(value) &&
  EffectArray.every(value, (hash): hash is string => typeof hash === 'string' && HASH.test(hash));

function parseHashes(value: unknown, name: string): readonly string[] {
  if (!isHashArray(value)) {
    throw new Error(`${name} must contain only lowercase SHA-256 hashes.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${name} must not contain duplicate hashes.`);
  return Object.freeze([...value]);
}

const approvals = parseApprovalData(approvalData);

/** Preregistered protocol hashes. Add only in a reviewed governance-only JSON commit before external trials begin. */
export const CODE_MEMORY_LINK_AGENT_AB_APPROVED_MANIFEST_HASHES = approvals.agentAbManifestHashes;

/** Completed external-agent outcome bundles. Add only after independent evidence review. */
export const CODE_MEMORY_LINK_AGENT_AB_APPROVED_EVIDENCE_HASHES = approvals.agentAbEvidenceHashes;

/** Completed practical exact-build dogfood matrices. Add only after independent evidence review. */
export const CODE_MEMORY_LINK_DOGFOOD_APPROVED_EVIDENCE_HASHES = approvals.dogfoodEvidenceHashes;

/** Complete privacy-safe retained bundles. Add only with the final evidence-governance commit. */
export const CODE_MEMORY_LINK_APPROVED_RETAINED_BUNDLE_HASHES = approvals.retainedEvidenceBundleHashes;
