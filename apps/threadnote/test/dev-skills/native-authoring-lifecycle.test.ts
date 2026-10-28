import {Effect, FileSystem, Result} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {ResourceStore} from '@threadnote/store/resource-store';
import {loadRecallIndexData, recallIndexStatus} from '@threadnote/recall/index';
import {runCommandEffect} from '@threadnote/platform/command';
import {
  decodeNativeAuthoringDocument,
  nativeAuthoringDigest,
  type NativeAuthoringDocument,
} from '@threadnote/workflow-automations/authoring';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {CurrentNativeOperationLimit} from '../../src/workflow_automation/store.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import {
  AuthoringRootSchema,
  decodeAuthoringArtifact,
  type AuthoringReference,
  type AuthoringRoot,
} from '../../src/workflow_automation/authoring_artifacts.js';

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result);
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object response');
  return value as ObjectValue;
};
const authoring = (value: unknown): ObjectValue => object(object(value).authoring);
const reference = (value: unknown): {uri: string; memoryId: string; revision: string} => {
  const result = object(value);
  if (typeof result.uri !== 'string' || typeof result.memoryId !== 'string' || typeof result.revision !== 'string')
    throw new Error('Expected a native memory reference');
  return {uri: result.uri, memoryId: result.memoryId, revision: result.revision};
};
const authoringRequest = (
  f: Effect.Success<ReturnType<typeof nativeFixture>>,
  command: string,
  changes: ObjectValue = {},
) => f.call({...f.base('authoring'), command, ...changes});

const seedEvidence = (f: Effect.Success<ReturnType<typeof nativeFixture>>, count: number) =>
  Effect.gen(function* () {
    const references: ReturnType<typeof reference>[] = [];
    for (let index = 0; index < count; index++) {
      const result = object(
        yield* f.call({
          ...f.base('write'),
          operationId: `seed-evidence-${index}`,
          artifactKey: `seed-evidence-${index}`,
          role: 'evidence',
          nameHint: 'evidence',
          body: `Private evidence ${index} is a real active native memory artifact.\n`,
          expectedRevision: null,
          storageKind: 'durable',
        }),
      );
      references.push(reference(result.artifact));
    }
    return references;
  });

const interruptNativeReceipt = (
  f: Effect.Success<ReturnType<typeof nativeFixture>>,
  matches: (intent: {
    readonly artifactKey?: string;
    readonly role?: string;
    readonly body?: string;
    readonly expectedRevision?: string | null;
  }) => boolean,
) =>
  Effect.gen(function* () {
    const stateFile = yield* f.fs
      .realPath(f.home)
      .pipe(Effect.map(home => f.path.join(home, 'workflow-automations', 'native-v1', 'native-run.json')));
    const originalFs = yield* FileSystem.FileSystem;
    let interrupted = false;
    const failingFs = FileSystem.FileSystem.of({
      ...originalFs,
      rename: (from, to) => {
        if (to !== stateFile || interrupted) return originalFs.rename(from, to);
        return originalFs.readFileString(from).pipe(
          Effect.flatMap(raw => {
            try {
              const candidate = JSON.parse(raw) as {
                operations?: {
                  status?: string;
                  intent?: {artifactKey?: string; role?: string; body?: string; expectedRevision?: string | null};
                }[];
              };
              const last = candidate.operations?.at(-1);
              if (last?.status === 'verified' && last.intent && matches(last.intent)) {
                interrupted = true;
                return Effect.sync(() => {
                  throw new Error('Synthetic final authoring receipt rename interruption');
                });
              }
            } catch {
              // Let ordinary file errors surface; this hook only intercepts matching native-state candidates.
            }
            return originalFs.rename(from, to);
          }),
        );
      },
    });
    return {failingFs, interrupted: () => interrupted, stateFile};
  });

const interruptReservationAcknowledgement = (
  f: Effect.Success<ReturnType<typeof nativeFixture>>,
  operationCount: number,
) =>
  Effect.gen(function* () {
    const stateFile = f.path.join(yield* f.fs.realPath(f.home), 'workflow-automations', 'native-v1', 'native-run.json');
    const originalFs = yield* FileSystem.FileSystem;
    let interrupted = false;
    let observedReservation: {operationStart?: number; operationLimit?: number; reservedBytes?: number} | undefined;
    const failingFs = FileSystem.FileSystem.of({
      ...originalFs,
      rename: (from, to) => {
        if (to !== stateFile || interrupted) return originalFs.rename(from, to);
        return originalFs.readFileString(from).pipe(
          Effect.flatMap(raw => {
            try {
              const candidate = JSON.parse(raw) as {
                authoringSave?: {operationStart?: number; operationLimit?: number; reservedBytes?: number};
                operations?: unknown[];
              };
              if (candidate.authoringSave !== undefined && candidate.operations?.length === operationCount) {
                observedReservation = candidate.authoringSave;
                return originalFs.rename(from, to).pipe(
                  Effect.flatMap(() => {
                    interrupted = true;
                    return Effect.sync(() => {
                      throw new Error('Synthetic lost authoring-reservation acknowledgement');
                    });
                  }),
                );
              }
            } catch {
              // Only inspect canonical native-state candidates; other files use the real filesystem behavior.
            }
            return originalFs.rename(from, to);
          }),
        );
      },
    });
    return {failingFs, interrupted: () => interrupted, observedReservation: () => observedReservation, stateFile};
  });

const interruptAfterVerifiedNativeReceipt = (
  f: Effect.Success<ReturnType<typeof nativeFixture>>,
  matches: (intent: {readonly artifactKey?: string; readonly role?: string}) => boolean,
) =>
  Effect.gen(function* () {
    const stateFile = yield* f.fs
      .realPath(f.home)
      .pipe(Effect.map(home => f.path.join(home, 'workflow-automations', 'native-v1', 'native-run.json')));
    const originalFs = yield* FileSystem.FileSystem;
    let interrupted = false;
    const failingFs = FileSystem.FileSystem.of({
      ...originalFs,
      rename: (from, to) => {
        if (to !== stateFile || interrupted) return originalFs.rename(from, to);
        return originalFs.readFileString(from).pipe(
          Effect.flatMap(raw => {
            try {
              const candidate = JSON.parse(raw) as {
                operations?: {status?: string; intent?: {artifactKey?: string; role?: string}}[];
              };
              const last = candidate.operations?.at(-1);
              if (last?.status === 'verified' && last.intent && matches(last.intent))
                return originalFs.rename(from, to).pipe(
                  Effect.flatMap(() => {
                    interrupted = true;
                    return Effect.sync(() => {
                      throw new Error('Synthetic interruption after verified child receipt');
                    });
                  }),
                );
            } catch {
              // Only matching native-state candidates trigger the post-commit interruption.
            }
            return originalFs.rename(from, to);
          }),
        );
      },
    });
    return {failingFs, interrupted: () => interrupted, stateFile};
  });

const context = {
  codeRefs: [] as string[],
  evidenceRefs: [] as [],
  note: 'Source-free fixture with no external evidence.',
};
const specDocument = (changes: ObjectValue = {}) =>
  decodeNativeAuthoringDocument({
    format: 'threadnote-native-authoring',
    schemaVersion: 1,
    kind: 'spec',
    id: 'feature',
    project: 'fixture',
    title: 'Lifecycle feature',
    objective: 'Keep a verified lifecycle behavior available.',
    requirements: [{id: 'req-read', behavior: 'A reader receives the saved document.'}],
    context,
    source: null,
    sourceFreeReason: 'This lifecycle test exercises authoring without inspected source.',
    actors: ['author'],
    inScope: ['Save and reload the native document.'],
    outOfScope: [],
    constraints: ['Retain complete UTF-8 content.'],
    observations: [],
    scenarios: [
      {
        id: 'scenario-read',
        requirementIds: ['req-read'],
        given: 'A native document was saved.',
        when: 'The author loads its root.',
        then: 'The complete document is returned.',
      },
    ],
    assumptions: [],
    questions: [],
    artifacts: [],
    review: {required: true, reason: 'A behavior change requires acceptance review.'},
    ...changes,
  });

const largePlan = (revision: number): NativeAuthoringDocument => {
  const stableComponents = Array.from(
    {length: 45},
    (_, index) => `component-${index.toString().padStart(2, '0')} ${'x'.repeat(990)}`,
  );
  return decodeNativeAuthoringDocument({
    format: 'threadnote-native-authoring',
    schemaVersion: 1,
    kind: 'plan',
    id: 'feature',
    project: 'fixture',
    title: 'Lifecycle plan',
    objective: `Implement lifecycle behavior; revision ${revision.toString().padStart(3, '0')}.`,
    requirements: [{id: 'req-read', behavior: 'A reader receives the saved document.'}],
    context,
    source: null,
    sourceFreeReason: 'The plan fixture has no code snapshot.',
    current: {
      summary: 'The authoring state is currently local.',
      components: stableComponents,
      contracts: ['Native memory retains complete structured data.'],
      diagram: 'flowchart TD\n  Author --> LocalMemory',
    },
    target: {
      summary: 'The author can reload every verified revision.',
      components: stableComponents,
      contracts: ['Revision history remains addressable.'],
      diagram: 'flowchart TD\n  Author --> Root --> History',
    },
    phases: [
      {
        id: 'phase-save',
        title: 'Save authoring data',
        outcome: 'The complete authoring plan is saved and reloadable.',
        dependsOn: [],
        affectedPaths: ['src/authoring.ts'],
        newPaths: [],
        contracts: ['Keep root identity stable during replacement.'],
        acceptance: [
          {
            id: 'accept-reload',
            criterion: 'The complete current document can be loaded.',
            verification: 'Compare loaded canonical document with the saved value.',
            requirementIds: ['req-read'],
          },
        ],
        safeBoundary: 'Do not alter unrelated project memories.',
      },
    ],
    decisions: [
      {
        id: 'decision-history',
        question: 'How are old revisions retained?',
        selection: 'no-better-alternative',
        selected: 'Keep an immutable chain of root snapshots.',
        alternatives: [],
        rationale: 'This preserves independently readable complete history.',
        affectedPhases: ['phase-save'],
        authority: 'orchestrator',
      },
    ],
    openQuestions: [],
    review: {required: false, reason: 'This synthetic lifecycle plan is not an approval.'},
  });
};

