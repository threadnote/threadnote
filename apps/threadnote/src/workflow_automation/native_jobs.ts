import {Clock, Context, Crypto, Effect, FileSystem, Option, Path, PlatformError, Schema} from 'effect';
import {FileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {runBinaryCommandEffect, runCommandEffect, runDetachedCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {codeGraphFileContentHashMatchesBytes} from '@threadnote/graph/content_identity';
import {assertMemoryCodeCitation, type MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {decodeNativeAuthoringDocument, validateNativeAuthoring} from '@threadnote/workflow-automations/authoring';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {inspectWorkflowJournal, withWorkflowLock} from '../workflow_memory/journal.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {captureMemoryCodeCitationsForMcp} from '../mcp/memory_code_citation.js';
import {readNativeCycleTreeEntry, nativeCycleRelativePath} from './cycle_git.js';
import {readNativeWorkflowState} from './store.js';
import {nativeAuthoringRequestSchema} from './authoring_request_schema.js';
import {
  nativeCloseoutRequestSchema,
  readNativeCloseoutJobBasis,
  readNativeCloseoutJobEpoch,
} from './closeout_request_schema.js';
import type {NativeWorkflowState} from '@threadnote/workflow-automations/native';

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const witnessLimit = 4 * 1024 * 1024;
const receiptLimit = 64 * 1024;
const workerLockOptions = {
  createParentDirectory: false,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 300_000,
  waitTimeoutMilliseconds: 50,
  useCanonicalProcessStartIdentity: true,
} as const;

export const nativeJobRequestSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  executorVersion: Schema.Literal(1),
  action: Schema.Literal('job'),
  command: Schema.Literals(['submit', 'status', 'result', 'cancel', 'resume']),
  runId: id,
  generation: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  jobId: Schema.optionalKey(id),
  work: Schema.optionalKey(Schema.Unknown),
});
type Work = Readonly<Record<string, unknown>> & {
  readonly action: 'authoring' | 'closeout';
  readonly command: 'save' | 'prepare' | 'finish';
  readonly runId: string;
  readonly generation: string;
};

interface RetainedObject {
  readonly id: string;
  readonly type: 'commit' | 'tree' | 'blob';
  readonly sha256: string;
  readonly bytes: string;
}
interface RetainedFile {
  readonly path: string;
  readonly object: RetainedObject;
}
export interface NativeJobSourceView {
  readonly bindingId: string;
  readonly repo: string;
  readonly gitDir: string;
  readonly head: string;
  readonly tree: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly commitObject: RetainedObject;
  readonly treeObject: RetainedObject;
  readonly files: readonly RetainedFile[];
  readonly citations: readonly MemoryCodeCitationV1[];
  readonly citationRefs: readonly string[];
  readonly cycleDigest?: string;
  readonly closeoutTransactionId?: string;
  readonly closeoutAdmissionEpoch?: string;
  readonly targetRoot?: {readonly kind: 'spec' | 'plan'; readonly uri: string | null; readonly revision: string | null};
}

/** Present only while one admitted job replays its original immutable input. */
export const CurrentNativeJobSourceView = Context.Reference<NativeJobSourceView | undefined>(
  'threadnote/NativeJobSourceView',
  {defaultValue: () => undefined},
);
/** Set only around a ready authoring root's canonical lower write. */
export const CurrentNativeJobReadyPromotion = Context.Reference<boolean>('threadnote/NativeJobReadyPromotion', {
  defaultValue: () => false,
});
export const CurrentNativeJobBoundary = Context.Reference<
  | Effect.Effect<void, WorkflowAutomationError | PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>
  | undefined
>('threadnote/NativeJobBoundary', {defaultValue: () => undefined});
/** Test/embedded runner seam after all worker admission checks and before canonical dispatch. */
export const CurrentNativeJobBeforeDispatch = Context.Reference<Effect.Effect<void> | undefined>(
  'threadnote/NativeJobBeforeDispatch',
  {defaultValue: () => undefined},
);
/** Narrow deterministic test/embedded runner seam; normal CLI submissions launch the same executable. */
export const CurrentNativeJobAutoLaunch = Context.Reference<boolean>('threadnote/NativeJobAutoLaunch', {
  defaultValue: () => true,
});

const envelopeSchema = Schema.Struct({
  format: Schema.Literal('threadnote-native-job'),
  version: Schema.Literal(1),
  jobId: id,
  runId: id,
  generation: Schema.String,
  bindingId: hash,
  intentDigest: hash,
  witnessDigest: hash,
  status: Schema.Literals([
    'accepted',
    'running',
    'blocked-with-progress',
    'stopped-with-progress',
    'completed',
    'failed',
  ]),
  stopRequested: Schema.Boolean,
  started: Schema.Boolean,
  result: Schema.optionalKey(Schema.Unknown),
  code: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  updatedAt: Schema.Finite,
});
type Envelope = typeof envelopeSchema.Type;
const inputSchema = Schema.Struct({
  format: Schema.Literal('threadnote-native-job-input'),
  version: Schema.Literal(1),
  jobId: id,
  runId: id,
  generation: Schema.String,
  bindingId: hash,
  work: Schema.Unknown,
  witness: Schema.Unknown,
});
type JobInput = typeof inputSchema.Type;
type Dispatch<R> = (work: unknown) => Effect.Effect<unknown, WorkflowAutomationError, R>;

export function nativeJobId(bindingId: string, work: unknown, admissionEpoch?: string): string {
  return (
    'job-' + sha256HexSync(stableJson({bindingId, work, ...(admissionEpoch ? {admissionEpoch} : {})})).slice(0, 48)
  );
}

export function nativeJobStatus(
  envelope: Pick<
    Envelope,
    'jobId' | 'runId' | 'generation' | 'status' | 'stopRequested' | 'updatedAt' | 'code' | 'action'
  >,
) {
  return {
    protocolVersion: 1 as const,
    executorVersion: 1 as const,
    action: 'job' as const,
    jobId: envelope.jobId,
    runId: envelope.runId,
    generation: envelope.generation,
    status: envelope.status,
    stopRequested: envelope.stopRequested,
    updatedAt: envelope.updatedAt,
    ...(envelope.code ? {code: envelope.code} : {}),
    ...(envelope.action ? {nextAction: envelope.action} : {}),
  };
}

const decode = (value: unknown): Envelope =>
  Schema.decodeUnknownSync(envelopeSchema, {onExcessProperty: 'error'})(value);

const decodeInput = (value: unknown, receipt: Envelope): JobInput => {
  const input = Schema.decodeUnknownSync(inputSchema, {onExcessProperty: 'error'})(value);
  if (
    input.jobId !== receipt.jobId ||
    input.runId !== receipt.runId ||
    input.generation !== receipt.generation ||
    input.bindingId !== receipt.bindingId ||
    sha256HexSync(stableJson(input.work)) !== receipt.intentDigest ||
    sha256HexSync(stableJson(input.witness)) !== receipt.witnessDigest ||
    !validWitness(input.witness, receipt.bindingId)
  )
    throw fail('invalid-job-state', 'The exact private job request or source witness changed.');
  return input;
};

function validWitness(value: unknown, bindingId: string): value is NativeJobSourceView {
  if (!value || typeof value !== 'object') return false;
  const witness = value as Partial<NativeJobSourceView>;
  if (
    witness.bindingId !== bindingId ||
    !witness.repo ||
    !witness.gitDir ||
    !witness.head ||
    !objectId.test(witness.head) ||
    !witness.tree ||
    !objectId.test(witness.tree) ||
    !['sha1', 'sha256'].includes(witness.objectFormat ?? '') ||
    !Array.isArray(witness.files) ||
    !Array.isArray(witness.citations) ||
    !Array.isArray(witness.citationRefs)
  )
    return false;
  const objects = [witness.commitObject, witness.treeObject, ...witness.files.map(file => file.object)];
  if (
    objects.some(object => {
      if (
        !object ||
        !objectId.test(object.id) ||
        !/^[a-f0-9]{64}$/u.test(object.sha256) ||
        typeof object.bytes !== 'string'
      )
        return true;
      const bytes = Buffer.from(object.bytes, 'base64');
      return (
        bytes.toString('base64') !== object.bytes ||
        sha256HexSync(bytes) !== object.sha256 ||
        new Bun.CryptoHasher(witness.objectFormat!)
          .update(`${object.type} ${bytes.length}\0`)
          .update(bytes)
          .digest('hex') !== object.id
      );
    })
  )
    return false;
  if (
    witness.commitObject?.id !== witness.head ||
    witness.commitObject?.type !== 'commit' ||
    witness.treeObject?.id !== witness.tree ||
    witness.treeObject?.type !== 'tree'
  )
    return false;
  if (witness.files.some(file => !nativeCycleRelativePath(file.path) || file.object.type !== 'blob')) return false;
  if (witness.cycleDigest !== undefined && !/^[a-f0-9]{64}$/u.test(witness.cycleDigest)) return false;
  if (witness.closeoutTransactionId !== undefined && !/^[a-f0-9]{64}$/u.test(witness.closeoutTransactionId))
    return false;
  if (witness.closeoutAdmissionEpoch !== undefined && !/^[a-f0-9]{64}$/u.test(witness.closeoutAdmissionEpoch))
    return false;
  if (
    witness.targetRoot &&
    (!['spec', 'plan'].includes(witness.targetRoot.kind) ||
      (witness.targetRoot.uri !== null && !witness.targetRoot.uri.startsWith('threadnote://')) ||
      (witness.targetRoot.revision !== null && !/^[a-f0-9]{64}$/u.test(witness.targetRoot.revision)))
  )
    return false;
  if (!Buffer.from(witness.commitObject.bytes, 'base64').toString('utf8').startsWith(`tree ${witness.tree}\n`))
    return false;
  if (
    witness.citations.some(citation => {
      const file = witness.files!.find(item => item.path === citation.path);
      return (
        !file ||
        citation.sourceCommit !== witness.head ||
        citation.sourceDirty ||
        citation.evidenceRetention !== 'capsule-retained' ||
        !codeGraphFileContentHashMatchesBytes(
          citation.fileContentHash.value,
          witness.objectFormat!,
          Buffer.from(file.object.bytes, 'base64'),
        )
      );
    })
  )
    return false;
  try {
    witness.citations.forEach(assertMemoryCodeCitation);
  } catch {
    return false;
  }
  return true;
}

const jobPath = Effect.fn('nativeJobs.path')(function* (
  config: RuntimeConfig,
  runId: string,
  jobId: string,
  create = false,
) {
  if (!Schema.is(id)(runId) || !Schema.is(id)(jobId) || runId.includes('..') || jobId.includes('..'))
    return yield* fail('invalid-request', 'Use bounded portable native job identifiers.');
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(config.agentContextHome);
  let directory = home;
  for (const part of ['workflow-automations', 'native-v1', 'jobs', runId]) {
    directory = path.join(directory, part);
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)))
      return yield* fail('unsafe-job-state', 'Job state directories cannot be symbolic links.');
    if (!(yield* fs.exists(directory))) {
      if (!create) return undefined;
      yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
    }
    if ((yield* fs.stat(directory)).type !== 'Directory' || (yield* fs.realPath(directory)) !== directory)
      return yield* fail('unsafe-job-state', 'Job state must remain in its original private directory.');
  }
  return path.join(directory, jobId + '.json');
});

