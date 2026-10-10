import {Effect, Fiber, FileSystem, Option, Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {type CommandExecutor, runBinaryCommandEffect, runCommandEffect} from '@threadnote/platform/command';
import {succeedUndefined} from '@threadnote/platform/optional';
import {platformPathFor, SystemInfo} from '@threadnote/platform/system';
import {CodeGraphRepositoryError, type RepositoryIdentity, type RepositoryIdentityExpectation} from './types.js';

const IDENTITY_FORMAT_VERSION = 1;
const GIT_DIRECTORY_OUTPUT_BYTES_MAXIMUM = 16 * 1_024;
const GIT_TEXT_OUTPUT_BYTES_MAXIMUM = 2 * 1_048_576;
const REPOSITORY_METADATA_BYTES_MAXIMUM = GIT_TEXT_OUTPUT_BYTES_MAXIMUM + GIT_DIRECTORY_OUTPUT_BYTES_MAXIMUM + 128;
const REPOSITORY_STATUS_OBSERVATION_BYTES_MAXIMUM = 64 * 1_024;

export const CODE_GRAPH_WORKTREE_REGISTRY_LIMITS = {
  maxOutputBytes: 8 * 1_048_576,
  maxPathBytes: 4_096,
  maxRecords: 4_096,
  timeoutMs: 10_000,
} as const;

export interface RepositoryWorktreeRegistryIdentity {
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly worktreeId: string;
}

interface RegisteredRepositoryWorktree extends RepositoryWorktreeRegistryIdentity {
  readonly root: string;
}

/** @internal Complete live observation used when a caller also needs the non-serializing git-dir detail. */
export const resolveRepositoryIdentityDetail = Effect.fn('codeGraph.resolveRepositoryIdentityDetail')(function* (
  cwd: string,
) {
  const result = yield* runBinaryCommandEffect(
    'git',
    [
      '-C',
      cwd,
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
      '--git-dir',
      '--show-object-format',
      'HEAD',
    ],
    {maxOutputBytes: REPOSITORY_METADATA_BYTES_MAXIMUM, timeoutMs: 30_000},
  ).pipe(
    Effect.catchTag('CommandFailed', () => succeedUndefined),
    Effect.mapError(cause => CodeGraphRepositoryError.make({message: `Not a Git repository: ${cause.message}`})),
  );
  // An unborn HEAD or an ambiguous frame must repeat complete discovery at the
  // original caller. Never combine a partial batch with later fallback fields.
  const metadata = result?.exitCode === 0 ? parseRepositoryIdentityMetadata(result.stdout) : undefined;
  return yield* resolveRepositoryIdentityDetailFromObservation(cwd, metadata);
});

/** Start a scoped worktree read, then bind it to the independently discovered local identity. */
export const startRepositoryWorktreeObservation = Effect.fn('codeGraph.startRepositoryWorktreeObservation')(function* (
  cwd: string,
) {
  const pending = yield* readRepositoryReadFenceWorktree(cwd).pipe(Effect.option, Effect.forkScoped);
  return (identity: RepositoryIdentity) =>
    Effect.gen(function* () {
      const output = yield* Fiber.join(pending);
      if (Option.isNone(output) || /^0+$/u.test(identity.headCommit)) return undefined;
      const worktree = yield* parseRepositoryReadFenceWorktree(output.value, identity.objectFormat);
      if (
        worktree.repoRoot !== identity.repoRoot ||
        worktree.gitCommonDirectory !== identity.gitCommonDirectory ||
        worktree.headCommit !== identity.headCommit
      ) {
        return yield* CodeGraphRepositoryError.make({
          message: 'Repository identity changed during the worktree observation.',
        });
      }
      return worktree.changed;
    });
});

const resolveRepositoryIdentityDetailFromObservation = Effect.fn(
  'codeGraph.resolveRepositoryIdentityDetailFromObservation',
)(function* (cwd: string, metadata: RepositoryIdentityMetadata | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const rootResult =
    metadata === undefined
      ? yield* runGit(cwd, ['rev-parse', '--show-toplevel']).pipe(
          Effect.mapError(cause => CodeGraphRepositoryError.make({message: `Not a Git repository: ${cause.message}`})),
        )
      : {stdout: metadata.repoRoot};
  const repoRoot = yield* fs.realPath(rootResult.stdout.trim());
  const [directories, formatResult, commitResult, ignoreCaseResult, remoteResult, branch] = yield* Effect.all(
    [
      metadata === undefined
        ? runBinaryCommandEffect(
            'git',
            ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'],
            {maxOutputBytes: GIT_DIRECTORY_OUTPUT_BYTES_MAXIMUM, timeoutMs: 30_000},
          ).pipe(Effect.map(result => parseGitDirectoryOutput(result.stdout)))
        : Effect.succeed(metadata),
      metadata === undefined
        ? runGit(repoRoot, ['rev-parse', '--show-object-format'])
        : Effect.succeed({stdout: metadata.objectFormat}),
      metadata === undefined
        ? runGit(repoRoot, ['rev-parse', 'HEAD'], true)
        : Effect.succeed({exitCode: 0, stdout: metadata.headCommit}),
      runGit(repoRoot, ['config', '--bool', 'core.ignorecase'], true),
      runGit(repoRoot, ['remote', 'get-url', 'origin'], true),
      observeRepositoryBranch(repoRoot),
    ],
    {concurrency: 6},
  );
  if (directories === undefined) {
    return yield* CodeGraphRepositoryError.make({message: 'Git repository directory metadata is invalid.'});
  }
  const commonRaw = directories.commonDirectory;
  const commonAbsolute = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repoRoot, commonRaw);
  const gitCommonDirectory = yield* fs.realPath(commonAbsolute);
  const objectFormat = formatResult.stdout.trim();
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    return yield* CodeGraphRepositoryError.make({message: `Unsupported Git object format: ${objectFormat}`});
  }
  const remoteIdentity =
    remoteResult.exitCode === 0 ? normalizeCredentialFreeRemote(remoteResult.stdout.trim()) : undefined;
  const repositorySource = remoteIdentity ?? `local:${normalizeLocalIdentity(gitCommonDirectory, system.platform)}`;
  const headCommit = commitResult.exitCode === 0 ? commitResult.stdout.trim() : zeroObjectId(objectFormat);
  const displayName = repositoryDisplayName(remoteIdentity, repoRoot);
  const identity = {
    ...(branch.state === 'current' ? {branch: branch.branch} : {}),
    caseMode:
      ignoreCaseResult.exitCode === 0 && ignoreCaseResult.stdout.trim().toLowerCase() === 'true'
        ? 'insensitive'
        : 'sensitive',
    checkoutId: checkoutIdForGitCommonDirectory(gitCommonDirectory),
    displayName,
    gitCommonDirectory,
    headCommit,
    objectFormat,
    remoteIdentity,
    repoRoot,
    repositoryId: sha256HexSync(`repository-v${IDENTITY_FORMAT_VERSION}\n${repositorySource}`),
    worktreeId: worktreeIdForRoot(repoRoot),
  } satisfies RepositoryIdentity;
  return {gitDirectory: directories.gitDirectory, identity};
});

