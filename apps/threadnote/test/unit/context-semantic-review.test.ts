import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Result, Layer} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {formatMemoryDocument, parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {
  analyzeContextHealthSemantics,
  extractContextHealthSemanticClaims,
  findContextHealthSemanticContradiction,
} from '@threadnote/context/health_semantic';
import {StandaloneBrokerLayer} from '../../src/effect/runtime-bootstrap.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {
  reviewedSemanticContradictionIds,
  projectReviewedSemanticCases,
  readSemanticReviewState,
} from '../../src/memory/context/semantic_review_state.js';
import {buildContextHealthReport} from '@threadnote/context/health';
import {handleManagerAttentionAction, semanticReviewFailureResponse} from '../../src/manager/attention_actions.js';
import {semanticReviewError} from '../../src/memory/context/semantic_review_state.js';
import {ResourceConflict} from '@threadnote/store/resource-store';
import {readContextMaintenanceStatus} from '../../src/memory/context/maintenance.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {writeSemanticReviewState} from '../../src/memory/context/semantic_review_state.js';
import {
  previewSemanticReview,
  applySemanticReview,
  buildSemanticReviewPreview,
} from '../../src/memory/context/semantic_review.js';

function memory(name: string, body: string): MemoryRecord {
  return parseMemoryDocument(
    `threadnote://user/tester/memories/durable/projects/threadnote/${name}.md`,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        schemaVersion: 2,
        project: 'threadnote',
        status: 'active',
        sourceAgentClient: 'test',
        timestamp: '2026-06-01T00:00:00.000Z',
        memoryId: name,
      },
      body,
    ),
  )!;
}
const NOW = new Date('2026-06-01T00:00:00.000Z');
const records = [memory('a', 'Timeout is 60 seconds.'), memory('b', 'Timeout must be 30 seconds.')];
function input(choice: 'left' | 'right' | 'both' = 'left', corpus = records) {
  const evidence = analyzeContextHealthSemantics({project: 'threadnote', records: corpus}).contradictions[0];
  return {
    project: 'threadnote',
    contradictionId: evidence.contradictionId,
    left: {recordUri: evidence.left.recordUri, recordContentFingerprint: evidence.left.recordContentFingerprint},
    right: {recordUri: evidence.right.recordUri, recordContentFingerprint: evidence.right.recordContentFingerprint},
    choice,
  };
}

const reviewLayer = Layer.mergeAll(
  StandaloneBrokerLayer,
  Layer.mock(LocalModelCatalog, {}),
  Layer.mock(LocalModelStore, {path: () => '/unused'}),
  Layer.mock(LocalModelRuntime, {}),
  CodeGraphLanguagePackRegistry.layer,
  Layer.mock(CodeGraphQueryService, {}),
  Layer.mock(CodeGraphStore, {}),
  ResourceStore.layer.pipe(
    Layer.provide(
      Layer.merge(StandaloneBrokerLayer, Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void})),
    ),
  ),
);

function fixture(corpus = records) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'semantic-review-'});
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: path.join(home, 'threadnote.json'),
      user: 'tester',
    };
    const store = yield* ResourceStore;
    const location = {account: config.account, home, user: 'tester'};
    for (const record of corpus) yield* store.write(location, record.uri, record.content, {mode: 'create'});
    return {store, location, config};
  });
}

