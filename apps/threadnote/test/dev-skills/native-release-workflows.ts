/** Extracted executable lifecycle acceptance controlled by the host runtime.
 * Every product operation uses the supplied native executable and isolated PATH.
 * Cloud acceptance uses actual bootstrap/publication against private bare Git.
 */
import assert from 'node:assert/strict';
import {Array as EffectArray, Option as EffectOption, String as EffectString} from 'effect';
// Bun 1.4.2 compile cannot bundle the testing builtin export-star wrappers.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Independent checksum boundary in the compiled release controller.
import {createHash} from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  // oxlint-disable-next-line effecttsgo/node-builtin-import -- Required for the compiled host controller.
} from 'node:fs';
import {basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep} from '@threadnote/testing/node-path';
import {gunzipSync} from 'node:zlib';
import {
  decodeReleaseOutput,
  ReleaseCommandError,
  runReleaseCommand,
  runReleaseCommandBytes,
} from './native-release-process.js';
import * as EffectRecord from 'effect/Record';
import * as Effect from 'effect';

// JSON documents are native protocol fixtures; assertions below validate their readbacks.
// oxlint-disable-next-line typescript/no-explicit-any -- Native JSON fixture fields are checked by the protocol and explicit readback assertions.
type Json = {[key: string]: any};
const object = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !EffectArray.isArray(value);
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const jsonObject = (value: unknown): Json => {
  assert(object(value), 'Expected a JSON object.');
  return value;
};
const parseJsonObject = (input: string): Json => jsonObject(JSON.parse(input));
const jsonFile = (path: string) => parseJsonObject(readFileSync(path, 'utf8'));
const save = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
const canonical = (path: string): string => {
  path = resolve(path);
  try {
    return realpathSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return join(canonical(dirname(path)), basename(path));
  }
};
const within = (parent: string, child: string) => {
  const path = relative(canonical(parent), canonical(child));
  return path !== '' && !Effect.pipe(path, EffectString.startsWith(`..${sep}`)) && path !== '..' && !isAbsolute(path);
};
const asciiJson = (value: unknown) =>
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only.
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    c =>
      `\\u${Effect.pipe(
        Effect.pipe(
          c,
          EffectString.charCodeAt(0),
          Effect.Option.getOrElse(() => NaN),
        ).toString(16),
        EffectString.padStart(4, '0'),
      )}`,
  );
const isMissing = (error: unknown) => object(error) && error.code === 'ENOENT';
const readBounded = (path: string, limit: number) => {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const size = readSync(fd, buffer, count, buffer.length - count, null);
      if (!size) break;
      count += size;
    }
    return buffer.subarray(0, count);
  } finally {
    closeSync(fd);
  }
};

export async function runNativeWorkflows(
  root: string,
  binary: string,
  environment: NodeJS.ProcessEnv,
  generation: string,
) {
  root = canonical(root);
  binary = canonical(binary);
  assert(statSync(binary).isFile(), binary);
  assert(typeof generation === 'string' && generation);
  mkdirSync(root, {recursive: true});
  const listed = parseJsonObject(runReleaseCommand([binary, 'dev-skills', 'list', '--json'], environment, root));
  assert(EffectArray.isArray(listed.surfaces) && EffectArray.every(listed.surfaces, object));
  const surfaces = EffectRecord.fromEntries(
    EffectArray.map(
      EffectArray.filter(listed.surfaces, (item: Json) =>
        ['codex-cloud-personal', 'cursor-cloud-personal'].includes(item.profile),
      ),
      (item: Json): [string, Json] => [item.profile, item],
    ),
  );
  assert.deepEqual(EffectRecord.keys(surfaces).sort(), ['codex-cloud-personal', 'cursor-cloud-personal']);
  const profiles = [
    'desktop',
    ...EffectArray.map(
      EffectArray.filter(EffectRecord.toEntries(surfaces), ([, surface]) =>
        surface.platforms.includes(process.platform),
      ),
      ([name]) => name,
    ),
  ];
  const results = EffectArray.map(profiles, profile =>
    runProfile(join(root, profile), binary, environment, generation, profile),
  );
  const rejected = [];
  for (const [name, surface] of EffectRecord.toEntries(surfaces)) {
    if (surface.platforms.includes(process.platform)) continue;
    const host = name === 'codex-cloud-personal' ? 'codex' : 'cursor';
    try {
      runReleaseCommand(
        [
          binary,
          'cloud',
          host,
          'bootstrap',
          '--remote',
          join(root, 'unsupported.git'),
          '--team',
          'default',
          '--user',
          'release-fixture',
          '--agent-id',
          'release-fixture',
        ],
        environment,
        root,
        {timeoutMs: 30_000},
      );
      assert.fail('Unsupported native workflow target was accepted');
    } catch (error) {
      assert(error instanceof ReleaseCommandError && error.status !== 0);
      assert(Effect.pipe(decodeReleaseOutput(error.stderr), EffectString.includes('no native workflow target on')));
    }
    rejected.push(name);
  }
  return {
    status: 'passed',
    profiles: results,
    operations: EffectArray.reduce(results, 0, (sum, item) => sum + item.operations),
    unsupportedHostProfilesRejected: rejected,
    personalCloudHost: 'catalog-declared native platforms',
    liveProviderAcceptance: false,
  };
}

