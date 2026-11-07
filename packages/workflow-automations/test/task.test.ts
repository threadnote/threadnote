import {describe, expect, it} from 'vitest';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {initializeNativeCycle, type NativeCyclePlan} from '../src/cycle.js';
import type {NativeCycleSnapshot} from '../src/cycle_review.js';
import type {NativeWorkflowState} from '../src/native.js';
import {
  decodeNativeTaskActionRef,
  decodeNativeTaskCursor,
  decodeNativeTaskStartReference,
  encodeNativeTaskActionRef,
  nativeTaskCursorMatches,
  projectNativeTaskView,
} from '../src/task.js';

const plan: NativeCyclePlan = {
  format: 'threadnote-native-cycle-plan',
  version: 1,
  featureId: 'feature',
  project: 'threadnote',
  objective: 'Implement a bounded feature',
  delivery: 'local',
  source: {
    root: {uri: 'threadnote://user/me/plan', memoryId: 'tn_123', revision: Effect.pipe('c', EffectString.repeat(64))},
    binding: {
      bindingId: Effect.pipe('d', EffectString.repeat(64)),
      runId: 'run',
      generation: 'generation',
      profile: 'desktop',
    },
    documentHash: Effect.pipe('e', EffectString.repeat(64)),
  },
  completion: {},
  phases: [
    {
      id: 'phase-one',
      definitionHash: Effect.pipe('a', EffectString.repeat(64)),
      title: 'Implement the task view',
      dependsOn: [],
      allowedPaths: ['src/task.ts'],
      acceptanceCriteria: ['Returns bounded actionable content'],
      safeToMergeReason: 'Local task',
      branch: 'feature/task',
      baseBranch: 'main',
      status: 'pending',
      acceptanceRefs: [
        {id: 'acceptance-one', criterion: 'Returns bounded actionable content', requirements: [], specScenarios: []},
      ],
    },
  ],
};

const state: NativeWorkflowState = {
  format: 'threadnote-native-workflow',
  stateVersion: 1,
  executorVersion: 1,
  runId: 'run',
  project: 'threadnote',
  featureId: 'feature',
  generation: 'generation',
  profile: 'desktop',
  bindingId: Effect.pipe('d', EffectString.repeat(64)),
  operations: [],
  cycle: {
    state: initializeNativeCycle(plan),
    plans: [plan],
    baselines: {},
    reviewLimits: {},
    reviewExpansions: [],
    snapshots: [],
    reviews: [],
    attempts: [],
  },
};

