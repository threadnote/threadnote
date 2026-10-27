import {it, expect} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {vi} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ResourceStore} from '@threadnote/store/resource-store';
import {parseMemoryDocument} from '@threadnote/memory/document';
import type {NativeAuthoringDocument} from '@threadnote/workflow-automations/authoring';
import type {NativeCloseoutAdmission} from '@threadnote/workflow-automations/closeout';
import {createNativeDocument} from '@threadnote/workflow-automations/templates';
import {runNativeCloseout} from '../../src/workflow_automation/closeout.js';
import {nativeWorkflowError} from '../../src/workflow_automation/memory.js';
import {
  planFreshNativeCloseoutDocuments,
  reserveNativeCloseoutCapacity,
} from '../../src/workflow_automation/closeout_capacity.js';
import {
  readNativeWorkflowState,
  writeNativeWorkflowState,
  withNativeWorkflowLock,
} from '../../src/workflow_automation/store.js';
import {runWorkflowMemory} from '../../src/workflow_memory/index.js';
import {
  inspectWorkflowJournal,
  withWorkflowLock,
  writeJournalFile,
  workflowTransition,
} from '../../src/workflow_memory/journal.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import {nativeCloseoutFixture} from './native-closeout-fixture.js';

const observed = vi.hoisted(() => ({
  captures: 0,
  prepared: [] as number[],
  afterPrepare: undefined as (() => Effect.Effect<void>) | undefined,
}));
vi.mock('../../src/workflow_memory/artifacts.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/workflow_memory/artifacts.js')>();
  return {
    ...original,
    withWorkflowProjectionCitations: (...args: Parameters<typeof original.withWorkflowProjectionCitations>) => {
      observed.captures++;
      return original.withWorkflowProjectionCitations(args[0], args[1], args[2], prepare =>
        args[3]((journal, request) =>
          prepare(journal, request).pipe(
            Effect.tap(operation =>
              Effect.sync(() => {
                observed.prepared.push(
                  parseMemoryDocument(operation.artifact.canonicalUri, operation.desired)?.metadata.codeCitations
                    ?.length ?? 0,
                );
              }),
            ),
            Effect.tap(() => Effect.suspend(() => observed.afterPrepare?.() ?? Effect.void)),
          ),
        ),
      );
    },
  };
});
const transaction = 'a'.repeat(64);
const run = <A, E, R>(program: Effect.Effect<A, E, R>) => program.pipe(TestClock.withLive, provideNative);
const proposal = (plan: NativeAuthoringDocument) => {
  if (plan.kind !== 'plan') throw new Error('Expected plan');
  return {
    architecture: {
      summary: 'The reader preserves complete results.',
      components: ['Reader', 'Store'],
      contracts: ['Complete reads.'],
      diagram: 'flowchart TD\n Reader --> Store',
      invariants: ['No truncation.'],
      unknowns: [],
      deviations: [],
      codeRefs: ['source.ts'],
    },
    architectureVerification: 'Inspected and exercised complete results.',
    combinedChecks: [{command: 'private fixture check', result: 'passed', evidence: 'Observed complete results.'}],
    phaseEvidence: plan.phases.map(phase => ({
      id: phase.id,
      acceptance: phase.acceptance.map(item => ({criterion: item.criterion, evidence: 'Observed ' + item.criterion})),
    })),
    scenarios: [],
    decisions: plan.decisions.map(item => ({
      id: item.id,
      implemented: item.selected,
      rationale: 'Applied the approved implementation and retained its tradeoffs.',
    })),
  };
};
const admission = (behavior = false): NativeCloseoutAdmission => ({
  format: 'threadnote-native-closeout-admission',
  version: 1,
  featureId: 'feature',
  project: 'fixture',
  planDocumentHash: 'b'.repeat(64),
  architecture: {
    summary: 'Complete results.',
    components: ['Reader'],
    contracts: [],
    diagram: 'flowchart TD\n Reader --> Store',
    invariants: [],
    unknowns: [],
    deviations: [],
    codeRefs: [],
  },
  architectureVerification: 'Verified.',
  combinedChecks: [],
  phaseEvidence: [],
  decisions: [],
  scenarios: [],
  documents: {
    architecture: createNativeDocument({
      kind: 'architecture-current',
      title: 'Feature — Implemented architecture',
      sections: {summary: 'Complete results.', components: 'Reader'},
    }),
    decisions: [],
    handoff: createNativeDocument({
      kind: 'handoff',
      title: 'Handoff',
      sections: {task: 'Complete.', verification: 'Checked.', 'next-step': 'Maintain.'},
    }),
    ...(behavior
      ? {
          behavior: createNativeDocument({
            kind: 'spec',
            title: 'Behavior',
            sections: {summary: 'Complete.', requirements: 'Complete reads.', acceptance: 'All fields returned.'},
          }),
        }
      : {}),
  },
});
const fixture = Effect.gen(function* () {
  const f = yield* nativeFixture();
  yield* f.init();
  const system = yield* SystemInfo;
  const scopedSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
  const stored = yield* readNativeWorkflowState(f.config, 'native-run');
  if (!stored) throw new Error('Expected native state');
  return {...f, state: stored.state, scopedSystem};
});

