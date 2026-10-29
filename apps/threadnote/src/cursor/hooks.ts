import {Array as EffectArray} from 'effect';
import {Console, Effect, FileSystem, Path, Schema} from 'effect';
import {THREADNOTE_HOOK_MARKER, THREADNOTE_HOOK_MARKER_VALUE} from '../constants.js';
import {expandPath, getInvocationCwd} from '@threadnote/platform/paths';
import {isJsonObject, parseJsonConfigObject} from '../utils.js';
import type {HooksInstallOptions} from '../types.js';
import type {JsonObject} from '@threadnote/platform/json';
import * as EffectRecord from 'effect/Record';

export type CursorHookTarget = 'desktop' | 'cloud';
export type CursorHookEvent = 'sessionStart' | 'preCompact';

class CursorHooksConfigError extends Schema.TaggedError<CursorHooksConfigError, {readonly brand: unique symbol}>()(
  'CursorHooksConfigError',
  {
    message: Schema.String,
  },
) {}

// Cursor uses flat command entries, unlike Claude's nested matcher/hook groups.
// https://cursor.com/docs/hooks (verified 2026-09-08).
const managedEvents = (target: CursorHookTarget): readonly CursorHookEvent[] =>
  target === 'cloud' ? ['preCompact'] : ['sessionStart', 'preCompact'];

function isManaged(value: unknown): boolean {
  return isJsonObject(value) && value[THREADNOTE_HOOK_MARKER] === THREADNOTE_HOOK_MARKER_VALUE;
}

/** Preserve unrelated entries and config fields, including empty user event arrays. */
export function withCursorHooks(input: JsonObject, target: CursorHookTarget, remove = false): JsonObject {
  const hooks = isJsonObject(input.hooks) ? {...input.hooks} : {};
  for (const [event, entries] of EffectRecord.toEntries(hooks)) {
    if (!EffectArray.isArray(entries) || !EffectArray.some(entries, isManaged)) continue;
    const remaining = EffectArray.filter(entries, entry => !isManaged(entry));
    hooks[event] = remaining;
  }
  if (!remove) {
    for (const event of managedEvents(target)) {
      const entries = EffectArray.isArray(hooks[event]) ? hooks[event] : [];
      hooks[event] = [
        ...entries,
        {
          [THREADNOTE_HOOK_MARKER]: THREADNOTE_HOOK_MARKER_VALUE,
          type: 'command',
          command: `threadnote cursor-hook ${event}`,
          timeout: 15,
        },
      ];
    }
  }
  const next = {...input};
  if (EffectRecord.keys(hooks).length || isJsonObject(input.hooks)) next.hooks = hooks;
  if (!remove) {
    next.version = input.version ?? 1;
    next.hooks = hooks;
  }
  return next;
}

export function cursorHooksAreCurrent(input: JsonObject, target: CursorHookTarget): boolean {
  return JSON.stringify(input) === JSON.stringify(withCursorHooks(input, target));
}

export const runCursorHooksInstall = Effect.fn('hooks.installCursor')(function* (options: HooksInstallOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = options.target ?? 'desktop';
  if (target === 'cloud' && !options.project) {
    return yield* CursorHooksConfigError.make({
      message:
        'Cursor Cloud hooks require --project <repository>; local ~/.cursor/hooks.json is unavailable in hosted Cloud VMs.',
    });
  }
  const configPath = options.project
    ? path.resolve(yield* getInvocationCwd(), options.project, '.cursor/hooks.json')
    : yield* expandPath('~/.cursor/hooks.json');
  const exists = yield* fs.exists(configPath);
  const raw = exists ? yield* fs.readFileString(configPath) : '{}';
  const parsed = parseJsonConfigObject(raw);
  if (
    !parsed ||
    (parsed.version !== undefined && parsed.version !== 1) ||
    (parsed.hooks !== undefined && !isJsonObject(parsed.hooks)) ||
    (isJsonObject(parsed.hooks) &&
      EffectArray.some(EffectRecord.values(parsed.hooks), entries => !EffectArray.isArray(entries)))
  ) {
    return yield* CursorHooksConfigError.make({
      message: `Refusing to modify invalid or unsupported Cursor hooks config at ${configPath}. Expected version 1 with event arrays.`,
    });
  }
  const remove = options.remove === true;
  const apply = options.apply === true && options.dryRun !== true;
  const next = withCursorHooks(parsed, target, remove);
  yield* Console.log(
    target === 'cloud'
      ? 'Cursor hosted Cloud: managed project preCompact command hook. sessionStart, sessionEnd, and workspaceOpen are unavailable; hooks begin only in a writable environment.'
      : 'Cursor desktop: managed sessionStart and preCompact command hooks. workspaceOpen is supported by Cursor but is not used by Threadnote.',
  );
  yield* Console.log(
    'Local user hooks do not carry into Cloud VMs. For hosted Cloud use --target cloud --project <repository>; commit .cursor/hooks.json and provision threadnote on the VM PATH. Cloud session recall remains instruction-driven.',
  );
  if (JSON.stringify(parsed) === JSON.stringify(next)) {
    yield* Console.log(`Cursor hooks already ${remove ? 'absent' : 'managed'} in ${configPath}.`);
    return;
  }
  yield* Console.log(`${apply ? 'Updating' : 'Would update'} ${configPath}:`);
  yield* Console.log(remove ? '  - threadnote-managed Cursor hooks' : JSON.stringify(next, undefined, 2));
  if (!apply) {
    yield* Console.log('\nRe-run with --apply to actually modify the file.');
    return;
  }
  yield* fs.makeDirectory(path.dirname(configPath), {recursive: true});
  yield* fs.writeFileString(configPath, `${JSON.stringify(next, undefined, 2)}\n`, {mode: 0o600});
  yield* Console.log(`${remove ? 'Removed' : 'Installed'} threadnote-managed Cursor hooks.`);
});

export const hasManagedCursorHooks = Effect.fn('hooks.hasManagedCursorHooks')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* expandPath('~/.cursor/hooks.json');
  if (!(yield* fs.exists(path))) return false;
  const parsed = parseJsonConfigObject(yield* fs.readFileString(path));
  return (
    !!parsed &&
    isJsonObject(parsed.hooks) &&
    EffectArray.some(
      EffectRecord.values(parsed.hooks),
      entries => EffectArray.isArray(entries) && EffectArray.some(entries, isManaged),
    )
  );
});

export const hasCurrentCursorHooks = Effect.fn('hooks.hasCurrentCursorHooks')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* expandPath('~/.cursor/hooks.json');
  if (!(yield* fs.exists(path))) return false;
  const parsed = parseJsonConfigObject(yield* fs.readFileString(path));
  return parsed !== undefined && cursorHooksAreCurrent(parsed, 'desktop');
});
