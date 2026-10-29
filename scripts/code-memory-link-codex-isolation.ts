import {isSafeInteger as checkedIsSafeInteger} from '@threadnote/platform/validation';
import {Array as EffectArray, Predicate} from 'effect';
/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed isolation builder owns disposable OS filesystem and process boundaries. */
import {createHash} from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {basename, delimiter, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {type CodeMemoryLinkAppServerCommand} from './code-memory-link-app-server-client.js';
import {randomUuidV4} from '@threadnote/threadnote/crypto/uuid';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_MEMORY_LINK_CODEX_CONFIG_VERSION = 1 as const;
export const CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION = 'codex-cli 0.149.0-alpha.4.1' as const;
export const CODE_MEMORY_LINK_PROXY_SERVER_NAME = 'context_brief_gate' as const;
export const CODE_MEMORY_LINK_PROXY_CAPABILITY_ENV = 'CODE_MEMORY_LINK_PROXY_PACKET' as const;
export const CODE_MEMORY_LINK_SAFE_EXECUTABLE_NAMES = [
  'cat',
  'file',
  'git',
  'head',
  'ls',
  'nl',
  'pwd',
  'rg',
  'sed',
  'stat',
  'tail',
  'wc',
] as const;
export const CODE_MEMORY_LINK_CODEX_ENVIRONMENT_POLICY_V1 = {
  appServerEnvironment: [
    CODE_MEMORY_LINK_PROXY_CAPABILITY_ENV,
    'CODEX_HOME',
    'HOME',
    'LANG',
    'LC_ALL',
    'NO_COLOR',
    'PATH',
    'TMPDIR',
  ],
  candidateEnvironment: [
    'CI',
    'HOME',
    'NO_COLOR',
    'NO_UPDATE_NOTIFIER',
    'PATH',
    'THREADNOTE_ACCOUNT',
    'THREADNOTE_AGENT_ID',
    'THREADNOTE_HOME',
    'THREADNOTE_NO_SPINNER',
    'THREADNOTE_NO_UPDATE_CHECK',
    'THREADNOTE_USER',
  ],
  shellEnvironment: ['LANG', 'LC_ALL', 'NO_COLOR', 'PATH'],
  version: 1,
} as const;

export interface CodeMemoryLinkCodexClientConfigV1 {
  readonly appServer: {
    readonly executable: string;
    readonly executableSha256: string;
    readonly version: typeof CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION;
  };
  readonly authSourcePath: string;
  readonly git: {
    readonly executable: string;
    readonly executableSha256: string;
  };
  readonly limits: {
    readonly turnTimeoutMilliseconds: number;
  };
  readonly model: {
    readonly id: string;
    readonly provider: string;
    readonly reasoningEffort: string;
  };
  readonly proxy: {
    readonly bunExecutable: string;
    readonly bunExecutableSha256: string;
    readonly bundlePath: string;
    readonly bundleSha256: string;
  };
  readonly safeBinaries: readonly {
    readonly name: (typeof CODE_MEMORY_LINK_SAFE_EXECUTABLE_NAMES)[number];
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly safeExecutablePath: string;
  readonly sealedSuite: {
    readonly layoutArtifactId: string;
    readonly root: string;
  };
  readonly temporaryRoot: string;
  readonly version: typeof CODE_MEMORY_LINK_CODEX_CONFIG_VERSION;
}

export interface CodeMemoryLinkCodexIsolation {
  readonly appServer: CodeMemoryLinkAppServerCommand;
  readonly codexHome: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly repositoryRoot: string;
  readonly root: string;
  readonly threadnoteHome: string;
  dispose(): Promise<void>;
}

const HASH = /^[0-9a-f]{64}$/u;
const ARTIFACT_ID = /^art_[0-9a-f]{16,64}$/u;
const MODEL = /^gpt-[a-z0-9.-]+$/u;
const PROVIDER = /^[a-z][a-z0-9_-]{1,63}$/u;
const EFFORT = /^(?:none|low|medium|high|xhigh|max)$/u;
const FORBIDDEN_FIXTURE_NAMES = new Set([
  '.codex',
  '.claude',
  '.cursor',
  '.git',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'hooks.json',
]);

export function parseCodeMemoryLinkCodexClientConfigV1(value: unknown): CodeMemoryLinkCodexClientConfigV1 {
  const config = object(value, 'Codex client config');
  exactKeys(config, [
    'appServer',
    'authSourcePath',
    'git',
    'limits',
    'model',
    'proxy',
    'safeBinaries',
    'safeExecutablePath',
    'sealedSuite',
    'temporaryRoot',
    'version',
  ]);
  if (config.version !== CODE_MEMORY_LINK_CODEX_CONFIG_VERSION) invalid('config version must be 1');
  const appServer = object(config.appServer, 'appServer');
  exactKeys(appServer, ['executable', 'executableSha256', 'version']);
  const model = object(config.model, 'model');
  exactKeys(model, ['id', 'provider', 'reasoningEffort']);
  const git = object(config.git, 'git');
  exactKeys(git, ['executable', 'executableSha256']);
  const limits = object(config.limits, 'limits');
  exactKeys(limits, ['turnTimeoutMilliseconds']);
  const proxy = object(config.proxy, 'proxy');
  exactKeys(proxy, ['bunExecutable', 'bunExecutableSha256', 'bundlePath', 'bundleSha256']);
  const sealedSuite = object(config.sealedSuite, 'sealedSuite');
  exactKeys(sealedSuite, ['layoutArtifactId', 'root']);
  const parsed = {
    appServer: {
      executable: absolutePath(appServer.executable, 'app-server executable'),
      executableSha256: hash(appServer.executableSha256, 'app-server executable'),
      version: literal(appServer.version, CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION, 'app-server version'),
    },
    authSourcePath: absolutePath(config.authSourcePath, 'auth source'),
    git: {
      executable: absolutePath(git.executable, 'Git executable'),
      executableSha256: hash(git.executableSha256, 'Git executable'),
    },
    limits: {
      turnTimeoutMilliseconds: integer(limits.turnTimeoutMilliseconds, 'turn timeout milliseconds', 1_000, 30 * 60_000),
    },
    model: {
      id: matchingText(model.id, MODEL, 'model id'),
      provider: matchingText(model.provider, PROVIDER, 'model provider'),
      reasoningEffort: matchingText(model.reasoningEffort, EFFORT, 'reasoning effort'),
    },
    proxy: {
      bunExecutable: absolutePath(proxy.bunExecutable, 'proxy Bun executable'),
      bunExecutableSha256: hash(proxy.bunExecutableSha256, 'proxy Bun executable'),
      bundlePath: absolutePath(proxy.bundlePath, 'proxy bundle'),
      bundleSha256: hash(proxy.bundleSha256, 'proxy bundle'),
    },
    safeBinaries: parseSafeBinaries(config.safeBinaries),
    safeExecutablePath: absolutePathList(config.safeExecutablePath, 'safe executable PATH'),
    sealedSuite: {
      layoutArtifactId: matchingText(sealedSuite.layoutArtifactId, ARTIFACT_ID, 'sealed suite layout artifact id'),
      root: absolutePath(sealedSuite.root, 'sealed suite root'),
    },
    temporaryRoot: absolutePath(config.temporaryRoot, 'temporary root'),
    version: CODE_MEMORY_LINK_CODEX_CONFIG_VERSION,
  } satisfies CodeMemoryLinkCodexClientConfigV1;
  if (parsed.model.id !== 'gpt-5.6-luna' && parsed.model.id !== 'gpt-5.6-terra') {
    invalid('model id must be one of the two reviewed gate clients');
  }
  if (EffectArray.some(parsed.safeBinaries, binary => dirname(binary.path) !== parsed.safeExecutablePath)) {
    invalid('every safe binary must live directly in the reviewed private PATH');
  }
  return parsed;
}

export function projectCodeMemoryLinkCodexClientConfigV1(config: CodeMemoryLinkCodexClientConfigV1) {
  return {
    appServer: {executableSha256: config.appServer.executableSha256, version: config.appServer.version},
    environmentPolicy: CODE_MEMORY_LINK_CODEX_ENVIRONMENT_POLICY_V1,
    gitSha256: config.git.executableSha256,
    model: config.model,
    proxy: {
      bundleSha256: config.proxy.bundleSha256,
      bunExecutableSha256: config.proxy.bunExecutableSha256,
      server: CODE_MEMORY_LINK_PROXY_SERVER_NAME,
      tool: 'context_brief',
      version: 1,
    },
    safeBinaries: EffectArray.map(config.safeBinaries, ({name, sha256}) => ({name, sha256})),
    sealedSuiteLayoutArtifactId: config.sealedSuite.layoutArtifactId,
    version: CODE_MEMORY_LINK_CODEX_CONFIG_VERSION,
  } as const;
}

export async function assertCodeMemoryLinkCodexArtifacts(config: CodeMemoryLinkCodexClientConfigV1): Promise<void> {
  const checks = [
    [config.appServer.executable, config.appServer.executableSha256, 'app-server executable'],
    [config.git.executable, config.git.executableSha256, 'Git executable'],
    [config.proxy.bunExecutable, config.proxy.bunExecutableSha256, 'proxy Bun executable'],
    [config.proxy.bundlePath, config.proxy.bundleSha256, 'proxy bundle'],
    ...EffectArray.map(
      config.safeBinaries,
      binary => [binary.path, binary.sha256, `safe ${binary.name} executable`] as const,
    ),
  ] as const;
  for (const [path, expectedHash, label] of checks) {
    const canonical = await realpath(path);
    if (canonical !== resolve(path)) throw new Error(`The reviewed ${label} must not be a mutable symlink.`);
    if (!(await stat(canonical)).isFile()) throw new Error(`The reviewed ${label} must be a regular file.`);
    if ((await sha256File(canonical)) !== expectedHash) throw new Error(`The reviewed ${label} hash changed.`);
  }
  const suiteRoot = await realpath(config.sealedSuite.root);
  if (suiteRoot !== resolve(config.sealedSuite.root) || !(await stat(suiteRoot)).isDirectory()) {
    throw new Error('The reviewed sealed suite root must be one canonical directory.');
  }
  const temporaryRoot = await realpath(config.temporaryRoot);
  if (temporaryRoot !== config.temporaryRoot || !(await stat(temporaryRoot)).isDirectory()) {
    throw new Error('The reviewed temporary root must be one canonical directory.');
  }
  const auth = await lstat(config.authSourcePath);
  if (!auth.isFile() || auth.isSymbolicLink()) throw new Error('Codex auth source must be a non-symlink regular file.');
  if ((await realpath(config.authSourcePath)) !== config.authSourcePath) {
    throw new Error('Codex auth source must be canonical.');
  }
  const version = await captureCommand(config.appServer.executable, ['--version'], 10_000);
  if (Effect.pipe(version.stdout, EffectString.trim) !== config.appServer.version)
    throw new Error('Codex app-server version is not pinned.');
}

export async function createCodeMemoryLinkCodexIsolation(input: {
  readonly config: CodeMemoryLinkCodexClientConfigV1;
  readonly fixtureRepository: string;
  readonly fixtureThreadnoteHome: string;
  readonly proxyPacket: (paths: {readonly repositoryRoot: string; readonly threadnoteHome: string}) => unknown;
}): Promise<CodeMemoryLinkCodexIsolation> {
  await assertCodeMemoryLinkCodexArtifacts(input.config);
  const root = await mkdtemp(join(input.config.temporaryRoot, 'threadnote-code-memory-link-codex-'));
  await chmod(root, 0o700);
  const codexHome = join(root, 'codex-home');
  const isolatedHome = join(root, 'home');
  const repositoryRoot = join(root, 'repository');
  const privateRoot = join(root, 'private');
  const threadnoteHome = join(privateRoot, 'threadnote-home');
  await Promise.all([mkdir(codexHome, {recursive: true}), mkdir(isolatedHome), mkdir(privateRoot)]);
  await Promise.all([
    copyFixtureTree(input.fixtureRepository, repositoryRoot),
    copyFixtureTree(input.fixtureThreadnoteHome, threadnoteHome, {allowAgentControlFiles: true}),
    copyPrivateFile(input.config.authSourcePath, join(codexHome, 'auth.json')),
  ]);
  const proxyPacketPath = join(privateRoot, `proxy-${randomUuidV4()}.json`);
  await writeFile(proxyPacketPath, `${JSON.stringify(input.proxyPacket({repositoryRoot, threadnoteHome}))}\n`, {
    mode: 0o600,
  });
  await writeFile(
    join(codexHome, 'config.toml'),
    buildCodeMemoryLinkCodexConfig({
      config: input.config,
      proxyPacketEnvironmentName: CODE_MEMORY_LINK_PROXY_CAPABILITY_ENV,
      repositoryRoot,
    }),
    {mode: 0o600},
  );
  return {
    appServer: {
      argumentsAfterSubcommand: [
        '--strict-config',
        '--disable',
        'apps',
        '--disable',
        'plugins',
        '--disable',
        'hooks',
        '--disable',
        'multi_agent',
        '--disable',
        'browser_use',
        '--disable',
        'computer_use',
        '--disable',
        'image_generation',
      ],
      executable: input.config.appServer.executable,
    },
    codexHome,
    environment: sanitizeCodeMemoryLinkAppServerEnvironment({
      codexHome,
      home: isolatedHome,
      proxyPacketPath,
      safeExecutablePath: input.config.safeExecutablePath,
      temporaryDirectory: root,
    }),
    repositoryRoot,
    root,
    threadnoteHome,
    dispose: () => rm(root, {force: true, recursive: true, maxRetries: 3}),
  };
}

export function sanitizeCodeMemoryLinkAppServerEnvironment(input: {
  readonly codexHome: string;
  readonly home: string;
  readonly proxyPacketPath: string;
  readonly safeExecutablePath: string;
  readonly temporaryDirectory: string;
}): Readonly<Record<string, string>> {
  return {
    [CODE_MEMORY_LINK_PROXY_CAPABILITY_ENV]: input.proxyPacketPath,
    CODEX_HOME: input.codexHome,
    HOME: input.home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    PATH: input.safeExecutablePath,
    TMPDIR: input.temporaryDirectory,
  };
}

export function buildCodeMemoryLinkCodexConfig(input: {
  readonly config: CodeMemoryLinkCodexClientConfigV1;
  readonly proxyPacketEnvironmentName: string;
  readonly repositoryRoot: string;
}): string {
  const {config} = input;
  return EffectArray.join(
    [
      `model = ${toml(config.model.id)}`,
      `model_provider = ${toml(config.model.provider)}`,
      `model_reasoning_effort = ${toml(config.model.reasoningEffort)}`,
      'approval_policy = "on-request"',
      'approvals_reviewer = "user"',
      'sandbox_mode = "workspace-write"',
      'allow_login_shell = false',
      'file_opener = "none"',
      'hide_agent_reasoning = true',
      'show_raw_agent_reasoning = false',
      'suppress_unstable_features_warning = true',
      'project_doc_max_bytes = 0',
      'project_doc_fallback_filenames = []',
      '',
      '[analytics]',
      'enabled = false',
      '',
      '[feedback]',
      'enabled = false',
      '',
      '[history]',
      'persistence = "none"',
      '',
      '[shell_environment_policy]',
      'inherit = "none"',
      'ignore_default_excludes = false',
      `include_only = ["PATH", "LANG", "LC_ALL", "NO_COLOR"]`,
      `set = { PATH = ${toml(config.safeExecutablePath)}, LANG = "C.UTF-8", LC_ALL = "C.UTF-8", NO_COLOR = "1" }`,
      '',
      '[tools]',
      'web_search = false',
      '',
      '[features]',
      'apps = false',
      'code_mode = true',
      'code_mode_only = true',
      'plugins = false',
      'hooks = false',
      'multi_agent = false',
      'browser_use = false',
      'computer_use = false',
      'image_generation = false',
      'non_prefixed_mcp_tool_names = true',
      'skill_mcp_dependency_install = false',
      'shell_snapshot = false',
      'tool_suggest = false',
      '',
      `[projects.${toml(input.repositoryRoot)}]`,
      'trust_level = "untrusted"',
      '',
      `[mcp_servers.${CODE_MEMORY_LINK_PROXY_SERVER_NAME}]`,
      `command = ${toml(config.proxy.bunExecutable)}`,
      `args = [${toml(config.proxy.bundlePath)}]`,
      'enabled = true',
      'required = true',
      'enabled_tools = ["context_brief"]',
      `env_vars = [${toml(input.proxyPacketEnvironmentName)}]`,
      'startup_timeout_sec = 20',
      'tool_timeout_sec = 120',
      'default_tools_approval_mode = "approve"',
      '',
    ],
    '\n',
  );
}

export async function copyFixtureTree(
  sourceInput: string,
  destination: string,
  options: {readonly allowAgentControlFiles?: boolean} = {},
): Promise<void> {
  const source = await realpath(sourceInput);
  if (!(await stat(source)).isDirectory()) throw new Error('Fixture repository must be a directory.');
  await mkdir(destination, {recursive: false});
  await copyDirectory(source, destination, source, options.allowAgentControlFiles === true);
}

async function copyDirectory(
  source: string,
  destination: string,
  fixtureRoot: string,
  allowAgentControlFiles: boolean,
): Promise<void> {
  const entries = (await readdir(source)).sort();
  for (const entry of entries) {
    if (!allowAgentControlFiles && FORBIDDEN_FIXTURE_NAMES.has(entry)) {
      throw new Error(`Fixture contains forbidden agent control file ${entry}.`);
    }
    const sourcePath = join(source, entry);
    const destinationPath = join(destination, entry);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) throw new Error('Fixture symlinks are forbidden.');
    if (metadata.isDirectory()) {
      await mkdir(destinationPath);
      await copyDirectory(sourcePath, destinationPath, fixtureRoot, allowAgentControlFiles);
    } else if (metadata.isFile()) {
      const relativePath = relative(fixtureRoot, sourcePath);
      if (Effect.pipe(relativePath, EffectString.startsWith('..')) || isAbsolute(relativePath))
        throw new Error('Fixture path escaped its root.');
      await copyFile(sourcePath, destinationPath);
      await chmod(destinationPath, 0o600);
    } else throw new Error('Fixture contains a non-regular filesystem entry.');
  }
}

async function copyPrivateFile(source: string, destination: string): Promise<void> {
  const content = await readFile(source);
  await writeFile(destination, content, {mode: 0o600});
}

async function captureCommand(executable: string, args: readonly string[], timeoutMilliseconds: number) {
  return new Promise<{readonly stderr: string; readonly stdout: string}>((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {env: {HOME: dirname(executable), PATH: dirname(executable)}});
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMilliseconds);
    child.stdout.on('data', value => stdout.push(Buffer.from(value)));
    child.stderr.on('data', value => stderr.push(Buffer.from(value)));
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error('Could not verify the pinned Codex version.'));
      else
        resolvePromise({
          stderr: Effect.pipe(Buffer.concat(stderr).toString('utf8'), EffectString.slice(-4096)),
          stdout: Effect.pipe(Buffer.concat(stdout).toString('utf8'), EffectString.slice(-4096)),
        });
    });
  });
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function absolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    Effect.pipe(value, EffectString.includes('\0'))
  ) {
    invalid(`${label} must be a normalized absolute path`);
  }
  return value;
}

