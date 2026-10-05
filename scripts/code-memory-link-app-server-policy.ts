import {Schema} from 'effect';
/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed adapter validates app-server actions before execution. */
import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {codeMemoryLinkAppServerOpaqueIdDigest} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';

export interface CodeMemoryLinkAppServerApprovalReceiptV1 {
  readonly itemIdDigest: string;
  readonly itemType: 'commandExecution' | 'fileChange';
  readonly requestDigest: string;
}

export interface CodeMemoryLinkCommandPolicyV1 {
  readonly approvedCommandTokens: readonly (readonly string[])[];
}

const EMPTY_COMMAND_POLICY: CodeMemoryLinkCommandPolicyV1 = {approvedCommandTokens: []};

interface ApprovalScope {
  readonly repositoryRoot: string;
  readonly threadId: string;
  readonly turnId: string;
}

const FORBIDDEN_PATH_SEGMENTS = new Set(['.codex', '.git']);
const SIMPLE_READ_EXECUTABLES = new Set(['cat', 'file', 'head', 'nl', 'stat', 'tail', 'wc']);
const STDIN_READ_EXECUTABLES = new Set(['cat', 'head', 'nl', 'tail', 'wc']);
const SIMPLE_FLAGS = new Map<string, ReadonlySet<string>>([
  ['cat', new Set(['-b', '-n', '-s', '--'])],
  ['file', new Set(['-b', '--'])],
  ['head', new Set(['-n', '--'])],
  ['nl', new Set(['-b', '-n', '--'])],
  ['stat', new Set(['-f', '--'])],
  ['tail', new Set(['-n', '--'])],
  ['wc', new Set(['-c', '-l', '-w', '--'])],
]);

/** A reviewed action was well-formed but is outside the experiment's execution policy. */
export class CodeMemoryLinkActionDeniedError extends Schema.TaggedError<CodeMemoryLinkActionDeniedError>()(
  'CodeMemoryLinkActionDeniedError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {
  static of(message: string, options?: ErrorOptions): CodeMemoryLinkActionDeniedError {
    return CodeMemoryLinkActionDeniedError.make({
      message,
      ...(options?.cause === undefined ? {} : {cause: options.cause}),
    });
  }
}

export function approveCodeMemoryLinkAppServerRequest(
  input: {
    readonly method: string;
    readonly params: unknown;
    readonly scope: ApprovalScope;
    readonly startedItem: unknown;
  },
  commandPolicy: CodeMemoryLinkCommandPolicyV1 = EMPTY_COMMAND_POLICY,
): CodeMemoryLinkAppServerApprovalReceiptV1 {
  if (input.method === 'item/commandExecution/requestApproval') {
    return approveCommand(input.params, input.startedItem, input.scope, commandPolicy);
  }
  if (input.method === 'item/fileChange/requestApproval') {
    return approveFileChange(input.params, input.startedItem, input.scope);
  }
  throw new Error(`Unsupported Code Memory Link app-server approval request ${input.method}.`);
}

export function assertCodeMemoryLinkPublicAction(
  itemInput: unknown,
  repositoryRoot: string,
  commandPolicy: CodeMemoryLinkCommandPolicyV1 = EMPTY_COMMAND_POLICY,
): 'commandExecution' | 'fileChange' | null {
  const item = object(itemInput, 'app-server action item');
  if (item.type === 'commandExecution') {
    assertReadCommand(item, repositoryRoot, commandPolicy);
    return 'commandExecution';
  }
  if (item.type === 'fileChange') {
    assertFileChanges(item, repositoryRoot);
    return 'fileChange';
  }
  return null;
}