describe('native task projection', () => {
  it('accepts canonical run IDs and only task-view action references for task start', () => {
    const taskViewRef = encodeNativeTaskActionRef({
      version: 1,
      kind: 'task',
      runId: 'run',
      generationHash: EffectString.repeat(64)('a'),
      stateRevision: EffectString.repeat(64)('b'),
      taskAction: 'initialize-cycle',
    });
    const decodedTaskViewRef = decodeNativeTaskActionRef(taskViewRef);
    if (!decodedTaskViewRef) throw new Error('Expected an encoded task-view reference to decode.');
    expect(decodeNativeTaskStartReference('run')).toEqual({runId: 'run'});
    expect(decodeNativeTaskStartReference(taskViewRef)).toEqual({
      runId: 'run',
      actionRef: decodeNativeTaskActionRef(taskViewRef),
    });
    expect(decodeNativeTaskStartReference('taskref-v1.invalid')).toBeUndefined();
    expect(
      decodeNativeTaskStartReference(encodeNativeTaskActionRef({...decodedTaskViewRef, kind: 'work'})),
    ).toBeUndefined();
    expect(decodeNativeTaskStartReference(EffectString.repeat(129)('r'))).toBeUndefined();
  });

  it.each(['work', 'snapshot'] as const)(
    'round-trips opaque %s references and rejects malformed or extended values',
    kind => {
      const reference = {
        version: 1 as const,
        kind,
        runId: 'run',
        generationHash: EffectString.repeat(64)('a'),
        stateRevision: EffectString.repeat(64)('b'),
        phaseId: 'phase-one',
        phaseHash: EffectString.repeat(64)('c'),
        baselineHead: EffectString.repeat(40)('d'),
        baselineTree: EffectString.repeat(40)('e'),
        baselineRef: 'refs/threadnote/cycle/baseline/phase-one',
        ...(kind === 'snapshot'
          ? {
              snapshotId: 'historical-predecessor',
              sourceHead: EffectString.repeat(40)('f'),
              sourceTree: EffectString.repeat(40)('a'),
            }
          : {}),
      };
      const encoded = encodeNativeTaskActionRef(reference);
      expect(encoded).toMatch(/^taskref-v1\./u);
      expect(decodeNativeTaskActionRef(encoded)).toEqual(reference);
      expect(decodeNativeTaskStartReference(encoded)).toBeUndefined();
      if (kind === 'snapshot') {
        expect(() => encodeNativeTaskActionRef({...reference, sourceHead: 'invalid-object-id'})).toThrow();
        expect(() => encodeNativeTaskActionRef({...reference, phaseHash: 'invalid-phase-hash'})).toThrow();
      }
      expect(decodeNativeTaskActionRef('taskref-v1.not-base64-json')).toBeUndefined();
      const withUnknown = btoa(JSON.stringify({...reference, hidden: true}));
      expect(
        decodeNativeTaskActionRef(
          `taskref-v1.${EffectString.replaceAll('=', '')(EffectString.replaceAll('/', '_')(EffectString.replaceAll('+', '-')(withUnknown)))}`,
        ),
      ).toBeUndefined();
    },
  );

  it('is deterministic, bounded, and returns only actionable fields', () => {
    const revision = Effect.pipe('f', EffectString.repeat(64));
    const view = projectNativeTaskView(state, revision);
    expect(projectNativeTaskView(state, revision)).toEqual(view);
    expect(view).toMatchObject({
      status: 'ready',
      objective: plan.objective,
      next: {action: 'implement', phaseId: 'phase-one'},
      role: 'implementation',
      phase: {
        id: 'phase-one',
        scope: ['src/task.ts'],
        acceptance: ['Returns bounded actionable content'],
        acceptanceRefs: ['acceptance-one'],
      },
    });
    expect(view).not.toHaveProperty('cycle');
    expect(new TextEncoder().encode(JSON.stringify(view)).byteLength).toBeLessThan(8192);
  });

  it('reports explicit missing inputs for an uninitialized run without changing the input', () => {
    const before = structuredClone(state);
    const view = projectNativeTaskView({...state, cycle: undefined}, Effect.pipe('f', EffectString.repeat(64)), {
      role: 'implementation',
    });
    expect(view).toMatchObject({
      status: 'uninitialized',
      role: 'implementation',
      missingInputs: ['A verified native cycle plan'],
    });
    expect(state).toEqual(before);
  });

  it('retrieves every admitted list item over continuation pages without mutation', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({min: 1, max: 128}), {minLength: 1, maxLength: 128}), values => {
        const expandedPlan: NativeCyclePlan = {
          ...plan,
          phases: [
            {
              ...plan.phases[0],
              allowedPaths: EffectArray.map(values, (value, index) => `src/${value}-${index}.ts`),
              acceptanceCriteria: EffectArray.map(values, (value, index) => `criterion ${value}-${index}`),
              acceptanceRefs: EffectArray.map(values, (value, index) => ({
                id: `ref-${value}-${index}`,
                criterion: `criterion ${value}-${index}`,
                requirements: [],
                specScenarios: [],
              })),
            },
          ],
        };
        const cycle = initializeNativeCycle(expandedPlan);
        const input: NativeWorkflowState = {
          ...state,
          cycle: {...state.cycle!, state: cycle, plans: [expandedPlan]},
        };
        const before = structuredClone(input);
        const revision = Effect.pipe('f', EffectString.repeat(64));
        const scope: string[] = [];
        const acceptance: string[] = [];
        const acceptanceRefs: string[] = [];
        let offset = 0;
        while (true) {
          const view = projectNativeTaskView(input, revision, {offset});
          expect(view.counts).toMatchObject({
            scope: values.length,
            acceptance: values.length,
            acceptanceRefs: values.length,
          });
          scope.push(...(view.phase?.scope ?? []));
          acceptance.push(...(view.phase?.acceptance ?? []));
          acceptanceRefs.push(...(view.phase?.acceptanceRefs ?? []));
          if (view.page.nextOffset === undefined) break;
          expect(view.page.nextOffset).toBe(offset + 16);
          const cursor = view.page.nextCursor;
          expect(cursor).toBeDefined();
          const decoded = decodeNativeTaskCursor(cursor!);
          expect(decoded?.offset).toBe(view.page.nextOffset);
          expect(nativeTaskCursorMatches(decoded!, view)).toBe(true);
          offset = decoded!.offset;
        }
        expect(scope).toEqual(expandedPlan.phases[0].allowedPaths);
        expect(acceptance).toEqual(expandedPlan.phases[0].acceptanceCriteria);
        expect(acceptanceRefs).toEqual(EffectArray.map(expandedPlan.phases[0].acceptanceRefs, ref => ref.id));
        expect(input).toEqual(before);
      }),
    );
  });

  it('rejects malformed and stale continuations when canonical task identity changes', () => {
    const expanded = {
      ...plan,
      phases: [{...plan.phases[0], allowedPaths: Array.from({length: 20}, (_, index) => `src/${index}.ts`)}],
    } satisfies NativeCyclePlan;
    const input: NativeWorkflowState = {
      ...state,
      cycle: {...state.cycle!, state: initializeNativeCycle(expanded), plans: [expanded]},
    };
    const current = projectNativeTaskView(input, 'revision-one');
    const token = current.page.nextCursor;
    expect(token).toBeDefined();
    expect(decodeNativeTaskCursor('task-v1.not-a-cursor')).toBeUndefined();
    const cursor = decodeNativeTaskCursor(token!);
    expect(cursor).toBeDefined();
    expect(nativeTaskCursorMatches(cursor!, projectNativeTaskView(input, 'revision-one'))).toBe(true);
    expect(nativeTaskCursorMatches(cursor!, projectNativeTaskView(input, 'revision-two'))).toBe(false);
    expect(
      nativeTaskCursorMatches(cursor!, projectNativeTaskView({...input, runId: 'other-run'}, 'revision-one')),
    ).toBe(false);
    expect(nativeTaskCursorMatches(cursor!, projectNativeTaskView(input, 'revision-one', {role: 'delivery'}))).toBe(
      false,
    );
  });

  it('stales a continuation when the refreshed external candidate set changes at the same native revision', () => {
    const expanded = {
      ...plan,
      phases: [{...plan.phases[0], allowedPaths: Array.from({length: 20}, (_, index) => `src/${index}.ts`)}],
    } satisfies NativeCyclePlan;
    const input: NativeWorkflowState = {
      ...state,
      cycle: {...state.cycle!, state: initializeNativeCycle(expanded), plans: [expanded]},
    };
    const revision = 'same-native-revision';

    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^phase-[a-z]{1,8}$/u), {minLength: 2, maxLength: 16}), candidateIds => {
        const pageOneCandidates = candidateIds;
        const refreshedCandidates = candidateIds.slice(1);
        const fingerprint = (ids: readonly string[]) => sha256HexSync(JSON.stringify(ids));
        const pageOne = projectNativeTaskView(input, revision, {candidateHash: fingerprint(pageOneCandidates)});
        const cursor = decodeNativeTaskCursor(pageOne.page.nextCursor!);

        expect(cursor).toBeDefined();
        expect(cursor?.candidateHash).toBe(fingerprint(pageOneCandidates));
        expect(nativeTaskCursorMatches(cursor!, pageOne, fingerprint(pageOneCandidates))).toBe(true);
        // A formerly eligible earlier candidate dropped from the refreshed external set.
        expect(nativeTaskCursorMatches(cursor!, pageOne, fingerprint(refreshedCandidates))).toBe(false);
        expect(pageOne.revision).toBe(revision);
      }),
      {numRuns: 40},
    );
  });

  it('keeps emitted cursors within the accepted input bound for admitted generation lengths', () => {
    const expanded = {
      ...plan,
      phases: [{...plan.phases[0], allowedPaths: Array.from({length: 20}, (_, index) => `src/${index}.ts`)}],
    } satisfies NativeCyclePlan;
    const cycle = initializeNativeCycle(expanded);
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', '漢', '🙂'), {minLength: 1, maxLength: 4096}), parts => {
        const input: NativeWorkflowState = {
          ...state,
          generation: EffectArray.join(parts, ''),
          cycle: {...state.cycle!, state: cycle, plans: [expanded]},
        };
        const view = projectNativeTaskView(input, 'revision');
        const token = view.page.nextCursor;
        expect(token).toBeDefined();
        expect(token!.length).toBeLessThanOrEqual(2048);
        const cursor = decodeNativeTaskCursor(token!);
        expect(cursor).toBeDefined();
        expect(nativeTaskCursorMatches(cursor!, view)).toBe(true);
      }),
      {numRuns: 30},
    );
    for (const generation of [
      Effect.pipe('g', EffectString.repeat(1500)),
      Effect.pipe('漢🙂', EffectString.repeat(750)),
      Effect.pipe('漢🙂', EffectString.repeat(2048)),
    ]) {
      const input: NativeWorkflowState = {
        ...state,
        generation,
        cycle: {...state.cycle!, state: cycle, plans: [expanded]},
      };
      const view = projectNativeTaskView(input, 'revision');
      const token = view.page.nextCursor;
      expect(token?.length).toBeLessThanOrEqual(2048);
      const cursor = token ? decodeNativeTaskCursor(token) : undefined;
      expect(cursor && nativeTaskCursorMatches(cursor, view)).toBe(true);
    }
  });

  it('round-trips task action references deterministically across bounded UTF-8 scope references', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'Z', '0', '漢', '🙂', '/'), {minLength: 1, maxLength: 80}), parts => {
        const ref = {
          version: 1 as const,
          kind: 'work' as const,
          runId: 'run-fixture',
          generationHash: Effect.pipe('a', EffectString.repeat(64)),
          stateRevision: Effect.pipe('b', EffectString.repeat(64)),
          phaseId: 'phase-one',
          phaseHash: Effect.pipe('c', EffectString.repeat(64)),
          baselineRef: `threadnote://fixture/${EffectArray.join(parts, '')}`,
        };
        const encoded = encodeNativeTaskActionRef(ref);
        expect(encodeNativeTaskActionRef(ref)).toBe(encoded);
        expect(decodeNativeTaskActionRef(encoded)).toEqual(ref);
      }),
      {numRuns: 80},
    );
  });

  it.each([
    {version: 1, previous: undefined, reviewMode: 'full'},
    {version: 1, previous: 'predecessor', reviewMode: 'incremental'},
    {version: 3, previous: 'predecessor', reviewMode: 'full'},
  ] as const)(
    'projects manifest $version review mode $reviewMode with predecessor $previous across pages',
    ({version, previous, reviewMode}) => {
      const cycleState = state.cycle!.state;
      const snapshot: NativeCycleSnapshot = {
        format: 'threadnote-native-cycle-snapshot',
        version,
        ...(previous ? {previous} : {}),
        snapshotId: 'review-one',
        phaseId: 'phase-one',
        phaseHash: cycleState.phases['phase-one'].phaseHash,
        repo: '/repo',
        head: Effect.pipe('a', EffectString.repeat(40)),
        baseTree: Effect.pipe('b', EffectString.repeat(40)),
        scopeBase: Effect.pipe('c', EffectString.repeat(40)),
        declaredBaseHead: Effect.pipe('d', EffectString.repeat(40)),
        scopeFiles: ['src/task.ts'],
        tree: Effect.pipe('e', EffectString.repeat(40)),
        files: EffectArray.map(
          Array.from({length: 18}, (_, index) => index),
          index => `src/file-${index}.ts`,
        ),
        pinnedRef: 'refs/threadnote/snapshot/review-one',
      };
      const runtime = {...state.cycle!, snapshots: [{snapshot, incoming: []}]};
      const input = {...state, cycle: runtime};
      const before = structuredClone(input);
      const view = projectNativeTaskView(input, Effect.pipe('f', EffectString.repeat(64)));
      expect(view).toMatchObject({
        status: 'ready',
        role: 'review',
        next: {action: 'review', phaseId: 'phase-one', snapshotId: 'review-one'},
        phase: {
          snapshot: {
            snapshotId: 'review-one',
            reviewMode,
            requiredReviewLanes: ['correctness', 'simplicity'],
            files: Array.from({length: 16}, (_, index) => `src/file-${index}.ts`),
          },
        },
        page: {offset: 0, limit: 16, nextOffset: 16},
        counts: {snapshotFiles: 18, snapshotScopeFiles: 1},
        missingInputs: [
          'A complete independent review for snapshot review-one',
          'Correctness and simplicity review lanes with complete reports',
        ],
      });
      const continuation = decodeNativeTaskCursor(view.page.nextCursor!);
      expect(continuation && nativeTaskCursorMatches(continuation, view)).toBe(true);
      const nextPage = projectNativeTaskView(input, Effect.pipe('f', EffectString.repeat(64)), {offset: 16});
      expect(nextPage.phase?.snapshot?.files).toEqual(['src/file-16.ts', 'src/file-17.ts']);
      expect(nextPage.phase?.snapshot).toMatchObject({
        snapshotId: 'review-one',
        reviewMode,
        requiredReviewLanes: ['correctness', 'simplicity'],
      });
      expect(nextPage.next).toEqual(view.next);
      expect(nextPage.taskRef).toBe(view.taskRef);
      expect(input).toEqual(before);
    },
  );

  it('keeps canonical invalidation blocking ahead of stale snapshot review hints', () => {
    const cycleState = state.cycle!.state;
    const snapshot: NativeCycleSnapshot = {
      format: 'threadnote-native-cycle-snapshot',
      version: 1,
      snapshotId: 'obsolete-review',
      phaseId: 'phase-one',
      phaseHash: cycleState.phases['phase-one'].phaseHash,
      repo: '/repo',
      head: Effect.pipe('a', EffectString.repeat(40)),
      baseTree: Effect.pipe('b', EffectString.repeat(40)),
      scopeBase: Effect.pipe('c', EffectString.repeat(40)),
      declaredBaseHead: Effect.pipe('d', EffectString.repeat(40)),
      scopeFiles: ['src/task.ts'],
      tree: Effect.pipe('e', EffectString.repeat(40)),
      files: ['src/task.ts'],
      pinnedRef: 'refs/threadnote/snapshot/obsolete-review',
    };
    const staleState = {
      ...cycleState,
      phases: {...cycleState.phases, 'phase-one': {...cycleState.phases['phase-one'], status: 'stale' as const}},
    };
    const view = projectNativeTaskView(
      {
        ...state,
        cycle: {...state.cycle!, state: staleState, snapshots: [{snapshot, incoming: []}]},
      },
      'revision',
    );
    expect(view).toMatchObject({status: 'blocked', next: {action: 'blocked', phaseId: 'phase-one'}});
    expect(view.next.action).not.toBe('review');
  });

  it('blocks a pending review at the canonical continuous phase limit', () => {
    const cycleState = state.cycle!.state;
    const snapshots = Array.from({length: 6}, (_, index) => {
      const snapshotId = `review-${index}`;
      const snapshot: NativeCycleSnapshot = {
        format: 'threadnote-native-cycle-snapshot',
        version: 1,
        snapshotId,
        phaseId: 'phase-one',
        phaseHash: cycleState.phases['phase-one'].phaseHash,
        repo: '/repo',
        head: Effect.pipe(String.fromCharCode(97 + index), EffectString.repeat(40)),
        baseTree: Effect.pipe('b', EffectString.repeat(40)),
        scopeBase: Effect.pipe('c', EffectString.repeat(40)),
        declaredBaseHead: Effect.pipe('d', EffectString.repeat(40)),
        scopeFiles: ['src/task.ts'],
        tree: Effect.pipe(String.fromCharCode(103 + index), EffectString.repeat(40)),
        files: ['src/task.ts'],
        pinnedRef: `refs/threadnote/snapshot/${snapshotId}`,
      };
      return {snapshot, incoming: []};
    });
    const reviews = EffectArray.map(snapshots.slice(0, 5), ({snapshot}) => ({
      snapshotId: snapshot.snapshotId,
      report: {
        snapshotId: snapshot.snapshotId,
        phaseHash: snapshot.phaseHash,
        snapshotTree: snapshot.tree,
        status: 'complete' as const,
        mode: 'full' as const,
        selected: ['correctness'],
        lanes: [{name: 'correctness', status: 'complete' as const}],
        findings: [],
      },
    }));
    const view = projectNativeTaskView(
      {
        ...state,
        cycle: {...state.cycle!, snapshots, reviews},
      },
      'revision',
    );
    expect(view).toMatchObject({
      status: 'blocked',
      role: 'review',
      next: {action: 'expand-review-budget', phaseId: 'phase-one', snapshotId: 'review-5'},
      missingInputs: ['Explicit human authorization to expand this phase review budget (current limit: 5)'],
    });
  });

  it('blocks obsolete plan content and asks for a verified reconciliation', () => {
    const view = projectNativeTaskView(state, Effect.pipe('f', EffectString.repeat(64)), {
      planDrift: 'The approved plan root changed.',
    });
    expect(view).toMatchObject({
      status: 'blocked',
      objective: 'Reconcile this cycle to its current approved plan.',
      next: {action: 'reconcile-plan', reason: 'The approved plan root changed.'},
      missingInputs: [
        'A fresh verified export of the current approved plan',
        'Cycle reconciliation against that export',
      ],
    });
    expect(view).not.toHaveProperty('phase');
  });
});