it.effect(
  'fresh whole PREPARE uses one final projection and zero output native preflights without knowledge writes',
  () =>
    Effect.gen(function* () {
      const f = yield* nativeCloseoutFixture(false);
      const system = yield* SystemInfo;
      const scopedSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
      const state = yield* readNativeWorkflowState(f.config, f.controllerRunId);
      if (!state) throw new Error('Expected controller');
      const account = f.path.join(f.home, 'data', f.config.account);
      const snapshot = Effect.gen(function* () {
        const paths = (yield* f.fs.readDirectory(account, {recursive: true})).sort();
        return yield* Effect.forEach(paths, path =>
          Effect.gen(function* () {
            const file = f.path.join(account, path);
            return {
              path,
              content:
                (yield* f.fs.stat(file)).type === 'File' ? sha256HexSync(yield* f.fs.readFile(file)) : 'directory',
            };
          }),
        );
      });
      const before = yield* snapshot;
      let preflights = 0;
      const inspectionLocks: boolean[] = [];
      observed.captures = 0;
      observed.prepared.length = 0;
      const result = yield* runNativeCloseout(
        f.config,
        {...f.base('closeout', f.controllerRunId), command: 'prepare', proposal: proposal(f.plan)},
        input =>
          Effect.gen(function* () {
            const request = input as {action: string; operationId?: string};
            if (request.action === 'preflight' && request.operationId?.startsWith('closeout-')) preflights++;
            if (request.action === 'inspect')
              inspectionLocks.push(yield* f.fs.exists(f.journalPath(state.state.bindingId) + '.lock'));
            return yield* f.call(input);
          }).pipe(Effect.mapError(nativeWorkflowError)),
      ).pipe(Effect.provideService(SystemInfo, scopedSystem));
      expect(result).toMatchObject({status: 'ok', closeout: {state: 'prepared'}});
      expect(preflights).toBe(0);
      expect(observed.captures).toBe(1);
      expect(observed.prepared).toHaveLength(6);
      expect(observed.prepared.every(count => count > 0)).toBe(true);
      expect(inspectionLocks.length).toBeGreaterThan(0);
      expect(inspectionLocks.every(held => !held)).toBe(true);
      expect(yield* snapshot).toEqual(before);
      const after = yield* readNativeWorkflowState(f.config, f.controllerRunId);
      expect(after?.state.operations).toHaveLength(0);
      expect(after?.state.closeoutSave?.operationIds).toHaveLength(6);
    }).pipe(run),
);