interface RepositoryIdentityMetadata {
  readonly repoRoot: string;
  readonly commonDirectory: string;
  readonly gitDirectory: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly headCommit: string;
}

/** @internal Successful bounded Git metadata only; undefined requests fresh legacy discovery. */
export function parseRepositoryIdentityMetadata(output: Uint8Array): RepositoryIdentityMetadata | undefined {
  if (output.byteLength === 0 || output.byteLength > REPOSITORY_METADATA_BYTES_MAXIMUM) return undefined;
  try {
    const decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(output);
    if (!decoded.endsWith('\n')) return undefined;
    const records = decoded.slice(0, -1).split('\n');
    if (records.length !== 5 || records.some(record => !record || record.includes('\0') || record.includes('\r'))) {
      return undefined;
    }
    const [repoRoot, commonDirectory, gitDirectory, objectFormat, headCommit] = records;
    // Full discovery trims the root output. Preserve that behavior by declining
    // the fast path for roots whose edge whitespace would select a different path.
    if (repoRoot !== repoRoot.trim() || byteLength(`${repoRoot}\n`) > GIT_TEXT_OUTPUT_BYTES_MAXIMUM) return undefined;
    if (byteLength(`${commonDirectory}\n${gitDirectory}\n`) > GIT_DIRECTORY_OUTPUT_BYTES_MAXIMUM) return undefined;
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') return undefined;
    if (!(objectFormat === 'sha1' ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u).test(headCommit)) return undefined;
    return {repoRoot, commonDirectory, gitDirectory, objectFormat, headCommit};
  } catch {
    return undefined;
  }
}

export function normalizeRepositoryBranchName(value: string): string | undefined {
  const branch = value.trim();
  return branch.length > 0 &&
    new TextEncoder().encode(branch).byteLength <= 1_024 &&
    !hasControlCharacter(branch) &&
    !/\p{Bidi_Control}/u.test(branch)
    ? branch
    : undefined;
}

