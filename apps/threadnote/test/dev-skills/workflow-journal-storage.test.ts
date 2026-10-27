import {describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {it as effectIt} from '@effect/vitest';
import {decodeWorkflowJournal, encodeWorkflowJournal} from '../../src/workflow_memory/journal_codec.js';
import {nativeAuthoringSaveByteBudget} from '@threadnote/workflow-automations/native';
import {ResourceStore} from '@threadnote/store/resource-store';
import {
  decodeWorkflowJournalStorageImage,
  hasPackedWorkflowScopes,
  workflowJournalStorageImage,
  workflowJournalStorageImagePair,
} from '../../src/workflow_memory/journal_storage.js';
import {stableJson, type WorkflowJournal} from '../../src/workflow_memory/protocol.js';
import {immutableWorkflowImage, withWorkflowReadCache} from '../../src/workflow_memory/read_cache.js';
import {
  assertWorkflowTransition,
  persistWorkflowState,
  serializeWorkflowJournal,
  withWorkflowLock,
} from '../../src/workflow_memory/journal.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

// This fixture tests storage fidelity, not native journal admission.
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
): WorkflowJournal =>
  ({
    protocolVersion: 1,
    binding: {bindingId: 'fixture'},
    artifacts: {},
    manifestCommitted: true,
    manifestUri: 'threadnote://fixture/manifest',
    manifestContent: texts.manifestContent,
    ...(texts.previousManifestContent === undefined ? {} : {previousManifestContent: texts.previousManifestContent}),
    operations: Object.fromEntries(
      scopes.map((set, index) => [
        'operation-' + index,
        {
          request: texts.requestBody === undefined ? {} : {body: texts.requestBody},
          desired: texts.desired,
          ...(texts.before === undefined ? {} : {before: texts.before}),
          relations: Array.from({length: 4}, () => ({
            uri: 'threadnote://fixture/target',
            content: texts.relationContent,
            allowedUriScopes: [...set],
          })),
        },
      ]),
    ),
  }) as unknown as WorkflowJournal;