describe('explicit semantic review', () => {
  effectIt.effect('persists selected claim fingerprints through preview and apply', () =>
    Effect.gen(function* () {
      const evidence = findContextHealthSemanticContradiction(records)!;
      const selected = {
        ...input('both'),
        left: {
          ...input('both').left,
          claimFingerprint: evidence.left.claimFingerprint,
        },
        right: {
          ...input('both').right,
          claimFingerprint: evidence.right.claimFingerprint,
        },
      };
      const {config} = yield* fixture();
      const preview = yield* previewSemanticReview(config, selected);
      const saved = yield* readSemanticReviewState(config);
      expect(saved.entries[0].input.left.claimFingerprint).toBe(evidence.left.claimFingerprint);
      expect(saved.entries[0].input.right.claimFingerprint).toBe(evidence.right.claimFingerprint);
      expect(
        yield* applySemanticReview(config, {
          project: 'threadnote',
          previewId: preview.previewId,
          revision: preview.revision,
          approved: true,
        }),
      ).toMatchObject({status: 'applied'});
    }).pipe(provideTestLayer(reviewLayer)),
  );
  it('previews an exact comparison whose claim was beyond the direct analyzer limit', () => {
    const filler = Array.from(
      {length: 17},
      (_, index) => `Worker token${String.fromCharCode(97 + index)} must retain verified context.`,
    ).join('\n');
    const subject = Array.from(
      {length: 100},
      (_, index) =>
        `Deployment policy${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
    ).find(
      candidate =>
        extractContextHealthSemanticClaims(
          memory('a-late', `${filler}\n${candidate} must use signed artifacts.`),
        ).claims.findIndex(claim => claim.text.startsWith(candidate)) >= 16,
    )!;
    const corpus = [
      memory('a-late', `${filler}\n${subject} must use signed artifacts.`),
      memory('z-late', `${subject} must not use signed artifacts.`),
    ];
    expect(analyzeContextHealthSemantics({project: 'threadnote', records: corpus}).contradictions).toHaveLength(0);
    const evidence = findContextHealthSemanticContradiction(corpus)!;
    const selected = {
      project: 'threadnote',
      contradictionId: evidence.contradictionId,
      left: {
        recordUri: evidence.left.recordUri,
        recordContentFingerprint: evidence.left.recordContentFingerprint,
        claimFingerprint: evidence.left.claimFingerprint,
      },
      right: {
        recordUri: evidence.right.recordUri,
        recordContentFingerprint: evidence.right.recordContentFingerprint,
        claimFingerprint: evidence.right.claimFingerprint,
      },
      choice: 'both' as const,
    };
    expect(buildSemanticReviewPreview(selected, corpus, 'tester').mode).toBe('keep-both');
  });
  it('returns plain safe recovery messages and reserves stale status for changed evidence', () => {
    const native = ResourceConflict.make({
      actualFingerprint: 'a'.repeat(64),
      expectedFingerprint: 'b'.repeat(64),
      uri: records[0].uri,
      message: `Resource changed: ${records[0].uri}`,
    });
    expect(semanticReviewFailureResponse(native).status).toBe(409);
    expect(semanticReviewFailureResponse(semanticReviewError('Stored shape is unsupported.', 'blocked')).status).toBe(
      422,
    );
    const unknown = semanticReviewFailureResponse(new Error(`Private storage path: ${records[0].uri}`));
    expect(unknown.status).toBe(503);
    expect(unknown.body.error).toContain("Couldn't confirm completion");
    for (const error of [
      native,
      semanticReviewError(records[0].uri, 'stale'),
      semanticReviewError(records[0].uri, 'blocked'),
      new Error(records[0].uri),
    ])
      expect(semanticReviewFailureResponse(error).body.error).not.toContain('threadnote://');
  });
  it('binds the same preview revision independently of request object key insertion order', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(['project', 'contradictionId', 'left', 'right', 'choice'] as const, {
          minLength: 5,
          maxLength: 5,
        }),
        fc.boolean(),
        (keys, reverseSourceKeys) => {
          const request = input();
          const values = {
            ...request,
            left: reverseSourceKeys
              ? {recordContentFingerprint: request.left.recordContentFingerprint, recordUri: request.left.recordUri}
              : request.left,
            right: reverseSourceKeys
              ? {recordContentFingerprint: request.right.recordContentFingerprint, recordUri: request.right.recordUri}
              : request.right,
          };
          const reordered = Object.fromEntries(keys.map(key => [key, values[key]])) as typeof request;
          expect(buildSemanticReviewPreview(reordered, records, 'tester').revision).toBe(
            buildSemanticReviewPreview(request, records, 'tester').revision,
          );
        },
      ),
      {numRuns: 24},
    );
  });
  fcEffectProp(
    effectIt,
    'human archive choice is idempotent and leaves chosen source unchanged for arbitrary incompatible values',
    {value: fc.integer({min: 1, max: 10_000}), keepLeft: fc.boolean()},
    ({value, keepLeft}) =>
      Effect.gen(function* () {
        const corpus = [memory('a', `Timeout is ${value} seconds.`), memory('b', `Timeout is ${value + 1} seconds.`)];
        const {config, store, location} = yield* fixture(corpus);
        const preview = yield* previewSemanticReview(config, input(keepLeft ? 'left' : 'right', corpus));
        const approval = {
          project: 'threadnote',
          previewId: preview.previewId,
          revision: preview.revision,
          approved: true,
        };
        expect((yield* applySemanticReview(config, approval)).status).toBe('applied');
        expect((yield* applySemanticReview(config, approval)).status).toBe('already-applied');
        expect(yield* store.read(location, preview.keptUri!)).toBe(
          corpus.find(record => record.uri === preview.keptUri)!.content,
        );
      }).pipe(provideTestLayer(reviewLayer)),
    {fastCheck: {numRuns: 12}},
  );
  it('requires an explicit choice and both exact current source revisions', () => {
    expect(() => buildSemanticReviewPreview({...input(), choice: undefined} as never, records, 'tester')).toThrow(
      /choice/iu,
    );
    for (const name of ['a', 'b']) {
      expect(() =>
        buildSemanticReviewPreview(
          input(),
          records.map(record =>
            record.uri.endsWith(`${name}.md`) ? memory(name, `${record.body}\nChanged.`) : record,
          ),
          'tester',
        ),
      ).toThrow(/changed/iu);
    }
  });
  effectIt.effect(
    'archives raw documents with surrounding whitespace and invalidates keep-both receipts on whitespace edits',
    () =>
      Effect.gen(function* () {
        const {config, store, location} = yield* fixture();
        for (const record of records)
          yield* store.write(location, record.uri, `\n${record.content}\n`, {mode: 'replace'});
        const preview = yield* previewSemanticReview(config, input());
        expect(
          (yield* applySemanticReview(config, {
            project: 'threadnote',
            previewId: preview.previewId,
            revision: preview.revision,
            approved: true,
          })).status,
        ).toBe('applied');
        expect(yield* store.read(location, preview.keptUri!)).toBe(
          `\n${records.find(record => record.uri === preview.keptUri)!.content}\n`,
        );
        const both = yield* fixture();
        const retained = yield* previewSemanticReview(both.config, input('both'));
        yield* applySemanticReview(both.config, {
          project: 'threadnote',
          previewId: retained.previewId,
          revision: retained.revision,
          approved: true,
        });
        yield* both.store.write(both.location, records[0].uri, `${records[0].content}\n`, {mode: 'replace'});
        expect(yield* reviewedSemanticContradictionIds(both.config, 'threadnote', records)).toEqual([]);
      }).pipe(provideTestLayer(reviewLayer)),
  );
  it('previews the entire other memory with policy/applicability caveats and preserves both original bodies', () => {
    const preview = buildSemanticReviewPreview(input(), records, 'tester');
    expect(preview.mode).toBe('archive-other');
    expect(preview.constraints.join(' ')).toMatch(/entire|policy|applicability/iu);
    expect([preview.keptContent, preview.archivedContent].sort()).toEqual(records.map(record => record.body).sort());
    expect(buildSemanticReviewPreview(input('both'), records, 'tester').mode).toBe('keep-both');
  });
  it('blocks storage-unsafe records without choosing a winner', () => {
    for (const patch of [{visibility: 'shared'}, {consolidationError: 'broken'}, {citationErrors: [{reason: 'bad'}]}]) {
      const changed = records.map(record => ({
        ...record,
        metadata: {...record.metadata, ...patch},
      })) as readonly MemoryRecord[];
      expect(buildSemanticReviewPreview(input(), changed, 'tester').mode).toBe('review-only');
    }
    const future = records.map(record => ({
      ...record,
      content: record.content.replace('schema_version: 2', 'schema_version: 999'),
    }));
    expect(buildSemanticReviewPreview(input('left', future), future, 'tester').mode).toBe('review-only');
  });
  it('swapping the presented pair and reversing the choice keeps the same memory', () => {
    fc.assert(
      fc.property(fc.boolean(), keepLeft => {
        const request = input(keepLeft ? 'left' : 'right');
        const reversed = {
          ...request,
          left: request.right,
          right: request.left,
          choice: keepLeft ? ('right' as const) : ('left' as const),
        };
        expect(buildSemanticReviewPreview(request, records, 'tester').keptUri).toBe(
          buildSemanticReviewPreview(reversed, records, 'tester').keptUri,
        );
      }),
      {numRuns: 12},
    );
  });
  effectIt.effect(
    'requires approval, archives exact original history, and repeats idempotently without changing kept bytes',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'semantic-review-'});
        const config = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'threadnote.json'),
          user: 'tester',
        };
        const store = yield* ResourceStore;
        const location = {account: config.account, home, user: 'tester'};
        for (const record of records) yield* store.write(location, record.uri, record.content, {mode: 'create'});
        const preview = yield* previewSemanticReview(config, input());
        const opposite = yield* previewSemanticReview(config, input('right'));
        expect(
          Result.isFailure(
            yield* applySemanticReview(config, {
              project: 'threadnote',
              previewId: preview.previewId,
              revision: preview.revision,
              approved: false,
            }).pipe(Effect.result),
          ),
        ).toBe(true);
        const result = yield* applySemanticReview(config, {
          project: 'threadnote',
          previewId: preview.previewId,
          revision: preview.revision,
          approved: true,
        });
        expect(result.status).toBe('applied');
        expect(
          Result.isFailure(
            yield* applySemanticReview(config, {
              project: 'threadnote',
              previewId: opposite.previewId,
              revision: opposite.revision,
              approved: true,
            }).pipe(Effect.result),
          ),
        ).toBe(true);
        expect(
          (yield* applySemanticReview(config, {
            project: 'threadnote',
            previewId: preview.previewId,
            revision: preview.revision,
            approved: true,
          })).status,
        ).toBe('already-applied');
        expect(yield* store.read(location, preview.keptUri!)).toBe(
          records.find(record => record.uri === preview.keptUri)!.content,
        );
        const history = parseMemoryDocument(result.archivedUri!, yield* store.read(location, result.archivedUri!))!;
        const original = records.find(record => record.uri === preview.archivedUri)!;
        expect(history.metadata.archivedFrom).toBe(original.uri);
        expect(history.metadata.memoryId).toBe(original.metadata.memoryId);
        expect(history.body).toContain(original.body);
      }).pipe(provideTestLayer(reviewLayer)),
  );
  effectIt.effect('rejects stale either-source apply and preserves both canonical memories', () =>
    Effect.gen(function* () {
      for (const changed of records) {
        const {config, store, location} = yield* fixture();
        const preview = yield* previewSemanticReview(config, input());
        yield* store.write(location, changed.uri, `${changed.content}\nChanged.`, {mode: 'replace'});
        expect(
          Result.isFailure(
            yield* applySemanticReview(config, {
              project: 'threadnote',
              previewId: preview.previewId,
              revision: preview.revision,
              approved: true,
            }).pipe(Effect.result),
          ),
        ).toBe(true);
        for (const record of records)
          expect(yield* store.read(location, record.uri)).toBe(
            record.content + (record.uri === changed.uri ? '\nChanged.' : ''),
          );
      }
    }).pipe(provideTestLayer(reviewLayer)),
  );
  effectIt.effect(
    'keeps both without changing text, suppresses only exact reviewed evidence, and reopens after edits',
    () =>
      Effect.gen(function* () {
        const {config, store, location} = yield* fixture();
        const preview = yield* previewSemanticReview(config, input('both'));
        const apply = {project: 'threadnote', previewId: preview.previewId, revision: preview.revision, approved: true};
        expect((yield* applySemanticReview(config, apply)).status).toBe('applied');
        expect((yield* applySemanticReview(config, apply)).status).toBe('already-applied');
        const ids = yield* reviewedSemanticContradictionIds(config, 'threadnote', records);
        expect(ids).toEqual([input().contradictionId]);
        expect(
          buildContextHealthReport({
            project: 'threadnote',
            records,
            now: NOW,
            reviewedSemanticContradictionIds: ids,
          }).findings.filter(finding => finding.semanticEvidence),
        ).toEqual([]);
        const finding = buildContextHealthReport({project: 'threadnote', records, now: NOW}).findings.find(
          finding => finding.semanticEvidence,
        )!;
        const item = {
          ...finding.caseIdentity!,
          caseId: finding.caseId!,
          evidenceRevision: 'original',
          disposition: 'needs-decision' as const,
          reason: 'original',
          firstSeen: '2026-06-01',
          lastSeen: '2026-06-01',
          lastChecked: '2026-06-01',
          attemptCount: 0,
          events: [{at: '2026-06-01', reason: 'original'}],
          subjectContentHashes: records.map(record => ({
            uri: record.uri,
            hash:
              input().left.recordUri === record.uri
                ? input().left.recordContentFingerprint
                : input().right.recordContentFingerprint,
          })),
        };
        const journal = yield* readSemanticReviewState(config);
        expect(projectReviewedSemanticCases([item], journal.entries, records)[0]).toMatchObject({
          disposition: 'resolved',
          reason: 'human-reviewed-keep-both',
          firstSeen: item.firstSeen,
        });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateFile = path.join(config.agentContextHome, 'context-maintenance', 'state-v2.json');
        yield* fs.makeDirectory(path.dirname(stateFile), {recursive: true});
        yield* fs.writeFileString(
          stateFile,
          JSON.stringify({version: 2, paused: false, projects: [], checkpoints: {}, receipts: [], cases: [item]}),
        );
        expect(
          (yield* readContextMaintenanceStatus(config, 'threadnote')).cases.find(
            current => current.caseId === item.caseId,
          )?.disposition,
        ).toBe('resolved');
        yield* applySemanticReview(config, apply);
        const persisted = JSON.parse(yield* fs.readFileString(stateFile));
        expect(persisted.cases[0]).toMatchObject({disposition: 'resolved', reason: 'human-reviewed-keep-both'});
        yield* store.write(location, records[0].uri, `${records[0].content}\n`, {mode: 'replace'});
        expect(yield* reviewedSemanticContradictionIds(config, 'threadnote', records)).toEqual([]);
        expect(
          (yield* readContextMaintenanceStatus(config, 'threadnote')).cases.find(
            current => current.caseId === item.caseId,
          )?.disposition,
        ).toBe('needs-decision');
        yield* store.write(location, records[0].uri, records[0].content, {mode: 'replace'});
        yield* writeSemanticReviewState(config, {
          ...journal,
          entries: journal.entries.map(entry => ({...entry, rawSources: undefined})),
        });
        expect(yield* reviewedSemanticContradictionIds(config, 'threadnote', records)).toEqual([]);
        expect(
          (yield* readContextMaintenanceStatus(config, 'threadnote')).cases.find(
            current => current.caseId === item.caseId,
          )?.disposition,
        ).toBe('needs-decision');
        yield* writeSemanticReviewState(config, journal);
        for (const record of records) expect(yield* store.read(location, record.uri)).toBe(record.content);
        const edited = memory('a', `${records[0].body}\nChanged context.`);
        yield* store.write(location, edited.uri, edited.content, {mode: 'replace'});
        const changedRecords = [edited, records[1]];
        expect(yield* reviewedSemanticContradictionIds(config, 'threadnote', changedRecords)).toEqual([]);
        expect(projectReviewedSemanticCases([item], journal.entries, changedRecords)[0].disposition).toBe(
          'needs-decision',
        );
        expect(Result.isFailure(yield* applySemanticReview(config, apply).pipe(Effect.result))).toBe(true);
      }).pipe(provideTestLayer(reviewLayer)),
  );
  effectIt.effect('rechecks both sources inside the account mutation lock before any canonical mutation', () =>
    Effect.gen(function* () {
      for (const changed of records) {
        const {config, store, location} = yield* fixture();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const preview = yield* previewSemanticReview(config, input());
        const wrapped = ResourceStore.of({
          ...store,
          mutateChecked: (location, mutations, check) =>
            store.mutateChecked(
              location,
              mutations,
              fs
                .writeFileString(
                  path.join(
                    config.agentContextHome,
                    'data',
                    'local',
                    'user',
                    'tester',
                    'memories',
                    'durable',
                    'projects',
                    'threadnote',
                    changed.uri.endsWith('/a.md') ? 'a.md' : 'b.md',
                  ),
                  `${changed.content}\nConcurrent edit.`,
                )
                .pipe(Effect.orDie, Effect.andThen(check)),
            ),
        });
        const applied = yield* applySemanticReview(config, {
          project: 'threadnote',
          previewId: preview.previewId,
          revision: preview.revision,
          approved: true,
        }).pipe(provideTestLayer(Layer.succeed(ResourceStore, wrapped)), Effect.result);
        expect(Result.isFailure(applied)).toBe(true);
        expect(
          yield* fs.exists(
            path.join(
              config.agentContextHome,
              'data',
              'local',
              'user',
              'tester',
              'memories',
              'durable',
              'archived',
              'threadnote',
              `${preview.previewId}.md`,
            ),
          ),
        ).toBe(false);
        for (const record of records)
          expect(yield* store.read(location, record.uri)).toBe(
            record.content + (record.uri === changed.uri ? '\nConcurrent edit.' : ''),
          );
      }
    }).pipe(provideTestLayer(reviewLayer)),
  );
  effectIt.effect(
    'preserves citation, identity, scope, relations and the entire original body in recoverable history',
    () =>
      Effect.gen(function* () {
        const citation = createMemoryCodeCitation({
          version: 1,
          repositoryId: 'b'.repeat(64),
          repositoryIdentityKind: 'local',
          sourceCommit: 'c'.repeat(40),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
          extractorSet: 'test',
          path: 'source.ts',
          fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
          target: {kind: 'file'},
        });
        const corpus = records.map(record =>
          parseMemoryDocument(
            record.uri,
            formatMemoryDocument(
              'MEMORY',
              {
                ...record.metadata,
                schemaVersion: 6,
                workspaceScope: 'repository',
                codeCitations: [citation],
                references: ['threadnote://resources/repos/threadnote'],
                relations: [{type: 'references', uri: 'threadnote://resources/repos/threadnote'}],
              },
              `${record.body}\nUnrelated original paragraph.`,
            ),
          )!,
        );
        const {config, store, location} = yield* fixture(corpus);
        const preview = yield* previewSemanticReview(config, input('left', corpus));
        const approval = {
          project: 'threadnote',
          previewId: preview.previewId,
          revision: preview.revision,
          approved: true,
        };
        const result = yield* applySemanticReview(config, approval);
        const history = parseMemoryDocument(result.archivedUri!, yield* store.read(location, result.archivedUri!))!;
        const original = corpus.find(record => record.uri === preview.archivedUri)!;
        expect(history.body).toBe(`Archived original Threadnote memory.\n\n${original.body}`);
        expect(history.metadata).toMatchObject({
          memoryId: original.metadata.memoryId,
          workspaceScope: original.metadata.workspaceScope,
          codeCitations: original.metadata.codeCitations,
          references: original.metadata.references,
          relations: original.metadata.relations,
          archivedFrom: original.uri,
          status: 'archived',
        });
        const saved = yield* readSemanticReviewState(config);
        yield* writeSemanticReviewState(config, {
          ...saved,
          entries: saved.entries.map(entry => ({...entry, applied: false})),
        });
        expect((yield* applySemanticReview(config, approval)).status).toBe('already-applied');
        expect(yield* store.read(location, preview.keptUri!)).toBe(
          corpus.find(record => record.uri === preview.keptUri)!.content,
        );
        yield* store.write(location, original.uri, original.content, {mode: 'create'});
        expect(Result.isFailure(yield* applySemanticReview(config, approval).pipe(Effect.result))).toBe(true);
      }).pipe(provideTestLayer(reviewLayer)),
  );
  effectIt.effect('Manager pair preview works across two topics without a repository and rejects missing choice', () =>
    Effect.gen(function* () {
      const {config} = yield* fixture();
      const action = (body: Record<string, unknown>) =>
        handleManagerAttentionAction({
          config,
          body: Effect.succeed(body),
          method: 'POST',
          url: new URL('http://localhost/api/context-health/semantic/preview'),
        });
      expect((yield* action({...input(), choice: undefined}))?.status).toBe(400);
      const response = yield* action(input());
      expect(response?.status).toBe(200);
      expect(response?.body).toHaveProperty('preview.mode', 'archive-other');
      const request = input();
      const reordered = yield* action({
        project: request.project,
        contradictionId: request.contradictionId,
        choice: request.choice,
        left: request.left,
        right: request.right,
      });
      expect(reordered?.status).toBe(200);
      const preview = (reordered!.body as {preview: {previewId: string; revision: string}}).preview;
      const applied = yield* handleManagerAttentionAction({
        config,
        body: Effect.succeed({
          project: request.project,
          previewId: preview.previewId,
          revision: preview.revision,
          approved: true,
        }),
        method: 'POST',
        url: new URL('http://localhost/api/context-health/semantic/apply'),
      });
      expect(applied?.status).toBe(200);
      expect(applied?.body).toHaveProperty('result.status', 'applied');
    }).pipe(provideTestLayer(reviewLayer)),
  );
});
