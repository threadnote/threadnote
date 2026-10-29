import {Effect} from 'effect';
import {writeFinalCliOutput} from '../effect/cli/output.js';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {compileContextBrief} from './index.js';
import type {ContextBriefDetail, ContextBriefMode} from '@threadnote/context/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CONTEXT_BRIEF_CWD_OPTION = {
  name: 'cwd',
} as const;

export interface RunContextBriefOptionsV1 {
  readonly budgetTokens?: number;
  readonly codeRefs?: readonly string[];
  readonly cwd?: string;
  readonly detail?: ContextBriefDetail;
  readonly json?: boolean;
  readonly mode?: ContextBriefMode;
  readonly project?: string;
  readonly surface?: string;
  readonly task: string;
  readonly workset?: string;
}

export const runContextBrief = Effect.fn('contextBrief.command.compile')(function* (
  config: RuntimeConfig,
  options: RunContextBriefOptionsV1,
) {
  const workset = Effect2.pipe(options.workset, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  const cwd =
    Effect2.pipe(options.cwd, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) || (yield* SystemInfo).currentDirectory();
  const projected = yield* compileContextBrief(config, {
    ...(options.budgetTokens === undefined ? {} : {budgetTokens: options.budgetTokens}),
    codeRefs: options.codeRefs ?? [],
    ...(options.detail === undefined ? {} : {detail: options.detail}),
    ...(options.mode === undefined ? {} : {mode: options.mode}),
    responseFormat: 'agent',
    scope: workset
      ? {
          kind: 'workset',
          name: workset,
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The optional-chain guard narrows `options.project` for the property value.
          ...(options.project?.trim() ? {project: options.project.trim()} : {}),
        }
      : {
          callerCwd: cwd,
          kind: 'repository',
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The optional-chain guard narrows `options.project` for the property value.
          ...(options.project?.trim() ? {project: options.project.trim()} : {}),
        },
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The optional-chain guard narrows `options.surface` for the property value.
    ...(options.surface?.trim() ? {surface: options.surface.trim()} : {}),
    task: options.task,
  });
  yield* writeFinalCliOutput(
    options.json ? JSON.stringify(projected.structuredContent) : Effect2.pipe(projected.text, EffectString.trimEnd),
  );
});