function approveCommand(
  paramsInput: unknown,
  startedItemInput: unknown,
  scope: ApprovalScope,
  commandPolicy: CodeMemoryLinkCommandPolicyV1,
): CodeMemoryLinkAppServerApprovalReceiptV1 {
  const params = object(paramsInput, 'command approval params');
  exactKeys(
    params,
    [
      'approvalId',
      'additionalPermissions',
      'availableDecisions',
      'command',
      'commandActions',
      'cwd',
      'environmentId',
      'itemId',
      'networkApprovalContext',
      'proposedExecpolicyAmendment',
      'proposedNetworkPolicyAmendments',
      'reason',
      'startedAtMs',
      'threadId',
      'turnId',
    ],
    'command approval params',
    true,
  );
  assertApprovalScope(params, scope);
  if (
    params.approvalId != null ||
    params.additionalPermissions != null ||
    (params.environmentId != null && params.environmentId !== 'local') ||
    params.networkApprovalContext != null ||
    params.proposedNetworkPolicyAmendments != null
  ) {
    throw new Error('Code Memory Link rejects compound, remote, network, and additional permissions.');
  }
  assertTemporaryCommandApproval(params);
  const item = object(startedItemInput, 'started command item');
  if (item.type !== 'commandExecution' || item.id !== params.itemId) {
    throw new Error('Command approval does not match its started action item.');
  }
  for (const field of ['command', 'commandActions', 'cwd'] as const) {
    if (JSON.stringify(params[field] ?? null) !== JSON.stringify(item[field] ?? null)) {
      throw new Error(`Command approval ${field} differs from its started action item.`);
    }
  }
  denyUnsupportedAction(() => {
    assertProposedExecpolicyAmendment(params.proposedExecpolicyAmendment);
    assertReadCommand(item, scope.repositoryRoot, commandPolicy);
  });
  return receipt('commandExecution', String(params.itemId), params);
}

function assertTemporaryCommandApproval(params: Record<string, unknown>): void {
  if (params.availableDecisions == null) return;
  if (
    !Array.isArray(params.availableDecisions) ||
    !params.availableDecisions.includes('accept') ||
    !params.availableDecisions.includes('cancel') ||
    new TextEncoder().encode(JSON.stringify(params.availableDecisions)).byteLength > 4_096
  ) {
    throw new Error('Code Memory Link command approval lacks bounded one-time decisions.');
  }
}

function assertProposedExecpolicyAmendment(value: unknown): void {
  if (value == null) return;
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(token => typeof token !== 'string' || token.length > 1_024 || token.includes('\0')) ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1_024
  ) {
    throw new Error('Code Memory Link command approval proposes an invalid execpolicy amendment.');
  }
}

function approveFileChange(
  paramsInput: unknown,
  startedItemInput: unknown,
  scope: ApprovalScope,
): CodeMemoryLinkAppServerApprovalReceiptV1 {
  const params = object(paramsInput, 'file-change approval params');
  exactKeys(
    params,
    ['grantRoot', 'itemId', 'reason', 'startedAtMs', 'threadId', 'turnId'],
    'file-change approval params',
    true,
  );
  assertApprovalScope(params, scope);
  if (params.grantRoot != null) throw new Error('Code Memory Link rejects persistent file-change grants.');
  const item = object(startedItemInput, 'started file-change item');
  if (item.type !== 'fileChange' || item.id !== params.itemId) {
    throw new Error('File-change approval does not match its started action item.');
  }
  denyUnsupportedAction(() => assertFileChanges(item, scope.repositoryRoot));
  return receipt('fileChange', String(params.itemId), params);
}

function assertApprovalScope(params: Record<string, unknown>, scope: ApprovalScope): void {
  if (
    params.threadId !== scope.threadId ||
    params.turnId !== scope.turnId ||
    typeof params.itemId !== 'string' ||
    params.itemId.length === 0 ||
    params.itemId.length > 256 ||
    !Number.isSafeInteger(params.startedAtMs)
  ) {
    throw new Error('App-server approval is outside the selected thread, turn, or item scope.');
  }
}

function assertReadCommand(
  item: Record<string, unknown>,
  repositoryRoot: string,
  commandPolicy: CodeMemoryLinkCommandPolicyV1,
): void {
  const cwd = containedPath(text(item.cwd, 'command cwd'), repositoryRoot);
  const command = text(item.command, 'command');
  const commands = reviewableCommands(item, repositoryRoot, cwd);
  if (
    commands.length !== 1 &&
    commands.some(candidate =>
      commandPolicy.approvedCommandTokens.some(approved =>
        equalTokens(tokenizeCodeMemoryLinkCommandV1(candidate), approved),
      ),
    )
  ) {
    throw new Error('Code Memory Link task-scoped commands must run as one exact standalone command.');
  }
  for (const command of commands) assertSingleReadCommand(command, repositoryRoot, cwd, commandPolicy);
  if (tokenizeCodeMemoryLinkCommandV1(command)[0] !== '/bin/zsh') {
    if (!Array.isArray(item.commandActions) || item.commandActions.length === 0) {
      throw new Error('Code Memory Link command lacks a reviewable read-only action projection.');
    }
    assertReadOnlyActionProjection(item.commandActions as readonly unknown[], repositoryRoot, cwd);
  }
}

