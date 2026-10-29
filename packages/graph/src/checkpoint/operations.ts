import {Array as EffectArray} from 'effect';
import {checkpointTerminalText} from './terminal_text.js';
import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runBinaryCommandEffect, runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {codeGraphCommittedContentHash} from '@threadnote/graph/content_identity';
import {CodeGraphIndexer, codeGraphDirectPersistentCapacityProtector} from '@threadnote/graph/indexer';
import {withCodeGraphProcessLock} from '@threadnote/graph/indexer/build';
import type {DirectPersistentCapacityProtection} from '@threadnote/graph/indexer/types';
import {
  CodeGraphLanguagePackRegistry,
  type CodeGraphLanguagePackRegistryShape,
} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {
  observeCleanRepositoryWorktree,
  resolveRepositoryIdentity,
  revalidateRepositoryIdentityFence,
} from '@threadnote/graph/repository';
import {
  CodeGraphStore,
  hydrateCodeGraphCheckpointReusableBaseReceipt,
  type CodeGraphCheckpointImportReceiptInput,
} from '@threadnote/graph/store';
import {CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION} from '@threadnote/graph/store/schema/revision';
import type {CodeGraphSnapshot, RepositoryIdentity} from '@threadnote/graph/types';
import {
  codeGraphCheckpointAbiInputV1,
  inspectCodeGraphCheckpointCompatibilityV1,
} from '@threadnote/graph/checkpoint/compatibility';
import {withCodeGraphCheckpointAuthorityVerification} from '@threadnote/graph/checkpoint/authority';
import {
  CODE_GRAPH_CHECKPOINT_PRELUDE_BYTES,
  CODE_GRAPH_CHECKPOINT_CHUNK_FRAME_HEADER_BYTES,
  CodeGraphCheckpointArtifactWriterV1,
  CodeGraphCheckpointStreamDecoderV1,
  CodeGraphCheckpointStreamEncoderV1,
  CodeGraphCheckpointStreamInspectorV1,
  codeGraphCheckpointReadPlanV1,
  type CodeGraphCheckpointInspectionV1,
  type CodeGraphCheckpointPreparedPackV1,
  type CodeGraphCheckpointVerifiedChunkV1,
} from '@threadnote/graph/checkpoint/pack';
import {
  codeGraphCheckpointGitPathBatches,
  parseGitTreeEntries,
  projectCodeGraphCheckpointV1,
} from '@threadnote/graph/checkpoint/projection';
import {
  CODE_GRAPH_CHECKPOINT_MEDIA_TYPE,
  type CodeGraphCheckpointDescriptorV1,
  type CodeGraphCheckpointFileRecordV1,
  type CodeGraphCheckpointHeaderV1,
  type CodeGraphCheckpointSha256,
} from '@threadnote/graph/checkpoint/schema';
import {prepareCodeGraphCheckpointReceiverAdmission} from '@threadnote/graph/checkpoint/receiver_admission';
import {recordCodeGraphSnapshotAdmission} from '@threadnote/graph/admission_freshness';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const CHECKPOINT_IO_CHUNK_BYTES = 64 * 1_024;
const CHECKPOINT_GIT_OUTPUT_BYTES_MAXIMUM = 16 * 1_024 * 1_024;
const CHECKPOINT_SNAPSHOT_DOMAIN = 'threadnote-code-graph-checkpoint-local-snapshot-v1\0';

export class CodeGraphCheckpointCommandError extends Schema.TaggedError<
  CodeGraphCheckpointCommandError,
  {readonly brand: unique symbol}
>()('CodeGraphCheckpointCommandError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export interface CodeGraphCheckpointArtifactOptions {
  readonly expectedDigest?: string;
  readonly input: string;
  readonly json?: boolean;
}

export interface CodeGraphCheckpointExportOptions {
  readonly cwd?: string;
  /** @internal Bind publication to the physical snapshot whose assembly was verified. */
  readonly expectedSnapshotId?: string;
  readonly json?: boolean;
  readonly output: string;
  readonly quiet?: boolean;
}

export interface CodeGraphCheckpointImportOptions extends CodeGraphCheckpointArtifactOptions {
  readonly cwd?: string;
  readonly followOnIndex?: boolean;
  readonly quiet?: boolean;
}

export interface CodeGraphCheckpointImportResultV1 {
  readonly artifact: CodeGraphCheckpointDescriptorV1;
  readonly imported: 'created' | 'reused';
  readonly logicalDigest: string;
  readonly publication: 'activated' | 'rebuilt' | 'stored';
  readonly snapshotId: string;
  readonly trust: CodeGraphCheckpointImportReceiptInput['trust'];
  readonly type: 'code-graph-checkpoint-import';
  readonly version: 1;
}

interface OpenCheckpointInput {
  readonly assertUnchanged: () => Effect.Effect<void, CodeGraphCheckpointCommandError>;
  readonly file: FileSystem.File;
  readonly path: string;
  readonly size: number;
}

