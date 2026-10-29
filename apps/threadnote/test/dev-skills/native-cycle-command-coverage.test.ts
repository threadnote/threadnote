import {it} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {decodeNativeAuthoringDocument} from '@threadnote/workflow-automations/authoring';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object') throw new Error('Expected an object response');
  return value as Record<string, unknown>;
};

it.effect('dispatches bounded cycle discovery and exact read checks through a real local acceptance and delivery', () =>
  Effect.gen(function* () {
    const f = yield* nativeFixture();
    const git = (args: readonly string[]) => runCommandEffect('git', ['-C', f.repo, ...args]);
    yield* git(['config', 'user.name', 'Native Commands Fixture']);
    yield* git(['config', 'user.email', 'fixture@example.invalid']);
    yield* git(['add', 'source.ts']);
    yield* git(['commit', '-m', 'Private baseline']);
    yield* git(['checkout', '-b', 'feature/commands']);
    yield* f.init();
    const document = decodeNativeAuthoringDocument({
      format: 'threadnote-native-authoring',
      schemaVersion: 1,
      kind: 'plan',
      id: 'feature',
      project: 'fixture',
      title: 'Bounded local command cycle',
      objective: 'Read back one actual source change and deliver its exact local commit.',
      requirements: [{id: 'req-value', behavior: 'The fixture exposes the accepted value.'}],
      context: {codeRefs: [], evidenceRefs: [], note: 'Private source-free planning fixture.'},
      source: null,
      sourceFreeReason: 'The plan describes a synthetic local source change; cycle captures its actual source.',
      current: {
        summary: 'The fixture exports true.',
        components: ['Fixture module'],
        contracts: [],
        diagram: 'flowchart TD\n  Caller --> Fixture',
      },
      target: {
        summary: 'The fixture exports the accepted string.',
        components: ['Fixture module'],
        contracts: ['Preserve unrelated source.'],
        diagram: 'flowchart TD\n  Caller --> Fixture',
      },
      phases: [
        {
          id: 'value',
          title: 'Expose the accepted value',
          outcome: 'The fixture exports the accepted string.',
          dependsOn: [],
          affectedPaths: ['source.ts'],
          newPaths: [],
          contracts: ['Only the fixture module changes.'],
          acceptance: [
            {
              id: 'value-readback',
              criterion: 'The source exports the accepted string.',
              verification: 'Read the exact source bytes before accepting the captured tree.',
              requirementIds: ['req-value'],
            },
          ],
          safeBoundary: 'An isolated local fixture with no provider or publication authority.',
        },
      ],
      decisions: [
        {
          id: 'local',
          question: 'How is the isolated fixture delivered?',
          selection: 'no-better-alternative',
          selected: 'Record the actual local commit after source readback.',
          alternatives: [],
          rationale: 'A local receipt needs no external provider or watcher.',
          affectedPhases: ['value'],
          authority: 'orchestrator',
        },
      ],
      openQuestions: [],
      review: {required: false, reason: 'The synthetic plan is fully asserted by this isolated fixture.'},
    });
    const authoring = (command: string, fields: Record<string, unknown>) =>
      f.call({...f.base('authoring'), command, ...fields}).pipe(Effect.map(value => object(object(value).authoring)));
    const saved = yield* authoring('save', {document, ready: true, expectedRevision: null});
    expect(saved.readiness).toBe('ready');
    const plan = yield* authoring('export-dev-cycle', {
      uri: object(saved.root).uri,
      delivery: 'local',
      bindings: {value: {branch: 'feature/commands', baseBranch: 'main'}},
    });
    const cycle = (command: string, fields: Record<string, unknown> = {}) =>
      f.call({...f.base('cycle'), command, ...fields}).pipe(
        Effect.map(value => {
          expect(value).toMatchObject({protocolVersion: 1, executorVersion: 1, status: 'ok'});
          return object(object(value).cycle);
        }),
      );
    const mutate = (command: string, fields: Record<string, unknown>) =>
      Effect.gen(function* () {
        const inspected = yield* cycle('inspect');
        return yield* cycle(command, {expectedRevision: inspected.revision, ...fields});
      });
    const reviewSchema = yield* f.call({
      protocolVersion: 1,
      executorVersion: 1,
      action: 'request-schema',
      topic: 'cycle-review',
      maxBytes: 4096,
    });
    expect(reviewSchema).toMatchObject({
      schemaKind: 'decoding-envelope',
      runtimeValidationRequired: true,
      semanticPrerequisites: {
        requiredSelectedLanes: ['orchestrator', 'simplicity'],
        requiredCompletedLanes: ['orchestrator', 'simplicity'],
        specialistLanes: expect.stringContaining('optional'),
      },
    });
    expect(new TextEncoder().encode(JSON.stringify(reviewSchema)).byteLength).toBeLessThanOrEqual(4096);
    const schema = yield* cycle('schema', {maxBytes: 8192});
    let schemaPage = object(schema.schemaPage);
    const schemaDigest = schemaPage.sourceDigest;
    expect(schemaDigest).toMatch(/^[a-f0-9]{64}$/u);
    let schemaText = '';
    for (;;) {
      if (typeof schemaPage.text !== 'string') throw new Error('Expected a schema text page');
      expect(schemaPage.sourceDigest).toBe(schemaDigest);
      schemaText += schemaPage.text;
      if (schemaPage.nextOffsetBytes === null) break;
      schemaPage = object(
        (yield* cycle('schema', {
          maxBytes: 8192,
          offsetBytes: schemaPage.nextOffsetBytes,
          sourceDigest: schemaDigest,
        })).schemaPage,
      );
    }
    expect(JSON.parse(schemaText)).toMatchObject({
      schema: {
        properties: {command: {enum: expect.arrayContaining(['validate-plan', 'check-phase', 'closeout-packet'])}},
      },
    });
    expect(schemaPage.totalBytes).toBe(new TextEncoder().encode(schemaText).byteLength);
    const initialState = yield* f.fs.readFileString(f.statePath());
    expect(yield* cycle('validate-plan', {plan})).toMatchObject({valid: true, phaseCount: 1, source: plan.source});
    expect(yield* f.fs.readFileString(f.statePath())).toBe(initialState);
    expect(yield* mutate('init', {plan})).toMatchObject({next: {action: 'implement', phaseId: 'value'}});
    const initializedState = yield* f.fs.readFileString(f.statePath());
    expect(yield* cycle('next')).toMatchObject({next: {action: 'implement', phaseId: 'value'}});
    expect(yield* cycle('learning-packet', {phaseId: 'value'})).toMatchObject({status: 'pending', attempts: []});
    expect(yield* f.fs.readFileString(f.statePath())).toBe(initializedState);

    const source = 'export const fixture = "accepted";\n';
    yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), source);
    expect(yield* f.fs.readFileString(f.path.join(f.repo, 'source.ts'))).toBe(source);
    const captured = yield* mutate('snapshot', {phaseId: 'value', snapshotId: 'value-review'});
    const snapshot = object(object(captured.snapshot).snapshot);
    const beforeChecks = yield* f.fs.readFileString(f.statePath());
    expect(yield* cycle('check', {snapshotId: snapshot.snapshotId})).toMatchObject({
      status: 'unchanged',
      tree: snapshot.tree,
    });
    expect(yield* cycle('check-phase', {phaseId: 'value', snapshotId: snapshot.snapshotId})).toMatchObject({
      status: 'unchanged',
      tree: snapshot.tree,
    });
    expect(yield* f.fs.readFileString(f.statePath())).toBe(beforeChecks);
    expect(
      yield* mutate('validate-review', {
        snapshotId: snapshot.snapshotId,
        attemptId: 'value-attempt',
        report: {
          snapshotId: snapshot.snapshotId,
          phaseHash: snapshot.phaseHash,
          snapshotTree: snapshot.tree,
          status: 'complete',
          mode: 'full',
          selected: ['orchestrator', 'simplicity'],
          lanes: [
            {name: 'orchestrator', status: 'complete'},
            {name: 'simplicity', status: 'complete'},
          ],
          findings: [],
        },
      }),
    ).toMatchObject({status: 'ok'});
    const acceptance = [{criterion: 'The source exports the accepted string.', result: 'passed', evidence: source}];
    expect(
      yield* mutate('ready', {
        phaseId: 'value',
        snapshotId: snapshot.snapshotId,
        validation: {
          snapshotTree: snapshot.tree,
          reviewTree: snapshot.tree,
          status: 'passed',
          productState: 'working',
          checks: [{command: 'read private source.ts', result: 'passed', evidence: source}],
          acceptance,
        },
      }),
    ).toMatchObject({next: {action: 'complete'}});
    yield* git(['add', 'source.ts']);
    yield* git(['commit', '-m', 'Accept private fixture value']);
    const head = (yield* git(['rev-parse', 'HEAD'])).stdout.trim();
    const beforePublication = yield* f.fs.readFileString(f.statePath());
    expect(yield* cycle('publication-ready', {phaseId: 'value'})).toMatchObject({head, tree: snapshot.tree});
    expect(yield* f.fs.readFileString(f.statePath())).toBe(beforePublication);
    const delivery = {
      phaseId: 'value',
      phaseHash: snapshot.phaseHash,
      delivery: 'local',
      headSha: head,
      validatedTree: snapshot.tree,
    };
    expect(yield* mutate('record-delivery', {phaseId: 'value', delivery})).toMatchObject({next: {action: 'complete'}});
    const completedState = yield* f.fs.readFileString(f.statePath());
    expect(yield* cycle('learning-packet', {phaseId: 'value'})).toMatchObject({
      phaseId: 'value',
      phaseHash: snapshot.phaseHash,
      status: 'published',
      acceptance,
      attempts: [{id: 'value-attempt', status: 'accepted'}],
      next: {action: 'complete'},
    });
    expect(yield* cycle('closeout-packet')).toMatchObject({
      format: 'threadnote-native-cycle-closeout',
      version: 1,
      source: plan.source,
      completion: {root: object(plan.completion).root, required: object(plan.completion).required},
      phases: [
        {id: 'value', phaseHash: snapshot.phaseHash, validation: {snapshotTree: snapshot.tree, acceptance}, delivery},
      ],
    });
    expect(yield* f.fs.readFileString(f.statePath())).toBe(completedState);
  }).pipe(TestClock.withLive, provideNative),
);
