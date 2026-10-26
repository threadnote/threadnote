import {it} from '@effect/vitest';
import {Effect, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {decodeNativeAuthoringDocument} from '@threadnote/workflow-automations/authoring';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object') throw new Error('Expected an object response');
  return value as Record<string, unknown>;
};
const plan = (objective = 'Preserve a small native draft across exact reads.') => {
  const document = decodeNativeAuthoringDocument({
    format: 'threadnote-native-authoring',
    schemaVersion: 1,
    kind: 'plan',
    id: 'feature',
    project: 'fixture',
    title: 'Small native command plan',
    objective,
    requirements: [{id: 'req-read', behavior: 'The saved draft remains readable.'}],
    context: {codeRefs: [], evidenceRefs: [], note: 'Private source-free command fixture.'},
    source: null,
    sourceFreeReason: 'This test verifies document commands without source discovery.',
    current: {
      summary: 'A native draft can be saved.',
      components: ['Draft store'],
      contracts: [],
      diagram: 'flowchart TD\n  Caller --> Store',
    },
    target: {
      summary: 'Exact reads and revisions preserve the saved draft.',
      components: ['Draft store'],
      contracts: ['Read-only document commands preserve saved bytes.'],
      diagram: 'flowchart TD\n  Caller --> Store',
    },
    phases: [
      {
        id: 'read',
        title: 'Read the draft',
        outcome: 'The draft remains readable.',
        dependsOn: [],
        affectedPaths: ['source.ts'],
        newPaths: [],
        contracts: ['Preserve unrelated artifacts.'],
        acceptance: [
          {
            id: 'readback',
            criterion: 'The saved draft reloads exactly.',
            verification: 'Read the owned root and compare the complete document.',
            requirementIds: ['req-read'],
          },
        ],
        safeBoundary: 'Only the private draft changes.',
      },
    ],
    decisions: [],
    openQuestions: [],
    review: {required: false, reason: 'This private draft does not request implementation readiness.'},
  });
  if (document.kind !== 'plan') throw new Error('Expected a native plan');
  return document;
};

