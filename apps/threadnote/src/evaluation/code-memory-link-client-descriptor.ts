import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_MEMORY_LINK_CLIENT_DESCRIPTOR_VERSION = 2 as const;

export interface CodeMemoryLinkClientArtifactBindingV2 {
  readonly pathDigest: string;
  readonly role: string;
  readonly sha256: string;
}

/** Complete, role-preserving identity for the executable evaluation client. */
export interface CodeMemoryLinkClientImplementationDescriptorV1 {
  readonly argumentVectorHash: string;
  readonly artifactBindings: readonly CodeMemoryLinkClientArtifactBindingV2[];
  readonly binaryBindings: readonly CodeMemoryLinkClientArtifactBindingV2[];
  readonly configurationHash: string;
  readonly configurationProjectionHash: string;
  readonly dependenciesLockHash: string;
  readonly entrypointHash: string;
  readonly environmentPolicyHash: string;
  readonly executionBundleHash: string;
  readonly expectedClientProjectionHash: string;
  readonly version: typeof CODE_MEMORY_LINK_CLIENT_DESCRIPTOR_VERSION;
}

const HASH = /^[0-9a-f]{64}$/u;
const ROLE = /^[a-z][a-z0-9-]{0,63}$/u;

export function codeMemoryLinkClientArgumentVectorHash(arguments_: readonly string[]): string {
  if (!EffectArray.isArray(arguments_) || EffectArray.some(arguments_, value => typeof value !== 'string')) {
    invalid('client argument vector must contain only strings');
  }
  return digest(arguments_);
}

export function codeMemoryLinkClientPathDigest(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || Effect.pipe(path, EffectString.includes('\0')))
    invalid('client artifact path is invalid');
  return digest({path});
}

export function codeMemoryLinkClientProjectionHash(domain: string, value: unknown): string {
  if (!ROLE.test(domain)) invalid('client projection domain is invalid');
  return digest({domain, value});
}

export function codeMemoryLinkClientImplementationDescriptorHash(value: unknown): string {
  return digest(parseCodeMemoryLinkClientImplementationDescriptorV1(value));
}

export function assertCodeMemoryLinkClientImplementationBinding(input: {
  readonly clientId: string;
  readonly descriptor: unknown;
  readonly roster: readonly {readonly clientId: string; readonly implementationDescriptorHash: string}[];
}): string {
  const descriptorHash = codeMemoryLinkClientImplementationDescriptorHash(input.descriptor);
  const rosterHashes = EffectArray.map(input.roster, entry =>
    matchingHash(entry.implementationDescriptorHash, 'roster descriptor'),
  );
  if (new Set(rosterHashes).size !== rosterHashes.length) invalid('roster descriptor hashes must be unique');
  const matchingClients = EffectArray.filter(input.roster, entry => entry.clientId === input.clientId);
  if (matchingClients.length !== 1) invalid('client id must identify exactly one roster entry');
  if (matchingClients[0].implementationDescriptorHash !== descriptorHash) {
    invalid('invoked implementation descriptor does not match the selected client id');
  }
  return descriptorHash;
}