interface OwnedFileIdentity {
  readonly birthtimeMilliseconds: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: number;
  readonly modifiedAtMilliseconds: number;
  readonly size: bigint;
}

export const runCodeGraphCheckpointInspect = Effect.fn('codeGraph.checkpoint.inspect')(function* (
  options: CodeGraphCheckpointArtifactOptions,
) {
  const inspection = yield* withCheckpointInput(options.input, input => inspectCheckpointInput(input, options));
  const result = {type: 'code-graph-checkpoint-inspection' as const, version: 1 as const, ...inspection};
  return result;
});

export const runCodeGraphCheckpointVerify = Effect.fn('codeGraph.checkpoint.verify')(function* (
  options: CodeGraphCheckpointArtifactOptions,
) {
  const result = yield* withCheckpointInput(options.input, input =>
    Effect.gen(function* () {
      const inspection = yield* inspectCheckpointInput(input, options);
      const verification = yield* withCodeGraphCheckpointAuthorityVerification(inspection.header, accept =>
        decodeCheckpointInput(input, inspection, chunk => accept(chunk.records)),
      );
      return {type: 'code-graph-checkpoint-verification' as const, version: 1 as const, ...verification};
    }),
  );
  return result;
});

export const runCodeGraphCheckpointExport = Effect.fn('codeGraph.checkpoint.export')(function* (
  config: RuntimeConfig,
  options: CodeGraphCheckpointExportOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const cwd = yield* checkpointCommandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
  const store = yield* CodeGraphStore;
  const snapshot = yield* store.readySnapshot(layout.databasePath, identity.worktreeId);
  if (
    snapshot === undefined ||
    (options.expectedSnapshotId !== undefined && snapshot.id !== options.expectedSnapshotId) ||
    snapshot.state !== 'ready' ||
    snapshot.dirty ||
    snapshot.commit !== identity.headCommit ||
    snapshot.graphContentId === undefined ||
    (yield* observeCleanRepositoryWorktree(identity.repoRoot)) === undefined
  ) {
    return yield* checkpointFailure(
      'Checkpoint export requires an exact clean ready root for the current commit. Run `threadnote graph index` after cleaning the worktree.',
    );
  }
  const provenance = yield* store.snapshotPackProvenance(layout.databasePath, snapshot.id);
  if (provenance === undefined) {
    return yield* checkpointFailure('The ready graph has no complete language-pack provenance receipt.');
  }
  const output = path.resolve(options.output);
  if (yield* fs.exists(output)) return yield* checkpointFailure(`Checkpoint output already exists: ${output}`);
  const parent = path.dirname(output);
  yield* fs.makeDirectory(parent, {recursive: true});
  const spoolPath = path.join(parent, `.${path.basename(output)}.${yield* crypto.randomUUIDv4()}.spool`);
  const artifact = yield* withPrivateSpool(spoolPath, spool =>
    Effect.gen(function* () {
      let encoder: CodeGraphCheckpointStreamEncoderV1 | undefined;
      yield* projectCodeGraphCheckpointV1({
        abi: codeGraphCheckpointAbiInputV1(provenance),
        databasePath: layout.databasePath,
        identity,
        snapshotId: snapshot.id,
        writeMetadata: metadata =>
          Effect.sync(() => {
            if (encoder !== undefined)
              throw CodeGraphCheckpointCommandError.make({message: 'Checkpoint metadata was emitted twice.'});
            encoder = new CodeGraphCheckpointStreamEncoderV1(metadata);
          }),
        writeRecords: records =>
          Effect.gen(function* () {
            if (encoder === undefined) {
              return yield* checkpointFailure('Checkpoint records were emitted before metadata.');
            }
            for (const record of records) {
              const emitted: Uint8Array[] = [];
              yield* attemptCheckpoint(() =>
                encoder!.write([record], chunk => {
                  if (emitted.length > 0) {
                    throw CodeGraphCheckpointCommandError.make({
                      message: 'Checkpoint encoder emitted more than one chunk for one record.',
                    });
                  }
                  emitted.push(chunk.bytes);
                }),
              );
              if (emitted[0] !== undefined) yield* spool.file.writeAll(emitted[0]);
            }
          }),
      });
      if (encoder === undefined) return yield* checkpointFailure('Checkpoint projection did not emit metadata.');
      const finishedEncoder = encoder;
      const finalChunks: Uint8Array[] = [];
      const prepared = yield* attemptCheckpoint(() => finishedEncoder.finish(chunk => finalChunks.push(chunk.bytes)));
      if (finalChunks.length > 1) return yield* checkpointFailure('Checkpoint encoder emitted an invalid final spool.');
      if (finalChunks[0] !== undefined) yield* spool.file.writeAll(finalChunks[0]);
      yield* spool.file.sync;
      return yield* publishPreparedCheckpoint(fs, path, output, prepared, spool);
    }),
  );
  const result = {
    artifact: artifact.descriptor,
    graphAbi: artifact.header.abi.digest,
    graphContentId: artifact.header.source.graphContentId,
    logicalDigest: artifact.header.logical.digest,
    output,
    snapshotId: checkpointSnapshotId(artifact.header),
    sourceCommit: artifact.header.source.commit,
    type: 'code-graph-checkpoint-export' as const,
    version: 1 as const,
  };
  return result;
});

