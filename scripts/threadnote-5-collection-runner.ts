import {Predicate} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Private release engineering coordinates bounded OS processes and retained artifacts. */
import {chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {
  collectionTrialIdentity,
  nativePointer,
  parseThreadnote5CollectionPlan,
  relativeFile,
  THREADNOTE_5_COLLECTION_MATRIX,
  threadnote5CollectionPlanHash,
  type CollectionRecipe,
  type CollectionSurface,
  type Threadnote5CollectionPlan,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-collection';
import {
  captureThreadnote5ReleaseCandidateV1,
  type Threadnote5ScenarioRuntimeBoundaryV1,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-capture';
import {
  assertUniqueNativeIdentities,
  deriveThreadnote5PrivateCollection,
  verifyThreadnote5PrivateCollection,
  verifyThreadnote5CollectionAuthorityBinding,
  type PrivateCollection,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-collection-envelope';
import {
  CollectionMcpTransport,
  createCollectionVerifiedLaunch,
  observeVerifiedCollectionRuntime,
  runVerifiedCollectionProcess,
  type CollectionVerifiedLaunch,
} from './threadnote-5-collection-transport.js';
import {
  COLLECTION_MAX_BYTES,
  collectionCleanupIsUnsafe,
  collectionEnvironment,
  ownCollectionProcess,
  readCollectionPayloadIdentity,
  runCollectionProcess,
} from './threadnote-5-collection-process.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export {assertUniqueNativeIdentities};
export type {PrivateCollection};

const COLLECTION_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;

export class CollectionCaptureBudget {
  private used = 0;

  constructor(readonly maximumBytes = COLLECTION_TRANSCRIPT_MAX_BYTES) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
      throw new Error('Invalid private transcript retention bound.');
  }

  get usedBytes(): number {
    return this.used;
  }

  get remainingBytes(): number {
    return this.maximumBytes - this.used;
  }

  consume(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remainingBytes)
      throw new Error('Private transcripts exceed the retention bound.');
    this.used += bytes;
  }
}

export function previewThreadnote5Collection(value: unknown) {
  const plan = parseThreadnote5CollectionPlan(value);
  return {
    version: 1,
    planHash: threadnote5CollectionPlanHash(plan),
    candidate: plan.candidate,
    scenarioCount: 15,
    sourceRecordCount: 24,
    retentionHours: plan.retentionHours,
    externalAuthorityRequired: true,
    scenarios: EffectArray.map(plan.recipes, recipe => ({
      scenario: recipe.scenario,
      trials: trialCount(plan, recipe),
      stepCount: recipe.steps.length,
      mutations: EffectArray.map(
        EffectArray.filter(recipe.steps, step => step.type === 'write' || step.type === 'cli' || step.type === 'mcp'),
        step => step.id,
      ),
    })),
  };
}

/** Collects private observations only. They become evidence only after independent authority and source replay. */
export async function collectThreadnote5Candidate(input: {
  readonly plan: unknown;
  readonly approvedPlanHash: string;
  readonly executable: string;
  readonly privateOutput: string;
}): Promise<PrivateCollection> {
  const plan = parseThreadnote5CollectionPlan(input.plan);
  const planHash = threadnote5CollectionPlanHash(plan);
  if (input.approvedPlanHash !== planHash)
    throw new Error('Collection requires approval of the exact previewed plan hash.');
  const installedPayload = await readCollectionPayloadIdentity(input.executable);
  if (installedPayload.executableSha256 !== plan.candidate.executableSha256)
    throw new Error('Installed payload digest mismatch.');
  return await atomicDirectory(input.privateOutput, async root => {
    await writePrivate(resolve(root, 'retention.json'), {
      version: 1,
      createdAt: new Date().toISOString(),
      deleteAfter: new Date(Date.now() + plan.retentionHours * 3600000).toISOString(),
      policy:
        'private-local-only; delete the directory reference and its private target by deleteAfter after confirming process quiescence; never publish raw sources, homes, or transcripts',
    });
    await mkdir(resolve(root, 'identity-home'), {mode: 0o700});
    await mkdir(resolve(root, 'identity-home', 'tmp'), {mode: 0o700});
    const env = collectionEnvironment(root, resolve(root, 'identity-home'));
    const executable = resolve(root, 'candidate-payload');
    await copyFile(input.executable, executable);
    await chmod(executable, 0o500);
    const payload = await readCollectionPayloadIdentity(executable);
    if (payload.executableSha256 !== installedPayload.executableSha256)
      throw new Error('Payload changed during private pinning.');
    const launch = await createCollectionVerifiedLaunch(executable, payload);
    const observe = async () => {
      if (canonicalJson(await readCollectionPayloadIdentity(input.executable)) !== canonicalJson(installedPayload))
        throw new Error('Installed payload bytes/inode drift.');
      return await observeVerifiedCollectionRuntime(launch, plan.candidate, root, env);
    };
    const runtimeBoundaries: Threadnote5ScenarioRuntimeBoundaryV1[] = [];
    const transcripts: unknown[] = [];
    const identities = new Map<string, string>();
    const captureBudget = new CollectionCaptureBudget();
    for (const recipe of plan.recipes) {
      const preRuntime = await observe();
      for (let index = 0; index < trialCount(plan, recipe); index += 1) {
        const trial = await executeTrial({root, plan, recipe, index, launch, captureBudget});
        assertUniqueNativeIdentities(trial.outputs, `${recipe.scenario}/${index}`, identities);
        transcripts.push(trial.transcript);
      }
      const postRuntime = await observe();
      runtimeBoundaries.push({scenario: recipe.scenario, preRuntime, postRuntime});
    }
    if (Buffer.byteLength(canonicalJson(transcripts)) > COLLECTION_TRANSCRIPT_MAX_BYTES)
      throw new Error('Private transcripts exceed the retention bound.');
    const collection = deriveThreadnote5PrivateCollection(plan, transcripts, runtimeBoundaries);
    await writePrivate(resolve(root, 'plan.json'), plan);
    await writePrivate(resolve(root, 'collection.json'), collection);
    await writePrivate(resolve(root, 'transcripts.json'), transcripts);
    return collection;
  });
}

/** Authority is explicitly external: the runner never manufactures an observer or a human judgment. */
export async function sealThreadnote5Collection(input: {
  readonly collection: unknown;
  readonly plan: unknown;
  readonly transcripts: unknown;
  readonly collectionAuthorityBinding: unknown;
  readonly expectedCollectionBindingSha256: string;
  readonly fixture: unknown;
  readonly candidate: unknown;
  readonly authorityManifest: unknown;
  readonly expectedAuthorityManifestSha256: string;
  readonly publicOutput: string;
}) {
  const collection = verifyThreadnote5PrivateCollection(input);
  verifyThreadnote5CollectionAuthorityBinding({
    binding: input.collectionAuthorityBinding,
    expectedBindingSha256: input.expectedCollectionBindingSha256,
    collectionHash: collection.collectionHash,
    authorityManifestHash: input.expectedAuthorityManifestSha256,
  });
  const captured = captureThreadnote5ReleaseCandidateV1({
    candidate: input.candidate,
    fixture: input.fixture,
    authorityManifest: input.authorityManifest,
    expectedAuthorityManifestSha256: input.expectedAuthorityManifestSha256,
    retainedSubsystemReceipts: collection.records,
    runtimeBoundaries: collection.runtimeBoundaries,
  });
  await atomicDirectory(input.publicOutput, async root => {
    await writePrivate(resolve(root, 'evidence.json'), captured.evidence);
    await writePrivate(resolve(root, 'digests.json'), {
      version: 1,
      authorityManifestHash: captured.authorityManifestHash,
      evidenceHash: captured.evidence.evidenceHash,
      planHash: collection.planHash,
      transcriptDigest: collection.transcriptDigest,
      collectionHash: collection.collectionHash,
      collectionAuthorityBindingSha256: input.expectedCollectionBindingSha256,
    });
  });
  return {evidenceHash: captured.evidence.evidenceHash, authorityManifestHash: captured.authorityManifestHash};
}

async function executeTrial(input: {
  root: string;
  plan: Threadnote5CollectionPlan;
  recipe: CollectionRecipe;
  index: number;
  launch: CollectionVerifiedLaunch;
  captureBudget: CollectionCaptureBudget;
}) {
  const identity = collectionTrialIdentity(input.plan.runId, input.recipe.scenario, input.index);
  const root = resolve(input.root, identity.trialId);
  await mkdir(root, {mode: 0o700});
  const primaryHome = resolve(root, 'primary-home');
  const secondaryHome = resolve(root, 'secondary-home');
  const repo = resolve(root, 'repo');
  const secondRepo = resolve(root, 'worktree');
  const remote = resolve(root, 'team.git');
  await Promise.all(EffectArray.map([primaryHome, secondaryHome, repo], path => mkdir(path, {mode: 0o700})));
  await Promise.all(EffectArray.map([primaryHome, secondaryHome], home => mkdir(resolve(home, 'tmp'), {mode: 0o700})));
  const env = collectionEnvironment(root, primaryHome);
  for (const argv of [
    ['init', '--bare', remote],
    ['init', repo],
    ['-C', repo, 'commit', '--allow-empty', '-m', 'Synthetic readiness input'],
    ['-C', repo, 'remote', 'add', 'origin', remote],
    ['-C', repo, 'worktree', 'add', '--detach', secondRepo],
  ]) {
    const result = await runCollectionProcess('/usr/bin/git', argv, root, env);
    if (result.exitCode !== 0) throw new Error('Could not prepare an isolated local Git trial.');
  }
  const anchorIdentities = {
    primary: {
      home: await readCollectionDirectoryIdentity(primaryHome),
      repo: await readCollectionDirectoryIdentity(repo),
    },
    secondary: {
      home: await readCollectionDirectoryIdentity(secondaryHome),
      repo: await readCollectionDirectoryIdentity(secondRepo),
    },
  } as const;
  const outputs: Record<string, unknown> = {};
  const transcript: unknown[] = [];
  const clients = new Map<CollectionSurface, Client>();
  const transports = new Map<CollectionSurface, CollectionMcpTransport>();
  const mcpStderr: Record<string, string[]> = {};
  const written = new Set<string>();
  const syntheticIdentities = new Set<string>();
  try {
    for (const step of input.recipe.steps) {
      const home = step.surface === 'primary' ? primaryHome : secondaryHome;
      const cwd = step.surface === 'primary' ? repo : secondRepo;
      const stepEnv = collectionEnvironment(root, home);
      const bindings = {
        ...identity,
        home: resolve(home, '.threadnote'),
        userHome: home,
        repo: cwd,
        primaryRepo: repo,
        secondaryRepo: secondRepo,
        remote,
      };
      const render = (value: string) => interpolate(value, bindings, outputs);
      let output: unknown;
      if (step.type === 'write' || step.type === 'read-json') {
        const anchor = step.root === 'home' ? home : cwd;
        const base = step.root === 'home' ? '.threadnote' : '.';
        const anchorIdentity = anchorIdentities[step.surface][step.root];
        const renderedPath = relativeFile(render(step.path));
        const pathKey = `${anchor}\u0000${base}\u0000${renderedPath}`;
        if (step.type === 'write') {
          syntheticIdentities.add(
            await writeSyntheticCollectionFile(anchor, base, renderedPath, render(step.text), anchorIdentity, stepEnv),
          );
          written.add(pathKey);
        } else {
          if (written.has(pathKey)) throw new Error('Synthetic input cannot be exported as native evidence.');
          output = await readNativeCollectionJson(
            anchor,
            base,
            renderedPath,
            anchorIdentity,
            syntheticIdentities,
            stepEnv,
          );
        }
      } else {
        await observeVerifiedCollectionRuntime(input.launch, input.plan.candidate, cwd, stepEnv);
        if (step.type === 'cli') {
          const argv = EffectArray.map(step.argv, render);
          assertIsolatedCollectionArguments(argv, root);
          const result = await runVerifiedCollectionProcess(input.launch, argv, cwd, stepEnv, {
            maximumCaptureBytes: input.captureBudget.remainingBytes,
          });
          if (result.exitCode !== step.expectedExit)
            throw new Error(`Candidate command failed in ${input.recipe.scenario}/${step.id}.`);
          if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > input.captureBudget.remainingBytes)
            throw new Error('Private transcripts exceed the retention bound.');
          let json: unknown = null;
          try {
            json = JSON.parse(result.stdout);
          } catch {
            /* Text output remains private and cannot masquerade as JSON. */
          }
          output = {...result, json};
        } else {
          let client = clients.get(step.surface);
          if (client === undefined) {
            client = new Client({name: `release-${identity.trialId}-${step.surface}`, version: '1'});
            const transport = new CollectionMcpTransport({
              launch: input.launch,
              cwd,
              env: stepEnv,
            });
            clients.set(step.surface, client);
            transports.set(step.surface, transport);
            mcpStderr[step.surface] = transport.stderr;
            transport.beginCapture(input.captureBudget.remainingBytes);
            await client.connect(transport, {timeout: 120_000});
          }
          const renderedArgs = renderNativeArguments(step.arguments, render);
          if (typeof renderedArgs !== 'object' || renderedArgs === null || EffectArray.isArray(renderedArgs)) {
            throw new Error('Rendered MCP tool arguments must be an object.');
          }
          const args = EffectRecord.fromEntries(EffectRecord.toEntries(renderedArgs));
          assertIsolatedCollectionArguments([JSON.stringify(args)], root);
          transports.get(step.surface)!.beginCapture(input.captureBudget.remainingBytes);
          output = await client.callTool({name: step.tool, arguments: args}, undefined, {timeout: 120_000});
          transports.get(step.surface)!.assertHealthy();
          if (Buffer.byteLength(canonicalJson(output)) > COLLECTION_MAX_BYTES)
            throw new Error('MCP output exceeds its private capture bound.');
          if (Predicate.isObject(output) && 'isError' in output && output.isError === true)
            throw new Error(`Candidate MCP tool failed in ${input.recipe.scenario}/${step.id}.`);
        }
        await observeVerifiedCollectionRuntime(input.launch, input.plan.candidate, cwd, stepEnv);
      }
      if (output !== undefined) outputs[step.id] = output;
      const entry = {step, bindings, output: output ?? null};
      input.captureBudget.consume(Buffer.byteLength(canonicalJson(entry)) + 1);
      transcript.push(entry);
    }
  } finally {
    const cleanup = await Promise.allSettled(EffectArray.map([...clients.values()], client => client.close()));
    const groups = await Promise.allSettled(EffectArray.map([...transports.values()], transport => transport.close()));
    await assertCollectionCleanup([...cleanup, ...groups]);
  }
  for (const transport of transports.values()) transport.assertHealthy();
  input.captureBudget.consume(
    Buffer.byteLength(canonicalJson({identity, scenario: input.recipe.scenario, mcpStderr})) + 1,
  );
  return {outputs, transcript: {identity, scenario: input.recipe.scenario, steps: transcript, mcpStderr}};
}

async function assertCollectionCleanup(results: readonly PromiseSettledResult<unknown>[]): Promise<void> {
  const errors = EffectArray.flatMap(results, result => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length > 0)
    throw EffectOption.getOrUndefined(EffectArray.findFirst(errors, collectionCleanupIsUnsafe)) ?? errors[0];
}

function interpolate(
  value: string,
  bindings: Readonly<Record<string, string>>,
  outputs: Readonly<Record<string, unknown>>,
): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native replacement callbacks receive capture groups and offsets; Effect String accepts replacement strings only.
  return value.replace(/\{\{([^{}]+)\}\}/gu, (_, name: string) => {
    if (Effect.pipe(name, EffectString.startsWith('output:'))) {
      const [step, ...pointer] = Effect.pipe(name, EffectString.slice(7), EffectString.split(':'));
      const result = nativePointer(outputs[step], EffectArray.join(pointer, ':'));
      if (typeof result !== 'string' && typeof result !== 'number')
        throw new Error('Argument selection requires scalar native output.');
      return String(result);
    }
    if (!EffectRecord.has(bindings, name)) throw new Error('Unknown collection binding.');
    return bindings[name];
  });
}

