import {Effect, FileSystem, Path, Schema} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {
  decodeNativeCyclePlan,
  initializeNativeCycle,
  nextNativeCycle,
  nativeCycleParentsReady,
  checkNativeCycleScope,
  validateNativeCyclePhase,
  recordNativeCycleDelivery,
  invalidateNativeCycle,
  reconcileNativeCyclePlan,
  type NativeCycleState,
  type NativeCycleValidation,
} from '@threadnote/workflow-automations/cycle';
import {
  NativeCyclePacketOptionsSchema,
  nativeCyclePacket,
  validateNativeCycleFeaturePublication,
} from '@threadnote/workflow-automations/cycle-packet';
import {validateNativeCycleReview, type NativeCycleSnapshot} from '@threadnote/workflow-automations/cycle-review';
import {decodeNativeCycleRuntime, type NativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';
import {nativeCycleTextPage} from '@threadnote/workflow-automations/cycle-output';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256HexSync} from '../workflow_memory/native_digest.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {inspectWorkflowJournal, withWorkflowLock} from '../workflow_memory/journal.js';
import {readNativeWorkflowState, writeNativeWorkflowState, withNativeWorkflowLock} from './store.js';
import {
  captureNativeCycleSource,
  pinNativeCycleTree,
  makeWorkflowGitAdapter,
  nativeCycleRelativePath,
  readNativeCycleTreeEntry,
} from './cycle_git.js';
import {nativeWorkflowError} from './memory.js';
import type {NativeAuthoringCall} from './authoring_artifacts.js';

const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const nativeCycleRequestSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  executorVersion: Schema.Literal(1),
  action: Schema.Literal('cycle'),
  command: Schema.Literals([
    'init',
    'begin-phase',
    'inspect',
    'next',
    'reconcile',
    'snapshot',
    'check',
    'detail',
    'validate-review',
    'packet',
    'ready',
    'invalidate',
    'record-delivery',
    'publication-ready',
    'learning-packet',
    'closeout-packet',
    'extend-reviews',
    'resume-phase',
    'schema',
    'validate-plan',
    'check-phase',
  ]),
  runId: id,
  generation: text,
  expectedRevision: Schema.optionalKey(digest),
  phaseId: Schema.optionalKey(id),
  snapshotId: Schema.optionalKey(id),
  previous: Schema.optionalKey(id),
  acceptedHead: Schema.optionalKey(text),
  base: Schema.optionalKey(text),
  plan: Schema.optionalKey(Schema.Unknown),
  reason: Schema.optionalKey(text),
  userAuthority: Schema.optionalKey(text),
  reviewLimit: Schema.optionalKey(Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 5, maximum: 256}))),
  report: Schema.optionalKey(Schema.Unknown),
  attemptId: Schema.optionalKey(id),
  validation: Schema.optionalKey(Schema.Unknown),
  reviewSkipped: Schema.optionalKey(text),
  delivery: Schema.optionalKey(Schema.Unknown),
  publication: Schema.optionalKey(Schema.Unknown),
  packet: Schema.optionalKey(Schema.Unknown),
  detailKind: Schema.optionalKey(
    Schema.Literals(['patch', 'manifest', 'review', 'attempt', 'phase', 'overview', 'plan']),
  ),
  offsetBytes: Schema.optionalKey(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  sourceDigest: Schema.optionalKey(digest),
  maxBytes: Schema.optionalKey(Schema.Finite.check(Schema.isInt(), Schema.isBetween({minimum: 1024, maximum: 65_536}))),
});
const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const from = <A>(f: () => A) => Effect.try({try: f, catch: nativeWorkflowError});
const required = <A>(value: A | undefined, name: string): A => {
  if (value === undefined) throw fail('invalid-request', 'Provide ' + name + '.');
  return value;
};
const git = (repo: string, args: readonly string[], maximum = 1_000_000) =>
  runCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args], {
    timeoutMs: 30_000,
    maxOutputBytes: maximum,
  }).pipe(Effect.map(result => result.stdout));

