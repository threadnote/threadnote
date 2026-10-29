import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {codeGraphInventoryReuseContract, readCodeGraphInventoryReuseEnvironment} from './inventory/reuse.js';
import type {CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import type {CodeGraphLayout} from './layout.js';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from './index_scope.js';
import {codeGraphScopeIdentityCompatible, codeGraphScopeViewKey} from './scope/identity.js';
import type {CodeGraphSnapshot, RepositoryIdentity} from './types.js';

const hash = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)));
const scopeEvidenceSchema = Schema.Struct({
  scopeKey: Schema.String.pipe(Schema.check(Schema.isPattern(/^code-graph-scope:[0-9a-f]{64}$/u))),
  definitionDigest: hash,
  closureDigest: hash,
  inventoryFingerprint: hash,
  observedCommit: Schema.String.pipe(Schema.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u))),
  scopedOverlayFingerprint: Schema.optional(hash),
});
/** A verified observation of one scope at a local worktree's current commit. */
export type CodeGraphScopeAdmissionEvidence = typeof scopeEvidenceSchema.Type;

const receiptFields = {
  contract: hash,
  environmentFingerprint: hash,
  includeOpaqueCorpusAssets: Schema.Boolean,
  repositoryId: hash,
  snapshotId: Schema.String,
  worktreeId: hash,
};
const legacyReceiptSchema = Schema.Struct({...receiptFields, version: Schema.Literal(1)});
const currentReceiptSchema = Schema.Struct({
  ...receiptFields,
  extractorSet: Schema.String,
  scopeKey: Schema.String,
  scope: Schema.optional(scopeEvidenceSchema),
  version: Schema.Literal(2),
});
const receiptSchema = Schema.Union([legacyReceiptSchema, currentReceiptSchema]);
type AdmissionReceipt = typeof receiptSchema.Type;

class CodeGraphAdmissionError extends Schema.TaggedError<CodeGraphAdmissionError, {readonly brand: unique symbol}>()(
  'CodeGraphAdmissionError',
  {
    message: Schema.String,
  },
) {}

export function codeGraphSnapshotAdmissionReceiptPath(
  path: Path.Path,
  layout: CodeGraphLayout,
  worktreeId: string,
  clean = false,
  scopeKey: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
): string {
  return path.join(
    layout.repositoryRoot,
    'admission',
    `${codeGraphScopeViewKey(worktreeId, scopeKey)}${clean ? '.clean' : ''}.json`,
  );
}

/** Missing cache evidence can deny freshness, but never substitutes for a ready SQLite snapshot. */
const readReceipt = Effect.fn('codeGraph.readAdmissionReceipt')(function* (
  layout: CodeGraphLayout,
  worktreeId: string,
  clean = false,
  scopeKey: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
) {
  if (!/^[0-9a-f]{64}$/u.test(worktreeId)) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = codeGraphSnapshotAdmissionReceiptPath(path, layout, worktreeId, clean, scopeKey);
  for (const file of [path.dirname(target), target]) {
    if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return undefined;
  }
  const info = yield* fs.stat(target);
  if (info.type !== 'File' || Number(info.size) > 4_096) return undefined;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(target, {flag: 'r'});
      const bytes = new Uint8Array(4_097);
      let length = 0;
      while (length < bytes.length) {
        const count = Number(yield* file.read(bytes.subarray(length)));
        if (count === 0) break;
        length += count;
      }
      if (length > 4_096) return undefined;
      const parsed = yield* Effect.try(() =>
        JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, length))),
      );
      return Option.getOrUndefined(Schema.decodeUnknownOption(receiptSchema, {onExcessProperty: 'error'})(parsed));
    }),
  );
});

export const codeGraphSnapshotAdmissionCurrent = Effect.fn('codeGraph.snapshotAdmissionCurrent')(function* (
  layout: CodeGraphLayout,
  snapshot: CodeGraphSnapshot,
  environmentFingerprint: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  producingWorktree = false,
  scope?: CodeGraphScopeAdmissionEvidence,
) {
  const worktreeId = producingWorktree ? snapshot.worktreeId : layout.worktreeId;
  return (
    (yield* matchingReceipt(
      layout,
      worktreeId,
      snapshot,
      environmentFingerprint,
      languagePacks,
      producingWorktree,
      scope,
    )) !== undefined
  );
});

const matchingReceipt = Effect.fn('codeGraph.matchingAdmissionReceipt')(function* (
  layout: CodeGraphLayout,
  worktreeId: string,
  snapshot: CodeGraphSnapshot,
  environment: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  includeClean: boolean,
  scope: CodeGraphScopeAdmissionEvidence | undefined,
) {
  if (scope !== undefined && Option.isNone(Schema.decodeOption(scopeEvidenceSchema)(scope))) return undefined;
  for (const clean of includeClean && !snapshot.dirty ? [false, true] : [false]) {
    const receipt = yield* readReceipt(layout, worktreeId, clean, scope?.scopeKey).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (receiptMatches(receipt, worktreeId, snapshot, environment, languagePacks, scope)) return receipt;
  }
  return undefined;
});

