import {Effect} from 'effect';
import {writeFinalCliOutput} from '../effect/cli/output.js';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {compileContextBrief} from './index.js';
import type {ContextBriefDetail, ContextBriefMode} from '@threadnote/context/types';

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
  const workset = options.workset?.trim();
  const cwd = options.cwd?.trim() || (yield* SystemInfo).currentDirectory();
  const projected = yield* compileContextBrief(config, {
    ...(options.budgetTokens === undefined ? {} : {budgetTokens: options.budgetTokens}),
    codeRefs: options.codeRefs ?? [],
    ...(options.detail === undefined ? {} : {detail: options.detail}),
    ...(options.mode === undefined ? {} : {mode: options.mode}),
    responseFormat: 'agent',
    scope: workset
      ? {kind: 'workset', name: workset, ...(options.project?.trim() ? {project: options.project.trim()} : {})}
      : {callerCwd: cwd, kind: 'repository', ...(options.project?.trim() ? {project: options.project.trim()} : {})},
    ...(options.surface?.trim() ? {surface: options.surface.trim()} : {}),
    task: options.task,
  });
  yield* writeFinalCliOutput(options.json ? JSON.stringify(projected.structuredContent) : projected.text.trimEnd());
});