function assertSingleReadCommand(
  command: string,
  repositoryRoot: string,
  cwd: string,
  commandPolicy: CodeMemoryLinkCommandPolicyV1,
): void {
  const tokens = tokenizeCodeMemoryLinkCommandV1(command);
  if (commandPolicy.approvedCommandTokens.some(approved => equalTokens(tokens, approved))) return;
  const executable = tokens[0];
  if (!executable || executable.includes('/') || executable.includes('\\')) {
    throw new Error('Code Memory Link commands require one bare reviewed executable name.');
  }
  if (executable === 'pwd') {
    if (tokens.length !== 1) throw new Error('pwd does not accept arguments in the evaluation policy.');
  } else if (executable === 'ls') assertLs(tokens.slice(1), repositoryRoot, cwd);
  else if (executable === 'find') assertFind(tokens.slice(1), repositoryRoot, cwd);
  else if (executable === 'git') assertGit(tokens.slice(1), repositoryRoot, cwd);
  else if (executable === 'grep') assertGrep(tokens.slice(1), repositoryRoot, cwd);
  else if (executable === 'rg') assertRipgrep(tokens.slice(1), repositoryRoot, cwd);
  else if (executable === 'sed') assertSed(tokens.slice(1), repositoryRoot, cwd);
  else if (executable === 'od') assertOd(tokens.slice(1), repositoryRoot, cwd);
  else if (SIMPLE_READ_EXECUTABLES.has(executable)) {
    assertSimpleRead(executable, tokens.slice(1), repositoryRoot, cwd);
  } else {
    throw new Error(
      `Code Memory Link command executable ${safeExecutableLabel(executable)} is outside the reviewed read-only allowlist.`,
    );
  }
}

function equalTokens(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function safeExecutableLabel(executable: string): string {
  return /^[A-Za-z0-9._+-]{1,128}$/u.test(executable)
    ? JSON.stringify(executable)
    : `with SHA-256 ${createHash('sha256').update(executable).digest('hex')}`;
}

function reviewableCommands(item: Record<string, unknown>, repositoryRoot: string, cwd: string): readonly string[] {
  const command = text(item.command, 'command');
  const shellTokens = tokenizeCodeMemoryLinkCommandV1(command);
  if (shellTokens[0] === '/bin/zsh') {
    if (shellTokens.length !== 3 || (shellTokens[1] !== '-c' && shellTokens[1] !== '-lc')) {
      throw new Error('Code Memory Link shell command uses an unsupported invocation shape.');
    }
    if (
      !Array.isArray(item.commandActions) ||
      item.commandActions.length === 0 ||
      item.commandActions.length > 32 ||
      (item.source !== 'agent' && item.source !== 'unifiedExecStartup')
    ) {
      throw new Error('Code Memory Link shell command lacks bounded reviewed local action projections.');
    }
    const actions = item.commandActions.map(action => object(action, 'command action'));
    const projected = shellTokens[2];
    for (const action of actions) {
      if (action.type === 'unknown') {
        exactKeys(action, ['command', 'type'], 'code-mode unknown command action', false);
        text(action.command, 'code-mode unknown command projection');
      } else assertReadOnlyActionProjection([action], repositoryRoot, cwd);
    }
    return splitReadCommandChain(projected);
  }
  return [command];
}

function assertReadOnlyActionProjection(commandActions: readonly unknown[], repositoryRoot: string, cwd: string): void {
  for (const actionInput of commandActions) {
    const action = object(actionInput, 'command action');
    if (!['read', 'listFiles', 'search'].includes(String(action.type))) {
      throw new Error('Code Memory Link command action is not read-only.');
    }
    if (typeof action.path === 'string' && action.path.length > 0) containedPath(action.path, repositoryRoot, cwd);
  }
}

function splitReadCommandChain(command: string): readonly string[] {
  if (command.length > 16_384 || /[\0\r\n]/u.test(command)) {
    throw new Error('Command chain is not bounded single-line text.');
  }
  const commands: string[] = [];
  let start = 0;
  let quote: 'single' | 'double' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === 'single') {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = null;
      else if (character === '$' || character === '`') {
        throw new Error('Command chain contains expansion inside double quotes.');
      } else if (character === '\\') {
        if (index + 1 >= command.length) throw new Error('Command chain ends with an escape.');
        index += 1;
      }
      continue;
    }
    if (character === "'") quote = 'single';
    else if (character === '"') quote = 'double';
    else if (character === '&') {
      if (command[index + 1] !== '&') throw new Error('Command chain contains unsupported shell control.');
      commands.push(nonemptyCommand(command.slice(start, index)));
      start = index + 2;
      index += 1;
    } else if (character === ';') {
      commands.push(nonemptyCommand(command.slice(start, index)));
      start = index + 1;
    } else if (character === '|') {
      if (command[index + 1] === '|') throw new Error('Command chain contains unsupported shell control.');
      commands.push(nonemptyCommand(command.slice(start, index)));
      start = index + 1;
    } else if ('<>`$(){}\\'.includes(character)) {
      throw new Error('Command chain contains unsupported shell control or expansion.');
    }
  }
  if (quote !== null) throw new Error('Command chain contains an unterminated quote.');
  commands.push(nonemptyCommand(command.slice(start)));
  return commands;
}

