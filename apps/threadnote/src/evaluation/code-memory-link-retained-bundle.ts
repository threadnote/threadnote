import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_MEMORY_LINK_RETAINED_BUNDLE_VERSION = 1 as const;
export const CODE_MEMORY_LINK_RETAINED_BUNDLE_TYPE = 'code-memory-link-retained-evidence-bundle' as const;
export const CODE_MEMORY_LINK_RETAINED_BUNDLE_CLAIM =
  'retained-local-cryptographic-consistency-not-hostile-local-author-authentication' as const;
export const CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT =
  'apps/threadnote/test/evaluation/retained/code-memory-link' as const;

export const CODE_MEMORY_LINK_RETAINED_ARTIFACT_ROLES = [
  'assignment',
  'attempts',
  'dogfood',
  'evidence',
  'manifest',
  'result',
  'sealedLayout',
  'sealedSuite',
  'trials',
] as const;

export type CodeMemoryLinkRetainedArtifactRole = (typeof CODE_MEMORY_LINK_RETAINED_ARTIFACT_ROLES)[number];

export interface CodeMemoryLinkRetainedBundleClientV1 {
  readonly clientId: string;
  readonly configProjection: string;
  readonly descriptor: string;
}

export interface CodeMemoryLinkRetainedBundleBlobV1 {
  readonly byteLength: number;
  readonly path: string;
  readonly sha256: string;
}

export interface CodeMemoryLinkRetainedBundleSealedFileV1 {
  readonly path: string;
  readonly sha256: string;
}

export interface CodeMemoryLinkRetainedBundleIndexV1 {
  readonly artifacts: Readonly<Record<CodeMemoryLinkRetainedArtifactRole, string>>;
  readonly blobs: readonly CodeMemoryLinkRetainedBundleBlobV1[];
  readonly candidateCommit: string;
  readonly claim: typeof CODE_MEMORY_LINK_RETAINED_BUNDLE_CLAIM;
  readonly clients: readonly CodeMemoryLinkRetainedBundleClientV1[];
  readonly sealedFiles: readonly CodeMemoryLinkRetainedBundleSealedFileV1[];
  readonly type: typeof CODE_MEMORY_LINK_RETAINED_BUNDLE_TYPE;
  readonly version: typeof CODE_MEMORY_LINK_RETAINED_BUNDLE_VERSION;
}

export interface CodeMemoryLinkRetainedBundleBuildV1 {
  readonly blobs: ReadonlyMap<string, string>;
  readonly bundleHash: string;
  readonly index: CodeMemoryLinkRetainedBundleIndexV1;
  readonly indexContent: string;
}

export interface CodeMemoryLinkRetainedBundleContentsV1 {
  readonly artifacts: Readonly<Record<CodeMemoryLinkRetainedArtifactRole, string>>;
  readonly clients: readonly {
    readonly clientId: string;
    readonly configProjection: string;
    readonly descriptor: string;
  }[];
  readonly index: CodeMemoryLinkRetainedBundleIndexV1;
  readonly sealedFiles: readonly {readonly content: string; readonly path: string}[];
}

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const CLIENT_ID = /^cli_[0-9a-f]{16,64}$/u;
const MAXIMUM_BLOB_BYTES = 32 * 1_024 * 1_024;
const MAXIMUM_BUNDLE_BYTES = 128 * 1_024 * 1_024;
const MAXIMUM_PRIVACY_SCAN_NODES = 2_000_000;
const MAXIMUM_SEALED_FILES = 1_024;
const JSONL_ROLES = new Set<CodeMemoryLinkRetainedArtifactRole>(['attempts', 'evidence', 'trials']);

