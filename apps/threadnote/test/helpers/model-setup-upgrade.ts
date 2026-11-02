import {RECALL_EMBEDDING_WORKER_ARGUMENT, RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION} from '../../src/worker_protocol.js';
import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
import {
  runtimeOpenTextDirectoryNameReader,
  runtimeReadBoundedStableRegularFile,
  parseCanonicalProcessStartIdentityOutput,
  parseProcessStartIdentityOutput,
} from '@threadnote/platform/system';
import {execFile} from '@threadnote/testing/node-child-process';
import {createHash} from '@threadnote/testing/node-crypto';
import {lstat, readFile, readdir, readlink, realpath, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {TestError} from '@threadnote/testing/test-error';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const executeUpgradeCommand = promisify(execFile);
export const PREDECESSOR_VERSION = '5.3.0-beta.4';
export const PREDECESSOR_ARCHIVE_SHA256 = '161ad1b05d6b5996a45b5cae80b5cd36beea95f87a4535b61734949a56dbddfe';
export const PREDECESSOR_EXECUTABLE_SHA256 = '9096d53c33c21cd333917fa44093b1481b39273ccf97040f815dd8a293e21cb1';
export const UPGRADE_ACKNOWLEDGEMENT = 'ephemeral-macos-real-predecessor';
export const LOOPBACK_ONLY_POLICY = `(version 1)
(allow default)
(deny network-outbound (require-not (remote ip "localhost:*")))
`;

/** This opt-in lane deliberately permits legacy repair to use the disposable runner's real OS home. */
export function upgradeQualificationAllowed(environment: NodeJS.ProcessEnv, platform: string, architecture: string) {
  return (
    environment.THREADNOTE_QUALIFY_OLD_UPGRADE === UPGRADE_ACKNOWLEDGEMENT &&
    environment.GITHUB_ACTIONS === 'true' &&
    environment.RUNNER_ENVIRONMENT === 'github-hosted' &&
    environment.RUNNER_OS === 'macOS' &&
    environment.RUNNER_ARCH === 'ARM64' &&
    platform === 'darwin' &&
    architecture === 'arm64'
  );
}

export function upgradeEnvironment(run: string): NodeJS.ProcessEnv {
  // No CI/test/cloud exclusions, credentials, THREADNOTE_HOME, or HOME/CODEX_HOME redirection.
  const inherited = EffectRecord.fromEntries(
    EffectArray.flatMap(['HOME', 'CODEX_HOME', 'PATH', 'USER', 'LOGNAME', 'LANG'], key =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  return {
    ...inherited,
    TMPDIR: join(run, 'tmp'),
    THREADNOTE_INSTALL_ROOT: join(run, 'installation'),
    THREADNOTE_BIN_DIR: join(run, 'bin'),
    DOCKER_CONFIG: join(run, 'docker'),
    THREADNOTE_TELEMETRY: 'off',
    THREADNOTE_NO_UPDATE_CHECK: '1',
  };
}

export const bytesSha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export function requiredUpgradeEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw TestError.make({message: `Missing required upgrade qualification input: ${name}`});
  return value;
}

export async function optionalUpgradeFile(file: string) {
  return readFile(file, 'utf8').catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return undefined;
    throw cause;
  });
}

export async function recordUpgradeAttempt(file: string, attempt: () => Promise<Record<string, unknown>>) {
  await writeFile(file, JSON.stringify({status: 'running'}), {mode: 0o600});
  try {
    const evidence = await attempt();
    await writeFile(file, JSON.stringify({status: 'passed', ...evidence}, null, 2), {mode: 0o600});
  } catch (cause) {
    await writeFile(
      file,
      JSON.stringify(
        {
          status: 'failed',
          error: Effect.pipe(String(cause), EffectString.slice(0, 2048)),
        },
        null,
        2,
      ),
      {mode: 0o600},
    );
    throw cause;
  }
}

export async function withUpgradeCleanupObservation(
  cleanup: () => Promise<void>,
  observeFailure: (cause: unknown) => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (cause) {
    try {
      await observeFailure(cause);
    } catch {
      // Diagnostic failure must never replace the original cleanup failure.
    }
    throw cause;
  }
}