function nonemptyCommand(value: string): string {
  const command = value.trim();
  if (!command) throw new Error('Command chain contains an empty command.');
  return command;
}

function assertSimpleRead(executable: string, args: readonly string[], root: string, cwd: string): void {
  const flags = SIMPLE_FLAGS.get(executable)!;
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (flags.has(value)) {
      if (['head', 'tail'].includes(executable) && value === '-n') positiveCount(args[++index], `${executable} -n`);
      else if (executable === 'stat' && value === '-f') boundedLiteral(args[++index], 'stat format');
      else if (executable === 'nl' && (value === '-b' || value === '-n')) boundedLiteral(args[++index], `nl ${value}`);
      continue;
    }
    if (/^-[0-9]+$/u.test(value) && (executable === 'head' || executable === 'tail')) continue;
    if (value.startsWith('-')) throw new Error(`${executable} option is outside the reviewed grammar.`);
    paths.push(value);
  }
  if (paths.length === 0 && !STDIN_READ_EXECUTABLES.has(executable)) {
    throw new Error(`${executable} requires an explicit repository file.`);
  }
  for (const path of paths) containedPath(path, root, cwd);
}

function assertOd(args: readonly string[], root: string, cwd: string): void {
  const paths: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!optionsEnded && value === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (value === '-A' || value === '-t')) {
      boundedLiteral(args[++index], `od ${value}`);
      continue;
    }
    if (!optionsEnded && (value === '-j' || value === '-N' || value === '-w')) {
      positiveCount(args[++index], `od ${value}`);
      continue;
    }
    if (
      !optionsEnded &&
      (value === '-v' || /^-A[dnox]$/u.test(value) || /^-t[a-zA-Z0-9.]+$/u.test(value) || /^-[jNw][0-9]+$/u.test(value))
    ) {
      continue;
    }
    if (!optionsEnded && value.startsWith('-')) throw new Error('od option is outside the reviewed grammar.');
    paths.push(value);
  }
  for (const path of paths) containedPath(path, root, cwd);
}

function denyUnsupportedAction(check: () => void): void {
  try {
    check();
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    throw CodeMemoryLinkActionDeniedError.of(
      `Code Memory Link declined an action outside the reviewed policy: ${error.message}`,
      {cause: error},
    );
  }
}

function assertLs(args: readonly string[], root: string, cwd: string): void {
  const paths: string[] = [];
  for (const value of args) {
    if (value === '--' || /^-[1aFlhR]+$/u.test(value)) continue;
    if (value.startsWith('-')) throw new Error('ls option is outside the reviewed grammar.');
    paths.push(value);
  }
  for (const path of paths.length === 0 ? ['.'] : paths) containedPath(path, root, cwd);
}

