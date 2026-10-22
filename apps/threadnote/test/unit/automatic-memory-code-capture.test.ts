import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {automaticMaintenanceEvidenceId} from '@threadnote/memory/automatic-maintenance';
import type {CodeGraphSymbol} from '@threadnote/graph/types';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {readContextHealthCitationEvidence} from '@threadnote/context/citation_validation';
import {runCommandEffect} from '@threadnote/platform/command';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {
  automaticCurrentSymbolMatchesExcerpt,
  captureAutomaticCurrentSymbol,
  exactAutomaticCurrentSymbol,
} from '../../src/memory/context/maintenance_code_capture.js';
import {automaticReviewPacket, requestAutomaticMemoryReview} from '../../src/memory/context/maintenance_draft.js';
import {
  prepareAutomaticMemory,
  readLiveAutomaticPreparation,
} from '../../src/memory/context/maintenance_preparation.js';
import {readPreparedMemory, writePreparedMemory} from '../../src/memory/context/maintenance_preparation_state.js';
import {
  prepareTopicMaintenanceReview,
  applyTopicMaintenanceReview,
} from '../../src/memory/context/maintenance_review.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const selectorPin = () =>
  createMemoryCodeCitation({
    version: 1,
    repositoryId: '1'.repeat(64),
    repositoryIdentityKind: 'local',
    sourceCommit: '2'.repeat(40),
    sourceSnapshotId: `cgsn_${'3'.repeat(40)}`,
    sourceDirty: false,
    extractorSet: 'old-extractor',
    path: 'source.ts',
    fileContentHash: {algorithm: 'sha256', value: '4'.repeat(64)},
    target: {
      kind: 'symbol',
      nodeId: `cgs_${'5'.repeat(32)}`,
      language: 'typescript',
      symbolKind: 'variable',
      name: 'limit',
      qualifiedName: 'limit',
      span: {line: 1, column: 14, endLine: 1, endColumn: 23},
      fragmentHash: {algorithm: 'sha256', value: '6'.repeat(64)},
      fragmentCanonicalization: 'utf8-source-span-v1',
    },
  });
const symbol = (overrides: Partial<CodeGraphSymbol> = {}): CodeGraphSymbol => ({
  id: `cgs_${'7'.repeat(32)}`,
  name: 'limit',
  qualifiedName: 'limit',
  path: 'source.ts',
  kind: 'variable',
  language: 'typescript',
  exported: true,
  contentHash: '8'.repeat(64),
  span: {line: 1, column: 14, endLine: 1, endColumn: 23},
  ...overrides,
});

