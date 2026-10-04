import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {DateTime, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {attachCodeGraphStatusObservation} from '@threadnote/graph/query/contract';
import type {CodeGraphStatus} from '@threadnote/graph/types';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {canonicalMemoryDocumentContent, formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import type {ContextBriefMemoryCandidateV1, ContextBriefCitationValidationReceiptV2} from '@threadnote/context/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {contextHealthCitationCoverageV2} from '@threadnote/context/health_maintenance';
import {
  collectContextMaintenanceCitationEvidence,
  clearContextMaintenanceEvidenceRequest,
  readContextMaintenanceEvidenceRequests,
  projectMaintenanceCitationReceipts,
  sourceObservation,
} from '@threadnote/threadnote/memory/context/maintenance_evidence';

const repository = '/synthetic/repository';
const status: CodeGraphStatus = {
  databasePath: '/private/graph.sqlite',
  freshness: 'current',
  stale: false,
  languagePacks: [],
  identity: {
    caseMode: 'sensitive',
    checkoutId: 'checkout',
    displayName: 'fixture',
    gitCommonDirectory: '/synthetic/git',
    headCommit: '1'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: repository,
    repositoryId: '2'.repeat(64),
    worktreeId: 'worktree',
  },
  readySnapshot: {
    commit: '1'.repeat(40),
    dirty: false,
    edgeCount: 0,
    extractorSet: 'test',
    fileCount: 1,
    id: `cgsn_${'3'.repeat(40)}`,
    repositoryId: '2'.repeat(64),
    state: 'ready',
    symbolCount: 0,
    worktreeId: 'worktree',
  },
};
const citation = createMemoryCodeCitation({
  extractorSet: 'test',
  fileContentHash: {algorithm: 'sha256', value: '4'.repeat(64)},
  path: 'source.ts',
  repositoryId: status.identity.repositoryId,
  repositoryIdentityKind: 'remote',
  sourceCommit: status.identity.headCommit,
  sourceDirty: false,
  sourceSnapshotId: status.readySnapshot!.id,
  target: {kind: 'file'},
  version: 1,
});
function record(index: number) {
  return recordWithCitation(index, citation);
}
function recordWithCitation(index: number, codeCitation: ReturnType<typeof createMemoryCodeCitation>) {
  const content = formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      project: 'fixture',
      status: 'active',
      topic: `fixture-${index}`,
      schemaVersion: 5,
      sourceAgentClient: 'test',
      timestamp: '1970-01-01T00:00:00.000Z',
      visibility: 'personal',
      codeCitations: [codeCitation],
    },
    `Supported claim ${index}.`,
  );
  const parsed = parseMemoryDocument(`threadnote://memory/fixture-${index.toString().padStart(5, '0')}`, content);
  if (parsed === undefined) throw new Error('Invalid fixture memory.');
  return parsed;
}
function candidate(value: ReturnType<typeof record>, rank: number): ContextBriefMemoryCandidateV1 {
  return {
    citationErrorCount: 0,
    codeCitations: value.metadata.codeCitations ?? [],
    excerpt: '',
    kind: 'durable',
    project: 'fixture',
    rank,
    uri: value.uri,
  };
}
function receipt(now: string): ContextBriefCitationValidationReceiptV2 {
  return {
    candidateCount: 1,
    citationId: citation.id,
    coverage: 'current-complete',
    kind: 'file',
    observedAt: now,
    provenance: 'current-verified',
    reason: 'exact',
    repositoryId: status.identity.repositoryId,
    snapshotCommit: status.readySnapshot!.commit,
    snapshotId: status.readySnapshot!.id,
    sourcePath: citation.path,
    status: 'exact',
    strategy: 'file-path',
    validatorVersion: 1,
  };
}
const narrow = Layer.mergeAll(
  BunServices.layer,
  Layer.succeed(CommandExecutor, {} as CommandExecutor['Service']),
  Layer.succeed(SystemInfo, {
    processId: 1,
    platform: 'linux',
    isProcessRunning: () => true,
    processStartIdentity: () => Effect.succeed('fixture'),
  } as unknown as SystemInfo['Service']),
);