function assertGit(args: readonly string[], root: string, cwd: string): void {
  const [subcommand, ...subcommandArgs] = args;
  if (subcommand === 'diff') {
    const flags = new Set([
      '--cached',
      '--check',
      '--color=never',
      '--name-only',
      '--name-status',
      '--no-ext-diff',
      '--no-renames',
      '--stat',
    ]);
    let optionsEnded = false;
    for (const value of subcommandArgs) {
      if (!optionsEnded && value === '--') {
        optionsEnded = true;
        continue;
      }
      if (!optionsEnded && flags.has(value)) continue;
      if (!optionsEnded) throw new Error('git diff revisions and options are outside the reviewed grammar.');
      containedPath(value, root, cwd);
    }
    return;
  }
  if (subcommand === 'status') {
    const flags = new Set([
      '-b',
      '-s',
      '--branch',
      '--porcelain',
      '--porcelain=v1',
      '--short',
      '--untracked-files=all',
      '--untracked-files=no',
      '--untracked-files=normal',
    ]);
    if (subcommandArgs.some(value => !flags.has(value))) {
      throw new Error('git status option is outside the reviewed grammar.');
    }
    return;
  }
  if (subcommand === 'rev-parse') {
    if (
      subcommandArgs.length !== 1 ||
      !['--is-inside-work-tree', '--show-prefix', '--show-toplevel'].includes(subcommandArgs[0])
    ) {
      throw new Error('git rev-parse is limited to one reviewed repository-location query.');
    }
    return;
  }
  if (subcommand === 'ls-files') {
    const flags = new Set([
      '--cached',
      '--deleted',
      '--exclude-standard',
      '--full-name',
      '--ignored',
      '--modified',
      '--others',
      '--stage',
      '--unmerged',
    ]);
    let optionsEnded = false;
    for (const value of subcommandArgs) {
      if (!optionsEnded && value === '--') {
        optionsEnded = true;
        continue;
      }
      if (!optionsEnded && flags.has(value)) continue;
      if (!optionsEnded && value.startsWith('-')) {
        throw new Error('git ls-files option is outside the reviewed grammar.');
      }
      containedPath(value, root, cwd);
    }
    return;
  }
  throw new Error('git subcommand is outside the reviewed read-only grammar.');
}

function assertFind(args: readonly string[], root: string, cwd: string): void {
  const paths: string[] = [];
  let index = 0;
  while (index < args.length && !args[index].startsWith('-')) {
    paths.push(args[index]);
    index += 1;
  }
  if (paths.length === 0) throw new Error('find requires an explicit repository path.');
  for (const path of paths) containedPath(path, root, cwd);
  while (index < args.length) {
    const predicate = args[index];
    index += 1;
    if (predicate === '-maxdepth' || predicate === '-mindepth') {
      positiveCount(args[index], `find ${predicate}`);
      index += 1;
      continue;
    }
    if (predicate === '-type') {
      if (!['d', 'f', 'l'].includes(args[index] ?? '')) {
        throw new Error('find -type is outside the reviewed grammar.');
      }
      index += 1;
      continue;
    }
    if (predicate === '-name' || predicate === '-iname' || predicate === '-path' || predicate === '-ipath') {
      safeGlob(boundedLiteral(args[index], `find ${predicate}`));
      index += 1;
      continue;
    }
    if (predicate === '-a' || predicate === '-o' || predicate === '-print') continue;
    throw new Error('find predicate is outside the reviewed read-only grammar.');
  }
}

function assertSed(args: readonly string[], root: string, cwd: string): void {
  if (args.length < 2 || args[0] !== '-n' || !/^[0-9]+(?:,[0-9]+)?p$/u.test(args[1])) {
    throw new Error('sed is limited to one numeric print range.');
  }
  for (const path of args.slice(2)) {
    if (path.startsWith('-')) throw new Error('sed path is invalid.');
    containedPath(path, root, cwd);
  }
}

