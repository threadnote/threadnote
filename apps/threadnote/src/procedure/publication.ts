import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withSharedRepositoryLock} from '../effect/share/lock.js';
import {
  assertShareTeamWritable,
  assertSharedWorktreeFileReady,
  resolveTeam,
  scrubberBlocker,
  writeSharedWorktreeFile,
  type ResolvedTeam,
} from '../share/index.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {requiredExecutable, runCommand} from '../utils.js';
import {
  canonicalProcedureManifest,
  canonicalProcedureVerificationReceipt,
  isPublishableProcedureManifest,
  parseProcedureManifest,
  parseProcedureVerificationReceipt,
  procedureStatus,
  type ProcedureManifestV2,
} from '@threadnote/context/procedure/contract';
import {decodeExactProcedureText} from '@threadnote/context/procedure/exact_text';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MAXIMUM_PROCEDURE_ARTIFACT_BYTES = 1024 * 1024;
const MAXIMUM_PROCEDURE_JSON_BYTES = 256 * 1024;
const PROCEDURE_PROPOSAL_PREFIX = 'procedure-v1';
const GIT_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export class ProcedurePublicationError extends Schema.TaggedError<
  ProcedurePublicationError,
  {readonly brand: unique symbol}
>()('ProcedurePublicationError', {message: Schema.String}) {}

export interface ProcedurePublishOptions {
  readonly apply?: boolean;
  readonly approved?: boolean;
  readonly artifact: string;
  readonly manifest: string;
  readonly proposalId?: string;
  readonly push?: boolean;
  readonly receipt: string;
  readonly team?: string;
}

export interface ProcedurePublicationTargetObservation {
  readonly expectedBlobId: string;
  readonly path: string;
  readonly state: 'absent' | 'exact';
}

export interface ProcedurePublicationPlan {
  readonly artifact: {readonly id: string; readonly semanticVersion: string; readonly sha256: string};
  readonly mode: 'apply' | 'preview';
  readonly paths: readonly string[];
  readonly proposalId: string;
  readonly push: boolean;
  readonly repository: {
    readonly baseCommit: string;
    readonly branchRef: string;
    readonly repositoryId: string;
    readonly targets: readonly ProcedurePublicationTargetObservation[];
  };
  readonly team: string;
  readonly version: 1;
}

interface PreparedPublicationInputs {
  readonly artifactContent: string;
  readonly contents: readonly [string, string, string];
  readonly manifest: ProcedureManifestV2;
  readonly manifestContent: string;
  readonly paths: readonly [string, string, string];
  readonly receiptContent: string;
  readonly team: ResolvedTeam;
}

interface PreparedPublicationPlan {
  readonly expectedBlobIds: readonly [string, string, string];
  readonly plan: ProcedurePublicationPlan;
  readonly worktree: string;
}

export const publishVerifiedProcedure = Effect.fn('procedure.publish')(function* (
  config: RuntimeConfig,
  options: ProcedurePublishOptions,
) {
  if (options.apply !== true) {
    return yield* withSharedRepositoryLock(
      config,
      Effect.gen(function* () {
        const inputs = yield* preparePublicationInputs(config, options);
        return (yield* preparePublicationPlan(inputs, 'preview', options.push === true)).plan;
      }),
    );
  }
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve optional-chain narrowing for the proposal identifier.
  if (options.approved !== true || !options.proposalId?.trim()) {
    return yield* publicationFailure('Procedure publication requires --approved and the exact preview --proposal-id.');
  }
  const approvedBase = yield* proposalBaseCommit(options.proposalId);
  return yield* withSharedRepositoryLock(
    config,
    Effect.gen(function* () {
      const inputs = yield* preparePublicationInputs(config, options);
      assertShareTeamWritable(inputs.team, 'publish a verified procedure');
      const prepared = yield* preparePublicationPlan(inputs, 'apply', options.push === true, approvedBase);
      if (prepared.plan.proposalId !== options.proposalId) {
        return yield* publicationFailure('Procedure publication inputs changed after preview; review a new proposal.');
      }
      yield* applyPreparedPublication(inputs, prepared);
      return prepared.plan;
    }),
  );
});