export function createCodeMemoryLinkRetainedBundleV1(input: {
  readonly artifacts: Readonly<Record<CodeMemoryLinkRetainedArtifactRole, string>>;
  readonly candidateCommit: string;
  readonly clients: readonly {
    readonly clientId: string;
    readonly configProjection: string;
    readonly descriptor: string;
  }[];
  readonly sealedFiles: readonly {readonly content: string; readonly path: string}[];
}): CodeMemoryLinkRetainedBundleBuildV1 {
  const candidateCommit = matching(input.candidateCommit, COMMIT, 'candidate commit');
  const blobs = new Map<string, string>();
  const addBlob = (content: string, label: string, media: 'json' | 'jsonl' | 'text'): string => {
    assertPrivacySafeRetainedContent(content, label, media);
    const byteLength = utf8Length(content);
    if (byteLength > MAXIMUM_BLOB_BYTES) invalid(`${label} exceeds the per-blob byte limit`);
    const hash = sha256HexSync(content);
    const previous = blobs.get(hash);
    if (previous !== undefined && previous !== content) invalid(`${label} collided with another retained blob`);
    blobs.set(hash, content);
    return hash;
  };
  const artifacts = artifactRecord(role =>
    addBlob(input.artifacts[role], role, JSONL_ROLES.has(role) ? 'jsonl' : 'json'),
  );
  const clients = EffectArray.map(
    [...input.clients].sort((left, right) => compareText(left.clientId, right.clientId)),
    client => ({
      clientId: matching(client.clientId, CLIENT_ID, 'client id'),
      configProjection: addBlob(client.configProjection, `${client.clientId} config projection`, 'json'),
      descriptor: addBlob(client.descriptor, `${client.clientId} descriptor`, 'json'),
    }),
  );
  assertUnique(
    EffectArray.map(clients, client => client.clientId),
    'client ids',
  );
  if (clients.length < 2) invalid('bundle requires at least two client descriptor/config-projection pairs');
  const sealedFiles = EffectArray.map(
    [...input.sealedFiles].sort((left, right) => compareText(left.path, right.path)),
    file => {
      const path = safeSealedPath(file.path);
      return {
        path,
        sha256: addBlob(
          file.content,
          `sealed file ${path}`,
          Effect.pipe(path, EffectString.endsWith('.json')) ? 'json' : 'text',
        ),
      };
    },
  );
  if (sealedFiles.length === 0 || sealedFiles.length > MAXIMUM_SEALED_FILES) {
    invalid(`bundle requires 1 through ${MAXIMUM_SEALED_FILES} sealed files`);
  }
  assertUnique(
    EffectArray.map(sealedFiles, file => file.path),
    'sealed file paths',
  );
  const totalBytes = EffectArray.reduce([...blobs.values()], 0, (total, content) => total + utf8Length(content));
  if (totalBytes > MAXIMUM_BUNDLE_BYTES) invalid('bundle exceeds the aggregate byte limit');
  const index = canonicalIndex({
    artifacts,
    blobs: EffectArray.map([...blobs.entries()], ([sha256, content]) => ({
      byteLength: utf8Length(content),
      path: `blobs/${sha256}`,
      sha256,
    })).sort((left, right) => compareText(left.sha256, right.sha256)),
    candidateCommit,
    claim: CODE_MEMORY_LINK_RETAINED_BUNDLE_CLAIM,
    clients,
    sealedFiles,
    type: CODE_MEMORY_LINK_RETAINED_BUNDLE_TYPE,
    version: CODE_MEMORY_LINK_RETAINED_BUNDLE_VERSION,
  });
  const indexContent = `${JSON.stringify(index, undefined, 2)}\n`;
  return {blobs, bundleHash: sha256HexSync(indexContent), index, indexContent};
}

export function verifyCodeMemoryLinkRetainedBundleV1(input: {
  readonly blobs: ReadonlyMap<string, string>;
  readonly indexContent: string;
}): CodeMemoryLinkRetainedBundleContentsV1 {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.indexContent);
  } catch (cause) {
    invalid(`bundle index must be valid JSON (${String(cause)})`);
  }
  const index = parseCodeMemoryLinkRetainedBundleIndexV1(decoded);
  const canonical = `${JSON.stringify(index, undefined, 2)}\n`;
  if (canonical !== input.indexContent) invalid('bundle index must use the canonical JSON encoding');
  const expectedHashes = new Set(EffectArray.map(index.blobs, blob => blob.sha256));
  if (
    input.blobs.size !== expectedHashes.size ||
    EffectArray.some([...input.blobs.keys()], hash => !expectedHashes.has(hash))
  ) {
    invalid('blob map differs from the exact indexed blob set');
  }
  let totalBytes = 0;
  for (const blob of index.blobs) {
    const content = input.blobs.get(blob.sha256);
    if (content === undefined) invalid(`indexed blob ${blob.sha256} is missing`);
    const byteLength = utf8Length(content);
    totalBytes += byteLength;
    if (byteLength !== blob.byteLength || sha256HexSync(content) !== blob.sha256) {
      invalid(`indexed blob ${blob.sha256} differs from its byte length or SHA-256`);
    }
  }
  if (totalBytes > MAXIMUM_BUNDLE_BYTES) invalid('bundle exceeds the aggregate byte limit');
  const referenced = new Set<string>();
  const artifacts = artifactRecord(role => {
    const hash = index.artifacts[role];
    const content = requiredBlob(input.blobs, hash, role);
    referenced.add(hash);
    assertPrivacySafeRetainedContent(content, role, JSONL_ROLES.has(role) ? 'jsonl' : 'json');
    return content;
  });
  const clients = EffectArray.map(index.clients, client => {
    const descriptor = requiredBlob(input.blobs, client.descriptor, `${client.clientId} descriptor`);
    const configProjection = requiredBlob(input.blobs, client.configProjection, `${client.clientId} config projection`);
    referenced.add(client.descriptor);
    referenced.add(client.configProjection);
    assertPrivacySafeRetainedContent(descriptor, `${client.clientId} descriptor`, 'json');
    assertPrivacySafeRetainedContent(configProjection, `${client.clientId} config projection`, 'json');
    return {clientId: client.clientId, configProjection, descriptor};
  });
  const sealedFiles = EffectArray.map(index.sealedFiles, file => {
    const content = requiredBlob(input.blobs, file.sha256, `sealed file ${file.path}`);
    referenced.add(file.sha256);
    assertPrivacySafeRetainedContent(
      content,
      `sealed file ${file.path}`,
      Effect.pipe(file.path, EffectString.endsWith('.json')) ? 'json' : 'text',
    );
    return {content, path: file.path};
  });
  if (referenced.size !== expectedHashes.size || EffectArray.some([...expectedHashes], hash => !referenced.has(hash))) {
    invalid('bundle contains an unreferenced blob');
  }
  return {artifacts, clients, index, sealedFiles};
}