const readOnlyIncoming = Effect.fn('workflowAutomation.cycle.incoming')(function* (
  repo: string,
  phase: NativeCycleState['plan']['phases'][number],
  captured: Effect.Success<ReturnType<typeof captureNativeCycleSource>>,
  baseline: NativeCycleRuntime['baselines'][string],
) {
  const base = (yield* git(repo, ['rev-parse', '--verify', '--end-of-options', phase.baseBranch + '^{commit}'])).trim();
  const common = (yield* git(repo, ['merge-base', base, captured.head])).trim();
  const scope = yield* captureNativeCycleSource(repo, common);
  if (scope.head !== captured.head || scope.tree !== captured.tree)
    return yield* fail('source-drift', 'Source changed during declared-base scope verification.');
  const files = [...new Set([...Object.keys(captured.files), ...Object.keys(scope.files)])].sort();
  const paths = files.filter(file => !checkNativeCycleScope(phase, [file]));
  const incoming = [];
  for (const file of paths) {
    const actual = captured.entries[file] ?? scope.entries[file];
    const preserved = baseline.preservedFiles.includes(file);
    const sourceTree = preserved ? baseline.tree : common;
    const expected = yield* readNativeCycleTreeEntry(repo, sourceTree, file);
    if (!actual || expected.blob !== actual.blob || expected.mode !== actual.mode)
      return yield* fail(
        'phase-scope',
        'Unowned source differs from its original preserved work or declared upstream base: ' + file,
      );
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
    scopeFiles: Object.keys(scope.files).sort(),
  };
});

const currentSnapshot = Effect.fn('workflowAutomation.cycle.checkSnapshot')(function* (
  repo: string,
  snapshot: NativeCycleSnapshot,
  acceptedHead?: string,
) {
  const current = yield* captureNativeCycleSource(repo, snapshot.baseTree);
  if (
    current.tree !== snapshot.tree ||
    (current.head !== snapshot.head &&
      (acceptedHead !== current.head || (yield* git(repo, ['rev-parse', 'HEAD^{tree}'])).trim() !== snapshot.tree))
  )
    return yield* fail('source-drift', 'Current HEAD/tree differs from the immutable review snapshot.');
  return current;
});