describe('generation-bound maintenance citation evidence', () => {
  effectIt.layer(narrow)(test => {
    test.effect('routes every distinct source selector while keeping report roots bounded', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-evidence-selectors-'});
        const config = {
          agentContextHome: home,
          manifestPath: path.join(home, 'manifest'),
          account: 'fixture',
        } as RuntimeConfig;
        yield* fs.writeFileString(config.manifestPath, 'stable manifest');
        const records = Array.from({length: 120}, (_, index) => {
          const sourceCommit = index.toString(16).padStart(40, '0');
          const value = createMemoryCodeCitation({
            extractorSet: 'test',
            fileContentHash: {algorithm: 'sha256', value: '4'.repeat(64)},
            path: 'source.ts',
            repositoryId: status.identity.repositoryId,
            repositoryIdentityKind: 'remote',
            sourceCommit,
            sourceDirty: false,
            sourceSnapshotId: status.readySnapshot!.id,
            target: {kind: 'file'},
            version: 1,
          });
          return recordWithCitation(index, value);
        });
        const candidates = records.map(candidate);
        let validations = 0;
        let sourceChecks = 0;
        const query = CodeGraphQueryService.of({
          status: () => {
            sourceChecks += 1;
            return Effect.succeed(
              attachCodeGraphStatusObservation({...status}, {identity: status.identity, overlay: {dirty: false}}),
            );
          },
        } as unknown as CodeGraphQueryService['Service']);
        const collect = (
          selectedRecords: readonly ReturnType<typeof record>[],
          selectedCandidates: readonly ContextBriefMemoryCandidateV1[],
          mode: 'worker' | undefined,
        ) =>
          collectContextMaintenanceCitationEvidence(
            config,
            'fixture',
            selectedRecords,
            selectedCandidates,
            repository,
            {
              mode,
              validate: selected =>
                Effect.gen(function* () {
                  validations += selected.reduce((count, value) => count + value.codeCitations.length, 0);
                  const now = (yield* DateTime.nowAsDate).toISOString();
                  return selected.map(value => ({
                    uri: value.uri,
                    receipts: value.codeCitations.map(codeCitation => ({
                      ...receipt(now),
                      citationId: codeCitation.id,
                    })),
                  }));
                }),
            },
          ).pipe(Effect.provideService(CodeGraphQueryService, query));

        for (let offset = 0; offset < records.length; offset += 16)
          yield* collect(records.slice(offset, offset + 16), candidates.slice(offset, offset + 16), 'worker');
        expect(validations).toBe(120);
        const beforeReport = sourceChecks;
        const report = yield* collect(records, candidates, undefined);
        expect(report.flatMap(value => value.receipts)).toHaveLength(120);
        expect(sourceChecks - beforeReport).toBe(2);
        expect(validations).toBe(120);
      }),
    );
    test.effect(
      'enqueues cold reads without source validation and reuses worker receipts across repeated 2,000-record pages',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-evidence-'});
          const config = {
            agentContextHome: home,
            manifestPath: path.join(home, 'manifest'),
            account: 'fixture',
          } as RuntimeConfig;
          yield* fs.writeFileString(config.manifestPath, 'stable manifest');
          const records = Array.from({length: 2_000}, (_, index) => record(index));
          const candidates = records.map(candidate);
          let sourceChecks = 0;
          let validations = 0;
          const query = CodeGraphQueryService.of({
            status: () => {
              sourceChecks += 1;
              return Effect.succeed(
                attachCodeGraphStatusObservation({...status}, {identity: status.identity, overlay: {dirty: false}}),
              );
            },
          } as unknown as CodeGraphQueryService['Service']);
          const validate = (selected: readonly ContextBriefMemoryCandidateV1[]) =>
            Effect.gen(function* () {
              validations += selected.reduce((count, value) => count + value.codeCitations.length, 0);
              const now = (yield* DateTime.nowAsDate).toISOString();
              return selected.map(value => ({uri: value.uri, receipts: value.codeCitations.map(() => receipt(now))}));
            });
          const collect = (
            selectedRecords = records,
            selectedCandidates = candidates,
            mode?: 'worker' | 'diagnostic',
          ) =>
            collectContextMaintenanceCitationEvidence(
              config,
              'fixture',
              selectedRecords,
              selectedCandidates,
              repository,
              {mode, validate},
            ).pipe(Effect.provideService(CodeGraphQueryService, query));
          const cold = yield* collect();
          expect(cold).toEqual([]);
          expect(validations).toBe(0);
          expect(sourceChecks).toBe(0);
          expect(contextHealthCitationCoverageV2({records, validations: cold})).toMatchObject({
            eligible: 2_000,
            checked: 0,
            deferred: 2_000,
            currentVerified: 0,
            state: 'unavailable',
          });
          const requests = yield* readContextMaintenanceEvidenceRequests(config);
          expect(requests[0]?.uris).toHaveLength(100);
          const acknowledged = requests[0]?.uris[0];
          if (acknowledged === undefined) return yield* Effect.die(new Error('Missing queued citation work.'));
          yield* clearContextMaintenanceEvidenceRequest(config, 'fixture', repository, [acknowledged]);
          expect((yield* readContextMaintenanceEvidenceRequests(config))[0]?.uris).toHaveLength(99);
          const diagnostic = yield* collect(records, candidates, 'diagnostic');
          expect(diagnostic.flatMap(value => value.receipts)).toHaveLength(96);
          expect(validations).toBe(96);
          expect(sourceChecks).toBe(2);
          for (let index = 96; index < records.length; index += 64)
            yield* collect(records.slice(index, index + 64), candidates.slice(index, index + 64), 'worker');
          expect(validations).toBe(2_000);
          const before = sourceChecks;
          for (let page = 0; page < 5; page++) {
            const evidence = yield* collect();
            expect(evidence).toHaveLength(2_000);
            expect(evidence.every(value => value.receipts.every(value => value.status === 'exact'))).toBe(true);
          }
          expect(validations).toBe(2_000);
          expect(sourceChecks - before).toBe(10);
          expect(yield* readContextMaintenanceEvidenceRequests(config)).toEqual([]);
        }),
    );
    test.effect('fails closed when source publication changes during a cache read', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-evidence-race-'});
        const config = {
          agentContextHome: home,
          manifestPath: path.join(home, 'manifest'),
          account: 'fixture',
        } as RuntimeConfig;
        const records = [record(0)];
        const candidates = records.map(candidate);
        let current = status;
        let race = false;
        let checks = 0;
        let validations = 0;
        const query = CodeGraphQueryService.of({
          status: () =>
            Effect.sync(() => {
              checks += 1;
              if (race && checks % 2 === 0)
                current = {...status, readySnapshot: {...status.readySnapshot!, id: `cgsn_${'5'.repeat(40)}`}};
              return attachCodeGraphStatusObservation(
                {...current},
                {identity: current.identity, overlay: {dirty: false}},
              );
            }),
        } as unknown as CodeGraphQueryService['Service']);
        const validate = (selected: readonly ContextBriefMemoryCandidateV1[]) =>
          Effect.gen(function* () {
            validations += selected.length;
            const now = (yield* DateTime.nowAsDate).toISOString();
            return selected.map(value => ({uri: value.uri, receipts: [receipt(now)]}));
          });
        const collect = () =>
          collectContextMaintenanceCitationEvidence(config, 'fixture', records, candidates, repository, {
            mode: 'diagnostic',
            validate,
          }).pipe(Effect.provideService(CodeGraphQueryService, query));
        expect(yield* collect()).toHaveLength(1);
        race = true;
        expect(yield* collect()).toEqual([]);
        expect(validations).toBe(1);
      }),
    );
    test.effect(
      'reuses recent unknown receipts without certifying coverage and retries after the bounded deadline',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-evidence-retry-'});
          const config = {
            agentContextHome: home,
            manifestPath: path.join(home, 'manifest'),
            account: 'fixture',
          } as RuntimeConfig;
          const records = [record(0)];
          const candidates = records.map(candidate);
          let validations = 0;
          const query = CodeGraphQueryService.of({
            status: () =>
              Effect.succeed(
                attachCodeGraphStatusObservation({...status}, {identity: status.identity, overlay: {dirty: false}}),
              ),
          } as unknown as CodeGraphQueryService['Service']);
          const validate = (selected: readonly ContextBriefMemoryCandidateV1[]) =>
            Effect.gen(function* () {
              validations += selected.length;
              const now = (yield* DateTime.nowAsDate).toISOString();
              return selected.map(value => ({
                uri: value.uri,
                receipts: [
                  {
                    ...receipt(now),
                    status: 'unknown' as const,
                    provenance: 'unverified' as const,
                    coverage: 'incomplete' as const,
                    reason: 'graph-stale' as const,
                  },
                ],
              }));
            });
          const collect = () =>
            collectContextMaintenanceCitationEvidence(config, 'fixture', records, candidates, repository, {
              mode: 'diagnostic',
              validate,
            }).pipe(Effect.provideService(CodeGraphQueryService, query));
          yield* collect();
          const repeated = yield* collect();
          expect(repeated[0]?.receipts[0]).toMatchObject({
            status: 'unknown',
            coverage: 'incomplete',
            provenance: 'unverified',
          });
          expect(validations).toBe(1);
          expect(yield* readContextMaintenanceEvidenceRequests(config)).toEqual([]);
          yield* TestClock.adjust('61 seconds');
          yield* collect();
          expect(validations).toBe(2);
        }),
    );
    test.effect('binds cache publication to the canonical memory mutation generation', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-evidence-memory-race-'});
        const config = {
          agentContextHome: home,
          manifestPath: path.join(home, 'manifest'),
          account: 'fixture',
        } as RuntimeConfig;
        const records = [record(0)];
        const generation = path.join(home, 'locks', 'resources', 'fixture', 'canonical-generation-v1');
        const query = CodeGraphQueryService.of({
          status: () =>
            Effect.succeed(
              attachCodeGraphStatusObservation({...status}, {identity: status.identity, overlay: {dirty: false}}),
            ),
        } as unknown as CodeGraphQueryService['Service']);
        const result = yield* collectContextMaintenanceCitationEvidence(
          config,
          'fixture',
          records,
          records.map(candidate),
          repository,
          {
            mode: 'diagnostic',
            validate: selected =>
              Effect.gen(function* () {
                yield* fs.makeDirectory(path.dirname(generation), {recursive: true});
                yield* fs.writeFileString(generation, 'v1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
                const now = (yield* DateTime.nowAsDate).toISOString();
                return selected.map(value => ({uri: value.uri, receipts: [receipt(now)]}));
              }),
          },
        ).pipe(Effect.provideService(CodeGraphQueryService, query));
        expect(result).toEqual([]);
      }),
    );
  });

  it('never promotes historical or unknown evidence and rejects every changed memory/source epoch', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom('historical', 'unknown', 'current'), (suffix, provenance) => {
        const value = record(0);
        const original = {
          ...receipt('1970-01-01T00:00:00.000Z'),
          ...(provenance === 'historical'
            ? {
                status: 'unknown' as const,
                coverage: 'incomplete' as const,
                provenance: 'historical-verified' as const,
              }
            : provenance === 'unknown'
              ? {status: 'unknown' as const, coverage: 'incomplete' as const, provenance: 'unverified' as const}
              : {}),
        };
        const entry = {
          uri: value.uri,
          contentHash: sha256HexSync(canonicalMemoryDocumentContent(value.content)),
          sources: {[repository]: 'source-epoch'},
          receipts: [original],
        };
        const sources = new Map([
          [
            repository,
            {
              epoch: 'source-epoch',
              current: true,
              repositoryId: status.identity.repositoryId,
              snapshotId: status.readySnapshot!.id,
            },
          ],
        ]);
        expect(
          projectMaintenanceCitationReceipts({entries: [entry], records: [value], sources, now: 0})[0]?.receipts[0],
        ).toEqual(original);
        expect(
          projectMaintenanceCitationReceipts({
            entries: [entry],
            records: [value],
            sources: new Map([[repository, {epoch: `changed-${suffix}`, current: true}]]),
            now: 0,
          }),
        ).toEqual([]);
        expect(
          projectMaintenanceCitationReceipts({
            entries: [entry],
            records: [{...value, content: `${value.content}\nChanged ${suffix}`}],
            sources,
            now: 0,
          }),
        ).toEqual([]);
      }),
      {numRuns: 100},
    );
  });
  it('ignores physical graph metadata while invalidating source, snapshot, and runtime policy changes', () => {
    const input = {cwd: repository, manifest: 'stable', identity: status.identity, status, overlay: {dirty: false}};
    const epoch = sourceObservation(input).epoch;
    expect(sourceObservation({...input, status: {...status, databasePath: '/elsewhere/graph.sqlite'}}).epoch).toBe(
      epoch,
    );
    expect(sourceObservation({...input, overlay: {dirty: true, fingerprint: 'changed-source'}}).epoch).not.toBe(epoch);
    expect(
      sourceObservation({
        ...input,
        status: {...status, readySnapshot: {...status.readySnapshot!, extractorSet: 'new-policy'}},
      }).epoch,
    ).not.toBe(epoch);
    expect(
      sourceObservation({...input, status: {...status, readySnapshot: {...status.readySnapshot!, id: 'new-snapshot'}}})
        .epoch,
    ).not.toBe(epoch);
  });
});