export function parseCodeMemoryLinkRetainedBundleIndexV1(value: unknown): CodeMemoryLinkRetainedBundleIndexV1 {
  const index = record(value, 'bundle index');
  exactKeys(
    index,
    ['artifacts', 'blobs', 'candidateCommit', 'claim', 'clients', 'sealedFiles', 'type', 'version'],
    'bundle index',
  );
  if (index.type !== CODE_MEMORY_LINK_RETAINED_BUNDLE_TYPE) invalid('bundle type is unsupported');
  if (index.version !== CODE_MEMORY_LINK_RETAINED_BUNDLE_VERSION) invalid('bundle version is unsupported');
  if (index.claim !== CODE_MEMORY_LINK_RETAINED_BUNDLE_CLAIM) invalid('bundle threat claim is unsupported');
  const artifactsInput = record(index.artifacts, 'artifact map');
  exactKeys(artifactsInput, [...CODE_MEMORY_LINK_RETAINED_ARTIFACT_ROLES], 'artifact map');
  const artifacts = artifactRecord(role => matchingHash(artifactsInput[role], role));
  if (!EffectArray.isArray(index.blobs) || index.blobs.length === 0) invalid('blob map must be a non-empty array');
  const blobs = EffectArray.map(index.blobs, (value, position) => {
    const blob = record(value, `blob ${position + 1}`);
    exactKeys(blob, ['byteLength', 'path', 'sha256'], `blob ${position + 1}`);
    const sha256 = matchingHash(blob.sha256, `blob ${position + 1}`);
    const byteLength = boundedInteger(blob.byteLength, `blob ${position + 1} byte length`, 1, MAXIMUM_BLOB_BYTES);
    if (blob.path !== `blobs/${sha256}`) invalid(`blob ${position + 1} path is not content-addressed`);
    return {byteLength, path: blob.path, sha256};
  });
  assertUnique(
    EffectArray.map(blobs, blob => blob.sha256),
    'blob hashes',
  );
  if (EffectArray.some(blobs, (blob, index) => index > 0 && blob.sha256 <= blobs[index - 1].sha256)) {
    invalid('blob map must use canonical SHA-256 order');
  }
  if (!EffectArray.isArray(index.clients) || index.clients.length < 2) {
    invalid('bundle requires at least two client descriptor/config-projection pairs');
  }
  const clients = EffectArray.map(index.clients, (value, position) => {
    const client = record(value, `client ${position + 1}`);
    exactKeys(client, ['clientId', 'configProjection', 'descriptor'], `client ${position + 1}`);
    return {
      clientId: matching(client.clientId, CLIENT_ID, `client ${position + 1} id`),
      configProjection: matchingHash(client.configProjection, `client ${position + 1} config projection`),
      descriptor: matchingHash(client.descriptor, `client ${position + 1} descriptor`),
    };
  });
  assertUnique(
    EffectArray.map(clients, client => client.clientId),
    'client ids',
  );
  if (EffectArray.some(clients, (client, index) => index > 0 && client.clientId <= clients[index - 1].clientId)) {
    invalid('clients must use canonical client-id order');
  }
  if (
    !EffectArray.isArray(index.sealedFiles) ||
    index.sealedFiles.length === 0 ||
    index.sealedFiles.length > MAXIMUM_SEALED_FILES
  ) {
    invalid(`bundle requires 1 through ${MAXIMUM_SEALED_FILES} sealed files`);
  }
  const sealedFiles = EffectArray.map(index.sealedFiles, (value, position) => {
    const file = record(value, `sealed file ${position + 1}`);
    exactKeys(file, ['path', 'sha256'], `sealed file ${position + 1}`);
    return {
      path: safeSealedPath(file.path),
      sha256: matchingHash(file.sha256, `sealed file ${position + 1}`),
    };
  });
  assertUnique(
    EffectArray.map(sealedFiles, file => file.path),
    'sealed file paths',
  );
  if (EffectArray.some(sealedFiles, (file, index) => index > 0 && file.path <= sealedFiles[index - 1].path)) {
    invalid('sealed files must use canonical path order');
  }
  const knownHashes = new Set(EffectArray.map(blobs, blob => blob.sha256));
  const references = [
    ...EffectRecord.values(artifacts),
    ...EffectArray.flatMap(clients, client => [client.configProjection, client.descriptor]),
    ...EffectArray.map(sealedFiles, file => file.sha256),
  ];
  if (EffectArray.some(references, hash => !knownHashes.has(hash))) {
    invalid('artifact, client, or sealed file references an absent blob');
  }
  return canonicalIndex({
    artifacts,
    blobs,
    candidateCommit: matching(index.candidateCommit, COMMIT, 'candidate commit'),
    claim: CODE_MEMORY_LINK_RETAINED_BUNDLE_CLAIM,
    clients,
    sealedFiles,
    type: CODE_MEMORY_LINK_RETAINED_BUNDLE_TYPE,
    version: CODE_MEMORY_LINK_RETAINED_BUNDLE_VERSION,
  });
}

