import {Array as EffectArray} from 'effect';
import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {fromPromise} from '@threadnote/platform/errors';
import {
  fileSystemModeIsPrivate,
  runtimePlatform,
  runtimeReadBoundedStableRegularFile,
  SystemInfo,
} from '@threadnote/platform/system';
import {readSeedManifest} from '@threadnote/workspace/manifest';
import type {ProjectManifest, RuntimeConfig, SeedManifest} from '@threadnote/workspace/config';
import {expandPath} from '@threadnote/platform/paths';
import {codeGraphLayout} from '../layout.js';
import {readPersistedCodeGraphLocalAssociation} from '../local_provenance.js';
import {
  awaitCodeGraphWorktreeBuilds,
  withCodeGraphMaintenanceIntent,
  withCodeGraphMaintenanceRegistration,
  withCodeGraphTargetWorktreeLock,
} from '../maintenance/gate.js';
import {resolveRepositoryIdentity} from '../repository.js';
import {CodeGraphStore, type CodeGraphWorktreeReconciliationCandidate} from '../store.js';
import {inspectCodeGraphViewDatabaseTarget} from '../view_removal.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MAXIMUM_REQUESTS = 64;
const MAXIMUM_INTENT_FILES = MAXIMUM_REQUESTS;
const MAXIMUM_BYTES = 600_000;
const LOCK_OPTIONS = {retryIntervalMilliseconds: 10, staleAfterMilliseconds: 30_000, waitTimeoutMilliseconds: 0};

interface ScopeRetirementRequest {
  readonly checkoutId?: string;
  readonly manifestPath: string;
  readonly projectPath: string;
  readonly worktreeId?: string;
}

interface ScopeRetirementIntent {
  readonly requests: readonly ScopeRetirementRequest[];
  readonly scopeId: string;
  readonly version: 1;
}

export interface CodeGraphScopeRetirementTarget {
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly threadnoteHome: string;
}

class CodeGraphScopeRetirementError extends Schema.TaggedError<
  CodeGraphScopeRetirementError,
  {readonly brand: unique symbol}
>()('CodeGraphScopeRetirementError', {message: Schema.String}) {}

/** Persist before manifest publication so absent checkouts can retire on a later bounded maintenance tick. */
export const queueCodeGraphScopeRetirements = Effect.fn('codeGraph.queueScopeRetirements')(function* (
  config: RuntimeConfig,
  before: SeedManifest,
  after: SeedManifest,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const targets = new Map<string, CodeGraphScopeRetirementTarget>();
  for (const project of before.projects) {
    if (
      project.graph === undefined ||
      EffectArray.some(
        after.projects,
        next => next.graph !== undefined && next.uri === project.uri && next.path === project.path,
      )
    )
      continue;
    if (
      (system.platform !== 'win32' && /^[A-Za-z]:[\\/]/u.test(project.path)) ||
      (system.platform === 'win32' && Effect2.pipe(project.path, EffectString.startsWith('/')))
    )
      continue;
    const expanded = yield* expandPath(project.path);
    const identity = yield* resolveRepositoryIdentity(expanded).pipe(Effect.option);
    const request: ScopeRetirementRequest = {
      manifestPath: path.resolve(config.manifestPath),
      projectPath: Option.isSome(identity) ? identity.value.repoRoot : path.resolve(expanded),
      ...(Option.isSome(identity)
        ? {checkoutId: identity.value.checkoutId, worktreeId: identity.value.worktreeId}
        : {}),
    };
    const scopeId = scopeForProject(project);
    yield* mutateIntent(config.agentContextHome, scopeId, requests => {
      if (EffectArray.some(requests, existing => requestKey(existing) === requestKey(request))) return requests;
      if (requests.length >= MAXIMUM_REQUESTS) throw new Error('Pending scoped graph retirement capacity is full.');
      return [...requests, request];
    });
    if (Option.isSome(identity)) {
      const canonicalHome = yield* fs.realPath(config.agentContextHome);
      const layout = codeGraphLayout(path, canonicalHome, identity.value.checkoutId, identity.value.worktreeId);
      targets.set(identity.value.checkoutId, {
        checkoutId: identity.value.checkoutId,
        databasePath: layout.databasePath,
        threadnoteHome: canonicalHome,
      });
    }
  }
  return [...targets.values()];
});