const readAt = Effect.fn('nativeJobs.readAt')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
    return yield* fail('unsafe-job-state', 'Job state cannot be a symbolic link.');
  if (!(yield* fs.exists(file))) return undefined;
  const stat = yield* fs.stat(file);
  if (stat.type !== 'File' || Number(stat.size) > receiptLimit)
    return yield* fail('invalid-job-state', 'Job state exceeds its fixed byte limit.');
  const bytes = yield* fs.readFileString(file);
  if (Buffer.byteLength(bytes) > receiptLimit)
    return yield* fail('invalid-job-state', 'Job state exceeds its fixed byte limit.');
  const state = yield* Effect.try({
    try: () => decode(JSON.parse(bytes) as unknown),
    catch: () => fail('invalid-job-state', 'Job state is corrupt; its bytes were preserved.'),
  });
  return {state, revision: sha256HexSync(bytes)};
});

const read = Effect.fn('nativeJobs.read')(function* (config: RuntimeConfig, runId: string, jobId: string) {
  const file = yield* jobPath(config, runId, jobId);
  return file === undefined ? undefined : yield* readAt(file);
});

/** Immutable admission bytes are separate from the small status receipt. */
const readInput = Effect.fn('nativeJobs.readInput')(function* (config: RuntimeConfig, receipt: Envelope) {
  const file = yield* jobPath(config, receipt.runId, receipt.jobId);
  if (!file) return yield* fail('job-not-found', 'The original job input is missing.');
  const fs = yield* FileSystem.FileSystem;
  const inputFile = file + '.input.json';
  if (Option.isSome(yield* fs.readLink(inputFile).pipe(Effect.option)) || !(yield* fs.exists(inputFile)))
    return yield* fail('invalid-job-state', 'The immutable admitted input is missing or unsafe.');
  const stat = yield* fs.stat(inputFile);
  if (stat.type !== 'File' || Number(stat.size) > witnessLimit)
    return yield* fail('invalid-job-state', 'The immutable admitted input exceeds its 4 MiB limit.');
  const bytes = yield* fs.readFileString(inputFile);
  if (Buffer.byteLength(bytes) > witnessLimit)
    return yield* fail('invalid-job-state', 'The immutable admitted input exceeds its 4 MiB limit.');
  return yield* Effect.try({
    try: () => decodeInput(JSON.parse(bytes) as unknown, receipt),
    catch: () => fail('invalid-job-state', 'The exact admitted input failed independent readback.'),
  });
});