export const observeRepositoryBranch = Effect.fn('codeGraph.observeRepositoryBranch')(function* (cwd: string) {
  const result = yield* runCommandEffect('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowFailure: true,
    maxOutputBytes: 2_048,
    timeoutMs: 5_000,
  }).pipe(Effect.option);
  if (result._tag === 'None' || (result.value.exitCode !== 0 && result.value.exitCode !== 1)) {
    return {state: 'missing' as const};
  }
  if (result.value.exitCode === 1) return {state: 'detached' as const};
  const branch = normalizeRepositoryBranchName(result.value.stdout);
  return branch === undefined ? {state: 'missing' as const} : {branch, state: 'current' as const};
});

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}

export const resolveRepositoryIdentity = Effect.fn('codeGraph.resolveRepositoryIdentity')(function* (cwd: string) {
  return (yield* resolveRepositoryIdentityDetail(cwd)).identity;
});

/** Bounded cleanliness probe used by the clean-snapshot final read fence. */
export const observeCleanRepositoryWorktree = Effect.fn('codeGraph.observeCleanRepositoryWorktree')(function* (
  cwd: string,
) {
  const porcelain = yield* runCommandEffect(
    'git',
    ['--no-optional-locks', '-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    {maxOutputBytes: REPOSITORY_STATUS_OBSERVATION_BYTES_MAXIMUM, timeoutMs: 10_000},
  );
  return porcelain.stdout.length === 0 ? {dirty: false as const, fingerprint: undefined} : undefined;
});

/**
 * Reobserve the code-bearing parts of an identity for a final read fence.
 * Branch display and case-mode configuration cannot change the cited bytes, so
 * the already-validated values are retained while repository IDs and HEAD are
 * independently recomputed.
 */
export const revalidateRepositoryIdentityFence = Effect.fn('codeGraph.revalidateRepositoryIdentityFence')(function* (
  cwd: string,
  previous: RepositoryIdentity,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const [metadataResult, remoteResult] = yield* Effect.all(
    [
      runGit(cwd, [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-common-dir',
        '--show-object-format',
        'HEAD',
      ]),
      runGit(cwd, ['remote', 'get-url', 'origin'], true),
    ],
    {concurrency: 2},
  ).pipe(
    Effect.mapError(() => CodeGraphRepositoryError.make({message: 'Repository identity could not be revalidated.'})),
  );
  const metadata = metadataResult.stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
  if (metadata.length !== 4) {
    return yield* CodeGraphRepositoryError.make({message: 'Git repository identity metadata is invalid.'});
  }
  const repoRoot = yield* fs
    .realPath(metadata[0])
    .pipe(
      Effect.mapError(() => CodeGraphRepositoryError.make({message: 'Repository identity could not be revalidated.'})),
    );
  const commonRaw = metadata[1];
  const commonAbsolute = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repoRoot, commonRaw);
  const gitCommonDirectory = yield* fs
    .realPath(commonAbsolute)
    .pipe(
      Effect.mapError(() => CodeGraphRepositoryError.make({message: 'Repository identity could not be revalidated.'})),
    );
  const objectFormat = metadata[2];
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    return yield* CodeGraphRepositoryError.make({message: `Unsupported Git object format: ${objectFormat}`});
  }
  const remoteIdentity =
    remoteResult.exitCode === 0 ? normalizeCredentialFreeRemote(remoteResult.stdout.trim()) : undefined;
  const repositorySource = remoteIdentity ?? `local:${normalizeLocalIdentity(gitCommonDirectory, system.platform)}`;
  const identity = {
    ...(previous.branch === undefined ? {} : {branch: previous.branch}),
    caseMode: previous.caseMode,
    checkoutId: checkoutIdForGitCommonDirectory(gitCommonDirectory),
    displayName: repositoryDisplayName(remoteIdentity, repoRoot),
    gitCommonDirectory,
    headCommit: metadata[3],
    objectFormat,
    remoteIdentity,
    repoRoot,
    repositoryId: sha256HexSync(`repository-v${IDENTITY_FORMAT_VERSION}\n${repositorySource}`),
    worktreeId: worktreeIdForRoot(repoRoot),
  } satisfies RepositoryIdentity;
  if (
    identity.checkoutId !== previous.checkoutId ||
    identity.repositoryId !== previous.repositoryId ||
    identity.worktreeId !== previous.worktreeId
  ) {
    return yield* CodeGraphRepositoryError.make({message: 'Repository identity changed during the graph read.'});
  }
  return identity;
});

export interface PublishedRepositoryReadFenceInterlock {
  /** @internal Deterministic caller-retarget hook for focused validation tests. */
  readonly afterInitialIdentity?: () => Effect.Effect<void, unknown, CommandExecutor>;
  /** @internal Deterministic closing-observation hook for focused validation tests. */
  readonly beforeClosingWorktreeObservation?: () => Effect.Effect<void, unknown, CommandExecutor>;
}

