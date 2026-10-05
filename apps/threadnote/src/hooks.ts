import {Console, Effect, FileSystem, Path, Result, Stdio, Stream} from 'effect';
import {
  CLAUDE_SETTINGS_PATH,
  HOOK_CODE_BRIEF_COMMAND,
  HOOK_AUTO_PRECOMPACT_TOPIC,
  HOOK_PRE_COMPACT_COMMAND,
  HOOK_SESSION_START_COMMAND,
  THREADNOTE_HOOK_MARKER,
  THREADNOTE_HOOK_MARKER_VALUE,
} from './constants.js';
import {runCursorHooksInstall} from './cursor/hooks.js';
import {runCodexHooksInstall} from './codex/hooks.js';
import {runOmpHooksInstall} from './omp_hooks.js';
import {parseAgentClient} from './mcp/index.js';
import {captureConsole} from './effect/console.js';
import {SystemInfo} from '@threadnote/platform/system';
import {runHandoff, runRecall} from './memory/index.js';
import {applyScrubber} from './share/index.js';
import {distillTrace} from './trace.js';
import type {AgentClient, HookRunnerOptions, HooksInstallOptions} from './types.js';
import type {JsonObject} from '@threadnote/platform/json';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {checkForThreadnoteUpdate} from './release/check.js';
import {expandPath} from '@threadnote/platform/paths';
import {exists, isJsonObject, parseJsonConfigObject, resolveRepoName} from './utils.js';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {withSetupMutationLock} from './setup/lock.js';
import {readAutoUpdateStatus, triggerAutoUpdateIfEnabled} from './release/auto_update.js';

type HookEvent = 'PreCompact' | 'PreToolUse' | 'SessionStart';

interface ManagedHookEntry {
  readonly event: HookEvent;
  readonly command: string;
  readonly description: string;
  readonly matcher?: string;
}

const MANAGED_HOOKS: readonly ManagedHookEntry[] = [
  {
    event: 'PreToolUse',
    command: HOOK_CODE_BRIEF_COMMAND,
    description: 'Show current code-linked memory before editing a cited file.',
    matcher: 'Edit|Write',
  },
  {
    event: 'PreCompact',
    command: HOOK_PRE_COMPACT_COMMAND,
    description: 'Auto-store a handoff snapshot before context compaction so the next turn can recall it.',
  },
  {
    event: 'SessionStart',
    command: HOOK_SESSION_START_COMMAND,
    description: 'Pre-load the latest handoff for the current repo into the new session context.',
  },
];

export {parseAgentClient as parseHookClient};

export function runHooksInstall(config: RuntimeConfig, agent: AgentClient, options: HooksInstallOptions) {
  const operation = Effect.gen(function* () {
    const apply = options.apply === true && options.dryRun !== true;
    const remove = options.remove === true;
    switch (agent) {
      case 'claude':
        yield* runClaudeHooksInstall({apply, remove});
        return;
      case 'codex':
        yield* runCodexHooksInstall(options);
        return;
      case 'cursor':
        yield* runCursorHooksInstall(options);
        return;
      case 'omp':
        yield* runOmpHooksInstall(options);
        return;
      case 'copilot':
        yield* printNoHooksSupported('copilot', remove);
        return;
    }
  });
  const apply = options.apply === true && options.dryRun !== true;
  return !apply || options.setupLockHeld === true
    ? operation
    : withSetupMutationLock(config.agentContextHome, operation);
}

function runClaudeHooksInstall(options: {readonly apply: boolean; readonly remove: boolean}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const path = yield* expandPath(CLAUDE_SETTINGS_PATH);
    const existingRaw = (yield* fs.exists(path)) ? yield* fs.readFileString(path) : '{}';
    const parsed = parseJsonConfigObject(existingRaw) ?? {};
    const next = options.remove ? withoutThreadnoteHooks(parsed) : withThreadnoteHooks(parsed);
    const before = JSON.stringify(parsed);
    const after = JSON.stringify(next);
    if (before === after) {
      yield* Console.log(`Claude hooks already ${options.remove ? 'absent' : 'managed'} in ${path}.`);
      return;
    }

    yield* Console.log(`${options.apply ? 'Updating' : 'Would update'} ${path}:`);
    for (const entry of MANAGED_HOOKS) {
      yield* Console.log(`  ${options.remove ? '-' : '+'} ${entry.event}: ${entry.command}`);
    }

    if (!options.apply) {
      yield* Console.log('\nRe-run with --apply to actually modify the file.');
      return;
    }

    yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
    const serialized = `${JSON.stringify(next, undefined, 2)}\n`;
    yield* fs.writeFileString(path, serialized, {mode: 0o600});
    yield* fs.chmod(path, 0o600);
    yield* Console.log(`${options.remove ? 'Removed' : 'Installed'} threadnote-managed Claude hooks.`);
  });
}