/** One catalog page, one retired logical view; existing residual/routine collectors own physical reclamation. */
export const reconcileCodeGraphScopeRetirements = Effect.fn('codeGraph.reconcileScopeRetirements')(function* (
  input: CodeGraphScopeRetirementTarget,
  selectedCandidates?: readonly CodeGraphWorktreeReconciliationCandidate[],
) {
  const store = yield* CodeGraphStore;
  const root = yield* intentRoot(input.threadnoteHome, false);
  if (root === undefined) return undefined;
  const intents = yield* readIntentPage(input.threadnoteHome);
  const inspected = yield* inspectCodeGraphViewDatabaseTarget(input.threadnoteHome, input.checkoutId);
  if (inspected.state === 'ready' && inspected.databasePath !== input.databasePath) return undefined;
  const candidates =
    selectedCandidates ??
    (inspected.state === 'ready'
      ? yield* store.claimWorktreeReconciliationCandidates(input.databasePath, 32, {waitTimeoutMilliseconds: 0})
      : []);
  const intentsByScope = new Map(EffectArray.map(intents, intent => [intent.scopeId, intent]));
  if (inspected.state === 'ready') {
    for (const candidate of candidates) {
      if (candidate.scopeId === undefined) continue;
      const intent = intentsByScope.get(candidate.scopeId);
      if (intent === undefined) continue;
      for (const request of intent.requests) {
        const result = yield* retireCandidate(input, candidate, request).pipe(Effect.option);
        if (Option.isSome(result) && result.value !== undefined) return {candidate, result: result.value};
      }
    }
  }
  for (const intent of intents) {
    for (const request of intent.requests) {
      const cleared = yield* clearAuthoritativeNoop(input, intent.scopeId, request).pipe(Effect.option);
      if (Option.isSome(cleared) && cleared.value) return undefined;
    }
  }
  return undefined;
});

const retireCandidate = Effect.fn('codeGraph.retireConfiguredScopeCandidate')(function* (
  input: CodeGraphScopeRetirementTarget,
  candidate: CodeGraphWorktreeReconciliationCandidate,
  request: ScopeRetirementRequest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const scopeId = candidate.scopeId;
  if (scopeId === undefined) return undefined;
  if (
    request.checkoutId !== undefined &&
    (request.checkoutId !== input.checkoutId || request.worktreeId !== candidate.worktreeId)
  )
    return undefined;
  const association = yield* readPersistedCodeGraphLocalAssociation(input.threadnoteHome, {
    checkoutId: input.checkoutId,
    repositoryId: candidate.repositoryId,
    worktreeId: candidate.worktreeId,
  });
  const associationPath = 'path' in association ? association.path : undefined;
  if (
    request.checkoutId === undefined &&
    (associationPath === undefined || !withinRoot(path, associationPath, request.projectPath))
  )
    return undefined;
  const repoRoot = associationPath ?? request.projectPath;
  return yield* withCodeGraphMaintenanceRegistration(
    input.threadnoteHome,
    withCodeGraphMaintenanceIntent(
      input.threadnoteHome,
      withExclusiveFileLock(
        fs,
        `${request.manifestPath}.worksets.lock`,
        LOCK_OPTIONS,
        Effect.gen(function* () {
          yield* awaitCodeGraphWorktreeBuilds(input.threadnoteHome, input.checkoutId, 0);
          return yield* withCodeGraphTargetWorktreeLock(
            input.threadnoteHome,
            input.checkoutId,
            candidate.worktreeId,
            Effect.gen(function* () {
              const manifestHash = sha256HexSync(yield* fs.readFileString(request.manifestPath));
              const manifest = yield* readSeedManifest(request.manifestPath);
              if (yield* scopeRetirementStillReferenced(input, scopeId, candidate.worktreeId, repoRoot, manifest))
                return undefined;
              const result = yield* store.removeView(input.databasePath, candidate.worktreeId, candidate.snapshotId, {
                scopeId,
                waitTimeoutMilliseconds: 0,
                requireReconciliationSchema: true,
                beforeDatabaseOpen: () =>
                  Effect.gen(function* () {
                    if (sha256HexSync(yield* fs.readFileString(request.manifestPath)) !== manifestHash)
                      return yield* CodeGraphScopeRetirementError.make({
                        message: 'Scoped retirement manifest changed.',
                      });
                    return yield* inspectCodeGraphViewDatabaseTarget(input.threadnoteHome, input.checkoutId);
                  }).pipe(
                    Effect.flatMap(current =>
                      current.state === 'ready' && current.databasePath === input.databasePath
                        ? Effect.void
                        : Effect.fail(
                            CodeGraphScopeRetirementError.make({message: 'Scoped retirement database changed.'}),
                          ),
                    ),
                    Effect.provideService(FileSystem.FileSystem, fs),
                    Effect.provideService(Path.Path, path),
                  ),
              });
              if (result.state !== 'removed' && result.state !== 'already-removed') return undefined;
              yield* mutateIntent(input.threadnoteHome, scopeId, requests =>
                EffectArray.filter(requests, existing => requestKey(existing) !== requestKey(request)),
              );
              return result;
            }),
            scopeId,
          );
        }),
      ),
    ),
    0,
  );
});