/**
 * Close a published repository read after immutable evidence has been read.
 * Remote identity is read from the resolved root, then the original caller
 * receives the last code-bearing observation and reports the root/common-dir
 * Git actually opened. An intervening retarget, edit, or HEAD move cannot
 * satisfy the proof.
 */
export const resolvePublishedRepositoryReadFence = Effect.fn('codeGraph.resolvePublishedRepositoryReadFence')(
  function* (cwd: string, expected: RepositoryIdentityExpectation, interlock?: PublishedRepositoryReadFenceInterlock) {
    const system = yield* SystemInfo;
    const observed = yield* observeRepositoryReadFenceMetadata(cwd);
    yield* interlock?.afterInitialIdentity?.() ?? Effect.void;
    const remoteResult = yield* runGit(observed.repoRoot, ['remote', 'get-url', 'origin'], true).pipe(
      Effect.mapError(() =>
        CodeGraphRepositoryError.make({message: 'Repository read fence could not be revalidated.'}),
      ),
    );
    const remoteIdentity =
      remoteResult.exitCode === 0 ? normalizeCredentialFreeRemote(remoteResult.stdout.trim()) : undefined;
    const repositorySource =
      remoteIdentity ?? `local:${normalizeLocalIdentity(observed.gitCommonDirectory, system.platform)}`;
    const identity = {
      checkoutId: checkoutIdForGitCommonDirectory(observed.gitCommonDirectory),
      headCommit: observed.headCommit,
      repositoryId: sha256HexSync(`repository-v${IDENTITY_FORMAT_VERSION}\n${repositorySource}`),
      worktreeId: worktreeIdForRoot(observed.repoRoot),
    };
    if (!repositoryIdentityMatchesExpectation(identity, expected)) {
      return yield* CodeGraphRepositoryError.make({message: 'Repository identity changed during the graph read.'});
    }
    yield* interlock?.beforeClosingWorktreeObservation?.() ?? Effect.void;
    const worktree = yield* observeRepositoryReadFenceClosingWorktree(cwd, observed.objectFormat);
    if (
      worktree.repoRoot !== observed.repoRoot ||
      worktree.gitCommonDirectory !== observed.gitCommonDirectory ||
      worktree.headCommit !== observed.headCommit
    ) {
      return yield* CodeGraphRepositoryError.make({message: 'Repository identity changed during the graph read.'});
    }
    return {...identity, worktreeChanged: worktree.changed};
  },
);

const observeRepositoryReadFenceClosingWorktree = Effect.fn('codeGraph.observeRepositoryReadFenceClosingWorktree')(
  function* (cwd: string, objectFormat: RepositoryIdentity['objectFormat']) {
    return yield* parseRepositoryReadFenceWorktree(yield* readRepositoryReadFenceWorktree(cwd), objectFormat);
  },
);

