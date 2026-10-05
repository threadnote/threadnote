import {Console, Crypto, Effect, FileSystem, Option, Path, PlatformError, Schema} from 'effect';
import {CODEX_HOOKS_PATH, HOOK_CODEX_RESUME_COMMAND} from '../constants.js';
import {expandPath} from '@threadnote/platform/paths';
import {isJsonObject, parseJsonConfigObject} from '../utils.js';
import type {HooksInstallOptions} from '../types.js';
import type {JsonObject} from '@threadnote/platform/json';

export const CODEX_RESUME_ADDITIONAL_CONTEXT_LIMIT = 800 as const;

class CodexHooksConfigError extends Schema.TaggedError<CodexHooksConfigError>()('CodexHooksConfigError', {
  message: Schema.String,
}) {}

const managedCommand = {
  type: 'command',
  command: HOOK_CODEX_RESUME_COMMAND,
  timeout: 15,
  statusMessage: 'Loading Threadnote continuation context',
} as const;

function isManagedCommand(value: unknown): boolean {
  return isJsonObject(value) && value.type === managedCommand.type && value.command === HOOK_CODEX_RESUME_COMMAND;
}

function withoutManagedCodexResumeHookGroups(entries: readonly unknown[]): unknown[] {
  return entries.flatMap(entry => {
    if (!isJsonObject(entry) || !Array.isArray(entry.hooks)) return [entry];
    const hooks = entry.hooks.filter(hook => !isManagedCommand(hook));
    if (hooks.length === entry.hooks.length) return [entry];
    return hooks.length === 0 ? [] : [{...entry, hooks}];
  });
}

/** Preserve every unrelated Codex hook and identify Threadnote ownership by its exact command. */
export function withCodexHooks(input: JsonObject, remove = false): JsonObject {
  const hooks = isJsonObject(input.hooks) ? {...input.hooks} : {};
  const existing = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
  const retained = withoutManagedCodexResumeHookGroups(existing);
  if (!remove) retained.push({hooks: [managedCommand]});
  if (retained.length > 0) hooks.UserPromptSubmit = retained;
  else delete hooks.UserPromptSubmit;

  const next: Record<string, unknown> = {...input};
  if (Object.keys(hooks).length > 0 || isJsonObject(input.hooks)) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

export function codexHooksAreCurrent(input: JsonObject): boolean {
  return JSON.stringify(input) === JSON.stringify(withCodexHooks(input));
}

export const runCodexHooksInstall = Effect.fn('hooks.installCodex')(function* (options: HooksInstallOptions) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const configPath = yield* expandPath(CODEX_HOOKS_PATH);
  const current = yield* readCodexHooksConfigFile(fs, configPath);
  const parsed = parseJsonConfigObject(current ?? '{}');
  if (
    !parsed ||
    (parsed.hooks !== undefined && !isJsonObject(parsed.hooks)) ||
    (isJsonObject(parsed.hooks) && Object.values(parsed.hooks).some(entries => !Array.isArray(entries)))
  ) {
    return yield* CodexHooksConfigError.make({
      message: `Refusing to modify invalid Codex hooks config at ${configPath}. Expected an object of hook event arrays.`,
    });
  }

  const remove = options.remove === true;
  const apply = options.apply === true && options.dryRun !== true;
  const next = withCodexHooks(parsed, remove);
  if (JSON.stringify(parsed) === JSON.stringify(next)) {
    yield* Console.log(`Codex hooks already ${remove ? 'absent' : 'managed'} in ${configPath}.`);
    return;
  }
  yield* Console.log(`${apply ? 'Updating' : 'Would update'} ${configPath}:`);
  yield* Console.log(
    remove
      ? `  - UserPromptSubmit: ${HOOK_CODEX_RESUME_COMMAND}`
      : `  + UserPromptSubmit: ${HOOK_CODEX_RESUME_COMMAND} (once per session and evidence generation)`,
  );
  if (!apply) {
    yield* Console.log('\nRe-run with --apply to actually modify the file.');
    return;
  }

  yield* fs.makeDirectory(pathService.dirname(configPath), {recursive: true, mode: 0o700});
  const crypto = yield* Crypto.Crypto;
  const temporary = pathService.join(pathService.dirname(configPath), `.hooks.${yield* crypto.randomUUIDv4}.tmp`);
  yield* fs.writeFileString(temporary, `${JSON.stringify(next, undefined, 2)}\n`, {flag: 'wx', mode: 0o600});
  yield* Effect.gen(function* () {
    if ((yield* readCodexHooksConfigFile(fs, configPath)) !== current) {
      return yield* CodexHooksConfigError.make({
        message: `Codex hooks config changed while Threadnote was preparing the update at ${configPath}. No change was applied; retry the command.`,
      });
    }
    yield* fs.rename(temporary, configPath);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  yield* Console.log(`${remove ? 'Removed' : 'Installed'} threadnote-managed Codex resume hook.`);
});

export const hasManagedCodexHooks = Effect.fn('hooks.hasManagedCodexHooks')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const configPath = yield* expandPath(CODEX_HOOKS_PATH);
  if (!(yield* fs.exists(configPath))) return false;
  const parsed = parseJsonConfigObject(yield* fs.readFileString(configPath));
  if (!parsed || !isJsonObject(parsed.hooks) || !Array.isArray(parsed.hooks.UserPromptSubmit)) return false;
  return parsed.hooks.UserPromptSubmit.some(
    entry => isJsonObject(entry) && Array.isArray(entry.hooks) && entry.hooks.some(isManagedCommand),
  );
});

export const hasCurrentCodexHooks = Effect.fn('hooks.hasCurrentCodexHooks')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const configPath = yield* expandPath(CODEX_HOOKS_PATH);
  if (!(yield* fs.exists(configPath))) return false;
  const parsed = parseJsonConfigObject(yield* fs.readFileString(configPath));
  return parsed !== undefined && codexHooksAreCurrent(parsed);
});

function readCodexHooksConfigFile(
  fs: FileSystem.FileSystem,
  configPath: string,
): Effect.Effect<string | undefined, CodexHooksConfigError | PlatformError.PlatformError> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(configPath))) return undefined;
    if (Option.isSome(yield* fs.readLink(configPath).pipe(Effect.option))) {
      return yield* CodexHooksConfigError.make({
        message: `Refusing to modify Codex hooks config through a symbolic link at ${configPath}.`,
      });
    }
    const info = yield* fs.stat(configPath);
    if (info.type !== 'File') {
      return yield* CodexHooksConfigError.make({
        message: `Refusing to modify non-file Codex hooks config at ${configPath}.`,
      });
    }
    return yield* fs.readFileString(configPath);
  });
}
