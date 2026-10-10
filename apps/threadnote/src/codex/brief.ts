import {Effect, Path} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {compileScopedContextBrief} from '../context_brief/index.js';
import type {RunContextBriefOptionsV1} from '../context_brief/commands.js';
import {writeFinalCliOutput} from '../effect/cli/output.js';
import {cursorCloudScopeRoots} from '../cursor/cloud.js';
import {codexCloudMemoryScope} from './cloud.js';
import {CodexCloudError} from './profile.js';

export const runCodexCloudBrief = Effect.fn('codexCloud.brief')(function* (
  config: RuntimeConfig,
  options: Omit<RunContextBriefOptionsV1, 'workset'> & {readonly cwd: string; readonly team?: string},
) {
  const path = yield* Path.Path;
  if (!path.isAbsolute(options.cwd))
    return yield* CodexCloudError.make({message: 'Codex Cloud brief --cwd must be an absolute checkout path.'});
  const scope = yield* codexCloudMemoryScope(config, options.team, true);
  const projected = yield* compileScopedContextBrief(
    config,
    {
      budgetTokens: options.budgetTokens,
      codeRefs: options.codeRefs ?? [],
      detail: options.detail,
      mode: options.mode,
      responseFormat: 'agent',
      scope: {callerCwd: options.cwd, kind: 'repository', project: options.project},
      task: options.task,
    },
    cursorCloudScopeRoots(scope),
  );
  yield* writeFinalCliOutput(options.json ? JSON.stringify(projected.structuredContent) : projected.text.trimEnd());
});
