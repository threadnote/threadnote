import {Array as EffectArray, Option as EffectOption, Predicate, String as EffectString} from 'effect';
import {
  observeSelectedMaintenanceCase,
  refreshContextMaintenanceCase,
} from '../../src/memory/context/maintenance_refresh.js';
import type {MaintenanceState} from '../../src/memory/context/maintenance_contracts.js';
import {SourceConfigurationStore} from '@threadnote/integration-core/config';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, FileSystem, Path, Result, Layer} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryRecord,
} from '@threadnote/memory/document';
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
import {readContextMaintenanceStatus, withStateLock} from '../../src/memory/context/maintenance.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {writeSemanticReviewState} from '../../src/memory/context/semantic_review_state.js';
import {
  previewSemanticReview,
  applySemanticReview,
  buildSemanticReviewPreview,
  refreshSemanticComparison,
} from '../../src/memory/context/semantic_review.js';
import * as EffectRecord from 'effect/Record';
import * as Effect2 from 'effect';
import * as EffectString2 from 'effect/String';

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
type SemanticReviewInput = ReturnType<typeof input>;
function parseSemanticReviewInput(value: unknown): SemanticReviewInput {
  if (!Predicate.isObject(value) || typeof value.project !== 'string' || typeof value.contradictionId !== 'string')
    throw new Error('Semantic review request identity is malformed.');
  if (value.choice !== 'left' && value.choice !== 'right' && value.choice !== 'both')
    throw new Error('Semantic review choice is malformed.');
  const side = (candidate: unknown) => {
    if (
      !Predicate.isObject(candidate) ||
      typeof candidate.recordUri !== 'string' ||
      typeof candidate.recordContentFingerprint !== 'string'
    )
      throw new Error('Semantic review source identity is malformed.');
    return {recordUri: candidate.recordUri, recordContentFingerprint: candidate.recordContentFingerprint};
  };
  return {
    project: value.project,
    contradictionId: value.contradictionId,
    left: side(value.left),
    right: side(value.right),
    choice: value.choice,
  };
}