export function codeMemoryLinkRetainedBundleHashV1(indexContent: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(indexContent);
  } catch (cause) {
    invalid(`bundle index must be valid JSON (${String(cause)})`);
  }
  const index = parseCodeMemoryLinkRetainedBundleIndexV1(decoded);
  if (`${JSON.stringify(index, undefined, 2)}\n` !== indexContent) {
    invalid('bundle index must use the canonical JSON encoding');
  }
  return sha256HexSync(indexContent);
}

export function assertPrivacySafeRetainedContent(
  content: string,
  label: string,
  media: 'json' | 'jsonl' | 'text',
): void {
  if (typeof content !== 'string' || content.length === 0 || Effect.pipe(content, EffectString.includes('\u0000'))) {
    invalid(`${label} must be non-empty UTF-8-compatible text`);
  }
  if (media === 'text') {
    if (containsSensitiveAbsolutePath(content) || containsSecretShapedValue(content)) {
      invalid(`${label} contains an absolute path or credential-shaped content`);
    }
    return;
  }
  const values: unknown[] = [];
  if (media === 'json') {
    try {
      values.push(JSON.parse(content));
    } catch (cause) {
      invalid(`${label} must be valid JSON (${String(cause)})`);
    }
  } else {
    const lines = EffectArray.filter(Effect.pipe(content, EffectString.split(/\r?\n/u)), line => line.length > 0);
    if (lines.length === 0) invalid(`${label} must contain at least one JSONL record`);
    for (const [index, line] of lines.entries()) {
      try {
        values.push(JSON.parse(line));
      } catch (cause) {
        invalid(`${label} JSONL record ${index + 1} is invalid (${String(cause)})`);
      }
    }
  }
  const state = {nodes: 0};
  for (const value of values) scanPrivacy(value, label, state, 0);
}

function scanPrivacy(value: unknown, label: string, state: {nodes: number}, depth: number): void {
  state.nodes += 1;
  if (state.nodes > MAXIMUM_PRIVACY_SCAN_NODES || depth > 64) invalid(`${label} exceeds the privacy scan bound`);
  if (typeof value === 'string') {
    if (containsAbsolutePath(value)) invalid(`${label} contains an absolute path`);
    if (containsSecretShapedValue(value)) invalid(`${label} contains credential-shaped content`);
    return;
  }
  if (EffectArray.isArray(value)) {
    for (const item of value) scanPrivacy(item, label, state, depth + 1);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, item] of EffectRecord.toEntries(value)) {
    if (secretShapedKey(key)) invalid(`${label} contains forbidden credential/auth configuration field ${key}`);
    scanPrivacy(item, label, state, depth + 1);
  }
}