const clearAuthoritativeNoop = Effect.fn('codeGraph.clearAuthoritativeScopeRetirementNoop')(function* (
  input: CodeGraphScopeRetirementTarget,
  scopeId: string,
  request: ScopeRetirementRequest,
) {
  if (request.checkoutId === undefined || request.worktreeId === undefined || request.checkoutId !== input.checkoutId)
    return false;
  const worktreeId = request.worktreeId;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const expectedDatabasePath = codeGraphLayout(path, input.threadnoteHome, input.checkoutId, worktreeId).databasePath;
  if (expectedDatabasePath !== input.databasePath) return false;
  return yield* withCodeGraphMaintenanceRegistration(
    input.threadnoteHome,
    withCodeGraphMaintenanceIntent(
      input.threadnoteHome,
      withExclusiveFileLock(
        fs,
        `${request.manifestPath}.worksets.lock`,
        LOCK_OPTIONS,
        Effect.gen(function* () {
          yield* awaitCodeGraphWorktreeBuilds(input.threadnoteHome, input.checkoutId, 0);
          return yield* withCodeGraphTargetWorktreeLock(
            input.threadnoteHome,
            input.checkoutId,
            worktreeId,
            Effect.gen(function* () {
              const manifestHash = sha256HexSync(yield* fs.readFileString(request.manifestPath));
              const manifest = yield* readSeedManifest(request.manifestPath);
              if (yield* scopeRetirementStillReferenced(input, scopeId, worktreeId, request.projectPath, manifest))
                return false;
              const before = yield* inspectCodeGraphViewDatabaseTarget(input.threadnoteHome, input.checkoutId);
              if (before.state === 'ready') {
                if (before.databasePath !== input.databasePath) return false;
                if ((yield* store.loadActiveViewFence(input.databasePath, worktreeId, scopeId)) !== undefined)
                  return false;
              }
              if (sha256HexSync(yield* fs.readFileString(request.manifestPath)) !== manifestHash) return false;
              const after = yield* inspectCodeGraphViewDatabaseTarget(input.threadnoteHome, input.checkoutId);
              if (
                before.state !== after.state ||
                (after.state === 'ready' && after.databasePath !== input.databasePath)
              )
                return false;
              yield* mutateIntent(input.threadnoteHome, scopeId, requests =>
                EffectArray.filter(requests, existing => requestKey(existing) !== requestKey(request)),
              );
              return true;
            }),
            scopeId,
          );
        }),
      ),
    ),
    0,
  );
});

const scopeRetirementStillReferenced = Effect.fn('codeGraph.scopeRetirementStillReferenced')(function* (
  input: CodeGraphScopeRetirementTarget,
  scopeId: string,
  worktreeId: string,
  repoRoot: string,
  manifest: SeedManifest,
) {
  const path = yield* Path.Path;
  for (const project of manifest.projects) {
    if (project.graph === undefined || scopeForProject(project) !== scopeId) continue;
    const expanded = yield* expandPath(project.path);
    if (withinRoot(path, repoRoot, path.resolve(expanded))) return true;
    const identity = yield* resolveRepositoryIdentity(expanded).pipe(Effect.option);
    if (Option.isNone(identity)) return true;
    if (identity.value.checkoutId === input.checkoutId && identity.value.worktreeId === worktreeId) return true;
  }
  return false;
});

function scopeForProject(project: Pick<ProjectManifest, 'uri'>): string {
  return `code-graph-scope:${sha256HexSync(project.uri)}`;
}

