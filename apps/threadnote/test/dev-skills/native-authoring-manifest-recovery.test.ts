import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {it as effectIt} from '@effect/vitest';
import {Effect, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, test} from 'vitest';
import * as fc from 'fast-check';
import {createHash} from '@threadnote/testing/node-crypto';
import type {WorkflowWriteIntent} from '@threadnote/workflow-automations/contracts';
import {workflowWriteRequest} from '../../src/workflow_automation/memory.js';
import {stableJson} from '../../src/workflow_memory/protocol.js';
import {isJsonObject} from '@threadnote/platform/json';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {decodeNativeAuthoringDocument} from '@threadnote/workflow-automations/authoring';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {runCommandEffect} from '@threadnote/platform/command';
import {decodeWorkflowJournal} from '../../src/workflow_memory/journal_codec.js';
import {decodeWorkflowJournalStorageImage} from '../../src/workflow_memory/journal_storage.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const object = (value: unknown): Record<string, unknown> => {
  if (!isJsonObject(value)) throw new Error('Expected an object response');
  return value;
};
const reference = (value: unknown) => {
  const ref = object(value);
  if (typeof ref.uri !== 'string' || typeof ref.memoryId !== 'string' || typeof ref.revision !== 'string')
    throw new Error('Expected a complete artifact reference');
  return {uri: ref.uri, memoryId: ref.memoryId, revision: ref.revision};
};

const fixture = Effect.fn('test.authoringManifest.fixture')(function* (sourceBacked = false) {
  const f = yield* nativeFixture();
  const initialized = yield* f.init();
  const author = (command: string, fields: Record<string, unknown> = {}) =>
    f.call({...f.base('authoring'), command, ...fields}).pipe(Effect.map(value => object(object(value).authoring)));
  if (sourceBacked) {
    yield* runCommandEffect('git', ['-C', f.repo, 'add', 'source.ts']);
    yield* runCommandEffect('git', [
      '-C',
      f.repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--no-gpg-sign',
      '-m',
      'Fixture source',
    ]);
  }
  const source = sourceBacked
    ? (yield* author('scope-inspect', {paths: ['source.ts'], literalOnly: true})).source
    : null;
  const context = {codeRefs: [], evidenceRefs: [], note: 'Private interrupted-manifest fixture.'};
  const spec = decodeNativeAuthoringDocument({
    format: 'threadnote-native-authoring',
    schemaVersion: 1,
    kind: 'spec',
    id: 'feature',
    project: 'fixture',
    title: 'Recover an admitted draft',
    objective: 'Keep the exact approved context during recovery.',
    requirements: [{id: 'req-recover', behavior: 'The exact interrupted save resumes without duplicate writes.'}],
    context,
    source,
    ...(source ? {} : {sourceFreeReason: 'This fixture tests persistence, not source discovery.'}),
    actors: ['author'],
    inScope: ['Recover the original save.'],
    outOfScope: [],
    constraints: ['Preserve other writes.'],
    observations: [],
    scenarios: [
      {
        id: 'scenario-recover',
        requirementIds: ['req-recover'],
        given: 'A save is interrupted.',
        when: 'The original save is retried.',
        then: 'Its exact intent is recovered.',
      },
    ],
    assumptions: [],
    questions: [],
    artifacts: [],
    review: {required: false, reason: 'Isolated synthetic test.'},
  });
  const confirmation = (yield* author('confirm', {
    document: spec,
    userDecision: 'approve',
    userResponse: 'Approve this synthetic test specification.',
  })).confirmation;
  const readySpec = yield* author('save', {document: spec, ready: true, expectedRevision: null, confirmation});
  expect(readySpec.readiness).toBe('ready');
  const packet = yield* author('export-plan', {uri: reference(readySpec.root).uri});
  const document = decodeNativeAuthoringDocument({
    format: 'threadnote-native-authoring',
    schemaVersion: 1,
    kind: 'plan',
    id: 'feature',
    project: 'fixture',
    title: 'Interrupted manifest plan',
    objective: 'Preserve the original draft.',
    requirements: spec.requirements,
    context,
    source,
    ...(source ? {} : {sourceFreeReason: 'This fixture tests persistence, not source discovery.'}),
    spec: packet.spec,
    current: {
      summary: 'A private draft exists.',
      components: ['Native store'],
      contracts: [],
      diagram: 'flowchart TD\n Author --> Store',
    },
    target: {
      summary: 'The original save resumes.',
      components: ['Native store'],
      contracts: ['Retain exact intent.'],
      diagram: 'flowchart TD\n Author --> Store',
    },
    phases: [
      {
        id: 'recover',
        title: 'Recover the draft',
        outcome: 'The exact draft is readable.',
        dependsOn: [],
        affectedPaths: [],
        newPaths: [],
        contracts: ['No duplicate writes.'],
        safeBoundary: 'Only this private draft changes.',
        acceptance: [
          {
            id: 'recovered',
            criterion: 'The complete draft reloads.',
            verification: 'Compare original and recovered intent.',
            requirementIds: ['req-recover'],
            scenarioIds: ['scenario-recover'],
          },
        ],
      },
    ],
    decisions: [],
    openQuestions: [],
    review: {required: false, reason: 'Isolated synthetic test.'},
  });
  yield* author('from-spec', {document, packet});
  const first = yield* author('save', {document, ready: false, expectedRevision: null});
  const root = reference(first.root);
  const journalFile = f.journalPath(initialized.bindingId);
  const readJournal = () =>
    f.fs.readFileString(journalFile).pipe(
      Effect.flatMap(text => Effect.tryPromise(signal => decodeWorkflowJournal(text, signal))),
      Effect.map(text =>
        Schema.decodeUnknownSync(
          Schema.Struct({
            manifestUri: Schema.String,
            manifestCommitted: Schema.Boolean,
            operations: Schema.Record(
              Schema.String,
              Schema.Struct({status: Schema.String, request: Schema.Struct({role: Schema.String})}),
            ),
          }),
        )(decodeWorkflowJournalStorageImage(JSON.parse(text))),
      ),
      Effect.orDie,
    );
  const journal = yield* readJournal();
  if (!journal) throw new Error('Expected an authoritative journal');
  const manifestUri = journal.manifestUri;
  const image = () =>
    Effect.all({
      state: f.fs.readFileString(f.statePath()),
      journal: f.fs.readFileString(journalFile),
      manifest: f.store.read(f.location, manifestUri),
      root: f.store.read(f.location, root.uri),
    });
  const interrupt = (save: Record<string, unknown>) =>
    Effect.gen(function* () {
      let interrupted = false;
      const prefix = (yield* readNativeWorkflowState(f.config, 'native-run'))!.state.operations.length;
      const faulty = ResourceStore.of({
        ...f.store,
        write: (location, uri, content, options) =>
          Effect.gen(function* () {
            if (uri === manifestUri && !interrupted) {
              const current = yield* readJournal();
              if (
                current &&
                !current.manifestCommitted &&
                EffectRecord.values(current.operations).length > prefix &&
                EffectArray.some(
                  EffectRecord.values(current.operations),
                  operation => operation.status === 'verified' && operation.request.role === 'authoring-child',
                )
              ) {
                interrupted = true;
                return yield* ResourceIoFailed.make({
                  uri,
                  operation: 'write',
                  message: 'Synthetic manifest commit refusal',
                  cause: new Error('Synthetic manifest commit refusal'),
                });
              }
            }
            return yield* f.store.write(location, uri, content, options);
          }),
      });
      const failed = yield* author('save', save).pipe(Effect.provideService(ResourceStore, faulty), Effect.result);
      expect(interrupted).toBe(true);
      expect(Result.isFailure(failed)).toBe(true);
      const pending = (yield* readNativeWorkflowState(f.config, 'native-run'))!.state;
      const child = EffectOption.getOrUndefined(
        EffectArray.findFirst(pending.operations, operation => operation.status === 'prepared'),
      );
      if (!child) throw new Error('Expected an interrupted child');
      expect(child.intent.role).toBe('authoring-child');
      const actual = yield* readJournal();
      expect(actual?.manifestCommitted).toBe(false);
      expect(actual?.operations[child.intent.operationId].status).toBe('verified');
      return {pending, child};
    });
  return {...f, author, document, root, image, interrupt, manifestUri, journalFile};
});