export const importCodeGraphCheckpointSnapshot = Effect.fn('codeGraph.checkpoint.importSnapshot')(function* (
  config: RuntimeConfig,
  options: CodeGraphCheckpointImportOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const system = yield* SystemInfo;
  const store = yield* CodeGraphStore;
  const registry = yield* CodeGraphLanguagePackRegistry;
  const maintenance = yield* CodeGraphMaintenanceCoordinator;
  const cwd = yield* checkpointCommandCwd(options.cwd);
  const identity = yield* resolveRepositoryIdentity(cwd);
  const layout = codeGraphLayout(path, config.agentContextHome, identity.checkoutId, identity.worktreeId);
  const validated = yield* withCheckpointInput(options.input, input =>
    Effect.gen(function* () {
      const inspection = yield* inspectCheckpointInput(input, options);
      yield* attemptCheckpoint(() => validateCheckpointReceiver(inspection.header, identity, registry));
      yield* requireCheckpointCommit(identity, inspection.header.source.commit);
      const admission = yield* prepareCodeGraphCheckpointReceiverAdmission(identity, inspection.header, registry).pipe(
        Effect.mapError(cause =>
          checkpointCommandError(
            'Checkpoint receiver admission could not be verified. Run `threadnote graph index` locally.',
            cause,
          ),
        ),
      );
      const attribution = checkpointAttributionRecordVerifier(inspection.header);
      yield* withCodeGraphCheckpointAuthorityVerification(inspection.header, accept =>
        decodeCheckpointInput(input, inspection, chunk =>
          Effect.gen(function* () {
            for (const record of chunk.records) {
              if (record.kind === 'file') admission.files.accept(record);
            }
            yield* verifyCheckpointFiles(identity, inspection.header.source.commit, chunk);
          }).pipe(Effect.andThen(attribution.accept(chunk)), Effect.andThen(accept(chunk.records))),
        ),
      );
      yield* attribution.finish;
      if (!admission.files.complete) {
        return yield* checkpointFailure(
          'Checkpoint file set does not match receiver admission. Run `threadnote graph index` locally.',
        );
      }
      yield* admission.verifyEnvironment;
      return {input, inspection, admission};
    }),
  );
  const receipt = checkpointImportReceipt(validated.inspection, options.expectedDigest !== undefined);
  const reusableBaseReceipt = yield* hydrateCodeGraphCheckpointReusableBaseReceipt(
    identity,
    validated.inspection.header,
    validated.admission,
  );
  const snapshotId = checkpointSnapshotId(validated.inspection.header);
  const building = checkpointBuildingSnapshot(snapshotId, identity, validated.inspection.header);
  const capacityProtection: DirectPersistentCapacityProtection = {
    availableDiskBytes: target => system.availableDiskBytes(target),
    crypto,
    maintenance,
    path,
    system,
    temporaryDirectory: system.tempDirectory,
    walAutoCheckpointPages: 1_000,
  };
  const persistentCapacityProtector = codeGraphDirectPersistentCapacityProtector({
    capacityProtection,
    fs,
    identity,
    layout,
    threadnoteHome: config.agentContextHome,
  });
  const imported = yield* withCodeGraphProcessLock(
    fs,
    layout.lockPath,
    () => Effect.void,
    'checkpoint-import',
    Effect.gen(function* () {
      yield* validated.admission.verifyEnvironment;
      const reusable = yield* store.readySnapshotByLogicalDigest(
        layout.databasePath,
        identity.repositoryId,
        validated.inspection.header.logical.digest,
        validated.inspection.header.abi.digest,
      );
      if (reusable !== undefined) return {mode: 'reused' as const, snapshot: reusable};
      const ownerToken = yield* store.claimPersistentBuild(layout.databasePath, identity, building, {
        logicalSnapshotId: snapshotId,
        owner: {buildId: yield* crypto.randomUUIDv4(), processId: system.processId},
      });
      const imported = Effect.gen(function* () {
        yield* store.bindCheckpointImportBuild(layout.databasePath, snapshotId, {
          ...receipt,
          batchCount: validated.inspection.header.chunks.length,
          packProvenance: validated.inspection.header.abi.input.languagePacks,
          recordCounts: validated.inspection.header.counts,
        });
        yield* withCheckpointInput(validated.input.path, input =>
          Effect.gen(function* () {
            if (input.size !== validated.input.size) {
              return yield* checkpointFailure('Checkpoint input changed before staging.');
            }
            yield* decodeCheckpointInput(input, validated.inspection, chunk =>
              store
                .stageCheckpointImportRecordPage(layout.databasePath, snapshotId, ownerToken, {
                  batchIndex: chunk.descriptor.ordinal,
                  digest: chunk.descriptor.digest,
                  records: chunk.records,
                })
                .pipe(Effect.asVoid),
            );
          }),
        );
        yield* store.finalizeCheckpointImport(layout.databasePath, identity, building, ownerToken, receipt, {
          persistentCapacityProtector,
          ...(reusableBaseReceipt === undefined ? {} : {reusableBaseReceipt}),
        });
        const ready = yield* store.readySnapshotById(layout.databasePath, snapshotId);
        if (ready === undefined || ready.state !== 'ready') {
          return yield* checkpointFailure('Checkpoint import completed without an exact ready snapshot.');
        }
        return {mode: 'created' as const, snapshot: ready};
      }).pipe(
        Effect.onError(() =>
          store
            .markFailed(layout.databasePath, snapshotId, 'Checkpoint import did not complete.', ownerToken)
            .pipe(Effect.ignore),
        ),
      );
      return yield* imported;
    }),
  );
  const publication = yield* publishImportedCheckpoint(cwd, identity, layout.databasePath, imported.snapshot);
  return {
    cwd,
    identity,
    result: {
      artifact: validated.inspection.descriptor,
      imported: imported.mode,
      logicalDigest: validated.inspection.header.logical.digest,
      publication: publication.state,
      snapshotId: publication.snapshotId,
      trust: receipt.trust,
      type: 'code-graph-checkpoint-import',
      version: 1,
    } satisfies CodeGraphCheckpointImportResultV1,
    snapshot: imported.snapshot,
  };

  function publishImportedCheckpoint(
    targetCwd: string,
    initialIdentity: RepositoryIdentity,
    databasePath: string,
    snapshot: CodeGraphSnapshot,
  ) {
    return Effect.gen(function* () {
      const closingIdentity = yield* revalidateRepositoryIdentityFence(targetCwd, initialIdentity);
      const clean = yield* observeCleanRepositoryWorktree(closingIdentity.repoRoot);
      if (closingIdentity.headCommit === snapshot.commit && clean !== undefined) {
        return yield* withCodeGraphProcessLock(
          fs,
          layout.lockPath,
          () => Effect.void,
          'checkpoint-promote',
          Effect.gen(function* () {
            const finalIdentity = yield* revalidateRepositoryIdentityFence(targetCwd, closingIdentity);
            if (
              finalIdentity.headCommit !== snapshot.commit ||
              (yield* observeCleanRepositoryWorktree(finalIdentity.repoRoot)) === undefined
            ) {
              return {snapshotId: snapshot.id, state: 'stored' as const};
            }
            yield* validated.admission.verifyEnvironment;
            yield* store.promote(databasePath, finalIdentity, snapshot.id, {persistentCapacityProtector});
            yield* validated.admission.verifyEnvironment;
            yield* recordCodeGraphSnapshotAdmission(
              layout,
              snapshot,
              validated.admission.environmentFingerprint,
              registry,
              validated.inspection.header.reuse?.inventory?.includeOpaqueCorpusAssets ??
                validated.admission.files.includesOpaqueAssets,
            );
            return {snapshotId: snapshot.id, state: 'activated' as const};
          }),
        );
      }
      return {snapshotId: snapshot.id, state: 'stored' as const};
    });
  }
});