const reviewLayer = Layer.mergeAll(
  Layer.mock(SourceConfigurationStore, {}),
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
    const filler = EffectArray.join(
      Array.from(
        {length: 17},
        (_, index) => `Worker token${String.fromCharCode(97 + index)} must retain verified context.`,
      ),
      '\n',
    );
    const subject = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        Array.from(
          {length: 100},
          (_, index) =>
            `Deployment policy${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
        ),
        candidate =>
          EffectOption.getOrElse(
            EffectArray.findFirstIndex(
              extractContextHealthSemanticClaims(memory('a-late', `${filler}\n${candidate} must use signed artifacts.`))
                .claims,
              __effectArrayValue =>
                !!(claim => Effect2.pipe(claim.text, EffectString.startsWith(candidate)))(__effectArrayValue),
            ),
            () => -1,
          ) >= 16,
      ),
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
      actualFingerprint: Effect2.pipe('a', EffectString.repeat(64)),
      expectedFingerprint: Effect2.pipe('b', EffectString.repeat(64)),
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
          const reordered = parseSemanticReviewInput(
            EffectRecord.fromEntries(EffectArray.map(keys, key => [key, values[key]])),
          );
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
          EffectOption.getOrUndefined(EffectArray.findFirst(corpus, record => record.uri === preview.keptUri))!.content,
        );
      }).pipe(provideTestLayer(reviewLayer)),
    {fastCheck: {numRuns: 12}},
  );
  it('requires an explicit choice and both exact current source revisions', () => {
    const missingChoice = {...input(), choice: undefined};
    expect(() =>
      buildSemanticReviewPreview(
        // @ts-expect-error This regression case deliberately omits the required reviewer choice.
        missingChoice,
        records,
        'tester',
      ),
    ).toThrow(/choice/iu);
    for (const name of ['a', 'b']) {
      expect(() =>
        buildSemanticReviewPreview(
          input(),
          EffectArray.map(records, record =>
            Effect2.pipe(record.uri, EffectString.endsWith(`${name}.md`))
              ? memory(name, `${record.body}\nChanged.`)
              : record,
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
          `\n${EffectOption.getOrUndefined(EffectArray.findFirst(records, record => record.uri === preview.keptUri))!.content}\n`,
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
    expect(EffectArray.join(preview.constraints, ' ')).toMatch(/entire|policy|applicability/iu);
    expect([preview.keptContent, preview.archivedContent].sort()).toEqual(
      EffectArray.map(records, record => record.body).sort(),
    );
    expect(buildSemanticReviewPreview(input('both'), records, 'tester').mode).toBe('keep-both');
  });
  it('blocks storage-unsafe records without choosing a winner', () => {
    const unsafeMetadataPatches: readonly Partial<MemoryMetadata>[] = [
      {visibility: 'shared'},
      {consolidationError: 'broken'},
      {citationErrors: [{reason: 'invalid-shape'}]},
    ];
    for (const patch of unsafeMetadataPatches) {
      const changed = EffectArray.map(records, record => ({
        ...record,
        metadata: {...record.metadata, ...patch},
      }));
      expect(buildSemanticReviewPreview(input(), changed, 'tester').mode).toBe('review-only');
    }
    const future = EffectArray.map(records, record => ({
      ...record,
      content: Effect2.pipe(record.content, EffectString.replace('schema_version: 2', 'schema_version: 999')),
    }));
    expect(buildSemanticReviewPreview(input('left', future), future, 'tester').mode).toBe('review-only');
  });
  effectIt.effect('refreshes one exact semantic case through the Manager route and refuses a different project', () =>
    Effect.gen(function* () {
      const {config, store, location} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const finding = buildContextHealthReport({project: 'threadnote', records, now: NOW}).findings[0];
      const item = {
        ...finding.caseIdentity!,
        caseId: finding.caseId!,
        evidenceRevision: 'unrelated-scan-generation',
        disposition: 'needs-decision',
        reason: 'opposing-canonical-claims',
        firstSeen: 'now',
        lastSeen: 'now',
        lastChecked: 'now',
        attemptCount: 1,
        events: [],
        subjectContentHashes: EffectArray.map(records, record => ({
          uri: record.uri,
          hash: sha256HexSync(canonicalMemoryDocumentContent(record.content)),
        })),
      };
      const directory = path.join(config.agentContextHome, 'context-maintenance');
      yield* fs.makeDirectory(directory, {recursive: true});
      const file = path.join(directory, 'state-v2.json');
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          version: 2,
          paused: false,
          state: 'needs-decision',
          generation: 'scan',
          projects: [],
          receipts: [],
          cases: [item],
          checkpoints: {},
        }),
      );
      const before = yield* fs.readFileString(file);
      const request = (project: string) =>
        handleManagerAttentionAction({
          config,
          method: 'POST',
          url: new URL('http://manager.test/api/attention/context-maintenance'),
          body: Effect.succeed({action: 'refresh-case', project, caseId: item.caseId}),
        });
      const refused = yield* request('another-project');
      expect(refused?.body).toMatchObject({outcome: 'unavailable'});
      expect(yield* fs.readFileString(file)).toBe(before);
      const result = yield* request('threadnote');
      expect(result?.status).toBe(200);
      expect(result?.body).toMatchObject({
        outcome: 'ready',
        item: {caseId: item.caseId},
        packet: {caseId: item.caseId, semanticEvidence: {contradictionId: finding.semanticEvidence!.contradictionId}},
      });
      expect(yield* fs.readFileString(file)).toBe(before);
      const changed = memory('a', 'Timeout is 90 seconds.');
      yield* store.write(location, changed.uri, changed.content, {mode: 'replace'});
      const updated = yield* request('threadnote');
      expect(updated?.body).toMatchObject({outcome: 'ready'});
      const refreshedBody: unknown = updated?.body;
      if (
        !Predicate.isObject(refreshedBody) ||
        !Predicate.isObject(refreshedBody.item) ||
        !Predicate.isObject(refreshedBody.packet) ||
        !Predicate.isObject(refreshedBody.packet.semanticEvidence) ||
        !Predicate.isObject(refreshedBody.packet.semanticEvidence.left) ||
        !Predicate.isObject(refreshedBody.packet.semanticEvidence.right) ||
        typeof refreshedBody.packet.semanticEvidence.left.text !== 'string' ||
        typeof refreshedBody.packet.semanticEvidence.right.text !== 'string'
      ) {
        throw new Error('Expected refreshed semantic evidence in the successful response.');
      }
      expect(refreshedBody.item.caseId).not.toBe(item.caseId);
      expect(
        EffectArray.join(
          [refreshedBody.packet.semanticEvidence.left.text, refreshedBody.packet.semanticEvidence.right.text],
          ' ',
        ),
      ).toContain('90');
      expect(yield* store.read(location, changed.uri)).toBe(changed.content);
    }).pipe(provideTestLayer(reviewLayer)),
  );

  effectIt.effect('applies an exact keep-both preview after an unrelated corpus mutation', () =>
    Effect.gen(function* () {
      const {config, store, location} = yield* fixture();
      const preview = yield* previewSemanticReview(config, input('both'));
      const unrelated = memory('unrelated', 'Keep an independent deployment note.');
      yield* store.write(location, unrelated.uri, unrelated.content, {mode: 'create'});
      yield* store.write(location, unrelated.uri, unrelated.content + '\nIndependent update.', {mode: 'replace'});
      const approved = {
        project: 'threadnote',
        previewId: preview.previewId,
        revision: preview.revision,
        approved: true,
      };
      expect((yield* applySemanticReview(config, approved)).status).toBe('applied');
      expect((yield* applySemanticReview(config, approved)).status).toBe('already-applied');
      for (const source of records) expect(yield* store.read(location, source.uri)).toBe(source.content);
    }).pipe(provideTestLayer(reviewLayer)),
  );

  effectIt.effect('records keep-both locally for shared sources without changing or publishing them', () =>
    Effect.gen(function* () {
      const corpus = EffectArray.map(records, record =>
        parseMemoryDocument(
          Effect2.pipe(record.uri, EffectString.replace('/durable/projects/', '/shared/default/durable/projects/')),
          formatMemoryDocument('MEMORY', {...record.metadata, visibility: 'shared'}, record.body),
        )!,
      );
      const {config, store, location} = yield* fixture(corpus);
      const preview = yield* previewSemanticReview(config, input('both', corpus));
      expect(preview.mode).toBe('keep-both');
      expect(EffectArray.join(preview.constraints, ' ')).toContain('local');
      const approval = {
        project: 'threadnote',
        previewId: preview.previewId,
        revision: preview.revision,
        approved: true,
      };
      expect((yield* applySemanticReview(config, approval)).status).toBe('applied');
      expect((yield* applySemanticReview(config, approval)).status).toBe('already-applied');
      expect(yield* reviewedSemanticContradictionIds(config, 'threadnote', corpus)).toEqual([
        input('both', corpus).contradictionId,
      ]);
      const state = yield* readSemanticReviewState(config);
      expect(state.entries[0].archiveUri).toBeUndefined();
      expect(state.entries[0].archiveContent).toBeUndefined();
      for (const record of corpus) expect(yield* store.read(location, record.uri)).toBe(record.content);
      for (const choice of ['left', 'right'] as const) {
        const blocked = yield* previewSemanticReview(config, input(choice, corpus));
        expect(blocked.mode).toBe('review-only');
        expect(blocked.constraints).toEqual([...new Set(blocked.constraints)]);
        expect(blocked.constraints).not.toContain(blocked.reason);
        expect(
          Result.isFailure(
            yield* applySemanticReview(config, {
              ...approval,
              previewId: blocked.previewId,
              revision: blocked.revision,
            }).pipe(Effect.result),
          ),
        ).toBe(true);
      }
      yield* store.write(location, corpus[0].uri, `${corpus[0].content}\nSource changed.`, {mode: 'replace'});
      expect(yield* reviewedSemanticContradictionIds(config, 'threadnote', corpus)).toEqual([]);
      expect(Result.isFailure(yield* applySemanticReview(config, approval).pipe(Effect.result))).toBe(true);
    }).pipe(provideTestLayer(reviewLayer)),
  );
  it('keeps source-preserving review independent of ownership while preserving project, lifecycle and revision checks', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('personal', 'shared', 'other-owner'), {minLength: 2, maxLength: 2}),
        kinds => {
          const corpus = EffectArray.map(records, (record, index) =>
            parseMemoryDocument(
              kinds[index] === 'shared'
                ? Effect2.pipe(
                    record.uri,
                    EffectString.replace('/durable/projects/', '/shared/default/durable/projects/'),
                  )
                : kinds[index] === 'other-owner'
                  ? Effect2.pipe(record.uri, EffectString.replace('/tester/', '/someone-else/'))
                  : record.uri,
              formatMemoryDocument(
                'MEMORY',
                {
                  ...record.metadata,
                  ...(kinds[index] === 'shared' ? {visibility: 'shared' as const} : {}),
                },
                record.body,
              ),
            )!,
          );
          const request = input('both', corpus);
          const snapshot = JSON.stringify(corpus);
          expect(buildSemanticReviewPreview(request, corpus, 'tester').mode).toBe('keep-both');
          expect(JSON.stringify(corpus)).toBe(snapshot);
          const lifecyclePatches: readonly Partial<MemoryMetadata>[] = [
            {project: 'another-project'},
            {status: 'archived'},
          ];
          for (const patch of lifecyclePatches) {
            expect(() =>
              buildSemanticReviewPreview(
                request,
                [{...corpus[0], metadata: {...corpus[0].metadata, ...patch}}, corpus[1]],
                'tester',
              ),
            ).toThrow(/changed|active/iu);
          }
          expect(() =>
            buildSemanticReviewPreview(
              request,
              [{...corpus[0], content: corpus[0].content + '\n'}, corpus[1]],
              'tester',
            ),
          ).toThrow(/changed/iu);
        },
      ),
      {numRuns: 24},
    );
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
          EffectOption.getOrUndefined(EffectArray.findFirst(records, record => record.uri === preview.keptUri))!
            .content,
        );
        const history = parseMemoryDocument(result.archivedUri!, yield* store.read(location, result.archivedUri!))!;
        const original = EffectOption.getOrUndefined(
          EffectArray.findFirst(records, record => record.uri === preview.archivedUri),
        )!;
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
          EffectArray.filter(
            buildContextHealthReport({
              project: 'threadnote',
              records,
              now: NOW,
              reviewedSemanticContradictionIds: ids,
            }).findings,
            finding => finding.semanticEvidence !== undefined,
          ),
        ).toEqual([]);
        const finding = EffectOption.getOrUndefined(
          EffectArray.findFirst(
            buildContextHealthReport({project: 'threadnote', records, now: NOW}).findings,
            finding => finding.semanticEvidence !== undefined,
          ),
        );
        if (finding === undefined) throw new Error('Expected semantic contradiction finding.');
        const caseIdentity = finding.caseIdentity;
        const caseId = finding.caseId;
        if (caseIdentity === undefined || caseId === undefined) throw new Error('Expected semantic case identity.');
        const item = {
          ...caseIdentity,
          caseId,
          evidenceRevision: 'original',
          disposition: 'needs-decision' as const,
          reason: 'original',
          firstSeen: '2026-06-01',
          lastSeen: '2026-06-01',
          lastChecked: '2026-06-01',
          attemptCount: 0,
          events: [{at: '2026-06-01', reason: 'original'}],
          subjectContentHashes: EffectArray.map(records, record => ({
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
          JSON.stringify({
            version: 2,
            paused: false,
            state: 'idle',
            generation: '',
            projects: [],
            checkpoints: {},
            receipts: [],
            cases: [item],
          } satisfies MaintenanceState),
        );
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(
              (yield* readContextMaintenanceStatus(config, 'threadnote')).cases,
              current => current.caseId === item.caseId,
            ),
          )?.disposition,
        ).toBe('resolved');
        yield* applySemanticReview(config, apply);
        const persisted = JSON.parse(yield* fs.readFileString(stateFile));
        expect(persisted.cases[0]).toMatchObject({disposition: 'resolved', reason: 'human-reviewed-keep-both'});
        yield* store.write(location, records[0].uri, `${records[0].content}\n`, {mode: 'replace'});
        expect(yield* reviewedSemanticContradictionIds(config, 'threadnote', records)).toEqual([]);
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(
              (yield* readContextMaintenanceStatus(config, 'threadnote')).cases,
              current => current.caseId === item.caseId,
            ),
          )?.disposition,
        ).toBe('needs-decision');
        yield* store.write(location, records[0].uri, records[0].content, {mode: 'replace'});
        yield* writeSemanticReviewState(config, {
          ...journal,
          entries: EffectArray.map(journal.entries, entry => ({...entry, rawSources: undefined})),
        });
        expect(yield* reviewedSemanticContradictionIds(config, 'threadnote', records)).toEqual([]);
        expect(
          EffectOption.getOrUndefined(
            EffectArray.findFirst(
              (yield* readContextMaintenanceStatus(config, 'threadnote')).cases,
              current => current.caseId === item.caseId,
            ),
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
                    Effect2.pipe(changed.uri, EffectString.endsWith('/a.md')) ? 'a.md' : 'b.md',
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
          repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
          repositoryIdentityKind: 'local',
          sourceCommit: Effect2.pipe('c', EffectString.repeat(40)),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
          extractorSet: 'test',
          path: 'source.ts',
          fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString.repeat(64))},
          target: {kind: 'file'},
        });
        const corpus = EffectArray.map(records, record =>
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
        const original = EffectOption.getOrUndefined(
          EffectArray.findFirst(corpus, record => record.uri === preview.archivedUri),
        )!;
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
          entries: EffectArray.map(saved.entries, entry => ({...entry, applied: false})),
        });
        expect((yield* applySemanticReview(config, approval)).status).toBe('already-applied');
        expect(yield* store.read(location, preview.keptUri!)).toBe(
          EffectOption.getOrUndefined(EffectArray.findFirst(corpus, record => record.uri === preview.keptUri))!.content,
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
      if (
        reordered?.status !== 200 ||
        !Predicate.isObject(reordered.body) ||
        !Predicate.hasProperty(reordered.body, 'preview') ||
        !Predicate.isObject(reordered.body.preview)
      )
        throw new Error('Expected a semantic review preview response.');
      const previewValue = reordered.body.preview;
      if (typeof previewValue.previewId !== 'string' || typeof previewValue.revision !== 'string')
        throw new Error('Semantic review preview approval is malformed.');
      const preview = {previewId: previewValue.previewId, revision: previewValue.revision};
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

effectIt.effect('fences both terminal semantic and removed-citation supersessions against a canonical edit', () =>
  Effect.gen(function* () {
    for (const family of ['semantic-contradiction', 'citation'] as const) {
      const citation = createMemoryCodeCitation({
        version: 1,
        repositoryId: Effect2.pipe('b', EffectString2.repeat(64)),
        repositoryIdentityKind: 'local',
        sourceCommit: Effect2.pipe('c', EffectString2.repeat(40)),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${Effect2.pipe('d', EffectString2.repeat(40))}`,
        extractorSet: 'test',
        path: 'source.ts',
        fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('a', EffectString2.repeat(64))},
        target: {kind: 'file'},
      });
      const original =
        family === 'semantic-contradiction'
          ? records[0]
          : parseMemoryDocument(
              records[0].uri,
              formatMemoryDocument(
                'MEMORY',
                {...records[0].metadata, schemaVersion: 11, codeCitations: [citation]},
                records[0].body,
              ),
            )!;
      const selected = family === 'semantic-contradiction' ? [original, records[1]] : [original];
      const {config, store, location} = yield* fixture(selected);
      const fs = yield* FileSystem.FileSystem;
      const finding = buildContextHealthReport({project: 'threadnote', records, now: NOW}).findings[0];
      const item = {
        ...finding.caseIdentity!,
        family,
        caseId: finding.caseId!,
        memoryId: original.metadata.memoryId!,
        ...(family === 'citation' ? {citationId: citation.id, slot: 'selected-anchor'} : {}),
        evidenceRevision: 'saved',
        disposition: 'needs-decision' as const,
        reason: 'selected-source',
        firstSeen: 'now',
        lastSeen: 'now',
        lastChecked: 'now',
        attemptCount: 1,
        events: [],
        subjectContentHashes: EffectArray.map(selected, record => ({
          uri: record.uri,
          hash: sha256HexSync(canonicalMemoryDocumentContent(record.content)),
        })),
      };
      const state: MaintenanceState = {
        version: 2,
        paused: false,
        state: 'needs-decision',
        generation: 'saved',
        projects: [],
        receipts: [],
        cases: [item],
        checkpoints: {},
      };
      const captured =
        family === 'semantic-contradiction' ? memory('a', 'Timeout is 30 seconds.') : memory('a', records[0].body);
      yield* store.write(location, original.uri, captured.content, {mode: 'replace'});
      let openings = 0;
      const racingFs = {
        ...fs,
        readFileString: (...args: Parameters<typeof fs.readFileString>) =>
          fs
            .readFileString(...args)
            .pipe(
              Effect.tap(() =>
                Effect2.pipe(args[0], EffectString2.endsWith('/a.md')) && openings++ === 0
                  ? fs.writeFileString(args[0], original.content)
                  : Effect.void,
              ),
            ),
      };
      const observed = yield* observeSelectedMaintenanceCase(config, state, item, config.agentContextHome).pipe(
        Effect.provideService(FileSystem.FileSystem, racingFs),
      );
      expect(observed.outcome).toBe('changing');
      expect('state' in observed).toBe(false);
      expect(yield* store.read(location, original.uri)).toBe(original.content);
      expect(state.cases[0].disposition).toBe('needs-decision');
    }
  }).pipe(provideTestLayer(reviewLayer)),
);