describe('workflow journal scope-set storage', () => {
  it('formats complete sibling images exactly across appends, replacements and pool-order changes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.string({maxLength: 40}), {maxLength: 8}), {minLength: 1, maxLength: 5}),
        fc.oneof(
          fc.array(fc.integer({min: 0, max: 0xffff}), {maxLength: 60}).map(units => String.fromCharCode(...units)),
          fc.constant('"manifestCommitted":false\n雪🙂\ud800x\udfff'),
        ),
        async (scopes, text) => {
          const initial = image(scopes, {
            manifestContent: text,
            previousManifestContent: text,
            requestBody: text,
            desired: text,
            before: text,
            relationContent: text,
          });
          const child = image([[...scopes[0], 'new-scope']]).operations['operation-0'];
          const appended = {...initial, operations: {...initial.operations, '0-child': child}};
          const replaced = {
            ...appended,
            operations: {
              ...appended.operations,
              'operation-0': {...child, desired: text + '\nreplacement'},
            },
          };
          const reordered = {
            ...replaced,
            operations: Object.fromEntries(Object.entries(replaced.operations).reverse()),
          };
          for (const current of [initial, appended, replaced, reordered]) {
            const prepared = immutableWorkflowImage({
              ...current,
              manifestCommitted: false,
              '4294967295': [undefined, text],
              '10': {manifestCommitted: false, nested: [text]},
              '2': text,
              '01': undefined,
              '4294967294': {optional: undefined},
            });
            const before = stableJson(prepared);
            const pair = workflowJournalStorageImagePair(prepared);
            for (const committed of [false, true]) {
              const state = {...prepared, manifestCommitted: committed};
              const content = committed ? pair.committed() : pair.prepared();
              expect(content).toBe(stableJson(workflowJournalStorageImage(state, true)) + '\n');
              const stored = encodeWorkflowJournal(content);
              expect(stored).toBe(serializeWorkflowJournal(state, true));
              const decoded = decodeWorkflowJournalStorageImage(JSON.parse(await decodeWorkflowJournal(stored)));
              expect(stableJson(decoded)).toBe(stableJson(state));
            }
            expect(stableJson(prepared)).toBe(before);
          }
        },
      ),
      {numRuns: 32},
    );
  });

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
            operations: Object.fromEntries(Object.entries(original.operations).reverse()),
          };
          expect(stableJson(workflowJournalStorageImage(reordered, true))).toBe(stableJson(packed));
        },
      ),
      {numRuns: 32},
    );
  });

  it('shares repeated scope sets and rejects malformed, unused or out-of-range references', () => {
    const original = image([['threadnote://fixture/a', 'threadnote://fixture/b']]);
    const packed = workflowJournalStorageImage(original, true) as {
      scopeSets: string[][];
      textValues: string[];
      journal: {
        operations: Record<
          string,
          {
            request: {body: {text: number}};
            relations: {allowedUriScopes: {scopeSet: number}; content: {text: number}}[];
          }
        >;
      };
    };
    expect(packed.scopeSets).toHaveLength(1);
    expect(packed.textValues).toBeDefined();
    const decoded = decodeWorkflowJournalStorageImage(JSON.parse(stableJson(packed))) as WorkflowJournal;
    const targets = decoded.operations['operation-0'].relations;
    expect(targets[0].allowedUriScopes).toBe(targets[1].allowedUriScopes);
    expect(hasPackedWorkflowScopes(decoded.binding)).toBe(true);
    for (const mutate of [
      (value: typeof packed) => {
        value.journal.operations['operation-0'].relations[0].allowedUriScopes.scopeSet = 2;
      },
      (value: typeof packed) => {
        value.journal.operations['operation-0'].relations[0].allowedUriScopes.scopeSet = -1;
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
        const reference = value.journal.operations['operation-0'].request.body;
        Object.assign(reference, {extra: true});
      },
      (value: typeof packed) => {
        const reference = value.journal.operations['operation-0'].request.body;
        reference.text = 0.5;
      },
      (value: typeof packed) => {
        const reference = value.journal.operations['operation-0'].request.body;
        reference.text = value.textValues.length;
      },
    ]) {
      const corrupt = JSON.parse(stableJson(packed)) as typeof packed;
      mutate(corrupt);
      expect(() => decodeWorkflowJournalStorageImage(corrupt)).toThrow();
    }
  });

  it('packs repeated large known text fields while preserving every decoded byte', () => {
    const repeated = '雪🙂\nrepeated payload\n'.repeat(6000);
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

    const fullNativeReceiptBudget = image([]) as unknown as Record<string, unknown>;
    const operations = Object.fromEntries(
      Array.from({length: 4096}, (_, index) => [
        `operation-${index}`,
        {
          request: {body: `request-${index}`},
          desired: `desired-${index}`,
          before: `before-${index}`,
          relations: [],
        },
      ]),
    );
    fullNativeReceiptBudget.operations = operations;
    const fullImage = workflowJournalStorageImage(fullNativeReceiptBudget as unknown as WorkflowJournal, true);
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
          const unique = `${kind}-${String(index).padStart(4, '0')}-`;
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
          ...ownedScopes.concat(nextScopes.flat()).map(value => utf8.encode(JSON.stringify(value)).byteLength + 1),
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
      const unique = `${kind}-${String(index).padStart(2, '0')}-`;
      return prefix + unique + 'x'.repeat(4096 - prefix.length - unique.length);
    };
    const ownedUris = Array.from({length: 16}, (_, index) => uri('owned', index));
    const childCandidates = Array.from({length: 16}, (_, index) => uri('candidate', index));
    const citation = (index: number) => {
      const reference = {
        uri: ownedUris[index],
        memoryId: `tn_authoring_${String(index).padStart(2, '0')}`,
        revision: 'a'.repeat(64),
      };
      const baseBytes = utf8.encode(JSON.stringify({...reference, body: ''})).byteLength;
      const remaining = 64 * 1024 - baseBytes;
      const pattern = '"\\\n雪🙂x';
      const body = pattern.repeat(Math.floor(remaining / 14)) + 'x'.repeat(remaining % 14);
      const completeContent = JSON.stringify({...reference, body});
      expect(utf8.encode(completeContent).byteLength).toBe(64 * 1024);
      return completeContent;
    };
    const citations = Array.from({length: ownedUris.length}, (_, index) => citation(index));
    const priorManifest = JSON.stringify({
      version: 1,
      artifacts: ownedUris.map((canonicalUri, index) => ({
        uri: canonicalUri,
        memoryId: `tn_authoring_${String(index).padStart(2, '0')}`,
        revision: 'a'.repeat(64),
        state: 'active',
      })),
    });
    const nextManifest = JSON.stringify({
      version: 2,
      artifacts: [
        ...ownedUris.map((canonicalUri, index) => ({
          uri: canonicalUri,
          memoryId: `tn_authoring_${String(index).padStart(2, '0')}`,
          revision: 'a'.repeat(64),
          state: 'active',
        })),
        ...childCandidates.slice(0, 4).map((canonicalUri, index) => ({
          uri: canonicalUri,
          memoryId: `tn_child_${String(index).padStart(2, '0')}`,
          revision: 'b'.repeat(64),
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
      const body = 'm'.repeat(targetBytes - emptyBodyBytes);
      const value = JSON.stringify({metadata, body});
      expect(utf8.encode(value).byteLength).toBe(targetBytes);
      return value;
    };
    const childData = Array.from({length: 4}, (_, index) => authoredChildData(index));
    const operations: Record<string, unknown> = {};
    for (let index = 0; index < ownedUris.length; index++)
      operations[`owned-${String(index).padStart(2, '0')}`] = {
        request: {body: citations[index]},
        desired: citations[index],
        before: citations[index],
        relations: [
          {
            uri: ownedUris[index],
            content: citations[index],
            allowedUriScopes: ownedUris,
          },
        ],
      };
    const postOperations = {...operations};
    for (let index = 0; index < 4; index++) {
      const previousChildren = childCandidates.slice(0, index);
      const allowedUriScopes = [...ownedUris, ...previousChildren];
      const targets = [...ownedUris.slice(0, 16 - index), ...previousChildren];
      const requestBody = authoredRequestBody;
      const desired = childData[index];
      const before = citations[index];
      const relations = targets.map((canonicalUri, targetIndex) => ({
        uri: canonicalUri,
        content: citations[targetIndex % citations.length],
        allowedUriScopes,
      }));
      postOperations[`child-${index}`] = {request: {body: requestBody}, desired, before, relations};
    }
    const manifestUri = 'threadnote://user/tester/memories/workflow/manifest.json';
    const baseline = {
      protocolVersion: 1,
      binding: {bindingId: 'fixture', repo: '/private/fixture'},
      manifestCommitted: true,
      manifestUri,
      manifestContent: priorManifest,
      artifacts: {},
      operations,
    } as unknown as WorkflowJournal;
    const postimage = {
      ...baseline,
      manifestContent: nextManifest,
      previousManifestContent: priorManifest,
      operations: postOperations,
    } as unknown as WorkflowJournal;
    const beforeJson = stableJson(workflowJournalStorageImage(baseline, true));
    const afterJson = stableJson(workflowJournalStorageImage(postimage, true));
    const actualGrowth = utf8.encode(afterJson).byteLength - utf8.encode(beforeJson).byteLength;
    const exactScopeBytes = utf8.encode(JSON.stringify(ownedUris)).byteLength;
    const maximumScopeEntryBytes = Math.max(
      ...ownedUris.concat(childCandidates).map(value => utf8.encode(JSON.stringify(value)).byteLength + 1),
    );
    const requestMetadataBytes = utf8.encode(
      stableJson({
        binding: baseline.binding,
        generation: 'generation-v1',
        codeRefs: ['src/authoring.ts'],
        evidenceRefs: ownedUris.map((canonicalUri, index) => ({
          uri: canonicalUri,
          memoryId: `tn_authoring_${String(index).padStart(2, '0')}`,
          revision: 'a'.repeat(64),
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
    const packed = workflowJournalStorageImage(postimage, true) as {
      scopeSets: string[][];
      textValues: string[];
      journal: {
        operations: Record<
          string,
          {relations: {uri: string; content: {text: number}; allowedUriScopes: {scopeSet: number}}[]}
        >;
      };
    };
    const packedOperations = Object.values(packed.journal.operations);
    const relationTextReferences = packedOperations.flatMap(operation =>
      operation.relations.map(item => item.content.text),
    );
    const decoded = decodeWorkflowJournalStorageImage(JSON.parse(afterJson)) as WorkflowJournal;

    expect(maximumScopeEntryBytes).toBe(4099);
    expect(childData).toHaveLength(4);
    expect(new Set([...citations, ...childData].map(value => JSON.stringify(value))).size).toBe(20);
    expect(actualGrowth).toBeGreaterThan(0);
    expect(actualGrowth).toBeLessThanOrEqual(allowance);
    expect(packed.scopeSets).toHaveLength(4);
    expect(new Set(relationTextReferences).size).toBe(16);
    expect(decoded.operations['owned-00'].relations[0].allowedUriScopes).toBe(
      decoded.operations['owned-01'].relations[0].allowedUriScopes,
    );
    expect(stableJson(decoded)).toBe(stableJson(postimage));
  });

  effectIt.effect('checks both native sibling capacities before mutation', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      const journalFile = f.journalPath(initialized.bindingId);
      const original = yield* f.fs.readFileString(journalFile);
      const previous = decodeWorkflowJournalStorageImage(
        JSON.parse(yield* Effect.promise(() => decodeWorkflowJournal(original))),
      ) as WorkflowJournal;
      const manifestBefore = yield* f.store.read(f.location, previous.manifestUri);
      const updated = {...previous, retainedJson: 'x'.repeat(17 * 1024 * 1024)};
      const flags: boolean[] = [];
      const nativeGzip = Bun.gzipSync;
      const result = yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(Bun, 'gzipSync').mockImplementation((bytes, options) => {
            const logical = decodeWorkflowJournalStorageImage(
              JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)),
            ) as WorkflowJournal;
            flags.push(logical.manifestCommitted);
            if (flags.length === 2) throw new Error('second capacity codec failure');
            return nativeGzip(bytes, options);
          }),
        ),
        () =>
          withWorkflowLock(
            f.config,
            initialized.bindingId,
            withWorkflowReadCache(assertWorkflowTransition(f.config, previous, updated), {compactJournal: true}),
          ).pipe(Effect.result),
        spy => Effect.sync(() => spy.mockRestore()),
      );
      expect(flags).toEqual([false, true]);
      expect(result).toMatchObject({_tag: 'Failure', failure: {code: 'journal-capacity'}});
      expect(yield* f.fs.readFileString(journalFile)).toBe(original);
      expect(yield* f.store.read(f.location, previous.manifestUri)).toBe(manifestBefore);
    }).pipe(TestClock.withLive, provideNative),
  );

  effectIt.effect('keeps native pair codec failures at the original write fences and recovers exact receipts', () =>
    Effect.gen(function* () {
      for (const failAt of [1, 2]) {
        const f = yield* nativeFixture();
        const initialized = yield* f.init();
        const journalFile = f.journalPath(initialized.bindingId);
        const original = yield* f.fs.readFileString(journalFile);
        const previous = decodeWorkflowJournalStorageImage(
          JSON.parse(yield* Effect.promise(() => decodeWorkflowJournal(original))),
        ) as WorkflowJournal;
        const manifestBefore = yield* f.store.read(f.location, previous.manifestUri);
        const updated = {...previous, retainedJson: 'x'.repeat(2 * 1024 * 1024)};
        yield* Effect.sleep('2 millis');
        const events: string[] = [];
        const monitored: typeof f.store = {
          ...f.store,
          read: (...args) =>
            f.store.read(...args).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (args[1] === previous.manifestUri) events.push('manifest-read');
                }),
              ),
            ),
          write: (...args) =>
            f.store.write(...args).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (args[1] === previous.manifestUri) events.push('manifest-written');
                }),
              ),
            ),
        };
        const nativeGzip = Bun.gzipSync;
        let codecs = 0;
        const result = yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi.spyOn(Bun, 'gzipSync').mockImplementation((bytes, options) => {
              const logical = decodeWorkflowJournalStorageImage(
                JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)),
              ) as WorkflowJournal;
              events.push(logical.manifestCommitted ? 'codec:committed' : 'codec:prepared');
              if (++codecs === failAt) throw new Error('pair write codec failure');
              return nativeGzip(bytes, options);
            }),
          ),
          () =>
            withWorkflowLock(
              f.config,
              initialized.bindingId,
              withWorkflowReadCache(persistWorkflowState(f.config, previous, updated), {compactJournal: true}),
            ).pipe(Effect.provideService(ResourceStore, monitored), Effect.result),
          spy => Effect.sync(() => spy.mockRestore()),
        );
        expect(result).toMatchObject({_tag: 'Failure', failure: {code: 'journal-capacity'}});
        const failedBytes = yield* f.fs.readFileString(journalFile);
        const pending = decodeWorkflowJournalStorageImage(
          JSON.parse(yield* Effect.promise(() => decodeWorkflowJournal(failedBytes))),
        ) as WorkflowJournal;
        if (failAt === 1) {
          expect(events).toEqual(['codec:prepared']);
          expect(failedBytes).toBe(original);
          expect(yield* f.store.read(f.location, previous.manifestUri)).toBe(manifestBefore);
        } else {
          expect(events).toEqual([
            'codec:prepared',
            'manifest-read',
            'manifest-written',
            'manifest-read',
            'codec:committed',
          ]);
          expect(pending.manifestCommitted).toBe(false);
          expect(failedBytes).toBe(serializeWorkflowJournal(pending, true));
          expect(yield* f.store.read(f.location, previous.manifestUri)).toBe(pending.manifestContent);
        }
        const recovered = yield* withWorkflowLock(
          f.config,
          initialized.bindingId,
          withWorkflowReadCache(persistWorkflowState(f.config, pending, pending), {compactJournal: true}),
        );
        expect(recovered.manifestCommitted).toBe(true);
        expect(yield* f.fs.readFileString(journalFile)).toBe(serializeWorkflowJournal(recovered, true));
        expect(yield* f.store.read(f.location, recovered.manifestUri)).toBe(recovered.manifestContent);
      }
    }).pipe(TestClock.withLive, provideNative),
  );

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
        const packed = JSON.parse(journalText) as {
          journalStorage: string;
          scopeSets: string[][];
          textValues: string[];
          journal: {
            operations: Record<
              string,
              {
                request: {body?: {text: number}};
                desired: {text: number};
                relations: {content: {text: number}; allowedUriScopes?: {scopeSet: number}}[];
              }
            >;
          };
        };
        expect(packed.journalStorage).toBe('threadnote-workflow-journal-shared-values-v1');
        expect(packed.scopeSets.length).toBeGreaterThan(0);
        expect(packed.textValues.length).toBeGreaterThan(0);
        const stateBefore = yield* f.fs.readFileString(f.statePath());
        const inspected = yield* f.call(f.base('inspect'));
        expect(inspected).toHaveProperty('operations');
        expect(yield* f.fs.readFileString(journalFile)).toBe(original);
        const target = Object.values(packed.journal.operations).flatMap(operation => operation.relations)[0];
        if (!target.allowedUriScopes) throw new Error('Expected a packed scope-set reference.');
        target.allowedUriScopes.scopeSet = packed.scopeSets.length + 1;
        const corrupt = stableJson(packed) + '\n';
        yield* f.fs.writeFileString(journalFile, corrupt);
        const rejected = yield* f.call(f.base('inspect')).pipe(Effect.result);
        expect(rejected).toMatchObject({_tag: 'Failure', failure: {code: 'invalid-journal'}});
        expect(yield* f.fs.readFileString(journalFile)).toBe(corrupt);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(stateBefore);
        yield* f.fs.writeFileString(journalFile, original);
        yield* f.call(f.base('inspect'));
        expect(yield* f.fs.readFileString(journalFile)).toBe(original);

        const textCorruption = JSON.parse(journalText) as typeof packed;
        const operationWithBody = Object.values(textCorruption.journal.operations).find(
          operation => operation.request.body !== undefined,
        );
        if (!operationWithBody?.request.body) throw new Error('Expected a packed request body reference.');
        Object.assign(operationWithBody.request.body, {extra: true});
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