export function assertIsolatedCollectionArguments(values: readonly string[], root: string): void {
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error('Collection trial root must be canonical.');
  for (const value of values) {
    const decoded = decodeCollectionArgument(value);
    if (
      Effect.pipe(decoded, EffectString.includes(String.fromCharCode(0))) ||
      /(?:^|[/\\])\.\.(?=[/\\]|$)/u.test(decoded) ||
      /(?:^|[\s"'=[{(,])~[/\\]/u.test(decoded) ||
      /(?:^|[\s"'=[{(,])(?:file|https?|ssh|git(?:\+ssh)?):/iu.test(decoded) ||
      /git@/u.test(decoded)
    )
      throw new Error('Candidate arguments may not escape the isolated trial.');
    for (const token of EffectArray.filter(Effect.pipe(decoded, EffectString.split(/[\s"'=,:{}()[\],]+/u)), Boolean))
      if (Effect.pipe(token, EffectString.startsWith('/')) && (resolve(token) !== token || !isWithin(root, token)))
        throw new Error('Absolute candidate paths must stay inside the isolated trial.');
  }
}

function decodeCollectionArgument(value: string): string {
  let decoded = value;
  for (let depth = 0; depth < 16; depth += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new Error('Candidate arguments may not escape the isolated trial.');
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  throw new Error('Candidate arguments may not escape the isolated trial.');
}

function isWithin(base: string, path: string): boolean {
  const fromBase = relative(base, path);
  return (
    fromBase === '' ||
    (fromBase !== '..' && !Effect.pipe(fromBase, EffectString.startsWith(`..${sep}`)) && !isAbsolute(fromBase))
  );
}

const COLLECTION_PROTECTED_PYTHON = '/usr/bin/python3';
const COLLECTION_FILE_BROKER = String.raw`
import os
import stat
import sys
import time

def fail(message):
    os.write(2, (message + "\n").encode("ascii"))
    raise SystemExit(125)

def components(value, dot_allowed=False):
    if dot_allowed and value == ".":
        return []
    if not value or os.path.isabs(value) or "\\" in value:
        fail("Native path escaped its selected base.")
    parts = value.split("/")
    if any(not part or part in (".", "..") for part in parts):
        fail("Native path escaped its selected base.")
    return parts

def same_object(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino

def open_directory(parent, name):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)

def open_chain(anchor, parts, create):
    current = os.dup(anchor)
    created = []
    try:
        for name in parts:
            try:
                next_descriptor = open_directory(current, name)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(name, 0o700, dir_fd=current)
                    created_info = open_directory(current, name)
                    info = os.fstat(created_info)
                    os.close(created_info)
                    created.append((os.dup(current), name, info.st_dev, info.st_ino))
                except FileExistsError:
                    pass
                next_descriptor = open_directory(current, name)
            os.close(current)
            current = next_descriptor
        return current, created
    except BaseException:
        os.close(current)
        cleanup_directories(created)
        raise

def cleanup_directories(created):
    for parent, name, device, inode in reversed(created):
        try:
            descriptor = open_directory(parent, name)
            current = os.fstat(descriptor)
            os.close(descriptor)
            if (current.st_dev, current.st_ino) == (device, inode):
                os.rmdir(name, dir_fd=parent)
        except OSError:
            pass
        os.close(parent)

def verify_current(anchor, parent_parts, parent_info, name, file_info):
    descriptor = -1
    opened_file = -1
    try:
        descriptor, _ = open_chain(anchor, parent_parts, False)
        if not same_object(os.fstat(descriptor), parent_info):
            return False
        opened_file = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=descriptor)
        current = os.fstat(opened_file)
        return (same_object(current, file_info) and current.st_size == file_info.st_size and
                current.st_mtime_ns == file_info.st_mtime_ns and current.st_ctime_ns == file_info.st_ctime_ns)
    except OSError:
        return False
    finally:
        if opened_file >= 0:
            os.close(opened_file)
        if descriptor >= 0:
            os.close(descriptor)

def wait_for_test_barrier():
    ready = os.environ.get("THREADNOTE_COLLECTION_TEST_FILE_READY")
    release = os.environ.get("THREADNOTE_COLLECTION_TEST_FILE_RELEASE")
    if bool(ready) != bool(release):
        fail("Invalid collection file barrier.")
    if not ready:
        return
    marker = os.open(ready, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(marker)
    for _ in range(500):
        try:
            if stat.S_ISREG(os.lstat(release).st_mode):
                return
        except FileNotFoundError:
            pass
        time.sleep(0.01)
    fail("Collection file barrier timed out.")

def main():
    if len(sys.argv) != 8 or sys.argv[1] not in ("read", "write"):
        fail("Invalid collection file broker invocation.")
    mode, anchor_path = sys.argv[1:3]
    expected_anchor = (int(sys.argv[3]), int(sys.argv[4]))
    parent_parts = components(sys.argv[5], True) + components(sys.argv[6])[:-1]
    name = components(sys.argv[6])[-1]
    maximum = int(sys.argv[7])
    if maximum < 0:
        fail("Invalid collection file byte bound.")
    anchor = os.open(anchor_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    parent = -1
    created = []
    opened_file = -1
    unlink_file = False
    committed = False
    try:
        anchor_info = os.fstat(anchor)
        if (anchor_info.st_dev, anchor_info.st_ino) != expected_anchor:
            fail("Native path escaped its selected base.")
        parent, created = open_chain(anchor, parent_parts, mode == "write")
        parent_info = os.fstat(parent)
        wait_for_test_barrier()
        if mode == "write":
            opened_file = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                  0o600, dir_fd=parent)
            unlink_file = True
            total = 0
            while True:
                chunk = os.read(0, min(65536, maximum + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > maximum:
                    fail("Synthetic input exceeds its private byte bound.")
                view = memoryview(chunk)
                while view:
                    written = os.write(opened_file, view)
                    view = view[written:]
            file_info = os.fstat(opened_file)
            if not stat.S_ISREG(file_info.st_mode):
                fail("Synthetic input must be a stable regular file.")
        else:
            opened_file = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            before = os.fstat(opened_file)
            if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
                fail("Native capture must be a bounded regular JSON file.")
            chunks = []
            total = 0
            while total <= maximum:
                chunk = os.read(opened_file, min(65536, maximum + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
            file_info = os.fstat(opened_file)
            if (total > maximum or total != before.st_size or not same_object(before, file_info) or
                    before.st_size != file_info.st_size or before.st_mtime_ns != file_info.st_mtime_ns or
                    before.st_ctime_ns != file_info.st_ctime_ns):
                fail("Private JSON changed during its bounded read.")
        if not verify_current(anchor, parent_parts, parent_info, name, file_info):
            fail("Native path changed during descriptor-relative access.")
        os.write(1, (str(file_info.st_dev) + ":" + str(file_info.st_ino) + "\n").encode("ascii"))
        if mode == "read":
            for chunk in chunks:
                os.write(1, chunk)
        unlink_file = False
        committed = True
    finally:
        if opened_file >= 0:
            os.close(opened_file)
        if unlink_file and parent >= 0:
            try:
                os.unlink(name, dir_fd=parent)
            except OSError:
                pass
        if parent >= 0:
            os.close(parent)
        os.close(anchor)
        if not committed:
            cleanup_directories(created)
        else:
            for descriptor, _, _, _ in created:
                os.close(descriptor)

try:
    main()
except SystemExit:
    raise
except BaseException:
    fail("Collection file broker failed closed.")
`;

export interface CollectionDirectoryIdentity {
  readonly device: string;
  readonly inode: string;
}

export async function readCollectionDirectoryIdentity(path: string): Promise<CollectionDirectoryIdentity> {
  if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path)
    throw new Error('Collection directory anchor must be canonical.');
  const info = await lstat(path, {bigint: true});
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev === 0n || info.ino === 0n)
    throw new Error('Collection directory anchor must be a stable directory.');
  return {device: String(info.dev), inode: String(info.ino)};
}

export async function writeSyntheticCollectionFile(
  anchor: string,
  base: string,
  file: string,
  text: string,
  anchorIdentity: CollectionDirectoryIdentity,
  env: Record<string, string>,
): Promise<string> {
  const bytes = Buffer.from(text);
  if (bytes.byteLength > COLLECTION_MAX_BYTES) throw new Error('Synthetic input exceeds its private byte bound.');
  const output = await runCollectionFileBroker('write', anchor, base, file, anchorIdentity, env, bytes);
  return parseCollectionFileBrokerIdentity(output);
}

export async function readNativeCollectionJson(
  anchor: string,
  base: string,
  file: string,
  anchorIdentity: CollectionDirectoryIdentity,
  syntheticIdentities: ReadonlySet<string>,
  env: Record<string, string>,
): Promise<unknown> {
  const output = await runCollectionFileBroker('read', anchor, base, file, anchorIdentity, env);
  const newline = Effect.pipe(
    output,
    EffectString.indexOf('\n'),
    Effect.Option.getOrElse(() => -1),
  );
  if (newline < 1) throw new Error('Invalid collection file broker response.');
  const identity = parseCollectionFileBrokerIdentity(Effect.pipe(output, EffectString.slice(0, newline + 1)));
  if (syntheticIdentities.has(identity)) throw new Error('Synthetic input cannot be exported as native evidence.');
  return JSON.parse(Effect.pipe(output, EffectString.slice(newline + 1)));
}

async function runCollectionFileBroker(
  mode: 'read' | 'write',
  anchor: string,
  base: string,
  file: string,
  anchorIdentity: CollectionDirectoryIdentity,
  env: Record<string, string>,
  input = Buffer.alloc(0),
): Promise<string> {
  const protectedPython = await requireProtectedCollectionPython();
  if (!isAbsolute(anchor) || resolve(anchor) !== anchor || (base !== '.' && relativeFile(base) !== base))
    throw new Error('Native path escaped its selected base.');
  const renderedFile = relativeFile(file);
  const owned = ownCollectionProcess(
    protectedPython,
    [
      '-I',
      '-S',
      '-E',
      '-c',
      COLLECTION_FILE_BROKER,
      mode,
      anchor,
      anchorIdentity.device,
      anchorIdentity.inode,
      base,
      renderedFile,
      String(COLLECTION_MAX_BYTES),
    ],
    anchor,
    env,
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const maximumOutput = mode === 'read' ? COLLECTION_MAX_BYTES + 256 : 256;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let exceeded = false;
  const stop = () => {
    exceeded = true;
    void owned.terminate().catch(() => {});
  };
  const timeout = setTimeout(stop, 30_000);
  owned.child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > maximumOutput) stop();
    else stdout.push(chunk);
  });
  owned.child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > 4096) stop();
    else stderr.push(chunk);
  });
  const sent = owned.input.end(input);
  try {
    const [exitCode] = await Promise.all([owned.done, sent]);
    const errorText = decodeCollectionFileBrokerOutput(Buffer.concat(stderr));
    if (exceeded || exitCode !== 0 || errorText !== '')
      throw new Error(Effect.pipe(errorText, EffectString.trim) || 'Collection file broker failed closed.');
    return decodeCollectionFileBrokerOutput(Buffer.concat(stdout));
  } finally {
    clearTimeout(timeout);
    await owned.terminate();
  }
}

async function requireProtectedCollectionPython(): Promise<string> {
  const entry = await lstat(COLLECTION_PROTECTED_PYTHON, {bigint: true});
  const canonical = await realpath(COLLECTION_PROTECTED_PYTHON);
  const observer = await lstat(canonical, {bigint: true});
  await Promise.all([
    assertProtectedCollectionAncestors(COLLECTION_PROTECTED_PYTHON),
    assertProtectedCollectionAncestors(canonical),
  ]);
  if (
    (!entry.isFile() && !entry.isSymbolicLink()) ||
    entry.uid !== 0n ||
    (entry.isFile() && (entry.mode & 0o22n) !== 0n) ||
    !observer.isFile() ||
    observer.isSymbolicLink() ||
    observer.uid !== 0n ||
    (observer.mode & 0o22n) !== 0n ||
    (await realpath(canonical)) !== canonical
  )
    throw new Error('Descriptor-relative collection files require an immutable protected system interpreter.');
  return canonical;
}

async function assertProtectedCollectionAncestors(path: string): Promise<void> {
  let current = dirname(path);
  while (true) {
    const entry = await lstat(current, {bigint: true});
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0n || (entry.mode & 0o22n) !== 0n)
      throw new Error('Descriptor-relative collection files require immutable protected path components.');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function decodeCollectionFileBrokerOutput(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  } catch {
    throw new Error('Collection file broker output must be valid UTF-8.');
  }
}

function parseCollectionFileBrokerIdentity(output: string): string {
  const identity = Effect.pipe(output, EffectString.trim);
  if (!/^\d+:\d+$/u.test(identity)) throw new Error('Invalid collection file broker response.');
  return identity;
}

function trialCount(plan: Threadnote5CollectionPlan, recipe: CollectionRecipe): number {
  return EffectArray.some(
    EffectOption.getOrUndefined(
      EffectArray.findFirst(THREADNOTE_5_COLLECTION_MATRIX, item => item[0] === recipe.scenario),
    )![1],
    item => item[1] > 1,
  )
    ? plan.measuredTrials
    : 1;
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  const body = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(body) > COLLECTION_MAX_BYTES && !Effect.pipe(path, EffectString.endsWith('transcripts.json')))
    throw new Error('Private collection artifact exceeds its bound.');
  await writeFile(path, body, {mode: 0o600, flag: 'wx'});
}

export async function atomicDirectory<T>(output: string, build: (root: string) => Promise<T>): Promise<T> {
  const destination = resolve(output);
  await requireAbsent(destination);
  const parent = await realpath(dirname(destination));
  const stage = await mkdtemp(resolve(parent, '.threadnote-collection-'));
  try {
    const result = await build(stage);
    await symlink(basename(stage), destination, 'dir');
    return result;
  } catch (error) {
    if (!collectionCleanupIsUnsafe(error)) await rm(stage, {recursive: true, force: true});
    throw error;
  }
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error('Collection output already exists.');
  } catch (error) {
    if ((Predicate.hasProperty(error, 'code') ? error.code : undefined) !== 'ENOENT') throw error;
  }
}

function renderNativeArguments(value: unknown, render: (value: string) => string): unknown {
  if (typeof value === 'string') return render(value);
  if (EffectArray.isArray(value)) return EffectArray.map(value, item => renderNativeArguments(item, render));
  if (value !== null && typeof value === 'object')
    return EffectRecord.fromEntries(
      EffectArray.map(EffectRecord.toEntries(value), ([key, item]) => [key, renderNativeArguments(item, render)]),
    );
  return value;
}