const refreshInput = () => {
  const evidence = findContextHealthSemanticContradiction(records)!;
  return {
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
  };
};

effectIt.effect(
  'refreshes a projected health comparison with no maintenance state while its writer owns the lock',
  () =>
    Effect.gen(function* () {
      const {config, store, location} = yield* fixture();
      const acquired = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* withStateLock(
        config,
        Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(acquired);
      const request = (body: Record<string, unknown>) =>
        handleManagerAttentionAction({
          config,
          method: 'POST',
          url: new URL('http://manager.test/api/context-health/semantic/refresh'),
          body: Effect.succeed(body),
        });
      const result = yield* request(refreshInput());
      expect(result).toMatchObject({
        status: 200,
        body: {outcome: 'ready', evidence: {contradictionId: refreshInput().contradictionId}},
      });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.exists(path.join(config.agentContextHome, 'context-maintenance', 'state-v2.json'))).toBe(false);
      const unrelated = memory('unrelated', 'Independent metadata note.');
      yield* store.write(location, unrelated.uri, unrelated.content, {mode: 'create'});
      expect(yield* request(refreshInput())).toEqual(result);
      expect(yield* store.read(location, records[0].uri)).toBe(records[0].content);
      expect(yield* store.read(location, records[1].uri)).toBe(records[1].content);
      yield* Deferred.succeed(release, undefined);
    }).pipe(provideTestLayer(reviewLayer)),
);