const readRepositoryReadFenceWorktree = Effect.fn('codeGraph.readRepositoryReadFenceWorktree')(function* (cwd: string) {
  const system = yield* SystemInfo;
  return yield* runCommandEffect(
    'git',
    ['--no-optional-locks', '-C', cwd, 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal'],
    {
      env: repositoryReadFenceTraceEnvironment(system.environment()),
      maxOutputBytes: REPOSITORY_STATUS_OBSERVATION_BYTES_MAXIMUM,
      timeoutMs: 10_000,
    },
  ).pipe(
    Effect.mapError(() => CodeGraphRepositoryError.make({message: 'Repository read fence could not be revalidated.'})),
  );
});

const parseRepositoryReadFenceWorktree = Effect.fn('codeGraph.parseRepositoryReadFenceWorktree')(function* (
  status: {readonly stdout: string; readonly stderr: string},
  objectFormat: RepositoryIdentity['objectFormat'],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const worktree = parseRepositoryIdentityWorktreeObservation(status.stdout, objectFormat);
  const setup = parseRepositoryReadFenceSetupObservation(status.stderr);
  if (worktree === undefined || setup === undefined) {
    return yield* CodeGraphRepositoryError.make({message: 'Repository read fence could not be revalidated.'});
  }
  const repoRoot = yield* fs
    .realPath(setup.worktree)
    .pipe(
      Effect.mapError(() =>
        CodeGraphRepositoryError.make({message: 'Repository read fence could not be revalidated.'}),
      ),
    );
  const commonPath = path.isAbsolute(setup.gitCommonDirectory)
    ? setup.gitCommonDirectory
    : path.resolve(repoRoot, setup.gitCommonDirectory);
  const gitCommonDirectory = yield* fs
    .realPath(commonPath)
    .pipe(
      Effect.mapError(() =>
        CodeGraphRepositoryError.make({message: 'Repository read fence could not be revalidated.'}),
      ),
    );
  return {...worktree, gitCommonDirectory, repoRoot};
});

export function parseRepositoryReadFenceSetupObservation(
  output: string,
): {readonly gitCommonDirectory: string; readonly worktree: string} | undefined {
  const markers = {
    gitCommonDirectory: 'setup: git_common_dir: ',
    worktree: 'setup: worktree: ',
  } as const;
  const matches = {gitCommonDirectory: [] as string[], worktree: [] as string[]};
  const markerKeys: (keyof typeof markers)[] = ['gitCommonDirectory', 'worktree'];
  for (const line of output.split(/\r?\n/u)) {
    for (const key of markerKeys) {
      const index = line.indexOf(markers[key]);
      if (index >= 0) matches[key].push(line.slice(index + markers[key].length));
    }
  }
  if (matches.gitCommonDirectory.length !== 1 || matches.worktree.length !== 1) return undefined;
  const gitCommonDirectory = matches.gitCommonDirectory[0];
  const worktree = matches.worktree[0];
  if (
    gitCommonDirectory.length === 0 ||
    worktree.length === 0 ||
    gitCommonDirectory === '(null)' ||
    worktree === '(null)' ||
    hasControlCharacter(gitCommonDirectory) ||
    hasControlCharacter(worktree) ||
    /\p{Bidi_Control}/u.test(gitCommonDirectory) ||
    /\p{Bidi_Control}/u.test(worktree)
  ) {
    return undefined;
  }
  return {gitCommonDirectory, worktree};
}

function repositoryReadFenceTraceEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
    GIT_TRACE: '0',
    GIT_TRACE2: '0',
    GIT_TRACE2_EVENT: '0',
    GIT_TRACE2_PERF: '0',
    GIT_TRACE_BARE: '0',
    GIT_TRACE_CURL: '0',
    GIT_TRACE_PACKET: '0',
    GIT_TRACE_PERFORMANCE: '0',
    GIT_TRACE_REFS: '0',
    GIT_TRACE_SETUP: '1',
    GIT_TRACE_SHALLOW: '0',
  };
}

const observeRepositoryReadFenceMetadata = Effect.fn('codeGraph.observeRepositoryReadFenceMetadata')(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const result = yield* runGit(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-common-dir',
    '--show-object-format',
    'HEAD',
  ]).pipe(
    Effect.mapError(() => CodeGraphRepositoryError.make({message: 'Repository read fence could not be revalidated.'})),
  );
  const metadata = result.stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
  if (metadata.length !== 4) {
    return yield* CodeGraphRepositoryError.make({message: 'Git repository identity metadata is invalid.'});
  }
  const repoRoot = yield* fs.realPath(metadata[0]);
  const commonRaw = metadata[1];
  const commonAbsolute = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repoRoot, commonRaw);
  const gitCommonDirectory = yield* fs.realPath(commonAbsolute);
  const objectFormat = metadata[2];
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    return yield* CodeGraphRepositoryError.make({message: `Unsupported Git object format: ${objectFormat}`});
  }
  const headCommit = metadata[3];
  const expectedLength = objectFormat === 'sha256' ? 64 : 40;
  if (!new RegExp(`^[0-9a-f]{${expectedLength}}$`, 'u').test(headCommit)) {
    return yield* CodeGraphRepositoryError.make({message: 'Git repository identity metadata is invalid.'});
  }
  return {
    gitCommonDirectory,
    headCommit,
    objectFormat,
    repoRoot,
  } satisfies Pick<RepositoryIdentity, 'gitCommonDirectory' | 'headCommit' | 'objectFormat' | 'repoRoot'>;
});

/**
 * Revalidate a previously published repository identity without repeating the
 * full discovery path. The expected repository ID remains independently
 * recomputed from the current remote or local checkout before it is trusted.
 */
export const resolveRepositoryIdentityForExpectation = Effect.fn('codeGraph.resolveRepositoryIdentityForExpectation')(
  function* (cwd: string, expected: RepositoryIdentityExpectation) {
    return (yield* resolveExpectedRepositoryIdentity(cwd, expected, false)).identity;
  },
);

/**
 * Revalidate a published member while co-observing its HEAD and clean/changed
 * bit. The common clean path avoids a second serial Git status process; a
 * changed path still falls back to the policy-aware overlay inventory.
 */
export const resolveRepositoryIdentityForExpectationAndWorktree = Effect.fn(
  'codeGraph.resolveRepositoryIdentityForExpectationAndWorktree',
)(function* (cwd: string, expected: RepositoryIdentityExpectation) {
  const observation = yield* resolveExpectedRepositoryIdentity(cwd, expected, true);
  return {identity: observation.identity, worktreeChanged: observation.worktreeChanged!};
});

