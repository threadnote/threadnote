import {it as effectIt} from '@effect/vitest';
import {DateTime, Effect, FileSystem, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  readContextMaintenanceStatus,
  runContextMaintenance,
  safeRelationRemoval,
  selectFairMaintenanceWork,
  setContextMaintenancePaused,
  undoContextMaintenance,
  updateMaintenanceCase,
  duplicateArchiveSafe,
  migrateMaintenanceCases,
  readContextMaintenancePacket,
} from '@threadnote/threadnote/memory/context/maintenance';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {readMaintenanceMemoryRecords} from '@threadnote/threadnote/memory/maintenance/records';
import {collectContextHealth} from '@threadnote/threadnote/memory/context/health_commands';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {prepareContextMaintenanceInventory} from '@threadnote/threadnote/memory/context/maintenance_inventory';
import {buildCandidateReview, candidateReviewWithState, saveCandidateReview} from '@threadnote/memory/candidate';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {selectMaintenanceSemanticPairBatch} from '@threadnote/threadnote/memory/context/maintenance_decisions';
import {captureCitationReplacements} from '@threadnote/threadnote/memory/context/health_repair_commands';
import {buildContextHealthReport} from '@threadnote/context/health';
import {readContextMaintenanceEvidenceRequests} from '@threadnote/threadnote/memory/context/maintenance_evidence';

const NOW = '2026-10-03T15:00:00.000Z';
const URI = 'threadnote://user/tester/memories/durable/projects/threadnote/source.md';
function record(topic: string, metadata: Partial<MemoryMetadata> = {}, body = 'Keep useful context.') {
  const uri = URI.replace('source.md', `${topic}.md`);
  return parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        schemaVersion: 2,
        memoryId: `tn_${topic}`,
        project: 'threadnote',
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: NOW,
        topic,
        ...metadata,
      },
      body,
    ),
  )!;
}