export function parseCodeMemoryLinkClientImplementationDescriptorV1(
  value: unknown,
): CodeMemoryLinkClientImplementationDescriptorV1 {
  const descriptor = record(value);
  const expected = [
    'argumentVectorHash',
    'artifactBindings',
    'binaryBindings',
    'configurationHash',
    'configurationProjectionHash',
    'dependenciesLockHash',
    'entrypointHash',
    'environmentPolicyHash',
    'executionBundleHash',
    'expectedClientProjectionHash',
    'version',
  ].sort();
  const keys = EffectRecord.keys(descriptor).sort();
  if (keys.length !== expected.length || EffectArray.some(keys, (key, index) => key !== expected[index])) {
    invalid('client descriptor has unsupported or missing fields');
  }
  if (descriptor.version !== CODE_MEMORY_LINK_CLIENT_DESCRIPTOR_VERSION) {
    invalid(`client descriptor version must be ${CODE_MEMORY_LINK_CLIENT_DESCRIPTOR_VERSION}`);
  }
  const artifactBindings = bindings(descriptor.artifactBindings, 'artifact');
  const binaryBindings = bindings(descriptor.binaryBindings, 'binary');
  const clientBundle = exactlyOneRole(artifactBindings, 'client-bundle');
  const entrypoint = exactlyOneRole(artifactBindings, 'client-entrypoint');
  exactlyOneRole(artifactBindings, 'proxy-bundle');
  exactlyOneRole(binaryBindings, 'client-runtime');
  exactlyOneRole(binaryBindings, 'codex-app-server');
  exactlyOneRole(binaryBindings, 'git');
  const executionBundleHash = matchingHash(descriptor.executionBundleHash, 'execution bundle');
  const entrypointHash = matchingHash(descriptor.entrypointHash, 'entrypoint');
  if (clientBundle.sha256 !== executionBundleHash) invalid('execution bundle hash differs from its role binding');
  if (entrypoint.sha256 !== entrypointHash) invalid('entrypoint hash differs from its role binding');
  return {
    argumentVectorHash: matchingHash(descriptor.argumentVectorHash, 'argument vector'),
    artifactBindings,
    binaryBindings,
    configurationHash: matchingHash(descriptor.configurationHash, 'configuration'),
    configurationProjectionHash: matchingHash(descriptor.configurationProjectionHash, 'configuration projection'),
    dependenciesLockHash: matchingHash(descriptor.dependenciesLockHash, 'dependency lock'),
    entrypointHash,
    environmentPolicyHash: matchingHash(descriptor.environmentPolicyHash, 'environment policy'),
    executionBundleHash,
    expectedClientProjectionHash: matchingHash(descriptor.expectedClientProjectionHash, 'expected client projection'),
    version: CODE_MEMORY_LINK_CLIENT_DESCRIPTOR_VERSION,
  };
}

function bindings(value: unknown, label: string): readonly CodeMemoryLinkClientArtifactBindingV2[] {
  if (!EffectArray.isArray(value) || value.length === 0 || value.length > 64) {
    invalid(`client ${label} bindings must be a bounded non-empty array`);
  }
  const parsed = EffectArray.map(value, (entry, index) => {
    const binding = record(entry);
    const keys = EffectRecord.keys(binding).sort();
    if (keys.length !== 3 || keys[0] !== 'pathDigest' || keys[1] !== 'role' || keys[2] !== 'sha256') {
      invalid(`client ${label} binding ${index + 1} has unsupported or missing fields`);
    }
    return {
      pathDigest: matchingHash(binding.pathDigest, `${label} binding path`),
      role: matchingRole(binding.role, `${label} binding role`),
      sha256: matchingHash(binding.sha256, `${label} binding`),
    };
  });
  if (EffectArray.some(parsed, (entry, index) => index > 0 && parsed[index - 1].role >= entry.role)) {
    invalid(`client ${label} bindings must have unique roles in canonical order`);
  }
  if (new Set(EffectArray.map(parsed, entry => entry.pathDigest)).size !== parsed.length) {
    invalid(`client ${label} binding paths must be unique`);
  }
  return parsed;
}

function exactlyOneRole(
  bindings: readonly CodeMemoryLinkClientArtifactBindingV2[],
  role: string,
): CodeMemoryLinkClientArtifactBindingV2 {
  const matching = EffectArray.filter(bindings, binding => binding.role === role);
  if (matching.length !== 1) invalid(`client descriptor requires exactly one ${role} binding`);
  return matching[0];
}

function digest(value: unknown): string {
  return sha256HexSync(`${JSON.stringify(value)}\n`);
}

function record(value: unknown): Record<string, unknown> {
  if (!Predicate.isObject(value)) {
    invalid('client descriptor must be an object');
  }
  return value;
}

function matchingHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid(`${label} hash is invalid`);
  return value;
}

function matchingRole(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ROLE.test(value)) invalid(`${label} is invalid`);
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link client implementation descriptor: ${message}.`);
}