const resolveExpectedRepositoryIdentity = Effect.fn('codeGraph.resolveExpectedRepositoryIdentity')(function* (
  cwd: string,
  expected: RepositoryIdentityExpectation,
  observeWorktree: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  // Bind every later observation to the checkout selected by this metadata read.
  // Running remote/config against the caller in parallel can mix an ABA-retargeted
  // caller's values with this checkout even when both checkouts share the same HEAD.
  const metadataResult = yield* runGit(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-common-dir',
    '--show-object-format',
    'HEAD',
  ]).pipe(
    Effect.mapError(() => CodeGraphRepositoryError.make({message: 'Repository identity could not be revalidated.'})),
  );
  const metadata = metadataResult.stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
  if (metadata.length !== 4) {
    return yield* CodeGraphRepositoryError.make({message: 'Git repository identity metadata is invalid.'});
  }
  const repoRoot = yield* fs
    .realPath(metadata[0])
    .pipe(
      Effect.mapError(() => CodeGraphRepositoryError.make({message: 'Repository identity could not be revalidated.'})),
    );
  const commonRaw = metadata[1];
  const commonAbsolute = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(repoRoot, commonRaw);
  const gitCommonDirectory = yield* fs
    .realPath(commonAbsolute)
    .pipe(
      Effect.mapError(() => CodeGraphRepositoryError.make({message: 'Repository identity could not be revalidated.'})),
    );
  const objectFormat = metadata[2];
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    return yield* CodeGraphRepositoryError.make({message: `Unsupported Git object format: ${objectFormat}`});
  }
  const branchOrWorktree = observeWorktree
    ? observeRepositoryReadFenceClosingWorktree(cwd, objectFormat).pipe(
        Effect.map(worktree => ({kind: 'worktree' as const, worktree})),
      )
    : observeRepositoryBranch(repoRoot).pipe(Effect.map(branch => ({branch, kind: 'branch' as const})));
  const [ignoreCaseResult, remoteResult, observed] = yield* Effect.all(
    [
      runGit(repoRoot, ['config', '--bool', 'core.ignorecase'], true),
      runGit(repoRoot, ['remote', 'get-url', 'origin'], true),
      branchOrWorktree,
    ],
    {concurrency: 3},
  ).pipe(
    Effect.mapError(() => CodeGraphRepositoryError.make({message: 'Repository identity could not be revalidated.'})),
  );
  const worktree = observed.kind === 'worktree' ? observed.worktree : undefined;
  if (
    worktree !== undefined &&
    (worktree.headCommit !== metadata[3] ||
      worktree.repoRoot !== repoRoot ||
      worktree.gitCommonDirectory !== gitCommonDirectory)
  ) {
    return yield* CodeGraphRepositoryError.make({
      message: 'Repository identity changed during the worktree observation.',
    });
  }
  const branch = observed.kind === 'branch' ? observed.branch : worktree!.branch;
  const remoteIdentity =
    remoteResult.exitCode === 0 ? normalizeCredentialFreeRemote(remoteResult.stdout.trim()) : undefined;
  const repositorySource = remoteIdentity ?? `local:${normalizeLocalIdentity(gitCommonDirectory, system.platform)}`;
  const identity = {
    ...(branch.state === 'current' ? {branch: branch.branch} : {}),
    caseMode:
      ignoreCaseResult.exitCode === 0 && ignoreCaseResult.stdout.trim().toLowerCase() === 'true'
        ? 'insensitive'
        : 'sensitive',
    checkoutId: checkoutIdForGitCommonDirectory(gitCommonDirectory),
    displayName: repositoryDisplayName(remoteIdentity, repoRoot),
    gitCommonDirectory,
    headCommit: metadata[3],
    objectFormat,
    remoteIdentity,
    repoRoot,
    repositoryId: sha256HexSync(`repository-v${IDENTITY_FORMAT_VERSION}\n${repositorySource}`),
    worktreeId: worktreeIdForRoot(repoRoot),
  } satisfies RepositoryIdentity;
  if (!repositoryIdentityMatchesExpectation(identity, expected)) {
    return yield* CodeGraphRepositoryError.make({message: 'Repository identity does not match the published workset.'});
  }
  return {
    identity,
    ...(worktree === undefined ? {} : {worktreeChanged: worktree.changed}),
  };
});