function absolutePathList(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be non-empty`);
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
  const entries = value.split(delimiter);
  if (
    EffectArray.some(
      entries,
      entry => !isAbsolute(entry) || resolve(entry) !== entry || Effect.pipe(entry, EffectString.includes('\0')),
    )
  ) {
    invalid(`${label} must contain only normalized absolute paths`);
  }
  if (entries.length !== 1) invalid(`${label} must name one private reviewed directory`);
  return entries[0];
}

function parseSafeBinaries(value: unknown): CodeMemoryLinkCodexClientConfigV1['safeBinaries'] {
  if (!EffectArray.isArray(value)) invalid('safeBinaries must be an array');
  const expectedNames = [...CODE_MEMORY_LINK_SAFE_EXECUTABLE_NAMES];
  if (value.length !== expectedNames.length) invalid('safeBinaries must contain the complete reviewed command set');
  return EffectArray.map(value, (entry, index) => {
    const binary = object(entry, `safe binary ${index + 1}`);
    exactKeys(binary, ['name', 'path', 'sha256']);
    if (typeof binary.name !== 'string' || !isCodeMemoryLinkSafeExecutableName(binary.name)) {
      invalid(`safe binary ${index + 1} name is invalid`);
    }
    const name = binary.name;
    if (name !== expectedNames[index]) invalid('safeBinaries must use canonical name order');
    const path = absolutePath(binary.path, `safe ${name} executable`);
    if (basename(path) !== name) invalid(`safe ${name} executable must use its reviewed basename`);
    return {name, path, sha256: hash(binary.sha256, `safe ${name} executable`)};
  });
}

function isCodeMemoryLinkSafeExecutableName(
  value: string,
): value is (typeof CODE_MEMORY_LINK_SAFE_EXECUTABLE_NAMES)[number] {
  return EffectArray.some(CODE_MEMORY_LINK_SAFE_EXECUTABLE_NAMES, name => name === value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = EffectRecord.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || EffectArray.some(actual, (key, index) => key !== wanted[index])) {
    invalid('object has unsupported or missing fields');
  }
}

function hash(value: unknown, label: string): string {
  return matchingText(value, HASH, `${label} hash`);
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!checkedIsSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} is out of range`);
  }
  return value;
}

function literal<T extends string | number>(value: unknown, expected: T, label: string): T {
  if (value !== expected) invalid(`${label} must equal ${String(expected)}`);
  return expected;
}

function matchingText(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function toml(value: string): string {
  return JSON.stringify(value);
}

function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link Codex client config: ${message}.`);
}