effectIt.effect(
  'rejects fabricated claim bindings, foreign projects and missing sources during direct comparison refresh',
  () =>
    Effect.gen(function* () {
      const {config} = yield* fixture();
      const selected = refreshInput();
      const request = (body: Record<string, unknown>) =>
        handleManagerAttentionAction({
          config,
          method: 'POST',
          url: new URL('http://manager.test/api/context-health/semantic/refresh'),
          body: Effect.succeed(body),
        });
      for (const patch of [
        {left: {...selected.left, claimFingerprint: Effect2.pipe('f', EffectString2.repeat(64))}},
        {
          left: {...selected.left, recordUri: selected.right.recordUri},
          right: {...selected.right, recordUri: selected.left.recordUri},
        },
        {contradictionId: Effect2.pipe('f', EffectString2.repeat(64))},
      ])
        expect((yield* request({...selected, ...patch}))?.status).toBe(400);
      expect((yield* request({...selected, project: 'other'}))?.body).toMatchObject({outcome: 'unavailable'});
      expect(
        (yield* request({
          ...selected,
          left: {
            ...selected.left,
            recordUri: Effect2.pipe(records[0].uri, EffectString2.replace('a.md', 'missing.md')),
          },
        }))?.status,
      ).toBe(404);
      expect(
        (yield* request({
          ...selected,
          left: {
            ...selected.left,
            recordUri: Effect2.pipe(records[0].uri, EffectString2.replace('/tester/', '/foreign/')),
          },
        }))?.status,
      ).toBe(403);
      const swapped = yield* request({...selected, left: selected.right, right: selected.left});
      expect(swapped?.body).toMatchObject({outcome: 'ready'});
    }).pipe(provideTestLayer(reviewLayer)),
);