it.effect('speculative repeated behavior names preserve the sequential create-and-replace graph', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const documents = yield* planFreshNativeCloseoutDocuments(f.config, f.state, transaction, admission(true), []).pipe(
      Effect.provideService(SystemInfo, f.scopedSystem),
    );
    if (!documents) throw new Error('Expected fresh planning');
    expect(documents.map(item => item.key)).toEqual(['behavior', 'handoff', 'architecture', 'behavior']);
    expect(documents[0].uri).toBe(documents[3].uri);
    expect(documents[0].body).toBe(documents[3].body);
    expect(documents[3].relations).toEqual([{type: 'references', uri: documents[2].uri}]);
    const reservation = yield* reserveNativeCloseoutCapacity(f.config, 'native-run', transaction, documents, [], [], {
      requireFreshOutputs: true,
    }).pipe(Effect.provideService(SystemInfo, f.scopedSystem));
    expect(reservation.operationIds.at(-1)).toBe('closeout-' + transaction.slice(0, 24) + '-behavior-final');
    const reserved = yield* readNativeWorkflowState(f.config, 'native-run');
    if (!reserved) throw new Error('Expected reserved controller');
    expect(
      yield* planFreshNativeCloseoutDocuments(f.config, reserved.state, transaction, admission(true), []).pipe(
        Effect.provideService(SystemInfo, f.scopedSystem),
      ),
    ).toBeUndefined();
  }).pipe(run),
);

it.effect('live destination drift rejects speculative names before any reservation', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const documents = yield* planFreshNativeCloseoutDocuments(f.config, f.state, transaction, admission(), []).pipe(
      Effect.provideService(SystemInfo, f.scopedSystem),
    );
    if (!documents) throw new Error('Expected fresh planning');
    yield* f.store.write(f.location, documents[0].uri, 'External destination collision.', {mode: 'create'});
    const before = yield* f.fs.readFileString(f.statePath());
    const result = yield* reserveNativeCloseoutCapacity(f.config, 'native-run', transaction, documents, [], [], {
      requireFreshOutputs: true,
    }).pipe(Effect.provideService(SystemInfo, f.scopedSystem), Effect.result);
    expect(result._tag).toBe('Failure');
    expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
    expect(yield* f.fs.exists(f.statePath() + '.closeout.json')).toBe(false);
  }).pipe(run),
);

it.effect.each(['lower-create', 'manifest-transition'] as const)(
  'a real %s during projection cannot race the final fresh reservation fence',
  interleaving =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const documents = yield* planFreshNativeCloseoutDocuments(f.config, f.state, transaction, admission(), []).pipe(
        Effect.provideService(SystemInfo, f.scopedSystem),
      );
      if (!documents) throw new Error('Expected fresh planning');
      const context = yield* Effect.context<Effect.Services<ReturnType<typeof runWorkflowMemory>>>();
      let interleaved = false;
      observed.afterPrepare = () => {
        if (interleaved) return Effect.void;
        interleaved = true;
        const document = documents[0];
        const id = 'closeout-' + transaction.slice(0, 24) + '-' + document.key;
        const lower =
          interleaving === 'lower-create'
            ? runWorkflowMemory(f.config, {
                protocolVersion: 1,
                action: 'create',
                bindingId: f.state.bindingId,
                operationId: id,
                artifactKey: id,
                sourceRunId: 'native-run',
                role: 'closeout-' + document.key,
                nameHint: document.key,
                body: document.body,
                bodySha256: sha256HexSync(document.body),
                expectedRevision: null,
                storageKind: 'durable',
              })
            : withWorkflowLock(
                f.config,
                f.state.bindingId,
                Effect.gen(function* () {
                  const journal = yield* inspectWorkflowJournal(f.config, f.state.bindingId);
                  yield* writeJournalFile(
                    f.config,
                    workflowTransition(journal.state, journal.state, '2050-01-01T00:00:00.000Z'),
                  );
                }),
              );
        return lower.pipe(
          Effect.provideService(SystemInfo, f.scopedSystem),
          Effect.provideContext(context),
          Effect.orDie,
          Effect.asVoid,
        );
      };
      const before = yield* f.fs.readFileString(f.statePath());
      const result = yield* reserveNativeCloseoutCapacity(f.config, 'native-run', transaction, documents, [], [], {
        requireFreshOutputs: true,
      }).pipe(
        Effect.provideService(SystemInfo, f.scopedSystem),
        Effect.result,
        Effect.ensuring(
          Effect.sync(() => {
            observed.afterPrepare = undefined;
          }),
        ),
      );
      expect(interleaved).toBe(true);
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: {code: interleaving === 'lower-create' ? 'closeout-capacity' : 'binding-recovery-needed'},
      });
      expect(yield* f.fs.readFileString(f.statePath())).toBe(before);
      if (interleaving === 'lower-create') {
        expect(yield* f.store.read(f.location, documents[0].uri)).toContain('Handoff');
        expect(
          yield* planFreshNativeCloseoutDocuments(f.config, f.state, transaction, admission(), []).pipe(
            Effect.provideService(SystemInfo, f.scopedSystem),
          ),
        ).toBeUndefined();
      }
    }).pipe(run),
);