it.effect('dispatches source-free authoring views, pins and exact recovery without rewriting saved bytes', () =>
  Effect.gen(function* () {
    const f = yield* nativeFixture();
    const initialized = yield* f.init();
    const call = (command: string, fields: Record<string, unknown> = {}) =>
      f.call({...f.base('authoring'), command, ...fields}).pipe(
        Effect.map(value => {
          expect(value).toMatchObject({protocolVersion: 1, executorVersion: 1, status: 'ok'});
          return object(object(value).authoring);
        }),
      );
    const document = plan();
    const firstIntent = {document, ready: false, expectedRevision: null};
    const first = yield* call('save', firstIntent);
    const root = object(first.root);
    if (typeof root.uri !== 'string' || typeof root.revision !== 'string') throw new Error('Expected an owned root');
    const rootUri = root.uri;
    const initialRootBytes = yield* f.store.read(f.location, rootUri);
    const readImage = () =>
      Effect.all({
        state: f.fs.readFileString(f.statePath()),
        journal: f.fs.readFileString(f.journalPath(initialized.bindingId)),
        root: f.store.read(f.location, rootUri),
      });
    const before = yield* readImage();

    const schema = yield* call('schema');
    expect(schema.schema).toBeDefined();
    expect(schema.templates).toBeDefined();
    const pinned = yield* call('pin', {uri: root.uri});
    expect(pinned.reference).toEqual(root);
    const persistedRoot = parseMemoryDocument(rootUri, initialRootBytes);
    if (!persistedRoot) throw new Error('Expected a persisted native memory document');
    expect(pinned.body).toBe(persistedRoot.body.trim() + '\n');
    const validation = yield* call('validate', {document});
    expect(validation).toMatchObject({documentHash: first.documentHash, ready: false, issues: []});
    const rendered = yield* call('render', {document, detail: 'document'});
    expect(rendered).toMatchObject({
      documentHash: first.documentHash,
      documents: expect.arrayContaining([
        expect.objectContaining({id: 'plan', markdown: expect.stringContaining(document.objective)}),
        expect.objectContaining({id: 'current'}),
        expect.objectContaining({id: 'target'}),
      ]),
    });
    const routine = yield* call('challenge-packet', {document, designRisk: 'routine'});
    expect(routine).toMatchObject({action: 'skip', documentHash: first.documentHash});
    expect(routine).not.toHaveProperty('packet');
    const challenge = yield* call('challenge-packet', {document, designRisk: 'alternatives'});
    expect(challenge).toMatchObject({
      action: 'challenge',
      documentHash: first.documentHash,
      packet: {objective: document.objective, initialDesign: document.target.summary},
    });
    expect(object(challenge.packet).requirements).toEqual(document.requirements);
    const recovered = yield* call('recover', {uri: root.uri});
    expect(recovered).toMatchObject({root, recovery: 'complete-root-verified', documentHash: first.documentHash});
    const replayed = yield* call('recover', firstIntent);
    expect(replayed).toMatchObject({root, changed: false, documentHash: first.documentHash});
    expect(yield* readImage()).toEqual(before);

    const revised = plan('Preserve the revised native draft — 日本語 🧭.');
    const difference = yield* call('diff', {before: document, after: revised});
    expect(difference).toMatchObject({
      beforeHash: first.documentHash,
      intentChanged: true,
      changedFields: ['objective'],
    });
    expect(yield* readImage()).toEqual(before);
    const replacementIntent = {document: revised, ready: false, uri: root.uri, expectedRevision: root.revision};
    const replacement = yield* call('save', replacementIntent);
    expect(replacement.documentHash).toBe(difference.afterHash);
    expect(replacement.root).toMatchObject({uri: root.uri});
    const replacedImage = yield* readImage();
    expect(yield* call('recover', replacementIntent)).toMatchObject({root: replacement.root, changed: false});
    expect(yield* readImage()).toEqual(replacedImage);
    expect(object(yield* call('load', {uri: root.uri, detail: 'document'})).document).toEqual(revised);
  }).pipe(TestClock.withLive, provideNative),
);

it.effect.prop(
  'keeps dispatched diff identity and inverse hashes consistent for bounded Unicode objectives',
  {
    suffix: Schema.Array(Schema.Literals(['a', '界', '🧭', 'é', ' '])).check(Schema.isBetweenLength(1, 12)),
  },
  ({suffix}) =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const before = plan();
      const after = plan('Changed objective: ' + suffix.join(''));
      const image = yield* f.fs.readFileString(f.statePath());
      const journal = yield* f.fs.readFileString(f.journalPath(initialized.bindingId));
      const diff = (left: typeof before, right: typeof after) =>
        f
          .call({...f.base('authoring'), command: 'diff', before: left, after: right})
          .pipe(Effect.map(value => object(object(value).authoring)));
      const forward = yield* diff(before, after);
      const reverse = yield* diff(after, before);
      const identity = yield* diff(before, before);
      expect(forward.changedFields).toEqual(['objective']);
      expect(reverse.changedFields).toEqual(['objective']);
      expect(forward.beforeHash).toBe(reverse.afterHash);
      expect(forward.afterHash).toBe(reverse.beforeHash);
      expect(identity).toMatchObject({
        beforeHash: forward.beforeHash,
        afterHash: forward.beforeHash,
        intentChanged: false,
      });
      expect(identity.changedFields).toEqual([]);
      expect(yield* f.fs.readFileString(f.statePath())).toBe(image);
      expect(yield* f.fs.readFileString(f.journalPath(initialized.bindingId))).toBe(journal);
    }).pipe(TestClock.withLive, provideNative),
  {arbitrary: {runs: 5}},
);
