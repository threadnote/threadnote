import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {ByteSize, Effect, FileSystem, Path, Result} from 'effect';
import fc from 'fast-check';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';

import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {uriSegment} from '@threadnote/workspace/manifest';
import {
  collectContextHealthAggregate,
  collectContextHealthAggregateSources,
} from '@threadnote/threadnote/memory/context/health_aggregate_commands';
import {aggregateContextHealthReportsV1} from '@threadnote/context/health_schedule';
import {formatMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import {
  admitPersonalProjectBytes,
  admitPersonalProjectFileCount,
  readPersonalProjectMemoryRecords,
} from '@threadnote/threadnote/memory/maintenance/records';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('context health aggregate runtime', () => {
  effectIt.effect('selects every configured team deterministically and excludes local shared copies', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture(['runtime', 'platform']);
        yield* writePersonalMemory(fixture, 'personal', 'Agents must retain deterministic evidence.');
        yield* writeLocalSharedCopy(fixture, 'platform', 'duplicate', 'Agents must retain deterministic evidence.');
        yield* writeTeamMemory(fixture, 'platform', 'platform', 'Platforms must retain deterministic evidence.');
        yield* writeTeamMemory(fixture, 'runtime', 'runtime', 'Runtimes must retain deterministic evidence.');
        for (const worktree of Object.values(fixture.worktrees)) {
          const other = fixture.path.join(worktree, 'durable', 'projects', 'other-project');
          yield* fixture.fs.makeDirectory(other, {recursive: true});
          yield* fixture.fs.writeFileString(fixture.path.join(other, 'malformed.md'), 'not a memory');
        }
        yield* commitTeams(fixture);
        const platformWorktree = fixture.worktrees.platform;
        if (platformWorktree === undefined) return yield* Effect.die(new Error('Missing platform fixture.'));
        const unrelatedDirty = fixture.path.join(
          platformWorktree,
          'durable',
          'projects',
          'other-project',
          'untracked.md',
        );
        yield* fixture.fs.writeFileString(unrelatedDirty, 'unrelated dirty evidence');
        const statusBefore = (yield* git(platformWorktree, ['status', '--porcelain=v1'])).stdout;

        const sources = yield* collectContextHealthAggregateSources(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(TestClock.withLive);
        const aggregate = aggregateContextHealthReportsV1(sources);

        expect(aggregate).toMatchObject({
          completeSources: 3,
          exitCode: 0,
          knownFindings: 0,
          status: 'clean',
          unknownSources: 0,
        });
        expect(aggregate.sources.map(source => source.sourceKey)).toEqual([
          'personal',
          'team:platform',
          'team:runtime',
        ]);
        expect(aggregate.sources[0]).toMatchObject({recordsScanned: 1});
        expect(aggregate).toEqual(
          yield* collectContextHealthAggregate(fixture.config, {
            callerCwd: fixture.repository,
            project: 'threadnote',
          }).pipe(TestClock.withLive),
        );
        expect((yield* git(platformWorktree, ['status', '--porcelain=v1'])).stdout).toBe(statusBefore);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reads the observed personal lifecycle snapshot scale', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture([]);
        const fileCount = 1_979;
        const totalBytes = 84_628_183;
        const legacyRecordBytes = 4_160_056;
        const ordinaryRecordBytes = Math.floor((totalBytes - legacyRecordBytes) / (fileCount - 1));
        const largerOrdinaryRecordCount = totalBytes - legacyRecordBytes - ordinaryRecordBytes * (fileCount - 1);
        const topics = Array.from({length: fileCount - 1}, (_, index) => `scale-${String(index).padStart(4, '0')}`);
        const handoffDirectory = personalProjectDirectory(fixture, 'handoff', 'threadnote');
        const archivedHandoffDirectory = personalProjectDirectory(fixture, 'handoff', 'threadnote', 'archived');
        yield* Effect.forEach(
          topics,
          (topic, index) => {
            const bytes = ordinaryRecordBytes + (index < largerOrdinaryRecordCount ? 1 : 0);
            return writePersonalRawAt(
              fixture,
              handoffDirectory,
              `${topic}.md`,
              handoffMemoryOfByteLength(topic, bytes),
            );
          },
          {concurrency: 64, discard: true},
        );
        yield* writePersonalRawAt(
          fixture,
          archivedHandoffDirectory,
          'legacy-scale.md',
          handoffMemoryOfByteLength('legacy-scale', legacyRecordBytes, 'archived'),
        );
        const snapshot = yield* readPersonalProjectMemoryRecords(fixture.config, 'threadnote');
        expect(snapshot).toHaveLength(fileCount);
        expect(snapshot.some(record => record.metadata.topic === 'legacy-scale')).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('ignores product dotfiles before bounded personal snapshot admission', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture([]);
        const directory = personalProjectDirectory(fixture, 'durable', 'threadnote');
        yield* writePersonalRaw(fixture, 'threadnote', 'visible.md', personalMemory('visible', 'Selected evidence.'));
        const hiddenNames = ['.abstract.md', ...Array.from({length: 10_000}, (_, index) => `.derived-${index}.md`)];
        let hiddenFileOpens = 0;
        let hiddenFileStats = 0;
        const recordingFileSystem = FileSystem.FileSystem.of({
          ...fixture.fs,
          open: (file, options) => {
            if (hiddenNames.some(name => file.endsWith(`/${name}`))) hiddenFileOpens += 1;
            return fixture.fs.open(file, options);
          },
          readDirectory: candidate =>
            candidate === directory
              ? Effect.succeed([...hiddenNames, 'visible.md'])
              : fixture.fs.readDirectory(candidate),
          stat: file => {
            if (hiddenNames.some(name => file.endsWith(`/${name}`))) hiddenFileStats += 1;
            return fixture.fs.stat(file);
          },
        });

        const records = yield* readPersonalProjectMemoryRecords(fixture.config, 'threadnote').pipe(
          Effect.provideService(FileSystem.FileSystem, recordingFileSystem),
        );

        expect(records.map(record => record.metadata.topic)).toEqual(['visible']);
        expect(hiddenFileOpens).toBe(0);
        expect(hiddenFileStats).toBe(0);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'returns the same canonical snapshot across directory and file-read interleavings without mutating content',
    {
      ids: fc.uniqueArray(fc.integer({min: 0, max: 9}), {minLength: 2, maxLength: 6}),
      reverse: fc.boolean(),
    },
    ({ids, reverse}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture([]);
          const directory = personalProjectDirectory(fixture, 'durable', 'threadnote');
          const expected = ids
            .map(id => ({
              body: `Synthetic record ${id}.`,
              topic: `interleaving-${id}`,
            }))
            .sort((left, right) => left.topic.localeCompare(right.topic));
          for (const record of expected) {
            yield* writePersonalMemory(fixture, record.topic, record.body);
          }
          const reorderedFileSystem = FileSystem.FileSystem.of({
            ...fixture.fs,
            readDirectory: target =>
              fixture.fs
                .readDirectory(target)
                .pipe(Effect.map(entries => (target === directory && reverse ? [...entries].reverse() : entries))),
            open: (file, options) =>
              Effect.gen(function* () {
                if (file.endsWith(`${ids[0]}.md`)) yield* Effect.yieldNow;
                return yield* fixture.fs.open(file, options);
              }),
          });
          const snapshot = yield* readPersonalProjectMemoryRecords(fixture.config, 'threadnote').pipe(
            Effect.provideService(FileSystem.FileSystem, reorderedFileSystem),
          );
          expect(snapshot.map(record => ({body: record.body, topic: record.metadata.topic}))).toEqual(expected);
          for (const record of expected) {
            expect(yield* fixture.fs.readFileString(fixture.path.join(directory, `${record.topic}.md`))).toBe(
              personalMemory(record.topic, record.body),
            );
          }
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 12}},
  );

  effectIt.effect('accepts writer-compatible personal topics, headers, and legacy visibility', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture([]);
        yield* writePersonalRaw(
          fixture,
          'threadnote',
          'subset-authoring-0324.md',
          personalMemory('subset-authoring/0324', 'Normalized writer topic.'),
        );
        yield* writePersonalRaw(
          fixture,
          'threadnote',
          'legacy-no-visibility.md',
          personalMemory('legacy-no-visibility', 'Legacy personal evidence.').replace('visibility: personal\n', ''),
        );
        const handoffDirectory = personalProjectDirectory(fixture, 'handoff', 'threadnote');
        yield* writePersonalRawAt(
          fixture,
          handoffDirectory,
          'current-handoff.md',
          handoffMemory('current-handoff', 'Current handoff.', 'HANDOFF').replace('visibility: personal\n', ''),
        );
        yield* writePersonalRawAt(
          fixture,
          handoffDirectory,
          'legacy-handoff.md',
          handoffMemory('legacy-handoff', 'Legacy handoff.', 'MEMORY'),
        );

        const records = yield* readPersonalProjectMemoryRecords(fixture.config, 'threadnote');

        expect(records.map(record => record.metadata.topic)).toEqual([
          'legacy-no-visibility',
          'subset-authoring/0324',
          'current-handoff',
          'legacy-handoff',
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'round-trips writer-normalized filenames for path-like personal topics',
    {
      segments: fc.array(
        fc.string({maxLength: 8, minLength: 1, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789')}),
        {maxLength: 4, minLength: 2},
      ),
    },
    ({segments}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture([]);
          const topic = segments.join('/');
          yield* writePersonalRaw(
            fixture,
            'threadnote',
            `${uriSegment(topic)}.md`,
            personalMemory(topic, 'Writer-normalized evidence.'),
          );

          const records = yield* readPersonalProjectMemoryRecords(fixture.config, 'threadnote');

          expect(records.map(record => record.metadata.topic)).toEqual([topic]);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 24}},
  );

  effectIt.effect('rejects personal filename, header, and explicit visibility mismatches', () =>
    Effect.scoped(
      Effect.forEach(
        [
          {
            content: personalMemory('subset-authoring/0324', 'Mismatched normalized filename.'),
            filename: 'subset-authoring-0325.md',
            kind: 'durable' as const,
          },
          ...(['shared', 'external', 'unknown'] as const).map(visibility => ({
            content: personalMemory(`visibility-${visibility}`, 'Invalid visibility.').replace(
              'visibility: personal',
              `visibility: ${visibility}`,
            ),
            filename: `visibility-${visibility}.md`,
            kind: 'durable' as const,
          })),
        ],
        ({content, filename, kind}) =>
          Effect.gen(function* () {
            const fixture = yield* makeFixture([]);
            yield* writePersonalRawAt(
              fixture,
              personalProjectDirectory(fixture, kind, 'threadnote'),
              filename,
              content,
            );

            const result = yield* readPersonalProjectMemoryRecords(fixture.config, 'threadnote').pipe(Effect.result);

            expect(result._tag).toBe('Failure');
          }),
        {discard: true},
      ),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails closed before reading personal contents when the finite snapshot bound is exceeded', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture([]);
        const durableDirectory = personalProjectDirectory(fixture, 'durable', 'threadnote');
        const handoffDirectory = personalProjectDirectory(fixture, 'handoff', 'threadnote');
        yield* fixture.fs.makeDirectory(durableDirectory, {recursive: true});
        yield* fixture.fs.makeDirectory(handoffDirectory, {recursive: true});
        let selectedFileOpens = 0;
        let selectedFileStats = 0;
        const oversizedFileSystem = FileSystem.FileSystem.of({
          ...fixture.fs,
          open: (file, options) => {
            if (file.endsWith('.md')) selectedFileOpens += 1;
            return fixture.fs.open(file, options);
          },
          readDirectory: directory =>
            directory === durableDirectory
              ? Effect.succeed(Array.from({length: 6_000}, (_, index) => `durable-overflow-${index}.md`))
              : directory === handoffDirectory
                ? Effect.succeed(Array.from({length: 4_001}, (_, index) => `handoff-overflow-${index}.md`))
                : fixture.fs.readDirectory(directory),
          stat: file => {
            if (file.endsWith('.md')) selectedFileStats += 1;
            return fixture.fs.stat(file);
          },
        });

        const aggregate = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(Effect.provideService(FileSystem.FileSystem, oversizedFileSystem), TestClock.withLive);

        expect(aggregate).toMatchObject({completeSources: 0, exitCode: 2, status: 'unknown', unknownSources: 1});
        expect(aggregate.sources[0]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});
        expect(selectedFileOpens).toBe(0);
        expect(selectedFileStats).toBe(0);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preflights the personal per-file byte bound before opening content', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture([]);
        const directory = personalProjectDirectory(fixture, 'handoff', 'threadnote');
        const target = fixture.path.join(directory, 'oversized.md');
        yield* writePersonalRawAt(fixture, directory, 'oversized.md', handoffMemory('oversized', 'small on disk'));
        let selectedFileOpens = 0;
        const oversizedFileSystem = FileSystem.FileSystem.of({
          ...fixture.fs,
          open: (file, options) => {
            if (file === target) selectedFileOpens += 1;
            return fixture.fs.open(file, options);
          },
          stat: file =>
            fixture.fs
              .stat(file)
              .pipe(
                Effect.map(info =>
                  file.endsWith('/oversized.md') ? {...info, size: ByteSize.bytes(8 * 1_024 * 1_024 + 1)} : info,
                ),
              ),
        });

        const result = yield* readPersonalProjectMemoryRecords(fixture.config, 'threadnote').pipe(
          Effect.provideService(FileSystem.FileSystem, oversizedFileSystem),
          Effect.result,
        );

        expect(result._tag).toBe('Failure');
        expect(selectedFileOpens).toBe(0);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preflights the personal aggregate byte bound before opening content', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture([]);
        const directory = personalProjectDirectory(fixture, 'handoff', 'threadnote');
        const targets = Array.from({length: 17}, (_, index) => fixture.path.join(directory, `total-${index}.md`));
        yield* Effect.forEach(
          targets,
          (target, index) =>
            writePersonalRawAt(
              fixture,
              directory,
              `total-${index}.md`,
              handoffMemory(`total-${index}`, 'small on disk'),
            ),
          {discard: true},
        );
        let selectedFileOpens = 0;
        const oversizedFileSystem = FileSystem.FileSystem.of({
          ...fixture.fs,
          open: (file, options) => {
            if (targets.includes(file)) selectedFileOpens += 1;
            return fixture.fs.open(file, options);
          },
          stat: file =>
            fixture.fs.stat(file).pipe(
              Effect.map(info => {
                const index = Number(file.match(/total-(\d+)\.md$/u)?.[1]);
                if (index >= 0)
                  return {
                    ...info,
                    size: ByteSize.bytes(index === targets.length - 1 ? 1 : 8 * 1_024 * 1_024),
                  };
                return info;
              }),
            ),
        });

        const result = yield* readPersonalProjectMemoryRecords(fixture.config, 'threadnote').pipe(
          Effect.provideService(FileSystem.FileSystem, oversizedFileSystem),
          Effect.result,
        );

        expect(result._tag).toBe('Failure');
        expect(selectedFileOpens).toBe(0);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('accepts exact personal snapshot admission ceilings', () =>
    Effect.sync(() => {
      const exactFileCount = admitPersonalProjectFileCount(10_000 - 1);
      expect(Result.isSuccess(exactFileCount)).toBe(true);
      if (Result.isSuccess(exactFileCount)) expect(exactFileCount.success).toBe(10_000);

      const exactFileBytes = admitPersonalProjectBytes(0, 8 * 1_024 * 1_024);
      expect(Result.isSuccess(exactFileBytes)).toBe(true);
      if (Result.isSuccess(exactFileBytes)) expect(exactFileBytes.success).toBe(8 * 1_024 * 1_024);

      const exactTotalBytes = admitPersonalProjectBytes(120 * 1_024 * 1_024, 8 * 1_024 * 1_024);
      expect(Result.isSuccess(exactTotalBytes)).toBe(true);
      if (Result.isSuccess(exactTotalBytes)) expect(exactTotalBytes.success).toBe(128 * 1_024 * 1_024);
    }),
  );

  fcEffectProp(
    effectIt,
    'preflights the total personal file bound before reads for every two-directory partition',
    {firstDirectoryCount: fc.integer({max: 10_000, min: 1})},
    ({firstDirectoryCount}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture([]);
          const durableDirectory = personalProjectDirectory(fixture, 'durable', 'threadnote');
          const handoffDirectory = personalProjectDirectory(fixture, 'handoff', 'threadnote');
          yield* fixture.fs.makeDirectory(durableDirectory, {recursive: true});
          yield* fixture.fs.makeDirectory(handoffDirectory, {recursive: true});
          let selectedFileOpens = 0;
          let selectedFileStats = 0;
          const oversizedFileSystem = FileSystem.FileSystem.of({
            ...fixture.fs,
            open: (file, options) => {
              if (file.endsWith('.md')) selectedFileOpens += 1;
              return fixture.fs.open(file, options);
            },
            readDirectory: directory =>
              directory === durableDirectory
                ? Effect.succeed(
                    Array.from({length: firstDirectoryCount}, (_, index) => `durable-overflow-${index}.md`),
                  )
                : directory === handoffDirectory
                  ? Effect.succeed(
                      Array.from({length: 10_001 - firstDirectoryCount}, (_, index) => `handoff-overflow-${index}.md`),
                    )
                  : fixture.fs.readDirectory(directory),
            stat: file => {
              if (file.endsWith('.md')) selectedFileStats += 1;
              return fixture.fs.stat(file);
            },
          });

          const result = yield* readPersonalProjectMemoryRecords(fixture.config, 'threadnote').pipe(
            Effect.provideService(FileSystem.FileSystem, oversizedFileSystem),
            Effect.result,
          );

          expect(result._tag).toBe('Failure');
          expect(selectedFileOpens).toBe(0);
          expect(selectedFileStats).toBe(0);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 20}},
  );

  effectIt.effect('fails closed for unconfigured, dirty, and citation-unverifiable selected teams', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture(['platform']);
        yield* writeTeamMemory(fixture, 'platform', 'clean', 'Platforms must retain deterministic evidence.');
        yield* commitTeams(fixture);

        const unconfigured = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: ['missing'],
        }).pipe(TestClock.withLive);
        expect(unconfigured).toMatchObject({exitCode: 2, status: 'unknown', unknownSources: 1});
        expect(unconfigured.sources).toContainEqual({
          reason: 'team-not-configured',
          sourceKey: 'team:missing',
          state: 'unknown',
        });

        yield* writeTeamMemory(fixture, 'platform', 'untracked', 'Dirty snapshots must never report clean.');
        const dirty = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: [],
        }).pipe(TestClock.withLive);
        expect(dirty).toMatchObject({exitCode: 2, status: 'unknown', unknownSources: 1});
        expect(dirty.sources[1]).toMatchObject({
          evidenceRevision: expect.stringMatching(/^[0-9a-f]{64}$/u),
          reason: 'snapshot-dirty',
          sourceKey: 'team:platform',
          state: 'unknown',
        });

        yield* git(fixture.worktrees.platform, ['add', '.']);
        yield* git(fixture.worktrees.platform, ['commit', '--quiet', '--message', 'dirty record']);
        const citedPath = yield* teamMemoryPath(fixture, 'platform', 'cited');
        yield* fixture.fs.writeFileString(
          citedPath,
          memory('cited', 'Cited records must retain repository proof.').replace(
            '\n\n',
            '\ncode_citation: {not-json}\n\n',
          ),
        );
        yield* git(fixture.worktrees.platform, ['add', '.']);
        yield* git(fixture.worktrees.platform, ['commit', '--quiet', '--message', 'cited record']);
        const cited = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: ['platform'],
        }).pipe(TestClock.withLive);
        expect(cited).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(cited.sources[1]).toMatchObject({reason: 'citation-evidence-unavailable', state: 'unknown'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails closed when a selected tracked memory is malformed or oversized', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture(['platform']);
        const target = yield* teamMemoryPath(fixture, 'platform', 'broken');
        yield* fixture.fs.writeFileString(target, 'not a memory');
        yield* commitTeams(fixture);

        const malformed = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: ['platform'],
        }).pipe(TestClock.withLive);
        expect(malformed).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(malformed.sources[1]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});

        yield* fixture.fs.writeFileString(
          target,
          memory('broken', 'Active paths must contain active records only.').replace(
            'status: active',
            'status: archived',
          ),
        );
        yield* git(fixture.worktrees.platform, ['add', '.']);
        yield* git(fixture.worktrees.platform, ['commit', '--quiet', '--message', 'mismatched status']);
        const inactiveTeamRecord = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: ['platform'],
        }).pipe(TestClock.withLive);
        expect(inactiveTeamRecord).toMatchObject({exitCode: 0, status: 'clean'});
        expect(inactiveTeamRecord.sources[1]).toMatchObject({recordsScanned: 0, state: 'complete'});

        yield* fixture.fs.writeFileString(
          target,
          memory('broken', 'Durable team records require the canonical MEMORY header.').replace(/^MEMORY/u, 'HANDOFF'),
        );
        yield* git(fixture.worktrees.platform, ['add', '.']);
        yield* git(fixture.worktrees.platform, ['commit', '--quiet', '--message', 'mismatched header']);
        const mismatchedHeader = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: ['platform'],
        }).pipe(TestClock.withLive);
        expect(mismatchedHeader).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(mismatchedHeader.sources[1]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});

        yield* fixture.fs.writeFileString(
          target,
          personalMemory('broken', 'Team snapshots require shared visibility.'),
        );
        yield* git(fixture.worktrees.platform, ['add', '.']);
        yield* git(fixture.worktrees.platform, ['commit', '--quiet', '--message', 'mismatched visibility']);
        const personalVisibility = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: ['platform'],
        }).pipe(TestClock.withLive);
        expect(personalVisibility).toMatchObject({exitCode: 0, status: 'clean'});
        expect(personalVisibility.sources[1]).toMatchObject({recordsScanned: 1, state: 'complete'});

        yield* fixture.fs.writeFileString(
          target,
          memory('broken', 'Team snapshots reject external visibility.').replace(
            'visibility: shared',
            'visibility: external',
          ),
        );
        yield* git(fixture.worktrees.platform, ['add', '.']);
        yield* git(fixture.worktrees.platform, ['commit', '--quiet', '--message', 'external visibility']);
        const externalVisibility = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: ['platform'],
        }).pipe(TestClock.withLive);
        expect(externalVisibility).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(externalVisibility.sources[1]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});

        yield* fixture.fs.writeFileString(
          target,
          memory('broken', 'Team snapshots reject unknown visibility.').replace(
            'visibility: shared',
            'visibility: unknown',
          ),
        );
        yield* git(fixture.worktrees.platform, ['add', '.']);
        yield* git(fixture.worktrees.platform, ['commit', '--quiet', '--message', 'unknown visibility']);
        const unknownVisibility = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: ['platform'],
        }).pipe(TestClock.withLive);
        expect(unknownVisibility).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(unknownVisibility.sources[1]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});

        yield* fixture.fs.writeFileString(
          target,
          memory('broken', 'visibility: external').replace('\nvisibility: shared', '').replaceAll('\n', '\r\n'),
        );
        yield* git(fixture.worktrees.platform, ['add', '.']);
        yield* git(fixture.worktrees.platform, ['commit', '--quiet', '--message', 'body visibility']);
        const bodyVisibility = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: ['platform'],
        }).pipe(TestClock.withLive);
        expect(bodyVisibility).toMatchObject({exitCode: 0, status: 'clean'});
        expect(bodyVisibility.sources[1]).toMatchObject({recordsScanned: 1, state: 'complete'});

        yield* fixture.fs.writeFileString(
          target,
          memory('broken', 'Team snapshots reject CR-only external visibility.')
            .replace('visibility: shared', 'visibility: external')
            .replaceAll('\n', '\r'),
        );
        yield* git(fixture.worktrees.platform, ['add', '.']);
        yield* git(fixture.worktrees.platform, ['commit', '--quiet', '--message', 'cr-only visibility']);
        const crOnlyExternalVisibility = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: ['platform'],
        }).pipe(TestClock.withLive);
        expect(crOnlyExternalVisibility).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(crOnlyExternalVisibility.sources[1]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});

        yield* fixture.fs.writeFileString(
          target,
          memory('broken', `Evidence must remain bounded.\n${'x'.repeat(300_000)}`),
        );
        yield* git(fixture.worktrees.platform, ['add', '.']);
        yield* git(fixture.worktrees.platform, ['commit', '--quiet', '--message', 'oversized record']);
        const oversized = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: ['platform'],
        }).pipe(TestClock.withLive);
        expect(oversized).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(oversized.sources[1]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('accepts legacy team visibility and retains inactive records for relation classification', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture(['platform']);
        const active = yield* teamMemoryPath(fixture, 'platform', 'active');
        const archived = yield* teamMemoryPath(fixture, 'platform', 'archived');
        yield* fixture.fs.writeFileString(
          active,
          memory('active', 'Active records may depend on archived team knowledge.').replace(
            'visibility: shared',
            'relation: depends_on threadnote://memory/tn_archived\n',
          ),
        );
        yield* fixture.fs.writeFileString(
          archived,
          memory('archived', 'Archived team knowledge remains relation evidence.').replace(
            'status: active',
            'status: archived',
          ),
        );
        const legacyVisibility = yield* teamMemoryPath(fixture, 'platform', 'legacy-visibility');
        yield* fixture.fs.writeFileString(
          legacyVisibility,
          memory('legacy-visibility', 'Legacy team records may omit visibility.').replace('\nvisibility: shared', ''),
        );
        const updatedTopic = 'provider-neutral-credentials';
        const stableTopicPath = yield* teamMemoryPath(fixture, 'platform', 'legacy-credentials');
        yield* fixture.fs.writeFileString(
          stableTopicPath,
          memory(updatedTopic, 'Shared replacements may evolve topic metadata while keeping their stable path.'),
        );
        yield* commitTeams(fixture);

        const aggregate = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: ['platform'],
        }).pipe(TestClock.withLive);

        expect(aggregate).toMatchObject({exitCode: 1, knownFindings: 1, status: 'findings'});
        expect(aggregate.sources[1]).toMatchObject({recordsScanned: 3, state: 'complete'});
        expect(aggregate.findings[0]?.findingId).toMatch(/^relation-target-inactive\0/u);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'keeps stable team paths readable when replacement topics evolve',
    {
      segments: fc.array(
        fc.string({maxLength: 8, minLength: 1, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789')}),
        {maxLength: 4, minLength: 2},
      ),
    },
    ({segments}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture(['platform']);
          const topic = segments.join('/');
          const target = yield* teamMemoryPath(fixture, 'platform', 'stable-shared-location');
          yield* fixture.fs.writeFileString(
            target,
            memory(topic, 'Replacement topic metadata evolved in place.').replace(
              /^memory_id: .*$/mu,
              'memory_id: tn_stable_shared_location',
            ),
          );
          yield* commitTeams(fixture);

          const aggregate = yield* collectContextHealthAggregate(fixture.config, {
            callerCwd: fixture.repository,
            project: 'threadnote',
            teams: ['platform'],
          }).pipe(TestClock.withLive);

          expect(aggregate).toMatchObject({completeSources: 2, exitCode: 0, status: 'clean'});
          expect(aggregate.sources[1]).toMatchObject({recordsScanned: 1, state: 'complete'});
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 12}},
  );

  effectIt.effect('rejects personal filename-topic and header mismatches', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture([]);
        const durableDirectory = personalProjectDirectory(fixture, 'durable', 'threadnote');
        const mismatchedFilename = fixture.path.join(durableDirectory, 'wrong-name.md');
        yield* writePersonalRaw(
          fixture,
          'threadnote',
          'wrong-name.md',
          personalMemory('canonical-name', 'Filenames must match canonical topic metadata.'),
        );
        const filenameMismatch = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(TestClock.withLive);
        expect(filenameMismatch).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(filenameMismatch.sources[0]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});
        yield* fixture.fs.remove(mismatchedFilename);

        const durableHeader = fixture.path.join(durableDirectory, 'durable-header.md');
        yield* writePersonalRaw(
          fixture,
          'threadnote',
          'durable-header.md',
          personalMemory('durable-header', 'Durable records require MEMORY headers.').replace(/^MEMORY/u, 'HANDOFF'),
        );
        const durableHeaderMismatch = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(TestClock.withLive);
        expect(durableHeaderMismatch).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(durableHeaderMismatch.sources[0]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});
        yield* fixture.fs.remove(durableHeader);

        const handoffDirectory = personalProjectDirectory(fixture, 'handoff', 'threadnote');
        yield* writePersonalRawAt(
          fixture,
          handoffDirectory,
          'handoff-header.md',
          handoffMemory('handoff-header', 'Handoffs require a recognized header.').replace(/^HANDOFF/u, 'NOTE'),
        );
        const handoffHeaderMismatch = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(TestClock.withLive);
        expect(handoffHeaderMismatch).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(handoffHeaderMismatch.sources[0]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uses a strict inactive personal corpus for relation classification', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture([]);
        yield* writePersonalRaw(
          fixture,
          'threadnote',
          'source.md',
          personalMemory('source', 'Source depends on retired knowledge.', {
            memoryId: 'tn_relation_source',
            relations: [
              {type: 'depends_on', uri: 'threadnote://memory/tn_archived_target'},
              {type: 'depends_on', uri: 'threadnote://memory/tn_superseded_target'},
            ],
          }),
        );
        const supersededDirectory = personalProjectDirectory(fixture, 'durable', 'threadnote', 'superseded');
        yield* writePersonalRawAt(
          fixture,
          supersededDirectory,
          'superseded-copy.md',
          personalMemory('superseded-target', 'Replaced knowledge.', {
            memoryId: 'tn_superseded_target',
            status: 'superseded',
          }),
        );
        const archiveDirectory = personalProjectDirectory(fixture, 'durable', 'threadnote', 'archived');
        yield* writePersonalRawAt(
          fixture,
          archiveDirectory,
          'archive-copy.md',
          personalMemory('archived-target', 'Retired knowledge.', {
            memoryId: 'tn_archived_target',
            status: 'archived',
          }),
        );

        const aggregate = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(TestClock.withLive);

        expect(aggregate).toMatchObject({exitCode: 1, knownFindings: 2, status: 'findings'});
        expect(aggregate.sources[0]).toMatchObject({recordsScanned: 1, state: 'complete'});
        expect(
          aggregate.findings.filter(finding => finding.findingId.startsWith('relation-target-inactive\0')),
        ).toHaveLength(2);
        expect(aggregate.findings.some(finding => finding.findingId.startsWith('relation-target-missing\0'))).toBe(
          false,
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('resolves legacy direct relations through canonical archived_from provenance', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture([]);
        const retiredUri = 'threadnote://user/tester/memories/durable/projects/threadnote/legacy-target.md';
        yield* writePersonalRaw(
          fixture,
          'threadnote',
          'source.md',
          personalMemory('source', 'Source depends on retired knowledge.', {
            relations: [{type: 'depends_on', uri: retiredUri}],
          }),
        );
        yield* writePersonalRawAt(
          fixture,
          personalProjectDirectory(fixture, 'durable', 'threadnote', 'archived'),
          'archive-copy.md',
          personalMemory('legacy-target', 'Retired knowledge.', {
            archivedFrom: retiredUri,
            status: 'archived',
          }),
        );

        const aggregate = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(TestClock.withLive);

        expect(aggregate).toMatchObject({exitCode: 1, knownFindings: 1, status: 'findings'});
        expect(aggregate.findings[0]?.findingId).toMatch(/^relation-target-inactive\0/u);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reads raw project identities from their canonical storage segment', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture(['platform']);
        const project = 'My Product';
        const segment = 'my-product';
        yield* writePersonalRaw(
          fixture,
          segment,
          'personal.md',
          personalMemory('personal', 'Personal project identity is preserved.', {project}),
        );
        const teamTarget = yield* teamProjectMemoryPath(fixture, 'platform', segment, 'shared');
        yield* fixture.fs.writeFileString(
          teamTarget,
          memory('shared', 'Shared project identity is preserved.', project),
        );
        yield* commitTeams(fixture);

        const aggregate = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project,
        }).pipe(TestClock.withLive);

        expect(aggregate).toMatchObject({completeSources: 2, exitCode: 0, project, status: 'clean'});
        expect(aggregate.sources).toEqual([
          expect.objectContaining({recordsScanned: 1, sourceKey: 'personal'}),
          expect.objectContaining({recordsScanned: 1, sourceKey: 'team:platform'}),
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('fails closed when a previously read personal file changes later in the same scan', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture([]);
        yield* writePersonalRaw(fixture, 'threadnote', 'a.md', personalMemory('a', 'First snapshot value.'));
        yield* writePersonalRaw(fixture, 'threadnote', 'b.md', personalMemory('b', 'Second snapshot value.'));
        const first = fixture.path.join(personalProjectDirectory(fixture, 'durable', 'threadnote'), 'a.md');
        const second = fixture.path.join(personalProjectDirectory(fixture, 'durable', 'threadnote'), 'b.md');
        let replaced = false;
        const racingFileSystem = FileSystem.FileSystem.of({
          ...fixture.fs,
          open: (file, options) =>
            Effect.gen(function* () {
              if ((file === second || file.endsWith('/b.md')) && !replaced) {
                replaced = true;
                yield* fixture.fs.writeFileString(first, personalMemory('a', 'Changed after its first read.'));
              }
              return yield* fixture.fs.open(file, options);
            }),
        });

        const aggregate = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(Effect.provideService(FileSystem.FileSystem, racingFileSystem), TestClock.withLive);

        expect(aggregate).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(aggregate.sources[0]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reports invalid configured-team selection without a collidable synthetic team', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture([]);
        const teams = Object.fromEntries(
          ['configured-teams', ...Array.from({length: 32}, (_, index) => `team-${index}`)].map(name => [
            name,
            {
              addedAt: '2026-09-18T00:00:00.000Z',
              gitdir: fixture.path.join(fixture.home, 'share', 'teams', `${name}.gitdir`),
              name,
              remote: `https://example.test/${name}.git`,
              worktree: fixture.path.join(fixture.home, 'share', 'worktrees', name),
            },
          ]),
        );
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.home, 'share', 'teams.json'),
          `${JSON.stringify({teams, version: 1})}\n`,
        );

        const aggregate = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(TestClock.withLive);

        expect(aggregate).toMatchObject({exitCode: 2, status: 'unknown', unknownSources: 1});
        expect(aggregate.sources).toContainEqual({
          reason: 'configured-teams-invalid',
          sourceKey: 'team-selection',
          state: 'unknown',
        });
        expect(aggregate.sources.some(source => source.sourceKey === 'team:configured-teams')).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects shared visibility in the personal namespace', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture([]);
        yield* writePersonalRaw(
          fixture,
          'threadnote',
          'shared-visibility.md',
          memory('shared-visibility', 'Personal snapshots must not trust shared visibility.'),
        );

        const aggregate = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(TestClock.withLive);

        expect(aggregate).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(aggregate.sources[0]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a tracked symbolic memory without reading its target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture(['platform']);
        const outside = fixture.path.join(fixture.home, 'outside.md');
        yield* fixture.fs.writeFileString(outside, memory('outside', 'Outside evidence must stay outside.'));
        const linked = yield* teamMemoryPath(fixture, 'platform', 'linked');
        yield* fixture.fs.symlink(outside, linked);
        yield* commitTeams(fixture);

        const aggregate = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
          teams: ['platform'],
        }).pipe(TestClock.withLive);

        expect(aggregate).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(aggregate.sources[1]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reads only canonical personal project paths and fails closed for malformed selected evidence', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture([]);
        yield* writePersonalMemory(fixture, 'personal', 'Agents must retain deterministic evidence.');
        yield* writePersonalRaw(fixture, 'other-project', 'broken.md', 'not a memory');

        const isolated = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(TestClock.withLive);
        expect(isolated).toMatchObject({exitCode: 0, status: 'clean'});
        expect(isolated.sources[0]).toMatchObject({recordsScanned: 1, state: 'complete'});

        yield* writePersonalRaw(
          fixture,
          'threadnote',
          'mismatch.md',
          personalMemory('mismatch', 'Mismatched metadata must fail closed.', {project: 'other-project'}),
        );
        const mismatched = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(TestClock.withLive);
        expect(mismatched).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(mismatched.sources[0]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});

        yield* writePersonalRaw(fixture, 'threadnote', 'mismatch.md', 'not a memory');
        const malformed = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(TestClock.withLive);
        expect(malformed).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(malformed.sources[0]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});

        yield* writePersonalRaw(
          fixture,
          'threadnote',
          'mismatch.md',
          personalMemory('mismatch', `Personal evidence must remain bounded.\n${'x'.repeat(8 * 1_024 * 1_024)}`),
        );
        const oversized = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'threadnote',
        }).pipe(TestClock.withLive);
        expect(oversized).toMatchObject({exitCode: 2, status: 'unknown'});
        expect(oversized.sources[0]).toMatchObject({reason: 'snapshot-unreadable', state: 'unknown'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('uses literal project pathspecs and disables lazy fetches for every aggregate Git read', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture(['platform']);
        const selected = yield* teamProjectMemoryPath(fixture, 'platform', 'project-1', 'selected');
        yield* fixture.fs.writeFileString(
          selected,
          memory('selected', 'Literal pathspecs must select this project only.', 'project[1]'),
        );
        yield* writeTeamProjectMemory(
          fixture,
          'platform',
          'project-1x',
          'sibling',
          'Glob-like project names must not select siblings.',
        );
        yield* commitTeams(fixture);
        const sibling = yield* teamProjectMemoryPath(fixture, 'platform', 'project-1x', 'untracked');
        yield* fixture.fs.writeFileString(
          sibling,
          memory('untracked', 'Unrelated dirty state stays unrelated.', 'project-1x'),
        );

        const command = yield* CommandExecutor;
        const invocations: Array<{
          readonly args: readonly string[];
          readonly environment: NodeJS.ProcessEnv | undefined;
        }> = [];
        const recording = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) =>
            Effect.sync(() => {
              if (executable === 'git') invocations.push({args: [...args], environment: options?.env});
            }).pipe(Effect.andThen(command.execute(executable, args, options))),
        });
        const aggregate = yield* collectContextHealthAggregate(fixture.config, {
          callerCwd: fixture.repository,
          project: 'project[1]',
          teams: ['platform'],
        }).pipe(Effect.provideService(CommandExecutor, recording), TestClock.withLive);

        expect(aggregate).toMatchObject({exitCode: 0, status: 'clean'});
        expect(aggregate.sources[1]).toMatchObject({recordsScanned: 1, state: 'complete'});
        const snapshotReads = invocations.filter(invocation => invocation.args.includes('--literal-pathspecs'));
        expect(snapshotReads.length).toBeGreaterThan(0);
        expect(snapshotReads.every(invocation => invocation.environment?.GIT_NO_LAZY_FETCH === '1')).toBe(true);
        expect(
          snapshotReads.every(invocation => {
            const configIndex = invocation.args.indexOf('-c');
            return configIndex >= 0 && invocation.args[configIndex + 1] === 'core.fsmonitor=false';
          }),
        ).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