const preparePublicationInputs = Effect.fn('procedure.publish.prepareInputs')(function* (
  config: RuntimeConfig,
  options: ProcedurePublishOptions,
) {
  const [manifestValue, receiptValue, artifactContent, team] = yield* Effect.all(
    [
      readBoundedJson(yield* explicitLocalPath(options.manifest), MAXIMUM_PROCEDURE_JSON_BYTES),
      readBoundedJson(yield* explicitLocalPath(options.receipt), MAXIMUM_PROCEDURE_JSON_BYTES),
      readBoundedText(yield* explicitLocalPath(options.artifact), MAXIMUM_PROCEDURE_ARTIFACT_BYTES),
      resolveTeam(config, options.team),
    ],
    {concurrency: 4},
  );
  const manifest = yield* parseContract(() => parseProcedureManifest(manifestValue), 'Procedure manifest is invalid.');
  if (!isPublishableProcedureManifest(manifest)) {
    return yield* publicationFailure('Procedure publication requires a schemaVersion 2 manifest.');
  }
  const rawReceipt =
    typeof receiptValue === 'object' && receiptValue !== null && 'receipt' in receiptValue
      ? receiptValue.receipt
      : receiptValue;
  const receipt = yield* parseContract(
    () => parseProcedureVerificationReceipt(rawReceipt),
    'Procedure verification receipt is invalid.',
  );
  const artifactSha256 = sha256HexSync(artifactContent);
  if (
    procedureStatus(manifest, {
      capabilities: manifest.compatible.capabilities,
      localArtifactSha256: artifactSha256,
      receipt,
      surfaceIds: manifest.compatible.surfaceIds,
    }) !== 'current'
  ) {
    return yield* publicationFailure('Only exact, currently verified procedure bytes can be published.');
  }
  const manifestContent = canonicalProcedureManifest(manifest);
  const receiptContent = canonicalProcedureVerificationReceipt(receipt);
  for (const [label, content] of [
    ['manifest', manifestContent],
    ['receipt', receiptContent],
    ['artifact', artifactContent],
  ] as const) {
    const blocker = scrubberBlocker(content);
    if (blocker !== undefined) return yield* publicationFailure(`Procedure ${label} contains possible ${blocker}.`);
  }
  const artifactIdHash = sha256HexSync(manifest.artifact.id);
  const root = `agent-artifacts/procedures/${artifactIdHash}/${manifest.artifact.semanticVersion}`;
  const paths = [`${root}/manifest.json`, `${root}/receipt.json`, `${root}/artifact.txt`] as const;
  return {
    artifactContent,
    contents: [manifestContent, receiptContent, artifactContent] as const,
    manifest,
    manifestContent,
    paths,
    receiptContent,
    team,
  } satisfies PreparedPublicationInputs;
});