effectIt.effect('reconstructs changed current statements and detects raw-source races without writing decisions', () =>
  Effect.gen(function* () {
    const {config, store, location} = yield* fixture();
    const changed = memory('a', 'Timeout is 90 seconds.');
    yield* store.write(location, changed.uri, changed.content, {mode: 'replace'});
    const result = yield* refreshSemanticComparison(config, refreshInput());
    expect(result).toMatchObject({outcome: 'ready'});
    if (result.outcome === 'ready') {
      expect(EffectArray.join([result.evidence.left.text, result.evidence.right.text], ' ')).toContain('90');
      expect(result.evidence.contradictionId).not.toBe(refreshInput().contradictionId);
    }
    let reads = 0;
    const racing = ResourceStore.of({
      ...store,
      readBounded: (location, uri, limit) =>
        Effect.gen(function* () {
          const source = yield* store.readBounded(location, uri, limit);
          if (++reads === 2)
            yield* store.write(location, changed.uri, changed.content + '\nIndependent source edit.', {
              mode: 'replace',
            });
          return source;
        }),
    });
    expect(
      (yield* refreshSemanticComparison(config, refreshInput()).pipe(Effect.provideService(ResourceStore, racing)))
        .outcome,
    ).toBe('changing');
  }).pipe(provideTestLayer(reviewLayer)),
);