export function withThreadnoteHooks(input: JsonObject): JsonObject {
  const hooks: Record<string, unknown> = ensureMutableObject(input.hooks);
  for (const entry of MANAGED_HOOKS) {
    const list = ensureMutableArray(hooks[entry.event]).filter(item => !isManagedThreadnoteEntry(item));
    list.push({
      [THREADNOTE_HOOK_MARKER]: THREADNOTE_HOOK_MARKER_VALUE,
      matcher: entry.matcher ?? '',
      hooks: [{type: 'command', command: entry.command}],
    });
    hooks[entry.event] = list;
  }
  return {...input, hooks};
}

export function threadnoteHooksAreCurrent(input: JsonObject): boolean {
  return JSON.stringify(input) === JSON.stringify(withThreadnoteHooks(input));
}

function withoutThreadnoteHooks(input: JsonObject): JsonObject {
  if (!isJsonObject(input.hooks)) {
    return input;
  }
  const hooks: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(input.hooks)) {
    if (!Array.isArray(value)) {
      hooks[event] = value;
      continue;
    }
    const filtered = value.filter(item => !isManagedThreadnoteEntry(item));
    if (filtered.length > 0) {
      hooks[event] = filtered;
    }
  }
  if (Object.keys(hooks).length === 0) {
    const next: Record<string, unknown> = {...input};
    delete next.hooks;
    return next;
  }
  return {...input, hooks};
}

function isManagedThreadnoteEntry(value: unknown): boolean {
  return isJsonObject(value) && value[THREADNOTE_HOOK_MARKER] === THREADNOTE_HOOK_MARKER_VALUE;
}

function ensureMutableObject(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? {...value} : {};
}

function ensureMutableArray(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

function printNoHooksSupported(agent: AgentClient, remove: boolean) {
  if (remove) {
    return Console.log(`${agent} does not expose a hook surface; nothing to remove.`);
  }
  return Console.log(
    [
      `${agent} does not expose agent-mode hooks today.`,
      'Threadnote already installs user-level instructions for this agent; that remains the active guidance surface.',
      'Hooks support will be added if the agent gains a hook surface upstream.',
    ].join('\n'),
  );
}

export const hasManagedClaudeHooks = Effect.fn('hooks.hasManagedClaudeHooks')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* expandPath(CLAUDE_SETTINGS_PATH);
  if (!(yield* exists(path))) {
    return false;
  }
  const raw = yield* fs.readFileString(path);
  const parsed = parseJsonConfigObject(raw);
  if (!parsed || !isJsonObject(parsed.hooks)) {
    return false;
  }
  for (const value of Object.values(parsed.hooks)) {
    if (!Array.isArray(value)) {
      continue;
    }
    if (value.some(item => isManagedThreadnoteEntry(item))) {
      return true;
    }
  }
  return false;
});

export const hasCurrentClaudeHooks = Effect.fn('hooks.hasCurrentClaudeHooks')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* expandPath(CLAUDE_SETTINGS_PATH);
  if (!(yield* exists(path))) return false;
  const parsed = parseJsonConfigObject(yield* fs.readFileString(path));
  return parsed !== undefined && threadnoteHooksAreCurrent(parsed);
});

export function runPreCompactHook(
  config: RuntimeConfig,
  options: HookRunnerOptions & {
    readonly sourceAgentClient?: 'claude' | 'cursor' | 'omp';
    readonly sessionId?: string;
  } = {},
) {
  // Hooks must never block compaction. Anything that throws here gets swallowed
  // and the process still exits 0 — the worst-case is a missed snapshot.
  return Effect.gen(function* () {
    const project = (yield* resolveRepoName()) ?? 'general';
    const sourceAgentClient = options.sourceAgentClient ?? 'claude';
    // Only Claude passes a compatible transcript; other hosts use state-only snapshots.
    const {sessionId, trace}: TraceContext =
      sourceAgentClient === 'claude' ? yield* captureTraceContext() : {sessionId: options.sessionId};
    yield* runHandoff(config, {
      blockers: '- none recorded',
      dryRun: options.dryRun === true,
      nextStep:
        'Continue from this auto-snapshot. A manual `threadnote handoff` will produce a richer write-up if you have more context.',
      project,
      sessionId,
      sourceAgentClient,
      task: `Auto-snapshot captured at ${
        sourceAgentClient === 'claude'
          ? 'Claude PreCompact'
          : `${sourceAgentClient === 'cursor' ? 'Cursor' : 'OMP'} preCompact`
      } (deterministic safety net before context compaction).`,
      tests: '- not recorded (auto-snapshot)',
      topic: HOOK_AUTO_PRECOMPACT_TOPIC,
      trace,
    });
  }).pipe(
    Effect.catch(error =>
      Console.error(
        `threadnote pre-compact-hook: snapshot skipped (${error instanceof Error ? error.message : String(error)})`,
      ),
    ),
  );
}