export const runCodeGraphCheckpointImport = Effect.fn('codeGraph.checkpoint.import')(function* (
  config: RuntimeConfig,
  options: CodeGraphCheckpointImportOptions,
) {
  const imported = yield* importCodeGraphCheckpointSnapshot(config, options);
  let result: CodeGraphCheckpointImportResultV1 = imported.result;
  if (options.followOnIndex !== false && result.publication === 'stored') {
    const closingIdentity = yield* revalidateRepositoryIdentityFence(imported.cwd, imported.identity);
    const ancestor = yield* checkpointCommitIsAncestor(
      closingIdentity,
      imported.snapshot.commit,
      closingIdentity.headCommit,
    );
    if (closingIdentity.headCommit === imported.snapshot.commit || ancestor) {
      const indexer = yield* CodeGraphIndexer;
      const summary = yield* indexer.index({
        cwd: imported.cwd,
        ensureVectors: false,
        threadnoteHome: config.agentContextHome,
      });
      result = {...result, publication: 'rebuilt', snapshotId: summary.snapshot.id};
    }
  }
  return result;
});

function inspectCheckpointInput(
  input: OpenCheckpointInput,
  options: Pick<CodeGraphCheckpointArtifactOptions, 'expectedDigest'>,
) {
  return Effect.gen(function* () {
    const expectedDigest = yield* parseExpectedDigest(options.expectedDigest);
    const inspector = yield* attemptCheckpoint(() => new CodeGraphCheckpointStreamInspectorV1({expectedDigest}));
    yield* consumeCheckpointInput(input, bytes => attemptCheckpoint(() => inspector.push(bytes)));
    const inspection = yield* attemptCheckpoint(() => inspector.finish());
    if (inspection.descriptor.size !== input.size) {
      return yield* checkpointFailure('Checkpoint descriptor does not match the opened input size.');
    }
    yield* input.assertUnchanged();
    return inspection;
  });
}