const boundedSemanticRefreshCases = [
  {
    name: 'body limit hides a still-present selected conflict',
    reason: 'body-limit',
    count: 0,
    left: '```\n' + Effect2.pipe('x', EffectString2.repeat(65_536)) + '\n```\nTimeout is 60 seconds.',
    right: records[1].body,
  },
  {
    name: 'claim limit hides a still-present selected conflict',
    reason: 'claim-limit',
    count: 0,
    left:
      EffectArray.join(
        Array.from({length: 23}, (_, index) => `Queue${index} is ${10 + index} seconds.`),
        '\n',
      ) + '\nTimeout is 60 seconds.',
    right: records[1].body,
  },
  {
    name: 'partial extraction exposes one different comparison without proving uniqueness',
    reason: 'claim-limit',
    count: 1,
    left:
      'Retries is 60 seconds.\n' +
      EffectArray.join(
        Array.from({length: 21}, (_, index) => `Queue${index} is ${10 + index} seconds.`),
        '\n',
      ) +
      '\nTimeout is 60 seconds.',
    right: 'Retries must be 30 seconds.\nTimeout must be 30 seconds.',
  },
];
for (const scenario of boundedSemanticRefreshCases) {
  effectIt.effect(`F007 retains a blocked comparison when ${scenario.name}`, () =>
    Effect.gen(function* () {
      const changed = [memory('a', scenario.left), memory('b', scenario.right)];
      const report = buildContextHealthReport({
        project: 'threadnote',
        records: changed,
        includeFindingCategories: ['semantic-contradiction'],
        now: NOW,
      });
      expect(report.semanticCompleteness.state).not.toBe('complete');
      expect(EffectArray.map(report.semanticCompleteness.unknownReasons, value => value.reason)).toContain(
        scenario.reason,
      );
      expect(EffectArray.filter(report.findings, value => Boolean(value.semanticEvidence))).toHaveLength(
        scenario.count,
      );
      expect(changed[0].body).toContain(records[0].body);
      expect(changed[1].body).toContain(records[1].body);
      const {config, store, location} = yield* fixture();
      for (const record of changed) yield* store.write(location, record.uri, record.content, {mode: 'replace'});
      const result = yield* refreshSemanticComparison(config, refreshInput());
      expect(result).toMatchObject({outcome: 'incomplete'});
      expect('reason' in result && result.reason).toContain('bounded');
      for (const record of changed) expect(yield* store.read(location, record.uri)).toBe(record.content);
    }).pipe(provideTestLayer(reviewLayer)),
  );
}