export function runSessionStartHook(config: RuntimeConfig, options: HookRunnerOptions = {}) {
  // Hooks must never block session start. Failures fall through quietly so the
  // user just gets a normal session without injected context.
  return Effect.gen(function* () {
    yield* emitUpdateBannerIfOutdated(config);
    const project = yield* resolveRepoName();
    if (!project) {
      return;
    }
    const recalled = yield* captureConsole(
      runRecall(config, {
        dryRun: options.dryRun === true,
        inferScope: true,
        nodeLimit: '5',
        // Keep the intent phrase so recall resolves the branch as separate, non-topical context.
        query: `${project} current branch latest handoff durable feature memory`,
      }),
    );
    yield* Console.log(renderSessionStartRecallQueue(project, recalled.output));
  }).pipe(
    Effect.catch(error =>
      Console.error(
        `threadnote session-start-hook: recall skipped (${error instanceof Error ? error.message : String(error)})`,
      ),
    ),
  );
}

/**
 * The session-start hook is an action queue, not a second recall UI. It keeps
 * ranking diagnostics out of the always-injected surface and makes the
 * required pointer-follow explicit. The full explainable recall remains
 * available through recall_context and the interactive CLI.
 */
export function renderSessionStartRecallQueue(project: string, recallOutput: string): string {
  const uris = rankedRecallUris(recallOutput).slice(0, SESSION_START_RECALL_POINTER_LIMIT);
  const warnings = operationalRecallWarnings(recallOutput);
  const queue =
    uris.length > 0
      ? uris.map(uri => `- [unread] ${uri}`)
      : warnings.length > 0
        ? ['No unread context pointers were returned, but recall ran in degraded mode.']
        : ['No unread context pointers were recalled for this workspace.'];
  const warningSection =
    warnings.length > 0 ? ['', 'Recall warnings (bounded):', ...warnings.map(warning => `- ${warning}`)] : [];
  return [
    `## Threadnote — unread context queue for ${project}`,
    '',
    ...queue,
    ...warningSection,
    '',
    uris.length > 0
      ? 'Required next action: call `read_context` for the relevant URI above before relying on memory-backed claims.'
      : warnings.length > 0
        ? 'Required next action: continue with repository evidence, follow the warning remediation, and retry recall when healthy. Do not treat this empty queue as proof that no memory exists.'
        : 'Continue with current repository evidence; there is no recalled memory to treat as context.',
    'A ranked recall pointer is not evidence until its content has been read.',
  ].join('\n');
}

const SESSION_START_RECALL_POINTER_LIMIT = 5;
const SESSION_START_RECALL_WARNING_LIMIT = 4;
const SESSION_START_RECALL_WARNING_MAX_CHARACTERS = 320;
const SESSION_START_RECALL_WARNING_PREFIXES = [
  'Auto-sync warning:',
  'Local AI recall warning:',
  'Recall index warning:',
  'Recall warning:',
  'Recall error:',
] as const;

function operationalRecallWarnings(output: string): readonly string[] {
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const normalized = line.trim().replace(/\s+/g, ' ');
    if (!SESSION_START_RECALL_WARNING_PREFIXES.some(prefix => normalized.startsWith(prefix))) continue;
    const bounded = boundedRecallWarning(normalized);
    if (seen.has(bounded)) continue;
    seen.add(bounded);
    warnings.push(bounded);
    if (warnings.length === SESSION_START_RECALL_WARNING_LIMIT) break;
  }
  return warnings;
}

function boundedRecallWarning(warning: string): string {
  const characters = [...warning];
  return characters.length <= SESSION_START_RECALL_WARNING_MAX_CHARACTERS
    ? warning
    : `${characters.slice(0, SESSION_START_RECALL_WARNING_MAX_CHARACTERS - 1).join('')}…`;
}