function requestKey(request: ScopeRetirementRequest): string {
  return JSON.stringify([request.manifestPath, request.projectPath, request.checkoutId, request.worktreeId]);
}

function withinRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !Effect2.pipe(relative, EffectString.startsWith(`..${path.sep}`)))
  );
}

const intentRoot = Effect.fn('codeGraph.scopeRetirementIntentRoot')(function* (home: string, create: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(home, 'scope-retirements-v1');
  for (const directory of [home, root]) {
    if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)))
      return yield* CodeGraphScopeRetirementError.make({message: 'Scoped retirement directory is a symbolic link.'});
    if (!(yield* fs.exists(directory))) {
      if (!create) return undefined;
      yield* fs.makeDirectory(directory, {mode: 0o700});
    }
    const info = yield* fs.stat(directory);
    if (info.type !== 'Directory' || (directory === root && !fileSystemModeIsPrivate(runtimePlatform, info.mode)))
      return yield* CodeGraphScopeRetirementError.make({message: 'Scoped retirement directory is unavailable.'});
  }
  return root;
});

const readIntentFile = Effect.fn('codeGraph.readScopeRetirementIntentFile')(function* (
  home: string,
  fileName: string,
  expectedScopeId?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* intentRoot(home, false);
  if (root === undefined) return undefined;
  if (!/^[0-9a-f]{64}\.json$/u.test(fileName))
    return yield* CodeGraphScopeRetirementError.make({message: 'Scoped retirement intent name is invalid.'});
  const file = path.join(root, fileName);
  if (!(yield* fs.exists(file))) return undefined;
  const before = yield* fs.stat(root);
  const canonicalRoot = yield* fs.realPath(root);
  const bytes = yield* fromPromise('codeGraph.readScopeRetirement', () =>
    runtimeReadBoundedStableRegularFile(file, MAXIMUM_BYTES),
  );
  yield* intentRoot(home, false);
  const after = yield* fs.stat(root);
  if (
    before.dev !== after.dev ||
    Option.getOrUndefined(before.ino) !== Option.getOrUndefined(after.ino) ||
    canonicalRoot !== (yield* fs.realPath(root))
  )
    return yield* CodeGraphScopeRetirementError.make({message: 'Scoped retirement directory changed.'});
  const value = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: () => CodeGraphScopeRetirementError.make({message: 'Scoped retirement intent is invalid.'}),
  });
  const scopeId =
    typeof value === 'object' && value !== null && 'scopeId' in value && typeof value.scopeId === 'string'
      ? value.scopeId
      : undefined;
  if (
    scopeId === undefined ||
    (expectedScopeId !== undefined && scopeId !== expectedScopeId) ||
    fileName !== `${sha256HexSync(scopeId)}.json` ||
    !validIntent(path, value, scopeId)
  )
    return yield* CodeGraphScopeRetirementError.make({message: 'Scoped retirement intent is invalid.'});
  return value;
});

const readIntent = Effect.fn('codeGraph.readScopeRetirementIntent')(function* (home: string, scopeId: string) {
  return yield* readIntentFile(home, `${sha256HexSync(scopeId)}.json`, scopeId);
});

const intentFilePage = Effect.fn('codeGraph.scopeRetirementIntentFilePage')(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* intentRoot(home, false);
  if (root === undefined) return {fileNames: [], truncated: false} as const;
  const fileNames = EffectArray.filter(
    yield* fs.readDirectory(root),
    __effectArrayValue => !!(name => /^[0-9a-f]{64}\.json$/u.test(name))(__effectArrayValue),
  ).sort();
  return {
    fileNames: fileNames.slice(0, MAXIMUM_INTENT_FILES),
    truncated: fileNames.length > MAXIMUM_INTENT_FILES,
  } as const;
});

const readIntentPage = Effect.fn('codeGraph.readScopeRetirementIntentPage')(function* (home: string) {
  const page = yield* intentFilePage(home);
  const intents = yield* Effect.forEach(
    page.fileNames,
    fileName => readIntentFile(home, fileName).pipe(Effect.option),
    {concurrency: 1},
  );
  return EffectArray.flatMap(intents, intent =>
    Option.isSome(intent) && intent.value !== undefined ? [intent.value] : [],
  );
});

