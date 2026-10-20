import {Console, Effect, FileSystem, Path} from 'effect';
import {runDetachedCommandEffect} from '@threadnote/platform/command';
import {SystemInfo, runtimeLstat} from '@threadnote/platform/system';
import {fromPromise} from '@threadnote/platform/errors';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {withStandaloneProcessLease} from '../process/standalone_lease.js';
import {withSetupMutationLock} from '../setup/lock.js';
import {activeInstalledRelease, executingInstalledRelease} from '../installations.js';
import {automaticModelSetupRuntimeAllowed, modelSetupWorkerEnvironment, requestModelSetup} from './setup.js';

export const MODEL_SETUP_REQUEST_ARGUMENT = 'model-setup-request';
export const MODEL_SETUP_RETRY_TICK_MILLISECONDS = 60_000;

export interface AutomaticModelSetupHome {
  readonly home: string;
  readonly identity: string;
}

/** A queued request binds the existing directory, not just a path that could be erased/recreated. */
export const captureAutomaticModelSetupHome = Effect.fn('models.setup.captureHome')(
  function* (home: string) {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(home))) return undefined;
    const canonical = yield* fs.realPath(home);
    const info = yield* fromPromise('observe model setup home identity', () => runtimeLstat(canonical));
    if (!info.isDirectory() || info.dev < 0n || info.ino <= 0n || info.birthtimeNs <= 0n) return undefined;
    return {home: canonical, identity: `${info.dev}:${info.ino}:${info.birthtimeNs}`} satisfies AutomaticModelSetupHome;
  },
  Effect.orElseSucceed(() => undefined),
);

const automaticRuntimeAllowed = Effect.fn('models.setup.automaticRuntimeAllowed')(function* () {
  const system = yield* SystemInfo;
  return (
    system.environment().THREADNOTE_MODEL_SETUP !== 'off' &&
    automaticModelSetupRuntimeAllowed(system, yield* getThreadnoteVersion())
  );
});

/** Only the validated active release owns automatic catalog intent; preserved older sessions are read-only here. */
const automaticRuntimeIsActive = Effect.fn('models.setup.automaticRuntimeIsActive')(function* () {
  const active = yield* activeInstalledRelease();
  if (!active) return false;
  const executing = yield* executingInstalledRelease();
  return executing?.version === active.version && executing.releaseRoot === active.releaseRoot;
});

const sameHome = (left: AutomaticModelSetupHome | undefined, right: AutomaticModelSetupHome) =>
  left?.home === right.home && left.identity === right.identity;

const deferredNotice = () =>
  Console.error(
    'Gemma background setup is deferred. The Threadnote installation remains usable. Check `threadnote models setup --status` and retry when ready.',
  );

/** The external home lock also fences uninstall. No home initialization occurs before both identity checks. */
export const runAutomaticModelSetupRequest = Effect.fn('models.setup.automaticRequest')(
  function* (binding: AutomaticModelSetupHome) {
    if (!(yield* automaticRuntimeAllowed()) || !(yield* automaticRuntimeIsActive())) return;
    if (!sameHome(yield* captureAutomaticModelSetupHome(binding.home), binding)) return;
    yield* withSetupMutationLock(
      binding.home,
      Effect.gen(function* () {
        if (
          !(yield* automaticRuntimeIsActive()) ||
          !sameHome(yield* captureAutomaticModelSetupHome(binding.home), binding)
        )
          return;
        yield* requestModelSetup(binding.home, {automatic: true});
      }),
    );
  },
  Effect.catch(() => deferredNotice()),
);

export function automaticModelSetupEnvironment(environment: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const result = modelSetupWorkerEnvironment(environment, home);
  for (const key of ['CI', 'VITEST', 'NODE_ENV', 'THREADNOTE_TOOLSET', 'THREADNOTE_MCP_TOOLSET']) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  return result;
}

/** Install/update only launches a coordinator; download, verification and retries never block their foreground. */
export const queueAutomaticModelSetup = Effect.fn('models.setup.queueAutomatic')(
  function* (
    home: string,
    options: {readonly dryRun?: boolean; readonly modelSetup?: boolean; readonly executable?: string} = {},
  ) {
    if (options.dryRun || options.modelSetup === false || !(yield* automaticRuntimeAllowed())) return;
    const binding = yield* captureAutomaticModelSetupHome(home);
    if (!binding) return;
    const system = yield* SystemInfo;
    // An older updater may have promoted B already; its explicitly selected B child checks its own active identity.
    const executable = options.executable ?? system.executablePath;
    const started = yield* runDetachedCommandEffect(
      executable,
      [MODEL_SETUP_REQUEST_ARGUMENT, '--home', binding.home, '--identity', binding.identity],
      {cwd: binding.home, env: automaticModelSetupEnvironment(system.environment(), binding.home)},
    );
    if (!started) yield* deferredNotice();
  },
  Effect.catch(() => deferredNotice()),
);

/** Correctly bound startup is also the compatibility path for predecessors that omitted --home in repair children. */
export const startAutomaticModelSetupScheduler = Effect.fn('models.setup.startAutomaticScheduler')(
  function* (home: string) {
    if (!(yield* automaticRuntimeAllowed())) return;
    const binding = yield* captureAutomaticModelSetupHome(home);
    if (!binding) return;
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        for (;;) {
          if (
            !(yield* automaticRuntimeIsActive()) ||
            !sameHome(yield* captureAutomaticModelSetupHome(binding.home), binding)
          )
            return;
          yield* runAutomaticModelSetupRequest(binding);
          yield* Effect.sleep(MODEL_SETUP_RETRY_TICK_MILLISECONDS);
        }
      }),
    );
  },
  Effect.catch(() => deferredNotice()),
);

export function parseAutomaticModelSetupArguments(arguments_: readonly string[]): AutomaticModelSetupHome | undefined {
  if (arguments_.length !== 4 || arguments_[0] !== '--home' || arguments_[2] !== '--identity') return undefined;
  const [, home, , identity] = arguments_;
  if (!home || home.length > 4096 || !/^\d+:\d+:-?\d+$/.test(identity) || identity.length > 100) return undefined;
  return {home, identity};
}

/** Early standalone dispatch: no CLI configuration, telemetry, logger or application bootstrap can create a home. */
export const runAutomaticModelSetupChild = Effect.fn('models.setup.automaticChild')(
  function* (arguments_: readonly string[]) {
    const binding = parseAutomaticModelSetupArguments(arguments_);
    const path = yield* Path.Path;
    if (
      !binding ||
      !path.isAbsolute(binding.home) ||
      !(yield* automaticRuntimeAllowed()) ||
      !(yield* automaticRuntimeIsActive())
    )
      return;
    if (!sameHome(yield* captureAutomaticModelSetupHome(binding.home), binding)) return;
    yield* withStandaloneProcessLease(runAutomaticModelSetupRequest(binding));
  },
  Effect.catch(() => deferredNotice()),
);