export function parseRepositoryIdentityWorktreeObservation(
  output: string,
  objectFormat: RepositoryIdentity['objectFormat'],
):
  | {
      readonly branch: {readonly branch?: string; readonly state: 'current' | 'detached' | 'missing'};
      readonly changed: boolean;
      readonly headCommit: string;
    }
  | undefined {
  if (!output.endsWith('\0')) return undefined;
  const records = output.slice(0, -1).split('\0');
  const heads = records.filter(record => record.startsWith('# branch.oid '));
  const branches = records.filter(record => record.startsWith('# branch.head '));
  if (heads.length !== 1 || branches.length > 1) return undefined;
  const headCommit = heads[0].slice('# branch.oid '.length);
  const expectedLength = objectFormat === 'sha256' ? 64 : 40;
  if (!new RegExp(`^[0-9a-f]{${expectedLength}}$`, 'u').test(headCommit)) return undefined;
  const rawBranch = branches[0]?.slice('# branch.head '.length);
  const branch =
    rawBranch === '(detached)'
      ? ({state: 'detached'} as const)
      : rawBranch === undefined
        ? ({state: 'missing'} as const)
        : normalizeRepositoryBranchName(rawBranch) === undefined
          ? ({state: 'missing'} as const)
          : ({branch: normalizeRepositoryBranchName(rawBranch), state: 'current'} as const);
  return {
    branch,
    changed: records.some(record => !record.startsWith('# ')),
    headCommit,
  };
}

/**
 * Return a bounded, pathless diagnostic observation from Git's porcelain output.
 *
 * This is not deletion authority: Git may probe registered worktree paths while
 * producing the listing, so timeout/failure/absence must remain non-destructive.
 * F1/E4 reconciliation requires a separate bounded common-gitdir observation.
 */
export const repositoryWorktreeRegistry = Effect.fn('codeGraph.repositoryWorktreeRegistry')(function* (
  identity: RepositoryIdentity,
) {
  const system = yield* SystemInfo;
  const result = yield* runBinaryCommandEffect(
    'git',
    ['-C', identity.repoRoot, 'worktree', 'list', '--porcelain', '-z'],
    {
      maxOutputBytes: CODE_GRAPH_WORKTREE_REGISTRY_LIMITS.maxOutputBytes,
      timeoutMs: CODE_GRAPH_WORKTREE_REGISTRY_LIMITS.timeoutMs,
    },
  ).pipe(Effect.mapError(() => CodeGraphRepositoryError.make({message: 'Unable to read the Git worktree registry.'})));
  const output = yield* Effect.try({
    catch: () => CodeGraphRepositoryError.make({message: 'Git worktree registry output is invalid.'}),
    try: () => new TextDecoder('utf-8', {fatal: true}).decode(result.stdout),
  });
  return yield* Effect.try({
    catch: () => CodeGraphRepositoryError.make({message: 'Git worktree registry output is invalid.'}),
    try: () => parseRepositoryWorktreeRegistryOutput(output, system.platform),
  });
});

export function parseRepositoryWorktreeRegistryOutput(
  output: string,
  platform: NodeJS.Platform,
): readonly RepositoryWorktreeRegistryIdentity[] {
  return parseRegisteredRepositoryWorktrees(output, platform)
    .map(({locked, prunable, worktreeId}) => ({locked, prunable, worktreeId}))
    .sort((left, right) => compareCodeUnits(left.worktreeId, right.worktreeId));
}

function parseRegisteredRepositoryWorktrees(
  output: string,
  platform: NodeJS.Platform,
): readonly RegisteredRepositoryWorktree[] {
  const invalid = () => CodeGraphRepositoryError.make({message: 'Git worktree registry output is invalid.'});
  if (
    byteLength(output) > CODE_GRAPH_WORKTREE_REGISTRY_LIMITS.maxOutputBytes ||
    output.length === 0 ||
    !output.endsWith('\0\0')
  ) {
    throw invalid();
  }
  const body = output.slice(0, -2);
  if (body.length === 0) throw invalid();
  const records = body.split('\0\0');
  if (records.length > CODE_GRAPH_WORKTREE_REGISTRY_LIMITS.maxRecords) throw invalid();
  const path = platformPathFor(platform);
  const seen = new Set<string>();
  return records.map(record => {
    const fields = record.split('\0');
    if (fields.some(field => field.length === 0)) throw invalid();
    const worktreeFields = fields.filter(field => field.startsWith('worktree '));
    if (worktreeFields.length !== 1) throw invalid();
    const rawRoot = worktreeFields[0].slice('worktree '.length);
    if (!rawRoot || byteLength(rawRoot) > CODE_GRAPH_WORKTREE_REGISTRY_LIMITS.maxPathBytes) throw invalid();
    const root = path.normalize(rawRoot);
    if (!path.isAbsolute(rawRoot) || !path.isAbsolute(root)) throw invalid();
    const key = platform === 'win32' ? root.toLowerCase() : root;
    if (seen.has(key)) throw invalid();
    seen.add(key);
    return {
      locked: fields.some(field => field === 'locked' || field.startsWith('locked ')),
      prunable: fields.some(field => field === 'prunable' || field.startsWith('prunable ')),
      root,
      worktreeId: worktreeIdForRoot(root),
    };
  });
}

