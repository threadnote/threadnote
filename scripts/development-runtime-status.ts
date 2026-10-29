import {ScriptCommandExecutorLayer} from './effect/system-layer.js';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {printJson, scriptArguments} from './effect/script.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Array as EffectArray, Console, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {installationRoot} from '@threadnote/threadnote/installations';
import {developmentBuildVersion} from './development-runtime.js';
import {
  CLEAN_GIT_STATUS_ARGUMENTS,
  developmentRuntimeOwnershipConflict,
  developmentSourceCheckoutId,
  readDevelopmentRuntimeOwnershipSnapshot,
  type DevelopmentRuntimeOwnershipConflict,
  type DevelopmentRuntimeOwnershipState,
} from './install-local-standalone.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ROOT_URL = new URL('..', import.meta.url);

export interface DevelopmentRuntimeStatusOptions {
  readonly json: boolean;
}

export interface DevelopmentInstallAdvice {
  readonly blockedReason: string | undefined;
  readonly canInstallWithoutTakeOver: boolean;
  readonly requiresTakeOver: boolean;
  readonly suggestedCommand: string;
}

export interface DevelopmentRuntimeStatusReport {
  readonly checkout: {
    readonly dirty: boolean;
    readonly expectedDevelopmentVersion: string | undefined;
    readonly head: string;
    readonly packageVersion: string;
    readonly sourceCheckoutId: string;
    readonly sourceRoot: string;
  };
  readonly install: DevelopmentInstallAdvice;
  readonly runtime: {
    readonly activeVersion: string | undefined;
    readonly conflict: DevelopmentRuntimeOwnershipConflict | undefined;
    readonly ownedByThisCheckout: boolean;
    readonly owner: DevelopmentRuntimeOwnershipState;
  };
}

export function parseDevelopmentRuntimeStatusArguments(arguments_: readonly string[]): DevelopmentRuntimeStatusOptions {
  let json = false;
  for (const argument of arguments_) {
    if (argument === '--') continue;
    if (argument === '--json') json = true;
    else throw ScriptError.make({message: `Unknown development runtime status option: ${argument}`});
  }
  return {json};
}

export function resolveDevelopmentInstallAdvice(input: {
  readonly conflict: DevelopmentRuntimeOwnershipConflict | undefined;
  readonly dirty: boolean;
}): DevelopmentInstallAdvice {
  if (input.dirty) {
    return {
      blockedReason: 'Refusing a global development install from a dirty Threadnote checkout.',
      canInstallWithoutTakeOver: false,
      requiresTakeOver: false,
      suggestedCommand: 'Commit or restore the worktree so HEAD is clean, then rerun bun run dev:runtime-status.',
    };
  }
  if (input.conflict !== undefined) {
    return {
      blockedReason:
        input.conflict === 'different-source-checkout'
          ? 'another source checkout owns the active global development runtime'
          : input.conflict === 'untracked-development-activation'
            ? 'the active global development runtime changed outside its owning installer'
            : 'the active global development runtime ownership record is invalid',
      canInstallWithoutTakeOver: false,
      requiresTakeOver: true,
      suggestedCommand: 'bun run dev:install-global -- --take-over-global-runtime --terminate-superseded',
    };
  }
  return {
    blockedReason: undefined,
    canInstallWithoutTakeOver: true,
    requiresTakeOver: false,
    suggestedCommand: 'bun run dev:install-global -- --terminate-superseded',
  };
}

export const inspectDevelopmentRuntimeStatus = Effect.fn('developmentRuntimeStatus.inspect')(function* (
  sourceRoot?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const checkoutRoot = sourceRoot ?? (yield* path.fromFileUrl(ROOT_URL));
  const git = Option.fromNullishOr(Bun.which('git'));
  if (Option.isNone(git)) {
    return yield* ScriptError.make({message: 'Git is required to inspect the development runtime.'});
  }
  const [sourceCommit, status] = yield* Effect.all(
    [
      runCommandEffect(git.value, ['rev-parse', 'HEAD'], {cwd: checkoutRoot}),
      runCommandEffect(git.value, [...CLEAN_GIT_STATUS_ARGUMENTS], {cwd: checkoutRoot}),
    ],
    {concurrency: 2},
  );
  const commit = Effect2.pipe(sourceCommit.stdout, EffectString.trim);
  if (!GIT_COMMIT_PATTERN.test(commit)) {
    return yield* ScriptError.make({message: 'The Threadnote checkout did not resolve to an exact Git commit.'});
  }
  const manifest = yield* fs.readFileString(path.join(checkoutRoot, 'package.json')).pipe(
    Effect.flatMap(source =>
      Effect.try({
        try: (): unknown => JSON.parse(source),
        catch: cause => ScriptError.make({message: 'Could not parse package.json.', cause}),
      }),
    ),
  );
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    EffectArray.isArray(manifest) ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string' ||
    manifest.version.length === 0
  ) {
    return yield* ScriptError.make({message: 'package.json does not declare a version.'});
  }
  const packageVersion = manifest.version;
  const expectedDevelopmentVersion = yield* Effect.sync(() => {
    try {
      return developmentBuildVersion(packageVersion, commit);
    } catch {
      return undefined;
    }
  });
  const sourceCheckoutId = yield* developmentSourceCheckoutId(checkoutRoot);
  const installRoot = path.resolve(installationRoot(path, system));
  const {activeVersion, owner} = yield* readDevelopmentRuntimeOwnershipSnapshot(installRoot);
  const conflict = developmentRuntimeOwnershipConflict(activeVersion, owner, sourceCheckoutId);
  const dirty = status.stdout.length > 0;
  return {
    checkout: {
      dirty,
      expectedDevelopmentVersion,
      head: commit,
      packageVersion,
      sourceCheckoutId,
      sourceRoot: checkoutRoot,
    },
    install: resolveDevelopmentInstallAdvice({conflict, dirty}),
    runtime: {
      activeVersion,
      conflict,
      ownedByThisCheckout:
        owner !== 'absent' &&
        owner !== 'invalid' &&
        owner.sourceCheckoutId === sourceCheckoutId &&
        owner.version === activeVersion,
      owner,
    },
  } satisfies DevelopmentRuntimeStatusReport;
});

const systemLayer = ScriptSystemInfoLayer;
const commandLayer = ScriptCommandExecutorLayer.pipe(Layer.provide(systemLayer));
const statusLayer = Layer.merge(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));
const program = Effect.gen(function* () {
  const options = parseDevelopmentRuntimeStatusArguments(yield* scriptArguments());
  const report = yield* inspectDevelopmentRuntimeStatus();
  if (options.json) {
    yield* printJson(report);
    return report;
  }
  yield* Console.log(`Checkout: ${report.checkout.sourceRoot}`);
  yield* Console.log(`HEAD: ${report.checkout.head}${report.checkout.dirty ? ' (dirty)' : ''}`);
  yield* Console.log(`Package version: ${report.checkout.packageVersion}`);
  if (report.checkout.expectedDevelopmentVersion !== undefined) {
    yield* Console.log(`Expected development version: ${report.checkout.expectedDevelopmentVersion}`);
  }
  yield* Console.log(`Active runtime: ${report.runtime.activeVersion ?? 'none'}`);
  yield* Console.log(
    report.install.canInstallWithoutTakeOver
      ? `Ready: ${report.install.suggestedCommand}`
      : `Blocked: ${report.install.blockedReason}. ${report.install.suggestedCommand}`,
  );
  return report;
});

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, statusLayer));