function assertRipgrep(args: readonly string[], root: string, cwd: string): void {
  let filesMode = false;
  const positionals: string[] = [];
  const valueOptions = new Set([
    '-A',
    '-B',
    '-C',
    '-g',
    '--after-context',
    '--before-context',
    '--context',
    '--glob',
    '--max-count',
    '--type',
  ]);
  const flags = new Set([
    '-F',
    '-S',
    '-i',
    '-l',
    '-n',
    '--files',
    '--files-with-matches',
    '--fixed-strings',
    '--hidden',
    '--ignore-case',
    '--line-number',
    '--no-heading',
    '--smart-case',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (flags.has(value)) {
      filesMode ||= value === '--files';
      continue;
    }
    if (valueOptions.has(value)) {
      const optionValue = boundedLiteral(args[++index], `rg ${value}`);
      if (value === '-g' || value === '--glob') safeGlob(optionValue);
      else if (value !== '--type') positiveCount(optionValue, `rg ${value}`);
      continue;
    }
    if (value.startsWith('-')) throw new Error('rg option is outside the reviewed grammar.');
    positionals.push(value);
  }
  const paths = filesMode ? positionals : positionals.slice(1);
  if (!filesMode && positionals.length === 0) throw new Error('rg requires an explicit search pattern.');
  for (const path of paths.length === 0 ? ['.'] : paths) containedPath(path, root, cwd);
}

/**
 * Keep the reviewed grammar deliberately smaller than grep's full CLI: no
 * recursive traversal, pattern files, binary modes, or filesystem-selection
 * globs. Existing operands are canonicalized because grep follows explicitly
 * named symlinks even without recursive flags.
 */
function assertGrep(args: readonly string[], root: string, cwd: string): void {
  let explicitPatterns = 0;
  const positionals: string[] = [];
  const flags = new Set([
    '-E',
    '-F',
    '-H',
    '-L',
    '-c',
    '-h',
    '-i',
    '-l',
    '-n',
    '-s',
    '-v',
    '-w',
    '-x',
    '--count',
    '--extended-regexp',
    '--files-with-matches',
    '--files-without-match',
    '--fixed-strings',
    '--ignore-case',
    '--invert-match',
    '--line-number',
    '--line-regexp',
    '--no-filename',
    '--no-messages',
    '--with-filename',
    '--word-regexp',
  ]);
  const countOptions = new Set([
    '-A',
    '-B',
    '-C',
    '-m',
    '--after-context',
    '--before-context',
    '--context',
    '--max-count',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (flags.has(value) || /^-[EFHLchilnsvwx]+$/u.test(value)) continue;
    if (countOptions.has(value)) {
      positiveCount(args[++index], `grep ${value}`);
      continue;
    }
    if (value === '-e' || value === '--regexp') {
      boundedLiteral(args[++index], `grep ${value}`);
      explicitPatterns += 1;
      continue;
    }
    if (value.startsWith('-')) throw new Error('grep option is outside the reviewed grammar.');
    positionals.push(value);
  }
  const implicitPatternCount = explicitPatterns === 0 ? 1 : 0;
  if (positionals.length < implicitPatternCount) throw new Error('grep requires an explicit bounded search pattern.');
  const paths = positionals.slice(implicitPatternCount);
  for (const path of paths.length === 0 ? ['.'] : paths) containedExistingPath(path, root, cwd);
}

function assertFileChanges(item: Record<string, unknown>, repositoryRoot: string): void {
  if (!Array.isArray(item.changes) || item.changes.length === 0) {
    throw new Error('Code Memory Link file change has no paths.');
  }
  for (const changeInput of item.changes) {
    const change = object(changeInput, 'file change');
    containedPath(text(change.path, 'file change path'), repositoryRoot);
    if (typeof change.diff !== 'string' || new TextEncoder().encode(change.diff).byteLength > 2 * 1_024 * 1_024) {
      throw new Error('Code Memory Link file-change diff is missing or oversized.');
    }
    const kind = object(change.kind, 'file change kind');
    if (kind.type !== undefined) {
      exactKeys(kind, kind.type === 'update' ? ['move_path', 'type'] : ['type'], 'file change kind', false);
      if (!['add', 'delete', 'update'].includes(String(kind.type))) {
        throw new Error('Code Memory Link file-change kind is invalid.');
      }
      if (kind.type === 'update' && kind.move_path != null) {
        containedPath(text(kind.move_path, 'file move path'), repositoryRoot);
      }
    } else if (kind.update !== undefined) {
      const update = object(kind.update, 'file update');
      if (update.movePath != null) containedPath(text(update.movePath, 'file move path'), repositoryRoot);
    } else {
      throw new Error('Code Memory Link file-change kind is invalid.');
    }
  }
}

export function tokenizeCodeMemoryLinkCommandV1(command: string): readonly string[] {
  if (command.length > 16_384 || /[\0\r\n]/u.test(command)) throw new Error('Command is not bounded single-line text.');
  const tokens: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | null = null;
  let active = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === 'single') {
      if (character === "'") quote = null;
      else token += character;
      active = true;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = null;
      else {
        if (character === '$' || character === '`') {
          throw new Error('Command contains expansion inside double quotes.');
        }
        if (character === '\\') {
          const next = command[index + 1];
          if (next === undefined) throw new Error('Command ends with an escape inside double quotes.');
          if (next === '"' || next === '\\') {
            token += next;
            index += 1;
          } else token += character;
        } else token += character;
      }
      active = true;
      continue;
    }
    if (character === "'") {
      quote = 'single';
      active = true;
    } else if (character === '"') {
      quote = 'double';
      active = true;
    } else if (/\s/u.test(character)) {
      if (active) {
        tokens.push(token);
        token = '';
        active = false;
      }
    } else {
      if (';&|<>`$(){}\\*?[]'.includes(character)) {
        throw new Error('Command contains shell control, expansion, or an unquoted glob.');
      }
      token += character;
      active = true;
    }
  }
  if (quote !== null) throw new Error('Command contains an unterminated quote.');
  if (active) tokens.push(token);
  if (tokens.length === 0) throw new Error('Command is empty.');
  return tokens;
}