function rankedRecallUris(output: string): readonly string[] {
  const seen = new Set<string>();
  const uris: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const uri = /^\s*\d+\.\s+.*\s·\s+(threadnote:\/\/\S+)\s*$/.exec(line)?.[1];
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    uris.push(uri);
  }
  return uris;
}

interface TraceContext {
  readonly sessionId?: string;
  readonly trace?: string;
}

/**
 * Reads Claude's PreCompact stdin payload and distills the referenced
 * transcript into a short, scrubbed trace. Entirely best-effort: any failure
 * (no stdin, unreadable transcript, unstable format, secret blocker) yields an
 * empty context so the pre-compact snapshot still writes its state-only
 * handoff. Never throws.
 */
const captureTraceContext = Effect.fn('hooks.captureTraceContext')(() =>
  Effect.gen(function* () {
    const payload = yield* readHookPayload();
    if (!payload) {
      return {} satisfies TraceContext;
    }
    const rawTrace = payload.transcriptPath ? yield* distillTrace(payload.transcriptPath) : undefined;
    return {
      sessionId: payload.sessionId,
      trace: rawTrace ? scrubTrace(rawTrace) : undefined,
    } satisfies TraceContext;
  }),
);

/** Redacts soft leaks; drops the trace on a hard credential blocker. */
function scrubTrace(trace: string): string | undefined {
  const result = applyScrubber(trace, {redact: true});
  return result.blocker ? undefined : result.cleaned;
}

export const readHookPayload = Effect.fn('hooks.readPayload')(function* () {
  const system = yield* SystemInfo;
  if (system.stdinIsTTY) {
    return undefined;
  }
  const raw = yield* readStdinWithTimeout(1500, 512 * 1024);
  if (!raw.trim()) {
    return undefined;
  }
  const parsedResult = Result.try((): unknown => JSON.parse(raw));
  if (Result.isFailure(parsedResult)) {
    return undefined;
  }
  const parsed = parsedResult.success;
  if (!isJsonObject(parsed)) {
    return undefined;
  }
  return {
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
    hookEventName: typeof parsed.hook_event_name === 'string' ? parsed.hook_event_name : undefined,
    filePath:
      isJsonObject(parsed.tool_input) && typeof parsed.tool_input.file_path === 'string'
        ? parsed.tool_input.file_path
        : undefined,
    toolName: typeof parsed.tool_name === 'string' ? parsed.tool_name : undefined,
    sessionId:
      typeof parsed.session_id === 'string'
        ? parsed.session_id
        : typeof parsed.conversation_id === 'string'
          ? parsed.conversation_id
          : undefined,
    prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
    turnId: typeof parsed.turn_id === 'string' ? parsed.turn_id : undefined,
    workspaceRoots:
      Array.isArray(parsed.workspace_roots) && parsed.workspace_roots.every(root => typeof root === 'string')
        ? parsed.workspace_roots
        : undefined,
    transcriptPath: typeof parsed.transcript_path === 'string' ? parsed.transcript_path : undefined,
  };
});

const readStdinWithTimeout = Effect.fn('hooks.readStdin')(function* (timeoutMs: number, maxBytes: number) {
  const stdio = yield* Stdio.Stdio;
  return yield* stdio.stdin.pipe(
    Stream.decodeText,
    Stream.runFold(
      () => '',
      (output, chunk) => `${output}${chunk}`.slice(0, maxBytes),
    ),
    Effect.timeoutOrElse({duration: timeoutMs, orElse: () => Effect.succeed('')}),
    Effect.orElseSucceed(() => ''),
  );
});

function emitUpdateBannerIfOutdated(config: RuntimeConfig) {
  // Automatic mode delegates all network and install work to the detached,
  // install-scoped coordinator. Notify mode retains the cheap daily banner.
  return Effect.gen(function* () {
    const autoUpdate = yield* readAutoUpdateStatus();
    if (autoUpdate.effectivePolicy === 'automatic') {
      yield* triggerAutoUpdateIfEnabled();
      return;
    }
    const path = yield* Path.Path;
    const result = yield* checkForThreadnoteUpdate({
      cachePath: path.join(config.agentContextHome, '.update-state.json'),
      currentVersion: yield* getThreadnoteVersion(),
    });
    if (!result || !result.outdated) {
      return;
    }
    yield* Console.log(
      `[threadnote] v${result.latestVersion} available (current v${result.currentVersion}). Run: threadnote update\n`,
    );
  }).pipe(Effect.ignore);
}