fcEffectProp(
  effectIt,
  'F007 never promotes a claim-limited current pair to absent or uniquely ready under bounded source permutations',
  {extraClaims: fc.integer({min: 17, max: 48}), reverse: fc.boolean()},
  ({extraClaims, reverse}) =>
    Effect.gen(function* () {
      const fillers = Array.from({length: extraClaims}, (_, index) => `Queue${index} is ${10 + index} seconds.`);
      const changed = memory(
        'a',
        EffectArray.join(reverse ? fillers.reverse() : fillers, '\n') + '\n' + records[0].body,
      );
      const {config, store, location} = yield* fixture();
      yield* store.write(location, changed.uri, changed.content, {mode: 'replace'});
      expect((yield* refreshSemanticComparison(config, refreshInput())).outcome).toBe('incomplete');
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const {item, state} = retainedSemanticState();
      const stateFile = path.join(config.agentContextHome, 'context-maintenance', 'state-v2.json');
      yield* fs.makeDirectory(path.dirname(stateFile), {recursive: true});
      const encoded = JSON.stringify(state);
      yield* fs.writeFileString(stateFile, encoded);
      expect(
        (yield* refreshContextMaintenanceCase(config, {
          project: 'threadnote',
          caseId: item.caseId,
          cwd: config.agentContextHome,
        })).outcome,
      ).toBe('incomplete');
      expect(yield* fs.readFileString(stateFile)).toBe(encoded);
      expect(yield* store.read(location, changed.uri)).toBe(changed.content);
      expect(yield* store.read(location, records[1].uri)).toBe(records[1].content);
    }).pipe(provideTestLayer(reviewLayer)),
  {fastCheck: {numRuns: 8, seed: 80407}},
);