function decodeCheckpointInput<E, R>(
  input: OpenCheckpointInput,
  inspection: CodeGraphCheckpointInspectionV1,
  onChunk: (chunk: CodeGraphCheckpointVerifiedChunkV1) => Effect.Effect<void, E, R>,
) {
  return Effect.gen(function* () {
    const plan = yield* attemptCheckpoint(() => codeGraphCheckpointReadPlanV1(inspection.header));
    const verifiedChunks: CodeGraphCheckpointVerifiedChunkV1[] = [];
    const decoder = yield* attemptCheckpoint(
      () =>
        new CodeGraphCheckpointStreamDecoderV1({
          expectedDescriptor: inspection.descriptor,
          onVerifiedChunk: chunk => {
            if (verifiedChunks.length > 0) {
              throw CodeGraphCheckpointCommandError.make({
                message: 'Checkpoint decoder emitted more than one chunk per frame.',
              });
            }
            verifiedChunks.push(chunk);
          },
        }),
    );
    yield* input.file.seek(0n, 'start');
    yield* readCheckpointPart(input.file, plan.prefixBytes).pipe(
      Effect.flatMap(bytes => attemptCheckpoint(() => decoder.push(bytes))),
    );
    for (const frame of plan.chunks) {
      verifiedChunks.length = 0;
      const bytes = yield* readCheckpointPart(input.file, frame.frameBytes);
      yield* attemptCheckpoint(() => decoder.push(bytes));
      const chunk = verifiedChunks[0];
      if (verifiedChunks.length !== 1 || chunk === undefined || chunk.descriptor.ordinal !== frame.ordinal) {
        return yield* checkpointFailure('Checkpoint decoder did not verify the expected chunk frame.');
      }
      yield* onChunk(chunk);
    }
    yield* requireCheckpointEof(input.file);
    const verification = yield* attemptCheckpoint(() => decoder.finish());
    yield* input.assertUnchanged();
    return verification;
  });
}

function verifyCheckpointFiles(
  identity: RepositoryIdentity,
  commit: string,
  chunk: CodeGraphCheckpointVerifiedChunkV1,
) {
  return Effect.gen(function* () {
    const files = EffectArray.filter(
      chunk.records,
      (record): record is CodeGraphCheckpointFileRecordV1 => record.kind === 'file',
    );
    if (files.length === 0) return;
    const system = yield* SystemInfo;
    for (const batch of codeGraphCheckpointGitPathBatches(files)) {
      const result = yield* runBinaryCommandEffect(
        'git',
        [
          '-C',
          identity.repoRoot,
          'ls-tree',
          '-l',
          '-z',
          '--full-tree',
          commit,
          '--',
          ...EffectArray.map(batch, file => file.path),
        ],
        {
          env: {...system.environment(), GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1'},
          maxOutputBytes: CHECKPOINT_GIT_OUTPUT_BYTES_MAXIMUM,
          timeoutMs: 30_000,
        },
      );
      const entries = yield* attemptCheckpoint(() => parseGitTreeEntries(result.stdout, identity.objectFormat));
      if (entries.size !== batch.length) {
        return yield* checkpointFailure('Checkpoint file identities are incomplete in the local source commit.');
      }
      for (const file of batch) {
        const entry = entries.get(file.path);
        if (
          entry === undefined ||
          entry.blobId !== file.blobId ||
          entry.mode !== file.mode ||
          entry.size !== file.size ||
          codeGraphCommittedContentHash(identity.objectFormat, entry.blobId) !== file.contentHash
        ) {
          return yield* checkpointFailure('Checkpoint file identity does not match the local source commit.');
        }
      }
    }
  });
}

/**
 * Reuse context is executable graph input on a later incremental build. Bind
 * every portable attribution tuple to the checkpoint's already Git-verified
 * file record instead of trusting header-only blob claims.
 */
function checkpointAttributionRecordVerifier(header: CodeGraphCheckpointHeaderV1) {
  const remaining = new Map(
    EffectArray.map(header.reuse?.inventory?.attributionFiles ?? [], file => [file.path, file] as const),
  );
  return {
    accept: (chunk: CodeGraphCheckpointVerifiedChunkV1) =>
      Effect.gen(function* () {
        for (const record of chunk.records) {
          if (record.kind !== 'file') continue;
          const expected = remaining.get(record.path);
          if (expected === undefined) continue;
          if (
            record.blobId !== expected.blobId ||
            record.size !== expected.blobSize ||
            record.contentHash !== expected.contentHash ||
            record.language !== expected.language ||
            record.mode !== expected.mode ||
            record.source !== expected.source
          ) {
            return yield* checkpointFailure(
              `Checkpoint attribution context does not match its file record: ${record.path}`,
            );
          }
          remaining.delete(record.path);
        }
      }),
    finish: Effect.suspend(() =>
      remaining.size === 0
        ? Effect.void
        : checkpointFailure('Checkpoint attribution context is not covered by exact graph file records.'),
    ),
  };
}

function validateCheckpointReceiver(
  header: CodeGraphCheckpointHeaderV1,
  identity: RepositoryIdentity,
  registry: CodeGraphLanguagePackRegistryShape,
): void {
  if (
    header.repository.repositoryId !== identity.repositoryId ||
    header.repository.objectFormat !== identity.objectFormat
  ) {
    throw CodeGraphCheckpointCommandError.make({
      message: 'Checkpoint repository identity does not match this checkout.',
    });
  }
  const compatibility = inspectCodeGraphCheckpointCompatibilityV1(header.abi.input, registry);
  if (!compatibility.compatible) {
    const detail =
      compatibility.code === 'language-pack-unavailable'
        ? ` Missing packs: ${checkpointTerminalText(Option.getOrUndefined(Option.map(Option.fromNullishOr(compatibility.unavailablePackIds), __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ', '))) ?? 'unknown')}.`
        : '';
    throw CodeGraphCheckpointCommandError.make({message: `Checkpoint runtime ABI is incompatible.${detail}`});
  }
}

function requireCheckpointCommit(identity: RepositoryIdentity, commit: string) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const result = yield* runCommandEffect('git', ['-C', identity.repoRoot, 'cat-file', '-e', `${commit}^{commit}`], {
      allowFailure: true,
      env: {...system.environment(), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'},
      maxOutputBytes: 4_096,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) {
      return yield* checkpointFailure('Checkpoint source commit is not available in the local Git object database.');
    }
  });
}