/** Content fingerprints include symlink targets without following them or reading unrelated runner files. */
export async function upgradeHomeSnapshot(root: string, prefix = ''): Promise<Record<string, string>> {
  const names = await readdir(join(root, prefix)).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  });
  const result: Record<string, string> = {};
  for (const name of names.sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const file = join(root, relative);
    const info = await lstat(file);
    if (info.isSymbolicLink()) result[relative] = `symlink:${await readlink(file)}`;
    else if (info.isDirectory()) Object.assign(result, await upgradeHomeSnapshot(root, relative));
    else if (info.isFile()) result[relative] = bytesSha256(await readFile(file));
  }
  return result;
}

/** Same two-asset GitHub response shape as installer E2E; immutable is synthetic parser metadata only. */
export function serveUpgradeCandidate(archive: string, checksum: string, version: string) {
  const artifact = 'threadnote-darwin-arm64.tar.gz';
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (url.pathname === '/releases') {
        return Response.json([
          {
            assets: EffectArray.map([artifact, `${artifact}.sha256`], name => ({
              name,
              browser_download_url: `${url.origin}/${name}`,
            })),
            draft: false,
            immutable: true,
            prerelease: Effect.pipe(version, EffectString.includes('-')),
            tag_name: `v${version}`,
          },
        ]);
      }
      if (url.pathname === `/${artifact}`) return new Response(Bun.file(archive));
      if (url.pathname === `/${artifact}.sha256`) return new Response(checksum);
      return new Response('not found', {status: 404});
    },
  });
  return {source: `http://127.0.0.1:${server.port}/releases`, requests, close: () => server.stop(true)};
}

/** Bounded supplementary observations; the pinned updater's synchronous exit is the completion oracle. */
export async function observeUpgradeProcesses(releaseRoot: string) {
  const observed = new Set<string>();
  const snapshots = new Map<string, readonly string[]>();
  let complete = true;
  let pending = Promise.resolve();
  let sampling = false;
  let failure: unknown;
  const sample = async () => {
    const {stdout} = await executeUpgradeCommand('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
      timeout: 1000,
      maxBuffer: 1_048_576,
      env: {...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC'},
    });
    const related = EffectArray.map(
      EffectArray.filter(EffectString.split('\n')(stdout), line => EffectString.includes(`${releaseRoot}/`)(line)),
      EffectString.trim,
    );
    if (related.length >= 256 || EffectArray.some(related, line => line.length >= 2048)) complete = false;
    for (const line of related) {
      if (!observed.has(line) && observed.size >= 256) complete = false;
      if (observed.size < 256) observed.add(EffectString.slice(0, 2048)(line));
    }
    const snapshot = EffectArray.map(EffectArray.take(related, 255), EffectString.slice(0, 2047));
    const key = EffectArray.join(snapshot, '\n');
    if (!snapshots.has(key)) {
      if (snapshots.size >= 64) complete = false;
      else snapshots.set(key, snapshot);
    }
  };
  await sample();
  const timer = setInterval(() => {
    if (sampling || failure) return;
    sampling = true;
    pending = sample()
      .catch(cause => {
        failure = cause;
      })
      .finally(() => {
        sampling = false;
      });
  }, 25);
  return async () => {
    clearInterval(timer);
    await pending;
    if (failure) throw TestError.make({message: 'Upgrade process observation failed.', cause: failure});
    return {commands: [...observed], snapshots: [...snapshots.values()], complete};
  };
}