/** Native cycle state is an owned extension of the run's CAS journal, never a caller-selected file. */
export const runNativeCycle = <R>(
  config: RuntimeConfig,
  input: unknown,
  call: NativeAuthoringCall<R>,
  authoring: NativeAuthoringCall<R>,
) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(nativeCycleRequestSchema, {onExcessProperty: 'error'})(
      input,
    ).pipe(Effect.mapError(() => fail('invalid-request', 'Provide a closed native cycle request.')));
    if (request.command === 'schema') {
      const budget = request.maxBytes ?? 16_384;
      if (budget < 8192) return {available: false, reason: 'detail-budget-too-small', minimumBytes: 8192};
      return yield* from(() => ({
        status: 'ok',
        schemaPage: nativeCycleTextPage(stableJson(Schema.toJsonSchemaDocument(nativeCycleRequestSchema)), {
          maxBytes: Math.floor((budget - 1024) / 6),
          offsetBytes: request.offsetBytes,
          sourceDigest: request.sourceDigest,
        }),
      }));
    }
    const base = (action: string) => ({
      protocolVersion: 1,
      executorVersion: 1,
      action,
      runId: request.runId,
      generation: request.generation,
    });
    yield* call(base('inspect'));
    let verifiedPlan: ReturnType<typeof decodeNativeCyclePlan> | undefined;
    if (request.command === 'init' || request.command === 'reconcile' || request.command === 'validate-plan') {
      verifiedPlan = yield* from(() => decodeNativeCyclePlan(request.plan));
      const plan = verifiedPlan;
      const observed = yield* authoring({
        protocolVersion: 1,
        executorVersion: 1,
        action: 'authoring',
        command: 'export-dev-cycle',
        runId: plan.source.binding.runId,
        generation: plan.source.binding.generation,
        uri: plan.source.root.uri,
        delivery: plan.delivery,
        bindings: Object.fromEntries(
          plan.phases.map(phase => [phase.id, {branch: phase.branch, baseBranch: phase.baseBranch}]),
        ),
      });
      if (stableJson((observed as {authoring: unknown}).authoring) !== stableJson(plan))
        return yield* fail('plan-drift', 'The plan differs from its verified ready native authoring export.');
      if (request.command === 'validate-plan')
        return {status: 'ok', valid: true, source: plan.source, phaseCount: plan.phases.length};
    }
    const livePlanCommands = [
      'next',
      'begin-phase',
      'packet',
      'snapshot',
      'check-phase',
      'validate-review',
      'ready',
      'publication-ready',
      'record-delivery',
      'resume-phase',
      'closeout-packet',
    ];
    let checkedPlanSource: string | undefined;
    if (livePlanCommands.includes(request.command)) {
      const current = yield* readNativeWorkflowState(config, request.runId);
      const plan = current?.state.cycle?.state.plan;
      if (plan) {
        const read = yield* call({
          protocolVersion: 1,
          executorVersion: 1,
          action: 'read',
          runId: plan.source.binding.runId,
          generation: plan.source.binding.generation,
          uri: plan.source.root.uri,
        });
        const artifact = (read as {artifact?: {memoryId: string; revision: string}}).artifact;
        if (artifact?.memoryId !== plan.source.root.memoryId || artifact.revision !== plan.source.root.revision)
          return yield* fail(
            'plan-drift',
            'The approved plan root changed. Reconcile its current verified export before further delivery.',
          );
        checkedPlanSource = stableJson(plan.source);
      }
    }
    // Graph preparation can index and must never run while holding a native run lock.
    let sourceBeforeGraph: Effect.Success<ReturnType<typeof captureNativeCycleSource>> | undefined;
    if (request.command === 'packet') {
      const state = yield* readNativeWorkflowState(config, request.runId);
      if (!state) return yield* fail('run-not-found', 'Start the native run first.');
      if (!state.state.cycle?.baselines[request.phaseId ?? ''])
        return yield* fail('baseline-required', 'Run begin-phase before preparing an implementation packet.');
      const journal = yield* withWorkflowLock(
        config,
        state.state.bindingId,
        inspectWorkflowJournal(config, state.state.bindingId),
      );
      sourceBeforeGraph = yield* captureNativeCycleSource(journal.state.binding.repo, 'HEAD');
    }
    const graph = request.command === 'packet' ? yield* call(base('graph-ready')) : undefined;
    return yield* withNativeWorkflowLock(
      config,
      request.runId,
      false,
      Effect.gen(function* () {
        const stored = yield* readNativeWorkflowState(config, request.runId);
        if (!stored || stored.state.generation !== request.generation)
          return yield* fail('binding-drift', 'Resume the original native run and generation.');
        const journal = yield* withWorkflowLock(
          config,
          stored.state.bindingId,
          inspectWorkflowJournal(config, stored.state.bindingId),
        );
        const repo = journal.state.binding.repo;
        let runtime = stored.state.cycle;
        if (checkedPlanSource && checkedPlanSource !== stableJson(runtime?.state.plan.source))
          return yield* fail('state-conflict', 'The cycle plan changed during source-pin verification.');
        const mutation = ![
          'inspect',
          'next',
          'check',
          'check-phase',
          'detail',
          'packet',
          'publication-ready',
          'learning-packet',
          'closeout-packet',
        ].includes(request.command);
        if (
          mutation &&
          (stored.state.authoringSave || stored.state.operations.some(operation => operation.status === 'prepared'))
        )
          return yield* fail(
            'pending-operation',
            'Recover the original memory or authoring operation before changing cycle state.',
          );
        if (mutation && request.expectedRevision !== stored.revision)
          return yield* fail(
            'state-conflict',
            'Read this run and provide its exact state revision before a cycle mutation.',
          );
        const save = (value: NativeCycleRuntime) =>
          Effect.gen(function* () {
            if (stableJson(value) === stableJson(stored.state.cycle)) return stored.revision;
            const canonical = yield* from(() => decodeNativeCycleRuntime(JSON.parse(stableJson(value))));
            return (yield* writeNativeWorkflowState(config, {...stored.state, cycle: canonical}, stored.revision))
              .revision;
          });
        const pinBaseline = (phaseId: string) =>
          Effect.gen(function* () {
            const selected = (runtime?.state.plan ?? verifiedPlan!).phases.find(phase => phase.id === phaseId)!;
            if ((yield* git(repo, ['branch', '--show-current'])).trim() !== selected.branch)
              return yield* fail('branch-drift', 'Begin from the declared phase branch before changing source.');
            const captured = yield* captureNativeCycleSource(repo, 'HEAD');
            return {
              repo,
              head: captured.head,
              tree: captured.tree,
              preservedFiles: Object.keys(captured.files),
              pinnedRef: yield* pinNativeCycleTree(repo, stored.state.bindingId, phaseId, captured.tree, 'baseline'),
            };
          });
        if (request.command === 'init') {
          if (runtime) {
            if (stableJson(runtime.state.plan) !== stableJson(verifiedPlan))
              return yield* fail('cycle-conflict', 'This native cycle already belongs to another plan.');
          } else
            runtime = {
              state: initializeNativeCycle(verifiedPlan!),
              plans: [verifiedPlan!],
              baselines: {},
              reviewLimits: {},
              reviewExpansions: [],
              snapshots: [],
              reviews: [],
              attempts: [],
            };
          const next = nextNativeCycle(runtime.state);
          if (next.action === 'implement' && next.phaseId && !runtime.baselines[next.phaseId])
            runtime = {...runtime, baselines: {...runtime.baselines, [next.phaseId]: yield* pinBaseline(next.phaseId)}};
          return {status: 'ok', revision: yield* save(runtime), next};
        }
        if (!runtime && request.command === 'inspect')
          return {status: 'ok', revision: stored.revision, initialized: false};
        if (!runtime) return yield* fail('cycle-not-found', 'Initialize this run from a verified native plan export.');
        const state = runtime.state;
        const phaseId = request.phaseId;
        const phase = state.plan.phases.find(item => item.id === phaseId);
        const getPhase = () => required(phase, 'a phaseId from this native plan');
        const getSnapshot = () =>
          required(
            runtime.snapshots.find(item => item.snapshot.snapshotId === request.snapshotId),
            'an existing snapshotId',
          );
        const compact = () => ({
          status: 'ok',
          revision: stored.revision,
          next: nextNativeCycle(state),
          featureId: state.plan.featureId,
          phases: state.plan.phases.map(item => ({
            id: item.id,
            status: state.phases[item.id].status,
            phaseHash: state.phases[item.id].phaseHash,
            ...(state.phases[item.id].reason ? {reason: state.phases[item.id].reason} : {}),
          })),
        });
        if (request.command === 'inspect' || request.command === 'next') return compact();
        if (request.command === 'begin-phase') {
          const selected = yield* from(getPhase);
          const next = nextNativeCycle(state);
          if (next.action !== 'implement' || next.phaseId !== selected.id)
            return yield* fail(
              'phase-not-eligible',
              'Finish the returned delivery or reconciliation before starting this phase.',
            );
          const baseline = runtime.baselines[selected.id] ?? (yield* pinBaseline(selected.id));
          return {
            status: 'ok',
            revision: yield* save({...runtime, baselines: {...runtime.baselines, [selected.id]: baseline}}),
            baseline,
          };
        }
        if (request.command === 'extend-reviews') {
          const selected = yield* from(getPhase);
          const limit = yield* from(() => required(request.reviewLimit, 'the newly authorized review limit'));
          yield* from(() => required(request.userAuthority, 'the explicit human authority for expanding reviews'));
          if (limit <= (runtime.reviewLimits[selected.id] ?? 5))
            return yield* fail('review-budget', 'Expansion must increase the existing continuous review budget.');
          return {
            status: 'ok',
            revision: yield* save({
              ...runtime,
              reviewLimits: {...runtime.reviewLimits, [selected.id]: limit},
              reviewExpansions: [
                ...runtime.reviewExpansions,
                {
                  phaseId: selected.id,
                  from: runtime.reviewLimits[selected.id] ?? 5,
                  to: limit,
                  authority: request.userAuthority!,
                },
              ],
            }),
            phaseId: selected.id,
            reviewLimit: limit,
            authority: request.userAuthority,
          };
        }
        if (request.command === 'reconcile') {
          const reconciled = yield* from(() =>
            reconcileNativeCyclePlan(
              state,
              verifiedPlan!,
              required(request.reason, 'a concrete reconciliation reason'),
            ),
          );
          return {
            status: 'ok',
            revision: yield* save({
              ...runtime,
              state: reconciled.state,
              plans:
                stableJson(state.plan) === stableJson(verifiedPlan) ? runtime.plans : [...runtime.plans, verifiedPlan!],
            }),
            affected: reconciled.affected,
            next: nextNativeCycle(reconciled.state),
          };
        }
        if (request.command === 'resume-phase') {
          const selected = yield* from(getPhase);
          const prior = state.phases[selected.id];
          const reason = yield* from(() => required(request.reason, 'the completed reconciliation evidence'));
          if (!['stale', 'blocked'].includes(prior.status) || !nativeCycleParentsReady(state, selected.id))
            return yield* fail('dependency-stale', 'Resume only the reconciled phase after its parent acceptance.');
          if (nextNativeCycle(state).action === 'deliver')
            return yield* fail('delivery-pending', 'Finish the outstanding delivery first.');
          const updated = {
            ...state,
            phases: {...state.phases, [selected.id]: {...prior, status: 'pending' as const, reason}},
          };
          return {status: 'ok', revision: yield* save({...runtime, state: updated}), next: nextNativeCycle(updated)};
        }
        if (request.command === 'invalidate') {
          const updated = yield* from(() =>
            invalidateNativeCycle(
              state,
              getPhase().id,
              required(request.reason, 'the observed failure or source drift'),
            ),
          );
          return {status: 'ok', revision: yield* save({...runtime, state: updated}), next: nextNativeCycle(updated)};
        }
        if (request.command === 'snapshot') {
          const selected = yield* from(getPhase);
          const next = nextNativeCycle(state);
          if (next.action === 'deliver' && next.phaseId !== selected.id)
            return yield* fail('delivery-pending', 'Deliver the accepted prior phase before the next implementation.');
          if (!nativeCycleParentsReady(state, selected.id))
            return yield* fail('dependency-stale', 'Reconcile the affected parent acceptance first.');
          if (state.phases[selected.id].status === 'merged')
            return yield* fail('phase-complete', 'Merged phase history is immutable.');
          const snapshotId = yield* from(() => required(request.snapshotId, 'a fresh immutable snapshotId'));
          const existing = runtime.snapshots.find(item => item.snapshot.snapshotId === snapshotId);
          if (existing) {
            if (
              existing.snapshot.phaseId !== selected.id ||
              existing.snapshot.phaseHash !== state.phases[selected.id].phaseHash
            )
              return yield* fail('snapshot-conflict', 'This snapshot ID belongs to another phase contract.');
            yield* currentSnapshot(repo, existing.snapshot, request.acceptedHead);
            return {status: 'ok', revision: stored.revision, snapshot: existing};
          }
          const prior = request.previous
            ? runtime.snapshots.find(item => item.snapshot.snapshotId === request.previous)?.snapshot
            : undefined;
          const last = runtime.snapshots.filter(item => item.snapshot.phaseId === selected.id).at(-1)?.snapshot;
          if ((last && prior?.snapshotId !== last.snapshotId) || (!last && request.previous))
            return yield* fail('review-history', 'Continue from this phase’s latest immutable snapshot.');
          if (prior && !runtime.reviews.some(item => item.snapshotId === prior.snapshotId))
            return yield* fail('review-pending', 'Record the previous review before the next source iteration.');
          const baseline = runtime.baselines[selected.id];
          if (!baseline) return yield* fail('baseline-required', 'Run begin-phase before implementation.');
          const captured = yield* captureNativeCycleSource(repo, baseline.tree);
          if (request.base && (yield* git(repo, ['rev-parse', request.base + '^{tree}'])).trim() !== baseline.tree)
            return yield* fail('review-history', 'Keep the phase’s original review baseline.');
          const priorHead = prior?.head ?? baseline.head;
          if (captured.head !== priorHead) {
            if (request.acceptedHead !== captured.head || !request.reason?.trim())
              return yield* fail('head-drift', 'Record the exact changed HEAD and its reconciliation evidence.');
            yield* git(repo, ['merge-base', '--is-ancestor', priorHead, captured.head]);
          }
          const scope = yield* readOnlyIncoming(repo, selected, captured, baseline);
          const materialRestart = prior && prior.phaseHash !== state.phases[selected.id].phaseHash;
          const snapshot: NativeCycleSnapshot = {
            format: 'threadnote-native-cycle-snapshot',
            version: 1,
            snapshotId,
            phaseId: selected.id,
            phaseHash: state.phases[selected.id].phaseHash,
            repo,
            head: captured.head,
            baseTree: captured.baseTree,
            tree: captured.tree,
            files: scope.files,
            scopeBase: scope.scopeBase,
            declaredBaseHead: scope.declaredBaseHead,
            scopeFiles: scope.scopeFiles,
            ...(prior
              ? materialRestart
                ? {supersedes: prior.snapshotId}
                : {previous: prior.snapshotId, previousTree: prior.tree}
              : {}),
            ...(request.acceptedHead ? {acceptedHead: request.acceptedHead} : {}),
            pinnedRef: yield* pinNativeCycleTree(repo, stored.state.bindingId, snapshotId, captured.tree),
          };
          const updated: NativeCycleRuntime = {
            ...runtime,
            snapshots: [...runtime.snapshots, {snapshot, incoming: scope.incoming}],
          };
          return {status: 'ok', revision: yield* save(updated), snapshot: {snapshot, incoming: scope.incoming}};
        }
        if (request.command === 'check' || request.command === 'check-phase') {
          const entry = yield* from(getSnapshot);
          yield* currentSnapshot(repo, entry.snapshot, request.acceptedHead);
          if (
            request.command === 'check-phase' &&
            (entry.snapshot.phaseHash !== state.phases[entry.snapshot.phaseId].phaseHash ||
              (request.phaseId && request.phaseId !== entry.snapshot.phaseId))
          )
            return yield* fail('review-stale', 'Snapshot is not current for the selected material phase.');
          return {status: 'unchanged', revision: stored.revision, tree: entry.snapshot.tree};
        }
        if (request.command === 'detail') {
          const budget = request.maxBytes ?? 16_384;
          if (budget < 8192) return {available: false, reason: 'detail-budget-too-small', minimumBytes: 8192};
          const kind = request.detailKind ?? 'patch';
          let body: string;
          let snapshot: NativeCycleSnapshot | undefined;
          if (kind === 'overview') body = stableJson(compact());
          else if (kind === 'plan') body = stableJson(state.plan);
          else if (kind === 'phase') {
            const selected = yield* from(getPhase);
            const ids = runtime.snapshots
              .filter(item => item.snapshot.phaseId === selected.id)
              .map(item => item.snapshot.snapshotId);
            body = stableJson({
              phase: selected,
              proof: state.phases[selected.id],
              snapshots: ids,
              attempts: runtime.attempts
                .filter(item => ids.includes(item.snapshotId))
                .map(item => ({id: item.id, snapshotId: item.snapshotId, status: item.status})),
            });
          } else if (kind === 'attempt')
            body = yield* from(
              () =>
                required(
                  runtime.attempts.find(item => item.id === request.attemptId),
                  'an existing attemptId',
                ).report,
            );
          else {
            const entry = yield* from(getSnapshot);
            snapshot = entry.snapshot;
            if (kind === 'manifest') body = stableJson(entry);
            else if (kind === 'review')
              body = stableJson(
                yield* from(
                  () =>
                    required(
                      runtime.reviews.find(item => item.snapshotId === snapshot!.snapshotId),
                      'the completed review',
                    ).report,
                ),
              );
            else
              body = yield* git(
                repo,
                [
                  'diff',
                  '--no-ext-diff',
                  '--no-textconv',
                  '--binary',
                  snapshot.previousTree ?? snapshot.baseTree,
                  snapshot.tree,
                  '--',
                ],
                4_000_000,
              );
            const previousScope = snapshot.previous
              ? runtime.snapshots.find(item => item.snapshot.snapshotId === snapshot!.previous)?.snapshot.scopeBase
              : snapshot.baseTree;
            if (kind === 'patch' && snapshot.scopeBase !== previousScope)
              body +=
                '\nDeclared-base scope delta\n' +
                (yield* git(
                  repo,
                  ['diff', '--no-ext-diff', '--no-textconv', '--binary', snapshot.scopeBase, snapshot.tree, '--'],
                  4_000_000,
                ));
          }
          return yield* from(() => ({
            available: true,
            detailKind: kind,
            ...(snapshot ? {snapshotId: snapshot.snapshotId} : {}),
            page: nativeCycleTextPage(body, {
              maxBytes: Math.floor((budget - 1024) / 6),
              offsetBytes: request.offsetBytes,
              sourceDigest: request.sourceDigest,
            }),
          }));
        }
        if (request.command === 'validate-review') {
          const {snapshot} = yield* from(getSnapshot);
          if (snapshot.phaseHash !== state.phases[snapshot.phaseId].phaseHash)
            return yield* fail('review-stale', 'The material phase contract changed since this snapshot.');
          yield* currentSnapshot(repo, snapshot, request.acceptedHead);
          const attemptId = yield* from(() => required(request.attemptId, 'an immutable review attemptId'));
          const raw = stableJson(request.report ?? null);
          if (new TextEncoder().encode(raw).byteLength > 65_536)
            return yield* fail(
              'review-capacity',
              'Split review evidence into a bounded complete report before admission.',
            );
          const hash = sha256HexSync(raw);
          const repeated = runtime.attempts.find(item => item.id === attemptId);
          if (repeated) {
            if (repeated.digest !== hash || repeated.snapshotId !== snapshot.snapshotId)
              return yield* fail('review-conflict', 'Review attempt identity already belongs to other evidence.');
            return {
              status: repeated.status === 'accepted' ? 'ok' : 'error',
              code: repeated.status === 'invalid' ? 'invalid-cycle-review' : undefined,
              revision: stored.revision,
              attempt: repeated,
            };
          }
          if (
            runtime.reviews.filter(
              item =>
                runtime.snapshots.find(entry => entry.snapshot.snapshotId === item.snapshotId)?.snapshot.phaseId ===
                snapshot.phaseId,
            ).length >= (runtime.reviewLimits[snapshot.phaseId] ?? 5)
          )
            return yield* fail(
              'review-budget',
              'The continuous phase review limit is reached. Record explicit human expansion before another review.',
            );
          if (
            runtime.attempts.filter(item => item.snapshotId === snapshot.snapshotId && item.status === 'invalid')
              .length >= 2 &&
            !request.userAuthority?.trim()
          )
            return yield* fail(
              'review-failed',
              'The malformed review and its targeted recovery both failed; retain the reports and resolve the review failure.',
            );
          const predecessor = snapshot.previous ?? snapshot.supersedes;
          const previous = predecessor
            ? runtime.snapshots.find(item => item.snapshot.snapshotId === predecessor)?.snapshot
            : undefined;
          const priorReview = previous
            ? runtime.reviews.find(item => item.snapshotId === previous.snapshotId)?.report
            : undefined;
          const verdict = yield* from(() => {
            try {
              return {
                accepted: true as const,
                value: validateNativeCycleReview(
                  snapshot,
                  request.report,
                  previous && priorReview ? {snapshot: previous, review: priorReview} : undefined,
                ),
              };
            } catch (error) {
              return {accepted: false as const, message: nativeWorkflowError(error).message};
            }
          });
          const attempt = {
            id: attemptId,
            snapshotId: snapshot.snapshotId,
            digest: hash,
            status: verdict.accepted ? ('accepted' as const) : ('invalid' as const),
            message: verdict.accepted ? 'Complete source-bound review.' : verdict.message,
            report: raw,
            ...(request.userAuthority ? {authority: request.userAuthority} : {}),
          };
          if (verdict.accepted && runtime.reviews.some(item => item.snapshotId === snapshot.snapshotId))
            return yield* fail(
              'review-conflict',
              'A completed review is immutable; create a new source iteration for changed findings.',
            );
          const updated = {
            ...runtime,
            attempts: [...runtime.attempts, attempt],
            reviews: verdict.accepted
              ? [...runtime.reviews, {snapshotId: snapshot.snapshotId, report: verdict.value.review}]
              : runtime.reviews,
          };
          const revision = yield* save(updated);
          return verdict.accepted
            ? {status: 'ok', revision, summary: verdict.value.summary}
            : {status: 'error', code: 'invalid-cycle-review', message: verdict.message, revision, attemptId};
        }
        if (request.command === 'packet') {
          const selected = yield* from(getPhase);
          if (!runtime.baselines[selected.id])
            return yield* fail('baseline-required', 'Run begin-phase before dispatching implementation.');
          const next = nextNativeCycle(state);
          if (next.action !== 'implement' || next.phaseId !== selected.id)
            return yield* fail('phase-not-eligible', 'Follow the current native next decision before dispatch.');
          const options = yield* Schema.decodeUnknownEffect(NativeCyclePacketOptionsSchema, {
            onExcessProperty: 'error',
          })(request.packet).pipe(
            Effect.mapError(() =>
              fail('invalid-cycle-packet', 'Provide bounded source anchors, ownership, checks and capacity evidence.'),
            ),
          );
          const observedGraph = graph as {graph: typeof options.graphProof};
          const captured = yield* captureNativeCycleSource(repo, 'HEAD');
          if (
            !sourceBeforeGraph ||
            sourceBeforeGraph.head !== captured.head ||
            sourceBeforeGraph.tree !== captured.tree
          )
            return yield* fail(
              'source-drift',
              'Source changed around ready-graph preparation. Retry with current evidence.',
            );
          const proof = {...observedGraph.graph, tree: captured.tree};
          if (
            stableJson(proof) !== stableJson(options.graphProof) ||
            proof.head !== captured.head ||
            proof.repositoryRoot !== repo
          )
            return yield* fail('source-drift', 'Packet graph evidence does not match exact current checkout bytes.');
          const adapter = yield* makeWorkflowGitAdapter();
          const source = yield* adapter.inspect(repo, [...new Set(options.anchors.map(anchor => anchor.path))]);
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          for (const anchor of options.anchors) {
            if (
              !nativeCycleRelativePath(anchor.path) ||
              source.files[anchor.path] !== anchor.sha256 ||
              !(yield* fs.readFileString(path.join(repo, anchor.path))).includes(anchor.pattern)
            )
              return yield* fail('anchor-drift', 'Packet anchor bytes or literal symbol changed.');
          }
          if (!checkNativeCycleScope(selected, options.ownership))
            return yield* fail('phase-scope', 'Worker ownership exceeds the approved phase scope.');
          const after = yield* captureNativeCycleSource(repo, 'HEAD');
          if (after.head !== captured.head || after.tree !== captured.tree)
            return yield* fail('source-drift', 'Source changed while preparing the implementation packet.');
          return yield* from(() => nativeCyclePacket(state, selected.id, options));
        }
        if (request.command === 'ready') {
          const selected = yield* from(getPhase);
          if (!nativeCycleParentsReady(state, selected.id))
            return yield* fail('dependency-stale', 'Reconcile and deliver every effective ancestor before acceptance.');
          const entry = yield* from(getSnapshot);
          if (
            entry.snapshot.phaseId !== selected.id ||
            entry.snapshot.phaseHash !== state.phases[selected.id].phaseHash
          )
            return yield* fail('review-stale', 'Snapshot belongs to another material phase contract.');
          const current = yield* currentSnapshot(repo, entry.snapshot, request.acceptedHead);
          const report = runtime.reviews.find(item => item.snapshotId === entry.snapshot.snapshotId)?.report;
          if (!report)
            return yield* fail('review-pending', 'A complete immutable source review is required before acceptance.');
          const predecessor = entry.snapshot.previous ?? entry.snapshot.supersedes;
          const previous = predecessor
            ? runtime.snapshots.find(item => item.snapshot.snapshotId === predecessor)?.snapshot
            : undefined;
          const priorReport = previous
            ? runtime.reviews.find(item => item.snapshotId === previous.snapshotId)?.report
            : undefined;
          const reviewed = yield* from(() =>
            validateNativeCycleReview(
              entry.snapshot,
              report,
              previous && priorReport ? {snapshot: previous, review: priorReport} : undefined,
            ),
          );
          if (reviewed.summary.blockingIssueCount)
            return yield* fail('review-blocked', 'Resolve the recorded blockers before accepting this phase.');
          if (state.plan.delivery !== 'local' && entry.incoming.some(item => item.source === 'preserved'))
            return yield* fail(
              'preserved-work-publication',
              'Preserve unowned existing work outside the phase commit. Use a clean isolated phase checkout.',
            );
          const incoming = new Set(entry.incoming.map(item => item.path));
          const updated = yield* from(() =>
            validateNativeCyclePhase(
              state,
              selected.id,
              {...current, files: entry.snapshot.files.filter(file => !incoming.has(file))},
              request.validation as NativeCycleValidation,
            ),
          );
          return {status: 'ok', revision: yield* save({...runtime, state: updated}), next: nextNativeCycle(updated)};
        }
        if (request.command === 'publication-ready' || request.command === 'record-delivery') {
          const selected = yield* from(getPhase);
          const proof = state.phases[selected.id];
          if (request.command === 'record-delivery' && proof.status === 'merged') {
            const replay = yield* from(() => recordNativeCycleDelivery(state, selected.id, request.delivery));
            return {status: 'ok', revision: stored.revision, next: nextNativeCycle(replay)};
          }
          if (!nativeCycleParentsReady(state, selected.id))
            return yield* fail('dependency-stale', 'Reconcile and deliver effective parents before publication.');
          const pending = nextNativeCycle(state);
          if (pending.action === 'deliver' && pending.phaseId !== selected.id)
            return yield* fail('delivery-pending', 'Finish the outstanding delivery first.');
          if (!proof.validation || !proof.tree)
            return yield* fail('not-ready', 'Current phase validation is required.');
          const current = yield* captureNativeCycleSource(repo, 'HEAD');
          if (current.tree !== proof.tree || (yield* git(repo, ['rev-parse', 'HEAD^{tree}'])).trim() !== proof.tree)
            return yield* fail('source-drift', 'Publish the clean exact validated tree.');
          if ((yield* git(repo, ['branch', '--show-current'])).trim() !== selected.branch)
            return yield* fail('branch-drift', 'Publish from the declared phase branch.');
          if (state.plan.delivery === 'pr')
            yield* from(() =>
              validateNativeCycleFeaturePublication(request.publication, {
                currentHead: current.head,
                team: stored.state.team ?? 'default',
              }),
            );
          if (request.command === 'publication-ready')
            return {status: 'ok', revision: stored.revision, head: current.head, tree: current.tree};
          // A clean normal commit advances HEAD while retaining the reviewed tree.
          const accepted = {
            ...state,
            phases: {
              ...state.phases,
              [selected.id]: {...proof, head: current.head, validation: {...proof.validation, head: current.head}},
            },
          };
          const updated = yield* from(() => recordNativeCycleDelivery(accepted, selected.id, request.delivery));
          return {status: 'ok', revision: yield* save({...runtime, state: updated}), next: nextNativeCycle(updated)};
        }
        if (request.command === 'learning-packet') {
          const selected = yield* from(getPhase);
          const proof = state.phases[selected.id];
          return {
            phaseId: selected.id,
            phaseHash: proof.phaseHash,
            status: proof.status,
            acceptance: proof.validation?.acceptance,
            attempts: runtime.attempts
              .filter(
                item =>
                  runtime.snapshots.find(entry => entry.snapshot.snapshotId === item.snapshotId)?.snapshot.phaseId ===
                  selected.id,
              )
              .map(({id, status, message}) => ({id, status, message})),
            next: nextNativeCycle(state),
          };
        }
        if (request.command === 'closeout-packet') {
          if (nextNativeCycle(state).action !== 'complete')
            return yield* fail('plan-incomplete', 'Finish every current acceptance and delivery before closeout.');
          return {
            format: 'threadnote-native-cycle-closeout',
            version: 1,
            source: state.plan.source,
            completion: state.plan.completion,
            spec: state.plan.spec,
            phases: state.plan.phases.map(phase => ({
              id: phase.id,
              phaseHash: state.phases[phase.id].phaseHash,
              validation: state.phases[phase.id].validation,
              delivery: state.phases[phase.id].delivery,
            })),
          };
        }
        return yield* fail('invalid-request', 'Unsupported native cycle operation.');
      }),
    );
  });
