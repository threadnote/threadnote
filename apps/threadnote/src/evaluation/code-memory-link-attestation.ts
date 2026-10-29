import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';

export const CODE_MEMORY_LINK_HARNESS_VERSION = 'code-memory-link-harness-v1' as const;

export interface CodeMemoryLinkCandidateIdentityV1 {
  readonly buildIdentityHash: string;
  readonly commit: string;
  readonly dirty: false;
}

export interface CodeMemoryLinkRuntimeIdentityV1 {
  readonly executableSha256: string;
  readonly sourceCommit: string;
}

export function projectCodeMemoryLinkRuntimeIdentityV1(
  runtime: CodeMemoryLinkRuntimeIdentityV1,
): CodeMemoryLinkRuntimeIdentityV1 {
  return {
    executableSha256: runtime.executableSha256,
    sourceCommit: runtime.sourceCommit,
  };
}

export interface CodeMemoryLinkInvocationAttestationV1 {
  readonly harnessCommit: string;
  readonly harnessVersion: typeof CODE_MEMORY_LINK_HARNESS_VERSION;
  readonly invocationDigest: string;
  readonly invocationNonce: string;
  readonly outputDigest: string;
  readonly postRuntime: CodeMemoryLinkRuntimeIdentityV1;
  readonly preRuntime: CodeMemoryLinkRuntimeIdentityV1;
  readonly summaryDigest: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const INVOCATION_NONCE = /^inv_[0-9a-f]{16,64}$/u;

export function createCodeMemoryLinkInvocationAttestationV1(input: {
  readonly candidate: CodeMemoryLinkCandidateIdentityV1;
  readonly harnessCommit: string;
  readonly invocation: unknown;
  readonly invocationNonce: string;
  /** Privacy-safe structured projection retained in the receipt and independently recomputable. */
  readonly outputProjection: unknown;
  readonly postRuntime: CodeMemoryLinkRuntimeIdentityV1;
  readonly preRuntime: CodeMemoryLinkRuntimeIdentityV1;
  readonly summary: unknown;
}): CodeMemoryLinkInvocationAttestationV1 {
  const candidate = parseCandidate(input.candidate);
  const harnessCommit = matching(input.harnessCommit, COMMIT, 'harness commit');
  const invocationNonce = matching(input.invocationNonce, INVOCATION_NONCE, 'invocation nonce');
  const preRuntime = parseRuntime(projectCodeMemoryLinkRuntimeIdentityV1(input.preRuntime), 'pre-run runtime');
  const postRuntime = parseRuntime(projectCodeMemoryLinkRuntimeIdentityV1(input.postRuntime), 'post-run runtime');
  assertRuntime(candidate, preRuntime, 'pre-run runtime');
  assertRuntime(candidate, postRuntime, 'post-run runtime');
  const invocationDigest = digest({
    candidate,
    harnessCommit,
    harnessVersion: CODE_MEMORY_LINK_HARNESS_VERSION,
    invocation: input.invocation,
    invocationNonce,
  });
  const outputDigest = digest(input.outputProjection);
  return {
    harnessCommit,
    harnessVersion: CODE_MEMORY_LINK_HARNESS_VERSION,
    invocationDigest,
    invocationNonce,
    outputDigest,
    postRuntime,
    preRuntime,
    summaryDigest: digest({invocationDigest, outputDigest, summary: input.summary}),
  };
}

export function parseCodeMemoryLinkInvocationAttestationV1(
  value: unknown,
  input: {
    readonly candidate: CodeMemoryLinkCandidateIdentityV1;
    readonly harnessCommit: string;
    readonly invocation: unknown;
    readonly outputProjection: unknown;
    readonly summary: unknown;
  },
): CodeMemoryLinkInvocationAttestationV1 {
  const attestation = record(value, 'invocation attestation');
  exactKeys(
    attestation,
    [
      'harnessVersion',
      'harnessCommit',
      'invocationDigest',
      'invocationNonce',
      'outputDigest',
      'postRuntime',
      'preRuntime',
      'summaryDigest',
    ],
    'invocation attestation',
  );
  if (attestation.harnessVersion !== CODE_MEMORY_LINK_HARNESS_VERSION) invalid('harness version is unsupported');
  const candidate = parseCandidate(input.candidate);
  const harnessCommit = matching(attestation.harnessCommit, COMMIT, 'harness commit');
  if (harnessCommit !== matching(input.harnessCommit, COMMIT, 'expected harness commit')) {
    invalid('harness commit does not match the reviewed runner checkout');
  }
  const invocationNonce = matching(attestation.invocationNonce, INVOCATION_NONCE, 'invocation nonce');
  const preRuntime = parseRuntime(attestation.preRuntime, 'pre-run runtime');
  const postRuntime = parseRuntime(attestation.postRuntime, 'post-run runtime');
  assertRuntime(candidate, preRuntime, 'pre-run runtime');
  assertRuntime(candidate, postRuntime, 'post-run runtime');
  const invocationDigest = matching(attestation.invocationDigest, HASH, 'invocation digest');
  const expectedInvocationDigest = digest({
    candidate,
    harnessCommit,
    harnessVersion: CODE_MEMORY_LINK_HARNESS_VERSION,
    invocation: input.invocation,
    invocationNonce,
  });
  if (invocationDigest !== expectedInvocationDigest) invalid('invocation digest does not match its run contract');
  const outputDigest = matching(attestation.outputDigest, HASH, 'output digest');
  if (outputDigest !== digest(input.outputProjection)) {
    invalid('output digest does not match the retained privacy-safe projection');
  }
  const summaryDigest = matching(attestation.summaryDigest, HASH, 'summary digest');
  if (summaryDigest !== digest({invocationDigest, outputDigest, summary: input.summary})) {
    invalid('summary digest does not bind the reported observation to the harness output');
  }
  return {
    harnessCommit,
    harnessVersion: CODE_MEMORY_LINK_HARNESS_VERSION,
    invocationDigest,
    invocationNonce,
    outputDigest,
    postRuntime,
    preRuntime,
    summaryDigest,
  };
}

/** Parse the self-consistent runtime identity before a higher-level manifest supplies the expected candidate. */
export function codeMemoryLinkCandidateFromAttestation(value: unknown): CodeMemoryLinkCandidateIdentityV1 {
  const attestation = record(value, 'invocation attestation');
  const preRuntime = parseRuntime(attestation.preRuntime, 'pre-run runtime');
  const postRuntime = parseRuntime(attestation.postRuntime, 'post-run runtime');
  if (JSON.stringify(preRuntime) !== JSON.stringify(postRuntime)) {
    invalid('pre-run and post-run runtime identities differ');
  }
  return {buildIdentityHash: preRuntime.executableSha256, commit: preRuntime.sourceCommit, dirty: false};
}

export function assertUniqueCodeMemoryLinkAttestations(
  attestations: readonly CodeMemoryLinkInvocationAttestationV1[],
  label: string,
): void {
  unique(
    EffectArray.map(attestations, value => value.invocationNonce),
    `${label} invocation nonces`,
  );
  unique(
    EffectArray.map(attestations, value => value.invocationDigest),
    `${label} invocation digests`,
  );
  unique(
    EffectArray.map(attestations, value => value.outputDigest),
    `${label} output digests`,
  );
  unique(
    EffectArray.map(attestations, value => value.summaryDigest),
    `${label} summary digests`,
  );
}

function parseCandidate(value: unknown): CodeMemoryLinkCandidateIdentityV1 {
  const candidate = record(value, 'candidate identity');
  exactKeys(candidate, ['buildIdentityHash', 'commit', 'dirty'], 'candidate identity');
  if (candidate.dirty !== false) invalid('candidate identity must be clean');
  return {
    buildIdentityHash: matching(candidate.buildIdentityHash, HASH, 'candidate executable digest'),
    commit: matching(candidate.commit, COMMIT, 'candidate commit'),
    dirty: false,
  };
}

function parseRuntime(value: unknown, label: string): CodeMemoryLinkRuntimeIdentityV1 {
  const runtime = record(value, label);
  exactKeys(runtime, ['executableSha256', 'sourceCommit'], label);
  return {
    executableSha256: matching(runtime.executableSha256, HASH, `${label} executable digest`),
    sourceCommit: matching(runtime.sourceCommit, COMMIT, `${label} source commit`),
  };
}

function assertRuntime(
  candidate: CodeMemoryLinkCandidateIdentityV1,
  runtime: CodeMemoryLinkRuntimeIdentityV1,
  label: string,
): void {
  if (candidate.commit !== runtime.sourceCommit || candidate.buildIdentityHash !== runtime.executableSha256) {
    invalid(`${label} does not match the exact candidate executable`);
  }
}

function digest(value: unknown): string {
  return sha256HexSync(`${JSON.stringify(value)}\n`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = EffectRecord.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || EffectArray.some(actual, (key, index) => key !== expected[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length)
    invalid(`${label} must be unique; replayed harness receipts are rejected`);
}

function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link harness attestation: ${message}.`);
}