function containsAbsolutePath(value: string): boolean {
  return (
    /(?:^|[\s"'(=:])\/(?!\/)[A-Za-z0-9._~-]+(?:\/[^\s"'<>]*)?/u.test(value) ||
    /(?:^|[\s"'(=:])[A-Za-z]:[\\/][^\s"'<>]*/u.test(value) ||
    /(?:^|[\s"'(=:])\\\\[^\s"'<>]+/u.test(value) ||
    /(?:^|[\s"'(=:])file:\/\//iu.test(value) ||
    /(?:^|[\s"'(=:])~\//u.test(value)
  );
}

function containsSecretShapedValue(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) ||
    /(?:^|\s)Bearer\s+[A-Za-z0-9._~+/=-]{12,}/iu.test(value) ||
    /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/u.test(value) ||
    /(?:^|[^A-Za-z0-9])(?:ghp_|github_pat_)[A-Za-z0-9_]{16,}/u.test(value) ||
    /(?:^|[^A-Z0-9])AKIA[A-Z0-9]{16}(?:$|[^A-Z0-9])/u.test(value)
  );
}

function containsSensitiveAbsolutePath(value: string): boolean {
  const withoutPortableInterpreterShebang = Effect.pipe(
    value,
    EffectString.replace(/^#!\/usr\/bin\/env (?:bun|node)\r?\n/u, ''),
  );
  return containsAbsolutePath(withoutPortableInterpreterShebang);
}

function secretShapedKey(key: string): boolean {
  const normalized = Effect.pipe(key, EffectString.toLowerCase, EffectString.replace(/[^a-z0-9]/gu, ''));
  return [
    'accesstoken',
    'apikey',
    'auth',
    'authconfig',
    'authsource',
    'authsourcepath',
    'authorization',
    'credential',
    'credentials',
    'password',
    'passwd',
    'privatekey',
    'refreshtoken',
    'secret',
  ].includes(normalized);
}

function canonicalIndex(index: CodeMemoryLinkRetainedBundleIndexV1): CodeMemoryLinkRetainedBundleIndexV1 {
  return {
    artifacts: artifactRecord(role => index.artifacts[role]),
    blobs: index.blobs,
    candidateCommit: index.candidateCommit,
    claim: CODE_MEMORY_LINK_RETAINED_BUNDLE_CLAIM,
    clients: index.clients,
    sealedFiles: index.sealedFiles,
    type: CODE_MEMORY_LINK_RETAINED_BUNDLE_TYPE,
    version: CODE_MEMORY_LINK_RETAINED_BUNDLE_VERSION,
  };
}

function safeSealedPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    Effect.pipe(value, EffectString.includes('\\')) ||
    Effect.pipe(value, EffectString.startsWith('/')) ||
    !/^(?:artifacts|tasks)\/[A-Za-z0-9._/-]+$/u.test(value) ||
    EffectArray.some(
      Effect.pipe(value, EffectString.split('/')),
      part => part.length === 0 || part === '.' || part === '..',
    )
  ) {
    invalid('sealed file path must be a safe relative artifacts/ or tasks/ path');
  }
  return value;
}

function requiredBlob(blobs: ReadonlyMap<string, string>, hash: string, label: string): string {
  const content = blobs.get(hash);
  if (content === undefined) invalid(`${label} blob is missing`);
  return content;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = EffectRecord.keys(value).sort(compareText);
  const sortedExpected = [...expected].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    invalid(`${label} must contain exactly: ${EffectArray.join(sortedExpected, ', ')}`);
  }
}

function matchingHash(value: unknown, label: string): string {
  return matching(value, HASH, `${label} SHA-256`);
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function artifactRecord(
  valueFor: (role: CodeMemoryLinkRetainedArtifactRole) => string,
): Record<CodeMemoryLinkRetainedArtifactRole, string> {
  return {
    assignment: valueFor('assignment'),
    attempts: valueFor('attempts'),
    dogfood: valueFor('dogfood'),
    evidence: valueFor('evidence'),
    manifest: valueFor('manifest'),
    result: valueFor('result'),
    sealedLayout: valueFor('sealedLayout'),
    sealedSuite: valueFor('sealedSuite'),
    trials: valueFor('trials'),
  };
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function utf8Length(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link retained evidence bundle: ${message}.`);
}