const smallPlan = () =>
  decodeNativeAuthoringDocument({
    format: 'threadnote-native-authoring',
    schemaVersion: 1,
    kind: 'plan',
    id: 'feature',
    project: 'fixture',
    title: 'Lifecycle implementation plan',
    objective: 'Implement the approved lifecycle behavior.',
    requirements: [{id: 'req-read', behavior: 'A reader receives the saved document.'}],
    context,
    source: null,
    sourceFreeReason: 'This plan fixture has no source snapshot.',
    current: {
      summary: 'The current behavior is represented in local memory.',
      components: ['Native authoring store'],
      contracts: [],
      diagram: 'flowchart TD\n  Caller --> Store',
    },
    target: {
      summary: 'The accepted behavior is implemented with durable history.',
      components: ['Native authoring store', 'History roots'],
      contracts: ['Every accepted revision remains inspectable.'],
      diagram: 'flowchart TD\n  Caller --> Store --> History',
    },
    phases: [
      {
        id: 'phase-save',
        title: 'Save the document',
        outcome: 'The native document can be saved and reloaded.',
        dependsOn: [],
        affectedPaths: ['src/authoring.ts'],
        newPaths: [],
        contracts: ['Keep the existing native root identity.'],
        acceptance: [
          {
            id: 'accept-load',
            criterion: 'The saved document reloads completely.',
            verification: 'Read the document by its verified root.',
            requirementIds: ['req-read'],
            scenarioIds: ['scenario-read'],
          },
        ],
        safeBoundary: 'Do not change unrelated artifacts.',
      },
    ],
    decisions: [
      {
        id: 'decision-history',
        question: 'How should prior decisions be preserved?',
        selection: 'no-better-alternative',
        selected: 'Retain exact decision history under immutable roots.',
        alternatives: [],
        rationale: 'Exact snapshots preserve the decision evidence for later review.',
        affectedPhases: ['phase-save'],
        authority: 'orchestrator',
      },
    ],
    openQuestions: [],
    review: {required: false, reason: 'This plan is a synthetic import fixture.'},
  });

