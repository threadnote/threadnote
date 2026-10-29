import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {it as effectIt} from '@effect/vitest';
import {decodeWorkflowJournal, encodeWorkflowJournal} from '../../src/workflow_memory/journal_codec.js';
import {nativeAuthoringSaveByteBudget} from '@threadnote/workflow-automations/native';
import {
  decodeWorkflowJournalStorageImage,
  hasPackedWorkflowScopes,
  workflowJournalStorageImage,
} from '../../src/workflow_memory/journal_storage.js';
import {stableJson, type WorkflowJournal, type WorkflowOperation} from '../../src/workflow_memory/protocol.js';
import {withWorkflowReadCache} from '../../src/workflow_memory/read_cache.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

// This fixture tests storage fidelity, not native journal admission.
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const withRest = <const S extends Schema.StructWithRest.Objects>(schema: S) =>
  Schema.StructWithRest(schema, [JsonRecordSchema]);
const PackedTextReferenceSchema = withRest(Schema.Struct({text: Schema.mutableKey(Schema.Finite)}));
const PackedStorageSchema = withRest(
  Schema.Struct({
    journalStorage: Schema.String,
    scopeSets: Schema.mutable(Schema.Array(Schema.mutable(Schema.Array(Schema.String)))),
    textValues: Schema.mutable(Schema.Array(Schema.String)),
    journal: withRest(
      Schema.Struct({
        binding: Schema.Unknown,
        operations: Schema.Record(
          Schema.String,
          withRest(
            Schema.Struct({
              before: Schema.optionalKey(PackedTextReferenceSchema),
              desired: PackedTextReferenceSchema,
              relations: Schema.Array(
                withRest(
                  Schema.Struct({
                    allowedUriScopes: Schema.optionalKey(
                      withRest(Schema.Struct({scopeSet: Schema.mutableKey(Schema.Finite)})),
                    ),
                    content: PackedTextReferenceSchema,
                    uri: Schema.optionalKey(Schema.String),
                  }),
                ),
              ),
              request: Schema.optionalKey(
                withRest(Schema.Struct({body: Schema.optionalKey(PackedTextReferenceSchema)})),
              ),
            }),
          ),
        ),
      }),
    ),
  }),
);
const packedStorage = Schema.decodeUnknownSync(PackedStorageSchema);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !EffectArray.isArray(value);
const isWorkflowBinding = (value: unknown): value is WorkflowJournal['binding'] =>
  isRecord(value) &&
  typeof value.bindingId === 'string' &&
  typeof value.workflowRunId === 'string' &&
  (value.profile === 'desktop' ||
    value.profile === 'codex-cloud-personal' ||
    value.profile === 'cursor-cloud-personal') &&
  typeof value.project === 'string' &&
  typeof value.featureId === 'string' &&
  typeof value.generation === 'string' &&
  typeof value.home === 'string' &&
  typeof value.repo === 'string' &&
  typeof value.account === 'string' &&
  typeof value.user === 'string' &&
  typeof value.agentId === 'string' &&
  EffectArray.isArray(value.sharedRoots) &&
  EffectArray.every(value.sharedRoots, root => typeof root === 'string') &&
  (value.artifactLifetime === 'local-home' || value.artifactLifetime === 'possibly-ephemeral-workspace');

interface ExpandedJournalView {
  readonly binding: WorkflowJournal['binding'];
  readonly operations: Readonly<
    Record<
      string,
      {
        readonly relations: readonly {readonly allowedUriScopes?: readonly string[]}[];
      }
    >
  >;
}
const isExpandedJournalView = (value: unknown): value is ExpandedJournalView => {
  if (!isRecord(value) || !isWorkflowBinding(value.binding) || !isRecord(value.operations)) return false;
  return EffectArray.every(
    EffectRecord.values(value.operations),
    operation =>
      isRecord(operation) &&
      EffectArray.isArray(operation.relations) &&
      EffectArray.every(
        operation.relations,
        relation =>
          isRecord(relation) &&
          (relation.allowedUriScopes === undefined ||
            (EffectArray.isArray(relation.allowedUriScopes) &&
              EffectArray.every(relation.allowedUriScopes, uri => typeof uri === 'string'))),
      ),
  );
};