const preparePublicationPlan = Effect.fn('procedure.publish.preparePlan')(function* (
  inputs: PreparedPublicationInputs,
  mode: ProcedurePublicationPlan['mode'],
  push: boolean,
  approvedBase?: string,
) {
  const worktree = inputs.team.config.worktree;
  const repository = yield* resolveRepositoryIdentity(worktree).pipe(
    Effect.mapError(() => publicationFailure('Could not resolve the shared Git repository identity.')),
  );
  if (repository.branch === undefined) {
    return yield* publicationFailure('Procedure publication requires a checked-out shared Git branch.');
  }
  const baseCommit = approvedBase ?? repository.headCommit;
  if (!validObjectId(baseCommit, repository.objectFormat)) {
    return yield* publicationFailure('Procedure publication base commit is invalid for this repository.');
  }
  const git = yield* requiredExecutable('git');
  const baseExists = yield* runCommand(git, ['-C', worktree, 'cat-file', '-e', `${baseCommit}^{commit}`], {
    allowFailure: true,
  });
  if (baseExists.exitCode !== 0) {
    return yield* publicationFailure('Procedure publication base commit is no longer available.');
  }
  const expectedBlobIds: [string, string, string] = [
    yield* gitObjectId(git, worktree, ['hash-object', '--stdin'], new TextEncoder().encode(inputs.contents[0])),
    yield* gitObjectId(git, worktree, ['hash-object', '--stdin'], new TextEncoder().encode(inputs.contents[1])),
    yield* gitObjectId(git, worktree, ['hash-object', '--stdin'], new TextEncoder().encode(inputs.contents[2])),
  ];
  const targets = yield* Effect.forEach(inputs.paths, (path, index) =>
    observeTarget(git, worktree, baseCommit, path, expectedBlobIds[index]),
  );
  const branchRef = `refs/heads/${repository.branch}`;
  const proposalDigest = sha256HexSync(
    JSON.stringify({
      artifactSha256: inputs.manifest.artifact.sha256,
      manifestSha256: sha256HexSync(inputs.manifestContent),
      paths: inputs.paths,
      push,
      receiptSha256: sha256HexSync(inputs.receiptContent),
      repository: {baseCommit, branchRef, repositoryId: repository.repositoryId, targets},
      team: inputs.team.name,
      version: 1,
    }),
  );
  const plan = {
    artifact: inputs.manifest.artifact,
    mode,
    paths: inputs.paths,
    proposalId: `${PROCEDURE_PROPOSAL_PREFIX}.${baseCommit}.${proposalDigest}`,
    push,
    repository: {baseCommit, branchRef, repositoryId: repository.repositoryId, targets},
    team: inputs.team.name,
    version: 1 as const,
  } satisfies ProcedurePublicationPlan;
  return {expectedBlobIds, plan, worktree};
});

const applyPreparedPublication = Effect.fn('procedure.publish.apply')(function* (
  inputs: PreparedPublicationInputs,
  prepared: PreparedPublicationPlan,
) {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* requiredExecutable('git');
  const {baseCommit, branchRef} = prepared.plan.repository;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-procedure-index-'});
      const path = yield* Path.Path;
      const privateIndex = path.join(temporary, 'index');
      const runPrivate = (args: readonly string[], input?: Uint8Array) =>
        runCommand(git, ['-C', prepared.worktree, ...args], {
          ...(input === undefined ? {} : {input}),
          trustedGitIndexFile: privateIndex,
        });
      yield* runPrivate(['read-tree', baseCommit]);
      const blobIds = yield* Effect.forEach(inputs.contents, content =>
        runPrivate(['hash-object', '-w', '--stdin'], new TextEncoder().encode(content)).pipe(
          Effect.flatMap(result => requireObjectId(result.stdout)),
        ),
      );
      if (EffectArray.some(blobIds, (blob, index) => blob !== prepared.expectedBlobIds[index])) {
        return yield* publicationFailure('Procedure publication blob identity changed after preview.');
      }
      for (const [index, relativePath] of inputs.paths.entries()) {
        yield* runPrivate(['update-index', '--add', '--cacheinfo', '100644', blobIds[index], relativePath]);
      }
      const tree = yield* runPrivate(['write-tree']).pipe(Effect.flatMap(result => requireObjectId(result.stdout)));
      const baseTree = yield* gitObjectId(git, prepared.worktree, ['rev-parse', `${baseCommit}^{tree}`]);
      const current = yield* gitObjectId(git, prepared.worktree, ['rev-parse', 'HEAD']);
      const retry =
        current === baseCommit
          ? false
          : yield* isExactPublicationRetry(git, prepared.worktree, current, baseCommit, tree);
      if (current !== baseCommit && !retry) {
        return yield* publicationFailure('Shared Git base changed after preview; review a new procedure proposal.');
      }
      if (!retry) yield* assertProcedureIndexReady(git, prepared.worktree, inputs.paths);
      for (const [index, relativePath] of inputs.paths.entries()) {
        yield* assertSharedWorktreeFileReady(
          prepared.worktree,
          relativePath,
          inputs.contents[index],
          false,
          (currentContent, expectedContent) => currentContent === expectedContent,
        );
      }
      let commit = current;
      if (!retry && tree !== baseTree) {
        commit = yield* runPrivate(
          ['-c', 'user.name=Threadnote', '-c', 'user.email=threadnote@invalid', 'commit-tree', tree, '-p', baseCommit],
          new TextEncoder().encode(
            `procedure: publish ${prepared.plan.artifact.id}@${prepared.plan.artifact.semanticVersion}\n`,
          ),
        ).pipe(Effect.flatMap(result => requireObjectId(result.stdout)));
        yield* runCommand(git, [
          '-c',
          'core.hooksPath=/dev/null',
          '-C',
          prepared.worktree,
          'update-ref',
          branchRef,
          commit,
          baseCommit,
        ]);
      }
      for (const [index, relativePath] of inputs.paths.entries()) {
        yield* writeSharedWorktreeFile(prepared.worktree, relativePath, inputs.contents[index]);
      }
      if (commit !== baseCommit) {
        const indexInput = new TextEncoder().encode(
          EffectArray.join(
            EffectArray.map(inputs.paths, (relativePath, index) => `100644 ${blobIds[index]}\t${relativePath}\u0000`),
            '',
          ),
        );
        yield* runCommand(git, ['-C', prepared.worktree, 'update-index', '-z', '--index-info'], {input: indexInput});
      }
      if (prepared.plan.push) {
        yield* runCommand(git, [
          '-c',
          'core.hooksPath=/dev/null',
          '-C',
          prepared.worktree,
          'push',
          'origin',
          `${commit}:${branchRef}`,
        ]);
      }
    }),
  );
});