describe('automatic current symbol capture', () => {
  it('binds each same-file symbol excerpt to its own evidence ID and fragment independently of ordering', () => {
    const first = selectorPin();
    if (first.target.kind !== 'symbol') throw new Error('Expected symbol fixture');
    const {id: _firstId, ...fields} = first;
    const pins = [
      first,
      createMemoryCodeCitation({
        ...fields,
        target: {
          ...first.target,
          nodeId: `cgs_${'9'.repeat(32)}`,
          name: 'secondary',
          qualifiedName: 'secondary',
          span: {line: 2, column: 14, endLine: 2, endColumn: 35},
          fragmentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
        },
      }),
    ];
    const target = parseMemoryDocument(
      'threadnote://user/tester/memories/durable/projects/fixture/two.md',
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          schemaVersion: 10,
          memoryId: 'tn_two_symbols',
          project: 'fixture',
          timestamp: '2026-10-21T00:00:00.000Z',
          sourceAgentClient: 'test',
          codeCitations: pins,
        },
        'Two independent constants.',
      ),
    )!;
    const entries = pins.map((citation, i) => {
      const content = i ? 'export const secondary = 2;' : 'export const limit = 1;';
      const id = automaticMaintenanceEvidenceId({kind: 'code', citation});
      return {
        evidence: {
          id,
          source: {kind: 'code' as const, citation},
          scope: 'repository' as const,
          authority: 'recorded' as const,
          availability: 'available' as const,
        },
        candidate: {
          evidenceId: id,
          text: content,
          excerpt: {
            content,
            startLine: i + 1,
            endLine: i + 1,
            excerptHash: sha256HexSync(content),
            fileBytesHash: fields.fileContentHash.value,
            provenance: 'current-verified' as const,
            supportsCitation: true,
            truncated: false,
            source: {
              repositoryId: citation.repositoryId,
              path: citation.path,
              sourceCommit: citation.sourceCommit,
              sourceSnapshotId: citation.sourceSnapshotId,
              sourceDirty: citation.sourceDirty,
              extractorSet: citation.extractorSet,
              fileContentHash: citation.fileContentHash.value,
            },
          },
        },
      };
    });
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (reverseEvidence, reverseCandidates) => {
        const prepared = prepareAutomaticMemory(target, {
          scopeRevision: 'b'.repeat(64),
          evidence: (reverseEvidence ? [...entries].reverse() : entries).map(e => e.evidence),
          candidates: (reverseCandidates ? [...entries].reverse() : entries).map(e => e.candidate),
        });
        const packet = automaticReviewPacket(target, prepared);
        expect(packet.reviewEvidence).toHaveLength(2);
        for (const expected of entries) {
          const actual = packet.reviewEvidence.find(e => e.content === expected.candidate.text)!;
          expect(actual.handleId).toBe(`current:${expected.evidence.id}`);
          expect(actual.descriptor.source).toEqual(expected.evidence.source);
          if (actual.descriptor.source.kind !== 'code' || actual.descriptor.source.citation.target.kind !== 'symbol')
            throw new Error('Expected typed symbol');
          expect(actual.descriptor.source.citation.target.fragmentHash).toEqual(
            expected.evidence.source.citation.target.kind === 'symbol'
              ? expected.evidence.source.citation.target.fragmentHash
              : undefined,
          );
        }
      }),
      {numRuns: 12},
    );
  });

  it('refuses a changed historical symbol snippet without an independently captured current pin', () => {
    const citation = selectorPin(),
      before = JSON.stringify(citation);
    const content = 'export const limit = 7 * 1_024;';
    const id = automaticMaintenanceEvidenceId({kind: 'code', citation});
    const target = parseMemoryDocument(
      'threadnote://user/tester/memories/durable/projects/fixture/target.md',
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          status: 'active',
          schemaVersion: 10,
          memoryId: 'tn_missing_capture',
          project: 'fixture',
          timestamp: '2026-10-21T00:00:00.000Z',
          sourceAgentClient: 'test',
          codeCitations: [citation],
        },
        'The limit is 8192 bytes.',
      ),
    )!;
    const prepared = prepareAutomaticMemory(target, {
      scopeRevision: 'a'.repeat(64),
      evidence: [
        {id, source: {kind: 'code', citation}, scope: 'repository', authority: 'recorded', availability: 'available'},
      ],
      candidates: [
        {
          evidenceId: id,
          text: content,
          excerpt: {
            content,
            startLine: 1,
            endLine: 1,
            excerptHash: sha256HexSync(content),
            fileBytesHash: sha256HexSync(content),
            provenance: 'current-verified',
            truncated: false,
            supportsCitation: false,
            source: {
              repositoryId: citation.repositoryId,
              path: citation.path,
              sourceCommit: 'b'.repeat(40),
              sourceSnapshotId: `cgsn_${'c'.repeat(40)}`,
              sourceDirty: false,
              extractorSet: citation.extractorSet,
              fileContentHash: sha256HexSync(content),
            },
          },
        },
      ],
    });
    const packet = automaticReviewPacket(target, prepared);
    expect(packet.reviewEvidence).toEqual([]);
    expect(packet.draftRequest.available).toBe(false);
    expect(JSON.stringify(citation)).toBe(before);
  });

  it('requires a unique complete exact selector without mutating the historical pin', () => {
    const fields = ['path', 'language', 'kind', 'qualifiedName', 'name'] as const;
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...fields), {maxLength: 12}), fc.boolean(), (noiseFields, reverse) => {
        const citation = selectorPin(),
          before = JSON.stringify(citation),
          exact = symbol();
        const noise = noiseFields.map((field, i) => symbol({id: `noise-${i}`, [field]: 'other'}));
        const rows = reverse ? [...noise, exact].reverse() : [exact, ...noise];
        expect(exactAutomaticCurrentSymbol(citation, citation.repositoryId, rows, false)).toEqual(exact);
        expect(
          exactAutomaticCurrentSymbol(citation, citation.repositoryId, [...rows, symbol({id: 'duplicate'})], false),
        ).toBeUndefined();
        expect(exactAutomaticCurrentSymbol(citation, citation.repositoryId, rows, true)).toBeUndefined();
        expect(exactAutomaticCurrentSymbol(citation, '9'.repeat(64), rows, false)).toBeUndefined();
        expect(exactAutomaticCurrentSymbol(citation, citation.repositoryId, noise, false)).toBeUndefined();
        expect(JSON.stringify(citation)).toBe(before);
      }),
      {numRuns: 40},
    );
  });

  effectIt.effect(
    'persists bounded current symbol support through real approval and canonical-only fresh-home drift',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'automatic-symbol-home-'});
        const freshHome = yield* fs.makeTempDirectoryScoped({prefix: 'automatic-symbol-fresh-'});
        const repository = path.join(home, 'repository');
        yield* fs.makeDirectory(repository);
        const source = path.join(repository, 'source.ts');
        const configFor = (agentContextHome: string): RuntimeConfig => ({
          account: 'local',
          user: 'tester',
          agentId: 'test',
          agentContextHome,
          manifestPath: path.join(agentContextHome, 'manifest.yaml'),
        });
        const config = configFor(home),
          fresh = configFor(freshHome);
        const manifest = `version: 1\nprojects:\n  - name: fixture\n    path: ${JSON.stringify(repository)}\n    uri: threadnote://resources/repos/fixture\n    seed: []\n`;
        yield* fs.writeFileString(config.manifestPath, manifest);
        yield* fs.writeFileString(fresh.manifestPath, manifest);
        const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
        const commit = () =>
          Effect.gen(function* () {
            yield* git(['add', '.']);
            yield* git([
              '-c',
              'user.name=Test',
              '-c',
              'user.email=test@example.invalid',
              'commit',
              '--quiet',
              '-m',
              'fixture',
            ]);
          });
        const index = (c: RuntimeConfig) =>
          CodeGraphIndexer.pipe(
            Effect.flatMap(i => i.index({cwd: repository, threadnoteHome: c.agentContextHome, ensureVectors: false})),
          );
        const sourceBody = (factor: number) =>
          `export const limit = ${factor} * 1_024;\n` +
          Array.from({length: 300}, (_, i) => `// line ${i}: sufficiently large source with unrelated details.\n`).join(
            '',
          );
        yield* git(['init', '--quiet']);
        yield* fs.writeFileString(source, sourceBody(8));
        yield* commit();
        yield* index(config);
        const query = yield* CodeGraphQueryService,
          store = yield* CodeGraphStore;
        const status = yield* query.status(home, repository, {
          project: 'fixture',
          manifestPath: config.manifestPath,
          requestMaintenance: false,
          observeWorktree: true,
        });
        const [[node]] = yield* store.searchSymbolsMany(status.databasePath, status.readySnapshot!.id, ['limit'], 3);
        const [capturedOld] = yield* captureMemoryCodeCitations(config, {
          callerCwd: repository,
          project: 'fixture',
          refs: [node.id],
        });
        expect(capturedOld.target.kind).toBe('symbol');
        // A previous runtime's extractor is deliberately unavailable in the fresh current graph.
        const {id: _oldId, ...oldFields} = capturedOld;
        const historical = createMemoryCodeCitation({...oldFields, extractorSet: 'previous-extractor-version'});
        const historicalBefore = JSON.stringify(historical);
        const uri = 'threadnote://user/tester/memories/durable/projects/fixture/target.md';
        const canonicalPath = (c: RuntimeConfig) =>
          path.join(c.agentContextHome, 'data/local/user/tester/memories/durable/projects/fixture/target.md');
        const content = formatMemoryDocument(
          'MEMORY',
          {
            kind: 'durable',
            schemaVersion: 10,
            status: 'active',
            memoryId: 'tn_portable_symbol',
            project: 'fixture',
            topic: 'limit',
            timestamp: '2026-10-21T00:00:00.000Z',
            sourceAgentClient: 'test',
            codeCitations: [historical],
          },
          'The limit is 8192 bytes.',
        );
        yield* fs.makeDirectory(path.dirname(canonicalPath(config)), {recursive: true});
        yield* fs.writeFileString(canonicalPath(config), content);
        yield* fs.writeFileString(source, sourceBody(7));
        yield* commit();
        yield* index(config);
        const captured = yield* captureAutomaticCurrentSymbol(config, repository, historical, 'fixture');
        expect(captured?.excerpt.content).toBe('export const limit = 7 * 1_024;');
        expect(captured?.citation.target.kind).toBe('symbol');
        expect(JSON.stringify(historical)).toBe(historicalBefore);
        const wrongRepository = createMemoryCodeCitation({...oldFields, repositoryId: 'f'.repeat(64)});
        expect(yield* captureAutomaticCurrentSymbol(config, repository, wrongRepository, 'fixture')).toBeUndefined();
        const wrongPath = createMemoryCodeCitation({...oldFields, path: 'other.ts'});
        expect(yield* captureAutomaticCurrentSymbol(config, repository, wrongPath, 'fixture')).toBeUndefined();
        const oldEvidence = yield* readContextHealthCitationEvidence(
          config,
          {kind: 'repository', callerCwd: repository},
          historical,
          {symbolSpanOnly: true},
        );
        expect(oldEvidence.excerpts.some(e => e.provenance === 'current-verified')).toBe(false);
        const live = yield* readLiveAutomaticPreparation(config, uri, repository);
        expect(
          live.prepared.assessment.evidence.find(
            e => e.source.kind === 'code' && e.source.citation.id === historical.id,
          )?.availability,
        ).toBe('unknown');
        const packet = automaticReviewPacket(live.record, live.prepared, live.locators, live.repositoryIdentity);
        expect(packet.draftRequest.available).toBe(true);
        const entry = packet.reviewEvidence.find(
          e =>
            e.handleId.startsWith('current:') &&
            e.descriptor.source.kind === 'code' &&
            e.descriptor.source.citation.target.kind === 'symbol',
        )!;
        expect(entry.content).toBe('export const limit = 7 * 1_024;');
        const basis = packet.basis;
        const proposed = yield* requestAutomaticMemoryReview(config, {
          uri,
          expectedContentHash: sha256HexSync(content),
          sourceCwd: repository,
          draftJson: JSON.stringify({
            version: 2,
            kind: 'automatic',
            purpose: 'automatic',
            targetHash: basis.targetHash,
            observationRevision: basis.observationRevision,
            packetDigest: basis.packetDigest,
            outcome: 'propose-update',
            paragraphDecisions: [
              {
                ordinal: 0,
                beforeHash: basis.paragraphs[0].hash,
                role: 'descriptive',
                support: 'direct',
                evidenceIds: [entry.descriptor.id],
              },
            ],
            operations: [
              {
                ordinal: 0,
                beforeHash: basis.paragraphs[0].hash,
                supportHandles: [entry.handleId],
                rationale: 'Exact current definition.',
                text: 'The limit is 7168 bytes.',
              },
            ],
            reviewedHandles: [entry.handleId],
            rationale: 'Exact current definition.',
            unresolvedQuestions: [],
            removedClaims: [],
          }),
        });
        if (!('reviewId' in proposed)) throw new Error('Expected actual private review');
        const preview = yield* prepareTopicMaintenanceReview(config, {
          reviewId: proposed.reviewId,
          revision: proposed.revision,
          sourceCwd: repository,
        });
        if (preview.maintenanceApproval?.version !== 3) throw new Error('Expected complete automatic preview');
        const exact = preview.maintenanceApproval.preview;
        expect(exact.reviewedSupport.active.sources[0].source).toMatchObject({
          kind: 'code',
          citation: {target: {kind: 'symbol'}},
        });
        expect(yield* fs.readFileString(canonicalPath(config))).toBe(content);
        yield* applyTopicMaintenanceReview(config, {
          reviewId: preview.reviewId,
          revision: preview.revision,
          approvalDigest: exact.approvalDigest,
          approved: true,
          sourceCwd: repository,
        });
        const approved = yield* fs.readFileString(canonicalPath(config));
        expect(approved).toBe(exact.content);
        expect(parseMemoryDocument(uri, approved)!.metadata.codeCitations).toEqual([historical]);
        const accepted = yield* readLiveAutomaticPreparation(config, uri, repository);
        const acceptedPacket = automaticReviewPacket(
          accepted.record,
          accepted.prepared,
          accepted.locators,
          accepted.repositoryIdentity,
        );
        const currentEntries = (p: typeof acceptedPacket) =>
          p.reviewEvidence.filter(e => e.handleId.startsWith('current:'));
        expect(currentEntries(acceptedPacket)).toHaveLength(1);
        expect(currentEntries(acceptedPacket)[0].descriptor).toEqual(exact.reviewedSupport.active.sources[0]);
        yield* fs.writeFileString(path.join(repository, 'unrelated.ts'), 'export const untouched = true;\n');
        yield* commit();
        yield* index(config);
        const unchanged = yield* readLiveAutomaticPreparation(config, uri, repository);
        const unchangedPacket = automaticReviewPacket(
          unchanged.record,
          unchanged.prepared,
          unchanged.locators,
          unchanged.repositoryIdentity,
        );
        // Scheduling suppresses unchanged relevantRevision; HEAD/snapshot churn cannot introduce another pin.
        expect(unchanged.prepared.relevantRevision).toBe(accepted.prepared.relevantRevision);
        expect(unchanged.prepared.assessment.evidence.map(e => e.id)).toEqual(
          accepted.prepared.assessment.evidence.map(e => e.id),
        );
        expect(currentEntries(unchangedPacket).map(e => e.descriptor)).toEqual(
          currentEntries(acceptedPacket).map(e => e.descriptor),
        );
        // Only the genuine approved canonical document crosses homes. Rebuild graph in the same repository.
        yield* fs.makeDirectory(path.dirname(canonicalPath(fresh)), {recursive: true});
        yield* fs.writeFileString(canonicalPath(fresh), approved);
        for (const name of ['threadnote', 'context-maintenance', 'code-graph'])
          expect(yield* fs.exists(path.join(freshHome, name))).toBe(false);
        expect(yield* captureAutomaticCurrentSymbol(fresh, repository, historical, 'fixture')).toBeUndefined();
        yield* fs.writeFileString(source, sourceBody(4));
        yield* commit();
        yield* index(fresh);
        const rebuilt = yield* readLiveAutomaticPreparation(fresh, uri, repository);
        const next = automaticReviewPacket(
          rebuilt.record,
          rebuilt.prepared,
          rebuilt.locators,
          rebuilt.repositoryIdentity,
        );
        expect(next.basis.body).toBe('The limit is 7168 bytes.');
        expect(next.draftRequest.available).toBe(true);
        expect(next.reviewEvidence.filter(e => e.handleId.startsWith('current:'))).toHaveLength(1);
        expect(
          next.reviewEvidence.some(
            e =>
              e.handleId.startsWith('current:') &&
              e.content === 'export const limit = 4 * 1_024;' &&
              e.descriptor.source.kind === 'code' &&
              e.descriptor.source.citation.target.kind === 'symbol',
          ),
        ).toBe(true);
        expect(
          rebuilt.prepared.assessment.evidence.find(
            e => e.source.kind === 'code' && e.source.citation.id === historical.id,
          )?.availability,
        ).toBe('unknown');
        yield* writePreparedMemory(fresh, rebuilt.prepared);
        expect(yield* readPreparedMemory(fresh, uri)).toEqual(rebuilt.prepared);
        expect(yield* fs.readFileString(canonicalPath(fresh))).toBe(approved);
        expect(JSON.stringify(historical)).toBe(historicalBefore);
        if (!captured) throw new Error('Expected current capture');
        expect(automaticCurrentSymbolMatchesExcerpt(captured.citation, {...captured.excerpt, truncated: true})).toBe(
          false,
        );
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