effectIt.effect.prop(
  'repairs an exact linked-plan child and makes retries idempotent',
  {
    suffix: Schema.Array(Schema.Literals(['alpha', '仕様', '🧭', '\n'])).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(3),
    ),
    retries: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 3})),
  },
  ({suffix, retries}) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const document = {...f.document, objective: 'Recover this exact revision ' + EffectArray.join(suffix, '')};
      const save = {document, ready: false, uri: f.root.uri, expectedRevision: f.root.revision};
      const {pending, child} = yield* f.interrupt(save);
      const before = yield* f.image();
      for (const changed of [
        {document: {...document, objective: 'Different intent'}},
        {uri: f.root.uri + '-different'},
        {expectedRevision: EffectString.repeat(64)('0')},
      ]) {
        const wrong = yield* f.author('save', {...save, ...changed}).pipe(Effect.result);
        expect(wrong).toMatchObject({_tag: 'Failure', failure: {code: 'pending-operation'}});
      }
      const direct = yield* f.call({...f.base('recover'), operationId: child.intent.operationId}).pipe(Effect.result);
      expect(direct).toMatchObject({_tag: 'Failure', failure: {code: 'pending-operation'}});
      const preview = yield* f.author('validate', {document}).pipe(Effect.result);
      expect(preview).toMatchObject({_tag: 'Failure', failure: {code: 'binding-recovery-needed'}});
      expect(yield* f.image()).toEqual(before);
      const saved = yield* f.author('save', save);
      const complete = (yield* readNativeWorkflowState(f.config, 'native-run'))!.state;
      expect(complete.authoringSave).toBeUndefined();
      expect(complete.operations.slice(0, pending.authoringSave!.operationStart)).toEqual(
        pending.operations.slice(0, pending.authoringSave!.operationStart),
      );
      expect(
        EffectArray.filter(complete.operations, operation => operation.intent.operationId === child.intent.operationId),
      ).toHaveLength(1);
      expect((yield* f.author('load', {uri: reference(saved.root).uri, detail: 'document'})).document).toEqual(
        document,
      );
      const after = yield* f.image();
      for (let index = 0; index < retries; index++) {
        expect((yield* f.author('save', save)).changed).toBe(false);
        expect(yield* f.image()).toEqual(after);
      }
    }).pipe(TestClock.withLive, provideNative),
  {timeout: 120000, arbitrary: {runs: 6}},
);