/** Failure-only metadata; no commands, paths, memory bodies, model data or tokens are retained. */
export async function recordUpgradeCleanupFailure(input: {
  file: string;
  scenario: 'hosted-predecessor' | 'candidate-only';
  installation: string;
  home: string;
  version: string;
  sourceCommit: string;
  sourceTree: string;
  candidateSha256: string;
  manager?: {pid?: number; exitCode: number | null; signalCode: string | null};
  ownedRecallChild?: {pid?: number; exitCode: number | null; signalCode: string | null};
  stage: 'model-setup-off' | 'manager-close' | 'release-leases-empty' | 'recall-worker-retirement';
  bodyFailure: unknown;
  bodyFailed: boolean;
  cleanupFailure: unknown;
}) {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !EffectArray.isArray(value);
  const object = (value: unknown): Record<string, unknown> => (isObject(value) ? value : {});
  const startedAt = new Date().toISOString();
  const choice = (value: unknown, allowed: readonly string[]) =>
    typeof value === 'string' && EffectArray.contains(allowed, value) ? value : null;
  const integer = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const version = (value: unknown) =>
    typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value) && value.length <= 64 ? value : null;
  const identity = (value: unknown) =>
    typeof value === 'string' &&
    /^(?:darwin-v2|darwin):[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(value)
      ? value
      : null;
  const owner = (value: unknown) => {
    const item = object(value);
    return {processId: integer(item.processId), processStartIdentity: identity(item.processStartIdentity)};
  };
  const child = (value: unknown) => {
    const item = object(value);
    return {
      pid: integer(item.pid),
      exitCode: integer(item.exitCode),
      signalCode:
        choice(item.signalCode, [
          'SIGTERM',
          'SIGKILL',
          'SIGABRT',
          'SIGSEGV',
          'SIGBUS',
          'SIGINT',
          'SIGHUP',
          'SIGILL',
          'SIGTRAP',
          'SIGFPE',
          'SIGPIPE',
          'SIGALRM',
          'SIGSYS',
        ]) ?? (item.signalCode == null ? null : 'other'),
    };
  };
  const hex = (value: unknown, size: 40 | 64) =>
    typeof value === 'string' && (size === 40 ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(value) ? value : null;
  const failure = (value: unknown, present: boolean) => {
    if (!present) return {present: false};
    const item = object(value);
    const frame = typeof item.stack === 'string' ? /model-setup-upgrade\.e2e\.ts:(\d+):(\d+)/.exec(item.stack) : null;
    return {
      present: true,
      kind: choice(item.name, ['AssertionError', 'TypeError', 'SyntaxError', 'Error']) ?? 'other',
      code: choice(item.code, [
        'ENOENT',
        'EPERM',
        'EACCES',
        'ESRCH',
        'ETIMEDOUT',
        'ENOSPC',
        'UPGRADE_WORKER_OWNERSHIP_UNVERIFIED',
      ]),
      sourceLine: frame ? Number(frame[1]) : null,
      sourceColumn: frame ? Number(frame[2]) : null,
    };
  };
  const read = async (file: string): Promise<{status: 'read' | 'unavailable'; value: Record<string, unknown>}> => {
    try {
      const bytes = await runtimeReadBoundedStableRegularFile(file, 8192);
      return {status: 'read', value: object(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)))};
    } catch {
      return {status: 'unavailable', value: {}};
    }
  };
  const page = async (directory: string, pattern: RegExp) => {
    try {
      const reader = await runtimeOpenTextDirectoryNameReader(directory, {entryKind: 'file'});
      try {
        const result = await reader.readPage(16);
        return {
          status: 'read',
          truncated: !result.done,
          names: EffectArray.filter(result.names, name => pattern.test(name)),
        };
      } finally {
        await reader.close();
      }
    } catch {
      return {status: 'unavailable', truncated: null, names: [] as string[]};
    }
  };
  const candidate = join(input.installation, 'versions', input.version, 'threadnote');
  const leaseRoot = join(input.installation, 'leases', input.version);
  const leasesPage = await page(leaseRoot, /^[1-9]\d*\.json$/);
  const leases = await Promise.all(
    EffectArray.map(leasesPage.names, async name => {
      const readback = await read(join(leaseRoot, name));
      return {
        filenamePid: Number(EffectString.slice(0, -5)(name)),
        readStatus: readback.status,
        ...owner(readback.value),
        version: version(readback.value.version),
        executableMatchesCandidate:
          typeof readback.value.executable === 'string' ? readback.value.executable === candidate : null,
        retirementPolicy: choice(readback.value.retirementPolicy, ['terminate', 'preserve-session']),
      };
    }),
  );
  const receipt = await read(join(input.home, 'locks', 'recall', 'embedding-worker-v1.json'));
  const launch = await read(join(input.home, 'locks', 'recall', 'embedding-worker-v1.json.launch-v2.json'));
  const lock = await read(join(input.home, 'locks', 'recall', 'embedding-worker.lock'));
  const active = object(launch.value.active);
  const demandRoot = join(input.home, 'recall', 'embedding-demand-v1');
  const demandsPage = await page(demandRoot, /^[a-f0-9]{64}\.json$/);
  const demands = await Promise.all(
    EffectArray.map(demandsPage.names, async name => {
      const readback = await read(join(demandRoot, name));
      const observed = object(readback.value.observation);
      const desired = object(readback.value.desired);
      const states = ['queued', 'deferred-cpu', 'deferred-foreground', 'preparing', 'running', 'blocked', 'corrupt'];
      const reasons = [
        'embedding-model-unavailable',
        'retry-backoff',
        'native-authority-deferred',
        'source-changed',
        'index-storage-requires-repair',
        'embedding-preparation-failed',
        'cpu-unknown',
        'cpu-busy',
        'foreground',
        'foreground-quiet',
        'inference-active',
        'fair-turn',
        'identity-unavailable',
        'admission-unavailable',
        'batch-deadline',
        'checkpoint',
      ];
      return {
        readStatus: readback.status,
        schemaVersion: integer(readback.value.version),
        desiredPresent: readback.status === 'read' ? readback.value.desired !== undefined : null,
        observationState: choice(observed.state, states),
        observationReason: choice(observed.reason, reasons),
        failures: integer(observed.failures),
        notBefore: integer(observed.notBefore),
        owner: owner(observed.owner),
        sameRevision:
          typeof desired.revision === 'string' && typeof observed.revision === 'string'
            ? desired.revision === observed.revision
            : null,
      };
    }),
  );
  const processes = EffectArray.map(leases, item => ({
    ...item,
    liveness: 'unknown',
    canonicalStartIdentity: null as string | null,
    leaseIdentityMatches: null as boolean | null,
    commBasename: null as string | null,
    commSha256: null as string | null,
    parentProcessId: null as number | null,
  }));
  for (const item of processes) {
    try {
      process.kill(item.filenamePid, 0);
      item.liveness = 'present';
    } catch (cause) {
      item.liveness = object(cause).code === 'ESRCH' ? 'absent' : 'unknown';
    }
  }
  let processProbe: 'complete' | 'unavailable' | 'no-pids' = 'no-pids';
  if (processes.length) {
    try {
      const {stdout} = await executeUpgradeCommand(
        '/bin/ps',
        [
          '-p',
          EffectArray.join(
            EffectArray.map(processes, item => String(item.filenamePid)),
            ',',
          ),
          '-o',
          'pid=,ppid=,lstart=,comm=',
        ],
        {timeout: 1000, maxBuffer: 16_384, env: {...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC'}},
      );
      for (const line of EffectString.split('\n')(String(stdout))) {
        const row = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/.exec(line);
        if (!row) continue;
        const item = EffectOption.getOrUndefined(
          EffectArray.findFirst(processes, value => value.filenamePid === Number(row[1])),
        );
        if (!item) continue;
        item.canonicalStartIdentity = parseCanonicalProcessStartIdentityOutput('darwin', row[3]) ?? null;
        item.leaseIdentityMatches =
          item.processStartIdentity !== null &&
          EffectString.startsWith('darwin-v2:')(item.processStartIdentity) &&
          item.canonicalStartIdentity
            ? item.processStartIdentity === item.canonicalStartIdentity
            : null;
        item.parentProcessId = Number(row[2]);
        item.commBasename =
          EffectOption.getOrUndefined(EffectArray.last(EffectString.split('/')(row[4]))) === 'threadnote'
            ? 'threadnote'
            : 'other';
        item.commSha256 = bytesSha256(row[4]);
      }
      processProbe = 'complete';
    } catch {
      processProbe = 'unavailable';
    }
  }
  const ownedRecallChild = input.ownedRecallChild ? child(input.ownedRecallChild) : undefined;
  const evidence = {
    schemaVersion: 1,
    startedAt,
    observedAt: new Date().toISOString(),
    atomicSnapshot: false,
    sourceCommit: hex(input.sourceCommit, 40),
    sourceTree: hex(input.sourceTree, 40),
    candidateVersion: version(input.version),
    candidateSha256: hex(input.candidateSha256, 64),
    scenario: input.scenario,
    predecessor:
      input.scenario === 'hosted-predecessor'
        ? {status: 'invoked', version: PREDECESSOR_VERSION, executableSha256: PREDECESSOR_EXECUTABLE_SHA256}
        : {status: 'not-invoked'},
    cleanupStage: input.stage,
    bodyFailure: failure(input.bodyFailure, input.bodyFailed),
    cleanupFailure: failure(input.cleanupFailure, true),
    manager: input.manager ? child(input.manager) : null,
    leases: {readStatus: leasesPage.status, truncated: leasesPage.truncated, processes},
    processProbe,
    recall: {
      receipt: {
        readStatus: receipt.status,
        ...owner(receipt.value),
        version: version(receipt.value.version),
        protocol: integer(receipt.value.protocol),
      },
      control: {
        readStatus: launch.status,
        schemaVersion: integer(launch.value.version),
        runtimeVersion: version(launch.value.runtimeVersion),
        protocol: integer(launch.value.protocol),
        wakeSequence: integer(launch.value.wakeSequence),
        startingPresent: launch.status === 'read' ? launch.value.starting !== undefined : null,
        activeOwner: owner(active.owner),
        staleReceipt: owner(launch.value.staleReceipt),
        staleLock: owner(launch.value.staleLock),
      },
      lock: {readStatus: lock.status, ...owner(lock.value)},
      demand: {readStatus: demandsPage.status, truncated: demandsPage.truncated, observations: demands},
      exit: ownedRecallChild
        ? {
            status: ownedRecallChild.exitCode === null && ownedRecallChild.signalCode === null ? 'pending' : 'observed',
            pid: ownedRecallChild.pid,
            exitCode: ownedRecallChild.exitCode,
            signalCode: ownedRecallChild.signalCode,
          }
        : {status: 'unobserved', reason: 'detached-child-no-owned-process-handle'},
    },
  };
  const encoded = JSON.stringify(evidence, null, 2);
  await writeFile(
    input.file,
    Buffer.byteLength(encoded) <= 65_536
      ? encoded
      : JSON.stringify({schemaVersion: 1, status: 'output-limit', complete: false}),
    {mode: 0o600},
  );
}

/** Only the admitted disposable predecessor fixture may retire its original repair child. */
export async function requestOwnedUpgradeRecallRetirement(input: {
  run: string;
  installation: string;
  home: string;
  version: string;
  candidate: string;
  observedSnapshots: readonly (readonly string[])[];
  observationComplete: boolean;
  legacyEnvironment: NodeJS.ProcessEnv;
}): Promise<
  | {
      pid: number;
      canonicalStartIdentity: string;
      signalRequested: boolean;
      hasReturned: () => Promise<boolean>;
    }
  | undefined
> {
  const fail = () =>
    Object.assign(new Error('Cannot verify the fixture-owned recall worker.'), {
      code: 'UPGRADE_WORKER_OWNERSHIP_UNVERIFIED',
    });
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !EffectArray.isArray(value);
  const nonce = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/u.test(value);
  const ownerSchema = Schema.Struct({
    token: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
    processId: Schema.Int.check(Schema.isGreaterThan(0)),
    processStartIdentity: Schema.String.check(Schema.isMaxLength(1024), Schema.isMinLength(1)),
  });
  // Production stateSchema is private. Decode only the admissible active/idle subset, with identical field constraints.
  const controlSchema = Schema.Struct({
    version: Schema.Literals([1]),
    protocol: Schema.Int.check(Schema.isGreaterThan(0)),
    runtimeVersion: Schema.String.check(Schema.isMaxLength(256)),
    wakeSequence: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: Number.MAX_SAFE_INTEGER})),
    active: Schema.optionalKey(
      Schema.Struct({
        nonce: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
        owner: ownerSchema,
      }),
    ),
  });
  const decodeControl = Schema.decodeUnknownSync(controlSchema, {onExcessProperty: 'error'});
  const parseRow = (line: string) => {
    const row = /^\s*([1-9]\d*)\s+([1-9]\d*)\s+(.{24})\s+(.+?)\s*$/u.exec(line);
    if (!row) return undefined;
    const pid = Number(row[1]);
    const parent = Number(row[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) return undefined;
    const canonical = parseCanonicalProcessStartIdentityOutput('darwin', row[3]);
    return canonical ? {pid, parent, canonical, command: row[4]} : undefined;
  };
  if (
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(input.version) ||
    input.version.length > 64 ||
    !input.observationComplete ||
    input.observedSnapshots.length > 64 ||
    EffectArray.some(
      input.observedSnapshots,
      rows => rows.length >= 256 || EffectArray.some(rows, line => line.length >= 2048),
    ) ||
    (await realpath(input.run)) !== input.run ||
    input.installation !== join(input.run, 'installation') ||
    (await realpath(input.installation)) !== input.installation ||
    input.home !== join(input.run, 'data') ||
    (await realpath(input.home)) !== input.home ||
    input.candidate !== join(input.installation, 'versions', input.version, 'threadnote') ||
    (await realpath(input.candidate)) !== input.candidate
  )
    throw fail();
  const oldExecutable = join(input.installation, 'versions', PREDECESSOR_VERSION, 'threadnote');
  const updaterPrefix = `${oldExecutable} update --home ${input.home} --source `;
  const repairCommand = `${input.candidate} repair --no-post-update`;
  const childPrefix = `${input.candidate} ${RECALL_EMBEDDING_WORKER_ARGUMENT} --home ${input.home} --protocol ${RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION} --version ${input.version} --launch-nonce `;
  const owners = new Map<string, {pid: number; canonical: string; nonce: string}>();
  for (const snapshot of input.observedSnapshots) {
    const rows = EffectArray.filter(EffectArray.map(snapshot, parseRow), row => row !== undefined);
    if (new Set(EffectArray.map(rows, row => row.pid)).size !== rows.length) throw fail();
    for (const row of rows) {
      if (!EffectString.startsWith(childPrefix)(row.command)) continue;
      const launchNonce = EffectString.slice(childPrefix.length)(row.command);
      if (!nonce(launchNonce)) throw fail();
      const repair = EffectArray.findFirst(
        rows,
        parent => parent.pid === row.parent && parent.command === repairCommand,
      );
      if (EffectOption.isNone(repair)) continue; // Reparented rows alone never grant ownership.
      const updater = EffectArray.findFirst(
        rows,
        parent =>
          parent.pid === repair.value.parent &&
          parent.parent === process.pid &&
          EffectString.startsWith(updaterPrefix)(parent.command),
      );
      if (EffectOption.isNone(updater)) throw fail();
      // All three instances coexist in this original sample; flattened PID joins are never authority.
      const key = JSON.stringify([
        row.pid,
        row.canonical,
        launchNonce,
        repair.value.pid,
        repair.value.canonical,
        updater.value.pid,
        updater.value.canonical,
      ]);
      owners.set(key, {pid: row.pid, canonical: row.canonical, nonce: launchNonce});
    }
  }
  if (owners.size > 1) throw fail(); // No group retirement or arbitrary latest-PID choice.
  const proof = EffectOption.getOrUndefined(EffectArray.head(EffectArray.fromIterable(owners.values())));
  if (!proof) {
    // A missing original child is normal only when no recall ownership is present.
    for (const name of [
      'embedding-worker-v1.json',
      'embedding-worker.lock',
      'embedding-worker-v1.json.launch-v2.json',
    ]) {
      const filename = join(input.home, 'locks', 'recall', name);
      try {
        await lstat(filename);
      } catch (cause) {
        if (isRecord(cause) && cause.code === 'ENOENT') continue;
        throw fail();
      }
      if (name !== 'embedding-worker-v1.json.launch-v2.json') throw fail();
      const state = decodeControl(
        JSON.parse(
          new TextDecoder('utf-8', {fatal: true}).decode(await runtimeReadBoundedStableRegularFile(filename, 8192)),
        ),
      );
      if (
        state.protocol !== RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION ||
        state.runtimeVersion !== input.version ||
        state.active !== undefined
      )
        throw fail();
    }
    return undefined;
  }
  if (proof.pid <= 1 || proof.pid === process.pid) throw fail();
  const probe = async (): Promise<'current' | 'returned' | 'unknown'> => {
    try {
      if (!process.kill(proof.pid, 0)) return 'unknown';
    } catch (cause) {
      return isRecord(cause) && cause.code === 'ESRCH' ? 'returned' : 'unknown';
    }
    try {
      const {stdout} = await executeUpgradeCommand(
        '/bin/ps',
        ['-p', String(proof.pid), '-o', 'pid=,ppid=,lstart=,comm='],
        {
          timeout: 1000,
          maxBuffer: 16_384,
          env: {...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC'},
        },
      );
      const row = parseRow(stdout);
      if (!row || row.pid !== proof.pid) return 'unknown';
      if (row.canonical !== proof.canonical) return 'returned'; // The original instance is gone; never signal its replacement.
      return row.command === input.candidate ? 'current' : 'unknown';
    } catch {
      try {
        process.kill(proof.pid, 0);
      } catch (cause) {
        if (isRecord(cause) && cause.code === 'ESRCH') return 'returned';
      }
      return 'unknown';
    }
  };
  const hasReturned = async () => {
    const state = await probe();
    if (state === 'unknown') throw fail();
    return state === 'returned';
  };
  const result = (signalRequested: boolean) => ({
    pid: proof.pid,
    canonicalStartIdentity: proof.canonical,
    signalRequested,
    hasReturned,
  });
  const first = await probe();
  if (first === 'returned') return result(false);
  if (first !== 'current') throw fail();
  const leaseDirectory = join(input.installation, 'leases', input.version);
  const recallDirectory = join(input.home, 'locks', 'recall');
  if ((await realpath(leaseDirectory)) !== leaseDirectory || (await realpath(recallDirectory)) !== recallDirectory)
    throw fail();
  const read = async (filename: string) => {
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', {fatal: true}).decode(await runtimeReadBoundedStableRegularFile(filename, 8192)),
    );
    if (!isRecord(value)) throw fail();
    return value;
  };
  try {
    // Legacy ownership uses the exact child environment; never derive local time from canonical UTC text.
    const {stdout} = await executeUpgradeCommand('/bin/ps', ['-p', String(proof.pid), '-o', 'lstart='], {
      timeout: 1000,
      maxBuffer: 16_384,
      env: input.legacyEnvironment,
    });
    const legacyIdentity = parseProcessStartIdentityOutput('darwin', stdout);
    if (!legacyIdentity || legacyIdentity.length > 1024) throw fail();
    const receipt = await read(join(recallDirectory, 'embedding-worker-v1.json'));
    const control = decodeControl(await read(join(recallDirectory, 'embedding-worker-v1.json.launch-v2.json')));
    const lock = await read(join(recallDirectory, 'embedding-worker.lock'));
    const lease = await read(join(leaseDirectory, `${proof.pid}.json`));
    if (!isRecord(control.active) || !isRecord(control.active.owner)) throw fail();
    const owner = control.active.owner;
    if (
      control.version !== 1 ||
      control.protocol !== RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION ||
      control.runtimeVersion !== input.version ||
      control.active.nonce !== proof.nonce ||
      owner.processId !== proof.pid ||
      owner.processStartIdentity !== legacyIdentity ||
      !nonce(owner.token) ||
      receipt.processId !== proof.pid ||
      receipt.processStartIdentity !== legacyIdentity ||
      receipt.token !== owner.token ||
      receipt.protocol !== RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION ||
      receipt.version !== input.version ||
      lock.processId !== proof.pid ||
      lock.processStartIdentity !== legacyIdentity ||
      !nonce(lock.token) ||
      lease.processId !== proof.pid ||
      lease.processStartIdentity !== proof.canonical ||
      !nonce(lease.token) ||
      lease.version !== input.version ||
      lease.executable !== input.candidate ||
      lease.retirementPolicy !== 'terminate'
    )
      throw fail();
  } catch {
    if ((await probe()) === 'returned') return result(false);
    throw fail();
  }
  const final = await probe();
  if (final === 'returned') return result(false);
  if (final !== 'current') throw fail();
  try {
    if (!process.kill(proof.pid, 'SIGTERM')) throw fail();
  } catch (cause) {
    if (isRecord(cause) && cause.code === 'ESRCH' && (await probe()) === 'returned') return result(false);
    throw fail();
  }
  return result(true);
}