describe('persistent context maintenance', () => {
  effectIt.effect('bounds a scoped one-record tick independently of two thousand unrelated cited records', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const unrelated = fixture.path.join(fixture.directory, '..', 'unrelated');
      yield* fixture.fs.makeDirectory(unrelated, {recursive: true});
      const citation = createMemoryCodeCitation({
        version: 1,
        repositoryId: 'b'.repeat(64),
        repositoryIdentityKind: 'local',
        sourceCommit: 'c'.repeat(40),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
        extractorSet: 'typescript-v1',
        path: 'unrelated.ts',
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        target: {kind: 'file'},
      });
      yield* Effect.forEach(
        Array.from({length: 2_000}, (_, index) => `unrelated-${index}`),
        topic =>
          fixture.fs.writeFileString(
            fixture.path.join(unrelated, `${topic}.md`),
            record(topic, {project: 'unrelated', schemaVersion: 5, codeCitations: [citation]}).content,
          ),
        {concurrency: 64, discard: true},
      );
      yield* fixture.fs.writeFileString(fixture.source, record('source').content);
      let reads = 0;
      let unrelatedReads = 0;
      const recording = FileSystem.FileSystem.of({
        ...fixture.fs,
        readFileString: (file, encoding) => {
          reads++;
          if (file.startsWith(unrelated)) unrelatedReads++;
          return fixture.fs.readFileString(file, encoding);
        },
      });
      const result = yield* runContextMaintenance(fixture.config, {
        cwd: fixture.home,
        project: 'threadnote',
        maxRecords: 1,
      }).pipe(Effect.provideService(FileSystem.FileSystem, recording));
      expect(result.projects[0].checked).toBe(1);
      expect(unrelatedReads).toBe(0);
      expect(reads).toBeLessThan(20);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rebuilds a malformed persisted inventory without treating it as authoritative absence', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.fs.writeFileString(fixture.source, record('source').content);
      yield* prepareContextMaintenanceInventory(fixture.config, undefined, 256);
      const cache = fixture.path.join(fixture.home, 'context-maintenance', 'inventory', `${sha256HexSync('*')}.json`);
      yield* fixture.fs.writeFileString(
        cache,
        JSON.stringify({
          version: 1,
          complete: true,
          entries: null,
          queue: [],
          mutationGeneration: '',
          refreshCursor: 0,
        }),
      );
      const rebuilt = yield* prepareContextMaintenanceInventory(fixture.config, undefined, 1);
      expect(rebuilt.complete).toBe(false);
      expect(rebuilt.records).toHaveLength(0);
      expect(yield* fixture.fs.exists(fixture.source)).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps fresh changed-citation packets and no-op progress against a real ready graph', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const repository = fixture.path.join(fixture.home, 'repository');
      yield* fixture.fs.makeDirectory(repository);
      const file = fixture.path.join(repository, 'source.ts');
      yield* fixture.fs.writeFileString(file, 'export const supported = true;\n');
      const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
      yield* git(['init', '--quiet']);
      yield* git(['add', '.']);
      yield* git([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'source',
      ]);
      yield* fixture.fs.writeFileString(
        fixture.config.manifestPath,
        `version: 1\nprojects:\n  - name: threadnote\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/threadnote\n    seed: []\n`,
      );
      const indexer = yield* CodeGraphIndexer;
      yield* indexer.index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      const citations = yield* captureMemoryCodeCitations(fixture.config, {
        callerCwd: repository,
        project: 'threadnote',
        refs: ['source.ts'],
      });
      const source = record('source', {schemaVersion: 5, codeCitations: citations});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(file, 'export const supported = false;\n');
      yield* indexer.index({cwd: repository, threadnoteHome: fixture.home, ensureVectors: false});
      const first = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
      const changed = first.cases.find(item => item.family === 'citation' && item.disposition === 'needs-decision');
      expect(changed, JSON.stringify(first)).toBeDefined();
      expect((yield* readContextMaintenancePacket(fixture.config, changed!.caseId)).caseId).toBe(changed!.caseId);
      const second = yield* runContextMaintenance(fixture.config, {cwd: repository, maxRecords: 1});
      expect(second.cases.find(item => item.caseId === changed!.caseId)?.attemptCount).toBe(changed!.attemptCount);
      expect(second.lastProgressAt).toBe(first.lastProgressAt);
      expect((yield* readContextMaintenancePacket(fixture.config, changed!.caseId)).caseId).toBe(changed!.caseId);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('revisits unchanged records at future review and validity deadlines', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* TestClock.setTime(Date.parse('2040-01-01T00:00:00.000Z'));
      const source = record('source', {reviewAfter: '2040-01-02T00:00:00.000Z', validTo: '2040-01-04T00:00:00.000Z'});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      expect((yield* runContextMaintenance(fixture.config, {cwd: fixture.home})).counts?.decisionMemories).toBe(0);
      yield* TestClock.adjust('2 days');
      const overdue = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(overdue.cases.find(item => item.family === 'review-overdue')?.disposition, JSON.stringify(overdue)).toBe(
        'needs-decision',
      );
      yield* TestClock.adjust('2 days');
      expect((yield* runContextMaintenance(fixture.config, {cwd: fixture.home})).receipts).toHaveLength(1);
      expect(yield* fixture.fs.exists(fixture.source)).toBe(false);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retains revision-bound candidate decisions with and without canonical target records', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const review = yield* buildCandidateReview(
        {
          project: 'threadnote',
          topic: 'candidate-work',
          sourceAgentClient: 'test',
          task: 'Review current claim',
          outcome: 'Pending review',
          evidence: ['apps/threadnote/src/memory/context/maintenance.ts'],
          decisions: ['Use explicit reviewed evidence.'],
        },
        [],
        DateTime.toDateUtc(DateTime.makeUnsafe(NOW)),
      );
      const candidates = [
        {
          ...review.candidates[0],
          comparison: 'contradiction' as const,
          recommendation: 'manual_review' as const,
          targetUri: URI,
        },
        {
          ...review.candidates[0],
          candidateId: `${review.candidates[0].candidateId.slice(0, -1)}a`,
          comparison: 'possible_duplicate' as const,
          recommendation: 'manual_review' as const,
        },
      ];
      const pending = {...review, candidates};
      yield* saveCandidateReview(fixture.home, pending);
      yield* fixture.fs.writeFileString(fixture.source, record('source').content);
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const cases = first.cases.filter(item => item.family === 'candidate');
      expect(cases).toHaveLength(2);
      expect(cases.every(item => item.disposition === 'needs-decision')).toBe(true);
      for (const item of cases) {
        const packet = yield* readContextMaintenancePacket(fixture.config, item.caseId);
        expect('reviewInbox' in packet && packet.reviewInbox?.reviewId).toBe(review.reviewId);
      }
      const resolved = candidateReviewWithState(pending, candidates[0].candidateId, 'rejected');
      yield* saveCandidateReview(fixture.home, resolved);
      const stale = yield* readContextMaintenancePacket(fixture.config, cases[0].caseId).pipe(Effect.result);
      expect(Result.isFailure(stale)).toBe(true);
      const second = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(second.cases.find(item => item.slot === candidates[0].candidateId)?.disposition).toBe('resolved');
      expect(second.cases.find(item => item.slot === candidates[1].candidateId)?.disposition).toBe('needs-decision');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves exact duplicates targeted by active URI or identity dependencies', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source');
      const copyUri = URI.replace('source.md', 'copy.md');
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'copy.md'), source.content);
      for (const [topic, uri] of [
        ['uri-dependent', copyUri],
        ['alias-dependent', 'threadnote://memory/tn_source'],
      ] as const)
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.directory, `${topic}.md`),
          record(topic, {relations: [{type: 'depends_on', uri}]}, `${topic} claim.`).content,
        );
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(result.receipts).toHaveLength(0);
      expect(yield* fixture.fs.exists(fixture.path.join(fixture.directory, 'copy.md'))).toBe(true);
      expect(yield* fixture.fs.exists(fixture.source)).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('rejects a duplicate dependency introduced after preparation before the locked archive', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source');
      const copyFile = fixture.path.join(fixture.directory, 'copy.md');
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(copyFile, source.content);
      let injected = false;
      const racedFs = {
        ...fixture.fs,
        writeFileString: (...args: Parameters<typeof fixture.fs.writeFileString>) =>
          Effect.gen(function* () {
            if (!injected && args[0].includes('context-health-repairs') && args[0].endsWith('.tmp')) {
              injected = true;
              const journal = JSON.parse(args[1]) as {proposal: {mutation: {subjectUri: string}}};
              yield* fixture.fs.writeFileString(
                fixture.path.join(fixture.directory, 'raced-dependent.md'),
                record(
                  'raced-dependent',
                  {relations: [{type: 'depends_on', uri: journal.proposal.mutation.subjectUri}]},
                  'New incoming dependency.',
                ).content,
              );
            }
            return yield* fixture.fs.writeFileString(...args);
          }),
      };
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1}).pipe(
        Effect.provideService(FileSystem.FileSystem, racedFs),
      );
      expect(injected).toBe(true);
      expect(result.receipts).toHaveLength(0);
      expect(yield* fixture.fs.exists(copyFile)).toBe(true);
      expect(yield* fixture.fs.exists(fixture.source)).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('skips all citation recovery I/O when repair preview has no citation candidates', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const citation = createMemoryCodeCitation({
        version: 1,
        repositoryId: 'b'.repeat(64),
        repositoryIdentityKind: 'local',
        sourceCommit: 'c'.repeat(40),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
        extractorSet: 'typescript-v1',
        path: 'source.ts',
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        target: {kind: 'file'},
      });
      const subjects = Array.from({length: 100}, (_, index) =>
        record(`cited-${index}`, {schemaVersion: 5, codeCitations: [citation]}),
      );
      const report = {
        ...buildContextHealthReport({
          project: 'threadnote',
          records: [],
          now: DateTime.toDateUtc(DateTime.makeUnsafe(NOW)),
        }),
        findings: [],
      };
      let reads = 0;
      const countedFs = {
        ...fixture.fs,
        readFileString: (...args: Parameters<typeof fixture.fs.readFileString>) => {
          reads += 1;
          return fixture.fs.readFileString(...args);
        },
      };
      const replacements = yield* captureCitationReplacements(
        fixture.config,
        'threadnote',
        fixture.home,
        subjects,
        report,
      ).pipe(Effect.provideService(FileSystem.FileSystem, countedFs));
      expect(replacements.size).toBe(0);
      expect(reads).toBe(0);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('admits every semantic subject pair in bounded windows without mutating the index', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 256}), size => {
        const records = Array.from({length: size}, (_, index) => index);
        const original = [...records];
        const first = selectMaintenanceSemanticPairBatch(records, 0);
        const windows = Array.from(
          {length: first.totalBatches},
          (_, cursor) => selectMaintenanceSemanticPairBatch(records, cursor).records,
        );
        expect(windows.every(window => window.length <= 128)).toBe(true);
        for (const left of records)
          for (const right of records)
            expect(windows.some(window => window.includes(left) && window.includes(right))).toBe(true);
        expect(records).toEqual(original);
      }),
      {numRuns: 20},
    );
  });

  it('requires personal target authority and preserves inactive historical relations', () => {
    const archived = record('archive', {status: 'archived', archivedFrom: URI.replace('source.md', 'old.md')});
    const source = record('source', {
      relations: [
        {type: 'depends_on', uri: URI.replace('source.md', 'missing.md')},
        {type: 'references', uri: archived.uri},
        {type: 'supersedes', uri: 'threadnote://memory/tn_unavailable'},
        {
          type: 'depends_on',
          uri: 'threadnote://user/tester/memories/shared/default/durable/projects/threadnote/unavailable.md',
        },
      ],
    });
    expect(safeRelationRemoval(source, [source, archived])).toEqual([
      {type: 'depends_on', uri: URI.replace('source.md', 'missing.md')},
    ]);
  });

  it('keeps one logical case and bounded attempt history when reasons change', () => {
    let current = updateMaintenanceCase(
      undefined,
      {
        project: 'threadnote',
        memoryId: 'tn_subject',
        family: 'citation',
        slot: '0',
        evidenceRevision: 'revision',
        disposition: 'waiting-evidence',
        reason: 'not-ready',
      },
      NOW,
    );
    const id = current.caseId;
    for (let index = 0; index < 50; index++)
      current = updateMaintenanceCase(current, {...current, reason: `reason-${index}`}, NOW);
    expect(current.caseId).toBe(id);
    expect(current.events).toHaveLength(8);
    expect(current.attemptCount).toBe(51);
    expect(Date.parse(current.nextAttemptAt!) - Date.parse(NOW)).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  it('preserves every useful relation and anchor before collapsing exact duplicates', () => {
    const subject = record('source', {relations: [{type: 'references', uri: 'threadnote://memory/tn_dependency'}]});
    expect(duplicateArchiveSafe(subject, record('copy'))).toBe(false);
    expect(duplicateArchiveSafe(subject, record('copy', {relations: subject.metadata.relations}))).toBe(true);
    expect(
      duplicateArchiveSafe(subject, record('copy', {relations: subject.metadata.relations}, 'Different claim.')),
    ).toBe(false);
  });

  it('round-robin work never starves a project and does not mutate the input', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({min: 0, max: 5}), {minLength: 1, maxLength: 100}), ids => {
        const work = ids.map((id, index) => ({project: `project-${id}`, index}));
        const original = structuredClone(work);
        const projects = new Set(work.map(item => item.project));
        const selected = selectFairMaintenanceWork(work, undefined, projects.size);
        expect(new Set(selected.map(item => item.project)).size).toBe(projects.size);
        expect(work).toEqual(original);
        expect(new Set(selectFairMaintenanceWork(work, undefined, work.length).map(item => item.index)).size).toBe(
          work.length,
        );
      }),
      {numRuns: 100},
    );
  });

  it('migrates early case identities idempotently and removes duplicate coverage cases', () => {
    const original = updateMaintenanceCase(
      undefined,
      {
        project: 'threadnote',
        memoryId: 'tn_source',
        family: 'citation',
        slot: '0',
        evidenceRevision: 'v1',
        disposition: 'waiting-evidence',
        reason: 'repository-unavailable',
      },
      NOW,
    );
    const coverage = {...original, family: 'citation-coverage', slot: '0', caseId: 'legacy-coverage'};
    const migrated = migrateMaintenanceCases([original, coverage]);
    expect(migrated).toHaveLength(1);
    expect(migrated[0].slot).toBe('anchor:0');
    expect(migrateMaintenanceCases(migrated)).toEqual(migrated);
    expect(
      migrateMaintenanceCases([
        {...original, family: 'review-overdue', slot: 'record', disposition: 'deferred-policy'},
      ])[0].disposition,
    ).toBe('needs-decision');
  });

  effectIt.effect('stores one unavailable anchor case matching core identity and a bounded packet', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const citation = createMemoryCodeCitation({
        extractorSet: 'typescript-v1',
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        path: 'source.ts',
        repositoryId: 'b'.repeat(64),
        repositoryIdentityKind: 'local',
        sourceCommit: 'c'.repeat(40),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
        target: {kind: 'file'},
        version: 1,
      });
      const source = record('source', {schemaVersion: 5, codeCitations: [citation]});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const waiting = first.cases.filter(item => item.disposition === 'waiting-evidence');
      expect(waiting).toHaveLength(1);
      expect(waiting[0].repositoryId).toBe(citation.repositoryId);
      expect(waiting[0].reason).toBe('repository-unavailable');
      const report = yield* collectContextHealth(fixture.config, 'threadnote', [source], fixture.home, {
        includeCitationCoverageFindings: true,
      });
      expect(waiting[0].caseId).toBe(report.findings.find(item => item.category === 'citation-unknown')?.caseId);
      const packet = yield* readContextMaintenancePacket(fixture.config, waiting[0].caseId);
      expect(packet).toMatchObject({memoryUri: source.uri, evidenceRevision: waiting[0].evidenceRevision});
      const replay = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(replay.cases[0].attemptCount).toBe(waiting[0].attemptCount);
      expect(replay.projects[0].checkedCitations).toBe(0);
      yield* fixture.fs.writeFileString(fixture.source, `${source.content}\nChanged claim.`);
      const stalePacket = yield* readContextMaintenancePacket(fixture.config, waiting[0].caseId).pipe(Effect.result);
      expect(Result.isFailure(stalePacket) && stalePacket.failure.message).toContain('case is stale');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps expired unknown projection requests queued until the unchanged worker retry deadline', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* TestClock.setTime(Date.parse(NOW));
      const citation = createMemoryCodeCitation({
        extractorSet: 'typescript-v1',
        fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        path: 'source.ts',
        repositoryId: 'b'.repeat(64),
        repositoryIdentityKind: 'local',
        sourceCommit: 'c'.repeat(40),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
        target: {kind: 'file'},
        version: 1,
      });
      const source = record('source', {schemaVersion: 5, codeCitations: [citation]});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      const waiting = first.cases.find(item => item.disposition === 'waiting-evidence')!;
      expect(waiting.nextAttemptAt).toBe('2026-10-03T15:02:00.000Z');
      const projectionFile = fixture.path.join(
        fixture.home,
        'context-maintenance',
        'evidence',
        `${sha256HexSync(`threadnote\0${fixture.home}`)}.json`,
      );
      const projection = yield* fixture.fs.readFileString(projectionFile);
      yield* TestClock.adjust('61 seconds');
      const foreground = yield* collectContextHealth(fixture.config, 'threadnote', [source], fixture.home);
      expect(foreground.maintenance?.citationCoverage.state).toBe('unavailable');
      expect(
        (yield* readContextMaintenanceEvidenceRequests(fixture.config)).flatMap(request => request.uris),
      ).toContain(source.uri);
      const beforeDeadline = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      expect(beforeDeadline.cases.find(item => item.caseId === waiting.caseId)).toMatchObject({
        disposition: 'waiting-evidence',
        attemptCount: waiting.attemptCount,
        nextAttemptAt: waiting.nextAttemptAt,
      });
      expect(beforeDeadline.lastProgressAt).toBe(first.lastProgressAt);
      expect(yield* fixture.fs.readFileString(projectionFile)).toBe(projection);
      expect(
        (yield* readContextMaintenanceEvidenceRequests(fixture.config)).flatMap(request => request.uris),
      ).toContain(source.uri);
      yield* TestClock.adjust('59 seconds');
      const atDeadline = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      expect(atDeadline.cases.find(item => item.caseId === waiting.caseId)?.attemptCount).toBe(
        waiting.attemptCount + 1,
      );
      expect(yield* fixture.fs.readFileString(projectionFile)).not.toBe(projection);
      expect(
        (yield* readContextMaintenanceEvidenceRequests(fixture.config)).flatMap(request => request.uris),
      ).not.toContain(source.uri);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('archives only explicit expiry and retains memory identity and historical edges', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source', {
        validTo: '2000-01-01T00:00:00.000Z',
        relations: [{type: 'references', uri: URI.replace('source.md', 'target.md')}],
      });
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(
        fixture.path.join(fixture.directory, 'target.md'),
        record('target', {}, 'Independent target claim.').content,
      );
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(yield* fixture.fs.exists(fixture.source)).toBe(false);
      const archive = (yield* readMaintenanceMemoryRecords(fixture.config)).find(
        item => item.metadata.archivedFrom === source.uri,
      )!;
      expect(archive.metadata.memoryId).toBe(source.metadata.memoryId);
      expect(archive.metadata.relations).toEqual(source.metadata.relations);
      const receipt = first.receipts.find(item => item.subjectUri === source.uri)!;
      expect(yield* undoContextMaintenance(fixture.config, receipt.receiptId)).toMatchObject({
        status: 'conflict',
        reason: 'validity-policy-still-expired',
      });
      expect(
        (yield* runContextMaintenance(fixture.config, {cwd: fixture.home})).receipts.filter(
          item => item.subjectUri === source.uri,
        ),
      ).toHaveLength(1);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('makes bounded progress through a 2k corpus and classifies overdue review as one decision', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* Effect.forEach(
        Array.from({length: 2_000}, (_, index) => `scale-${index}`),
        topic => fixture.fs.writeFileString(fixture.path.join(fixture.directory, `${topic}.md`), record(topic).content),
        {concurrency: 64, discard: true},
      );
      const source = record('000-source', {
        reviewAfter: '2000-01-01T00:00:00.000Z',
        relations: [{type: 'depends_on', uri: URI.replace('source.md', 'missing.md')}],
      });
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, '000-source.md'), source.content);
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      expect(result.projects[0].checked).toBe(1);
      expect(result.receipts).toHaveLength(0);
      expect(result.preparation?.complete).toBe(false);
      expect(result.cases.some(item => item.reason === 'inventory-preparation-incomplete')).toBe(true);
      for (let index = 0; index < 10; index++)
        yield* prepareContextMaintenanceInventory(fixture.config, undefined, 256);
      const prepared = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      expect(prepared.receipts).toHaveLength(1);
      expect(result.cases.find(item => item.family === 'review-overdue')?.disposition).toBe('needs-decision');
      expect(result.counts?.decisionMemories).toBe(1);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps anchor identities and rechecks unchanged memory after source events', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const citations = Array.from({length: 8}, (_, index) =>
        createMemoryCodeCitation({
          extractorSet: 'typescript-v1',
          fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
          path: `source-${index}.ts`,
          repositoryId: 'b'.repeat(64),
          repositoryIdentityKind: 'local',
          sourceCommit: 'c'.repeat(40),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
          target: {kind: 'file'},
          version: 1,
        }),
      );
      const source = record('source', {schemaVersion: 5, codeCitations: citations});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 2});
      const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
      const before = JSON.parse(yield* fixture.fs.readFileString(stateFile)) as {
        cases: Array<{caseId: string; slot: string; attemptCount: number; evidenceRevision: string}>;
      };
      const anchors = before.cases.filter(item => item.slot.startsWith('anchor:'));
      expect(anchors).toHaveLength(8);
      expect(new Set(anchors.map(item => item.caseId)).size).toBe(8);
      expect(anchors.some(item => item.slot === 'anchor:7')).toBe(true);
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.home, 'source-7.ts'), 'Source event.');
      const staleSourcePacket = yield* readContextMaintenancePacket(
        fixture.config,
        anchors.find(item => item.slot === 'anchor:7')!.caseId,
      ).pipe(Effect.result);
      expect(Result.isFailure(staleSourcePacket) && staleSourcePacket.failure.message).toContain(
        'Source evidence changed',
      );
      yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 2});
      const after = JSON.parse(yield* fixture.fs.readFileString(stateFile)) as typeof before;
      expect(after.cases.find(item => item.slot === 'anchor:7')).toMatchObject({
        caseId: anchors.find(item => item.slot === 'anchor:7')!.caseId,
        attemptCount: 1,
      });
      expect(after.cases.find(item => item.slot === 'anchor:7')!.evidenceRevision).not.toBe(
        anchors.find(item => item.slot === 'anchor:7')!.evidenceRevision,
      );
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'recovers an interrupted receipt and keeps successful undo from reapplying unchanged duplicate policy',
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const source = record('source');
        yield* fixture.fs.writeFileString(fixture.source, source.content);
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'copy.md'), source.content);
        const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        const receipt = first.receipts[0];
        expect(receipt, JSON.stringify(first)).toBeDefined();
        const restoredFile = fixture.path.join(fixture.directory, receipt.subjectUri.split('/').at(-1)!);
        expect(yield* fixture.fs.exists(restoredFile)).toBe(false);
        const journalFile = fixture.path.join(
          fixture.home,
          'context-maintenance',
          'receipts',
          `${receipt.receiptId}.json`,
        );
        const journal = JSON.parse(yield* fixture.fs.readFileString(journalFile)) as {state: string};
        yield* fixture.fs.writeFileString(journalFile, JSON.stringify({...journal, state: 'applying'}));
        const stateFile = fixture.path.join(fixture.home, 'context-maintenance', 'state-v2.json');
        const state = JSON.parse(yield* fixture.fs.readFileString(stateFile)) as {receipts: unknown[]};
        yield* fixture.fs.writeFileString(stateFile, JSON.stringify({...state, receipts: []}));
        const recovered = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(recovered.receipts.find(item => item.receiptId === receipt.receiptId)?.state).toBe('applied');
        expect(yield* undoContextMaintenance(fixture.config, receipt.receiptId)).toMatchObject({status: 'undone'});
        expect(yield* undoContextMaintenance(fixture.config, receipt.receiptId)).toMatchObject({
          status: 'already-undone',
        });
        yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
        expect(yield* fixture.fs.exists(restoredFile)).toBe(true);
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('discovers real paired semantic decisions matching Health and returns a current packet', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source', {}, '- Agents must load verified context before implementation.');
      const target = record('target', {}, '- Agents must not load verified context before implementation.');
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const targetFile = fixture.path.join(fixture.directory, 'target.md');
      yield* fixture.fs.writeFileString(targetFile, target.content);
      const health = yield* collectContextHealth(fixture.config, 'threadnote', [source, target], fixture.home);
      const semantic = health.findings.find(item => item.category === 'semantic-contradiction')!;
      const maintained = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(maintained.cases.find(item => item.caseId === semantic.caseId)?.disposition).toBe('needs-decision');
      expect(maintained.counts?.decisionMemories).toBe(2);
      const packet = yield* readContextMaintenancePacket(fixture.config, semantic.caseId!);
      expect('relatedMemories' in packet && packet.relatedMemories).toHaveLength(2);
      yield* fixture.fs.writeFileString(targetFile, record('target', {status: 'archived'}, target.body).content);
      expect(
        (yield* runContextMaintenance(fixture.config, {cwd: fixture.home})).cases.find(
          item => item.caseId === semantic.caseId,
        )?.disposition,
      ).toBe('resolved');
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps legacy URI semantic subjects active and rejects packets after either canonical edit', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record(
        'source',
        {schemaVersion: 1, memoryId: undefined},
        '- Agents must load verified context before implementation.',
      );
      const target = record(
        'target',
        {schemaVersion: 1, memoryId: undefined},
        '- Agents must not load verified context before implementation.',
      );
      const targetFile = fixture.path.join(fixture.directory, 'target.md');
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(targetFile, target.content);
      const health = yield* collectContextHealth(fixture.config, 'threadnote', [source, target], fixture.home);
      const caseId = health.findings.find(item => item.category === 'semantic-contradiction')!.caseId!;
      const maintained = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      const semantic = maintained.cases.find(item => item.caseId === caseId)!;
      expect(semantic.disposition).toBe('needs-decision');
      expect(semantic.subjectContentHashes?.map(subject => subject.uri).sort()).toEqual(
        [source.uri, target.uri].sort(),
      );
      expect(maintained.counts?.decisionMemories).toBe(2);
      const packet = yield* readContextMaintenancePacket(fixture.config, caseId);
      expect('relatedMemories' in packet && packet.relatedMemories).toHaveLength(2);
      const replay = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(replay.cases.find(item => item.caseId === caseId)?.disposition).toBe('needs-decision');
      for (const [file, subject] of [
        [fixture.source, source],
        [targetFile, target],
      ] as const) {
        yield* fixture.fs.writeFileString(file, `${subject.content}\nIndependent edited prose.`);
        const stale = yield* readContextMaintenancePacket(fixture.config, caseId).pipe(Effect.result);
        expect(Result.isFailure(stale) && stale.failure.message).toContain('case is stale');
        yield* fixture.fs.writeFileString(file, subject.content);
        expect((yield* readContextMaintenancePacket(fixture.config, caseId)).caseId).toBe(caseId);
      }
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('eventually discovers a semantic pair beyond the first 128 records with partial coverage', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('a-source', {}, '- Agents must load verified context before implementation.');
      const target = record('z-target', {}, '- Agents must not load verified context before implementation.');
      yield* Effect.forEach(
        [
          source,
          target,
          ...Array.from({length: 129}, (_, index) =>
            record(`m-${String(index).padStart(3, '0')}`, {}, 'Independent historical context.'),
          ),
        ],
        subject =>
          fixture.fs.writeFileString(
            fixture.path.join(fixture.directory, `${subject.metadata.topic}.md`),
            subject.content,
          ),
      );
      for (let page = 0; page < 4; page++) yield* prepareContextMaintenanceInventory(fixture.config, undefined, 256);
      const health = yield* collectContextHealth(fixture.config, 'threadnote', [source, target], fixture.home);
      const caseId = health.findings.find(item => item.category === 'semantic-contradiction')!.caseId!;
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      expect(first.semanticCoverage?.[0].state).toBe('partial');
      expect(first.cases.some(item => item.caseId === caseId)).toBe(false);
      for (let tick = 0; tick < 5; tick++)
        yield* runContextMaintenance(fixture.config, {cwd: fixture.home, maxRecords: 1});
      const status = yield* readContextMaintenanceStatus(fixture.config);
      expect(status.cases.find(item => item.caseId === caseId)?.disposition).toBe('needs-decision');
      const packet = yield* readContextMaintenancePacket(fixture.config, caseId);
      expect('relatedMemories' in packet && packet.relatedMemories).toHaveLength(2);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('repairs proven dangling relations once, persists pause/restart, and rejects unsafe undo', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source', {relations: [{type: 'depends_on', uri: URI.replace('source.md', 'missing.md')}]});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const first = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(first.receipts).toHaveLength(1);
      expect(first.cases.some(item => item.disposition === 'retired')).toBe(true);
      expect(
        parseMemoryDocument(URI, yield* fixture.fs.readFileString(fixture.source))!.metadata.relations ?? [],
      ).toEqual([]);
      const second = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(second.receipts).toHaveLength(1);
      const receipt = first.receipts[0];
      expect(yield* undoContextMaintenance(fixture.config, receipt.receiptId)).toMatchObject({
        status: 'conflict',
        reason: 'restored-target-not-active',
      });
      yield* setContextMaintenancePaused(fixture.config, true);
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      expect((yield* runContextMaintenance(fixture.config, {cwd: fixture.home})).paused).toBe(true);
      expect((yield* readContextMaintenanceStatus(fixture.config)).paused).toBe(true);
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves unreadable corpus records and never turns them into target absence', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source', {relations: [{type: 'depends_on', uri: URI.replace('source.md', 'missing.md')}]});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'missing.md'), 'Malformed but present.');
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(result).toMatchObject({state: 'failed', error: {reason: 'memory-snapshot-unreadable'}});
      expect(yield* fixture.fs.readFileString(fixture.source)).toBe(source.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('ignores ancillary shared documents while preserving their existence and personal authority', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const shared = fixture.path.join(
        fixture.home,
        'data',
        'local',
        'user',
        'tester',
        'memories',
        'shared',
        'default',
      );
      yield* fixture.fs.makeDirectory(shared, {recursive: true});
      yield* fixture.fs.writeFileString(
        fixture.path.join(shared, 'guide.md'),
        '---\ntitle: Guide\n---\nAncillary docs.',
      );
      const source = record('source', {
        relations: [
          {type: 'references', uri: 'threadnote://user/tester/memories/shared/default/guide.md'},
          {type: 'references', uri: 'threadnote://memory/tn_unknown_authority'},
          {type: 'depends_on', uri: URI.replace('source.md', 'missing.md')},
        ],
      });
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      expect(result.state).toBe('needs-decision');
      expect(result.receipts).toHaveLength(1);
      expect(parseMemoryDocument(URI, yield* fixture.fs.readFileString(fixture.source))!.metadata.relations).toEqual(
        source.metadata.relations!.slice(0, 2),
      );
      expect(yield* fixture.fs.exists(fixture.path.join(shared, 'guide.md'))).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('undo requires the exact post-repair CAS even after the target becomes readable', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const source = record('source', {relations: [{type: 'references', uri: URI.replace('source.md', 'missing.md')}]});
      yield* fixture.fs.writeFileString(fixture.source, source.content);
      const result = yield* runContextMaintenance(fixture.config, {cwd: fixture.home});
      yield* fixture.fs.writeFileString(fixture.path.join(fixture.directory, 'missing.md'), record('missing').content);
      yield* fixture.fs.writeFileString(fixture.source, record('source', {}, 'Changed after repair.').content);
      expect(yield* undoContextMaintenance(fixture.config, result.receipts[0].receiptId)).toMatchObject({
        status: 'conflict',
        reason: 'memory-changed',
      });
      const bad = yield* undoContextMaintenance(fixture.config, '../../invalid').pipe(Effect.result);
      expect(Result.isFailure(bad)).toBe(true);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});

function makeFixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'context-maintenance-'});
    const directory = path.join(
      home,
      'data',
      'local',
      'user',
      'tester',
      'memories',
      'durable',
      'projects',
      'threadnote',
    );
    yield* fs.makeDirectory(directory, {recursive: true});
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      manifestPath: path.join(home, 'threadnote.json'),
      user: 'tester',
    };
    return {fs, path, home, directory, source: path.join(directory, 'source.md'), config};
  });
}
