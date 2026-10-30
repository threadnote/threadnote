import {Predicate} from 'effect';
import {Array as EffectArray} from 'effect';
/** Compiled host controller: drive the extracted native CLI outside the checkout. */
// Bun 1.4.2 compile cannot bundle the testing builtin export-star wrappers.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import * as fs from 'node:fs';
// oxlint-disable-next-line effecttsgo/node-builtin-import
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
// oxlint-disable-next-line effecttsgo/node-builtin-import
import {createHash, randomBytes} from 'node:crypto';
// oxlint-disable-next-line effecttsgo/node-builtin-import
import {request as httpRequest} from 'node:http';
import {constants, devNull, tmpdir} from 'node:os';
import {basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep} from '@threadnote/testing/node-path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect} from 'effect';
import {isDeepStrictEqual} from 'node:util';
import {extractGzipTar} from '../../src/effect/archive.js';
import {runReleaseCommand} from './native-release-process.js';
import {runNativeWorkflows} from './native-release-workflows.js';
import {nativeSocketConnect, requireNativeNetworkDenial} from './native-release-network-probe.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const errorCode = (error: unknown) =>
  Predicate.hasProperty(error, 'code') && typeof error.code === 'string' ? error.code : undefined;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sleep = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));
const readJson = (path: string): unknown => JSON.parse(fs.readFileSync(path, 'utf8'));
const writeJson = (path: string, value: unknown) =>
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
const inside = (root: string, target: string) => {
  const part = relative(root, target);
  return (
    part === '' || (!isAbsolute(part) && part !== '..' && !Effect2.pipe(part, EffectString.startsWith(`..${sep}`)))
  );
};

interface LockOwner {
  version: number;
  processId: number;
  token: string;
}
interface ManagerPreview {
  canApply: boolean;
  issues: unknown;
  previewDigest: string;
  target: {layout: string};
}
interface ManagerApply {
  result: {applied: boolean};
  status: {targets: {installationState: string}[]};
}
interface WatchEvent {
  id: string;
  kind: string;
}
interface WatchDelivery {
  id: string;
  events: WatchEvent[];
}
interface WatchWork {
  eventId: string;
  status: string;
}
interface WatchResponse {
  status: string;
  collector: {alive: boolean} | null;
  delivery?: WatchDelivery;
  sourceErrors: unknown[];
  sources?: unknown[];
  pending: number;
  work: {open: number; items?: WatchWork[]};
  revision: string;
}