const writeInput = Effect.fn('nativeJobs.writeInput')(function* (
  config: RuntimeConfig,
  receipt: Envelope,
  input: JobInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = (yield* jobPath(config, receipt.runId, receipt.jobId, true))!;
  const inputFile = file + '.input.json';
  const serialized = stableJson(decodeInput(input, receipt)) + '\n';
  if (Buffer.byteLength(serialized) > witnessLimit)
    return yield* fail('job-capability', 'The exact request and source witness exceed the 4 MiB background limit.');
  if (yield* fs.exists(inputFile)) {
    const old = yield* readInput(config, receipt);
    if (stableJson(old) !== stableJson(input))
      return yield* fail('job-intent-conflict', 'This job identity already retains different immutable input.');
    return;
  }
  const temporary = inputFile + '.' + (yield* (yield* Crypto.Crypto).randomUUIDv4()) + '.tmp';
  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, serialized, {mode: 0o600, flag: 'wx'});
    if ((yield* jobPath(config, receipt.runId, receipt.jobId)) !== file || (yield* fs.exists(inputFile)))
      return yield* fail('job-conflict', 'Job input path changed before durable admission.');
    yield* fs.rename(temporary, inputFile);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
  yield* readInput(config, receipt);
});

const write = Effect.fn('nativeJobs.write')(function* (
  config: RuntimeConfig,
  state: Envelope,
  expected: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = (yield* jobPath(config, state.runId, state.jobId, true))!;
  const serialized = stableJson(decode(state)) + '\n';
  if (Buffer.byteLength(serialized) > receiptLimit)
    return yield* fail('job-capacity', 'Job receipt exceeds its fixed byte limit.');
  const temporary = file + '.' + (yield* (yield* Crypto.Crypto).randomUUIDv4()) + '.tmp';
  return yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, serialized, {mode: 0o600, flag: 'wx'});
    const previous = yield* readAt(file);
    if ((previous?.revision ?? null) !== expected)
      return yield* fail('job-conflict', 'Job receipt changed; retry from current status.');
    if ((yield* jobPath(config, state.runId, state.jobId)) !== file)
      return yield* fail('unsafe-job-state', 'Job receipt path changed before commit.');
    yield* fs.rename(temporary, file);
    return {state, revision: sha256HexSync(serialized)};
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

const withJobLock = <A, E, R>(
  config: RuntimeConfig,
  runId: string,
  jobId: string,
  create: boolean,
  program: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* jobPath(config, runId, jobId, create);
    if (!file) return yield* fail('job-not-found', 'No accepted job has this identity.');
    return yield* withExclusiveFileLock(
      fs,
      file + '.lock',
      {
        createParentDirectory: false,
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 300_000,
        waitTimeoutMilliseconds: 2_000,
        useCanonicalProcessStartIdentity: true,
      },
      program,
    ).pipe(
      Effect.catchIf(Schema.is(FileLockTimeout), () =>
        Effect.fail(fail('job-busy', 'Another process is updating this job.')),
      ),
    );
  });

