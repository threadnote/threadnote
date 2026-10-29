import {Array as EffectArray, Effect, FileSystem, Path, Schema} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {shellQuote} from '../utils.js';
import type {ConsolidationModel} from './consolidation_models.js';
import type {AgentClient} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MAX_DRAFT_BYTES = 32 * 1024;

export class ConsolidationAgentError extends Schema.TaggedError<
  ConsolidationAgentError,
  {readonly brand: unique symbol}
>()('ConsolidationAgentError', {
  message: Schema.String,
}) {}

export function consolidationAgentScript(agent: AgentClient, executable: string, model?: ConsolidationModel): string {
  const modelFlag = model ? ` --model ${shellQuote(model.id)}` : '';
  const effortFlag = model?.reasoningEffort
    ? ` -c ${shellQuote(`model_reasoning_effort=${JSON.stringify(model.reasoningEffort)}`)}`
    : '';
  if (agent === 'codex') {
    return `${shellQuote(executable)} exec${modelFlag}${effortFlag} --sandbox read-only --skip-git-repo-check --json --output-last-message "$2" - < "$1"`;
  }
  if (agent === 'claude') {
    return `${shellQuote(executable)} --print${modelFlag} --permission-mode default < "$1"`;
  }
  throw ConsolidationAgentError.make({
    message: `${agent} does not expose a supported non-interactive consolidation mode.`,
  });
}

export const runConsolidationAgentCommand = Effect.fn('manager.runConsolidationAgentCommand')(function* (
  agent: 'codex' | 'claude',
  executable: string,
  prompt: string,
  model?: ConsolidationModel,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stagingDir = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-consolidate-'});
      const promptPath = path.join(stagingDir, 'prompt.txt');
      const finalPath = path.join(stagingDir, 'final.txt');
      yield* fs.writeFileString(promptPath, prompt, {mode: 0o600});
      const script = consolidationAgentScript(agent, executable, model);
      const result = yield* runCommandEffect('sh', ['-lc', script, 'threadnote-consolidate', promptPath, finalPath], {
        allowFailure: true,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: 10 * 60 * 1000,
      });

      if (agent === 'codex') {
        const structuredFailure = codexFailureMessage(result.stdout, result.exitCode);
        if (structuredFailure) return yield* fail(structuredFailure);
        if (result.exitCode !== 0) return yield* fail(processFailureMessage(agent, result));
        const info = yield* fs
          .stat(finalPath)
          .pipe(Effect.mapError(() => ConsolidationAgentError.make({message: 'codex returned no final answer.'})));
        if (info.type !== 'File' || info.size > BigInt(MAX_DRAFT_BYTES))
          return yield* fail('codex final answer exceeded the 32 KiB consolidation limit.');
        const draft = yield* fs
          .readFileString(finalPath)
          .pipe(Effect.mapError(() => ConsolidationAgentError.make({message: 'codex returned no final answer.'})));
        if (new TextEncoder().encode(draft).byteLength > MAX_DRAFT_BYTES)
          return yield* fail('codex final answer exceeded the 32 KiB consolidation limit.');
        if (!Effect2.pipe(draft, EffectString.trim)) return yield* fail('codex returned an empty final answer.');
        return Effect2.pipe(draft, EffectString.trim);
      }

      if (result.exitCode !== 0) return yield* fail(processFailureMessage(agent, result));
      const draft = Effect2.pipe(result.stdout, EffectString.trim);
      if (!draft) return yield* fail('claude returned an empty consolidation draft.');
      return draft;
    }),
  );
});

function fail(message: string) {
  return Effect.fail(ConsolidationAgentError.make({message}));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function processFailureMessage(agent: string, result: {exitCode: number; stdout: string; stderr: string}): string {
  const diagnostic = Effect2.pipe(
    Effect2.pipe(result.stderr, EffectString.trim) || Effect2.pipe(result.stdout, EffectString.trim),
    EffectString.slice(-500),
  );
  return `${agent} exited with ${result.exitCode}.${diagnostic ? `\n${diagnostic}` : ''}`;
}

function codexFailureMessage(output: string, exitCode: number): string | undefined {
  let lastError: string | undefined;
  for (const line of Effect2.pipe(output, EffectString.split('\n'))) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    const record = event;
    const type = typeof record.type === 'string' ? Effect2.pipe(record.type, EffectString.toLowerCase) : '';
    if (type !== 'error' && type !== 'turn.failed') continue;
    const nested = record.error;
    const nestedMessage = isRecord(nested) ? nested.message : nested;
    const message = typeof record.message === 'string' ? record.message : nestedMessage;
    const detail =
      typeof message === 'string' && Effect2.pipe(message, EffectString.trim)
        ? `codex failed: ${Effect2.pipe(message, EffectString.trim, EffectString.slice(0, 500))}`
        : 'codex reported a failed turn.';
    if (type === 'turn.failed') return detail;
    lastError = detail;
  }
  return exitCode !== 0 ? lastError : undefined;
}