function containedPath(value: string, rootInput: string, cwdInput = rootInput): string {
  if (value.includes('\0') || value.includes('\\')) throw new Error('Repository path is invalid.');
  const segments = value.split('/');
  if (segments.some(segment => segment === '..')) {
    throw new Error('Repository path contains a forbidden parent or control segment.');
  }
  const root = resolve(rootInput);
  const cwd = resolve(cwdInput);
  const candidate = resolve(isAbsolute(value) ? value : resolve(cwd, value));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error('App-server action referenced a path outside the public task repository.');
  }
  const repositoryRelativeSegments = candidate === root ? [] : relative(root, candidate).split(sep);
  if (repositoryRelativeSegments.some(segment => FORBIDDEN_PATH_SEGMENTS.has(segment))) {
    throw new Error('Repository path contains a forbidden parent or control segment.');
  }
  return candidate;
}

/**
 * grep follows an explicitly named symlink even without recursive flags. Resolve
 * existing operands so the reviewed read cannot escape through a repository
 * symlink; nonexistent operands remain harmless grep errors.
 */
function containedExistingPath(value: string, rootInput: string, cwdInput = rootInput): string {
  const candidate = containedPath(value, rootInput, cwdInput);
  try {
    const canonicalRoot = realpathSync(resolve(rootInput));
    const canonicalCandidate = realpathSync(candidate);
    if (canonicalCandidate !== canonicalRoot && !canonicalCandidate.startsWith(`${canonicalRoot}${sep}`)) {
      throw new Error('App-server action referenced a symlink target outside the public task repository.');
    }
  } catch (cause) {
    if (isMissingPath(cause)) return candidate;
    throw cause;
  }
  return candidate;
}

function isMissingPath(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
  );
}

function safeGlob(value: string): void {
  if (!value || value.length > 256 || value.includes('..') || /[{}\\]/u.test(value)) {
    throw new Error('rg glob is outside the reviewed grammar.');
  }
}

function positiveCount(value: string | undefined, label: string): void {
  if (!value || !/^[1-9][0-9]{0,5}$/u.test(value)) throw new Error(`${label} requires a bounded positive integer.`);
}

function boundedLiteral(value: string | undefined, label: string): string {
  if (!value || value.length > 256 || value.includes('\0')) throw new Error(`${label} requires a bounded value.`);
  return value;
}

function receipt(
  itemType: CodeMemoryLinkAppServerApprovalReceiptV1['itemType'],
  itemId: string,
  params: Record<string, unknown>,
): CodeMemoryLinkAppServerApprovalReceiptV1 {
  return {
    itemIdDigest: codeMemoryLinkAppServerOpaqueIdDigest('item', itemId),
    itemType,
    requestDigest: digest('approval', JSON.stringify(params)),
  };
}

function digest(domain: string, value: string): string {
  return createHash('sha256').update(`threadnote-code-memory-link-${domain}-v1\0${value}`).digest('hex');
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, optional: boolean): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some(key => !allowedSet.has(key))) throw new Error(`${label} has unsupported fields.`);
  if (!optional && allowed.some(key => !(key in value))) throw new Error(`${label} has missing fields.`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || value.includes('\0')) {
    throw new Error(`${label} must be bounded nonempty text.`);
  }
  return value;
}
