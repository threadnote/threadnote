import {Console, Effect} from 'effect';
import {Command} from 'effect/cli';
import {applicationError, errorMessage} from '@threadnote/platform/errors';
import {runRepair} from '../lifecycle.js';
import {codexOwnerRefreshInputError, runCodexOwnerRefresh} from '../mcp/codex_broker_reload.js';
import {maybeNotifyUpdate} from '../release/index.js';
import {boolean, defaultString, negatedBoolean, optionalString} from './cli/flags.js';
import type {CliRuntimeRunner} from './cli_runtime_contract.js';
import {ensureLocalAiStarted, readLocalAiSettings, runLocalAiStart} from './local-ai.js';

export function makeRepairCommand(withRuntimeEffect: CliRuntimeRunner) {
  return Command.make(
    'repair',
    {
      codexReloadSocket: optionalString(
        'codex-reload-socket',
        'Request a reload on the physical Codex Unix socket in its private owner directory. Applies all pending MCP edits for that owner. Requires --mcp codex and --codex-reload-thread.',
      ),
      codexReloadThread: optionalString('codex-reload-thread', 'A chat ID already loaded by the selected Codex owner'),
      coreOnly: boolean('core-only', 'Repair core state and indexes without host instructions, hooks, or MCP settings'),
      deep: boolean('deep', 'Run explicit full SQLite integrity, foreign-key, and derived-state cleanup checks'),
      dryRun: boolean('dry-run', 'Print the repair actions without making changes'),
      mcp: defaultString(
        'mcp',
        'MCP clients: available, all, none, codex, claude, cursor, copilot, omp, or comma-separated list',
        'available',
      ),
      postUpdate: negatedBoolean('post-update', 'Skip post-update migration prompts after repair'),
    },
    options => {
      const socket = options.codexReloadSocket;
      const threadId = options.codexReloadThread;
      if (socket !== undefined || threadId !== undefined) {
        const operation = 'request Codex MCP owner refresh';
        if (
          socket === undefined ||
          threadId === undefined ||
          options.mcp !== 'codex' ||
          options.coreOnly ||
          options.deep
        ) {
          return Effect.fail(
            applicationError(
              operation,
              new Error(
                'Use --mcp codex, --codex-reload-socket and --codex-reload-thread together. Run core or deep repair separately.',
              ),
            ),
          );
        }
        const opts = {socket, threadId, dryRun: options.dryRun};
        const invalid = codexOwnerRefreshInputError(opts);
        if (invalid !== undefined) return Effect.fail(applicationError(operation, new Error(invalid)));
        return withRuntimeEffect(config => runCodexOwnerRefresh(config, opts).pipe(Effect.asVoid));
      }
      return withRuntimeEffect(config =>
        Effect.gen(function* () {
          yield* runRepair(config, options);
          if ((yield* readLocalAiSettings(config))?.enabled === true) {
            if (options.dryRun) {
              yield* runLocalAiStart(config, {dryRun: true});
            } else {
              yield* ensureLocalAiStarted(config).pipe(
                Effect.catch(error => Console.warn(`WARN could not repair local AI health: ${errorMessage(error)}`)),
              );
            }
          }
          yield* maybeNotifyUpdate(config, {dryRun: options.dryRun});
        }),
      );
    },
  ).pipe(Command.withDescription('Repair Threadnote storage, derived indexes, hooks, and MCP configuration'));
}