it.effect('allocation-only probes do not create missing foreign storage roots and legacy intents fall back', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const foreign = f.path.join(f.root, 'foreign');
    yield* f.fs.makeDirectory(foreign);
    let probes = 0;
    const store = ResourceStore.of({
      ...f.store,
      read: (location, uri, options) => {
        if (options?.existingOnly) {
          probes++;
          return f.store.read({...location, home: foreign}, uri, options);
        }
        return f.store.read(location, uri, options);
      },
    });
    expect(
      yield* planFreshNativeCloseoutDocuments(f.config, f.state, transaction, admission(), []).pipe(
        Effect.provideService(SystemInfo, f.scopedSystem),
        Effect.provideService(ResourceStore, store),
      ),
    ).toBeDefined();
    expect(probes).toBeGreaterThan(0);
    expect(yield* f.fs.readDirectory(foreign, {recursive: true})).toEqual([]);
    const id = 'closeout-' + transaction.slice(0, 24) + '-handoff';
    yield* f.call(f.write({operationId: id, artifactKey: id, role: 'closeout-handoff', nameHint: 'handoff'}));
    const current = yield* readNativeWorkflowState(f.config, 'native-run');
    if (!current) throw new Error('Expected state');
    expect(
      yield* planFreshNativeCloseoutDocuments(f.config, current.state, transaction, admission(), []).pipe(
        Effect.provideService(SystemInfo, f.scopedSystem),
      ),
    ).toBeUndefined();
    const retry = {
      ...f.write({operationId: id, artifactKey: id, role: 'closeout-handoff', nameHint: 'handoff'}),
      action: 'preflight',
    };
    expect(yield* f.call({...retry, body: 'A different output intent.'}).pipe(Effect.result)).toMatchObject({
      _tag: 'Failure',
      failure: {code: 'operation-intent-conflict'},
    });
    const preparedState = {
      ...current.state,
      operations: current.state.operations.map(operation => {
        const {artifact: _artifact, ...prepared} = operation;
        return {...prepared, status: 'prepared' as const};
      }),
    };
    yield* withNativeWorkflowLock(
      f.config,
      'native-run',
      false,
      writeNativeWorkflowState(f.config, preparedState, current.revision),
    );
    expect(
      yield* planFreshNativeCloseoutDocuments(f.config, preparedState, transaction, admission(), []).pipe(
        Effect.provideService(SystemInfo, f.scopedSystem),
      ),
    ).toBeUndefined();
    expect(yield* f.call(retry).pipe(Effect.result)).toMatchObject({
      _tag: 'Failure',
      failure: {code: 'pending-operation'},
    });
  }).pipe(run),
);