interface Fixture {
  readonly config: RuntimeConfig;
  readonly fs: FileSystem.FileSystem;
  readonly home: string;
  readonly path: Path.Path;
  readonly repository: string;
  readonly worktrees: Readonly<Record<string, string>>;
}

function makeFixture(teams: readonly string[]) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-health-aggregate-'});
    const repository = path.join(home, 'caller');
    yield* fs.makeDirectory(repository, {recursive: true});
    yield* fs.writeFileString(path.join(repository, 'README.md'), '# Caller\n');
    yield* git(repository, ['init', '--quiet']);
    yield* configureGit(repository);
    yield* git(repository, ['add', '.']);
    yield* git(repository, ['commit', '--quiet', '--message', 'caller']);
    const worktrees: Record<string, string> = {};
    for (const team of teams) {
      const worktree = path.join(home, 'share', 'worktrees', team);
      worktrees[team] = worktree;
      yield* fs.makeDirectory(path.join(worktree, 'durable', 'projects', 'threadnote'), {recursive: true});
      yield* git(worktree, ['init', '--quiet']);
      yield* configureGit(worktree);
      yield* fs.writeFileString(path.join(worktree, 'README.md'), '# Team\n');
      yield* git(worktree, ['add', '.']);
      yield* git(worktree, ['commit', '--quiet', '--message', 'init']);
    }
    yield* fs.makeDirectory(path.join(home, 'share'), {recursive: true});
    yield* fs.writeFileString(
      path.join(home, 'share', 'teams.json'),
      `${JSON.stringify({
        teams: Object.fromEntries(
          teams.map(team => [
            team,
            {
              addedAt: '2026-09-18T00:00:00.000Z',
              gitdir: path.join(home, 'share', 'teams', `${team}.gitdir`),
              name: team,
              remote: `https://example.test/${team}.git`,
              worktree: worktrees[team],
            },
          ]),
        ),
        version: 1,
      })}\n`,
    );
    return {
      config: {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: path.join(home, 'threadnote.json'),
        user: 'tester',
      },
      fs,
      home,
      path,
      repository,
      worktrees,
    } satisfies Fixture;
  });
}

function configureGit(cwd: string) {
  return Effect.all(
    [
      git(cwd, ['config', 'user.email', 'threadnote@example.test']),
      git(cwd, ['config', 'user.name', 'Threadnote Test']),
    ],
    {concurrency: 1, discard: true},
  );
}

function git(cwd: string, args: readonly string[]) {
  return runCommandEffect('git', args, {cwd, maxOutputBytes: 1_048_576, timeoutMs: 30_000}).pipe(TestClock.withLive);
}

function writePersonalMemory(fixture: Fixture, topic: string, body: string) {
  return writePersonalRaw(fixture, 'threadnote', `${topic}.md`, personalMemory(topic, body));
}

function writePersonalRaw(fixture: Fixture, project: string, filename: string, content: string) {
  return writePersonalRawAt(fixture, personalProjectDirectory(fixture, 'durable', project), filename, content);
}

function personalProjectDirectory(
  fixture: Fixture,
  kind: 'durable' | 'handoff',
  project: string,
  status: MemoryMetadata['status'] = 'active',
) {
  return fixture.path.join(
    fixture.home,
    'data',
    fixture.config.account,
    'user',
    fixture.config.user,
    'memories',
    kind === 'durable' ? 'durable' : 'handoffs',
    kind === 'durable' && status === 'active' ? 'projects' : status,
    project,
  );
}

function writePersonalRawAt(fixture: Fixture, directory: string, filename: string, content: string) {
  const target = fixture.path.join(directory, filename);
  return Effect.gen(function* () {
    yield* fixture.fs.makeDirectory(fixture.path.dirname(target), {recursive: true});
    yield* fixture.fs.writeFileString(target, content);
  });
}

function writeLocalSharedCopy(fixture: Fixture, team: string, topic: string, body: string) {
  const target = fixture.path.join(
    fixture.home,
    'data',
    fixture.config.account,
    'user',
    fixture.config.user,
    'memories',
    'shared',
    team,
    'durable',
    'projects',
    'threadnote',
    `${topic}.md`,
  );
  return Effect.gen(function* () {
    yield* fixture.fs.makeDirectory(fixture.path.dirname(target), {recursive: true});
    yield* fixture.fs.writeFileString(target, memory(topic, body));
  });
}

function teamMemoryPath(fixture: Fixture, team: string, topic: string) {
  return teamProjectMemoryPath(fixture, team, 'threadnote', topic);
}

function teamProjectMemoryPath(fixture: Fixture, team: string, project: string, topic: string) {
  return Effect.gen(function* () {
    const worktree = fixture.worktrees[team];
    if (worktree === undefined) return yield* Effect.die(new Error(`Missing fixture team ${team}.`));
    const directory = fixture.path.join(worktree, 'durable', 'projects', project);
    yield* fixture.fs.makeDirectory(directory, {recursive: true});
    return fixture.path.join(directory, `${topic}.md`);
  });
}

function writeTeamMemory(fixture: Fixture, team: string, topic: string, body: string) {
  return Effect.flatMap(teamMemoryPath(fixture, team, topic), target =>
    fixture.fs.writeFileString(target, memory(topic, body)),
  );
}

function writeTeamProjectMemory(fixture: Fixture, team: string, project: string, topic: string, body: string) {
  return Effect.flatMap(teamProjectMemoryPath(fixture, team, project, topic), target =>
    fixture.fs.writeFileString(target, memory(topic, body, project)),
  );
}

function commitTeams(fixture: Fixture) {
  return Effect.forEach(
    Object.values(fixture.worktrees),
    worktree =>
      Effect.gen(function* () {
        yield* git(worktree, ['add', '.']);
        yield* git(worktree, ['commit', '--quiet', '--message', 'memories']);
      }),
    {concurrency: 1, discard: true},
  );
}

function memory(topic: string, body: string, project = 'threadnote'): string {
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId: `tn_${topic.replaceAll('-', '_')}`,
    project,
    schemaVersion: 5,
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-09-18T00:00:00.000Z',
    topic,
    visibility: 'shared',
  };
  return formatMemoryDocument('MEMORY', metadata, body);
}

function personalMemory(
  topic: string,
  body: string,
  overrides: Partial<MemoryMetadata> = {},
  title: 'MEMORY' | 'HANDOFF' = 'MEMORY',
): string {
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId: `tn_${topic.replaceAll('-', '_')}`,
    project: 'threadnote',
    schemaVersion: 5,
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-09-18T00:00:00.000Z',
    topic,
    visibility: 'personal',
    ...overrides,
  };
  return formatMemoryDocument(title, metadata, body);
}

function handoffMemory(topic: string, body: string, title: 'MEMORY' | 'HANDOFF' = 'HANDOFF'): string {
  const metadata: MemoryMetadata = {
    kind: 'handoff',
    memoryId: `tn_${topic.replaceAll('-', '_')}`,
    project: 'threadnote',
    schemaVersion: 5,
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-09-18T00:00:00.000Z',
    topic,
    visibility: 'personal',
  };
  return formatMemoryDocument(title, metadata, body);
}

function handoffMemoryOfByteLength(
  topic: string,
  byteLength: number,
  status: MemoryMetadata['status'] = 'active',
): string {
  const empty = handoffMemory(topic, '', 'HANDOFF').replace('status: active', `status: ${status}`);
  return handoffMemory(topic, 'x'.repeat(byteLength - empty.length), 'HANDOFF').replace(
    'status: active',
    `status: ${status}`,
  );
}
