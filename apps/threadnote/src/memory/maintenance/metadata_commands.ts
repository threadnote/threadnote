import {Array as EffectArray} from 'effect';
import {DateTime, Effect, FileSystem} from 'effect';
import {writeFinalCliOutput} from '../../effect/cli/output.js';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {readMemoryRecordsByUri, writeMemoryContentWithExpectedHash} from '../../mcp/server/memory.js';
import {refreshRecallDerivedIndexesAfterCanonicalMutation} from '@threadnote/recall/mcp/refresh';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readMaintenanceMemoryRecords} from './records.js';
import {
  applyMaintenanceMetadataV1,
  previewMaintenanceMetadataV1,
  type MaintenanceMetadataPatchV1,
  type MaintenanceMetadataProposalV1,
} from '@threadnote/memory/maintenance/metadata';
import {isMemoryId, memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {MemoryOperationError} from '../migrations.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface MetadataMutationOptionsV1 extends MaintenanceMetadataPatchV1 {
  readonly memoryId?: string;
  readonly uri?: string;
}

export interface MetadataApplyOptionsV1 extends MetadataMutationOptionsV1 {
  readonly approved?: boolean;
  readonly expectedContentHash: string;
  readonly proposalId: string;
  readonly revision: string;
}

export const previewMaintenanceMetadata = Effect.fn('memory.maintenanceMetadata.preview')(function* (
  config: RuntimeConfig,
  options: MetadataMutationOptionsV1,
) {
  const selector = selectorFor(options);
  const records = yield* readMaintenanceMemoryRecords(config);
  return previewMaintenanceMetadataV1(records, selector, patchFrom(options));
});

export const applyMaintenanceMetadata = Effect.fn('memory.maintenanceMetadata.apply')(function* (
  config: RuntimeConfig,
  options: MetadataApplyOptionsV1,
) {
  const preview = yield* previewMaintenanceMetadata(config, options);
  if (preview.status === 'conflict') return preview;
  if (preview.proposal.proposalId !== options.proposalId || preview.proposal.revision !== options.revision) {
    return {
      code: 'proposal-mismatch',
      message: 'Proposal ID or revision does not match current preview.',
      status: 'conflict' as const,
    };
  }
  const fs = yield* FileSystem.FileSystem;
  const result = yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [preview.proposal.targetUri],
    Effect.gen(function* () {
      const [current] = yield* readMemoryRecordsByUri(config, [preview.proposal.targetUri]);
      const result = applyMaintenanceMetadataV1({
        approved: options.approved,
        expectedContentHash: options.expectedContentHash,
        expectedRevision: options.revision,
        proposal: preview.proposal,
        record: current,
        updatedAt: (yield* DateTime.nowAsDate).toISOString(),
      });
      if (result.status !== 'applied') return result;
      const write = yield* writeMemoryContentWithExpectedHash(
        config,
        'threadnote-native',
        preview.proposal.targetUri,
        result.content,
        current.content,
        {alreadyLocked: true},
      );
      if (write.isError === true) {
        return {
          code: 'write-failed',
          message: 'The metadata target changed during its locked CAS update.',
          status: 'conflict' as const,
        };
      }
      return result;
    }),
  );
  if (result.status === 'applied') {
    yield* refreshRecallDerivedIndexesAfterCanonicalMutation(config, [preview.proposal.targetUri]);
  }
  return result;
});

export const runMaintenanceMetadataPreview = Effect.fn('memory.maintenanceMetadata.previewCommand')(function* (
  config: RuntimeConfig,
  options: MetadataMutationOptionsV1 & {readonly json?: boolean},
) {
  const result = yield* previewMaintenanceMetadata(config, options);
  yield* writeFinalCliOutput(options.json ? JSON.stringify(result) : renderMaintenanceMetadata(result));
});

export const runMaintenanceMetadataApply = Effect.fn('memory.maintenanceMetadata.applyCommand')(function* (
  config: RuntimeConfig,
  options: MetadataApplyOptionsV1 & {readonly json?: boolean},
) {
  const result = yield* applyMaintenanceMetadata(config, options);
  yield* writeFinalCliOutput(options.json ? JSON.stringify(result) : renderMaintenanceMetadata(result));
});

export function renderMaintenanceMetadata(
  result:
    | ReturnType<typeof previewMaintenanceMetadataV1>
    | ReturnType<typeof applyMaintenanceMetadataV1>
    | {readonly code: string; readonly message: string; readonly status: 'conflict'},
): string {
  if (result.status === 'conflict') return `Metadata conflict (${result.code}): ${result.message}`;
  if (result.status === 'already-applied')
    return `Metadata proposal ${result.proposal.proposalId} was already applied.`;
  if (result.status === 'applied') return `Metadata proposal ${result.proposal.proposalId} applied.`;
  return EffectArray.join(
    [
      `Metadata preview for ${result.proposal.targetUri}`,
      `proposal: ${result.proposal.proposalId}`,
      `revision: ${result.proposal.revision}`,
      `content_hash: ${result.proposal.expectedContentHash}`,
      `current: ${JSON.stringify(result.proposal.current)}`,
      `patch: ${JSON.stringify(result.proposal.patch)}`,
    ],
    '\n',
  );
}

export function metadataProposalFromPreview(
  result: ReturnType<typeof previewMaintenanceMetadataV1>,
): MaintenanceMetadataProposalV1 | undefined {
  return result.status === 'preview' ? result.proposal : undefined;
}

function selectorFor(options: MetadataMutationOptionsV1): string {
  const values = EffectArray.filter(
    [
      Effect2.pipe(options.uri, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ),
      Effect2.pipe(options.memoryId, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ),
    ],
    (value): value is string => Boolean(value),
  );
  if (values.length !== 1)
    throw MemoryOperationError.make({message: 'Provide exactly one target URI or stable memory ID.'});
  const value = values[0];
  return isMemoryId(value) ? memoryIdentityAlias(value) : value;
}

function patchFrom(options: MetadataMutationOptionsV1): MaintenanceMetadataPatchV1 {
  return {
    ...(options.owner === undefined ? {} : {owner: options.owner}),
    ...(options.reviewAfter === undefined ? {} : {reviewAfter: options.reviewAfter}),
    ...(options.validTo === undefined ? {} : {validTo: options.validTo}),
  };
}