function receiptMatches(
  receipt: AdmissionReceipt | undefined,
  worktreeId: string,
  snapshot: CodeGraphSnapshot,
  environmentFingerprint: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  scope: CodeGraphScopeAdmissionEvidence | undefined,
): boolean {
  return (
    receipt !== undefined &&
    receipt.worktreeId === worktreeId &&
    receipt.repositoryId === snapshot.repositoryId &&
    receipt.snapshotId === snapshot.id &&
    receipt.environmentFingerprint === environmentFingerprint &&
    receipt.contract === codeGraphInventoryReuseContract(languagePacks, receipt.includeOpaqueCorpusAssets) &&
    (receipt.version === 1
      ? scope === undefined
      : receipt.extractorSet === snapshot.extractorSet &&
        receipt.scopeKey === (scope?.scopeKey ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY) &&
        codeGraphScopeIdentityCompatible(receipt.scope, scope) &&
        receipt.scope?.observedCommit === scope?.observedCommit &&
        receipt.scope?.inventoryFingerprint === scope?.inventoryFingerprint &&
        receipt.scope?.scopedOverlayFingerprint === scope?.scopedOverlayFingerprint)
  );
}

/** Caller owns target-worktree publication and has fenced the captured admission environment. */
export const recordCodeGraphSnapshotAdmission = Effect.fn('codeGraph.recordSnapshotAdmission')(function* (
  layout: CodeGraphLayout,
  snapshot: CodeGraphSnapshot,
  environmentFingerprint: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  includeOpaqueCorpusAssets: boolean,
  options?: {readonly cleanOnly?: boolean; readonly scope?: CodeGraphScopeAdmissionEvidence},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  if (options?.cleanOnly && snapshot.dirty) {
    return yield* CodeGraphAdmissionError.make({message: 'Dirty snapshots cannot establish clean-base admission.'});
  }
  if (!/^[0-9a-f]{64}$/u.test(layout.worktreeId)) {
    return yield* CodeGraphAdmissionError.make({message: 'Invalid graph admission worktree identity.'});
  }
  const scope =
    options?.scope === undefined
      ? undefined
      : Option.getOrUndefined(Schema.decodeOption(scopeEvidenceSchema)(options.scope));
  if (options?.scope !== undefined && scope === undefined) {
    return yield* CodeGraphAdmissionError.make({message: 'Invalid graph admission scope applicability evidence.'});
  }
  const target = codeGraphSnapshotAdmissionReceiptPath(path, layout, layout.worktreeId, false, scope?.scopeKey);
  const directory = path.dirname(target);
  yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option))) {
    return yield* CodeGraphAdmissionError.make({message: 'Graph admission directory must not be a symbolic link.'});
  }
  const receipt: AdmissionReceipt = {
    contract: codeGraphInventoryReuseContract(languagePacks, includeOpaqueCorpusAssets),
    environmentFingerprint,
    includeOpaqueCorpusAssets,
    repositoryId: snapshot.repositoryId,
    snapshotId: snapshot.id,
    extractorSet: snapshot.extractorSet,
    scopeKey: scope?.scopeKey ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
    ...(scope === undefined ? {} : {scope}),
    version: 2,
    worktreeId: layout.worktreeId,
  };
  const encoded = `${JSON.stringify(receipt)}\n`;
  if (
    Option.isNone(Schema.decodeOption(currentReceiptSchema)(receipt)) ||
    new TextEncoder().encode(encoded).length > 4_096
  ) {
    return yield* CodeGraphAdmissionError.make({message: 'Invalid or oversized graph admission evidence.'});
  }
  // Retain the last verified clean base while its producer works on a dirty overlay.
  // Two bounded files per worktree and scope avoid retaining proof for every historical snapshot.
  for (const clean of options?.cleanOnly ? [true] : snapshot.dirty ? [false] : [false, true]) {
    const destination = codeGraphSnapshotAdmissionReceiptPath(path, layout, layout.worktreeId, clean, scope?.scopeKey);
    const temporary = `${destination}.${yield* crypto.randomUUIDv4()}.tmp`;
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(temporary, encoded, {flag: 'wx', mode: 0o600});
      yield* fs.rename(temporary, destination);
    }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  }
});

export const observeCodeGraphAdmissionEnvironment = Effect.fn('codeGraph.observeAdmissionEnvironment')(function* (
  identity: RepositoryIdentity,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (yield* readCodeGraphInventoryReuseEnvironment(identity, fs, path)).fingerprint;
});

export const codeGraphSnapshotAdmissionCurrentForIdentity = Effect.fn('codeGraph.snapshotAdmissionCurrentForIdentity')(
  function* (
    layout: CodeGraphLayout,
    snapshot: CodeGraphSnapshot,
    identity: RepositoryIdentity,
    languagePacks: CodeGraphLanguagePackRegistryShape,
    producingWorktree = false,
    scope?: CodeGraphScopeAdmissionEvidence,
  ) {
    if (scope !== undefined && scope.observedCommit !== identity.headCommit) return false;
    const environment = yield* observeCodeGraphAdmissionEnvironment(identity);
    return yield* codeGraphSnapshotAdmissionCurrent(
      layout,
      snapshot,
      environment,
      languagePacks,
      producingWorktree,
      scope,
    );
  },
);

export const adoptCodeGraphSnapshotAdmission = Effect.fn('codeGraph.adoptSnapshotAdmission')(function* (
  layout: CodeGraphLayout,
  snapshot: CodeGraphSnapshot,
  identity: RepositoryIdentity,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  scope?: CodeGraphScopeAdmissionEvidence,
) {
  if (scope !== undefined && scope.observedCommit !== identity.headCommit) return false;
  const environment = yield* observeCodeGraphAdmissionEnvironment(identity);
  const receipt = yield* matchingReceipt(
    layout,
    snapshot.worktreeId,
    snapshot,
    environment,
    languagePacks,
    true,
    scope,
  );
  if (receipt === undefined) return false;
  yield* recordCodeGraphSnapshotAdmission(
    layout,
    snapshot,
    environment,
    languagePacks,
    receipt.includeOpaqueCorpusAssets,
    {scope},
  );
  return true;
});