describe('native authoring lifecycle', () => {
  effectIt.effect('clears a reservation whose state commit succeeded but whose acknowledgement was interrupted', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
      const seed = object(yield* f.call(f.write({operationId: 'reservation-seed', artifactKey: 'reservation-seed'})));
      const seedRef = reference(seed.artifact);
      const before = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {
        operations: {intent: {operationId: string}}[];
      };
      const fault = yield* interruptReservationAcknowledgement(f, before.operations.length);
      const document = specDocument();
      const save = {document, ready: false, expectedRevision: null};
      const interrupted = yield* failure(
        authoringRequest(f, 'save', save).pipe(
          Effect.provideService(CurrentNativeOperationLimit, 6),
          Effect.provideService(FileSystem.FileSystem, fault.failingFs),
        ),
      );
      expect(fault.interrupted()).toBe(true);
      expect(fault.observedReservation()).toMatchObject({operationStart: 1, operationLimit: 6});
      expect(fault.observedReservation()?.reservedBytes).toBeGreaterThan(0);
      expect(Result.isFailure(interrupted)).toBe(true);
      const cleaned = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {
        operations: {intent: {operationId: string}; status: string}[];
        authoringSave?: unknown;
      };
      expect(cleaned.operations).toHaveLength(before.operations.length);
      expect(cleaned.authoringSave).toBeUndefined();
      expect(
        cleaned.operations.some(item => item.intent.operationId === 'reservation-seed' && item.status === 'verified'),
      ).toBe(true);

      const saved = authoring(
        yield* authoringRequest(f, 'save', save).pipe(Effect.provideService(CurrentNativeOperationLimit, 6)),
      );
      const state = JSON.parse(yield* f.fs.readFileString(f.statePath())) as {
        operations: {intent: {operationId: string}; status: string}[];
        authoringSave?: unknown;
      };
      expect(reference(saved.root).memoryId).toMatch(/^tn_/u);
      expect(state.operations.filter(item => item.intent.operationId === 'reservation-seed')).toHaveLength(1);
      expect(state.authoringSave).toBeUndefined();
      expect(state.operations.length).toBeGreaterThan(before.operations.length);
      expect(state.operations.length).toBeLessThanOrEqual(6);
      const seedRead = object(yield* f.call({...f.base('read'), uri: seedRef.uri}));
      expect(object(seedRead.artifact)).toMatchObject({
        memoryId: seedRef.memoryId,
        body: expect.stringContaining('A Unicode plan'),
      });
    }).pipe(run),
  );

  effectIt.effect('reserves one six-operation save across child interruption and rejects competing writes', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const seed = object(
        yield* f.call(
          f.write({
            operationId: 'budget-seed',
            artifactKey: 'budget-seed',
            role: 'seed',
            body: 'An unrelated native write predating the authoring reservation.\n',
          }),
        ),
      );
      const seedRef = reference(seed.artifact);
      const journalFile = f.journalPath(initialized.bindingId);
      const document = specDocument();
      const save = {document, ready: false, expectedRevision: null};
      const fault = yield* interruptNativeReceipt(f, intent => intent.role === 'authoring-child');
      const interrupted = yield* failure(
        authoringRequest(f, 'save', save).pipe(
          Effect.provideService(CurrentNativeOperationLimit, 6),
          Effect.provideService(FileSystem.FileSystem, fault.failingFs),
        ),
      );
      expect(fault.interrupted()).toBe(true);
      expect(Result.isFailure(interrupted)).toBe(true);
      const stateFile = fault.stateFile;
      const pendingBytes = yield* f.fs.readFileString(stateFile);
      const pending = JSON.parse(pendingBytes) as {
        authoringSave: {
          intentDigest: string;
          operationStart: number;
          operationLimit: number;
          reservedBytes: number;
        };
        operations: {status: string; intent: {operationId: string; role: string; artifactKey: string}}[];
      };
      expect(pending.authoringSave).toMatchObject({operationStart: 1, operationLimit: 6});
      expect(pending.authoringSave.reservedBytes).toBeGreaterThan(0);
      expect(pending.operations).toHaveLength(2);
      const sourceChild = pending.operations.find(item => item.status === 'prepared');
      expect(sourceChild?.intent.role).toBe('authoring-child');
      const journalBytes = yield* f.fs.readFileString(journalFile);

      const changed = specDocument({objective: 'An altered request cannot spend another save reservation.'});
      const wrongIntent = yield* failure(
        authoringRequest(f, 'save', {...save, document: changed}).pipe(
          Effect.provideService(CurrentNativeOperationLimit, 6),
        ),
      );
      expect(wrongIntent).toMatchObject({_tag: 'Failure', failure: {code: 'pending-operation'}});
      const directRecover = yield* failure(
        f.call({...f.base('recover'), operationId: sourceChild!.intent.operationId}),
      );
      expect(directRecover).toMatchObject({_tag: 'Failure', failure: {code: 'pending-operation'}});
      const competingWrite = yield* failure(
        f.call(f.write({operationId: 'competing-write', artifactKey: 'competing-write', role: 'other'})),
      );
      expect(competingWrite).toMatchObject({_tag: 'Failure', failure: {code: 'pending-operation'}});
      expect(yield* f.fs.readFileString(stateFile)).toBe(pendingBytes);
      expect(yield* f.fs.readFileString(journalFile)).toBe(journalBytes);

      const recovered = authoring(
        yield* authoringRequest(f, 'save', save).pipe(Effect.provideService(CurrentNativeOperationLimit, 6)),
      );
      expect(recovered).toMatchObject({readiness: 'draft', changed: true});
      const recoveredState = JSON.parse(yield* f.fs.readFileString(stateFile)) as {
        authoringSave?: unknown;
        operations: {status: string; intent: {operationId: string; role: string; artifactKey: string}}[];
      };
      expect(recoveredState.authoringSave).toBeUndefined();
      expect(recoveredState.operations.length).toBeGreaterThan(2);
      expect(recoveredState.operations.length).toBeLessThanOrEqual(6);
      const operationIds = recoveredState.operations.map(item => item.intent.operationId);
      expect(new Set(operationIds).size).toBe(operationIds.length);
      expect(operationIds.filter(id => id === sourceChild?.intent.operationId)).toHaveLength(1);
      expect(
        recoveredState.operations.find(item => item.intent.operationId === sourceChild?.intent.operationId)?.status,
      ).toBe('verified');
      const root = reference(recovered.root);
      expect(yield* f.store.read(f.location, seedRef.uri)).toContain('unrelated native write');
      expect(yield* f.store.read(f.location, root.uri)).toContain('Readiness: draft.');
      const loaded = authoring(yield* authoringRequest(f, 'load', {uri: root.uri, detail: 'document'}));
      expect(loaded.document).toEqual(document);
      const stateAfter = yield* f.fs.readFileString(stateFile);
      const journalAfter = yield* f.fs.readFileString(journalFile);
      const replay = authoring(
        yield* authoringRequest(f, 'save', save).pipe(Effect.provideService(CurrentNativeOperationLimit, 6)),
      );
      expect(replay.changed).toBe(false);
      expect(reference(replay.root)).toEqual(root);
      expect(yield* f.fs.readFileString(stateFile)).toBe(stateAfter);
      expect(yield* f.fs.readFileString(journalFile)).toBe(journalAfter);
    }).pipe(run),
  );

  effectIt.effect('keeps the reservation exclusive between verified child receipts', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const seed = object(
        yield* f.call(
          f.write({
            operationId: 'between-child-seed',
            artifactKey: 'between-child-seed',
            role: 'seed',
            body: 'An unrelated native write predating this reservation.\n',
          }),
        ),
      );
      const seedRef = reference(seed.artifact);
      const journalFile = f.journalPath(initialized.bindingId);
      const document = specDocument();
      const save = {document, ready: false, expectedRevision: null};
      const fault = yield* interruptAfterVerifiedNativeReceipt(f, intent => intent.role === 'authoring-child');
      const failed = yield* failure(
        authoringRequest(f, 'save', save).pipe(
          Effect.provideService(CurrentNativeOperationLimit, 6),
          Effect.provideService(FileSystem.FileSystem, fault.failingFs),
        ),
      );
      expect(fault.interrupted()).toBe(true);
      expect(Result.isFailure(failed)).toBe(true);
      const stateBytes = yield* f.fs.readFileString(fault.stateFile);
      const pending = JSON.parse(stateBytes) as {
        authoringSave: {operationStart: number; operationLimit: number};
        operations: {status: string; intent: {operationId: string; role: string; artifactKey: string}}[];
      };
      expect(pending.authoringSave).toMatchObject({operationStart: 1, operationLimit: 6});
      expect(pending.operations).toHaveLength(2);
      const verifiedChild = pending.operations.at(-1);
      expect(verifiedChild).toMatchObject({status: 'verified', intent: {role: 'authoring-child'}});
      const journalBytes = yield* f.fs.readFileString(journalFile);

      const unrelatedWrite = yield* failure(
        f.call(f.write({operationId: 'between-child-write', artifactKey: 'between-child-write', role: 'other'})),
      );
      expect(unrelatedWrite).toMatchObject({_tag: 'Failure', failure: {code: 'pending-operation'}});
      expect(yield* f.fs.readFileString(fault.stateFile)).toBe(stateBytes);
      expect(yield* f.fs.readFileString(journalFile)).toBe(journalBytes);

      const completed = authoring(
        yield* authoringRequest(f, 'save', save).pipe(Effect.provideService(CurrentNativeOperationLimit, 6)),
      );
      const root = reference(completed.root);
      expect(completed).toMatchObject({readiness: 'draft', changed: true});
      const stateAfter = JSON.parse(yield* f.fs.readFileString(fault.stateFile)) as {
        authoringSave?: unknown;
        operations: {status: string; intent: {operationId: string; role: string}}[];
      };
      expect(stateAfter.authoringSave).toBeUndefined();
      expect(stateAfter.operations.length).toBeLessThanOrEqual(6);
      const operationIds = stateAfter.operations.map(item => item.intent.operationId);
      expect(new Set(operationIds).size).toBe(operationIds.length);
      expect(operationIds.filter(id => id === verifiedChild?.intent.operationId)).toHaveLength(1);
      expect(
        stateAfter.operations.find(item => item.intent.operationId === verifiedChild?.intent.operationId)?.status,
      ).toBe('verified');
      expect(yield* f.store.read(f.location, seedRef.uri)).toContain('predating this reservation');
      expect(yield* f.store.read(f.location, root.uri)).toContain('Readiness: draft.');
      const loaded = authoring(yield* authoringRequest(f, 'load', {uri: root.uri, detail: 'document'}));
      expect(loaded.document).toEqual(document);
    }).pipe(run),
  );

  effectIt.effect('clears the reservation after the verified root commits before finalization', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const document = specDocument();
      const save = {document, ready: false, expectedRevision: null};
      const stateFile = f.path.join(
        yield* f.fs.realPath(f.home),
        'workflow-automations',
        'native-v1',
        'native-run.json',
      );
      const originalFs = yield* FileSystem.FileSystem;
      let interrupted = false;
      const interruptedFs = FileSystem.FileSystem.of({
        ...originalFs,
        rename: (from, to) => {
          if (to !== stateFile || interrupted) return originalFs.rename(from, to);
          return originalFs.readFileString(from).pipe(
            Effect.flatMap(raw => {
              try {
                const candidate = JSON.parse(raw) as {
                  authoringSave?: unknown;
                  operations?: {status?: string; intent?: {artifactKey?: string; expectedRevision?: string | null}}[];
                };
                const last = candidate.operations?.at(-1);
                if (
                  candidate.authoringSave === undefined &&
                  last?.status === 'verified' &&
                  last.intent?.artifactKey === 'author-root-spec'
                ) {
                  interrupted = true;
                  return Effect.sync(() => {
                    throw new Error('Synthetic verified-root finalization interruption');
                  });
                }
              } catch {
                // Only matching native-state writes are interrupted.
              }
              return originalFs.rename(from, to);
            }),
          );
        },
      });
      const failed = yield* failure(
        authoringRequest(f, 'save', save).pipe(Effect.provideService(FileSystem.FileSystem, interruptedFs)),
      );
      expect(interrupted).toBe(true);
      expect(Result.isFailure(failed)).toBe(true);
      const pendingBytes = yield* f.fs.readFileString(stateFile);
      const pending = JSON.parse(pendingBytes) as {
        authoringSave?: {operationStart: number; operationLimit: number};
        operations: {status: string; intent: {artifactKey: string; operationId: string}}[];
      };
      expect(pending.authoringSave).toMatchObject({operationStart: 0, operationLimit: 5});
      expect(pending.operations.filter(item => item.intent.artifactKey === 'author-root-spec')).toHaveLength(1);
      expect(pending.operations.at(-1)).toMatchObject({status: 'verified', intent: {artifactKey: 'author-root-spec'}});
      const journalFile = f.journalPath(initialized.bindingId);
      const journalBytes = yield* f.fs.readFileString(journalFile);
      const rootOp = pending.operations.at(-1)!;
      const recovered = authoring(yield* authoringRequest(f, 'save', save));
      expect(recovered).toMatchObject({readiness: 'draft', changed: false});
      expect(reference(recovered.root).memoryId).toMatch(/^tn_/u);
      const stableBytes = yield* f.fs.readFileString(stateFile);
      const final = JSON.parse(stableBytes) as {
        authoringSave?: unknown;
        operations: {intent: {artifactKey: string; operationId: string}}[];
      };
      expect(final.authoringSave).toBeUndefined();
      expect(final.operations).toHaveLength(pending.operations.length);
      expect(final.operations.filter(item => item.intent.artifactKey === 'author-root-spec')).toHaveLength(1);
      expect(yield* f.fs.readFileString(stateFile)).toBe(stableBytes);
      expect(yield* f.fs.readFileString(journalFile)).toBe(journalBytes);
      expect(rootOp.intent.operationId).toBe(final.operations.at(-1)?.intent.operationId);
      const loaded = authoring(
        yield* authoringRequest(f, 'load', {uri: reference(recovered.root).uri, detail: 'document'}),
      );
      expect(loaded.document).toEqual(document);
    }).pipe(run),
  );

  effectIt.effect(
    'keeps ready roots bound to their run while allowing a verified spec export to seed another plan',
    () =>
      Effect.gen(function* () {
        const f = yield* nativeFixture();
        const runA = 'binding-run-a';
        const runB = 'binding-run-b';
        const bindingA = yield* f.init(runA);
        const bindingB = yield* f.init(runB);
        const request = (runId: string, command: string, changes: ObjectValue = {}) =>
          f.call({...f.base('authoring', runId), command, ...changes});
        const document = specDocument();
        const draft = authoring(yield* request(runA, 'save', {document, ready: false, expectedRevision: null}));
        const draftRoot = reference(draft.root);
        const packet = authoring(yield* request(runA, 'acceptance-packet', {document}));
        const hashes = object(packet);
        if (typeof hashes.documentHash !== 'string') throw new Error('Expected the native document digest.');
        const confirmation = authoring(
          yield* request(runA, 'confirm', {
            document,
            userDecision: 'approve',
            userResponse: 'I approve this exact specification for the bound run.',
          }),
        );
        const promoted = authoring(
          yield* request(runA, 'save', {
            document,
            ready: true,
            uri: draftRoot.uri,
            expectedRevision: draftRoot.revision,
            confirmation: confirmation.confirmation,
            review: {documentHash: hashes.documentHash, outcome: 'accepted', blockingIssueCount: 0},
          }),
        );
        expect(promoted.readiness).toBe('ready');
        const readyRoot = reference(promoted.root);
        const sameRunPacket = authoring(yield* request(runA, 'export-plan', {uri: readyRoot.uri}));
        expect(sameRunPacket).toMatchObject({
          format: 'threadnote-native-spec-export',
          spec: {binding: {bindingId: bindingA.bindingId, runId: runA, profile: 'desktop'}},
        });

        const rootBytes = yield* f.store.read(f.location, readyRoot.uri);
        const stateAPath = f.statePath(runA);
        const stateBPath = f.statePath(runB);
        const journalAPath = f.journalPath(bindingA.bindingId);
        const journalBPath = f.journalPath(bindingB.bindingId);
        const before = {
          stateA: yield* f.fs.readFileString(stateAPath),
          stateB: yield* f.fs.readFileString(stateBPath),
          journalA: yield* f.fs.readFileString(journalAPath),
          journalB: yield* f.fs.readFileString(journalBPath),
        };
        const crossRunRead = yield* failure(
          request(runB, 'load', {uri: readyRoot.uri, evidenceRefs: [readyRoot], detail: 'document'}),
        );
        expect(crossRunRead).toMatchObject({_tag: 'Failure', failure: {code: 'binding-drift'}});
        const crossRunExport = yield* failure(
          request(runB, 'export-plan', {uri: readyRoot.uri, evidenceRefs: [readyRoot]}),
        );
        expect(crossRunExport).toMatchObject({_tag: 'Failure', failure: {code: 'binding-drift'}});
        expect(yield* f.fs.readFileString(stateAPath)).toBe(before.stateA);
        expect(yield* f.fs.readFileString(stateBPath)).toBe(before.stateB);
        expect(yield* f.fs.readFileString(journalAPath)).toBe(before.journalA);
        expect(yield* f.fs.readFileString(journalBPath)).toBe(before.journalB);
        expect(yield* f.store.read(f.location, readyRoot.uri)).toBe(rootBytes);

        const imported = authoring(yield* request(runB, 'from-spec', {document: smallPlan(), packet: sameRunPacket}));
        const importedDocument = object(imported.document);
        expect(importedDocument).toMatchObject({
          kind: 'plan',
          id: 'feature',
          project: 'fixture',
          spec: {
            root: readyRoot,
            binding: {bindingId: bindingA.bindingId, runId: runA, profile: 'desktop'},
            documentHash: hashes.documentHash,
          },
        });
        expect(object(object(importedDocument.spec).binding).bindingId).not.toBe(bindingB.bindingId);
        expect(yield* f.fs.readFileString(stateBPath)).toBe(before.stateB);
        expect(yield* f.fs.readFileString(journalBPath)).toBe(before.journalB);

        const pin = object(importedDocument.spec);
        const changedRequirements = [{id: 'req-read', behavior: 'A forged behavior copied into both plan fields.'}];
        const changedScenarios = [
          {
            id: 'scenario-read',
            requirementIds: ['req-read'],
            given: 'A forged premise.',
            when: 'The forged plan is validated.',
            then: 'The forged behavior appears approved.',
          },
        ];
        const forged = decodeNativeAuthoringDocument({
          ...importedDocument,
          requirements: changedRequirements,
          spec: {...pin, requirements: changedRequirements, scenarios: changedScenarios},
        });
        const forgedValidation = yield* failure(request(runB, 'validate', {document: forged}));
        expect(forgedValidation).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'invalid-readback'},
        });
        expect(yield* f.fs.readFileString(stateBPath)).toBe(before.stateB);
        expect(yield* f.fs.readFileString(journalBPath)).toBe(before.journalB);
        expect(yield* f.store.read(f.location, readyRoot.uri)).toBe(rootBytes);
        const specPin = object(importedDocument.spec);
        const originalPin = object(specPin.root);
        for (const changedRoot of [
          {...originalPin, revision: '0'.repeat(64)},
          {...originalPin, memoryId: 'tn_changed-root-pin'},
        ]) {
          const changedLink = decodeNativeAuthoringDocument({
            ...importedDocument,
            spec: {...specPin, root: changedRoot},
          });
          const refused = yield* failure(request(runB, 'validate', {document: changedLink}));
          expect(Result.isFailure(refused)).toBe(true);
          expect(yield* f.fs.readFileString(stateBPath)).toBe(before.stateB);
          expect(yield* f.fs.readFileString(journalBPath)).toBe(before.journalB);
        }
        const forgedSave = yield* failure(
          request(runB, 'save', {
            document: forged,
            ready: false,
            expectedRevision: null,
          }),
        );
        expect(forgedSave).toMatchObject({_tag: 'Failure', failure: {code: 'invalid-readback'}});
        expect(yield* f.fs.readFileString(stateBPath)).toBe(before.stateB);
        expect(yield* f.fs.readFileString(journalBPath)).toBe(before.journalB);
      }).pipe(run),
  );

  effectIt.effect('keeps historic reads available while refusing stale source-backed cycle export', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const sourcePath = f.path.join(f.repo, 'source.ts');
      const initialSource = 'export const fixture = true;\n';
      yield* f.fs.writeFileString(sourcePath, initialSource);
      yield* runCommandEffect('git', ['-C', f.repo, 'config', 'user.name', 'Authoring Fixture']);
      yield* runCommandEffect('git', ['-C', f.repo, 'config', 'user.email', 'authoring-fixture@example.test']);
      yield* runCommandEffect('git', ['-C', f.repo, 'add', 'source.ts']);
      yield* runCommandEffect('git', ['-C', f.repo, 'commit', '-m', 'source fixture']);
      const inspected = authoring(
        yield* f.call({...f.base('authoring'), command: 'scope-inspect', paths: ['source.ts'], literalOnly: true}),
      );
      const snapshot = object(inspected.source);
      const sourceHash = sha256HexSync(initialSource);
      expect(snapshot.files).toEqual([{path: 'source.ts', sha256: sourceHash}]);

      const originalSpec = specDocument({
        context,
        source: snapshot,
      });
      const specDraft = authoring(
        yield* authoringRequest(f, 'save', {document: originalSpec, ready: false, expectedRevision: null}),
      );
      const specRoot = reference(specDraft.root);
      const packet = authoring(yield* authoringRequest(f, 'acceptance-packet', {document: originalSpec}));
      const confirmation = authoring(
        yield* authoringRequest(f, 'confirm', {
          document: originalSpec,
          userDecision: 'approve',
          userResponse: 'I approve this source-backed specification.',
        }),
      ).confirmation;
      const readySpec = authoring(
        yield* authoringRequest(f, 'save', {
          document: originalSpec,
          ready: true,
          uri: specRoot.uri,
          expectedRevision: specRoot.revision,
          confirmation,
          review: {documentHash: object(packet).documentHash, outcome: 'accepted', blockingIssueCount: 0},
        }),
      );
      const specPacket = authoring(yield* authoringRequest(f, 'export-plan', {uri: reference(readySpec.root).uri}));
      const plan = decodeNativeAuthoringDocument({
        ...smallPlan(),
        requirements: originalSpec.requirements,
        context,
        source: snapshot,
        spec: specPacket.spec,
      });
      const imported = authoring(yield* authoringRequest(f, 'from-spec', {document: plan, packet: specPacket}));
      const planDocument = object(imported.document);
      const planDraft = authoring(
        yield* authoringRequest(f, 'save', {document: planDocument, ready: false, expectedRevision: null}),
      );
      const planRoot = reference(planDraft.root);
      const readyPlan = authoring(
        yield* authoringRequest(f, 'save', {
          document: planDocument,
          ready: true,
          uri: planRoot.uri,
          expectedRevision: planRoot.revision,
        }),
      );
      const readyPlanRef = reference(readyPlan.root);
      const stateFile = f.statePath();
      const journalFile = f.journalPath(initialized.bindingId);
      const savedState = yield* f.fs.readFileString(stateFile);
      const savedJournal = yield* f.fs.readFileString(journalFile);
      const savedRoot = yield* f.store.read(f.location, readyPlanRef.uri);

      yield* f.fs.writeFileString(sourcePath, 'export const fixture = false;\n');
      const changedPlan = decodeNativeAuthoringDocument({
        ...planDocument,
        objective: 'Changed after source inspection.',
      });
      const refusedEdit = yield* failure(
        authoringRequest(f, 'save', {
          document: changedPlan,
          ready: true,
          uri: readyPlanRef.uri,
          expectedRevision: readyPlanRef.revision,
        }),
      );
      expect(refusedEdit).toMatchObject({_tag: 'Failure', failure: {code: 'source-drift'}});
      const cycle = yield* failure(
        authoringRequest(f, 'export-dev-cycle', {
          uri: readyPlanRef.uri,
          delivery: 'local',
          bindings: {'phase-save': {branch: 'phase/save', baseBranch: 'main'}},
        }),
      );
      expect(cycle).toMatchObject({_tag: 'Failure', failure: {code: 'source-drift'}});
      expect(yield* f.fs.readFileString(stateFile)).toBe(savedState);
      expect(yield* f.fs.readFileString(journalFile)).toBe(savedJournal);
      expect(yield* f.store.read(f.location, readyPlanRef.uri)).toBe(savedRoot);

      const historicalLoad = authoring(yield* authoringRequest(f, 'load', {uri: readyPlanRef.uri, detail: 'document'}));
      expect(historicalLoad.document).toEqual(planDocument);
      const historicalView = authoring(
        yield* authoringRequest(f, 'read', {uri: readyPlanRef.uri, artifactId: 'plan', detail: 'outline'}),
      );
      expect(historicalView.outline).toMatchObject({kind: 'plan'});
      const closeout = authoring(yield* authoringRequest(f, 'closeout-input', {uri: readyPlanRef.uri}));
      expect(closeout).toMatchObject({format: 'threadnote-native-closeout-input', root: readyPlanRef});
      expect(yield* f.fs.readFileString(stateFile)).toBe(savedState);
      expect(yield* f.fs.readFileString(journalFile)).toBe(savedJournal);
      expect(yield* f.store.read(f.location, readyPlanRef.uri)).toBe(savedRoot);
    }).pipe(run),
  );

  effectIt.effect('recovers an interrupted exact root promotion without rebinding or duplicating children', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const draftDocument = specDocument();
      const draft = authoring(
        yield* authoringRequest(f, 'save', {document: draftDocument, ready: false, expectedRevision: null}),
      );
      const draftRef = reference(draft.root);
      const packet = authoring(yield* authoringRequest(f, 'acceptance-packet', {document: draftDocument}));
      const confirmation = authoring(
        yield* authoringRequest(f, 'confirm', {
          document: draftDocument,
          userDecision: 'approve',
          userResponse: 'I approve the displayed behavior.',
        }),
      ).confirmation;
      const readyIntent = {
        document: draftDocument,
        ready: true,
        uri: draftRef.uri,
        expectedRevision: draftRef.revision,
        confirmation,
        review: {documentHash: object(packet).documentHash, outcome: 'accepted', blockingIssueCount: 0},
      };
      const stateFile = f.path.join(
        yield* f.fs.realPath(f.home),
        'workflow-automations',
        'native-v1',
        'native-run.json',
      );
      const journalFile = f.journalPath(initialized.bindingId);
      const originalFs = yield* FileSystem.FileSystem;
      let interrupted = false;
      const interruptedFs = FileSystem.FileSystem.of({
        ...originalFs,
        rename: (from, to) => {
          if (to !== stateFile || interrupted) return originalFs.rename(from, to);
          return originalFs.readFileString(from).pipe(
            Effect.flatMap(raw => {
              try {
                const candidate = JSON.parse(raw) as {
                  operations?: {
                    status?: string;
                    intent?: {artifactKey?: string; expectedRevision?: string | null};
                  }[];
                };
                const last = candidate.operations?.at(-1);
                if (
                  last?.status === 'verified' &&
                  last.intent?.artifactKey === 'author-root-spec' &&
                  last.intent.expectedRevision === draftRef.revision
                ) {
                  interrupted = true;
                  return Effect.sync(() => {
                    throw new Error('Synthetic final authoring receipt rename interruption');
                  });
                }
              } catch {
                // Non-state files are not expected at this destination; let the ordinary rename report errors.
              }
              return originalFs.rename(from, to);
            }),
          );
        },
      });
      const failedPromotion = yield* failure(
        authoringRequest(f, 'save', readyIntent).pipe(Effect.provideService(FileSystem.FileSystem, interruptedFs)),
      );
      expect(interrupted).toBe(true);
      expect(Result.isFailure(failedPromotion)).toBe(true);
      const pendingBytes = yield* f.fs.readFileString(stateFile);
      const pendingState = JSON.parse(pendingBytes) as {
        operations: {status: string; intent: {artifactKey: string; operationId: string}}[];
      };
      const pendingRoot = pendingState.operations.filter(item => item.intent.artifactKey === 'author-root-spec').at(-1);
      expect(pendingRoot).toMatchObject({status: 'prepared'});
      const verifiedJournalBytes = yield* f.fs.readFileString(journalFile);
      const verifiedJournal = JSON.parse(verifiedJournalBytes) as {
        operations?: Record<string, {status: string}>;
        journal?: {operations: Record<string, {status: string}>};
      };
      const journalOperations = verifiedJournal.journal?.operations ?? verifiedJournal.operations;
      expect(journalOperations?.[pendingRoot!.intent.operationId]).toMatchObject({status: 'verified'});

      const altered = specDocument({objective: 'Changed while an exact root operation is pending.'});
      const wrongIntent = yield* failure(authoringRequest(f, 'save', {...readyIntent, document: altered}));
      expect(wrongIntent).toMatchObject({_tag: 'Failure', failure: {code: 'pending-operation'}});
      expect(yield* f.fs.readFileString(stateFile)).toBe(pendingBytes);
      expect(yield* f.fs.readFileString(journalFile)).toBe(verifiedJournalBytes);

      const recovered = authoring(yield* authoringRequest(f, 'save', readyIntent));
      expect(recovered).toMatchObject({readiness: 'ready', recovered: true, changed: false});
      expect(reference(recovered.root)).toMatchObject({uri: draftRef.uri, memoryId: draftRef.memoryId});
      const recoveredBytes = yield* f.fs.readFileString(stateFile);
      const finalState = JSON.parse(yield* f.fs.readFileString(stateFile)) as {
        operations: {status: string; intent: {artifactKey: string}}[];
      };
      expect(finalState.operations).toHaveLength(pendingState.operations.length);
      expect(finalState.operations.filter(item => item.intent.artifactKey === 'author-root-spec')).toHaveLength(2);
      expect(
        finalState.operations.find(
          item => item.intent.artifactKey === 'author-root-spec' && item.status === 'prepared',
        ),
      ).toBeUndefined();
      const finalJournalBytes = yield* f.fs.readFileString(journalFile);
      expect(finalJournalBytes).toBe(verifiedJournalBytes);
      const rootBytes = yield* f.store.read(f.location, reference(recovered.root).uri);
      const replay = authoring(yield* authoringRequest(f, 'save', readyIntent));
      expect(replay.changed).toBe(false);
      expect(reference(replay.root)).toEqual(reference(recovered.root));
      expect(yield* f.fs.readFileString(stateFile)).toBe(recoveredBytes);
      expect(yield* f.fs.readFileString(journalFile)).toBe(verifiedJournalBytes);
      expect(yield* f.store.read(f.location, reference(recovered.root).uri)).toBe(rootBytes);
      const reloaded = authoring(
        yield* authoringRequest(f, 'load', {uri: reference(recovered.root).uri, detail: 'document'}),
      );
      expect(reloaded.document).toEqual(draftDocument);
    }).pipe(run),
  );

  effectIt.effect('recovers an omitted-URI root replacement with one pinned evidence relation', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const originalDocument = specDocument();
      const initial = authoring(
        yield* authoringRequest(f, 'save', {document: originalDocument, ready: false, expectedRevision: null}),
      );
      const originalRoot = reference(initial.root);
      const [evidence] = yield* seedEvidence(f, 1);
      const replacementDocument = specDocument({
        context: {...context, evidenceRefs: [evidence], note: 'Pinned evidence informs this replacement.'},
      });
      const replacement = {document: replacementDocument, ready: false, expectedRevision: originalRoot.revision};
      expect(replacement).not.toHaveProperty('uri');
      const fault = yield* interruptNativeReceipt(
        f,
        intent => intent.artifactKey === 'author-root-spec' && intent.expectedRevision === originalRoot.revision,
      );
      const failed = yield* failure(
        authoringRequest(f, 'save', replacement).pipe(Effect.provideService(FileSystem.FileSystem, fault.failingFs)),
      );
      expect(fault.interrupted()).toBe(true);
      expect(Result.isFailure(failed)).toBe(true);

      const journalFile = f.journalPath(initialized.bindingId);
      const pendingBytes = yield* f.fs.readFileString(fault.stateFile);
      const pending = JSON.parse(pendingBytes) as {
        operations: {
          status: string;
          intent: {
            artifactKey: string;
            operationId: string;
            role: string;
            relations?: {uri: string}[];
          };
        }[];
      };
      const pendingRoot = pending.operations.find(
        item => item.intent.artifactKey === 'author-root-spec' && item.status === 'prepared',
      );
      expect(pendingRoot?.intent.role).toBe('authoring-root');
      expect(pendingRoot?.intent.relations?.map(item => item.uri)).toContain(evidence.uri);
      const journalBytes = yield* f.fs.readFileString(journalFile);
      const replacedRootBytes = yield* f.store.read(f.location, originalRoot.uri);

      const changed = specDocument({
        objective: 'Change the save while its exact evidence-backed root is pending.',
        context: replacementDocument.context,
      });
      const wrong = yield* failure(authoringRequest(f, 'save', {...replacement, document: changed}));
      expect(wrong).toMatchObject({_tag: 'Failure', failure: {code: 'pending-operation'}});
      expect(yield* f.fs.readFileString(fault.stateFile)).toBe(pendingBytes);
      expect(yield* f.fs.readFileString(journalFile)).toBe(journalBytes);
      expect(yield* f.store.read(f.location, originalRoot.uri)).toBe(replacedRootBytes);

      const recovered = authoring(yield* authoringRequest(f, 'save', replacement));
      expect(recovered).toMatchObject({readiness: 'draft', recovered: true, changed: false});
      expect(reference(recovered.root)).toMatchObject({uri: originalRoot.uri, memoryId: originalRoot.memoryId});
      const replayed = authoring(yield* authoringRequest(f, 'save', replacement));
      expect(replayed.changed).toBe(false);
      expect(reference(replayed.root)).toEqual(reference(recovered.root));
      const finalState = JSON.parse(yield* f.fs.readFileString(fault.stateFile)) as typeof pending;
      expect(finalState.operations.map(item => item.intent.operationId)).toEqual(
        pending.operations.map(item => item.intent.operationId),
      );
      expect(
        finalState.operations.find(item => item.intent.operationId === pendingRoot?.intent.operationId)?.status,
      ).toBe('verified');
      const loaded = authoring(yield* authoringRequest(f, 'load', {uri: originalRoot.uri, detail: 'document'}));
      expect(loaded.document).toEqual(replacementDocument);
      expect(yield* f.fs.readFileString(journalFile)).toBe(journalBytes);
    }).pipe(run),
  );

  effectIt.effect('recovers an evidence-navigation root replacement with nine pinned references', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const initial = authoring(
        yield* authoringRequest(f, 'save', {document: specDocument(), ready: false, expectedRevision: null}),
      );
      const originalRoot = reference(initial.root);
      const evidenceRefs = yield* seedEvidence(f, 9);
      const replacementDocument = specDocument({
        context: {...context, evidenceRefs, note: 'Nine pinned references are retained through a navigation artifact.'},
      });
      const replacement = {
        document: replacementDocument,
        ready: false,
        uri: originalRoot.uri,
        expectedRevision: originalRoot.revision,
      };
      const fault = yield* interruptNativeReceipt(
        f,
        intent => intent.artifactKey === 'author-root-spec' && intent.expectedRevision === originalRoot.revision,
      );
      const failed = yield* failure(
        authoringRequest(f, 'save', replacement).pipe(Effect.provideService(FileSystem.FileSystem, fault.failingFs)),
      );
      expect(fault.interrupted()).toBe(true);
      expect(Result.isFailure(failed)).toBe(true);

      const journalFile = f.journalPath(initialized.bindingId);
      const pendingBytes = yield* f.fs.readFileString(fault.stateFile);
      const pending = JSON.parse(pendingBytes) as {
        operations: {
          status: string;
          intent: {
            artifactKey: string;
            operationId: string;
            role: string;
            body: string;
            relations?: {uri: string}[];
          };
        }[];
      };
      const navigation = pending.operations.find(item => item.intent.role === 'authoring-context');
      for (const evidence of evidenceRefs) expect(navigation?.intent.body).toContain(evidence.uri);
      const pendingRoot = pending.operations.find(
        item => item.intent.artifactKey === 'author-root-spec' && item.status === 'prepared',
      );
      expect(pendingRoot?.intent.relations?.map(item => item.uri)).toContain(
        'threadnote://user/tester/memories/durable/projects/fixture/workflow-feature-context.md',
      );
      const journalBytes = yield* f.fs.readFileString(journalFile);
      const replacedRootBytes = yield* f.store.read(f.location, originalRoot.uri);

      const changed = specDocument({
        objective: 'Change the save while its nine-reference root is pending.',
        context: replacementDocument.context,
      });
      const wrong = yield* failure(authoringRequest(f, 'save', {...replacement, document: changed}));
      expect(wrong).toMatchObject({_tag: 'Failure', failure: {code: 'pending-operation'}});
      expect(yield* f.fs.readFileString(fault.stateFile)).toBe(pendingBytes);
      expect(yield* f.fs.readFileString(journalFile)).toBe(journalBytes);
      expect(yield* f.store.read(f.location, originalRoot.uri)).toBe(replacedRootBytes);

      const recovered = authoring(yield* authoringRequest(f, 'save', replacement));
      expect(recovered).toMatchObject({readiness: 'draft', recovered: true, changed: false});
      const reloaded = authoring(yield* authoringRequest(f, 'load', {uri: originalRoot.uri, detail: 'document'}));
      expect(reloaded.document).toEqual(replacementDocument);
      const replay = authoring(yield* authoringRequest(f, 'save', replacement));
      expect(replay.changed).toBe(false);
      const finalState = JSON.parse(yield* f.fs.readFileString(fault.stateFile)) as typeof pending;
      expect(finalState.operations.map(item => item.intent.operationId)).toEqual(
        pending.operations.map(item => item.intent.operationId),
      );
      expect(
        finalState.operations.find(item => item.intent.operationId === pendingRoot?.intent.operationId)?.status,
      ).toBe('verified');
      expect(yield* f.fs.readFileString(journalFile)).toBe(journalBytes);
    }).pipe(run),
  );

  effectIt.effect('recovers the first source child after its native receipt commit is interrupted', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const document = specDocument();
      const save = {document, ready: false, expectedRevision: null};
      const fault = yield* interruptNativeReceipt(
        f,
        intent =>
          intent.role === 'authoring-child' && intent.body?.includes('threadnote-native-authoring-data') === true,
      );
      const failed = yield* failure(
        authoringRequest(f, 'save', save).pipe(Effect.provideService(FileSystem.FileSystem, fault.failingFs)),
      );
      expect(fault.interrupted()).toBe(true);
      expect(Result.isFailure(failed)).toBe(true);

      const journalFile = f.journalPath(initialized.bindingId);
      const pendingBytes = yield* f.fs.readFileString(fault.stateFile);
      const pending = JSON.parse(pendingBytes) as {
        operations: {status: string; intent: {artifactKey: string; operationId: string; role: string; body: string}}[];
      };
      const sourceChild = pending.operations.find(item => item.status === 'prepared');
      expect(sourceChild?.intent).toMatchObject({role: 'authoring-child'});
      expect(sourceChild?.intent.artifactKey).toMatch(/^author-[a-f0-9]{64}$/u);
      expect(sourceChild?.intent.body).toContain('threadnote-native-authoring-data');
      const journalBytes = yield* f.fs.readFileString(journalFile);

      const changed = specDocument({objective: 'Change the draft while the first source child is pending.'});
      const wrong = yield* failure(authoringRequest(f, 'save', {...save, document: changed}));
      expect(wrong).toMatchObject({_tag: 'Failure', failure: {code: 'pending-operation'}});
      expect(yield* f.fs.readFileString(fault.stateFile)).toBe(pendingBytes);
      expect(yield* f.fs.readFileString(journalFile)).toBe(journalBytes);

      const recovered = authoring(yield* authoringRequest(f, 'save', save));
      expect(recovered).toMatchObject({readiness: 'draft', changed: true});
      const recoveredState = JSON.parse(yield* f.fs.readFileString(fault.stateFile)) as typeof pending;
      const operationIds = recoveredState.operations.map(item => item.intent.operationId);
      expect(new Set(operationIds).size).toBe(operationIds.length);
      expect(operationIds.filter(id => id === sourceChild?.intent.operationId)).toHaveLength(1);
      expect(
        recoveredState.operations.find(item => item.intent.operationId === sourceChild?.intent.operationId)?.status,
      ).toBe('verified');
      const reloaded = authoring(
        yield* authoringRequest(f, 'load', {uri: reference(recovered.root).uri, detail: 'document'}),
      );
      expect(reloaded.document).toEqual(document);
      const replay = authoring(yield* authoringRequest(f, 'save', save));
      expect(replay.changed).toBe(false);
      expect(reference(replay.root)).toEqual(reference(recovered.root));
      const finalState = JSON.parse(yield* f.fs.readFileString(fault.stateFile)) as typeof pending;
      expect(finalState.operations.map(item => item.intent.operationId)).toEqual(operationIds);
    }).pipe(run),
  );

  effectIt.effect('recovers an interrupted history child during root replacement', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const sourcePlan = smallPlan();
      if (sourcePlan.kind !== 'plan') throw new Error('Expected a plan fixture.');
      const originalDocument = decodeNativeAuthoringDocument({
        ...sourcePlan,
        phases: sourcePlan.phases.map(phase => ({
          ...phase,
          acceptance: phase.acceptance.map(({scenarioIds: _scenarioIds, ...item}) => item),
        })),
      });
      const initial = authoring(
        yield* authoringRequest(f, 'save', {document: originalDocument, ready: false, expectedRevision: null}),
      );
      const originalRoot = reference(initial.root);
      const originalRootContent = parseMemoryDocument(
        originalRoot.uri,
        yield* f.store.read(f.location, originalRoot.uri),
      );
      if (!originalRootContent) throw new Error('Expected the original plan root to be readable.');
      const replacementDocument = decodeNativeAuthoringDocument({
        ...originalDocument,
        objective: 'Implement the same plan while preserving its complete prior root.',
      });
      const replacement = {
        document: replacementDocument,
        ready: false,
        uri: originalRoot.uri,
        expectedRevision: originalRoot.revision,
      };
      const fault = yield* interruptNativeReceipt(f, intent => intent.role === 'authoring-history');
      const failed = yield* failure(
        authoringRequest(f, 'save', replacement).pipe(Effect.provideService(FileSystem.FileSystem, fault.failingFs)),
      );
      expect(fault.interrupted()).toBe(true);
      expect(Result.isFailure(failed)).toBe(true);

      const journalFile = f.journalPath(initialized.bindingId);
      const pendingBytes = yield* f.fs.readFileString(fault.stateFile);
      const pending = JSON.parse(pendingBytes) as {
        operations: {status: string; intent: {artifactKey: string; operationId: string; role: string}}[];
      };
      const historyChild = pending.operations.find(item => item.status === 'prepared');
      expect(historyChild?.intent.role).toBe('authoring-history');
      const journalBytes = yield* f.fs.readFileString(journalFile);
      const changed = decodeNativeAuthoringDocument({
        ...replacementDocument,
        objective: 'Altered pending history intent.',
      });
      const wrong = yield* failure(authoringRequest(f, 'save', {...replacement, document: changed}));
      expect(wrong).toMatchObject({_tag: 'Failure', failure: {code: 'pending-operation'}});
      expect(yield* f.fs.readFileString(fault.stateFile)).toBe(pendingBytes);
      expect(yield* f.fs.readFileString(journalFile)).toBe(journalBytes);

      const recovered = authoring(yield* authoringRequest(f, 'save', replacement));
      expect(recovered).toMatchObject({readiness: 'draft', changed: true});
      expect(reference(recovered.root)).toMatchObject({uri: originalRoot.uri, memoryId: originalRoot.memoryId});
      const recoveredState = JSON.parse(yield* f.fs.readFileString(fault.stateFile)) as typeof pending;
      const operationIds = recoveredState.operations.map(item => item.intent.operationId);
      expect(new Set(operationIds).size).toBe(operationIds.length);
      expect(operationIds.filter(id => id === historyChild?.intent.operationId)).toHaveLength(1);
      expect(
        recoveredState.operations.find(item => item.intent.operationId === historyChild?.intent.operationId)?.status,
      ).toBe('verified');
      const recoveredStateBytes = yield* f.fs.readFileString(fault.stateFile);
      const loaded = authoring(yield* authoringRequest(f, 'load', {uri: originalRoot.uri, detail: 'document'}));
      expect(loaded.document).toEqual(replacementDocument);
      const recoveredMemory = parseMemoryDocument(originalRoot.uri, yield* f.store.read(f.location, originalRoot.uri));
      if (!recoveredMemory) throw new Error('Expected the replaced plan root to remain readable.');
      const newRoot = decodeAuthoringArtifact(recoveredMemory.body.trimEnd() + '\n', AuthoringRootSchema);
      expect(newRoot.previous).toBeDefined();
      const priorMemory = parseMemoryDocument(
        newRoot.previous!.uri,
        yield* f.store.read(f.location, newRoot.previous!.uri),
      );
      expect(priorMemory?.body).toBe(originalRootContent.body);
      const replay = authoring(yield* authoringRequest(f, 'save', replacement));
      expect(replay.changed).toBe(false);
      expect(reference(replay.root)).toEqual(reference(recovered.root));
      expect(yield* f.fs.readFileString(fault.stateFile)).toBe(recoveredStateBytes);
      const recoveredJournalBytes = yield* f.fs.readFileString(journalFile);
      expect(recoveredJournalBytes).not.toBe(journalBytes);
      const journalStableReplay = authoring(yield* authoringRequest(f, 'save', replacement));
      expect(journalStableReplay.changed).toBe(false);
      expect(yield* f.fs.readFileString(journalFile)).toBe(recoveredJournalBytes);
    }).pipe(run),
  );

  effectIt.effect('refreshes a durable authoring prefix when a post-commit child write fails before verification', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
      let written: {uri: string; content: string} | undefined;
      const faulty = ResourceStore.of({
        ...f.store,
        writeChecked: (location, uri, content, options, check) =>
          f.store.writeChecked(location, uri, content, options, check).pipe(
            Effect.tap(() => {
              if (written) return Effect.void;
              written = {uri, content};
              return Effect.die(new Error('Synthetic post-commit child write failure'));
            }),
          ),
      });
      const failed = yield* authoringRequest(f, 'save', {
        document: specDocument(),
        ready: false,
        expectedRevision: null,
      }).pipe(Effect.provideService(ResourceStore, faulty), Effect.exit);
      expect(failed._tag).toBe('Failure');
      const committed = written;
      if (!committed) throw new Error('Expected an actual committed child artifact.');
      expect(yield* f.store.read(f.location, committed.uri)).toBe(committed.content);
      expect((yield* recallIndexStatus(f.config, false)).ready).toBe(true);
      const recalled = yield* loadRecallIndexData(f.config, {includeInactive: false});
      expect(recalled.candidates.some(candidate => candidate.uri === committed.uri)).toBe(true);
    }).pipe(run),
  );

  effectIt.effect('saves, validates, reloads, replays and exports a reviewed native specification', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
      const decodedSpec = specDocument();
      if (decodedSpec.kind !== 'spec') throw new Error('Expected a spec fixture');
      const document = decodedSpec;
      const initial = authoring(yield* authoringRequest(f, 'save', {document, ready: false, expectedRevision: null}));
      expect(initial.readiness).toBe('draft');
      const originalRoot = reference(initial.root);
      // Check readiness before querying, so lazy recall repair cannot hide a missed batch flush.
      expect((yield* recallIndexStatus(f.config, false)).ready).toBe(true);
      const recalled = yield* loadRecallIndexData(f.config, {includeInactive: false, query: document.title});
      expect(recalled.candidates.some(candidate => candidate.uri === originalRoot.uri)).toBe(true);
      const rootBytes = yield* f.store.read(f.location, originalRoot.uri);
      const statePath = f.statePath();
      const stateBytes = yield* f.fs.readFileString(statePath);

      const summary = authoring(yield* authoringRequest(f, 'load', {uri: originalRoot.uri}));
      expect(summary.root).toEqual(originalRoot);
      expect(summary).not.toHaveProperty('document');
      const complete = authoring(yield* authoringRequest(f, 'load', {uri: originalRoot.uri, detail: 'document'}));
      expect(complete.document).toEqual(document);

      const repeated = authoring(
        yield* authoringRequest(f, 'save', {
          document,
          ready: false,
          uri: originalRoot.uri,
          expectedRevision: originalRoot.revision,
        }),
      );
      expect(repeated.changed).toBe(false);
      expect(reference(repeated.root)).toEqual(originalRoot);
      expect(yield* f.fs.readFileString(statePath)).toBe(stateBytes);
      expect(yield* f.store.read(f.location, originalRoot.uri)).toEqual(rootBytes);

      const packet = authoring(yield* authoringRequest(f, 'acceptance-packet', {document}));
      expect(packet).not.toHaveProperty('document');
      expect(packet.views).toBeDefined();
      const hashes = object(packet);
      const reviewPacket = authoring(yield* authoringRequest(f, 'review-packet', {document}));
      expect(reviewPacket).not.toHaveProperty('document');
      expect(reviewPacket.views).toBeDefined();
      const acceptedReview = {documentHash: hashes.documentHash, outcome: 'accepted', blockingIssueCount: 0};
      const declined = authoring(
        yield* authoringRequest(f, 'confirm', {
          document,
          userDecision: 'reject',
          userResponse: 'This behavior needs revision.',
        }),
      );
      expect(declined.confirmation).toBeNull();
      const deferred = authoring(
        yield* authoringRequest(f, 'confirm', {
          document,
          userDecision: 'defer',
          userResponse: 'Defer until the behavior examples are reviewed.',
        }),
      );
      expect(deferred.confirmation).toBeNull();
      const confirmed = authoring(
        yield* authoringRequest(f, 'confirm', {
          document,
          userDecision: 'approve',
          userResponse: 'I approve this exact behavior.',
        }),
      );
      const confirmation = confirmed.confirmation;
      expect(confirmation).toMatchObject({intentHash: hashes.intentHash, decision: 'approved'});
      const ready = authoring(
        yield* authoringRequest(f, 'save', {
          document,
          ready: true,
          uri: originalRoot.uri,
          expectedRevision: originalRoot.revision,
          confirmation,
          review: acceptedReview,
        }),
      );
      expect(ready.readiness).toBe('ready');
      expect(reference(ready.root)).toMatchObject({uri: originalRoot.uri, memoryId: originalRoot.memoryId});

      const staleDocument = specDocument({objective: 'Change behavior without refreshing approval.'});
      if (staleDocument.kind !== 'spec') throw new Error('Expected a changed spec fixture');
      const stale = authoring(
        yield* authoringRequest(f, 'save', {
          document: staleDocument,
          ready: true,
          uri: originalRoot.uri,
          expectedRevision: reference(ready.root).revision,
          confirmation,
          review: acceptedReview,
        }),
      );
      expect(stale).toMatchObject({requestedReadiness: 'ready', readiness: 'draft'});
      expect(stale.readinessBlockers).toEqual(
        expect.arrayContaining([expect.objectContaining({code: expect.stringMatching(/confirmation|review/u)})]),
      );
      const staleRoot = reference(stale.root);
      expect(staleRoot).toMatchObject({uri: originalRoot.uri, memoryId: originalRoot.memoryId});
      const staleStored = authoring(yield* authoringRequest(f, 'load', {uri: staleRoot.uri, detail: 'document'}));
      expect(staleStored.document).toEqual(staleDocument);
      expect(staleStored.readiness).toBe('draft');
      const retainedApprovedRoot = reference(stale.previous);
      const retainedReady = authoring(
        yield* authoringRequest(f, 'load', {uri: retainedApprovedRoot.uri, detail: 'document'}),
      );
      expect(retainedReady.readiness).toBe('ready');
      expect(retainedReady.document).toEqual(document);

      const changedPacket = authoring(yield* authoringRequest(f, 'acceptance-packet', {document: staleDocument}));
      const changedHashes = object(changedPacket);
      const changedConfirmationResponse = authoring(
        yield* authoringRequest(f, 'confirm', {
          document: staleDocument,
          userDecision: 'approve',
          userResponse: 'I approve the changed behavior.',
        }),
      );
      const changedConfirmation = changedConfirmationResponse.confirmation;
      const approvedDraft = authoring(
        yield* authoringRequest(f, 'save', {
          document: staleDocument,
          ready: true,
          uri: staleRoot.uri,
          expectedRevision: staleRoot.revision,
          confirmation: changedConfirmation,
        }),
      );
      expect(approvedDraft).toMatchObject({requestedReadiness: 'ready', readiness: 'draft'});
      expect(approvedDraft.readinessBlockers).toEqual(
        expect.arrayContaining([expect.objectContaining({code: expect.stringMatching(/review/u)})]),
      );
      const storedApprovedMemory = parseMemoryDocument(staleRoot.uri, yield* f.store.read(f.location, staleRoot.uri));
      if (!storedApprovedMemory) throw new Error('Expected saved root memory content');
      const storedApprovedRoot = decodeAuthoringArtifact(
        storedApprovedMemory.body.trimEnd() + '\n',
        AuthoringRootSchema,
      );
      expect(storedApprovedRoot.confirmation).toEqual(changedConfirmation);
      expect(storedApprovedRoot.confirmation).toMatchObject({
        decision: 'approved',
        intentHash: changedHashes.intentHash,
      });

      const acceptedChangedReview = {
        documentHash: changedHashes.documentHash,
        outcome: 'accepted',
        blockingIssueCount: 0,
      };
      const promoted = authoring(
        yield* authoringRequest(f, 'save', {
          document: staleDocument,
          ready: true,
          uri: staleRoot.uri,
          expectedRevision: reference(approvedDraft.root).revision,
          confirmation: changedConfirmation,
          review: acceptedChangedReview,
        }),
      );
      expect(promoted.readiness).toBe('ready');
      const activeReadyRoot = reference(promoted.root);

      const decisions = authoring(
        yield* authoringRequest(f, 'read', {
          uri: activeReadyRoot.uri,
          artifactId: 'spec',
          detail: 'outline',
        }),
      );
      expect(decisions.outline).toMatchObject({
        kind: 'spec',
        sections: expect.arrayContaining([expect.objectContaining({id: 'requirements'})]),
      });
      const section = authoring(
        yield* authoringRequest(f, 'read', {
          uri: activeReadyRoot.uri,
          artifactId: 'spec',
          detail: 'section',
          sectionId: 'requirements',
          offsetBytes: 0,
          maxBytes: 500,
        }),
      );
      expect(JSON.stringify(section)).toContain('req-read');

      const exported = authoring(yield* authoringRequest(f, 'export-plan', {uri: activeReadyRoot.uri}));
      expect(exported).toMatchObject({
        format: 'threadnote-native-spec-export',
        version: 1,
        featureId: 'feature',
        project: 'fixture',
        spec: {
          root: activeReadyRoot,
          binding: {runId: 'native-run', generation: 'skill-generation-v1', profile: 'desktop'},
          requirements: document.requirements,
          scenarios: document.scenarios,
        },
        closeout: {specRoot: activeReadyRoot},
      });
      expect(exported.spec).toHaveProperty('documentHash', nativeAuthoringDigest(staleDocument));

      const planDraft = smallPlan();
      const imported = authoring(yield* authoringRequest(f, 'from-spec', {document: planDraft, packet: exported}));
      expect(imported.document).toMatchObject({
        kind: 'plan',
        id: 'feature',
        project: 'fixture',
        requirements: staleDocument.requirements,
        spec: {
          root: activeReadyRoot,
          binding: {runId: 'native-run', generation: 'skill-generation-v1', profile: 'desktop'},
          documentHash: nativeAuthoringDigest(staleDocument),
          requirements: staleDocument.requirements,
          scenarios: staleDocument.scenarios,
        },
      });
      const mismatchedPacket = {
        ...exported,
        spec: {
          ...object(exported.spec),
          requirements: [{id: 'req-read', behavior: 'Changed after approval.'}],
        },
      };
      const rejectedImport = yield* failure(
        authoringRequest(f, 'from-spec', {document: planDraft, packet: mismatchedPacket}),
      );
      expect(Result.isFailure(rejectedImport)).toBe(true);

      const importedPlan = object(imported.document);
      const importedPlanRoot = authoring(
        yield* authoringRequest(f, 'save', {
          document: importedPlan,
          ready: false,
          expectedRevision: null,
        }),
      );
      const planRoot = reference(importedPlanRoot.root);
      const planReady = authoring(
        yield* authoringRequest(f, 'save', {
          document: importedPlan,
          ready: true,
          uri: planRoot.uri,
          expectedRevision: planRoot.revision,
        }),
      );
      expect(planReady.readiness).toBe('ready');
      const decisionOutline = authoring(
        yield* authoringRequest(f, 'read', {
          uri: reference(planReady.root).uri,
          artifactId: 'decisions',
          decisionId: 'decision-history',
          detail: 'outline',
        }),
      );
      expect(decisionOutline).toMatchObject({
        decisionId: 'decision-history',
        outline: {kind: 'decisions', sections: expect.arrayContaining([expect.objectContaining({id: 'alternatives'})])},
      });
      const decisionAlternatives = authoring(
        yield* authoringRequest(f, 'read', {
          uri: reference(planReady.root).uri,
          artifactId: 'decisions',
          decisionId: 'decision-history',
          detail: 'section',
          sectionId: 'alternatives',
        }),
      );
      expect(JSON.stringify(decisionAlternatives)).toContain('No better alternative identified.');
    }).pipe(run),
  );

  // P0 Windows quarantine: 100 real native saves exceeded 600s; revisit after performance and cost-model work.
  effectIt.effect.skipIf(process.platform === 'win32')(
    'retains and navigates 100 same-length revisions of a large native plan',
    () =>
      Effect.gen(function* () {
        const f = yield* nativeFixture();
        yield* f.init();
        let root: {uri: string; memoryId: string; revision: string} | undefined;
        const history: {uri: string; memoryId: string; revision: string}[] = [];
        for (let revision = 0; revision < 100; revision++) {
          const document = largePlan(revision);
          const saved = authoring(
            yield* authoringRequest(f, 'save', {
              document,
              ready: false,
              expectedRevision: root?.revision ?? null,
              ...(root ? {uri: root.uri} : {}),
            }),
          );
          if (root) history.push(root);
          root = reference(saved.root);
          expect(saved.readiness).toBe('draft');
        }
        if (!root) throw new Error('Expected final plan root');
        const current = authoring(yield* authoringRequest(f, 'load', {uri: root.uri, detail: 'document'}));
        expect(current.document).toEqual(largePlan(99));
        expect(nativeAuthoringDigest(decodeNativeAuthoringDocument(current.document))).toBe(current.documentHash);

        const currentMemory = parseMemoryDocument(root.uri, yield* f.store.read(f.location, root.uri));
        if (!currentMemory) throw new Error('Expected final root memory content');
        const currentEnvelope = decodeAuthoringArtifact(currentMemory.body.trimEnd() + '\n', AuthoringRootSchema);
        if (!currentEnvelope.previous) throw new Error('Expected the immediately preceding root snapshot');
        const publicPrevious = authoring(yield* authoringRequest(f, 'load', {uri: currentEnvelope.previous.uri}));
        expect(publicPrevious.root).toMatchObject({
          uri: currentEnvelope.previous.uri,
          memoryId: currentEnvelope.previous.memoryId,
          revision: currentEnvelope.previous.revision,
        });

        const statePath = f.statePath();
        const stateBeforeHistory = yield* f.fs.readFileString(statePath);
        let cursor: {uri: string; memoryId: string; revision: string} | undefined = root;
        let traversed = 0;
        const historyHashes = new Set<string>();
        const historyUris = new Set<string>();
        while (cursor) {
          expect(historyUris.has(cursor.uri)).toBe(false);
          historyUris.add(cursor.uri);
          const memory = parseMemoryDocument(cursor.uri, yield* f.store.read(f.location, cursor.uri));
          if (!memory) throw new Error('Expected a saved history root memory');
          const savedRoot: AuthoringRoot = decodeAuthoringArtifact(memory.body.trimEnd() + '\n', AuthoringRootSchema);
          expect(savedRoot.featureId).toBe('feature');
          historyHashes.add(savedRoot.documentHash);
          const previous: AuthoringReference | undefined = savedRoot.previous;
          traversed++;
          cursor = previous ? reference(previous) : undefined;
        }
        expect(traversed).toBe(100);
        expect(historyHashes).toHaveLength(100);
        expect(history).toHaveLength(99);
        expect(yield* f.fs.readFileString(statePath)).toBe(stateBeforeHistory);
        const inspection = object(yield* f.call(f.base('inspect')));
        if (!Array.isArray(inspection.operations)) throw new Error('Expected inspected operation receipts');
        expect(inspection.operations.length).toBeLessThanOrEqual(512);
      }).pipe(run),
    // Full-history retention stress; the measured save profile is recorded separately.
    {timeout: 600_000},
  );
});
