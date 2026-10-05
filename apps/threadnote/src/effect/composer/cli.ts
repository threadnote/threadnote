import {makeGitWorktreeLock} from '../git_worktree_lock.js';
import {Console, Effect, Schema} from 'effect';
import {Command} from 'effect/cli';
import {applicationError, fromPromiseInterruptibleAwaiting} from '@threadnote/platform/errors';
import {boolean, optionalString} from '../cli/flags.js';
import {SystemInfo} from '@threadnote/platform/system';
import {resolveTeam} from '../../share/core.js';
import {resolveComposerServeShareId} from '../../mcp/composer_attach.js';
import {LOCAL_COMPOSER_DEFAULT_LISTEN} from '../../remote_memory/local_idp.js';
import {runComposerServe} from '../../remote_memory/composer_serve.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';

class ComposerServeError extends Schema.TaggedError<ComposerServeError>()('ComposerServeError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export function makeComposerCommands(
  withRuntimeEffect: <E, R>(effect: (config: RuntimeConfig) => Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>,
) {
  const composerServe = Command.make(
    'serve',
    {
      databaseUrl: optionalString('database-url', 'PostgreSQL URL for the composer control plane and search index'),
      gitWorktree: optionalString('git-worktree', 'Absolute git worktree of the existing team memory share'),
      listen: optionalString(
        'listen',
        'Loopback host:port for the Git composer and local OAuth issuer (default 127.0.0.1:18788)',
      ),
      push: boolean('push', 'Push Git memory commits to the configured team remote (default off)'),
      shareId: optionalString('share-id', 'Control-plane share id bound to the Git team share'),
      subject: optionalString('subject', 'OAuth subject provisioned for the local issuer'),
      team: optionalString('team', 'Existing Git memory team; defaults to the teams.json default team'),
    },
    options => withRuntimeEffect(config => runComposerServeCommand(config, options)),
  ).pipe(
    Command.withDescription(
      'Serve a loopback Git-backed organization composer with a local OAuth issuer against the existing team share',
    ),
  );

  return Command.make('composer').pipe(
    Command.withDescription('Serve the organization Git memory composer for credential-less agents'),
    Command.withSubcommands([composerServe]),
  );
}

export const runComposerServeCommand = Effect.fn('composer.serveCommand')(function* (
  config: RuntimeConfig,
  options: {
    readonly databaseUrl?: string;
    readonly gitWorktree?: string;
    readonly listen?: string;
    readonly push?: boolean;
    readonly shareId?: string;
    readonly subject?: string;
    readonly team?: string;
  },
) {
  const system = yield* SystemInfo;
  const team = yield* resolveTeam(config, options.team);
  const databaseUrl = options.databaseUrl?.trim() || system.environment().THREADNOTE_REMOTE_DATABASE_URL?.trim();
  if (!databaseUrl) {
    return yield* ComposerServeError.make({
      message: 'Composer serve requires --database-url or THREADNOTE_REMOTE_DATABASE_URL.',
    });
  }
  const shareId = yield* Effect.try({
    try: () => resolveComposerServeShareId(team.name, options.shareId),
    catch: cause =>
      ComposerServeError.make({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  const gitWorktree = options.gitWorktree?.trim() || team.config.worktree;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const worktreeLock = yield* makeGitWorktreeLock();
      yield* Console.consoleWith(output =>
        fromPromiseInterruptibleAwaiting(
          signal =>
            runComposerServe(
              {
                databaseUrl,
                executablePath: system.executablePath,
                gitCloneUrl: team.config.remote,
                gitPush: options.push === true,
                gitWorktree,
                listen: options.listen?.trim() || LOCAL_COMPOSER_DEFAULT_LISTEN,
                shareId,
                subject: options.subject?.trim() || `local:${config.user}`,
                tenantId: 'local-org',
              },
              {
                error: message => {
                  output.error(message);
                },
                shutdownSignal: () => shutdownFromAbort(signal),
                worktreeLock,
              },
            ),
          cause => applicationError('composer serve', cause),
        ),
      );
    }),
  );
});

function shutdownFromAbort(signal: AbortSignal): {
  readonly dispose: () => void;
  readonly promise: Promise<string>;
} {
  const {promise, resolve} = Promise.withResolvers<string>();
  const onAbort = () => resolve('runtime interruption');
  signal.addEventListener('abort', onAbort, {once: true});
  if (signal.aborted) onAbort();
  return {
    dispose: () => signal.removeEventListener('abort', onAbort),
    promise,
  };
}
