import {Array as EffectArray, Effect, Option as EffectOption, String as EffectString} from 'effect';
import * as EffectRecord from 'effect/Record';
import {runCommandEffect} from '@threadnote/platform/command';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {
  checkNativeCycleScope,
  nextNativeCycle,
  nativeCycleParentsReady,
  nativeCyclePhaseIntentHash,
} from '@threadnote/workflow-automations/cycle';
import type {NativeCycleState} from '@threadnote/workflow-automations/cycle';
import type {NativeCycleSnapshot} from '@threadnote/workflow-automations/cycle-review';
import type {NativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';
import {nativeTaskViewNext, nativeRefusal} from '@threadnote/workflow-automations/gates';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {
  captureNativeCycleSource,
  pinNativeCycleCommit,
  pinNativeCycleTree,
  readNativeCycleTreeEntries,
} from './cycle_git.js';

type Phase = NativeCycleState['plan']['phases'][number];
type Baseline = NativeCycleRuntime['baselines'][string];
type Captured = Effect.Success<ReturnType<typeof captureNativeCycleSource>>;

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const git = (repo: string, args: readonly string[]) =>
  runCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args], {
    timeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
  }).pipe(Effect.map(result => EffectString.trim(result.stdout)));

/**
 * Partition every changed path against the declared base. Unowned paths that match preserved work or the upstream
 * base are incoming; any other unowned change refuses, or becomes out-of-plan when `outOfPlan` collects it.
 */
export const readNativeCycleIncoming = Effect.fn('workflowAutomation.cycle.incoming')(function* (
  repo: string,
  phase: Phase,
  captured: Captured,
  baseline: Baseline,
  outOfPlan?: string[],
) {
  const base = yield* git(repo, ['rev-parse', '--verify', '--end-of-options', phase.baseBranch + '^{commit}']);
  const common = yield* git(repo, ['merge-base', base, captured.head]);
  const scope = yield* captureNativeCycleSource(repo, common);
  if (scope.head !== captured.head || scope.tree !== captured.tree)
    return yield* fail('source-drift', 'Source changed during declared-base scope verification.');
  const files = [...new Set([...EffectRecord.keys(captured.files), ...EffectRecord.keys(scope.files)])].sort();
  const paths = EffectArray.filter(files, file => !checkNativeCycleScope(phase, [file]));
  const preservedPaths = new Set(baseline.preservedFiles);
  const preservedEntries = yield* readNativeCycleTreeEntries(
    repo,
    baseline.tree,
    EffectArray.filter(paths, file => preservedPaths.has(file)),
  );
  const upstreamEntries = yield* readNativeCycleTreeEntries(
    repo,
    common,
    EffectArray.filter(paths, file => !preservedPaths.has(file)),
  );
  const incoming = [];
  for (const file of paths) {
    const actual = captured.entries[file] ?? scope.entries[file];
    const preserved = preservedPaths.has(file);
    const expected = (preserved ? preservedEntries : upstreamEntries)[file];
    if (!actual || expected.blob !== actual.blob || expected.mode !== actual.mode) {
      if (outOfPlan) {
        outOfPlan.push(file);
        continue;
      }
      return yield* fail(
        'phase-scope',
        'Unowned source differs from its original preserved work or declared upstream base: ' + file,
      );
    }
    incoming.push({
      path: file,
      ...expected,
      source: preserved ? ('preserved' as const) : ('upstream' as const),
      tree: preserved ? baseline.tree : scope.baseTree,
      commit: preserved ? baseline.head : common,
    });
  }
  return {
    files,
    incoming,
    scopeBase: scope.baseTree,
    declaredBaseHead: base,
    scopeFiles: EffectRecord.keys(scope.files).sort(),
  };
});

/**
 * The phase position keeps identities unique when a tree returns to an earlier state; a crash before the write
 * recomputes the same identity and a retry after it replays.
 */
const nativeCycleTreeSnapshotId = (identity: {
  readonly phaseId: string;
  readonly position: number;
  readonly phaseHash: string;
  readonly intentHash: string;
  readonly scopeBase: string;
  readonly tree: string;
}) => `tree-${EffectString.slice(0, 48)(sha256HexSync(stableJson(identity)))}`;

/**
 * Record the current tree, clean or dirty, for the selected phase. The same tree under the same intent replays; a new
 * tree supersedes an unreviewed latest snapshot whatever its contract, and keeps the last reviewed snapshot of the same
 * intent as its review basis.
 */