const observeTarget = Effect.fn('procedure.publish.observeTarget')(function* (
  git: string,
  worktree: string,
  baseCommit: string,
  relativePath: string,
  expectedBlobId: string,
) {
  const result = yield* runCommand(git, ['-C', worktree, 'ls-tree', '-z', baseCommit, '--', relativePath]);
  if (result.stdout.length === 0) {
    return {expectedBlobId, path: relativePath, state: 'absent'} satisfies ProcedurePublicationTargetObservation;
  }
  const records = EffectArray.filter(Effect2.pipe(result.stdout, EffectString.split('\u0000')), Boolean);
  if (records.length !== 1) return yield* publicationFailure('Procedure publication target is ambiguous.');
  const match = /^(\d{6}) blob ([a-f0-9]{40}|[a-f0-9]{64})\t/u.exec(records[0]);
  if (!match || match[1] !== '100644' || match[2] !== expectedBlobId) {
    return yield* publicationFailure(`Procedure publication target changed: ${relativePath}.`);
  }
  return {expectedBlobId, path: relativePath, state: 'exact'} satisfies ProcedurePublicationTargetObservation;
});

const assertProcedureIndexReady = Effect.fn('procedure.publish.assertIndexReady')(function* (
  git: string,
  worktree: string,
  paths: readonly string[],
) {
  const unmerged = yield* runCommand(git, ['-C', worktree, 'ls-files', '-u', '--', ...paths], {allowFailure: true});
  if (unmerged.exitCode !== 0 || unmerged.stdout.length > 0) {
    return yield* publicationFailure('Procedure publication targets contain unmerged Git index entries.');
  }
  const staged = yield* runCommand(git, ['-C', worktree, 'diff', '--cached', '--quiet', '--', ...paths], {
    allowFailure: true,
  });
  if (staged.exitCode === 1) {
    return yield* publicationFailure('Procedure publication targets contain staged changes.');
  }
  if (staged.exitCode !== 0) return yield* publicationFailure('Could not inspect procedure publication index state.');
});

