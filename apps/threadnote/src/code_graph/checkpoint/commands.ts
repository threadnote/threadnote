import {Array as EffectArray} from 'effect';
import {Console, Effect} from 'effect';
import {writeFinalCliOutput} from '../../effect/cli/output.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as operations from '@threadnote/graph/checkpoint/operations';
import {checkpointTerminalText} from '@threadnote/graph/checkpoint/terminal_text';
import type {CodeGraphCheckpointHeaderV1} from '@threadnote/graph/checkpoint/schema';

export * from '@threadnote/graph/checkpoint/operations';

export const runCodeGraphCheckpointInspect = Effect.fn('codeGraph.checkpoint.inspectCommand')(function* (
  options: operations.CodeGraphCheckpointArtifactOptions,
) {
  const result = yield* operations.runCodeGraphCheckpointInspect(options);
  if (options.json) yield* writeFinalCliOutput(JSON.stringify(result));
  else {
    yield* Console.log(
      `Checkpoint ${result.descriptor.digest} · ${result.descriptor.size} bytes · ${result.header.chunks.length} chunk(s) · ${checkpointRecordTotal(result.header)} record(s).`,
    );
    yield* Console.log(
      `Source ${checkpointTerminalText(result.header.repository.displayName)} at ${result.header.source.commit}; logical sha256:${result.header.logical.digest}.`,
    );
  }
  return result;
});
export const runCodeGraphCheckpointVerify = Effect.fn('codeGraph.checkpoint.verifyCommand')(function* (
  options: operations.CodeGraphCheckpointArtifactOptions,
) {
  const result = yield* operations.runCodeGraphCheckpointVerify(options);
  if (options.json) yield* writeFinalCliOutput(JSON.stringify(result));
  else
    yield* Console.log(
      `Verified ${result.descriptor.digest} · ${result.header.chunks.length} chunk(s) · ${checkpointRecordTotal(result.header)} canonical record(s).`,
    );
  return result;
});
export const runCodeGraphCheckpointExport = Effect.fn('codeGraph.checkpoint.exportCommand')(function* (
  config: RuntimeConfig,
  options: operations.CodeGraphCheckpointExportOptions,
) {
  const result = yield* operations.runCodeGraphCheckpointExport(config, options);
  if (options.json) yield* writeFinalCliOutput(JSON.stringify(result));
  else if (!options.quiet)
    yield* Console.log(`Exported code graph checkpoint ${result.artifact.digest}: ${result.output}`);
  return result;
});
export const runCodeGraphCheckpointImport = Effect.fn('codeGraph.checkpoint.importCommand')(function* (
  config: RuntimeConfig,
  options: operations.CodeGraphCheckpointImportOptions,
) {
  const result = yield* operations.runCodeGraphCheckpointImport(config, options);
  if (!options.quiet) {
    if (options.json) yield* writeFinalCliOutput(JSON.stringify(result));
    else
      yield* Console.log(
        `${result.imported === 'created' ? 'Imported' : 'Reused'} code graph checkpoint ${result.artifact.digest}; ${publicationMessage(result.publication)} (${result.snapshotId}).`,
      );
  }
  return result;
});
function checkpointRecordTotal(header: CodeGraphCheckpointHeaderV1): number {
  return EffectArray.reduce(header.chunks, 0, (total, chunk) => total + chunk.recordCount);
}

function publicationMessage(state: operations.CodeGraphCheckpointImportResultV1['publication']): string {
  switch (state) {
    case 'activated':
      return 'activated the exact clean root';
    case 'rebuilt':
      return 'built the current local graph from the imported base';
    case 'stored':
      return 'stored the verified clean root without changing the current view';
  }
}