const gitText = (repo: string, args: readonly string[]) =>
  runCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args], {timeoutMs: 30_000, maxOutputBytes: 4096}).pipe(
    Effect.map(result => result.stdout.trim()),
  );

const retainObject = Effect.fn('nativeJobs.retainObject')(function* (
  repo: string,
  type: RetainedObject['type'],
  id: string,
) {
  const binary = yield* runBinaryCommandEffect('git', ['--no-optional-locks', '-C', repo, 'cat-file', type, id], {
    timeoutMs: 30_000,
    maxOutputBytes: witnessLimit,
  });
  const actual = yield* runBinaryCommandEffect(
    'git',
    ['--no-optional-locks', '-C', repo, 'hash-object', '-t', type, '--stdin'],
    {input: binary.stdout, timeoutMs: 30_000, maxOutputBytes: 4096},
  );
  if (new TextDecoder().decode(actual.stdout).trim() !== id)
    return yield* fail('source-drift', 'A retained Git object changed during admission.');
  return {id, type, sha256: sha256HexSync(binary.stdout), bytes: Buffer.from(binary.stdout).toString('base64')};
});

const parseWork = (value: unknown, runId: string, generation: string): Work => {
  if (!value || typeof value !== 'object')
    throw fail('invalid-request', 'Submit one exact authoring save or closeout prepare/finish request.');
  const candidate = value as Partial<Work>;
  if (candidate.runId !== runId || candidate.generation !== generation)
    throw fail('job-capability', 'Nested work must preserve the admitted run and generation.');
  if (candidate.action === 'authoring' && candidate.command === 'save') {
    const work = Schema.decodeUnknownSync(nativeAuthoringRequestSchema, {onExcessProperty: 'error'})(value);
    if (!work.document) throw fail('invalid-request', 'Authoring save requires its exact document.');
    const document = decodeNativeAuthoringDocument(work.document);
    if (work.ready && !validateNativeAuthoring(document, work).ready)
      throw fail('job-capability', 'Ready background authoring requires the exact reviewed and confirmed document.');
    return work as Work;
  }
  if (candidate.action === 'closeout' && (candidate.command === 'prepare' || candidate.command === 'finish')) {
    const work = Schema.decodeUnknownSync(nativeCloseoutRequestSchema, {onExcessProperty: 'error'})(value);
    if (work.command === 'prepare' && !work.proposal)
      throw fail('invalid-request', 'Closeout prepare requires its exact proposal.');
    if (work.command === 'finish' && (work.proposal !== undefined || work.expectedRevision !== undefined))
      throw fail(
        'job-capability',
        'Background finish uses the already prepared transaction without a new proposal or revision override.',
      );
    return work as Work;
  }
  throw fail('job-capability', 'Background jobs support exact authoring save or closeout prepare/finish only.');
};