function retainedSemanticState() {
  const finding = buildContextHealthReport({project: 'threadnote', records, now: NOW}).findings[0];
  const item = {
    ...finding.caseIdentity!,
    caseId: finding.caseId!,
    evidenceRevision: 'saved',
    disposition: 'needs-decision' as const,
    reason: 'opposing-canonical-claims',
    firstSeen: 'now',
    lastSeen: 'now',
    lastChecked: 'now',
    attemptCount: 1,
    events: [],
    subjectContentHashes: EffectArray.map(records, record => ({
      uri: record.uri,
      hash: sha256HexSync(canonicalMemoryDocumentContent(record.content)),
    })),
  };
  const state: MaintenanceState = {
    version: 2,
    paused: false,
    state: 'needs-decision',
    generation: 'saved',
    projects: [],
    receipts: [],
    cases: [
      item,
      {...item, caseId: 'unrelated-retained-case', family: 'citation', slot: 'unrelated-anchor', memoryId: 'unrelated'},
    ],
    checkpoints: {},
  };
  return {item, state};
}
for (const scenario of boundedSemanticRefreshCases) {
  effectIt.effect(`F007 retained maintenance case does not persist absence or uniqueness when ${scenario.name}`, () =>
    Effect.gen(function* () {
      const {config, store, location} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const {item, state} = retainedSemanticState();
      const stateFile = path.join(config.agentContextHome, 'context-maintenance', 'state-v2.json');
      yield* fs.makeDirectory(path.dirname(stateFile), {recursive: true});
      const encoded = JSON.stringify(state);
      yield* fs.writeFileString(stateFile, encoded);
      const changed = [memory('a', scenario.left), memory('b', scenario.right)];
      for (const record of changed) yield* store.write(location, record.uri, record.content, {mode: 'replace'});
      const result = yield* refreshContextMaintenanceCase(config, {
        project: 'threadnote',
        caseId: item.caseId,
        cwd: config.agentContextHome,
      });
      expect(result).toMatchObject({outcome: 'incomplete'});
      expect('state' in result).toBe(false);
      expect('item' in result).toBe(false);
      expect(yield* fs.readFileString(stateFile)).toBe(encoded);
      for (const record of changed) expect(yield* store.read(location, record.uri)).toBe(record.content);
    }).pipe(provideTestLayer(reviewLayer)),
  );
}

effectIt.effect(
  'F007 retained incomplete analysis obeys the closing raw-source race fence before returning or persisting',
  () =>
    Effect.gen(function* () {
      const {config, store, location} = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const {item, state} = retainedSemanticState();
      const stateFile = path.join(config.agentContextHome, 'context-maintenance', 'state-v2.json');
      yield* fs.makeDirectory(path.dirname(stateFile), {recursive: true});
      const encoded = JSON.stringify(state);
      yield* fs.writeFileString(stateFile, encoded);
      const changed = memory('a', boundedSemanticRefreshCases[0].left);
      yield* store.write(location, changed.uri, changed.content, {mode: 'replace'});
      let openings = 0;
      const racingFs = {
        ...fs,
        readFileString: (...args: Parameters<typeof fs.readFileString>) =>
          fs
            .readFileString(...args)
            .pipe(
              Effect.tap(() =>
                Effect2.pipe(args[0], EffectString2.endsWith('/a.md')) && openings++ === 0
                  ? fs.writeFileString(args[0], records[0].content)
                  : Effect.void,
              ),
            ),
      };
      const observed = yield* observeSelectedMaintenanceCase(config, state, item, config.agentContextHome).pipe(
        Effect.provideService(FileSystem.FileSystem, racingFs),
      );
      expect(observed.outcome).toBe('changing');
      expect('state' in observed).toBe(false);
      expect(yield* fs.readFileString(stateFile)).toBe(encoded);
      expect(yield* store.read(location, records[0].uri)).toBe(records[0].content);
      yield* store.write(location, changed.uri, changed.content, {mode: 'replace'});
      openings = 0;
      const refreshed = yield* refreshContextMaintenanceCase(config, {
        project: 'threadnote',
        caseId: item.caseId,
        cwd: config.agentContextHome,
      }).pipe(Effect.provideService(FileSystem.FileSystem, racingFs));
      expect(refreshed.outcome).toBe('ready');
      expect(openings).toBeGreaterThanOrEqual(3);
      expect(yield* fs.readFileString(stateFile)).toBe(encoded);
    }).pipe(provideTestLayer(reviewLayer)),
);