function runProfile(
  fixture: string,
  binary: string,
  suppliedEnvironment: NodeJS.ProcessEnv,
  generation: string,
  profile: string,
) {
  assert(!existsSync(fixture), 'Use a fresh extracted native workflow fixture');
  mkdirSync(fixture, {recursive: true});
  const home = join(fixture, 'home');
  const repo = join(fixture, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  const environment = {...suppliedEnvironment};
  delete environment.THREADNOTE_RELEASE_PUBLICATION_TRACE;
  Object.assign(environment, {
    THREADNOTE_HOME: home,
    THREADNOTE_USER: 'release-fixture',
    THREADNOTE_AGENT_ID: 'release-fixture',
    THREADNOTE_CURSOR_CLOUD_TEAM: 'default',
  });
  if (profile !== 'desktop') {
    const user = join(fixture, 'user');
    mkdirSync(user);
    Object.assign(environment, {
      HOME: user,
      USERPROFILE: user,
      XDG_CONFIG_HOME: join(user, '.config'),
      XDG_DATA_HOME: join(user, '.local/share'),
      XDG_STATE_HOME: join(user, '.local/state'),
      XDG_CACHE_HOME: join(user, '.cache'),
      APPDATA: join(user, 'appdata'),
      LOCALAPPDATA: join(user, 'localappdata'),
    });
  }
  Object.assign(environment, {
    GIT_AUTHOR_NAME: 'Release Workflow Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Release Workflow Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  });
  const run = (args: readonly string[], cwd = repo, timeoutMs = 60_000, input?: string) =>
    runReleaseCommand(args, environment, cwd, {timeoutMs, input});
  // Intel macOS cloud closeout archives a full published graph; keep other native request budgets unchanged.
  const closeoutFinishTimeoutMs =
    profile !== 'desktop' && process.platform === 'darwin' && process.arch === 'x64' ? 600_000 : 180_000;
  const git = (...args: string[]) => Effect.pipe(run(['git', ...args]), EffectString.trim);
  writeFileSync(join(repo, 'source.ts'), 'export const completeRead = (value: string) => value;\n', 'utf8');
  for (const args of [
    ['init', '--initial-branch=main'],
    ['config', 'user.email', 'fixture@example.invalid'],
    ['config', 'user.name', 'Private Closeout Fixture'],
    ['add', 'source.ts'],
    ['commit', '-m', 'Private closeout source'],
  ])
    git(...args);
  const runId = 'closeout-smoke';
  const common = {protocolVersion: 1, executorVersion: 1, runId, generation};
  const records: Json[] = [];
  assert(typeof environment.THREADNOTE_RELEASE_FIXTURE_ROOT === 'string');
  const traceRoot = canonical(environment.THREADNOTE_RELEASE_FIXTURE_ROOT);
  assert(within(traceRoot, fixture) && statSync(join(traceRoot, 'tool-paths.json')).isFile());
  const traceDirectory = join(traceRoot, 'publication-producer-events');
  let traceSetup = 'disabled';

  function snapshotProducer(): Json {
    const events: Json[] = [];
    let corrupt = 0,
      missing = 0;
    const fields = new Set([
      'version',
      'pid',
      'event',
      'verb',
      'argc',
      'specForm',
      'pathCharacters',
      'pathBytes',
      'pathControl',
      'pathBackslash',
      'timeMs',
      'elapsedMs',
      'exit',
      'signal',
      'success',
      'stdoutBytes',
      'stderrBytes',
      'stderrCategory',
      'stdoutWritten',
      'stderrWritten',
      'complete',
      'phase',
      'errorCode',
      'syscall',
    ]);
    const enums: Record<string, Set<string>> = EffectRecord.fromEntries(
      EffectArray.map(
        EffectRecord.toEntries({
          event: ['start', 'result', 'forwarded', 'exception'],
          verb: ['show', 'rev-parse', 'config', 'add', 'commit', 'status', 'push', 'fetch', 'other'],
          specForm: ['SHA40', 'SHA64', 'HEAD', 'index', 'other'],
          signal: ['none', 'SIGTERM', 'SIGKILL', 'SIGPIPE', 'SIGABRT', 'SIGSEGV', 'SIGINT', 'other'],
          stderrCategory: [
            'none',
            'missing-path',
            'missing-object',
            'not-repository',
            'unsafe-repository',
            'path-too-long',
            'path-invalid',
            'permission',
            'index-lock',
            'unknown',
          ],
          phase: ['load', 'spawn', 'stdout', 'stderr'],
          errorCode: ['ENOENT', 'EACCES', 'EPERM', 'EPIPE', 'EBADF', 'EINVAL', 'ENOSPC', 'other'],
          syscall: ['spawn', 'write', 'open', 'read', 'other'],
        }),
        ([key, values]) => [key, new Set(values)],
      ),
    );
    for (let slot = 0; slot < (traceSetup === 'enabled' ? 128 : 0); slot++) {
      try {
        const raw = readBounded(join(traceDirectory, `${slot}.json`), 480);
        const text = decodeReleaseOutput(raw);
        // Keep JSON integer fields strict: parsing alone erases the distinction
        // between integer tokens and floating-point spellings such as 1.0.
        const tokens =
          Effect.pipe(
            text,
            EffectString.match(/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g),
            Effect.Option.getOrElse(() => null),
          ) ?? [];
        assert(
          EffectArray.every(tokens, token => Effect.pipe(token, EffectString.startsWith('"')) || !/[.eE]/.test(token)),
        );
        const value = JSON.parse(text);
        assert(
          raw.length <= 480 &&
            object(value) &&
            EffectArray.every(EffectRecord.keys(value), key => fields.has(key)) &&
            value.version === 1,
        );
        assert(
          EffectArray.every(
            EffectRecord.toEntries(enums),
            ([key, allowed]) => !(key in value) || allowed.has(value[key]),
          ),
        );
        assert(
          EffectArray.every(
            EffectRecord.toEntries(value),
            ([key, item]) => key in enums || typeof item === 'boolean' || Number.isInteger(item),
          ),
        );
        assert(EffectArray.every(['version', 'pid', 'event', 'verb'], key => key in value));
        events.push(value);
      } catch (error) {
        if (isMissing(error)) missing++;
        else corrupt++;
      }
    }
    const starts = EffectArray.filter(events, event => event.event === 'start');
    const latest =
      EffectOption.getOrUndefined(EffectArray.findFirst([...starts].reverse(), event => event.verb === 'show')) ??
      EffectOption.getOrUndefined(EffectArray.findFirst([...events].reverse(), event => event.verb === 'show'));
    const relevant = EffectArray.filter(events, event => latest !== undefined && event.pid === latest.pid);
    const counts = {
      events: events.length,
      corrupt,
      unusedOrMissingSlots: missing,
      exceptions: EffectArray.filter(events, event => event.event === 'exception').length,
      orphanResults: EffectArray.filter(
        events,
        event => event.event === 'result' && !EffectArray.some(starts, row => row.pid === event.pid),
      ).length,
      unmatchedStarts: EffectArray.filter(
        starts,
        event => !EffectArray.some(events, row => row.pid === event.pid && row.event === 'result'),
      ).length,
      unforwardedResults: EffectArray.filter(
        events,
        event =>
          event.event === 'result' &&
          !EffectArray.some(events, row => row.pid === event.pid && row.event === 'forwarded'),
      ).length,
    };
    const projection: Json = {
      phase: 'producer-before-postfailure-probes',
      setup: traceSetup,
      state: events.length ? 'present' : 'missing-or-unreadable',
      counts,
      latestShow: relevant.slice(-4),
    };
    try {
      const snapshot = `${JSON.stringify({projection, events})}\n`;
      assert(Buffer.byteLength(snapshot) <= 64 * 1024);
      diagnosticArtifact(join(traceRoot, `${profile}-publication-producer-native.log`), snapshot);
    } catch {
      projection.snapshotWriteFailed = true;
    }
    return projection;
  }
  function diagnosticArtifact(path: string, text: string) {
    writeFileSync(path, text, 'utf8');
    writeFileSync(`${path}.stdout.bin`, Buffer.alloc(0));
    writeFileSync(`${path}.stderr.bin`, Buffer.alloc(0));
  }
  function timeoutStdoutProjection(error: ReleaseCommandError): Json {
    const raw = error.stdout;
    if (!raw.length) return {capture: 'no-output'};
    if (raw.length > 65536) return {capture: 'oversize'};
    try {
      const value = JSON.parse(decodeReleaseOutput(raw));
      if (!object(value)) return {capture: 'incomplete'};
      const closeout = object(value.closeout) ? value.closeout : {};
      return {
        capture: 'complete-json',
        status: ['ok', 'error'].includes(value.status) ? value.status : 'other',
        closeoutState: ['prepared', 'archiving', 'complete'].includes(closeout.state) ? closeout.state : 'other',
      };
    } catch {
      return {capture: 'incomplete'};
    }
  }
  function readJournal(path: string, codec: string | null, small = false): Json {
    const admitted = (value: Json) => {
      if (small) {
        assert(object(value), 'journal-shape-invalid');
        if (codec === null)
          assert(
            !('format' in value) &&
              object(value.intent) &&
              EffectArray.isArray(value.intent.stages) &&
              object(value.progress),
            'publication-shape-invalid',
          );
        else {
          const expected: Record<string, string> = {
            'threadnote-native-workflow-state-gzip-v1': 'threadnote-native-workflow',
            'threadnote-native-closeout-state-gzip-v1': 'threadnote-native-closeout',
          };
          assert(expected[codec] !== undefined && value.format === expected[codec], 'journal-format-invalid');
        }
      }
      return value;
    };
    const storedLimit = (small ? 1 : 16) * 1024 * 1024;
    const expandedLimit = (small ? 4 : 64) * 1024 * 1024;
    if (small) {
      const stat = lstatSync(path);
      assert(!stat.isSymbolicLink() && stat.isFile(), 'journal-not-regular');
    }
    const raw = readBounded(path, storedLimit);
    assert(raw.length <= storedLimit, 'journal-too-large');
    const value = JSON.parse(decodeReleaseOutput(raw));
    if (codec === null || !object(value) || value.format !== codec) return admitted(value);
    assert.deepEqual(EffectRecord.keys(value).sort(), ['expandedBytes', 'format', 'payload', 'sha256']);
    assert(
      Number.isInteger(value.expandedBytes) &&
        value.expandedBytes > 0 &&
        value.expandedBytes <= expandedLimit &&
        typeof value.payload === 'string',
      'journal-envelope-invalid',
    );
    // Buffer's base64 decoder is permissive; validate the envelope before decoding.
    assert(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.payload),
      'journal-envelope-invalid',
    );
    const decoded = gunzipSync(Buffer.from(value.payload, 'base64'), {maxOutputLength: value.expandedBytes + 1});
    assert(decoded.length === value.expandedBytes && hash(decoded) === value.sha256, 'journal-envelope-integrity');
    return admitted(JSON.parse(decodeReleaseOutput(decoded)));
  }
  function persistFinishPublicationDiagnostic(
    response: unknown,
    timedOut = false,
    suppliedProducer?: Json,
    timeoutOutput?: Json,
  ) {
    const producer = suppliedProducer ?? snapshotProducer();
    const statePath = join(home, 'workflow-automations', 'native-v1', `${runId}.json`);
    let bindingId: string | null = null,
      captureError: string | null = null,
      nativeState: Json | null = null;
    try {
      if (!existsSync(statePath) || !statSync(statePath).isFile()) captureError = 'native-state-missing';
      else {
        nativeState = readJournal(statePath, 'threadnote-native-workflow-state-gzip-v1', timedOut);
        bindingId = object(nativeState) ? nativeState.bindingId : null;
        if (typeof bindingId !== 'string' || !/^[a-f0-9]{64}$/.test(bindingId)) captureError = 'native-binding-invalid';
      }
    } catch {
      captureError = 'native-state-invalid';
    }
    if (timedOut) {
      // Only bounded persisted receipt reads are reachable after a timeout.
      const closedStatus = (value: unknown, choices: string[]) =>
        typeof value === 'string' && choices.includes(value) ? value : 'other';
      const count = (value: unknown, kind: 'array' | 'object') => {
        if (value === null || typeof value !== 'object') return null;
        return kind === 'array'
          ? EffectArray.isArray(value)
            ? // oxlint-disable-next-line effecttsgo/prefer-effect-record -- Native array keys exclude the length property and sparse holes in persisted diagnostic counts.
              Object.keys(value).length
            : null
          : !EffectArray.isArray(value)
            ? EffectRecord.keys(value).length
            : null;
      };
      const snapshot = (path: string, codec: string | null): [Json, string] => {
        try {
          const value = readJournal(path, codec, true);
          return object(value) ? [value, 'present'] : [{}, 'invalid-or-over-limit'];
        } catch (error) {
          return [{}, isMissing(error) ? 'missing' : 'invalid-or-over-limit'];
        }
      };
      const [closeout, closeoutRead] = snapshot(
        `${statePath}.closeout.json`,
        'threadnote-native-closeout-state-gzip-v1',
      );
      const unavailablePublication: [Json, string] = [{}, 'binding-unavailable'];
      const [publication, publicationRead] =
        bindingId && captureError === null
          ? snapshot(join(home, 'workflow-memory', `${bindingId}.publication.json`), null)
          : unavailablePublication;
      const native = object(nativeState) ? nativeState : {};
      const operationCount = count(native.operations, 'array');
      const operations = EffectArray.isArray(native.operations) ? native.operations : [];
      const lastOperation = operations.at(-1);
      const last: Json = object(lastOperation) ? lastOperation : {};
      const stages =
        object(publication.intent) && EffectArray.isArray(publication.intent.stages) ? publication.intent.stages : [];
      const progress = object(publication.progress) ? publication.progress : {};
      const rows = EffectArray.map(stages.slice(0, 3), (stage, index) => {
        const key = object(stage) ? stage.key : null;
        const receipt = typeof key === 'string' && object(progress[key]) ? progress[key] : {};
        return {
          ordinal: index,
          stage: closedStatus(key, ['architecture:create', 'spec:create', 'architecture:final']),
          started: receipt.started === true,
          committed: object(receipt.committed),
          verified: object(receipt.verified),
        };
      });
      const counts = object(producer.counts) ? producer.counts : {};
      const markerValue = {
        version: 1,
        phase: 'persisted-after-finish-timeout',
        timeoutSeconds: closeoutFinishTimeoutMs / 1000,
        stdout: timeoutOutput,
        producerRetainedShow: EffectArray.isArray(producer.latestShow) && producer.latestShow.length > 0,
        native: {
          captureError,
          operations: operationCount,
          prepared:
            operationCount === null
              ? null
              : EffectArray.filter(operations, item => object(item) && item.status === 'prepared').length,
          verified:
            operationCount === null
              ? null
              : EffectArray.filter(operations, item => object(item) && item.status === 'verified').length,
          lastOperationInArray: {
            ordinal: operations.length ? operations.length - 1 : null,
            status: closedStatus(last.status, ['prepared', 'verified']),
            artifactPresent: object(last.artifact),
          },
        },
        closeout: {
          read: closeoutRead,
          status: closedStatus(closeout.status, ['prepared', 'archiving', 'complete']),
          documents: count(closeout.documents, 'array'),
          outputs: count(closeout.outputs, 'object'),
          owned: count(closeout.owned, 'array'),
          archives: count(closeout.archives, 'object'),
          publicationSaved: object(closeout.publication),
        },
        publication: {read: publicationRead, stages: rows},
        producer: EffectRecord.fromEntries(
          EffectArray.map(
            [
              'events',
              'corrupt',
              'unusedOrMissingSlots',
              'exceptions',
              'orphanResults',
              'unmatchedStarts',
              'unforwardedResults',
            ],
            key => [key, Number.isInteger(counts[key]) && counts[key] >= 0 && counts[key] <= 128 ? counts[key] : null],
          ),
        ),
      };
      const prefix = 'NATIVE_CLOSEOUT_TIMEOUT_DIAGNOSTICS ';
      let marker = `${prefix}${asciiJson(markerValue)}\n`;
      if (Buffer.byteLength(marker) > 2048)
        marker = `${prefix}{"version":1,"phase":"persisted-after-finish-timeout","captureError":"marker-overflow"}\n`;
      try {
        diagnosticArtifact(join(traceRoot, `${profile}-closeout-timeout-native.log`), marker);
      } catch {
        /* Best-effort failure evidence. */
      }
      process.stderr.write(marker);
      return null;
    }
    let publication: Json | null = null,
      bindingJournal: Json | null = null,
      publicationPath: string | null = null;
    if (bindingId && captureError === null) {
      publicationPath = join(home, 'workflow-memory', `${bindingId}.publication.json`);
      const bindingPath = join(home, 'workflow-memory', `${bindingId}.json`);
      try {
        if (existsSync(publicationPath) && statSync(publicationPath).isFile())
          publication = readJournal(publicationPath, 'threadnote-workflow-publication-journal-gzip-v1');
        else captureError = 'publication-journal-missing';
      } catch {
        captureError = 'publication-journal-invalid';
      }
      try {
        if (existsSync(bindingPath) && statSync(bindingPath).isFile()) {
          bindingJournal = readJournal(bindingPath, 'threadnote-workflow-journal-gzip-v1');
          if (
            object(bindingJournal) &&
            bindingJournal.journalStorage === 'threadnote-workflow-journal-shared-values-v1'
          ) {
            assert(object(bindingJournal.journal));
            bindingJournal = bindingJournal.journal;
          }
        } else if (captureError === null) captureError = 'binding-journal-missing';
      } catch {
        if (captureError === null) captureError = 'binding-journal-invalid';
      }
    }
    const intent = object(publication?.intent) ? publication.intent : {};
    const rawStages = EffectArray.isArray(intent.stages) ? intent.stages : [];
    const rawNodes = EffectArray.isArray(intent.nodes) ? intent.nodes : [];
    const progress = object(publication?.progress) ? publication.progress : {};
    const binding = object(bindingJournal?.binding) ? bindingJournal.binding : {};
    const expectedRemote = binding.remote,
      expectedBranch = binding.branch;
    const finalReceipts: Json[] = [];
    const nodeKeys = [
      ...new Set(
        EffectArray.flatMap(rawNodes.slice(0, 3), node =>
          object(node) && object(node.input) && typeof node.input.key === 'string' ? [node.input.key] : [],
        ),
      ),
    ];
    for (const nodeKey of nodeKeys.slice(0, 3)) {
      const node = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          rawNodes.slice(0, 3),
          item => object(item) && object(item.input) && item.input.key === nodeKey,
        ),
      );
      const stage = EffectOption.getOrUndefined(
        EffectArray.findFirst([...rawStages.slice(0, 3)].reverse(), item => object(item) && item.nodeKey === nodeKey),
      );
      if (!object(node) || !object(stage)) continue;
      const stageKey = stage.key,
        prepared = object(node.prepared) ? node.prepared : {};
      const uri = prepared.memoryUri;
      const expectedPath =
        typeof uri === 'string' && Effect.pipe(uri, EffectString.includes('/shared/default/'))
          ? Effect.pipe(uri, EffectString.split('/shared/default/'))[1]
          : null;
      const expectedHash = typeof prepared.memory === 'string' ? hash(prepared.memory) : null;
      const stageProgress = typeof stageKey === 'string' && object(progress[stageKey]) ? progress[stageKey] : {};
      const receipt = object(stageProgress.verified) ? stageProgress.verified : {};
      const checks: Json = {
        commitFormat: typeof receipt.commit === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(receipt.commit),
        remoteMatches: expectedRemote != null ? receipt.remote === expectedRemote : null,
        branchMatches: expectedBranch != null ? receipt.branch === expectedBranch : null,
        pathMatches: expectedPath !== null && receipt.path === expectedPath,
        contentHashMatches: expectedHash !== null && receipt.contentHash === expectedHash,
      };
      checks.verifyFinalGraphPredicate =
        EffectRecord.keys(receipt).length > 0 &&
        EffectArray.every(EffectRecord.values(checks), value => value === true);
      finalReceipts.push({
        nodeKey: Effect.pipe(nodeKey, EffectString.slice(0, 64)),
        stageKey: Effect.pipe(String(stageKey || ''), EffectString.slice(0, 96)),
        started: stageProgress.started === true,
        committedPresent: object(stageProgress.committed),
        verifiedPresent: object(stageProgress.verified),
        checks,
      });
    }
    const stageReceipts: Json[] = [];
    let pendingStage: Json | null = null;
    for (const stage of rawStages.slice(0, 3)) {
      if (!object(stage)) continue;
      const state = object(progress[stage.key]) ? progress[stage.key] : {};
      stageReceipts.push({
        key: Effect.pipe(String(stage.key ?? ''), EffectString.slice(0, 96)),
        started: state.started === true,
        committed: object(state.committed),
        verified: object(state.verified),
      });
      if (pendingStage === null && state.started === true && !state.verified) pendingStage = stage;
    }
    let worktreeProbe: Json | null = null;
    if (pendingStage !== null) {
      try {
        const teams = jsonFile(join(home, 'share/teams.json'));
        const worktree = teams.teams.default.worktree;
        assert(within(home, worktree));
        const prepared = pendingStage.prepared;
        const relativePath = prepared.memoryUri.split('/shared/default/')[1];
        const target = join(worktree, ...relativePath.split('/'));
        const expected = Buffer.from(prepared.memory, 'utf8');
        const probeGit = (args: string[]) => {
          let result: {status: number | null; stdout: Buffer; stderr: Buffer};
          try {
            result = {
              status: 0,
              ...runReleaseCommandBytes(['git', '-C', worktree, ...args], environment, repo, {timeoutMs: 10_000}),
            };
          } catch (error) {
            if (!(error instanceof ReleaseCommandError) || error.timedOut || error.cause) throw error;
            result = error;
          }
          const {status, stdout, stderr} = result;
          const errorText = Effect.pipe(stderr.toString('utf8'), EffectString.toLowerCase);
          const failure = EffectOption.getOrUndefined(
            EffectArray.findFirst(
              [
                ['filename too long', 'path-too-long'],
                ['invalid path', 'invalid-path'],
                ['permission denied', 'permission-denied'],
                ['index.lock', 'index-lock'],
              ],
              __effectArrayValue =>
                !!(([token]) => Effect.pipe(errorText, EffectString.includes(token)))(__effectArrayValue),
            ),
          )?.[1];
          return {
            status,
            stdout,
            detail: {
              exit: status,
              failure: failure ?? (stderr.length ? 'unknown' : 'none'),
              stdoutBytes: stdout.length,
              stderrBytes: stderr.length,
            },
          };
        };
        const targetExists = existsSync(target) && statSync(target).isFile();
        worktreeProbe = {
          phase: 'postfailure',
          targetExists,
          targetPathBytes: Buffer.byteLength(target),
          targetPathCharacters: [...target].length,
          canonicalPathMatches: canonical(target) === join(canonical(worktree), ...relativePath.split('/')),
        };
        if (targetExists) worktreeProbe.worktreeMatches = readFileSync(target).equals(expected);
        for (const [label, revision] of [
          ['head', 'HEAD'],
          ['index', ''],
        ]) {
          const result = probeGit(['show', `${revision}:${relativePath}`]);
          worktreeProbe[label] = {...result.detail, matches: result.status === 0 && result.stdout.equals(expected)};
        }
        const resolved = probeGit(['rev-parse', '--verify', 'HEAD']);
        const revision = Effect.pipe(resolved.stdout.toString('ascii'), EffectString.trim);
        if (resolved.status === 0 && /^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/.test(revision)) {
          const result = probeGit(['show', `${revision}:${relativePath}`]);
          worktreeProbe.fullSha = {...result.detail, matches: result.status === 0 && result.stdout.equals(expected)};
        } else worktreeProbe.fullSha = {failure: 'invalid-or-missing-head'};
        for (const [label, option] of [
          ['longpaths', 'core.longpaths'],
          ['autocrlf', 'core.autocrlf'],
        ]) {
          const result = probeGit(['config', '--get', option]);
          const value = Effect.pipe(result.stdout.toString('ascii'), EffectString.trim);
          worktreeProbe[label] = {
            ...result.detail,
            value: ['true', 'false', 'input', ''].includes(value) ? value : 'other',
          };
        }
      } catch {
        worktreeProbe = {captureError: 'worktree-probe-failed'};
      }
    }
    const diagnostic: Json = {
      version: 1,
      profile,
      bindingIdPrefix: typeof bindingId === 'string' ? Effect.pipe(bindingId, EffectString.slice(0, 12)) : null,
      captureError,
      closeoutCode: object(response) ? Effect.pipe(String(response.code ?? ''), EffectString.slice(0, 80)) : null,
      finalReceipts: finalReceipts.slice(0, 3),
      stageReceipts,
      worktreeProbe,
      producer,
      localSnapshotSaved: false,
    };
    const diagnosticPath = join(fixture, 'finish-publication-diagnostic.json');
    try {
      save(diagnosticPath, {...diagnostic, publicationJournalPath: publicationPath});
      diagnostic.localSnapshotSaved = true;
    } catch {
      /* Best-effort local evidence. */
    }
    let marker = asciiJson(diagnostic);
    if (Buffer.byteLength(marker) > 3800)
      marker = asciiJson({
        version: 1,
        profile,
        bindingIdPrefix: typeof bindingId === 'string' ? Effect.pipe(bindingId, EffectString.slice(0, 12)) : null,
        captureError: 'marker-overflow',
        finalReceiptCount: finalReceipts.length,
        producer,
      });
    process.stderr.write(`NATIVE_PUBLICATION_DIAGNOSTICS ${marker}\n`);
    return diagnosticPath;
  }
  function call(
    request: Json,
    expectedCode?: string,
    allowedStatuses: readonly string[] = ['ok'],
    maxBytes?: number,
  ): Json {
    const capture = request.action === 'closeout' && request.command === 'finish';
    delete environment.THREADNOTE_RELEASE_PUBLICATION_TRACE;
    let stdout = '',
      stderr = '',
      status: number | null = 0;
    try {
      if (capture) {
        try {
          rmSync(traceDirectory, {recursive: true, force: true});
          mkdirSync(traceDirectory);
          environment.THREADNOTE_RELEASE_PUBLICATION_TRACE = '1';
          traceSetup = 'enabled';
        } catch {
          traceSetup = 'reset-failed';
        }
      }
      try {
        stdout = run(
          [binary, 'workflow-automation', '--home', home],
          repo,
          capture ? closeoutFinishTimeoutMs : 180_000,
          JSON.stringify(request),
        );
      } catch (error) {
        if (!(error instanceof ReleaseCommandError) || error.timedOut || error.cause) throw error;
        status = error.status;
        // Expected protocol rejection is decoded explicitly by its caller.
        stdout = decodeReleaseOutput(error.stdout);
        stderr = decodeReleaseOutput(error.stderr);
      }
    } catch (error) {
      if (capture && error instanceof ReleaseCommandError && error.timedOut) {
        try {
          const output = timeoutStdoutProjection(error);
          const producer = snapshotProducer();
          persistFinishPublicationDiagnostic({}, true, producer, output);
        } catch {
          try {
            process.stderr.write(
              `NATIVE_CLOSEOUT_TIMEOUT_DIAGNOSTICS ${asciiJson({version: 1, timeoutSeconds: closeoutFinishTimeoutMs / 1000, captureError: 'summary-failed'})}\n`,
            );
          } catch {
            /* Preserve the process error. */
          }
        }
      } else if (capture) snapshotProducer();
      throw error;
    } finally {
      delete environment.THREADNOTE_RELEASE_PUBLICATION_TRACE;
    }
    if (maxBytes !== undefined && Buffer.byteLength(stdout, 'utf8') > maxBytes) {
      records.push({
        action: request.action ?? null,
        command: request.command ?? null,
        returncode: status,
        status: 'response-too-large',
        code: null,
      });
      save(join(fixture, 'receipts.json'), records);
      throw new Error(`CLI response exceeded ${maxBytes} bytes for ${request.action}.`);
    }
    let value: Json;
    try {
      value = JSON.parse(stdout);
    } catch (error) {
      if (capture) snapshotProducer();
      throw new Error(`CLI returned non-JSON output for ${request.action}.`, {cause: error});
    }
    records.push({
      action: request.action ?? null,
      command: request.command ?? null,
      returncode: status,
      status: object(value) ? (value.status ?? null) : null,
      code: object(value) ? (value.code ?? null) : null,
    });
    save(join(fixture, 'receipts.json'), records);
    if (expectedCode !== undefined) {
      assert(status !== 0 && value.code === expectedCode, JSON.stringify(value));
      return value;
    }
    if (status !== 0 || !object(value) || !allowedStatuses.includes(value.status)) {
      if (capture) {
        try {
          persistFinishPublicationDiagnostic(value);
        } catch {
          process.stderr.write(
            `NATIVE_PUBLICATION_DIAGNOSTICS ${JSON.stringify({version: 1, profile, captureError: 'diagnostic-capture-failed'})}\n`,
          );
        }
      }
      throw new Error(
        `CLI request failed: ${JSON.stringify(value)}\n${Effect.pipe(stderr, EffectString.slice(-2000))}`,
      );
    }
    return value;
  }
  const author = (command: string, values: Json = {}): Json =>
    call({...common, action: 'authoring', command, ...values}).authoring;
  const cycle = (command: string, values: Json = {}): Json =>
    call({...common, action: 'cycle', command, ...values}).cycle;
  const mutateCycle = (command: string, values: Json = {}): Json =>
    cycle(command, {expectedRevision: cycle('inspect').revision, ...values});
  const readArtifact = (uri: string): Json => {
    const artifact = call({...common, action: 'read', uri}).artifact;
    assert.equal(artifact.uri, uri);
    return artifact;
  };
  const structuredDocument = (artifact: Json): Json => {
    const body = artifact.body,
      marker = '\n<!-- threadnote-authoring:v1 ';
    const start = body.lastIndexOf(marker),
      end = body.lastIndexOf(' -->\n');
    assert(start >= 0 && end > start, 'Expected complete structured native document readback');
    return JSON.parse(body.slice(start + marker.length, end));
  };
  let remote: string | null = null;
  if (profile !== 'desktop') {
    remote = join(fixture, 'remote.git');
    const seed = join(fixture, 'seed');
    for (const [args, cwd] of [
      [['init', '--bare', '--initial-branch=main', remote], fixture],
      [['clone', remote, seed], fixture],
      [['config', 'user.email', 'fixture@example.invalid'], seed],
      [['config', 'user.name', 'Release Workflow Fixture'], seed],
    ] as [string[], string][])
      run(['git', ...args], cwd);
    writeFileSync(join(seed, 'README.md'), 'Private local share fixture.\n', 'utf8');
    for (const args of [
      ['add', 'README.md'],
      ['commit', '-m', 'Seed isolated share'],
      ['push', 'origin', 'main'],
    ])
      run(['git', ...args], seed);
    git('remote', 'add', 'origin', 'https://github.com/fixture/native-release.git');
    const provider = profile === 'codex-cloud-personal' ? 'codex' : 'cursor';
    run(
      [
        binary,
        '--home',
        home,
        'cloud',
        provider,
        'bootstrap',
        '--remote',
        remote,
        '--team',
        'default',
        '--user',
        'release-fixture',
        '--agent-id',
        'release-fixture',
      ],
      repo,
      180_000,
    );
    const identity = jsonFile(join(home, `${provider}-cloud`, 'profile.json'));
    assert(identity.provider === `${provider}-cloud` && identity.user === 'release-fixture', JSON.stringify(identity));
  }
  let plan: Json = {
    format: 'threadnote-native-authoring',
    schemaVersion: 1,
    kind: 'plan',
    id: 'private-closeout-feature',
    project: 'private-closeout-smoke',
    title: 'Private Native Closeout Smoke',
    objective: 'Retain complete verified behavior and original decision rationale.',
    requirements: [{id: 'complete-read', behavior: 'The reader returns every stored field.'}],
    context: {
      codeRefs: ['source.ts'],
      evidenceRefs: [],
      note: 'Synthetic private smoke fixture; no external or production claims.',
    },
    source: {
      head: git('rev-parse', 'HEAD'),
      files: [{path: 'source.ts', sha256: hash(readFileSync(join(repo, 'source.ts')))}],
    },
    current: {
      summary: 'A reader uses the existing store.',
      components: ['Reader', 'Store'],
      contracts: ['Stored values remain complete.'],
      diagram: 'flowchart TD\n  Reader --> Store',
    },
    target: {
      summary: 'The reader returns complete records.',
      components: ['Reader', 'Store'],
      contracts: ['No field is silently omitted.'],
      diagram: 'flowchart TD\n  Reader --> Store',
    },
    phases: [
      {
        id: 'verify-read',
        title: 'Verify complete reads',
        outcome: 'The local reader preserves the complete value.',
        dependsOn: [],
        affectedPaths: ['source.ts'],
        newPaths: [],
        contracts: ['Return every stored field.'],
        acceptance: [
          {
            id: 'complete-read-check',
            criterion: 'The committed reader source is present and the local check passes.',
            verification: 'Read the exact source file and run git diff --check.',
            requirementIds: ['complete-read'],
          },
        ],
        safeBoundary: 'Private local fixture only; no merge or publication.',
      },
    ],
    decisions: [
      {
        id: 'retain-store',
        question: 'Should the existing store be retained?',
        selection: 'retain',
        selected: 'Retain the existing store and its complete-record behavior.',
        alternatives: [
          {
            id: 'replace-store',
            design: 'Replace the current store.',
            tradeoffs: 'Adds migration risk without improving the verified behavior.',
          },
        ],
        rationale:
          'The current store already preserves complete values; retaining it avoids a needless migration while meeting the approved behavior.',
        affectedPhases: ['verify-read'],
        authority: 'orchestrator',
      },
      {
        id: 'reject-partial-read',
        question: 'Should the reader return partial records?',
        selection: 'adapt',
        selected: 'Return the complete record and reject partial-read behavior.',
        alternatives: [
          {
            id: 'partial-record',
            design: 'Return only the fields available in the first response.',
            tradeoffs: 'Hides missing data and weakens the complete-read requirement.',
          },
        ],
        rationale:
          'The partial-record alternative was rejected because missing fields would be silent data loss; the reader must preserve the full stored value.',
        affectedPhases: ['verify-read'],
        authority: 'orchestrator',
      },
    ],
    openQuestions: [],
    review: {required: false, reason: 'Synthetic CLI smoke data; not a product approval.'},
  };
  const actualDecisions: Json = {
    'retain-store': {
      implemented: 'Kept the existing complete-record storage behavior.',
      rationale: 'The local source preserves the existing store contract and returns the full value.',
    },
    'reject-partial-read': {
      implemented: 'Returned complete records; partial-read behavior remained rejected.',
      rationale: 'The local reader returns the whole value and does not introduce a partial response path.',
    },
  };

  call({
    ...common,
    action: 'init',
    project: plan.project,
    featureId: plan.id,
    title: plan.title,
    profile,
    ...(profile === 'desktop' ? {} : {team: 'default'}),
  });
  call({...common, action: 'graph-ready'});
  const spec: Json = EffectRecord.fromEntries(
    EffectArray.map(
      ['format', 'schemaVersion', 'id', 'project', 'title', 'objective', 'requirements', 'context', 'source', 'review'],
      key => [key, plan[key]],
    ),
  );
  Object.assign(spec, {
    kind: 'spec',
    actors: ['Reader'],
    inScope: ['Read complete stored values.'],
    outOfScope: [],
    constraints: [],
    observations: [],
    scenarios: [
      {
        id: 'complete-read-scenario',
        requirementIds: ['complete-read'],
        given: 'A complete stored value.',
        when: 'The reader requests the value.',
        then: 'Every stored field is returned.',
      },
    ],
    assumptions: [],
    questions: [],
    artifacts: [],
  });
  const acceptance = author('acceptance-packet', {document: spec, detail: 'document'});
  assert.deepEqual(acceptance.document, spec);
  const confirmation = author('confirm', {
    document: spec,
    userDecision: 'approve',
    userResponse: 'Approve only this synthetic isolated complete-read fixture.',
  }).confirmation;
  assert.equal(confirmation.intentHash, acceptance.intentHash);
  const savedSpec = author('save', {document: spec, ready: true, expectedRevision: null, confirmation});
  assert.equal(savedSpec.readiness, 'ready');
  const specPacket = author('export-plan', {uri: savedSpec.root.uri});
  assert.deepEqual(specPacket.spec.root, savedSpec.root);
  assert.equal(specPacket.spec.binding.profile, profile);
  plan.phases[0].acceptance[0].scenarioIds = ['complete-read-scenario'];
  plan = author('from-spec', {packet: specPacket, document: plan}).document;
  assert.deepEqual(plan.spec, specPacket.spec);
  const authoringValidation = author('validate', {document: plan, ready: true});
  assert(authoringValidation.ready, `Plan validation issues: ${JSON.stringify(authoringValidation.issues)}`);
  const saved = author('save', {document: plan, ready: true, expectedRevision: null});
  assert.equal(saved.readiness, 'ready');
  const planRootUri = saved.root.uri;
  const exported = author('export-dev-cycle', {
    uri: planRootUri,
    delivery: 'local',
    bindings: {'verify-read': {branch: 'fixture/closeout-local', baseBranch: 'main'}},
  });
  assert.deepEqual(exported.phases[0].acceptanceRefs[0].requirements, ['complete-read']);
  assert.deepEqual(exported.phases[0].acceptanceRefs[0].specScenarios, ['complete-read-scenario']);
  const unrelatedResponse = call({
    ...common,
    action: 'write',
    operationId: 'private-unrelated-evidence',
    artifactKey: 'private-unrelated-evidence',
    role: 'evidence',
    nameHint: 'unrelated',
    body: 'Unrelated private evidence remains active after closeout.\n',
    expectedRevision: null,
    storageKind: profile === 'desktop' ? 'durable' : 'handoff',
    codeRefs: [],
    relations: [],
  });
  const unrelatedUri = unrelatedResponse.artifact.uri;
  git('checkout', '-b', 'fixture/closeout-local');
  assert.deepEqual(mutateCycle('init', {plan: exported}).next, {action: 'implement', phaseId: 'verify-read'});
  const snapshot = mutateCycle('snapshot', {phaseId: 'verify-read', snapshotId: 'verify-read-1'}).snapshot.snapshot;
  const review = {
    snapshotId: snapshot.snapshotId,
    phaseHash: snapshot.phaseHash,
    snapshotTree: snapshot.tree,
    status: 'complete',
    mode: 'full',
    selected: ['correctness', 'simplicity'],
    lanes: [
      {name: 'correctness', status: 'complete'},
      {name: 'simplicity', status: 'complete'},
    ],
    findings: [],
  };
  mutateCycle('validate-review', {snapshotId: snapshot.snapshotId, attemptId: 'verify-read-review-1', report: review});
  const sourceBytes = readFileSync(join(repo, 'source.ts'));
  assert(sourceBytes.includes('completeRead') && sourceBytes.includes('=> value'));
  git('diff', '--check');
  const validation = {
    snapshotTree: snapshot.tree,
    reviewTree: snapshot.tree,
    status: 'passed',
    productState: 'working',
    checks: [
      {
        command: 'git diff --check',
        result: 'passed',
        evidence: 'The real private fixture repository returned zero from git diff --check.',
      },
    ],
    acceptance: [
      {
        criterion: plan.phases[0].acceptance[0].criterion,
        result: 'passed',
        evidence:
          'Read the committed source.ts bytes and confirmed the completeRead identity implementation is present.',
      },
    ],
  };
  assert.deepEqual(mutateCycle('ready', {phaseId: 'verify-read', snapshotId: snapshot.snapshotId, validation}).next, {
    action: 'complete',
  });
  assert.equal(cycle('closeout-packet').phases.length, 1);
  const validationInput = call({...common, action: 'closeout', command: 'validation-input'});
  const proposal = {
    architecture: {
      summary: 'The implemented reader returns the complete local value.',
      components: ['Reader', 'Store'],
      contracts: ['Return every stored field.'],
      diagram: 'flowchart TD\n  Reader --> Store',
      invariants: ['A complete value is never silently truncated.'],
      unknowns: ['This private smoke does not measure production scale.'],
      deviations: [],
      codeRefs: ['source.ts'],
    },
    architectureVerification: 'Inspected the committed source.ts and verified the actual local cycle acceptance.',
    behaviorVerification:
      'Verified the complete saved spec and plan readback, linked acceptance scenario, committed completeRead source and successful local cycle checks.',
    combinedChecks: [
      {
        command: 'git diff --check',
        result: 'passed',
        evidence: 'The real private fixture repository returned zero from git diff --check.',
      },
    ],
    phaseEvidence: validationInput.phases.map((phase: Json) => ({
      id: phase.id,
      acceptance: phase.acceptanceCriteria.map((criterion: string) => ({
        criterion,
        evidence: 'Verified against committed source.ts and the local cycle receipt.',
      })),
    })),
    scenarios: validationInput.scenarios.map((item: Json) => ({
      id: item.id,
      evidence: 'Read complete committed source and verified every stored field is returned.',
    })),
    decisions: plan.decisions.map((item: Json) => ({id: item.id, ...actualDecisions[item.id]})),
  };
  assert(call({...common, action: 'closeout', command: 'prepare', proposal}).closeout.owned > 0);
  const beforeCloseoutInspect = call({...common, action: 'inspect'});
  const ownedUris: string[] = [
    ...new Set<string>(
      beforeCloseoutInspect.operations
        .filter((operation: Json) => operation.uri && (operation.operationId ?? '').startsWith('author-'))
        .map((operation: Json) => operation.uri),
    ),
  ].sort();
  assert(ownedUris.length && !ownedUris.includes(unrelatedUri));
  const ownedMemoryIds = EffectRecord.fromEntries(
    beforeCloseoutInspect.operations
      .filter((operation: Json) => ownedUris.includes(operation.uri))
      .map((operation: Json) => [operation.uri, operation.memoryId]),
  );
  assert.deepEqual(EffectRecord.keys(ownedMemoryIds).sort(), ownedUris);
  let decisionDocuments: string[],
    remoteHead: string | null = null;
  if (profile === 'desktop') {
    const closeoutSummary = call({...common, action: 'closeout', command: 'finish'}).closeout;
    assert.equal(closeoutSummary.state, 'complete');
    assert.equal(closeoutSummary.owned, ownedUris.length);
    assert.equal(closeoutSummary.archived, ownedUris.length);
    assert.equal(readArtifact(unrelatedUri).state, 'active');
    const outputs = EffectRecord.fromEntries(closeoutSummary.outputs.map((item: Json) => [item.key, item]));
    const architectureRef = outputs.architecture,
      decisionIndexRef = outputs['decisions-0'];
    const architectureArtifact = readArtifact(architectureRef.uri);
    assert(architectureArtifact.body.includes(decisionIndexRef.uri));
    const decisionIndexDocument = structuredDocument(readArtifact(decisionIndexRef.uri));
    const decisionEntries = decisionIndexDocument.sections.find((section: Json) => section.id === 'entries').body;
    const decisionUris = EffectArray.map(
      [...decisionEntries.matchAll(/^-\s*(threadnote:\/\/\S+)$/gm)],
      match => match[1],
    );
    assert.equal(decisionUris.length, plan.decisions.length, JSON.stringify(decisionUris));
    decisionDocuments = EffectArray.map(decisionUris, uri => readArtifact(uri).body);
    const historyUris = new Set<string>([outputs['history-0'].uri]),
      seenHistoryUris = new Set<string>();
    const archiveDestinations: Record<string, string> = {};
    while (historyUris.size) {
      const historyUri = historyUris.values().next().value!;
      historyUris.delete(historyUri);
      if (seenHistoryUris.has(historyUri)) continue;
      seenHistoryUris.add(historyUri);
      const historyDocument = structuredDocument(readArtifact(historyUri));
      const historyEntries = historyDocument.sections.find((section: Json) => section.id === 'entries').body;
      // oxlint-disable-next-line no-control-regex -- Preserve Python splitlines boundaries in complete history readback.
      for (const line of historyEntries.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/)) {
        if (line.startsWith('{')) {
          const item = JSON.parse(line);
          archiveDestinations[item.source] = item.archive;
        } else if (line.startsWith('Next: threadnote://')) historyUris.add(line.slice('Next: '.length).trim());
      }
    }
    assert.deepEqual(EffectRecord.keys(archiveDestinations).sort(), ownedUris);
    assert.equal(new Set(EffectRecord.values(archiveDestinations)).size, ownedUris.length);
    for (const sourceUri of ownedUris) {
      const archived = readArtifact(archiveDestinations[sourceUri]);
      assert.equal(archived.state, 'archived');
      assert.equal(archived.memoryId, ownedMemoryIds[sourceUri]);
    }
  } else {
    const publication = call({...common, action: 'closeout', command: 'publication-preview'}).publication;
    assert.deepEqual(publication.nodes.map((node: Json) => node.key).sort(), ['architecture', 'spec']);
    call(
      {
        ...common,
        action: 'closeout',
        command: 'publication-approve',
        approvalDigest: Effect.pipe('0', EffectString.repeat(64)),
        decision: 'approve',
        approvalEvidence: 'Synthetic wrong-digest rejection fixture.',
      },
      'publication-approval-changed',
    );
    for (const uri of ownedUris) assert.equal(readArtifact(uri).state, 'active');
    call({
      ...common,
      action: 'closeout',
      command: 'publication-approve',
      approvalDigest: publication.approvalDigest,
      decision: 'approve',
      approvalEvidence: 'Explicit fixture authority approves this exact isolated local bare Git publication graph.',
    });
    const closeoutSummary = call({...common, action: 'closeout', command: 'finish'}).closeout;
    assert.equal(closeoutSummary.state, 'complete');
    assert.equal(closeoutSummary.owned, ownedUris.length);
    assert.equal(closeoutSummary.archived, ownedUris.length);
    assert.equal(readArtifact(unrelatedUri).state, 'active');
    const extensions =
      process.platform === 'win32'
        ? Effect.pipe(environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD', EffectString.split(';'))
        : [''];
    const memoryReader = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.flatMap(
          (environment.PATH ?? '')
            // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This separator is not proven nonempty; native split returns [] for an empty receiver with an empty separator while Effect String split returns a nonempty array.
            .split(delimiter),
          directory => EffectArray.map(extensions, extension => join(directory, `memory-read${extension}`)),
        ),
        __effectArrayValue =>
          !!(path => {
            try {
              accessSync(path, constants.X_OK);
              return statSync(path).isFile();
            } catch {
              return false;
            }
          })(__effectArrayValue),
      ),
    );
    assert(memoryReader, 'The isolated native memory reader must be available');
    const remoteBodies: Record<string, string> = {};
    for (const node of publication.nodes) {
      const relativePath = node.canonicalUri.split('/shared/default/')[1];
      const raw = run(['git', '-C', remote!, 'show', `main:${relativePath}`]);
      const parsed = JSON.parse(run([memoryReader, node.canonicalUri], repo, 30_000, raw));
      const durableBody = `${parsed.body.trim()}\n`;
      assert.equal(hash(durableBody), node.bodySha256);
      assert.equal(durableBody, `${node.body.trim()}\n`);
      for (const forbidden of [fixture, home, '.context', '.closeout.json', ...ownedUris])
        assert(!Effect.pipe(raw, EffectString.includes(forbidden)), forbidden);
      remoteBodies[node.key] = durableBody;
    }
    assert(Effect.pipe(remoteBodies.spec, EffectString.includes(spec.scenarios[0].given)));
    decisionDocuments = [remoteBodies.architecture];
    const receipt = jsonFile(join(home, 'workflow-automations', 'native-v1', `${runId}.json.closeout.json`));
    assert(object(receipt.archives));
    assert.deepEqual(EffectRecord.keys(receipt.archives).sort(), ownedUris);
    assert.equal(
      new Set(EffectArray.map(EffectRecord.values(receipt.archives), item => item.uri)).size,
      ownedUris.length,
    );
    for (const uri of ownedUris) {
      const archived = readArtifact(receipt.archives[uri].uri);
      assert.equal(archived.state, 'archived');
      assert.equal(archived.memoryId, ownedMemoryIds[uri]);
      assert.equal(archived.memoryId, receipt.archives[uri].memoryId);
    }
    remoteHead = Effect.pipe(run(['git', '-C', remote!, 'rev-parse', 'main']), EffectString.trim);
  }
  for (const planned of plan.decisions) {
    const actual = actualDecisions[planned.id],
      matching = EffectArray.filter(decisionDocuments, body => Effect.pipe(body, EffectString.includes(planned.id)));
    assert.equal(matching.length, 1, planned.id);
    const body = matching[0];
    for (const value of [planned.selected, planned.rationale, actual.implemented, actual.rationale])
      assert(Effect.pipe(body, EffectString.includes(value)));
    for (const alternative of planned.alternatives)
      assert(
        Effect.pipe(body, EffectString.includes(alternative.design)) &&
          Effect.pipe(body, EffectString.includes(alternative.tradeoffs)),
      );
  }
  const receiptPath = join(home, 'workflow-automations', 'native-v1', `${runId}.json.closeout.json`),
    receiptBytes = readFileSync(receiptPath);
  assert.equal(call({...common, action: 'closeout', command: 'inspect'}).closeout.state, 'complete');
  assert.equal(call({...common, action: 'closeout', command: 'finish'}).closeout.state, 'complete');
  assert(readFileSync(receiptPath).equals(receiptBytes));
  if (remote !== null)
    assert.equal(Effect.pipe(run(['git', '-C', remote, 'rev-parse', 'main']), EffectString.trim), remoteHead);
  assert(EffectArray.isArray(plan.decisions));
  if (profile === 'desktop') {
    const jobCommon = {protocolVersion: 1, executorVersion: 1, runId: 'extracted-job-smoke', generation};
    const jobStates = ['accepted', 'running', 'completed', 'failed', 'blocked-with-progress', 'stopped-with-progress'];
    const jobDocument = {
      format: 'threadnote-native-authoring',
      schemaVersion: 1,
      kind: 'spec',
      id: 'extracted-job-smoke',
      project: 'release-fixture',
      title: 'Extracted native job smoke',
      objective: 'Save and independently read a complete draft through the detached executable.',
      requirements: [{id: 'complete-read', behavior: 'Read the full saved document.'}],
      context: {codeRefs: [], evidenceRefs: [], note: 'Private source-free release fixture.'},
      source: null,
      sourceFreeReason: 'This isolated job tests native execution without source references.',
      actors: ['reader'],
      inScope: ['Save and read the complete draft.'],
      outOfScope: [],
      constraints: [],
      observations: [],
      scenarios: [
        {
          id: 'read-draft',
          requirementIds: ['complete-read'],
          given: 'A clean committed private repository.',
          when: 'The native worker saves a draft.',
          then: 'The complete document is independently readable.',
        },
      ],
      assumptions: [],
      questions: [],
      artifacts: [],
      review: {required: true, reason: 'Verify the extracted worker boundary.'},
    };
    const work = {
      ...jobCommon,
      action: 'authoring',
      command: 'save',
      document: jobDocument,
      ready: false,
      expectedRevision: null,
    };
    call(
      {...jobCommon, action: 'init', project: 'release-fixture', featureId: 'extracted-job-smoke', profile},
      undefined,
      ['ok'],
      65_536,
    );
    let jobId: string | undefined;
    let workerLock: string | undefined;
    try {
      const accepted = call({...jobCommon, action: 'job', command: 'submit', work}, undefined, ['accepted'], 65_536);
      assert.equal(accepted.status, 'accepted');
      jobId = accepted.jobId;
      assert.match(jobId!, /^job-[a-f0-9]{48}$/u);
      workerLock = join(
        home,
        'workflow-automations',
        'native-v1',
        'jobs',
        jobCommon.runId,
        jobId! + '.json.worker.lock',
      );
      let status = accepted;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && status.status !== 'completed') {
        if (['failed', 'blocked-with-progress', 'stopped-with-progress'].includes(status.status))
          throw new Error(`Extracted native worker stopped: ${JSON.stringify(status)}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        status = call({...jobCommon, action: 'job', command: 'status', jobId}, undefined, jobStates, 4096);
        assert.equal(status.jobId, jobId);
        assert(Buffer.byteLength(JSON.stringify(status)) < 4096);
      }
      assert.equal(status.status, 'completed', JSON.stringify(status));
      const result = call({...jobCommon, action: 'job', command: 'result', jobId}, undefined, ['completed'], 65_536);
      assert.equal(result.status, 'completed');
      assert.equal(result.jobId, jobId);
      assert.equal(result.result.status, 'ok');
      const root = result.result.authoring.root;
      assert(object(root) && typeof root.uri === 'string');
      const loaded = call(
        {...jobCommon, action: 'authoring', command: 'load', uri: root.uri, detail: 'document'},
        undefined,
        ['ok'],
        1_048_576,
      );
      assert.deepEqual(loaded.authoring.document, jobDocument);
      assert.deepEqual(loaded.authoring.root, root);
      const artifact = call({...jobCommon, action: 'read', uri: root.uri}, undefined, ['ok'], 1_048_576).artifact;
      assert.equal(artifact.uri, root.uri);
      assert.equal(artifact.revision, root.revision);
      const rootPayload = structuredDocument(artifact);
      assert.equal(rootPayload.format, 'threadnote-native-authoring-root');
      assert.equal(rootPayload.kind, jobDocument.kind);
      assert.equal(rootPayload.featureId, jobDocument.id);
      assert.equal(rootPayload.documentHash, result.result.authoring.documentHash);
      assert.equal(rootPayload.readiness, 'draft');
      assert(EffectString.startsWith(`# ${jobDocument.title}\n`)(artifact.body));
      const retry = call({...jobCommon, action: 'job', command: 'submit', work}, undefined, ['completed'], 65_536);
      assert.equal(retry.jobId, jobId);
      assert.equal(retry.status, 'completed');
      for (let attempt = 0; attempt < 40 && existsSync(workerLock); attempt++)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      assert.equal(existsSync(workerLock), false, 'Detached worker lock must be released');
    } catch (error) {
      if (jobId) {
        let active = workerLock !== undefined && existsSync(workerLock);
        try {
          const status = call({...jobCommon, action: 'job', command: 'status', jobId}, undefined, jobStates, 4096);
          active ||= status.status === 'accepted' || status.status === 'running';
        } catch {
          active = true;
        }
        if (active) {
          try {
            call(
              {...jobCommon, action: 'job', command: 'cancel', jobId},
              undefined,
              ['stopped-with-progress', 'completed'],
              4096,
            );
          } catch {
            /* Preserve the original smoke failure. */
          }
          save(join(fixture, 'active-job-fixture.json'), {jobId, workerLock, fixture});
        }
      }
      throw error;
    }
  }
  const summary = {
    status: 'passed',
    operations: records.length,
    fixture,
    privateHome: home,
    ownedDraftsArchived: ownedUris.length,
    unrelatedArtifactPreserved: true,
    completeDecisionReadback: plan.decisions.length,
    profile,
    specConfirmationAndBinding: true,
    profileBootstrap: remote === null ? 'not-applicable' : 'actual-cli',
    remoteReplayHeadUnchanged: remote !== null,
    publicationBackend: remote === null ? 'private-local' : 'local-bare-git',
    liveProviderAcceptance: false,
    finishReplayReceiptBytesUnchanged: true,
    sourceSha256: hash(sourceBytes),
  };
  save(join(fixture, 'summary.json'), summary);
  return summary;
}
