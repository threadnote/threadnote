import {Array as EffectArray} from 'effect';
import {Effect, Schema} from 'effect';
import {runBinaryCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {codeGraphCommittedContentHash} from '../content_identity.js';
import {codeGraphUtf8ByteLength} from '../disk/capacity.js';
import {appearsBinary, decodeUtf8} from '../inventory/content.js';
import {retainResolutionContext} from '../inventory/content.js';
import {parseGitCatFileBatch} from '../inventory.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../languages/registry.js';
import {
  CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
  type CodeGraphReusableBaseReceiptInput,
  type CodeGraphAttributionContextFile,
} from '../store/models.js';
import {
  CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
  CODE_GRAPH_INVENTORY_EXCLUSION_REASONS,
  type CodeGraphInventoryExclusionReason,
} from '../inventory/policy.js';
import type {RepositoryIdentity} from '../types.js';
import {
  CODE_GRAPH_CHECKPOINT_ATTRIBUTION_CONTENT_BYTES_MAXIMUM,
  CODE_GRAPH_CHECKPOINT_ATTRIBUTION_FILES_MAXIMUM,
  CODE_GRAPH_CHECKPOINT_ATTRIBUTION_SOURCE_BYTES_MAXIMUM,
  type CodeGraphCheckpointAttributionFileV1,
  type CodeGraphCheckpointHeaderV1,
} from './schema.js';

const CAT_FILE_BATCH_ENTRIES = 128;
const CAT_FILE_BATCH_BYTES = 4 * 1_048_576;

export class CodeGraphCheckpointReuseHydrationError extends Schema.TaggedError<
  CodeGraphCheckpointReuseHydrationError,
  {readonly brand: unique symbol}
>()('CodeGraphCheckpointReuseHydrationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

function hydrationError(message: string, cause?: unknown): CodeGraphCheckpointReuseHydrationError {
  return CodeGraphCheckpointReuseHydrationError.make({
    message: message,
    cause: cause === undefined ? undefined : {cause},
  });
}

function attributionBatches(
  files: readonly CodeGraphCheckpointAttributionFileV1[],
): readonly (readonly CodeGraphCheckpointAttributionFileV1[])[] {
  const batches: CodeGraphCheckpointAttributionFileV1[][] = [];
  let current: CodeGraphCheckpointAttributionFileV1[] = [];
  let bytes = 0;
  for (const file of files) {
    if (
      current.length > 0 &&
      (current.length >= CAT_FILE_BATCH_ENTRIES || bytes + file.blobSize > CAT_FILE_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.blobSize;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Rebuild the receiver-local reusable-base receipt without trusting donor
 * environment or source bytes. Declared Git blob identities are hydrated from
 * the local object database with lazy fetching disabled and verified against
 * every portable attribution tuple.
 */
export const hydrateCodeGraphCheckpointReusableBaseReceipt = Effect.fn(
  'codeGraph.hydrateCheckpointReusableBaseReceipt',
)(function* (
  identity: RepositoryIdentity,
  header: CodeGraphCheckpointHeaderV1,
  receiverAdmission: {readonly environmentFingerprint: string},
) {
  const reuse = header.reuse;
  if (reuse === undefined) return undefined;
  if (
    header.repository.repositoryId !== identity.repositoryId ||
    header.repository.objectFormat !== identity.objectFormat
  ) {
    return yield* hydrationError('Checkpoint repository identity does not match the receiver.');
  }
  const packProvenance = EffectArray.map(header.abi.input.languagePacks, pack => ({
    cacheIdentity: pack.cacheIdentity,
    derivationIdentity: pack.derivationIdentity,
    id: pack.id,
    resolutionDomain: pack.resolutionDomain,
    resolutionVersion: pack.resolutionVersion,
  }));
  if (reuse.inventory === undefined) {
    return {
      fileSetFingerprint: reuse.fileSetFingerprint,
      packProvenance,
      workspaceFingerprint: reuse.workspaceFingerprint,
    } satisfies CodeGraphReusableBaseReceiptInput;
  }
  const portable = reuse.inventory;
  if (
    portable.version !== CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION ||
    portable.policyExclusions.policyVersion !== CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION ||
    EffectArray.some(portable.policyExclusions.reasons, reason => !isCodeGraphInventoryExclusionReason(reason.reason))
  ) {
    return yield* hydrationError('Checkpoint inventory reuse contract is incompatible.');
  }
  const totalContentBytes = EffectArray.reduce(portable.attributionFiles, 0, (total, file) => total + file.size);
  const totalSourceBytes = EffectArray.reduce(portable.attributionFiles, 0, (total, file) => total + file.blobSize);
  if (
    portable.attributionFiles.length > CODE_GRAPH_CHECKPOINT_ATTRIBUTION_FILES_MAXIMUM ||
    !Number.isSafeInteger(totalContentBytes) ||
    !Number.isSafeInteger(totalSourceBytes) ||
    totalContentBytes > CODE_GRAPH_CHECKPOINT_ATTRIBUTION_CONTENT_BYTES_MAXIMUM ||
    totalSourceBytes > CODE_GRAPH_CHECKPOINT_ATTRIBUTION_SOURCE_BYTES_MAXIMUM
  ) {
    return yield* hydrationError('Checkpoint attribution context exceeds the local reuse boundary.');
  }
  const system = yield* SystemInfo;
  const attributionFiles: CodeGraphAttributionContextFile[] = [];
  for (const batch of attributionBatches(portable.attributionFiles)) {
    const result = yield* runBinaryCommandEffect('git', ['-C', identity.repoRoot, 'cat-file', '--batch'], {
      env: {...system.environment(), GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'},
      input: new TextEncoder().encode(
        `${EffectArray.join(
          EffectArray.map(batch, file => file.blobId),
          '\n',
        )}\n`,
      ),
      maxOutputBytes: EffectArray.reduce(batch, 0, (total, file) => total + file.blobSize + 256),
      timeoutMs: 0,
    }).pipe(Effect.mapError(cause => hydrationError('Checkpoint attribution Git blobs are unavailable.', cause)));
    const blobs = yield* Effect.try({
      catch: cause => hydrationError('Checkpoint attribution Git response is invalid.', cause),
      try: () => parseGitCatFileBatch(result.stdout, batch),
    });
    for (let index = 0; index < batch.length; index += 1) {
      const declared = batch[index];
      const bytes = blobs[index];
      const sourceContent = decodeUtf8(bytes);
      const retained =
        sourceContent === undefined
          ? undefined
          : retainResolutionContext(
              {
                blobId: declared.blobId,
                content: sourceContent,
                contentHash: declared.contentHash,
                language: declared.language,
                mode: declared.mode,
                path: declared.path,
                size: declared.blobSize,
                source: 'commit',
              },
              BUILTIN_LANGUAGE_PACK_REGISTRY,
            );
      const content = retained?.content;
      if (
        bytes.byteLength !== declared.blobSize ||
        appearsBinary(bytes) ||
        content === undefined ||
        codeGraphUtf8ByteLength(content) !== declared.size ||
        codeGraphCommittedContentHash(identity.objectFormat, declared.blobId) !== declared.contentHash
      ) {
        return yield* hydrationError(
          `Checkpoint attribution blob for ${declared.path} does not match its portable identity.`,
        );
      }
      attributionFiles.push({
        blobId: declared.blobId,
        content,
        contentHash: declared.contentHash,
        language: declared.language,
        mode: declared.mode,
        path: declared.path,
        size: declared.size,
        source: 'commit',
      });
    }
  }
  return {
    fileSetFingerprint: reuse.fileSetFingerprint,
    inventory: {
      attributionFiles,
      contract: portable.contract,
      diagnostics: portable.diagnostics ?? [],
      environmentFingerprint: receiverAdmission.environmentFingerprint,
      includeOpaqueCorpusAssets: portable.includeOpaqueCorpusAssets,
      policyExclusions: {
        ...portable.policyExclusions,
        policyVersion: CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
        reasons: EffectArray.map(portable.policyExclusions.reasons, reason => {
          if (!isCodeGraphInventoryExclusionReason(reason.reason)) {
            throw hydrationError('Checkpoint inventory reuse contract is incompatible.');
          }
          return {...reason, reason: reason.reason};
        }),
      },
      skipped: portable.skipped,
      version: CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
      workspace: portable.workspace,
    },
    packProvenance,
    workspaceFingerprint: reuse.workspaceFingerprint,
  } satisfies CodeGraphReusableBaseReceiptInput;
});

function isCodeGraphInventoryExclusionReason(value: string): value is CodeGraphInventoryExclusionReason {
  return EffectArray.some(CODE_GRAPH_INVENTORY_EXCLUSION_REASONS, reason => reason === value);
}
