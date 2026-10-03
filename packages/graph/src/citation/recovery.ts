import {Effect, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  inspectCodeGraphLocalProvenanceInventory,
  readCodeGraphLocalReconciliationEvidence,
  readPersistedCodeGraphLocalAssociation,
  type CodeGraphLocalReconciliationEvidence,
} from '../local_provenance.js';
import {codeGraphDatabasePaths} from '../maintenance.js';
import {codeGraphLayout} from '../layout.js';
import {resolveRepositoryIdentity, revalidateRepositoryIdentityFence} from '../repository.js';
import type {RepositoryIdentity} from '../types.js';
import {
  captureCodeGraphGitWorktreeRegistration,
  sameCodeGraphGitWorktreeRegistration,
} from '../git/worktree/registration.js';

const MAXIMUM_RECOVERY_CHECKOUTS = 64;
const MAXIMUM_RECOVERY_PATHS = 32;

export interface CodeGraphRepositoryAliasProofV1 {
  readonly checkoutId: string;
  readonly evidenceRevision: string;
  readonly sourceCommit: string;
  readonly sourceRepositoryId: string;
  readonly sourceWorktreeId: string;
  readonly targetRepositoryId: string;
  readonly version: 1;
}

export interface CodeGraphCitationRecoveryRouteV1 {
  readonly aliasProof?: CodeGraphRepositoryAliasProofV1;
  readonly databasePath: string;
  readonly identity: RepositoryIdentity;
  readonly prior?: Extract<CodeGraphLocalReconciliationEvidence, {readonly state: 'verified'}>;
}

function sameIdentity(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return (
    left.checkoutId === right.checkoutId &&
    left.worktreeId === right.worktreeId &&
    left.repositoryId === right.repositoryId &&
    left.headCommit === right.headCommit &&
    left.gitCommonDirectory === right.gitCommonDirectory &&
    left.repoRoot === right.repoRoot
  );
}

const sourceCommitIsAncestor = Effect.fn('codeGraph.citationSourceCommitIsAncestor')(function* (
  identity: RepositoryIdentity,
  sourceCommit: string,
) {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sourceCommit)) return false;
  const system = yield* SystemInfo;
  const result = yield* runCommandEffect(
    'git',
    ['-C', identity.repoRoot, 'merge-base', '--is-ancestor', sourceCommit, identity.headCommit],
    {
      allowFailure: true,
      env: {...system.environment(), GIT_NO_LAZY_FETCH: '1'},
      maxOutputBytes: 4_096,
      timeoutMs: 10_000,
    },
  ).pipe(Effect.option);
  return result._tag === 'Some' && result.value.exitCode === 0;
});

/** A local alias proves checkout/history continuity, never the truth of a cited claim. */
export const verifyCodeGraphCitationRepositoryAlias = Effect.fn('codeGraph.verifyCitationRepositoryAlias')(function* <
  R = never,
>(
  threadnoteHome: string,
  prior: Extract<CodeGraphLocalReconciliationEvidence, {readonly state: 'verified'}>,
  identity: RepositoryIdentity,
  sourceCommit: string,
  beforeFinalFence?: () => Effect.Effect<void, unknown, R>,
) {
  if (prior.checkoutId !== identity.checkoutId || prior.repositoryId === identity.repositoryId) return undefined;
  const registration = yield* captureCodeGraphGitWorktreeRegistration(identity).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (registration === undefined) return undefined;
  if (!(yield* sourceCommitIsAncestor(identity, sourceCommit))) return undefined;
  yield* beforeFinalFence?.() ?? Effect.void;
  const [current, stablePrior, finalRegistration] = yield* Effect.all(
    [
      revalidateRepositoryIdentityFence(identity.repoRoot, identity).pipe(Effect.orElseSucceed(() => undefined)),
      readCodeGraphLocalReconciliationEvidence(threadnoteHome, prior),
      captureCodeGraphGitWorktreeRegistration(identity).pipe(Effect.orElseSucceed(() => undefined)),
    ],
    {concurrency: 2},
  );
  if (
    current === undefined ||
    !sameIdentity(identity, current) ||
    stablePrior.state !== 'verified' ||
    stablePrior.recordIdentity !== prior.recordIdentity ||
    stablePrior.recordDigest !== prior.recordDigest ||
    finalRegistration === undefined ||
    !sameCodeGraphGitWorktreeRegistration(registration, finalRegistration)
  )
    return undefined;
  return {
    checkoutId: prior.checkoutId,
    evidenceRevision: sha256HexSync(
      JSON.stringify([
        prior.recordIdentity,
        prior.recordDigest,
        identity.repositoryId,
        identity.worktreeId,
        identity.headCommit,
        sourceCommit,
        registration,
      ]),
    ),
    sourceCommit,
    sourceRepositoryId: prior.repositoryId,
    sourceWorktreeId: prior.worktreeId,
    targetRepositoryId: identity.repositoryId,
    version: 1,
  } satisfies CodeGraphRepositoryAliasProofV1;
});