effectIt.effect('rejects changed source before repairing the interrupted manifest', () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    const save = {
      document: {...f.document, objective: 'An exact source-backed revision.'},
      ready: false,
      uri: f.root.uri,
      expectedRevision: f.root.revision,
    };
    yield* f.interrupt(save);
    yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = false;\n');
    const before = yield* f.image();
    const refused = yield* f.author('save', save).pipe(Effect.result);
    expect(refused).toMatchObject({_tag: 'Failure', failure: {code: 'source-drift'}});
    expect(yield* f.image()).toEqual(before);
  }).pipe(TestClock.withLive, provideNative),
);

effectIt.effect('checks original child evidence before any manifest replay', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const evidence = object(
      yield* f.call(
        f.write({
          operationId: 'original-evidence',
          artifactKey: 'original-evidence',
          role: 'evidence',
          body: 'Pinned private fixture evidence.\n',
        }),
      ),
    );
    const pinned = reference(evidence.artifact);
    const document = {
      ...f.document,
      objective: 'Recover with the originally pinned evidence.',
      context: {...f.document.context, evidenceRefs: [pinned]},
    };
    const save = {document, ready: false, uri: f.root.uri, expectedRevision: f.root.revision};
    yield* f.interrupt(save);
    const original = yield* f.store.read(f.location, pinned.uri);
    if (!original) throw new Error('Expected the original fixture evidence');
    yield* f.store.write(f.location, pinned.uri, original + '\nChanged outside the pending save.\n', {mode: 'replace'});
    const before = yield* f.image();
    const refused = yield* f.author('save', save).pipe(Effect.result);
    expect(refused).toMatchObject({_tag: 'Failure', failure: {code: 'evidence-conflict'}});
    expect(yield* f.image()).toEqual(before);
  }).pipe(TestClock.withLive, provideNative),
);

test('binds every recovery authority field independently of key order without mutating the intent', () => {
  const text = fc
    .array(fc.constantFrom('alpha', '仕様', '🧭', '\n'), {maxLength: 12})
    .map(parts => EffectArray.join(parts, ''));
  fc.assert(
    fc.property(text, body => {
      const intent: WorkflowWriteIntent = {
        bindingId: EffectString.repeat(64)('a'),
        operationId: 'source-child',
        artifactKey: 'source',
        sourceRunId: 'native-run',
        role: 'authoring-child',
        nameHint: 'source',
        body,
        expectedRevision: null,
        uri: 'threadnote://user/tester/memories/durable/projects/fixture/source.md',
        storageKind: 'durable',
        codeRefs: ['source.ts'],
        relations: [{type: 'references', uri: 'threadnote://memory/tn_context'}],
        evidenceRefs: [
          {uri: 'threadnote://memory/tn_evidence', memoryId: 'tn_evidence', revision: EffectString.repeat(64)('c')},
        ],
      };
      const image = JSON.stringify(intent);
      const digest = (value: WorkflowWriteIntent) =>
        createHash('sha256')
          .update(stableJson(workflowWriteRequest(value)))
          .digest('hex');
      const original = digest(intent);
      const {body: originalBody, ...rest} = intent;
      expect(digest({body: originalBody, ...rest})).toBe(original);
      const changes: Partial<WorkflowWriteIntent>[] = [
        {bindingId: EffectString.repeat(64)('b')},
        {operationId: 'other-child'},
        {artifactKey: 'other-source'},
        {sourceRunId: 'other-run'},
        {role: 'authoring-history'},
        {nameHint: 'history'},
        {body: body + '\n'},
        {expectedRevision: EffectString.repeat(64)('d')},
        {uri: intent.uri + '-other'},
        {storageKind: 'handoff'},
        {codeRefs: ['other.ts']},
        {relations: [{type: 'depends_on', uri: 'threadnote://memory/tn_context'}]},
        {
          evidenceRefs: [
            {uri: 'threadnote://memory/tn_evidence', memoryId: 'tn_evidence', revision: EffectString.repeat(64)('e')},
          ],
        },
      ];
      for (const change of changes) expect(digest({...intent, ...change})).not.toBe(original);
      expect(JSON.stringify(intent)).toBe(image);
    }),
    {numRuns: 32},
  );
});