export const recordNativeCycleTreeSnapshot = Effect.fn('workflowAutomation.cycle.treeSnapshot')(function* <
  E1,
  R1,
  E2,
  R2,
>(input: {
  readonly repo: string;
  readonly bindingId: string;
  readonly runId: string;
  readonly revision: string;
  readonly runtime: NativeCycleRuntime;
  readonly phase: Phase;
  readonly reason: string | undefined;
  readonly pinBaseline: (phaseId: string) => Effect.Effect<Baseline, E1, R1>;
  readonly save: (runtime: NativeCycleRuntime) => Effect.Effect<string, E2, R2>;
}) {
  const {repo, bindingId, runtime, phase} = input;
  const state = runtime.state;
  const next = nextNativeCycle(state);
  const view = nativeTaskViewNext(input.runId, repo);
  if (next.action === 'deliver' && next.phaseId !== phase.id)
    return yield* nativeRefusal('delivery-pending', 'Deliver the accepted prior phase before the next snapshot.', {
      next: view,
    });
  if (!nativeCycleParentsReady(state, phase.id))
    return yield* nativeRefusal('dependency-stale', 'Reconcile the affected parent acceptance first.', {next: view});
  if (state.phases[phase.id].status === 'merged')
    return yield* nativeRefusal('phase-complete', 'Merged phase history is immutable.', {next: view});
  const branch = yield* git(repo, ['branch', '--show-current']);
  if (branch !== phase.branch)
    return yield* nativeRefusal('branch-drift', 'Record source from the declared phase branch ' + phase.branch + '.', {
      next: view,
    });
  const pinned = runtime.baselines[phase.id];
  // A phase without a baseline begins at HEAD when clean, otherwise at its merge-base with the declared base.
  let baseline = pinned;
  if (!baseline && EffectRecord.isEmptyRecord((yield* captureNativeCycleSource(repo, 'HEAD')).files))
    baseline = yield* input.pinBaseline(phase.id);
  if (!baseline) {
    const declared = yield* git(repo, ['rev-parse', '--verify', '--end-of-options', phase.baseBranch + '^{commit}']);
    const head = yield* git(repo, ['merge-base', declared, 'HEAD']);
    const tree = yield* git(repo, ['rev-parse', head + '^{tree}']);
    baseline = {
      repo,
      head,
      tree,
      preservedFiles: [],
      pinnedRef: yield* pinNativeCycleTree(repo, bindingId, phase.id, tree, 'baseline'),
    };
  }
  const captured = yield* captureNativeCycleSource(repo, baseline.tree);
  const outOfPlan: string[] = [];
  const scope = yield* readNativeCycleIncoming(repo, phase, captured, baseline, outOfPlan);
  const intentHash = nativeCyclePhaseIntentHash(state.plan, phase.id);
  const phaseSnapshots = EffectArray.filter(runtime.snapshots, entry => entry.snapshot.phaseId === phase.id);
  const latest = phaseSnapshots.at(-1);
  const reviewed = new Set(EffectArray.map(runtime.reviews, entry => entry.snapshotId));
  if (
    latest?.snapshot.version === 4 &&
    latest.snapshot.tree === captured.tree &&
    latest.snapshot.scopeBase === scope.scopeBase &&
    latest.snapshot.phaseHash === state.phases[phase.id].phaseHash
  )
    return {status: 'ok', revision: input.revision, replayed: true, snapshot: latest};
  const superseded = latest && !reviewed.has(latest.snapshot.snapshotId) ? latest.snapshot : undefined;
  const basis = EffectOption.getOrUndefined(
    EffectArray.findLast(
      phaseSnapshots,
      entry =>
        reviewed.has(entry.snapshot.snapshotId) &&
        (entry.snapshot.intentHash ?? entry.snapshot.phaseHash) === intentHash,
    ),
  )?.snapshot;
  const snapshotId = nativeCycleTreeSnapshotId({
    phaseId: phase.id,
    position: phaseSnapshots.length,
    phaseHash: state.phases[phase.id].phaseHash,
    intentHash,
    scopeBase: scope.scopeBase,
    tree: captured.tree,
  });
  const headTree = yield* git(repo, ['rev-parse', 'HEAD^{tree}']);
  const snapshot: NativeCycleSnapshot = {
    format: 'threadnote-native-cycle-snapshot',
    version: 4,
    snapshotId,
    phaseId: phase.id,
    phaseHash: state.phases[phase.id].phaseHash,
    intentHash,
    repo,
    head: captured.head,
    baseTree: captured.baseTree,
    tree: captured.tree,
    dirty: headTree !== captured.tree,
    files: scope.files,
    outOfPlan,
    scopeBase: scope.scopeBase,
    declaredBaseHead: scope.declaredBaseHead,
    scopeFiles: scope.scopeFiles,
    comparisonEvidence: {
      version: 1,
      baseBranch: phase.baseBranch,
      baseTree: yield* git(repo, ['rev-parse', scope.declaredBaseHead + '^{tree}']),
      sourceRef: yield* pinNativeCycleCommit(repo, bindingId, snapshotId, captured.head, 'snapshot-head'),
      baseRef: yield* pinNativeCycleCommit(repo, bindingId, snapshotId, scope.declaredBaseHead, 'snapshot-base'),
    },
    ...(superseded
      ? {
          supersedes: superseded.snapshotId,
          unreviewedSupersession: {
            reason: EffectString.trim(input.reason ?? '') || 'A newer source tree replaced this unreviewed snapshot.',
          },
        }
      : {}),
    ...(basis ? {reviewBasis: {snapshotId: basis.snapshotId, tree: basis.tree}} : {}),
    acceptedHead: captured.head,
    pinnedRef: yield* pinNativeCycleTree(repo, bindingId, snapshotId, captured.tree),
  };
  const entry = {snapshot, incoming: scope.incoming};
  const revision = yield* input.save({
    ...runtime,
    baselines: pinned ? runtime.baselines : {...runtime.baselines, [phase.id]: baseline},
    snapshots: [...runtime.snapshots, entry],
  });
  return {status: 'ok', revision, replayed: false, snapshot: entry};
});