const captureWitness = Effect.fn('nativeJobs.captureWitness')(function* (
  config: RuntimeConfig,
  state: NativeWorkflowState,
  repo: string,
  project: string,
  work: Work,
  admissionEpoch?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(repo);
  const firstHead = yield* gitText(root, ['rev-parse', '--verify', 'HEAD']);
  const tree = yield* gitText(root, ['rev-parse', '--verify', 'HEAD^{tree}']);
  const objectFormat = yield* gitText(root, ['rev-parse', '--show-object-format']);
  const gitDir = yield* gitText(root, ['rev-parse', '--absolute-git-dir']);
  const dirty = yield* gitText(root, ['status', '--porcelain=v2', '-z', '--ignore-submodules=none']);
  if (
    dirty.length ||
    !objectId.test(firstHead) ||
    !objectId.test(tree) ||
    (objectFormat !== 'sha1' && objectFormat !== 'sha256')
  )
    return yield* fail(
      'job-capability',
      'Background admission requires a clean committed original checkout. Use synchronous workflow execution for unsupported source.',
    );
  const document =
    work.action === 'authoring'
      ? yield* Effect.try({
          try: () => decodeNativeAuthoringDocument(work.document),
          catch: () => fail('invalid-request', 'The submitted authoring document is malformed.'),
        })
      : undefined;
  const closeout =
    work.action === 'closeout' && work.command === 'finish'
      ? yield* readNativeCloseoutJobBasis(config, work.runId, work.generation)
      : undefined;
  if (document?.source && document.source.head !== firstHead)
    return yield* fail('source-drift', 'The authoring document names a different original committed HEAD.');
  if (
    closeout &&
    (closeout.bindingId !== state.bindingId ||
      closeout.source.repo !== root ||
      closeout.source.head !== firstHead ||
      closeout.source.tree !== tree)
  )
    return yield* fail('job-source-drift', 'The prepared closeout transaction has a different original source.');
  const codeRefs =
    work.action === 'authoring'
      ? document!.context.codeRefs
      : (closeout?.codeRefs ??
        (work.proposal as {architecture?: {codeRefs?: readonly string[]}} | undefined)?.architecture?.codeRefs ??
        []);
  if (codeRefs.some(ref => ref.startsWith('cgr_')))
    return yield* fail(
      'job-capability',
      'Qualified or cross-repository citations are unsupported for background admission.',
    );
  const captured = yield* captureMemoryCodeCitationsForMcp(
    config,
    {callerCwd: root, project, refs: codeRefs},
    'workflow-job',
  );
  if (!captured.ok)
    return yield* fail('job-capability', 'Exact current citation evidence could not be retained before acceptance.');
  const citations = captured.citations;
  if (
    citations.some(
      citation =>
        citation.sourceCommit !== firstHead ||
        citation.sourceDirty ||
        citation.evidenceRetention !== 'capsule-retained',
    )
  )
    return yield* fail('job-capability', 'Background citations require retained exact clean source evidence.');
  const paths = [
    ...new Set([
      ...(document?.source?.files.map(file => file.path) ?? []),
      ...citations.map(citation => citation.path),
    ]),
  ];
  const files: RetainedFile[] = [];
  for (const path of paths) {
    if (!nativeCycleRelativePath(path))
      return yield* fail('job-capability', 'Unsupported source path in background witness.');
    const entry = yield* readNativeCycleTreeEntry(root, tree, path);
    if (!['100644', '100755'].includes(entry.mode) || !objectId.test(entry.blob))
      return yield* fail('job-capability', 'Background source requires committed regular files.');
    const object = yield* retainObject(root, 'blob', entry.blob);
    const bytes = Buffer.from(object.bytes, 'base64');
    const expected = document?.source?.files.find(file => file.path === path);
    if (
      (expected && expected.sha256 !== sha256HexSync(bytes)) ||
      citations.some(
        citation =>
          citation.path === path &&
          !codeGraphFileContentHashMatchesBytes(citation.fileContentHash.value, objectFormat, bytes),
      )
    )
      return yield* fail('source-drift', 'Committed source differs from its original authoring or citation proof.');
    files.push({path, object});
  }
  const witness: NativeJobSourceView = {
    bindingId: state.bindingId,
    repo: root,
    gitDir,
    head: firstHead,
    tree,
    objectFormat,
    commitObject: yield* retainObject(root, 'commit', firstHead),
    treeObject: yield* retainObject(root, 'tree', tree),
    files,
    citations,
    citationRefs: codeRefs,
    ...(state.cycle ? {cycleDigest: sha256HexSync(stableJson(state.cycle.state))} : {}),
    ...(closeout ? {closeoutTransactionId: closeout.transactionId} : {}),
    ...(admissionEpoch ? {closeoutAdmissionEpoch: admissionEpoch} : {}),
    ...(document
      ? {
          targetRoot: (() => {
            const root = [...state.operations]
              .reverse()
              .find(
                item => item.status === 'verified' && item.intent.artifactKey === 'author-root-' + document.kind,
              )?.artifact;
            return {kind: document.kind, uri: root?.uri ?? null, revision: root?.revision ?? null};
          })(),
        }
      : {}),
  };
  if (Buffer.byteLength(stableJson(witness)) > witnessLimit)
    return yield* fail('job-capability', 'The exact source and citation witness exceeds the 4 MiB background limit.');
  yield* assertNativeJobLiveSource(witness);
  return witness;
});