export const revalidateCodeGraphCitationRecoveryRoute = Effect.fn('codeGraph.revalidateCitationRecoveryRoute')(
  function* (threadnoteHome: string, route: CodeGraphCitationRecoveryRouteV1) {
    const current = yield* revalidateRepositoryIdentityFence(route.identity.repoRoot, route.identity).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (current === undefined || !sameIdentity(route.identity, current)) return false;
    if (route.aliasProof === undefined) return true;
    if (route.prior === undefined) return false;
    const proof = yield* verifyCodeGraphCitationRepositoryAlias(
      threadnoteHome,
      route.prior,
      current,
      route.aliasProof.sourceCommit,
    );
    return proof?.evidenceRevision === route.aliasProof.evidenceRevision;
  },
);

/** Discover only persisted local checkouts. No indexing, recreation, remote fetch, or identity rewrite occurs. */
export const resolveCodeGraphCitationRepositoryRoutes = Effect.fn('codeGraph.resolveCitationRepositoryRoutes')(
  function* (input: {
    readonly callerCwd?: string;
    readonly callerOnly?: boolean;
    readonly repositoryId: string;
    readonly sourceCommit: string;
    readonly threadnoteHome: string;
  }) {
    const path = yield* Path.Path;
    const caller =
      input.callerCwd === undefined
        ? undefined
        : yield* resolveRepositoryIdentity(input.callerCwd).pipe(Effect.orElseSucceed(() => undefined));
    const databases = yield* codeGraphDatabasePaths(input.threadnoteHome);
    const checkoutIds = [
      ...new Set([
        ...(caller === undefined ? [] : [caller.checkoutId]),
        ...databases.map(database => path.basename(path.dirname(database))),
      ]),
    ].slice(0, MAXIMUM_RECOVERY_CHECKOUTS);
    const observations = yield* Effect.forEach(
      checkoutIds,
      checkoutId =>
        Effect.gen(function* () {
          const inventory = yield* inspectCodeGraphLocalProvenanceInventory(input.threadnoteHome, checkoutId);
          if (inventory.state !== 'ready') return [];
          return yield* Effect.forEach(
            inventory.worktreeIds,
            worktreeId =>
              Effect.gen(function* () {
                const target = {checkoutId, worktreeId};
                const [association, evidence] = yield* Effect.all(
                  [
                    readPersistedCodeGraphLocalAssociation(input.threadnoteHome, target),
                    readCodeGraphLocalReconciliationEvidence(input.threadnoteHome, target),
                  ],
                  {concurrency: 2},
                );
                return {association, evidence};
              }),
            {concurrency: 4},
          );
        }),
      {concurrency: 4},
    );
    const records = observations.flat();
    const paths = [
      ...new Set([
        ...(caller === undefined ? [] : [caller.repoRoot]),
        ...records.flatMap(record =>
          record.association.available && record.association.path !== undefined ? [record.association.path] : [],
        ),
      ]),
    ].slice(0, MAXIMUM_RECOVERY_PATHS);
    const identities = yield* Effect.forEach(
      paths,
      cwd => resolveRepositoryIdentity(cwd).pipe(Effect.orElseSucceed(() => undefined)),
      {concurrency: 4},
    );
    const priors = records.flatMap(record =>
      record.evidence.state === 'verified' && record.evidence.repositoryId === input.repositoryId
        ? [record.evidence]
        : [],
    );
    const routes: CodeGraphCitationRecoveryRouteV1[] = [];
    for (const identity of identities) {
      if (identity === undefined) continue;
      const databasePath = codeGraphLayout(
        path,
        input.threadnoteHome,
        identity.checkoutId,
        identity.worktreeId,
      ).databasePath;
      if (identity.repositoryId === input.repositoryId) {
        routes.push({databasePath, identity});
        continue;
      }
      for (const prior of priors.filter(prior => prior.checkoutId === identity.checkoutId)) {
        const aliasProof = yield* verifyCodeGraphCitationRepositoryAlias(
          input.threadnoteHome,
          prior,
          identity,
          input.sourceCommit,
        ).pipe(Effect.orElseSucceed(() => undefined));
        if (aliasProof !== undefined) {
          routes.push({aliasProof, databasePath, identity, prior});
          break;
        }
      }
    }
    const preferred = caller === undefined ? undefined : routes.find(route => sameIdentity(route.identity, caller));
    const authorities = new Set(routes.map(route => `${route.identity.repositoryId}\0${route.identity.headCommit}`));
    return {
      ambiguous: preferred === undefined && authorities.size > 1,
      complete: databases.length <= MAXIMUM_RECOVERY_CHECKOUTS && paths.length < MAXIMUM_RECOVERY_PATHS,
      checkoutIds,
      routes: preferred === undefined ? (input.callerOnly ? [] : routes) : [preferred],
    };
  },
);