function checkpointCommitIsAncestor(identity: RepositoryIdentity, ancestor: string, descendant: string) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const result = yield* runCommandEffect(
      'git',
      ['-C', identity.repoRoot, 'merge-base', '--is-ancestor', ancestor, descendant],
      {
        allowFailure: true,
        env: {...system.environment(), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'},
        maxOutputBytes: 4_096,
        timeoutMs: 10_000,
      },
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    return yield* checkpointFailure('Checkpoint source ancestry could not be established locally.');
  });
}

function checkpointImportReceipt(
  inspection: CodeGraphCheckpointInspectionV1,
  expectedDigestSupplied: boolean,
): CodeGraphCheckpointImportReceiptInput {
  return {
    abi: {algorithm: 'sha256', digest: inspection.header.abi.digest},
    artifact: {
      algorithm: 'sha256',
      digest: Effect2.pipe(inspection.descriptor.digest, EffectString.slice('sha256:'.length)),
      mediaType: CODE_GRAPH_CHECKPOINT_MEDIA_TYPE,
      size: inspection.descriptor.size,
    },
    baseLogicalDigest: null,
    coverage: inspection.header.coverage,
    formatVersion: CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION,
    logical: inspection.header.logical,
    source: {
      commit: inspection.header.source.commit,
      graphContentId: inspection.header.source.graphContentId,
      repositoryId: inspection.header.repository.repositoryId,
    },
    trust: expectedDigestSupplied ? 'expected-descriptor-verified' : 'local-unverified',
  };
}

function checkpointSnapshotId(header: CodeGraphCheckpointHeaderV1): string {
  return `cgsn_${Effect2.pipe(
    sha256HexSync(
      `${CHECKPOINT_SNAPSHOT_DOMAIN}${header.repository.repositoryId}\0${header.source.commit}\0${header.logical.digest}`,
    ),
    EffectString.slice(0, 40),
  )}`;
}

function checkpointBuildingSnapshot(
  id: string,
  identity: RepositoryIdentity,
  header: CodeGraphCheckpointHeaderV1,
): CodeGraphSnapshot {
  return {
    commit: header.source.commit,
    dirty: false,
    edgeCount: header.counts.edge,
    extractorSet: header.source.extractorSet,
    fileCount: header.counts.file,
    graphContentId: header.source.graphContentId,
    id,
    repositoryId: identity.repositoryId,
    state: 'building',
    symbolCount: header.counts.symbol,
    worktreeId: identity.worktreeId,
  };
}