const isExactPublicationRetry = Effect.fn('procedure.publish.isExactRetry')(function* (
  git: string,
  worktree: string,
  current: string,
  baseCommit: string,
  expectedTree: string,
) {
  const [parents, tree] = yield* Effect.all(
    [
      runCommand(git, ['-C', worktree, 'rev-list', '--parents', '-n', '1', current]),
      runCommand(git, ['-C', worktree, 'rev-parse', `${current}^{tree}`]),
    ],
    {concurrency: 2},
  );
  const parentFields = Effect2.pipe(parents.stdout, EffectString.trim, EffectString.split(/\s+/u));
  return (
    parentFields.length === 2 &&
    parentFields[1] === baseCommit &&
    Effect2.pipe(tree.stdout, EffectString.trim) === expectedTree
  );
});

const gitObjectId = Effect.fn('procedure.publish.gitObjectId')(function* (
  git: string,
  worktree: string,
  args: readonly string[],
  input?: Uint8Array,
) {
  const result = yield* runCommand(git, ['-C', worktree, ...args], input === undefined ? {} : {input});
  return yield* requireObjectId(result.stdout);
});

function requireObjectId(value: string): Effect.Effect<string, ProcedurePublicationError> {
  const objectId = Effect2.pipe(value, EffectString.trim);
  return GIT_OBJECT_ID_PATTERN.test(objectId)
    ? Effect.succeed(objectId)
    : Effect.fail(publicationFailure('Git returned an invalid procedure publication object ID.'));
}

const proposalBaseCommit = Effect.fn('procedure.publish.proposalBase')(function* (proposalId: string) {
  const match = new RegExp(`^${PROCEDURE_PROPOSAL_PREFIX}\\.([a-f0-9]{40}|[a-f0-9]{64})\\.[a-f0-9]{64}$`, 'u').exec(
    Effect2.pipe(proposalId, EffectString.trim),
  );
  if (!match) return yield* publicationFailure('Procedure proposal ID is invalid; review a new proposal.');
  return match[1];
});

const explicitLocalPath = Effect.fn('procedure.publish.localPath')(function* (value: string) {
  if (!Effect2.pipe(value, EffectString.trim) || Effect2.pipe(value, EffectString.includes('://')))
    return yield* publicationFailure('Select an explicit local file path.');
  const path = yield* Path.Path;
  return path.resolve(value);
});

const readBoundedJson = Effect.fn('procedure.publish.readJson')(function* (path: string, maximumBytes: number) {
  const text = yield* readBoundedText(path, maximumBytes);
  return yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => publicationFailure('Procedure JSON is invalid.'),
  });
});

const readBoundedText = Effect.fn('procedure.publish.readText')(function* (path: string, maximumBytes: number) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    if (Option.isSome(yield* fs.readLink(path).pipe(Effect.option))) {
      return yield* publicationFailure('Procedure input must not be a symbolic link.');
    }
    const stat = yield* fs.stat(path);
    if (stat.type !== 'File' || stat.size > BigInt(maximumBytes)) {
      return yield* publicationFailure(`Procedure input must be a file of at most ${maximumBytes} bytes.`);
    }
    const bytes = yield* fs.readFile(path);
    if (bytes.byteLength > maximumBytes) {
      return yield* publicationFailure(`Procedure input must be a file of at most ${maximumBytes} bytes.`);
    }
    const decoded = decodeExactProcedureText(bytes);
    if (!decoded.ok && decoded.reason === 'encoding') {
      return yield* publicationFailure('Procedure input must be strict UTF-8 text.');
    }
    if (!decoded.ok) {
      return yield* publicationFailure('Procedure input must be exact, NUL-free UTF-8 text.');
    }
    return decoded.text;
  }).pipe(
    Effect.mapError(error =>
      Schema.is(ProcedurePublicationError)(error)
        ? error
        : publicationFailure('Could not read bounded local procedure input.'),
    ),
  );
});

function validObjectId(value: string, objectFormat: 'sha1' | 'sha256'): boolean {
  return (objectFormat === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(value);
}

function parseContract<A>(parse: () => A, message: string): Effect.Effect<A, ProcedurePublicationError> {
  return Effect.try({try: parse, catch: () => publicationFailure(message)});
}

function publicationFailure(message: string): ProcedurePublicationError {
  return ProcedurePublicationError.make({message});
}