interface WatchWorkResponse {
  status: string;
  watchId: string;
  revision: string;
  work: {
    items?: WatchWork[];
    offset: number;
    nextOffset: number | null;
  };
}
interface ReleaseManifest {
  digest: string;
  schemaVersion: number;
  hashes: Record<string, string>;
  skills: {id: string}[];
}
interface Installation {
  applied: boolean;
  target: {skillRoot: string};
  bundleDigest: string;
}
interface Release {
  executable: string;
  devSkills: {manifest: string};
}
interface StageResult {
  status: string;
  isolation: {enforced: boolean};
  [key: string]: unknown;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function parseLockOwner(value: unknown): LockOwner {
  const record = objectRecord(value, 'Lock owner');
  return {
    version: numberField(record.version, 'Lock owner version'),
    processId: numberField(record.processId, 'Lock owner process id'),
    token: stringField(record.token, 'Lock owner token'),
  };
}

function numberField(value: unknown, label: string): number {
  if (typeof value !== 'number') throw new Error(`${label} must be a number.`);
  return value;
}

function parseRelease(value: unknown): Release {
  const record = objectRecord(value, 'Release');
  const devSkills = objectRecord(record.devSkills, 'Release developer skills');
  return {
    executable: stringField(record.executable, 'Release executable'),
    devSkills: {manifest: stringField(devSkills.manifest, 'Release manifest path')},
  };
}

function parseReleaseManifest(value: unknown): ReleaseManifest {
  const record = objectRecord(value, 'Release manifest');
  const rawHashes = objectRecord(record.hashes, 'Release hashes');
  const hashes: Record<string, string> = {};
  for (const [name, hash] of EffectRecord.toEntries(rawHashes))
    hashes[name] = stringField(hash, `Release hash ${name}`);
  if (!EffectArray.isArray(record.skills)) throw new Error('Release skills must be an array.');
  return {
    digest: stringField(record.digest, 'Release digest'),
    schemaVersion: numberField(record.schemaVersion, 'Release schema version'),
    hashes,
    skills: EffectArray.map(record.skills, (skill, index) => ({
      id: stringField(objectRecord(skill, `Release skill ${index}`).id, `Release skill ${index} id`),
    })),
  };
}

function parseInstallation(value: unknown): Installation {
  const record = objectRecord(value, 'Installation');
  const target = objectRecord(record.target, 'Installation target');
  return {
    applied: booleanField(record.applied, 'Installation applied'),
    target: {skillRoot: stringField(target.skillRoot, 'Installation skill root')},
    bundleDigest: stringField(record.bundleDigest, 'Installation bundle digest'),
  };
}

function parseManagerPreview(value: unknown): ManagerPreview {
  const record = objectRecord(value, 'Manager preview');
  const target = objectRecord(record.target, 'Manager preview target');
  return {
    canApply: booleanField(record.canApply, 'Manager preview canApply'),
    issues: record.issues,
    previewDigest: stringField(record.previewDigest, 'Manager preview digest'),
    target: {layout: stringField(target.layout, 'Manager preview layout')},
  };
}

function parseManagerApply(value: unknown): ManagerApply {
  const record = objectRecord(value, 'Manager apply');
  const result = objectRecord(record.result, 'Manager apply result');
  const status = objectRecord(record.status, 'Manager apply status');
  if (!EffectArray.isArray(status.targets)) throw new Error('Manager apply targets must be an array.');
  return {
    result: {applied: booleanField(result.applied, 'Manager apply result applied')},
    status: {
      targets: EffectArray.map(status.targets, (target, index) => ({
        installationState: stringField(
          objectRecord(target, `Manager target ${index}`).installationState,
          `Manager target ${index} state`,
        ),
      })),
    },
  };
}

function parseStageResult(value: unknown): StageResult {
  const record = objectRecord(value, 'Release stage result');
  const isolation = objectRecord(record.isolation, 'Release isolation result');
  return {
    ...record,
    status: stringField(record.status, 'Release result status'),
    isolation: {enforced: booleanField(isolation.enforced, 'Release isolation enforced')},
  };
}

export function parseWatchWorkResponse(value: unknown): WatchWorkResponse {
  const record = objectRecord(value, 'Native watch work response');
  const work = objectRecord(record.work, 'Native watch work');
  if (!EffectArray.isArray(work.items)) throw new Error('Native watch work items must be an array.');
  if (work.nextOffset !== null && typeof work.nextOffset !== 'number')
    throw new Error('Native watch work next offset must be a number or null.');
  return {
    status: stringField(record.status, 'Native watch work status'),
    watchId: stringField(record.watchId, 'Native watch work id'),
    revision: stringField(record.revision, 'Native watch work revision'),
    work: {
      items: EffectArray.map(work.items, (item, index) => {
        const entry = objectRecord(item, `Native watch work item ${index}`);
        return {
          eventId: stringField(entry.eventId, `Native watch work item ${index} event id`),
          status: stringField(entry.status, `Native watch work item ${index} status`),
        };
      }),
      offset: numberField(work.offset, 'Native watch work offset'),
      nextOffset: work.nextOffset === null ? null : numberField(work.nextOffset, 'Native watch work next offset'),
    },
  };
}

export function parseWatchResponse(value: unknown): WatchResponse {
  const record = objectRecord(value, 'Native watch response');
  const collector = record.collector === null ? null : objectRecord(record.collector, 'Native watch collector');
  const work = objectRecord(record.work, 'Native watch work');
  if (
    !EffectArray.isArray(record.sourceErrors) ||
    (record.sources !== undefined && !EffectArray.isArray(record.sources)) ||
    (work.items !== undefined && !EffectArray.isArray(work.items))
  )
    throw new Error('Native watch response arrays are malformed.');
  let delivery: WatchDelivery | undefined;
  if (record.delivery !== undefined && record.delivery !== null) {
    const source = objectRecord(record.delivery, 'Native watch delivery');
    if (!EffectArray.isArray(source.events)) throw new Error('Native watch events must be an array.');
    delivery = {
      id: stringField(source.id, 'Native watch delivery id'),
      events: EffectArray.map(source.events, (event, index) => {
        const item = objectRecord(event, `Native watch event ${index}`);
        return {
          id: stringField(item.id, `Native watch event ${index} id`),
          kind: stringField(item.kind, `Native watch event ${index} kind`),
        };
      }),
    };
  }
  return {
    status: stringField(record.status, 'Native watch status'),
    collector: collector === null ? null : {alive: booleanField(collector.alive, 'Native watch collector alive')},
    ...(delivery === undefined ? {} : {delivery}),
    sourceErrors: record.sourceErrors,
    ...(record.sources === undefined ? {} : {sources: record.sources}),
    pending: numberField(record.pending, 'Native watch pending'),
    work: {
      open: numberField(work.open, 'Native watch open work'),
      ...(work.items === undefined
        ? {}
        : {
            items: EffectArray.map(work.items, (item, index) => {
              const value = objectRecord(item, `Native watch work ${index}`);
              return {
                eventId: stringField(value.eventId, `Native watch work ${index} event id`),
                status: stringField(value.status, `Native watch work ${index} status`),
              };
            }),
          }),
    },
    revision: stringField(record.revision, 'Native watch revision'),
  };
}

function parseJsonArray(value: unknown, label: string): unknown[] {
  if (!EffectArray.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

export function digest(path: string): string {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count: number;
    while ((count = fs.readSync(descriptor, buffer)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

type InventoryEntry = {link: string} | {directory: true} | {sha256: string};
export function inventory(root: string): Record<string, InventoryEntry> {
  const entries: Record<string, InventoryEntry> = {};
  const visit = (directory: string) => {
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory).sort()) {
      const path = join(directory, name);
      const key = Effect2.pipe(relative(root, path), EffectString.split(sep), EffectArray.join('/'));
      const stat = fs.lstatSync(path);
      if (stat.isSymbolicLink()) entries[key] = {link: fs.readlinkSync(path)};
      else if (stat.isDirectory()) {
        entries[key] = {directory: true};
        visit(path);
      } else entries[key] = {sha256: digest(path)};
    }
  };
  visit(root);
  return entries;
}

export interface CleanupFileSystem {
  lstatSync: typeof fs.lstatSync;
  realpathSync: typeof fs.realpathSync;
  readdirSync: typeof fs.readdirSync;
  unlinkSync: typeof fs.unlinkSync;
  chmodSync: typeof fs.chmodSync;
  rmdirSync: typeof fs.rmdirSync;
}

/** Repair one owned read-only regular file after a Windows permission failure. */
export function retryOwnedReadonlyFile(
  root: string,
  candidate: string,
  error: unknown,
  options: {platform?: NodeJS.Platform; filesystem?: CleanupFileSystem} = {},
): void {
  const filesystem = options.filesystem ?? fs;
  if ((options.platform ?? process.platform) !== 'win32' || !['EACCES', 'EPERM'].includes(errorCode(error) ?? ''))
    throw error;
  const stat = filesystem.lstatSync(candidate);
  if (!stat.isFile() || stat.mode & 0o200 || !inside(filesystem.realpathSync(root), filesystem.realpathSync(candidate)))
    throw error;
  filesystem.chmodSync(candidate, stat.mode | 0o200);
  filesystem.unlinkSync(candidate); // Exactly one retry; its original error escapes.
}

export function removeOwnedFixture(
  root: string,
  options: {platform?: NodeJS.Platform; filesystem?: CleanupFileSystem} = {},
): void {
  const filesystem = options.filesystem ?? fs;
  const owned = filesystem.realpathSync(root);
  const visit = (path: string) => {
    const stat = filesystem.lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of filesystem.readdirSync(path)) visit(join(path, name));
      filesystem.rmdirSync(path);
    } else {
      try {
        filesystem.unlinkSync(path);
      } catch (error) {
        retryOwnedReadonlyFile(owned, path, error, options);
      }
    }
  };
  visit(root);
}

function copyNativeLogs(root: string, destination: string) {
  for (const name of EffectArray.filter(
    fs.readdirSync(root),
    (name): name is string => typeof name === 'string' && Effect2.pipe(name, EffectString.endsWith('-native.log')),
  )) {
    for (const suffix of ['', '.stdout.bin', '.stderr.bin'])
      fs.copyFileSync(join(root, name + suffix), join(destination, name + suffix));
  }
}
const evidenceDirectory = (report: string) => {
  const name = basename(report);
  const dot = Effect2.pipe(
    name,
    EffectString.lastIndexOf('.'),
    Effect2.Option.getOrElse(() => -1),
  );
  return (
    (dot > 0 ? Effect2.pipe(report, EffectString.slice(0, report.length - name.length + dot)) : report) + '.provenance'
  );
};
function preserveFailedNativeLogs(root: string, report: string) {
  try {
    const destination = evidenceDirectory(report);
    fs.mkdirSync(destination, {recursive: true});
    copyNativeLogs(root, destination);
  } catch {
    /* Evidence retention cannot replace the original staging error. */
  }
}

function fixtureEnvironment(root: string, runtime: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  const user = join(root, 'user');
  Object.assign(environment, {
    PATH: runtime + delimiter + join(root, 'tools'),
    THREADNOTE_RELEASE_FIXTURE_ROOT: root,
    HOME: user,
    USERPROFILE: user,
    THREADNOTE_HOME: join(root, 'data'),
    THREADNOTE_USER: 'release-fixture',
    THREADNOTE_AGENT_ID: 'test',
    THREADNOTE_BIN_DIR: join(root, 'bin'),
    THREADNOTE_INSTALL_ROOT: join(root, 'runtime'),
    XDG_CONFIG_HOME: join(user, '.config'),
    XDG_DATA_HOME: join(user, '.local/share'),
    XDG_STATE_HOME: join(user, '.local/state'),
    XDG_CACHE_HOME: join(user, '.cache'),
    APPDATA: join(user, 'appdata'),
    LOCALAPPDATA: join(user, 'localappdata'),
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file',
    NO_COLOR: '1',
    NO_UPDATE_NOTIFIER: '1',
    THREADNOTE_NO_UPDATE_CHECK: '1',
    THREADNOTE_AUTO_UPDATE: 'off',
  });
  fs.mkdirSync(user);
  fs.mkdirSync(join(root, 'tmp'));
  return environment;
}

export async function verifyIsolation(checkout: string, enforced: boolean) {
  if (!enforced)
    return {enforced: false, reason: 'Functional native Windows lane; OS isolation acceptance is pending.'};
  let sourceErrno: number | undefined;
  try {
    fs.readFileSync(join(checkout, 'config/agent-skills/dev-plan/SKILL.md'));
  } catch (error) {
    const code = errorCode(error);
    requireCondition(['EPERM', 'EACCES', 'ENOENT'].includes(code ?? ''), `Unexpected source denial: ${message(error)}`);
    if (code === undefined) throw new Error('Expected an errno code for the source denial.', {cause: error});
    const errno = Object.getOwnPropertyDescriptor(constants.errno, code)?.value;
    if (typeof errno === 'number') sourceErrno = errno;
  }
  requireCondition(sourceErrno !== undefined, 'The source checkout is readable inside the isolated fixture');
  const denied = requireNativeNetworkDenial(await nativeSocketConnect());
  return {
    enforced: true,
    sourceReadErrno: sourceErrno,
    outboundConnectErrno: denied,
    exceptions:
      process.platform === 'darwin' ? ['/bin/ps only: system process-identity probe executes without sandbox'] : [],
  };
}

async function withLock<A>(root: string, relativePath: string, label: string, program: () => Promise<A>): Promise<A> {
  const lock = join(root, relativePath);
  fs.mkdirSync(dirname(lock), {recursive: true});
  const token = JSON.stringify({version: 1, processId: process.pid, token: randomBytes(16).toString('hex')}) + '\n';
  const deadline = performance.now() + 10_000;
  let descriptor: number;
  while (true) {
    try {
      descriptor = fs.openSync(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      requireCondition(
        performance.now() < deadline,
        `${label === 'account mutation' ? 'Account mutation' : label} lock did not become available`,
      );
      await sleep(10);
    }
  }
  let bodyFailed = false;
  const owned = () => {
    try {
      return fs.readFileSync(lock, 'utf8') === token;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  };
  const releaseLock = () => {
    try {
      if (owned()) fs.unlinkSync(lock);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && !bodyFailed) throw error;
    }
  };
  try {
    try {
      fs.writeFileSync(descriptor, token, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const result = await program();
    requireCondition(owned(), `Fixture lost ownership of the ${label} lock`);
    return result;
  } catch (error) {
    bodyFailed = true;
    throw error;
  } finally {
    releaseLock();
  }
}

export const withAccountMutationLock = <A>(root: string, program: () => Promise<A>): Promise<A> =>
  withLock(root, 'data/locks/resources/local/mutations.lock', 'account mutation', program);

async function waitForCompactionScheduler(root: string, manager: ChildProcess) {
  const lock = join(root, 'data/locks/indexes/code-graph/automatic-compaction-scheduler.lock');
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    requireCondition(
      manager.exitCode === null && manager.signalCode === null,
      'Manager stopped before its compaction scheduler was ready',
    );
    try {
      const owner = parseLockOwner(readJson(lock));
      if (owner.version === 1 && owner.processId === manager.pid && owner.token) return;
    } catch (error) {
      if (!(error instanceof SyntaxError) && !errorCode(error)) throw error;
    }
    await sleep(10);
  }
  throw new Error('Manager did not acquire its automatic compaction scheduler lock');
}

function managerRequest(
  origin: string,
  token: string,
  path: string,
  body?: unknown,
  authenticated = true,
  expected = 200,
): Promise<unknown | Buffer> {
  return new Promise((done, reject) => {
    const headers: Record<string, string> = {'Content-Type': 'application/json'};
    if (authenticated) headers.Authorization = `Bearer ${token}`;
    const request = httpRequest(
      new URL(path, origin),
      {headers, method: body === undefined ? 'GET' : 'POST'},
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => {
          try {
            const payload = Buffer.concat(chunks);
            requireCondition(
              response.statusCode === expected,
              `${path}: ${response.statusCode} ${Effect2.pipe(payload.toString('utf8'), EffectString.slice(0, 1000))}`,
            );
            const result: unknown | Buffer = Effect2.pipe(path, EffectString.startsWith('/api/'))
              ? JSON.parse(payload.toString('utf8'))
              : payload;
            done(result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(30_000, () => request.destroy(new Error('Manager request timed out')));
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function waitManagerExit(manager: ChildProcess, timeoutMs: number): Promise<void> {
  if (manager.exitCode !== null || manager.signalCode !== null) return;
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => {
      manager.off('exit', exit);
      reject(new Error('Manager shutdown timed out'));
    }, timeoutMs);
    const exit = () => {
      clearTimeout(timeout);
      done();
    };
    manager.once('exit', exit);
  });
}

async function managerChecksWhilePaused(
  root: string,
  binary: string,
  environment: NodeJS.ProcessEnv,
  checks: unknown[],
) {
  const log = join(root, 'manager.log');
  const output = fs.openSync(log, 'w');
  const manager = spawn(binary, ['manage', '--no-open', '--ui-port', '0'], {
    env: environment,
    cwd: root,
    stdio: ['ignore', output, output],
  });
  fs.closeSync(output);
  let spawnError: Error | undefined;
  manager.once('error', error => {
    spawnError = error;
  });
  try {
    const deadline = performance.now() + 45_000;
    let match: RegExpMatchArray | null = null;
    while (performance.now() < deadline) {
      const contents = fs.readFileSync(log, 'utf8');
      match = Effect2.pipe(
        contents,
        EffectString.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=([^\s]+)/),
        Effect2.Option.getOrElse(() => null),
      );
      if (match) break;
      if (spawnError) throw spawnError;
      requireCondition(
        manager.exitCode === null && manager.signalCode === null,
        `Manager stopped: ${Effect2.pipe(contents, EffectString.slice(-3000))}`,
      );
      await sleep(100);
    }
    requireCondition(match, 'Manager startup timed out');
    const origin = Effect2.pipe(match[0], EffectString.split('/?'))[0];
    const token = decodeURIComponent(match[1]);
    const request = (path: string, body?: unknown, authenticated = true, expected = 200) =>
      managerRequest(origin, token, path, body, authenticated, expected);
    requireCondition(
      await request('/').then(
        value =>
          Buffer.isBuffer(value) &&
          Effect2.pipe(value.toString('utf8'), EffectString.toLowerCase, EffectString.includes('<html')),
      ),
      'Packaged Manager HTML is missing',
    );
    await request('/api/dev-skills/catalog', undefined, false, 401);
    await request('/api/dev-skills/catalog');
    await waitForCompactionScheduler(root, manager);
    const selector = {agent: 'antigravity-cli', scope: 'user'};
    for (const action of ['install', 'update', 'remove']) {
      const preview = await withLock(root, 'data/context-maintenance/state-v2.json.lock', 'maintenance', () =>
        withAccountMutationLock(root, async () => {
          const before = EffectRecord.fromEntries(
            EffectArray.map(['user', 'data', 'runtime'], name => [name, inventory(join(root, name))]),
          );
          const preview = parseManagerPreview(await request('/api/dev-skills/preview', {action, selector}));
          requireCondition(preview.canApply, `Manager preview blocked: ${JSON.stringify(preview.issues)}`);
          const after = EffectRecord.fromEntries(
            EffectArray.map(EffectRecord.keys(before), name => [name, inventory(join(root, name))]),
          );
          const changed = EffectArray.flatMap(EffectRecord.keys(before), name =>
            EffectArray.map(
              EffectArray.filter(
                [...new Set([...EffectRecord.keys(before[name]), ...EffectRecord.keys(after[name])])].sort(),
                path => !isDeepStrictEqual(before[name][path], after[name][path]),
              ),
              path => `${name}/${path}`,
            ),
          );
          requireCondition(
            isDeepStrictEqual(before, after),
            `Manager ${action} preview changed files (${changed.length}): ${JSON.stringify(changed.slice(0, 30))}`,
          );
          return preview;
        }),
      );
      const result = parseManagerApply(
        await request('/api/dev-skills/apply', {
          action,
          selector,
          previewDigest: preview.previewDigest,
          confirm: true,
        }),
      );
      requireCondition(result.result.applied === (action !== 'update'), 'Unexpected Manager apply result');
      const target = result.status.targets[0];
      requireCondition(
        target.installationState === (action === 'remove' ? 'absent' : 'current'),
        'Manager status does not match apply',
      );
      checks.push({managerAction: action, layout: preview.target.layout, state: target.installationState});
    }
  } finally {
    manager.kill();
    try {
      await waitManagerExit(manager, 10_000);
    } catch {
      manager.kill('SIGKILL');
      await waitManagerExit(manager, 10_000);
    }
  }
}

async function managerChecks(root: string, binary: string, environment: NodeJS.ProcessEnv, checks: unknown[]) {
  const call = (action: string) =>
    JSON.parse(runReleaseCommand([binary, 'context', 'maintain', '--action', action, '--json'], environment, root));
  const previous = call('status');
  let bodyFailed = false;
  const restore = () => {
    if (!previous.paused) {
      try {
        requireCondition(call('resume').paused === false, 'Context maintenance pause state was not restored');
      } catch (error) {
        if (!bodyFailed) throw error;
        process.stderr.write(`Maintenance pause-state restoration also failed: ${message(error)}\n`);
      }
    }
  };
  try {
    if (!previous.paused)
      requireCondition(call('pause').paused === true, 'Context maintenance did not pause in the fixture home');
    await managerChecksWhilePaused(root, binary, environment, checks);
  } catch (error) {
    bodyFailed = true;
    throw error;
  } finally {
    restore();
  }
}

async function nativeWatchChecks(root: string, binary: string, environment: NodeJS.ProcessEnv) {
  const base = {
    protocolVersion: 1,
    executorVersion: 1,
    action: 'watch',
    watchId: 'extracted-release',
    consumerId: 'release-consumer',
    wakeupId: 'release-fixture',
  };
  const receipt = join(root, 'provenance/watch-deliveries.json');
  fs.mkdirSync(dirname(receipt), {recursive: true});
  const deliveries: unknown[] = [];
  const readResponse = (command: string, fields: Record<string, unknown> = {}): unknown =>
    JSON.parse(
      runReleaseCommand([binary, 'workflow-automation'], environment, root, {
        input: JSON.stringify({...base, command, ...fields}),
      }),
    );
  const call = (command: string, fields: Record<string, unknown> = {}): WatchResponse => {
    const response = parseWatchResponse(readResponse(command, fields));
    requireCondition(response.status === 'ok', `Native watch failed: ${JSON.stringify(response)}`);
    return response;
  };
  const callWork = (): WatchWorkResponse => {
    const response = parseWatchWorkResponse(readResponse('work'));
    requireCondition(response.status === 'ok', `Native watch failed: ${JSON.stringify(response)}`);
    return response;
  };
  const settle = (delivery: WatchDelivery, status: string) => {
    const dispositions = EffectArray.map(delivery.events, event => ({
      eventId: event.id,
      status,
      reason: 'Private extracted-release lifecycle observation.',
      evidence: 'provenance/watch-deliveries.json',
    }));
    deliveries.push({delivery, dispositions});
    const descriptor = fs.openSync(receipt, 'w');
    try {
      fs.writeFileSync(descriptor, JSON.stringify(deliveries, null, 2) + '\n', 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    call('disposition', {deliveryId: delivery.id, dispositions});
    return call('ack', {deliveryId: delivery.id});
  };
  let started = false;
  try {
    const initial = call('start', {pr: 'https://github.com/fixture/repo/pull/1'});
    started = true;
    requireCondition(initial.collector?.alive, 'Native collector did not start');
    const deadline = performance.now() + 30_000;
    let delivery: WatchDelivery | undefined;
    while (performance.now() < deadline) {
      delivery = call('wait', {timeoutSeconds: 1}).delivery;
      if (delivery) break;
    }
    requireCondition(delivery, 'Native collector missed the private provider signals');
    let health = call('inspect');
    requireCondition(
      health.sourceErrors.length === 0 && health.sources?.length === 5,
      'Native watch did not complete all five sources',
    );
    requireCondition(
      isDeepStrictEqual(EffectArray.map(delivery.events, event => event.kind).sort(), [
        'ci_error',
        'comment',
        'review_thread',
      ]),
      'Native provider signals were lost or invented',
    );
    const requests = fs.readFileSync(join(root, 'provider-requests.json'));
    requireCondition(
      isDeepStrictEqual(call('relay').delivery, delivery),
      'Unacknowledged native delivery did not replay',
    );
    requireCondition(
      fs.readFileSync(join(root, 'provider-requests.json')).equals(requests),
      'Relay consumption started a competing GitHub poll',
    );
    const acknowledged = settle(delivery, 'open');
    requireCondition(acknowledged.pending === 0 && acknowledged.work.open === 3, 'ACK discarded actionable work');
    const work = callWork().work.items;
    requireCondition(work !== undefined, 'Native work response omitted its items');
    requireCondition(
      isDeepStrictEqual(
        new Set(EffectArray.map(work, item => item.eventId)),
        new Set(EffectArray.map(delivery.events, event => event.id)),
      ),
      'Actionable work was not durably retained',
    );
    health = call('inspect');
    call('work-disposition', {
      expectedRevision: health.revision,
      dispositions: EffectArray.map(work, item => ({
        eventId: item.eventId,
        status: 'resolved',
        reason: 'Synthetic fixture issues verified.',
        evidence: 'provenance/watch-deliveries.json',
      })),
    });
    const resolvedWork = callWork().work.items;
    requireCondition(
      resolvedWork !== undefined && EffectArray.every(resolvedWork, item => item.status === 'resolved'),
      'Verified work disposition was not retained',
    );
    return {
      nativeWatch: 'passed',
      signals: 3,
      sources: 5,
      replayed: true,
      ackRetainedOpenWork: true,
      provider: 'private compiled frozen fixture',
    };
  } finally {
    if (started) {
      call('stop');
      const deadline = performance.now() + 15_000;
      let stopped = call('inspect');
      while (stopped.collector?.alive && performance.now() < deadline) {
        await sleep(50);
        stopped = call('inspect');
      }
      requireCondition(!stopped.collector?.alive, 'Fixture left an unowned native collector');
      for (let index = 0; index < 4; index++) {
        const pending = call('relay').delivery;
        if (!pending) break;
        settle(pending, 'resolved');
      }
      requireCondition(call('inspect').pending === 0, 'Terminal fixture events were not recorded and acknowledged');
    }
  }
}

export async function execute(root: string, checkout: string, enforced: boolean, profile = 'all') {
  const releaseRoot = join(root, 'runtime/versions/payload');
  const release = parseRelease(readJson(join(releaseRoot, 'release.json')));
  const binary = join(releaseRoot, release.executable);
  const beforeRelease = inventory(releaseRoot);
  const environment = fixtureEnvironment(root, releaseRoot);
  const checks: unknown[] = [];
  const result: Record<string, unknown> = {status: 'running', release, binarySha256: digest(binary), checks};
  try {
    result.isolation = await verifyIsolation(checkout, enforced);
    const denial = spawnSync(
      join(root, 'tools', process.platform === 'win32' ? 'python.exe' : 'python'),
      ['-c', 'raise SystemExit(0)'],
      {env: environment, cwd: root, timeout: 30_000},
    );
    requireCondition(denial.status === 97, 'External interpreter denial proxy is not active');
    writeJson(join(root, 'interpreter-attempts.json'), []);
    requireCondition(
      Bun.which('git', {PATH: environment.PATH}) && Bun.which('rg', {PATH: environment.PATH}),
      'Installed workflow checks require Git and ripgrep',
    );
    const cli = (...args: string[]): unknown => {
      const text = runReleaseCommand([binary, 'dev-skills', ...args], environment, root);
      checks.push({cli: args});
      return JSON.parse(text);
    };
    const beforePreview = inventory(join(root, 'user'));
    cli('list', '--json');
    for (const action of ['install', 'update', 'remove']) cli(action, '--agent', 'codex', '--dry-run', '--json');
    requireCondition(
      isDeepStrictEqual(beforePreview, inventory(join(root, 'user'))) && !fs.existsSync(join(root, 'data')),
      'CLI discovery or preview changed the fresh target',
    );
    const installed = parseInstallation(cli('install', '--agent', 'codex', '--json'));
    requireCondition(installed.applied, 'Compiled CLI did not install the bundled skills');
    const skills = installed.target.skillRoot;
    const generation = join(skills, '.threadnote-dev-skills/generations', installed.bundleDigest);
    const manifest = parseReleaseManifest(readJson(join(releaseRoot, release.devSkills.manifest)));
    requireCondition(manifest.digest === installed.bundleDigest, 'Installed bundle differs from the archive');
    requireCondition(
      isDeepStrictEqual(
        EffectRecord.fromEntries(
          EffectArray.map(EffectRecord.keys(manifest.hashes), name => [name, digest(join(generation, name))]),
        ),
        manifest.hashes,
      ),
      'Installed helper bytes differ from the archive manifest',
    );
    requireCondition(
      manifest.schemaVersion === 2 &&
        EffectArray.every(
          EffectRecord.keys(manifest.hashes),
          name => !Effect2.pipe(name, EffectString.endsWith('.py')),
        ),
      'New release includes a Python workflow payload or old manifest',
    );
    result.installedProvenance = {
      generation,
      digest: manifest.digest,
      files: EffectRecord.keys(manifest.hashes).length,
      nativeOnly: true,
    };
    for (const skill of manifest.skills) {
      const content = fs.readFileSync(join(skills, skill.id, 'SKILL.md'), 'utf8');
      requireCondition(
        Effect2.pipe(content, EffectString.includes(generation)) &&
          !Effect2.pipe(content, EffectString.includes(checkout)) &&
          !Effect2.pipe(content, EffectString.includes('{{THREADNOTE_')),
        `Entrypoint does not resolve to its installed generation: ${skill.id}`,
      );
    }
    for (const action of ['install', 'update'])
      requireCondition(
        !booleanField(objectRecord(cli(action, '--agent', 'codex', '--json'), 'CLI result').applied, 'CLI applied'),
        'Idempotent action changed files',
      );
    await managerChecks(root, binary, environment, checks);
    result.nativeWorkflows = await runNativeWorkflows(root, binary, environment, installed.bundleDigest, profile);
    checks.push(await nativeWatchChecks(root, binary, environment));
    requireCondition(
      parseJsonArray(readJson(join(root, 'interpreter-attempts.json')), 'Interpreter attempts').length === 0,
      'Product attempted to launch an external interpreter',
    );
    result.externalInterpreters = {denied: true, productAttempts: 0};
    requireCondition(
      booleanField(objectRecord(cli('remove', '--agent', 'codex', '--json'), 'CLI result').applied, 'CLI applied'),
      'CLI remove did not apply',
    );
    requireCondition(
      EffectArray.every(manifest.skills, skill => !fs.existsSync(join(skills, skill.id, 'SKILL.md'))),
      'Removed entrypoint still exists',
    );
    requireCondition(
      isDeepStrictEqual(beforeRelease, inventory(releaseRoot)),
      'Running the installed workflows changed the release',
    );
    result.status = enforced ? 'passed' : 'functional-passed-isolation-pending';
    return result;
  } catch (error) {
    Object.assign(result, {status: 'failed', error: message(error)});
    throw error;
  } finally {
    writeJson(join(root, 'result.json'), result);
  }
}

export interface StageArguments {
  archive: string;
  checkout: string;
  report: string;
  tools: string;
  functionalOnly?: boolean;
  profile?: string;
}
export interface StageDependencies {
  platform?: NodeJS.Platform;
  allocate?: () => string;
  findTool?: (name: string) => string | null;
  run?: typeof runReleaseCommand;
  remove?: typeof removeOwnedFixture;
}

/** Reuse the production streaming tar validator, then compare full inventory and hashes. */
export async function stage(arguments_: StageArguments, dependencies: StageDependencies = {}): Promise<void> {
  const checkout = fs.realpathSync(resolve(arguments_.checkout));
  const archive = resolve(arguments_.archive);
  const report = resolve(arguments_.report);
  requireCondition(fs.statSync(archive).isFile(), 'Build and archive the real release first');
  const checksum = Effect2.pipe(
    fs.readFileSync(`${archive}.sha256`, 'utf8'),
    EffectString.trim,
    EffectString.split(/\s+/),
  )[0];
  requireCondition(digest(archive) === checksum, 'Release archive checksum mismatch');
  const root = fs.realpathSync(
    dependencies.allocate?.() ?? fs.mkdtempSync(join(tmpdir(), 'threadnote-extracted-release-')),
  );
  requireCondition(!inside(checkout, root), 'Fixture must be outside the source checkout');
  const payload = join(root, 'runtime/versions/payload');
  fs.mkdirSync(payload, {recursive: true});
  try {
    const expected = inventory(join(checkout, 'dist'));
    requireCondition(EffectRecord.keys(expected).length > 0, 'Expected built release is absent');
    // This compiled host-controller entrypoint owns the extraction scope.
    // oxlint-disable-next-line effecttsgo/strict-effect-provide
    await Effect.runPromise(extractGzipTar(archive, payload).pipe(Effect.provide(BunServices.layer)));
    requireCondition(
      isDeepStrictEqual(inventory(payload), expected),
      'Extracted archive inventory/bytes differ from the built release',
    );
    const tool = resolve(arguments_.tools);
    requireCondition(fs.statSync(tool).isFile(), 'Compile the native test tool proxy before release isolation');
    const tools = join(root, 'tools');
    fs.mkdirSync(tools);
    const findTool = dependencies.findTool ?? ((name: string) => Bun.which(name));
    const toolPaths = EffectRecord.fromEntries(EffectArray.map(['git', 'rg'], name => [name, findTool(name)]));
    requireCondition(
      EffectArray.every(EffectRecord.values(toolPaths), Boolean),
      'Native release fixtures require Git and ripgrep',
    );
    writeJson(join(root, 'tool-paths.json'), toolPaths);
    const platform = dependencies.platform ?? process.platform;
    for (const name of ['git', 'rg', 'gh', 'memory-read', 'python', 'python3', 'python3.14', 'node', 'bun']) {
      const target = join(tools, name + (platform === 'win32' ? '.exe' : ''));
      try {
        fs.linkSync(tool, target);
      } catch {
        fs.copyFileSync(tool, target);
        fs.chmodSync(target, fs.statSync(tool).mode);
      }
    }
    writeJson(join(root, 'interpreter-attempts.json'), []);
    writeJson(join(root, 'provider-requests.json'), []);
    writeJson(join(root, 'provider.json'), {
      head: Effect2.pipe('a', EffectString.repeat(40)),
      terminal: false,
      revision: 1,
    });
    const harness = join(root, platform === 'win32' ? 'release-artifact.exe' : 'release-artifact');
    fs.copyFileSync(process.execPath, harness);
    fs.chmodSync(harness, fs.statSync(process.execPath).mode);
    let command = [harness, '--execute', root, '--checkout', checkout];
    if (arguments_.profile) command.push('--profile', arguments_.profile);
    if (platform === 'darwin') {
      const policy =
        '(version 1)(allow default)(deny network*)' +
        '(allow network-inbound (local ip "localhost:*"))' +
        '(allow network-outbound (remote ip "localhost:*"))' +
        '(allow process-exec (literal "/bin/ps") (with no-sandbox))' +
        '(deny file-read* (subpath ' +
        JSON.stringify(checkout) +
        '))';
      command = ['/usr/bin/sandbox-exec', '-p', policy, ...command];
    } else if (platform === 'linux') {
      requireCondition(findTool('bwrap'), 'Linux offline release checks require bubblewrap');
      command = [
        'bwrap',
        '--unshare-net',
        '--die-with-parent',
        '--ro-bind',
        '/',
        '/',
        '--bind',
        root,
        root,
        '--tmpfs',
        checkout,
        '--dev',
        '/dev',
        '--proc',
        '/proc',
        '--chdir',
        root,
        ...command,
      ];
    } else {
      requireCondition(
        arguments_.functionalOnly,
        'Native Windows OS isolation is pending; use explicit --functional-only',
      );
      command.push('--functional-only');
    }
    (dependencies.run ?? runReleaseCommand)(command, {...process.env}, root, {timeoutMs: 1_800_000});
    const result = parseStageResult(readJson(join(root, 'result.json')));
    Object.assign(result, {
      archiveSha256: checksum,
      archiveEntries: EffectRecord.keys(expected).length,
      checkoutAccess: result.isolation.enforced ? 'denied' : 'not OS-enforced',
    });
    fs.mkdirSync(dirname(report), {recursive: true});
    writeJson(report, result);
    const evidence = evidenceDirectory(report);
    fs.cpSync(join(root, 'provenance'), evidence, {recursive: true});
    copyNativeLogs(root, evidence);
    (dependencies.remove ?? removeOwnedFixture)(root);
    process.stdout.write(JSON.stringify({status: result.status, report}) + '\n');
  } catch (error) {
    fs.mkdirSync(dirname(report), {recursive: true});
    writeJson(report, {status: 'failed', error: message(error), fixture: root});
    preserveFailedNativeLogs(root, report);
    throw error;
  }
}

async function holdAccountLock(root: string): Promise<void> {
  await withAccountMutationLock(resolve(root), async () => {
    process.stdout.write('ready\n');
    const line = await new Promise<string>((done, reject) => {
      let buffer = '';
      const cleanup = () => {
        process.stdin.off('data', data);
        process.stdin.off('end', end);
        process.stdin.off('error', error);
        process.stdin.pause();
      };
      const data = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (Effect2.pipe(buffer, EffectString.includes('\n'))) {
          cleanup();
          done(
            Effect2.pipe(
              buffer,
              EffectString.slice(
                0,
                Effect2.pipe(
                  buffer,
                  EffectString.indexOf('\n'),
                  Effect2.Option.getOrElse(() => -1),
                ) + 1,
              ),
            ),
          );
        }
      };
      const end = () => {
        cleanup();
        done(buffer);
      };
      const error = (cause: Error) => {
        cleanup();
        reject(cause);
      };
      process.stdin.on('data', data);
      process.stdin.once('end', end);
      process.stdin.once('error', error);
      process.stdin.resume();
    });
    requireCondition(line === 'release\n', 'Invalid fixture release token');
  });
}

async function main(args: string[]): Promise<void> {
  const values = new Map<string, string>();
  let functionalOnly = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--functional-only') {
      functionalOnly = true;
      continue;
    }
    requireCondition(
      ['--archive', '--checkout', '--report', '--execute', '--tools', '--hold-account-lock', '--profile'].includes(
        flag,
      ),
      `Unknown argument: ${flag}`,
    );
    const value = args[++index];
    requireCondition(value && !Effect2.pipe(value, EffectString.startsWith('--')), `Missing value for ${flag}`);
    values.set(flag, value);
  }
  if (values.has('--hold-account-lock')) return holdAccountLock(values.get('--hold-account-lock')!);
  const checkout = values.get('--checkout');
  requireCondition(checkout, '--checkout is required');
  if (values.has('--execute')) {
    await execute(resolve(values.get('--execute')!), resolve(checkout), !functionalOnly, values.get('--profile'));
    return;
  }
  const archive = values.get('--archive');
  const report = values.get('--report');
  const tools = values.get('--tools');
  requireCondition(archive && report && tools, 'Staging requires --archive, --report and --tools');
  await stage({archive, checkout, report, tools, functionalOnly, profile: values.get('--profile')});
}
if (import.meta.main) await main(process.argv.slice(2));
