import {errorMessage} from '@threadnote/platform/errors';
import {Cause, Console, Effect, Exit} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {EffectMcpServerRegistry} from '../effect/ai/mcp.js';
import {captureConsoleWithoutProgress} from '../effect/console.js';
import {registerListTool} from '../mcp/server/list.js';
import {registerReadTool, registerSearchTool} from '../mcp/server/recall.js';
import {registerStoreTool} from '../mcp/server/store.js';
import {codexCloudMemoryScope} from './cloud.js';
import {CodexCloudError} from './profile.js';

export type CodexCloudMemoryOperation = 'recall' | 'read' | 'list' | 'remember';

/** CLI and MCP use the same validated handlers, application services and Git publication boundary. */
export const runCodexCloudMemory = Effect.fn('codexCloud.memory')(function* (
  config: RuntimeConfig,
  operation: CodexCloudMemoryOperation,
  options: Record<string, unknown>,
  json: boolean,
) {
  const scope = yield* codexCloudMemoryScope(
    config,
    typeof options.team === 'string' ? options.team : undefined,
    operation === 'read' || operation === 'list',
  );
  const registry = new EffectMcpServerRegistry();
  registerSearchTool(
    registry,
    config,
    'recall',
    'Recall Codex Cloud memories',
    {heartbeatMilliseconds: 10_000, sharedSyncDelayMilliseconds: 0},
    scope,
  );
  registerReadTool(registry, config, 'read', 'Read Codex Cloud memories', scope);
  registerListTool(registry, config, 'list', 'List Codex Cloud memories', scope);
  registerStoreTool(registry, config, 'remember', 'Remember Codex Cloud context', scope);
  const args = Object.fromEntries(
    Object.entries({...options, sourceAgentClient: 'codex', ...(json ? {responseFormat: 'dual'} : {})}).filter(
      ([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0),
    ),
  );
  const outcome = yield* captureConsoleWithoutProgress(registry.invokeTool(operation, args)).pipe(Effect.exit);
  if (Exit.isFailure(outcome)) {
    const message = errorMessage(Cause.squash(outcome.cause));
    if (json) yield* Console.log(JSON.stringify({content: [{type: 'text', text: message}], isError: true}));
    yield* Console.error(message);
    return yield* CodexCloudError.make({message: `Codex Cloud ${operation} failed.`});
  }
  const captured = outcome.value;
  if (captured.output) yield* Console.error(captured.output);
  const result = captured.value;
  if (json) yield* Console.log(JSON.stringify(result));
  else
    for (const item of result.content)
      if (item.type === 'text') yield* result.isError ? Console.error(item.text) : Console.log(item.text);
  if (json && result.isError)
    for (const item of result.content) if (item.type === 'text') yield* Console.error(item.text);
  if (result.isError)
    return yield* CodexCloudError.make({message: `Codex Cloud ${operation} failed; see the diagnostic above.`});
});