export const repositoryChangesSince = Effect.fn('codeGraph.repositoryChangesSince')(function* (
  cwd: string,
  base: string,
) {
  const verified = yield* runCommandEffect(
    'git',
    ['-C', cwd, 'rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
    {
      maxOutputBytes: 1_024,
      timeoutMs: 30_000,
    },
  );
  const objectId = verified.stdout.trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(objectId)) {
    return yield* CodeGraphRepositoryError.make({message: `Git resolved ${base} to an invalid object ID.`});
  }
  const [tracked, untracked] = yield* Effect.all(
    [
      runCommandEffect('git', ['-C', cwd, 'diff', '--name-only', '-z', objectId, '--'], {
        maxOutputBytes: 0,
        timeoutMs: 0,
      }),
      runCommandEffect('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard', '-z'], {
        maxOutputBytes: 0,
        timeoutMs: 0,
      }),
    ],
    {concurrency: 2},
  );
  const paths = [...new Set(`${tracked.stdout}\0${untracked.stdout}`.split('\0').filter(Boolean))].sort();
  if (paths.length === 0)
    return yield* CodeGraphRepositoryError.make({message: `No changed paths found relative to ${base}.`});
  return {baseCommit: objectId, paths};
});

export function worktreeIdForRoot(repoRoot: string): string {
  return sha256HexSync(`worktree-v${IDENTITY_FORMAT_VERSION}\n${repoRoot}`);
}

function checkoutIdForGitCommonDirectory(gitCommonDirectory: string): string {
  return sha256HexSync(`checkout-v${IDENTITY_FORMAT_VERSION}\n${gitCommonDirectory}`);
}

export function repositoryIdentityMatchesExpectation(
  identity: RepositoryIdentityExpectation,
  expected: RepositoryIdentityExpectation,
): boolean {
  return (
    identity.checkoutId === expected.checkoutId &&
    identity.repositoryId === expected.repositoryId &&
    identity.worktreeId === expected.worktreeId
  );
}

function runGit(cwd: string, args: readonly string[], allowFailure = false) {
  return runCommandEffect('git', ['-C', cwd, ...args], {
    allowFailure,
    maxOutputBytes: GIT_TEXT_OUTPUT_BYTES_MAXIMUM,
    timeoutMs: 30_000,
  });
}

export function normalizeCredentialFreeRemote(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0') || /[\r\n]/.test(trimmed)) return undefined;
  const scp = trimmed.includes('://') ? undefined : /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(trimmed);
  if (scp && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return normalizeRemoteParts(scp[1], scp[2]);
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'file:') return undefined;
    return normalizeRemoteParts(url.hostname, url.pathname);
  } catch {
    return undefined;
  }
}

function normalizeRemoteParts(host: string, pathname: string): string | undefined {
  const safeHost = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const safePath = pathname
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!safeHost || !safePath || safePath.includes('..')) return undefined;
  return `${safeHost}/${safePath}`;
}

function normalizeLocalIdentity(value: string, platform: NodeJS.Platform): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function repositoryDisplayName(remoteIdentity: string | undefined, repoRoot: string): string {
  const source = remoteIdentity ?? repoRoot.replaceAll('\\', '/');
  const parts = source.split('/').filter(Boolean);
  return (remoteIdentity ? parts.slice(-2).join('/') : parts.at(-1)) || 'repository';
}

function zeroObjectId(format: 'sha1' | 'sha256'): string {
  return '0'.repeat(format === 'sha256' ? 64 : 40);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseGitDirectoryOutput(
  output: Uint8Array,
): {readonly commonDirectory: string; readonly gitDirectory: string} | undefined {
  if (output.byteLength === 0 || output.byteLength > GIT_DIRECTORY_OUTPUT_BYTES_MAXIMUM) return undefined;
  try {
    const decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(output);
    if (!decoded.endsWith('\n')) return undefined;
    const records = decoded.slice(0, -1).split('\n');
    if (
      records.length !== 2 ||
      records.some(record => record.length === 0 || record.includes('\0') || record.includes('\r'))
    ) {
      return undefined;
    }
    return {commonDirectory: records[0], gitDirectory: records[1]};
  } catch {
    return undefined;
  }
}