function validIntent(path: Path.Path, value: unknown, scopeId: string): value is ScopeRetirementIntent {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    !('scopeId' in value) ||
    !('requests' in value)
  )
    return false;
  return (
    value.version === 1 &&
    value.scopeId === scopeId &&
    /^code-graph-scope:[0-9a-f]{64}$/u.test(scopeId) &&
    EffectArray.isArray(value.requests) &&
    value.requests.length <= MAXIMUM_REQUESTS &&
    EffectArray.every(value.requests, (request): request is ScopeRetirementRequest =>
      isScopeRetirementRequest(path, request),
    )
  );
}

function isScopeRetirementRequest(path: Path.Path, request: unknown): request is ScopeRetirementRequest {
  return (
    typeof request === 'object' &&
    request !== null &&
    'manifestPath' in request &&
    'projectPath' in request &&
    EffectArray.every(
      [request.manifestPath, request.projectPath],
      value =>
        typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && path.normalize(value) === value,
    ) &&
    (((!('checkoutId' in request) || request.checkoutId === undefined) &&
      (!('worktreeId' in request) || request.worktreeId === undefined)) ||
      ('checkoutId' in request &&
        typeof request.checkoutId === 'string' &&
        /^[0-9a-f]{64}$/u.test(request.checkoutId) &&
        'worktreeId' in request &&
        typeof request.worktreeId === 'string' &&
        /^[0-9a-f]{64}$/u.test(request.worktreeId)))
  );
}

const mutateIntent = Effect.fn('codeGraph.mutateScopeRetirementIntent')(function* (
  home: string,
  scopeId: string,
  update: (requests: readonly ScopeRetirementRequest[]) => readonly ScopeRetirementRequest[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const root = yield* intentRoot(home, true);
  if (root === undefined) return;
  const file = path.join(root, `${sha256HexSync(scopeId)}.json`);
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
    return yield* CodeGraphScopeRetirementError.make({message: 'Scoped retirement intent is a symbolic link.'});
  return yield* withExclusiveFileLock(
    fs,
    `${root}.lock`,
    {...LOCK_OPTIONS, waitTimeoutMilliseconds: 1000},
    Effect.gen(function* () {
      const current = yield* readIntent(home, scopeId);
      const next = yield* Effect.try({
        try: () => update(current?.requests ?? []),
        catch: () => CodeGraphScopeRetirementError.make({message: 'Scoped retirement intent capacity is unavailable.'}),
      });
      const currentKeys = EffectArray.map(current?.requests ?? [], requestKey);
      const nextKeys = EffectArray.map(next, requestKey);
      if (
        currentKeys.length === nextKeys.length &&
        EffectArray.every(currentKeys, (key, index) => key === nextKeys[index])
      )
        return;
      if (next.length === 0) {
        yield* fs.remove(file, {force: true});
        return;
      }
      const intent: ScopeRetirementIntent = {version: 1, scopeId, requests: next};
      const content = JSON.stringify(intent);
      if (!validIntent(path, intent, scopeId) || new TextEncoder().encode(content).length > MAXIMUM_BYTES)
        return yield* CodeGraphScopeRetirementError.make({message: 'Scoped retirement intent exceeds its bound.'});
      if (next.length > currentKeys.length) {
        const page = yield* intentFilePage(home);
        if (page.truncated)
          return yield* CodeGraphScopeRetirementError.make({
            message: 'Scoped retirement intent capacity is unavailable.',
          });
        const intents = yield* Effect.forEach(page.fileNames, fileName => readIntentFile(home, fileName), {
          concurrency: 1,
        });
        const requestCount = EffectArray.reduce(intents, 0, (total, value) => total + (value?.requests.length ?? 0));
        const projected = requestCount - currentKeys.length + next.length;
        if (projected > MAXIMUM_REQUESTS)
          return yield* CodeGraphScopeRetirementError.make({
            message: 'Scoped retirement intent capacity is unavailable.',
          });
      }
      const temporary = path.join(root, `${sha256HexSync(scopeId)}-${yield* crypto.randomUUIDv4()}.tmp`);
      const before = yield* fs.stat(root);
      yield* Effect.gen(function* () {
        yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
        yield* intentRoot(home, false);
        const after = yield* fs.stat(root);
        if (before.dev !== after.dev || Option.getOrUndefined(before.ino) !== Option.getOrUndefined(after.ino))
          return yield* CodeGraphScopeRetirementError.make({message: 'Scoped retirement directory changed.'});
        yield* fs.rename(temporary, file);
      }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
    }),
  );
});