function storageOperation(
  index: string,
  desired: string,
  relations: WorkflowOperation['relations'],
  requestBody?: string,
  before?: string,
): WorkflowOperation {
  return {
    request: {protocolVersion: 1, action: 'create', ...(requestBody === undefined ? {} : {body: requestBody})},
    intentDigest: sha256HexSync(`intent:${index}`),
    desired,
    ...(before === undefined ? {} : {before}),
    artifact: {
      artifactKey: `artifact-${index}`,
      sourceRunId: 'fixture-run',
      role: 'fixture',
      canonicalUri: `threadnote://fixture/${index}`,
      memoryId: `tn_fixture_${index}`,
      revision: sha256HexSync(`revision:${index}`),
      bodySha256: sha256HexSync(desired),
      storageKind: 'durable',
      state: 'active',
    },
    relations,
    status: 'prepared',
  };
}

interface JournalTexts {
  readonly manifestContent: string;
  readonly previousManifestContent?: string;
  readonly requestBody?: string;
  readonly desired: string;
  readonly before?: string;
  readonly relationContent: string;
}

const image = (
  scopes: readonly (readonly string[])[],
  texts: JournalTexts = {
    manifestContent: 'complete manifest',
    previousManifestContent: 'previous manifest',
    requestBody: 'complete original intent',
    desired: 'complete desired bytes',
    before: 'complete previous bytes',
    relationContent: 'complete target bytes',
  },
): WorkflowJournal => ({
  protocolVersion: 1,
  binding: {
    bindingId: 'fixture',
    workflowRunId: 'fixture-run',
    profile: 'desktop',
    project: 'threadnote',
    featureId: 'storage-fixture',
    generation: 'generation-v1',
    home: '/private/fixture',
    repo: '/private/fixture',
    account: 'local',
    user: 'tester',
    agentId: 'fixture-agent',
    sharedRoots: [],
    artifactLifetime: 'local-home',
  },
  artifacts: {},
  manifestCommitted: true,
  manifestUri: 'threadnote://fixture/manifest',
  manifestContent: texts.manifestContent,
  ...(texts.previousManifestContent === undefined ? {} : {previousManifestContent: texts.previousManifestContent}),
  operations: EffectRecord.fromEntries(
    EffectArray.map(scopes, (set, index) => [
      'operation-' + index,
      storageOperation(
        `operation-${index}`,
        texts.desired,
        Array.from({length: 4}, () => ({
          uri: 'threadnote://fixture/target',
          content: texts.relationContent,
          allowedUriScopes: [...set],
        })),
        texts.requestBody,
        texts.before,
      ),
    ]),
  ),
});