/** Call at the actual canonical promotion write and after independent readback. */
export const assertNativeJobLiveSource = Effect.fn('nativeJobs.assertLiveSource')(function* (
  view: NativeJobSourceView,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(view.repo);
  const gitDir = yield* gitText(root, ['rev-parse', '--absolute-git-dir']);
  const head = yield* gitText(root, ['rev-parse', '--verify', 'HEAD']);
  const tree = yield* gitText(root, ['rev-parse', '--verify', 'HEAD^{tree}']);
  const dirty = yield* gitText(root, ['status', '--porcelain=v2', '-z', '--ignore-submodules=none']);
  if (root !== view.repo || gitDir !== view.gitDir || head !== view.head || tree !== view.tree || dirty.length)
    return yield* fail(
      'job-source-drift',
      'The original checkout HEAD, tree or worktree changed; reconcile and re-review this job.',
    );
});

const launch = Effect.fn('nativeJobs.launch')(function* (config: RuntimeConfig, runId: string, jobId: string) {
  const system = yield* SystemInfo;
  const executable = system.executablePath;
  const name = executable.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
  const args = [
    ...(name === 'bun' || name === 'bun.exe' ? [system.developmentEntrypoint] : []),
    'workflow-automation',
    'job-worker',
    '--run-id',
    runId,
    '--job-id',
    jobId,
  ];
  const started = yield* runDetachedCommandEffect(executable, args, {
    env: {...system.environment(), THREADNOTE_HOME: config.agentContextHome, THREADNOTE_MANIFEST: config.manifestPath},
  });
  if (!started)
    return yield* fail(
      'job-startup-failed',
      'The admitted job remains durable; resume it after the worker is available.',
    );
});

const launchOrReport = Effect.fn('nativeJobs.launchOrReport')(function* (
  config: RuntimeConfig,
  runId: string,
  jobId: string,
  accepted: Envelope,
) {
  if (!(yield* CurrentNativeJobAutoLaunch)) return nativeJobStatus(accepted);
  const started = yield* Effect.result(launch(config, runId, jobId));
  if (started._tag === 'Success') return nativeJobStatus(accepted);
  const failed = yield* transition(config, runId, jobId, state => ({
    ...state,
    status: 'failed',
    code: 'job-startup-failed',
    action: 'The exact job remains accepted; resume this same identity after the worker is available.',
    updatedAt: Date.now(),
  }));
  return nativeJobStatus(failed.state);
});

const transition = Effect.fn('nativeJobs.transition')(function* (
  config: RuntimeConfig,
  runId: string,
  jobId: string,
  change: (state: Envelope) => Envelope,
) {
  return yield* withJobLock(
    config,
    runId,
    jobId,
    false,
    Effect.gen(function* () {
      const current = yield* read(config, runId, jobId);
      if (!current) return yield* fail('job-not-found', 'No accepted job has this identity.');
      const next = change(current.state);
      return yield* write(config, next, current.revision);
    }),
  );
});