function withCheckpointInput<A, E, R>(
  inputPath: string,
  use: (input: OpenCheckpointInput) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | CodeGraphCheckpointCommandError, R | FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = path.resolve(inputPath);
    if (Option.isSome(yield* fs.readLink(resolved).pipe(Effect.option))) {
      return yield* checkpointFailure('Checkpoint input must not be a symbolic link.');
    }
    const initial = yield* requireOwnedFileIdentity(yield* fs.stat(resolved), 'Checkpoint input');
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(resolved, {flag: 'r'});
        const opened = yield* requireOwnedFileIdentity(yield* file.stat, 'Opened checkpoint input');
        const pathOpened = yield* requireOwnedFileIdentity(yield* fs.stat(resolved), 'Checkpoint input');
        if (!sameOwnedFile(initial, opened) || !sameOwnedFile(initial, pathOpened)) {
          return yield* checkpointFailure('Checkpoint input changed while it was opened.');
        }
        const size = Number(initial.size);
        if (!Number.isSafeInteger(size) || size < CODE_GRAPH_CHECKPOINT_PRELUDE_BYTES) {
          return yield* checkpointFailure('Checkpoint input size is invalid.');
        }
        const assertUnchanged = () =>
          Effect.gen(function* () {
            if (Option.isSome(yield* fs.readLink(resolved).pipe(Effect.option))) {
              return yield* checkpointFailure('Checkpoint input changed into a symbolic link.');
            }
            const descriptor = yield* requireOwnedFileIdentity(yield* file.stat, 'Opened checkpoint input');
            const pathname = yield* requireOwnedFileIdentity(yield* fs.stat(resolved), 'Checkpoint input');
            if (!sameOwnedFile(initial, descriptor) || !sameOwnedFile(initial, pathname)) {
              return yield* checkpointFailure('Checkpoint input changed during verification.');
            }
          }).pipe(
            Effect.mapError(cause => checkpointCommandError('Checkpoint input changed during verification.', cause)),
          );
        return yield* use({assertUnchanged, file, path: resolved, size});
      }),
    );
  }).pipe(Effect.mapError(cause => checkpointCommandError('Checkpoint input could not be read.', cause)));
}

function consumeCheckpointInput(
  input: OpenCheckpointInput,
  accept: (bytes: Uint8Array) => Effect.Effect<void, CodeGraphCheckpointCommandError>,
) {
  return Effect.gen(function* () {
    yield* input.file.seek(0n, 'start');
    let remaining = input.size;
    while (remaining > 0) {
      const bytes = yield* readCheckpointPart(input.file, Math.min(remaining, CHECKPOINT_IO_CHUNK_BYTES));
      remaining -= bytes.byteLength;
      yield* accept(bytes);
    }
    yield* requireCheckpointEof(input.file);
  });
}

function readCheckpointPart(file: FileSystem.File, length: number) {
  return Effect.gen(function* () {
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = Number(yield* file.read(bytes.subarray(offset)));
      if (!Number.isSafeInteger(read) || read <= 0 || read > bytes.byteLength - offset) {
        return yield* checkpointFailure('Checkpoint input ended before its declared framing.');
      }
      offset += read;
    }
    return bytes;
  });
}

function requireCheckpointEof(file: FileSystem.File) {
  return Effect.gen(function* () {
    const extra = new Uint8Array(1);
    if (Number(yield* file.read(extra)) !== 0) {
      return yield* checkpointFailure('Checkpoint input has trailing bytes.');
    }
  });
}

function parseExpectedDigest(value: string | undefined) {
  if (value === undefined) return succeedUndefined;
  const normalized = Effect2.pipe(value, EffectString.trim, EffectString.toLowerCase);
  const prefixed = Effect2.pipe(normalized, EffectString.startsWith('sha256:')) ? normalized : `sha256:${normalized}`;
  return isCheckpointSha256(prefixed)
    ? Effect.succeed(prefixed)
    : checkpointFailure('--expected-digest must be a lowercase SHA-256 digest.');
}

function isCheckpointSha256(value: string): value is CodeGraphCheckpointSha256 {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function withPrivateSpool<A, E, R>(
  spoolPath: string,
  use: (spool: {readonly file: FileSystem.File}) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | CodeGraphCheckpointCommandError, R | FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(spoolPath, {flag: 'wx+', mode: 0o600});
        const identity = yield* requireOwnedFileIdentity(yield* file.stat, 'Checkpoint spool');
        yield* verifyOwnedPath(fs, spoolPath, identity, 'Checkpoint spool');
        return yield* use({file}).pipe(Effect.ensuring(removeOwnedPath(fs, spoolPath, identity)));
      }),
    );
  }).pipe(Effect.mapError(cause => checkpointCommandError('Checkpoint spool operation failed.', cause)));
}

