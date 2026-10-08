import {Deferred, Effect, Queue, Schema, Stream} from 'effect';
import * as ChildProcess from 'effect/process/ChildProcess';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {resolveCommandInvocation} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import type {ConsolidationModelOption} from '@threadnote/manager/ui/contracts';

export interface ConsolidationModel extends ConsolidationModelOption {
  readonly reasoningEffort?: string;
}
export class ConsolidationModelsError extends Schema.TaggedError<ConsolidationModelsError>()(
  'ConsolidationModelsError',
  {
    message: Schema.String,
  },
) {}
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODEL_PAGES = 8;
const MAX_MODELS = 256;
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const error = (message: string) => ConsolidationModelsError.make({message});

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function validModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 256 &&
    value.trim().length > 0 &&
    [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  );
}
export function normalizeCodexModelPage(value: unknown): {models: ConsolidationModel[]; nextCursor?: string} {
  const page = record(value);
  if (!page || !Array.isArray(page.data)) throw error('Codex returned an invalid model catalog. Reload model choices.');
  const models: ConsolidationModel[] = [];
  const ids = new Set<string>();
  for (const value of page.data) {
    const entry = record(value);
    if (!entry || entry.hidden === true || !validModelId(entry.model) || ids.has(entry.model)) continue;
    ids.add(entry.model);
    const effort = entry.defaultReasoningEffort;
    models.push({
      id: entry.model,
      label:
        typeof entry.displayName === 'string' && entry.displayName.trim() && entry.displayName.length <= 256
          ? entry.displayName
          : entry.model,
      isDefault: entry.isDefault === true,
      ...(typeof effort === 'string' && REASONING_EFFORTS.has(effort) ? {reasoningEffort: effort} : {}),
    });
  }
  const cursor = page.nextCursor;
  if (cursor != null && (typeof cursor !== 'string' || !cursor || cursor.length > 4096)) {
    throw error('Codex returned an invalid model catalog cursor. Reload model choices.');
  }
  return {models, ...(typeof cursor === 'string' ? {nextCursor: cursor} : {})};
}
export function selectConsolidationModel(value: unknown, models: readonly ConsolidationModel[]): ConsolidationModel {
  if (!validModelId(value)) throw error('Choose a model before generating a consolidation draft.');
  const selected = models.find(model => model.id === value);
  if (!selected) throw error('This model is no longer available. Reload model choices and select a model again.');
  return selected;
}

export const discoverConsolidationModels = Effect.fn('manager.discoverConsolidationModels')(function* (
  agent: 'codex' | 'claude',
  executable: string,
) {
  if (agent === 'claude')
    return [
      {id: 'sonnet', label: 'Sonnet', isDefault: true},
      {id: 'opus', label: 'Opus', isDefault: false},
      {id: 'haiku', label: 'Haiku', isDefault: false},
    ] satisfies ConsolidationModel[];
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const policy = yield* ChildEnvironmentPolicy;
      const environment = system.environment();
      const invocation = resolveCommandInvocation(
        executable,
        ['app-server', '--listen', 'stdio://'],
        system.platform,
        environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
      );
      const input = yield* Queue.make<Uint8Array>();
      const handle = yield* ChildProcess.make(invocation.executable, [...invocation.args], {
        env: policy.sanitizeExternal(environment),
        shell: invocation.shell,
        forceKillAfter: 1000,
        stdin: Stream.fromQueue(input),
      });
      let requestId = 0;
      const responses = new Map<number, Deferred.Deferred<unknown, ConsolidationModelsError>>();
      const send = (message: unknown) => Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(message)}\n`));
      const request = (method: string, params: unknown) =>
        Effect.gen(function* () {
          const id = ++requestId;
          const response = yield* Deferred.make<unknown, ConsolidationModelsError>();
          responses.set(id, response);
          yield* send({id, method, params});
          return yield* Deferred.await(response);
        });
      let responseBytes = 0;
      let buffer = '';
      const decoder = new TextDecoder();
      const read = handle.stdout.pipe(
        Stream.runForEach(chunk =>
          Effect.gen(function* () {
            responseBytes += chunk.byteLength;
            if (responseBytes > MAX_RESPONSE_BYTES)
              return yield* error('Codex model catalog exceeded the response limit.');
            buffer += decoder.decode(chunk, {stream: true});
            let newline: number;
            while ((newline = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (!line.trim()) continue;
              const message = yield* Effect.try({
                try: () => record(JSON.parse(line)),
                catch: () => error('Codex returned an invalid model catalog response.'),
              });
              if (!message || typeof message.id !== 'number') continue;
              const response = responses.get(message.id);
              if (!response) continue;
              responses.delete(message.id);
              if (message.error)
                yield* Deferred.fail(
                  response,
                  error('Codex could not load model choices. Check its sign-in and try again.'),
                );
              else yield* Deferred.succeed(response, message.result);
            }
          }),
        ),
        Effect.andThen(
          Effect.fail(error('Codex exited before returning model choices. Check its sign-in and try again.')),
        ),
      );
      let stderrBytes = 0;
      const drain = handle.stderr.pipe(
        Stream.runForEach(chunk => {
          stderrBytes += chunk.byteLength;
          return stderrBytes > MAX_RESPONSE_BYTES
            ? Effect.fail(error('Codex model discovery exceeded the diagnostic limit.'))
            : Effect.void;
        }),
      );
      const discover = Effect.gen(function* () {
        yield* request('initialize', {
          clientInfo: {name: 'threadnote_model_discovery', title: 'Threadnote', version: '1'},
        });
        yield* send({method: 'initialized'});
        const models = new Map<string, ConsolidationModel>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < MAX_MODEL_PAGES; pageIndex += 1) {
          const value = yield* request('model/list', {limit: 100, includeHidden: false, ...(cursor ? {cursor} : {})});
          const page = yield* Effect.try({
            try: () => normalizeCodexModelPage(value),
            catch: cause =>
              Schema.is(ConsolidationModelsError)(cause) ? cause : error('Codex returned an invalid model catalog.'),
          });
          for (const model of page.models) if (!models.has(model.id)) models.set(model.id, model);
          if (models.size > MAX_MODELS) return yield* error('Codex model catalog exceeded the model limit.');
          if (!page.nextCursor) {
            if (!models.size)
              return yield* error('Codex returned no available models. Check its sign-in and reload model choices.');
            return [...models.values()];
          }
          if (cursors.has(page.nextCursor)) return yield* error('Codex returned a repeated model catalog page.');
          cursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
        return yield* error('Codex model catalog exceeded the page limit.');
      });
      return yield* Effect.raceFirst(
        discover,
        Effect.all([read, drain], {concurrency: 'unbounded'}).pipe(
          Effect.andThen(Effect.fail(error('Codex exited before returning model choices.'))),
        ),
      );
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: 15_000,
      orElse: () => Effect.fail(error('Codex model discovery timed out. Check its sign-in and reload model choices.')),
    }),
    Effect.mapError(cause =>
      Schema.is(ConsolidationModelsError)(cause)
        ? cause
        : error('Could not load Codex model choices. Check that Codex is installed and signed in.'),
    ),
  );
});