export const runNativeJobWorker = Effect.fn('nativeJobs.worker')(function* <R>(
  config: RuntimeConfig,
  runId: string,
  jobId: string,
  dispatch: Dispatch<R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* jobPath(config, runId, jobId);
  if (!file) return yield* fail('job-not-found', 'No accepted job has this identity.');
  return yield* withExclusiveFileLock(
    fs,
    file + '.worker.lock',
    workerLockOptions,
    Effect.gen(function* () {
      let current = yield* read(config, runId, jobId);
      if (!current) return yield* fail('job-not-found', 'No accepted job has this identity.');
      if (current.state.status === 'completed') return nativeJobStatus(current.state);
      if (current.state.stopRequested) {
        current = yield* transition(config, runId, jobId, state => ({...state, status: 'stopped-with-progress'}));
        return nativeJobStatus(current.state);
      }
      const loaded = yield* Effect.result(readInput(config, current.state));
      if (loaded._tag === 'Failure') {
        current = yield* transition(config, runId, jobId, state => ({
          ...state,
          status: 'failed',
          code: 'invalid-job-state',
          action: 'Restore the exact immutable admitted input before resuming this job.',
          updatedAt: Date.now(),
        }));
        return nativeJobStatus(current.state);
      }
      const input = loaded.success;
      const view = input.witness as NativeJobSourceView;
      const firstStart = !current.state.started;
      current = yield* transition(config, runId, jobId, state => ({
        ...state,
        status: 'running',
        started: true,
        updatedAt: Date.now(),
      }));
      const boundary = Effect.gen(function* () {
        const latest = yield* read(config, runId, jobId);
        if (!latest || latest.state.stopRequested)
          return yield* fail('job-stopped', 'Cancellation was requested at a canonical child boundary.');
      });
      const generation = current.state.generation;
      let workAction: Work['action'] | undefined;
      const execute = Effect.gen(function* () {
        const work = yield* Effect.try({
          try: () => parseWork(input.work, runId, generation),
          catch: error =>
            Schema.is(WorkflowAutomationError)(error)
              ? error
              : fail('invalid-job-state', 'The admitted nested request is invalid.'),
        });
        workAction = work.action;
        const controller = yield* readNativeWorkflowState(config, runId);
        if (
          !controller ||
          controller.state.bindingId !== view.bindingId ||
          controller.state.generation !== generation ||
          (view.cycleDigest && sha256HexSync(stableJson(controller.state.cycle?.state)) !== view.cycleDigest)
        )
          return yield* fail('job-controller-drift', 'The admitted run binding, generation or pinned cycle changed.');
        if (view.targetRoot && firstStart) {
          const root = [...controller.state.operations]
            .reverse()
            .find(
              item => item.status === 'verified' && item.intent.artifactKey === 'author-root-' + view.targetRoot!.kind,
            )?.artifact;
          if ((root?.uri ?? null) !== view.targetRoot.uri || (root?.revision ?? null) !== view.targetRoot.revision)
            return yield* fail('job-target-drift', 'The authoring target changed before this job began.');
        }
        yield* boundary;
        if (work.action === 'closeout' && work.command === 'finish') {
          const basis = yield* readNativeCloseoutJobBasis(config, runId, generation);
          if (
            basis.transactionId !== view.closeoutTransactionId ||
            basis.admissionEpoch !== view.closeoutAdmissionEpoch ||
            basis.bindingId !== view.bindingId ||
            basis.source.repo !== view.repo ||
            basis.source.head !== view.head ||
            basis.source.tree !== view.tree ||
            stableJson(basis.codeRefs) !== stableJson(view.citationRefs)
          )
            return yield* fail('job-closeout-drift', 'The prepared closeout transaction changed since admission.');
        }
        if (work.action === 'closeout') {
          const epoch = yield* readNativeCloseoutJobEpoch(
            config,
            runId,
            generation,
            work.command as 'prepare' | 'finish',
          );
          if (epoch !== view.closeoutAdmissionEpoch)
            return yield* fail('job-closeout-drift', 'The closeout admission changed since this job was accepted.');
        }
        const beforeDispatch = yield* CurrentNativeJobBeforeDispatch;
        if (beforeDispatch) yield* beforeDispatch;
        const prepared = yield* dispatch(work);
        // A historical draft may materialize from the admitted witness, but
        // changed live source never makes the overall job completed in v1.
        yield* assertNativeJobLiveSource(view);
        return prepared;
      }).pipe(
        Effect.provideService(CurrentNativeJobSourceView, view),
        Effect.provideService(CurrentNativeJobBoundary, boundary),
      );
      const result = yield* Effect.result(execute);
      if (result._tag === 'Success') {
        const serialized = stableJson(result.success);
        if (Buffer.byteLength(serialized) > 32_768) {
          current = yield* transition(config, runId, jobId, state => {
            const {code: _code, ...rest} = state;
            return {
              ...rest,
              status: 'completed',
              stopRequested: false,
              result: {status: 'ok', resultOmitted: true},
              action:
                workAction === 'closeout'
                  ? 'The exact closeout command completed; inspect its original transaction and canonical outputs.'
                  : 'The canonical authoring work completed; load its verified root to read the complete document.',
              updatedAt: Date.now(),
            };
          });
          return nativeJobStatus(current.state);
        }
        current = yield* transition(config, runId, jobId, state => {
          const {code: _code, action: _action, ...rest} = state;
          return {...rest, status: 'completed', stopRequested: false, result: result.success, updatedAt: Date.now()};
        });
      } else {
        const error = result.failure;
        const code = Schema.is(WorkflowAutomationError)(error) ? error.code : 'job-failed';
        const stop = code === 'job-stopped';
        const blocked = /drift|conflict|approval|source|evidence|publication|busy/u.test(code);
        current = yield* transition(config, runId, jobId, state => ({
          ...state,
          status: stop ? 'stopped-with-progress' : blocked ? 'blocked-with-progress' : 'failed',
          code,
          action: stop
            ? 'Resume this exact job after reviewing partial receipts.'
            : blocked
              ? 'Reconcile the original source, authority and canonical receipts; re-review before same-intent resume.'
              : 'Inspect canonical receipts and retry this exact job only after resolving the failure.',
          updatedAt: Date.now(),
        }));
      }
      return nativeJobStatus(current.state);
    }).pipe(
      Effect.catchIf(Schema.is(FileLockTimeout), () =>
        Effect.fail(fail('job-busy', 'The original worker still owns this job.')),
      ),
    ),
  );
});