describe('workflow journal scope-set storage', () => {
  it('preserves every scope and text byte without changing ordinary storage', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          scopes: fc.array(fc.array(fc.string({maxLength: 80}), {maxLength: 24}), {maxLength: 12}),
          text: fc.oneof(fc.constantFrom('', '\n', '雪\n🙂', 'line one\nline two'), fc.string({maxLength: 80})),
          optional: fc.option(fc.oneof(fc.constantFrom('', '\n', '界✨\n'), fc.string({maxLength: 80})), {
            nil: undefined,
          }),
        }),
        async ({scopes, text, optional}) => {
          const texts: JournalTexts = {
            manifestContent: text,
            ...(optional === undefined ? {} : {previousManifestContent: optional}),
            ...(optional === undefined ? {} : {requestBody: optional}),
            desired: text,
            ...(optional === undefined ? {} : {before: optional}),
            relationContent: text,
          };
          const original = image(scopes, texts);
          const before = stableJson(original);
          expect(workflowJournalStorageImage(original, false)).toBe(original);
          const packed = workflowJournalStorageImage(original, true);
          const stored = encodeWorkflowJournal(stableJson(packed) + '\n');
          const decoded = decodeWorkflowJournalStorageImage(JSON.parse(await decodeWorkflowJournal(stored)));
          expect(stableJson(decoded)).toBe(before);
          expect(stableJson(original)).toBe(before);
          const reordered = {
            ...original,
            operations: EffectRecord.fromEntries(EffectRecord.toEntries(original.operations).reverse()),
          };
          expect(stableJson(workflowJournalStorageImage(reordered, true))).toBe(stableJson(packed));
        },
      ),
      {numRuns: 32},
    );
  });

  it('shares repeated scope sets and rejects malformed, unused or out-of-range references', () => {
    const original = image([['threadnote://fixture/a', 'threadnote://fixture/b']]);
    const packed = packedStorage(workflowJournalStorageImage(original, true));
    expect(packed.scopeSets).toHaveLength(1);
    expect(packed.textValues).toBeDefined();
    const decoded = decodeWorkflowJournalStorageImage(JSON.parse(stableJson(packed)));
    if (!isExpandedJournalView(decoded)) throw new Error('Expected the packed journal to decode.');
    const targets = decoded.operations['operation-0'].relations;
    expect(targets[0].allowedUriScopes).toBe(targets[1].allowedUriScopes);
    if (!isWorkflowBinding(decoded.binding)) throw new Error('Expected a packed binding.');
    expect(hasPackedWorkflowScopes(decoded.binding)).toBe(true);
    for (const mutate of [
      (value: typeof packed) => {
        const reference = value.journal.operations['operation-0'].relations[0]?.allowedUriScopes;
        if (!reference) throw new Error('Expected packed scope-set reference.');
        Object.assign(reference, {scopeSet: 2});
      },
      (value: typeof packed) => {
        const reference = value.journal.operations['operation-0'].relations[0]?.allowedUriScopes;
        if (!reference) throw new Error('Expected packed scope-set reference.');
        Object.assign(reference, {scopeSet: -1});
      },
      (value: typeof packed) => {
        value.scopeSets.push(['unused']);
      },
      (value: typeof packed) => {
        value.scopeSets.push([...value.scopeSets[0]]);
      },
      (value: typeof packed) => {
        value.textValues[0] = value.textValues[1] ?? 'duplicate';
      },
      (value: typeof packed) => {
        value.textValues.push('unused');
      },
      (value: typeof packed) => {
        const reference = value.journal.operations['operation-0'].request?.body;
        if (!reference) throw new Error('Expected packed request body reference.');
        Object.assign(reference, {extra: true});
      },
      (value: typeof packed) => {
        const reference = value.journal.operations['operation-0'].request?.body;
        if (!reference) throw new Error('Expected packed request body reference.');
        reference.text = 0.5;
      },
      (value: typeof packed) => {
        const reference = value.journal.operations['operation-0'].request?.body;
        if (!reference) throw new Error('Expected packed request body reference.');
        reference.text = value.textValues.length;
      },
    ]) {
      const corrupt = packedStorage(JSON.parse(stableJson(packed)));
      mutate(corrupt);
      expect(() => decodeWorkflowJournalStorageImage(corrupt)).toThrow();
    }
  });

  it('packs repeated large known text fields while preserving every decoded byte', () => {
    const repeated = Effect2.pipe('雪🙂\nrepeated payload\n', EffectString.repeat(6000));
    const original = image([['one-scope']], {
      manifestContent: 'manifest',
      previousManifestContent: 'previous',
      requestBody: repeated,
      desired: repeated,
      before: repeated,
      relationContent: repeated,
    });
    const plain = stableJson(workflowJournalStorageImage(original, false));
    const packed = workflowJournalStorageImage(original, true);
    const packedJson = stableJson(packed);
    expect(new TextEncoder().encode(packedJson).byteLength).toBeLessThan(
      new TextEncoder().encode(plain).byteLength * 0.35,
    );
    expect(stableJson(decodeWorkflowJournalStorageImage(JSON.parse(packedJson)))).toBe(stableJson(original));

    const fullNativeReceiptBudget: WorkflowJournal = {
      ...image([]),
      operations: EffectRecord.fromEntries(
        Array.from({length: 4096}, (_, index) => [
          `operation-${index}`,
          storageOperation(`operation-${index}`, `desired-${index}`, [], `request-${index}`, `before-${index}`),
        ]),
      ),
    };
    const fullImage = workflowJournalStorageImage(fullNativeReceiptBudget, true);
    expect(stableJson(decodeWorkflowJournalStorageImage(JSON.parse(stableJson(fullImage))))).toBe(
      stableJson(fullNativeReceiptBudget),
    );

    const tooManyReferences = {
      journalStorage: 'threadnote-workflow-journal-shared-values-v1',
      scopeSets: [],
      textValues: ['same exact text'],
      journal: {
        binding: {bindingId: 'fixture'},
        operations: {
          operation: {
            request: {body: {text: 0}},
            desired: {text: 0},
            before: {text: 0},
            relations: Array.from({length: 4096 * 19}, () => ({
              uri: 'threadnote://fixture/target',
              content: {text: 0},
            })),
          },
        },
      },
    };
    expect(() => decodeWorkflowJournalStorageImage(tooManyReferences)).toThrow();
    expect(() =>
      decodeWorkflowJournalStorageImage({
        journalStorage: 'threadnote-workflow-journal-shared-values-v1',
        scopeSets: [],
        textValues: Array.from({length: 4096 * 19 + 3}, (_, index) => `text-${index}`),
        journal: {binding: {bindingId: 'fixture'}, operations: {}},
      }),
    ).toThrow();
  });

  it('bounds actual packed postimage growth for large owned scopes and candidate child scopes', () => {
    const utf8 = new TextEncoder();
    const plannedOperations = 4;
    const texts: JournalTexts = {
      manifestContent: 'A realistic native manifest with retained full content.\n',
      previousManifestContent: 'The prior manifest remains available.\n',
      requestBody: 'A new authoring child intent body with all original bytes.\n',
      desired: 'A complete new child artifact body.\n',
      before: 'The full prior artifact body.\n',
      relationContent: 'The complete related artifact content.\n',
    };
    fc.assert(
      fc.property(fc.integer({min: 1, max: 2000}), inventoryCount => {
        const uri = (kind: string, index: number) => {
          const prefix = 'threadnote://user/tester/memories/durable/projects/fixture/';
          const unique = `${kind}-${Effect2.pipe(String(index), EffectString.padStart(4, '0'))}-`;
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
          return prefix + unique + 'x'.repeat(250 - prefix.length - unique.length);
        };
        const ownedScopes = Array.from({length: inventoryCount}, (_, index) => uri('owned', index));
        const nextScopes = Array.from({length: plannedOperations}, (_, operation) => [
          ...ownedScopes,
          ...Array.from({length: operation + 1}, (_, index) => uri('child', index)),
          ...Array.from({length: 16}, (_, index) => uri(`candidate-${operation}`, index)),
        ]);
        const before = image([ownedScopes], texts);
        const after = image([ownedScopes, ...nextScopes], texts);
        const beforeBytes = utf8.encode(stableJson(workflowJournalStorageImage(before, true))).byteLength;
        const afterBytes = utf8.encode(stableJson(workflowJournalStorageImage(after, true))).byteLength;
        const maxEntryBytes = Math.max(
          ...EffectArray.map(
            ownedScopes.concat(nextScopes.flat()),
            value => utf8.encode(JSON.stringify(value)).byteLength + 1,
          ),
        );
        const allowance = nativeAuthoringSaveByteBudget({
          contentBytes: plannedOperations * utf8.encode(stableJson(texts)).byteLength,
          evidenceBytes: 0,
          plannedOperations,
          scopeBytes: utf8.encode(JSON.stringify(ownedScopes)).byteLength,
          maximumScopeEntryBytes: maxEntryBytes,
          requestMetadataBytes: utf8.encode(
            stableJson({binding: {bindingId: 'fixture'}, generation: 'generation-1', codeRefs: [], evidenceRefs: []}),
          ).byteLength,
        });

        expect(afterBytes).toBeGreaterThan(beforeBytes);
        expect(afterBytes - beforeBytes).toBeLessThanOrEqual(allowance);
        expect(stableJson(decodeWorkflowJournalStorageImage(JSON.parse(stableJson(after))))).toBe(stableJson(after));
      }),
      {numRuns: 32},
    );
  });

  it('bounds a synthetic maximal citation and scope serialization component without losing retained bytes', () => {
    const utf8 = new TextEncoder();
    const uri = (kind: string, index: number) => {
      const prefix = 'threadnote://user/tester/memories/durable/projects/fixture/';
      const unique = `${kind}-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}-`;
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
      return prefix + unique + 'x'.repeat(4096 - prefix.length - unique.length);
    };
    const ownedUris = Array.from({length: 16}, (_, index) => uri('owned', index));
    const childCandidates = Array.from({length: 16}, (_, index) => uri('candidate', index));
    const citation = (index: number) => {
      const reference = {
        uri: ownedUris[index],
        memoryId: `tn_authoring_${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
        revision: Effect2.pipe('a', EffectString.repeat(64)),
      };
      const baseBytes = utf8.encode(JSON.stringify({...reference, body: ''})).byteLength;
      const remaining = 64 * 1024 - baseBytes;
      const pattern = '"\\\n雪🙂x';
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
      const body = pattern.repeat(Math.floor(remaining / 14)) + 'x'.repeat(remaining % 14);
      const completeContent = JSON.stringify({...reference, body});
      expect(utf8.encode(completeContent).byteLength).toBe(64 * 1024);
      return completeContent;
    };
    const citations = Array.from({length: ownedUris.length}, (_, index) => citation(index));
    const priorManifest = JSON.stringify({
      version: 1,
      artifacts: EffectArray.map(ownedUris, (canonicalUri, index) => ({
        uri: canonicalUri,
        memoryId: `tn_authoring_${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
        revision: Effect2.pipe('a', EffectString.repeat(64)),
        state: 'active',
      })),
    });
    const nextManifest = JSON.stringify({
      version: 2,
      artifacts: [
        ...EffectArray.map(ownedUris, (canonicalUri, index) => ({
          uri: canonicalUri,
          memoryId: `tn_authoring_${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
          revision: Effect2.pipe('a', EffectString.repeat(64)),
          state: 'active',
        })),
        ...EffectArray.map(childCandidates.slice(0, 4), (canonicalUri, index) => ({
          uri: canonicalUri,
          memoryId: `tn_child_${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
          revision: Effect2.pipe('b', EffectString.repeat(64)),
          state: 'active',
        })),
      ],
    });
    const authoredRequestBody = JSON.stringify({
      action: 'authoring-child',
      document: {kind: 'spec', requirements: ['A complete independently authored requirement.']},
      note: 'Complete request data remains retained in the packed journal.',
    });
    const authoredChildData = (index: number) => {
      const metadata = JSON.stringify({
        artifactKey: `child-${index}`,
        role: 'requirement',
        note: `New child metadata ${index} with quotes " and Unicode 雪🙂.`,
      });
      const targetBytes = 64 * 1024;
      const emptyBodyBytes = utf8.encode(JSON.stringify({metadata, body: ''})).byteLength;
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
      const body = 'm'.repeat(targetBytes - emptyBodyBytes);
      const value = JSON.stringify({metadata, body});
      expect(utf8.encode(value).byteLength).toBe(targetBytes);
      return value;
    };
    const childData = Array.from({length: 4}, (_, index) => authoredChildData(index));
    const operations: Record<string, WorkflowOperation> = {};
    for (let index = 0; index < ownedUris.length; index++)
      operations[`owned-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`] = storageOperation(
        `owned-${index}`,
        citations[index],
        [{uri: ownedUris[index], content: citations[index], allowedUriScopes: ownedUris}],
        citations[index],
        citations[index],
      );
    const postOperations = {...operations};
    for (let index = 0; index < 4; index++) {
      const previousChildren = childCandidates.slice(0, index);
      const allowedUriScopes = [...ownedUris, ...previousChildren];
      const targets = [...ownedUris.slice(0, 16 - index), ...previousChildren];
      const requestBody = authoredRequestBody;
      const desired = childData[index];
      const before = citations[index];
      const relations = EffectArray.map(targets, (canonicalUri, targetIndex) => ({
        uri: canonicalUri,
        content: citations[targetIndex % citations.length],
        allowedUriScopes,
      }));
      postOperations[`child-${index}`] = storageOperation(`child-${index}`, desired, relations, requestBody, before);
    }
    const manifestUri = 'threadnote://user/tester/memories/workflow/manifest.json';
    const baseline: WorkflowJournal = {
      ...image([]),
      manifestUri,
      manifestContent: priorManifest,
      operations,
    };
    const postimage: WorkflowJournal = {
      ...baseline,
      manifestContent: nextManifest,
      previousManifestContent: priorManifest,
      operations: postOperations,
    };
    const beforeJson = stableJson(workflowJournalStorageImage(baseline, true));
    const afterJson = stableJson(workflowJournalStorageImage(postimage, true));
    const actualGrowth = utf8.encode(afterJson).byteLength - utf8.encode(beforeJson).byteLength;
    const exactScopeBytes = utf8.encode(JSON.stringify(ownedUris)).byteLength;
    const maximumScopeEntryBytes = Math.max(
      ...EffectArray.map(ownedUris.concat(childCandidates), value => utf8.encode(JSON.stringify(value)).byteLength + 1),
    );
    const requestMetadataBytes = utf8.encode(
      stableJson({
        binding: baseline.binding,
        generation: 'generation-v1',
        codeRefs: ['src/authoring.ts'],
        evidenceRefs: EffectArray.map(ownedUris, (canonicalUri, index) => ({
          uri: canonicalUri,
          memoryId: `tn_authoring_${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
          revision: Effect2.pipe('a', EffectString.repeat(64)),
        })),
      }),
    ).byteLength;
    const allowance = nativeAuthoringSaveByteBudget({
      contentBytes: utf8.encode(authoredRequestBody).byteLength,
      evidenceBytes: 0,
      plannedOperations: 4,
      scopeBytes: exactScopeBytes,
      maximumScopeEntryBytes,
      requestMetadataBytes,
    });
    const packed = packedStorage(workflowJournalStorageImage(postimage, true));
    const packedOperations = EffectRecord.values(packed.journal.operations);
    const relationTextReferences = EffectArray.flatMap(packedOperations, operation =>
      EffectArray.map(operation.relations, item => item.content.text),
    );
    const decoded = decodeWorkflowJournalStorageImage(JSON.parse(afterJson));
    if (!isExpandedJournalView(decoded)) throw new Error('Expected the packed journal to decode.');

    expect(maximumScopeEntryBytes).toBe(4099);
    expect(childData).toHaveLength(4);
    expect(new Set(EffectArray.map([...citations, ...childData], value => JSON.stringify(value))).size).toBe(20);
    expect(actualGrowth).toBeGreaterThan(0);
    expect(actualGrowth).toBeLessThanOrEqual(allowance);
    expect(packed.scopeSets).toHaveLength(4);
    expect(new Set(relationTextReferences).size).toBe(16);
    expect(decoded.operations['owned-00'].relations[0].allowedUriScopes).toBe(
      decoded.operations['owned-01'].relations[0].allowedUriScopes,
    );
    expect(stableJson(decoded)).toBe(stableJson(postimage));
  });

  effectIt.effect(
    'reads packed authority through ordinary native calls and refuses corrupted references without writes',
    () =>
      Effect.gen(function* () {
        const f = yield* nativeFixture();
        const initialized = yield* f.init();
        const first = yield* withWorkflowReadCache(f.call(f.write()), {compactJournal: true});
        if (!('artifact' in first)) throw new Error('Expected a verified native artifact.');
        const second = yield* f.call(
          f.write({
            operationId: 'write-2',
            artifactKey: 'second',
            body: 'Linked body.',
            relations: [{type: 'references', uri: first.artifact.uri}],
          }),
        );
        if (!('artifact' in second)) throw new Error('Expected a linked native artifact.');
        const journalFile = f.journalPath(initialized.bindingId);
        const original = yield* f.fs.readFileString(journalFile);
        const journalText = yield* Effect.promise(() => decodeWorkflowJournal(original));
        const packed = packedStorage(JSON.parse(journalText));
        expect(packed.journalStorage).toBe('threadnote-workflow-journal-shared-values-v1');
        expect(packed.scopeSets.length).toBeGreaterThan(0);
        expect(packed.textValues.length).toBeGreaterThan(0);
        const stateBefore = yield* f.fs.readFileString(f.statePath());
        const inspected = yield* f.call(f.base('inspect'));
        expect(inspected).toHaveProperty('operations');
        expect(yield* f.fs.readFileString(journalFile)).toBe(original);
        const target = EffectArray.flatMap(
          EffectRecord.values(packed.journal.operations),
          operation => operation.relations,
        )[0];
        if (!target.allowedUriScopes) throw new Error('Expected a packed scope-set reference.');
        Object.assign(target.allowedUriScopes, {scopeSet: packed.scopeSets.length + 1});
        const corrupt = stableJson(packed) + '\n';
        yield* f.fs.writeFileString(journalFile, corrupt);
        const rejected = yield* f.call(f.base('inspect')).pipe(Effect.result);
        expect(rejected).toMatchObject({_tag: 'Failure', failure: {code: 'invalid-journal'}});
        expect(yield* f.fs.readFileString(journalFile)).toBe(corrupt);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(stateBefore);
        yield* f.fs.writeFileString(journalFile, original);
        yield* f.call(f.base('inspect'));
        expect(yield* f.fs.readFileString(journalFile)).toBe(original);

        const textCorruption = packedStorage(JSON.parse(journalText));
        const operationWithBody = EffectOption.getOrUndefined(
          EffectArray.findFirst(
            EffectRecord.values(textCorruption.journal.operations),
            operation => operation.request?.body !== undefined,
          ),
        );
        const requestBody = operationWithBody?.request?.body;
        if (!requestBody) throw new Error('Expected a packed request body reference.');
        Object.assign(requestBody, {extra: true});
        const corruptText = stableJson(textCorruption) + '\n';
        yield* f.fs.writeFileString(journalFile, corruptText);
        const rejectedText = yield* f.call(f.base('inspect')).pipe(Effect.result);
        expect(rejectedText).toMatchObject({_tag: 'Failure', failure: {code: 'invalid-journal'}});
        expect(yield* f.fs.readFileString(journalFile)).toBe(corruptText);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(stateBefore);
        yield* f.fs.writeFileString(journalFile, original);
        yield* f.call(f.base('inspect'));
        expect(yield* f.fs.readFileString(journalFile)).toBe(original);
      }).pipe(TestClock.withLive, provideNative),
  );
});