function publishPreparedCheckpoint(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  output: string,
  prepared: CodeGraphCheckpointPreparedPackV1,
  spool: {readonly file: FileSystem.File},
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const parent = path.dirname(output);
    const temporary = path.join(parent, `.${path.basename(output)}.${yield* crypto.randomUUIDv4()}.tmp`);
    let publicationIdentity: OwnedFileIdentity | undefined;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(temporary, {flag: 'wx', mode: 0o600});
        const writer = yield* attemptCheckpoint(() => new CodeGraphCheckpointArtifactWriterV1(prepared));
        yield* file.writeAll(writer.prefix);
        yield* spool.file.seek(0n, 'start');
        let offset = 0;
        for (const descriptor of prepared.header.chunks) {
          const frameBytes = CODE_GRAPH_CHECKPOINT_CHUNK_FRAME_HEADER_BYTES + descriptor.compressedBytes;
          const bytes = yield* readCheckpointPart(spool.file, frameBytes);
          offset += frameBytes;
          yield* file.writeAll(yield* attemptCheckpoint(() => writer.write({bytes, ordinal: descriptor.ordinal})));
        }
        yield* requireCheckpointEof(spool.file);
        const spoolSize = Number((yield* spool.file.stat).size);
        if (offset !== spoolSize) return yield* checkpointFailure('Checkpoint spool framing is inconsistent.');
        const descriptor = yield* attemptCheckpoint(() => writer.finish());
        yield* file.sync;
        const identity = yield* requireOwnedFileIdentity(yield* file.stat, 'Checkpoint output temporary');
        publicationIdentity = identity;
        yield* verifyOwnedPath(fs, temporary, identity, 'Checkpoint output temporary');
        const linked = yield* fs.link(temporary, output).pipe(Effect.result);
        if (linked._tag === 'Failure') {
          if (yield* fs.exists(output)) return yield* checkpointFailure(`Checkpoint output already exists: ${output}`);
          return yield* linked.failure;
        }
        yield* verifyOwnedPath(fs, output, identity, 'Published checkpoint output');
        yield* syncDirectory(fs, parent);
        yield* removeOwnedPath(fs, temporary, identity);
        yield* syncDirectory(fs, parent);
        return {descriptor, header: prepared.header};
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            publicationIdentity === undefined ? Effect.void : removeOwnedPath(fs, temporary, publicationIdentity),
          ),
        ),
      ),
    );
  });
}

function requireOwnedFileIdentity(info: FileSystem.File.Info, label: string) {
  const birthtime = Option.getOrUndefined(info.birthtime);
  const ino = Option.getOrUndefined(info.ino);
  const modifiedAt = Option.getOrUndefined(info.mtime);
  if (info.type !== 'File' || birthtime === undefined || ino === undefined || modifiedAt === undefined) {
    return checkpointFailure(`${label} has insufficient regular-file identity metadata.`);
  }
  return Effect.succeed({
    birthtimeMilliseconds: birthtime.getTime(),
    dev: info.dev,
    ino,
    mode: info.mode,
    modifiedAtMilliseconds: modifiedAt.getTime(),
    size: info.size,
  } satisfies OwnedFileIdentity);
}

function sameOwnedFile(left: OwnedFileIdentity, right: OwnedFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedAtMilliseconds === right.modifiedAtMilliseconds &&
    left.birthtimeMilliseconds === right.birthtimeMilliseconds
  );
}

function verifyOwnedPath(fs: FileSystem.FileSystem, target: string, expected: OwnedFileIdentity, label: string) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
      return yield* checkpointFailure(`${label} became a symbolic link.`);
    }
    const current = yield* requireOwnedFileIdentity(yield* fs.stat(target), label);
    if (!sameOwnedFile(expected, current)) return yield* checkpointFailure(`${label} changed identity.`);
  });
}

function removeOwnedPath(fs: FileSystem.FileSystem, target: string, expected: OwnedFileIdentity) {
  return Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) return;
    const current = yield* fs.stat(target).pipe(Effect.option);
    if (Option.isNone(current)) return;
    const identity = yield* requireOwnedFileIdentity(current.value, 'Checkpoint temporary');
    if (sameOwnedFile(expected, identity)) yield* fs.remove(target, {force: true});
  }).pipe(Effect.ignore);
}

function syncDirectory(fs: FileSystem.FileSystem, directory: string): Effect.Effect<void, never> {
  return Effect.scoped(
    fs.open(directory, {flag: 'r'}).pipe(
      Effect.flatMap(file => file.sync),
      Effect.ignore,
    ),
  );
}

function checkpointCommandCwd(value: string | undefined) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return path.resolve(
      Effect2.pipe(value, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) || system.currentDirectory(),
    );
  });
}

function attemptCheckpoint<A>(attempt: () => A) {
  return Effect.try({
    try: attempt,
    catch: cause => checkpointCommandError('Code graph checkpoint operation failed.', cause),
  });
}

function checkpointFailure(message: string): Effect.Effect<never, CodeGraphCheckpointCommandError> {
  return Effect.fail(CodeGraphCheckpointCommandError.make({message: message}));
}

function checkpointCommandError(message: string, cause: unknown): CodeGraphCheckpointCommandError {
  if (Schema.is(CodeGraphCheckpointCommandError)(cause)) return cause;
  return CodeGraphCheckpointCommandError.make({
    cause,
    message: cause instanceof Error && cause.message.length > 0 ? `${message} ${cause.message}` : message,
  });
}