export const runNativeJob = Effect.fn('nativeJobs.dispatch')(function* <R>(
  config: RuntimeConfig,
  input: unknown,
  dispatch: Dispatch<R>,
) {
  const request = yield* Schema.decodeUnknownEffect(nativeJobRequestSchema, {onExcessProperty: 'error'})(input).pipe(
    Effect.mapError(() => fail('invalid-request', 'Provide a bounded native job request.')),
  );
  if (request.command === 'submit') {
    const work = yield* Effect.try({
      try: () => parseWork(request.work, request.runId, request.generation),
      catch: error =>
        Schema.is(WorkflowAutomationError)(error)
          ? error
          : fail('invalid-request', 'Nested work must be one exact supported canonical request.'),
    });
    yield* dispatch({
      protocolVersion: 1,
      executorVersion: 1,
      action: 'inspect',
      runId: request.runId,
      generation: request.generation,
    });
    const stored = yield* readNativeWorkflowState(config, request.runId);
    if (!stored || stored.state.generation !== request.generation)
      return yield* fail('binding-drift', 'The original native run or generation changed.');
    const admissionEpoch =
      work.action === 'closeout'
        ? yield* readNativeCloseoutJobEpoch(
            config,
            request.runId,
            request.generation,
            work.command as 'prepare' | 'finish',
          )
        : undefined;
    const jobId = nativeJobId(stored.state.bindingId, work, admissionEpoch);
    if (request.jobId !== undefined && request.jobId !== jobId)
      return yield* fail('job-identity-conflict', 'Submit must use the one derived identity for this exact work.');
    const existing = yield* read(config, request.runId, jobId);
    const digest = sha256HexSync(stableJson(work));
    if (existing) {
      if (existing.state.intentDigest !== digest)
        return yield* fail('job-intent-conflict', 'This job identity belongs to a different exact request.');
      yield* readInput(config, existing.state);
      return nativeJobStatus(existing.state);
    }
    const journal = yield* withWorkflowLock(
      config,
      stored.state.bindingId,
      inspectWorkflowJournal(config, stored.state.bindingId),
    );
    if (
      journal.state.binding.bindingId !== stored.state.bindingId ||
      journal.state.binding.repo !== (yield* (yield* FileSystem.FileSystem).realPath(journal.state.binding.repo))
    )
      return yield* fail('binding-drift', 'The original logical repository binding changed.');
    const witness = yield* captureWitness(
      config,
      stored.state,
      journal.state.binding.repo,
      journal.state.binding.project,
      work,
      admissionEpoch,
    );
    const now = yield* Clock.currentTimeMillis;
    const envelope: Envelope = {
      format: 'threadnote-native-job',
      version: 1,
      jobId,
      runId: request.runId,
      generation: request.generation,
      bindingId: stored.state.bindingId,
      intentDigest: digest,
      witnessDigest: sha256HexSync(stableJson(witness)),
      status: 'accepted',
      stopRequested: false,
      started: false,
      updatedAt: now,
    };
    const jobInput: JobInput = {
      format: 'threadnote-native-job-input',
      version: 1,
      jobId,
      runId: request.runId,
      generation: request.generation,
      bindingId: stored.state.bindingId,
      work,
      witness,
    };
    const accepted = yield* withJobLock(
      config,
      request.runId,
      jobId,
      true,
      Effect.gen(function* () {
        const raced = yield* read(config, request.runId, jobId);
        if (raced) {
          if (raced.state.intentDigest !== digest)
            return yield* fail('job-intent-conflict', 'This job identity belongs to another exact request.');
          yield* readInput(config, raced.state);
          return raced;
        }
        yield* writeInput(config, envelope, jobInput);
        yield* assertNativeJobLiveSource(witness);
        const written = yield* write(config, envelope, null);
        const readback = yield* read(config, request.runId, jobId);
        if (!readback || readback.revision !== written.revision)
          return yield* fail('job-readback', 'Accepted receipt failed independent readback.');
        yield* readInput(config, readback.state);
        return readback;
      }),
    );
    return yield* launchOrReport(config, request.runId, jobId, accepted.state);
  }
  if (!request.jobId) return yield* fail('invalid-request', 'Provide the accepted jobId.');
  const stored = yield* read(config, request.runId, request.jobId);
  if (!stored || stored.state.generation !== request.generation)
    return yield* fail('job-not-found', 'No accepted job has this run and generation.');
  if (request.command === 'status') return nativeJobStatus(stored.state);
  if (request.command === 'result') {
    return {
      ...nativeJobStatus(stored.state),
      ...(stored.state.status === 'completed' ? {result: stored.state.result} : {}),
    };
  }
  if (request.command === 'cancel') {
    const changed = yield* transition(config, request.runId, request.jobId, state =>
      state.status === 'completed' ? state : {...state, stopRequested: true, updatedAt: Date.now()},
    );
    return nativeJobStatus(changed.state);
  }
  if (request.work !== undefined)
    return yield* fail('invalid-request', 'Resume uses the original durably admitted request.');
  const jobId = request.jobId;
  const file = yield* jobPath(config, request.runId, jobId);
  if (!file) return yield* fail('job-not-found', 'No accepted job has this identity.');
  const fs = yield* FileSystem.FileSystem;
  const resumed = yield* withExclusiveFileLock(
    fs,
    file + '.worker.lock',
    workerLockOptions,
    transition(config, request.runId, jobId, state =>
      state.status === 'completed'
        ? state
        : {...state, stopRequested: false, status: 'accepted', updatedAt: Date.now()},
    ).pipe(Effect.map(reopened => ({reopened, active: false}))),
  ).pipe(
    Effect.catchIf(Schema.is(FileLockTimeout), () =>
      read(config, request.runId, jobId).pipe(
        Effect.flatMap(current =>
          current
            ? Effect.succeed({reopened: current, active: true})
            : Effect.fail(fail('job-not-found', 'No accepted job has this identity.')),
        ),
      ),
    ),
  );
  const reopened = resumed.reopened;
  if (resumed.active || reopened.state.status === 'completed') return nativeJobStatus(reopened.state);
  return yield* launchOrReport(config, request.runId, jobId, reopened.state);
});
