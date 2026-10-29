import {Console, Effect, Path, Schema} from 'effect';
import {runIsolatedCodeGraphIndexSnapshot} from '@threadnote/graph/isolated/index';
import {resolveAndRecordCodeGraphLocalAssociation} from '@threadnote/graph/local_provenance';
import {captureConsole} from '../../effect/console.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {errorMessage} from '@threadnote/platform/errors';
import {requireString} from '@threadnote/manager/request_inputs';

class ManagerExplicitGraphActionError extends Schema.TaggedError<
  ManagerExplicitGraphActionError,
  {readonly brand: unique symbol}
>()('ManagerExplicitGraphActionError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export const runManagerExplicitCwdGraphIndex = Effect.fn('managerGraphActions.runExplicitCwdGraphIndex')(function* (
  config: RuntimeConfig,
  body: Record<string, unknown>,
) {
  const suppliedCwd = yield* Effect.try({
    try: () => requireString(body.cwd, 'cwd'),
    catch: cause => ManagerExplicitGraphActionError.make({cause, message: errorMessage(cause)}),
  });
  const path = yield* Path.Path;
  if (!path.isAbsolute(suppliedCwd)) {
    return yield* ManagerExplicitGraphActionError.make({message: 'Supply cwd as an absolute local worktree path.'});
  }
  const {identity} = yield* resolveAndRecordCodeGraphLocalAssociation(config.agentContextHome, suppliedCwd).pipe(
    Effect.mapError(() =>
      ManagerExplicitGraphActionError.make({
        message: 'The selected workspace is not an available local Git repository. Check its path and retry.',
      }),
    ),
  );
  const captured = yield* captureConsole(
    runIsolatedCodeGraphIndexSnapshot({
      manifestPath: config.manifestPath,
      cwd: identity.repoRoot,
      expectedIdentity: {
        checkoutId: identity.checkoutId,
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
      },
      force: body.full === true,
      threadnoteHome: config.agentContextHome,
    }).pipe(
      Effect.tap(summary =>
        Console.log(
          `Ready in an isolated process · ${summary.snapshot.fileCount.toLocaleString()} files · ` +
            `${summary.snapshot.symbolCount.toLocaleString()} symbols · ` +
            `${summary.snapshot.edgeCount.toLocaleString()} edges`,
        ),
      ),
    ),
  );
  const result = {
    output: captured.output,
    snapshot: {
      commit: captured.value.snapshot.commit,
      dirty: captured.value.snapshot.dirty,
      id: captured.value.snapshot.id,
    },
  };
  return body.action === 'index-cwd' ? {output: result.output} : result;
});
