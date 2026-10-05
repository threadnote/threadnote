import {it as effectIt} from '@effect/vitest';
import {DateTime, Effect, FileSystem} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {readRecallFeedbackEvents, recordRecallFeedback} from '@threadnote/recall/feedback';
import {writeValueReportExport} from '@threadnote/threadnote/value_report/commands';
import {
  readLocalValueEvents,
  recordCodexResumePreloadValueEvent,
  recordContextBriefValueEvent,
} from '@threadnote/threadnote/value_report/events';
import {buildValueReportExportV1} from '@threadnote/threadnote/value_report/export';
import {aggregateValueReportV1} from '@threadnote/threadnote/value_report/index';
import {
  deleteValueReportData,
  pruneValueReportData,
  selectValueReportExportNames,
  VALUE_REPORT_STORAGE_DELETE_BATCH_SIZE,
} from '@threadnote/threadnote/value_report/storage';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('local value-report storage controls', () => {
  effectIt.effect('retains the privacy-safe continuation evidence classification', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-value-resume-'});
        yield* recordCodexResumePreloadValueEvent(home, {
          continuationEvidenceState: 'evidence-bearing',
          durationMilliseconds: 12,
          estimatedTokens: 120,
          evidenceState: 'degraded',
          outcome: 'injected',
          outputBytes: 480,
          timestamp: '2026-10-02T00:00:00.000Z',
        });

        expect(yield* readLocalValueEvents(home)).toEqual([
          {
            continuationEvidenceState: 'evidence-bearing',
            durationMilliseconds: 12,
            estimatedTokens: 120,
            evidenceState: 'degraded',
            kind: 'codex-resume-preload',
            outcome: 'injected',
            outputBytes: 480,
            timestamp: '2026-10-02T00:00:00.000Z',
            version: 1,
          },
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('selects every export deterministically beyond one deletion batch', () => {
    const exports = Array.from(
      {length: VALUE_REPORT_STORAGE_DELETE_BATCH_SIZE + 1},
      (_, index) => `threadnote-value-report-export-v1-${index.toString(16).padStart(24, '0')}.json`,
    );
    const entries = ['notes.txt', ...exports].reverse();

    expect(selectValueReportExportNames(entries)).toEqual(exports);
  });

  it('selects staged and complete managed artifacts independently of input order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.nat({max: 100_000}), {maxLength: 40}), ids => {
        const expected = ids
          .flatMap(id => {
            const digest = id.toString(16).padStart(24, '0');
            return [
              `threadnote-value-pilot-report-v1-${digest}.json`,
              `.threadnote-value-report-export-v1-${digest}.staging`,
            ];
          })
          .sort();
        const input = [...expected, 'caller-copy.json', '.unrelated.staging', 'report.json'].reverse();
        expect(selectValueReportExportNames(input)).toEqual(expected);
        expect(selectValueReportExportNames(selectValueReportExportNames(input))).toEqual(expected);
      }),
      {numRuns: 50},
    );
  });

  effectIt.effect('previews retention and deletion before applying bounded content-free mutations', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-value-storage-'});
        const feedback = (timestamp: string, uri: string) =>
          recordRecallFeedback(home, {
            action: 'applied',
            project: 'private-project',
            query: 'private query text',
            timestamp,
            uri,
          });
        const valueEvent = (timestamp: string) =>
          recordContextBriefValueEvent(home, {
            coverageGaps: 0,
            durationMilliseconds: 100,
            estimatedTokens: 10,
            project: 'private-project',
            requestedCodeAnchors: 1,
            resolvedCodeAnchors: 1,
            successful: true,
            timestamp,
          });
        yield* feedback('2026-09-20T00:00:00.000Z', 'threadnote://user/tester/memories/current.md');
        yield* feedback('2025-01-01T00:00:00.000Z', 'threadnote://user/tester/memories/expired.md');
        yield* valueEvent('2026-09-20T00:00:00.000Z');
        yield* valueEvent('2025-01-01T00:00:00.000Z');
        yield* writeValueReportExport(
          home,
          buildValueReportExportV1(
            aggregateValueReportV1({
              period: {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'},
            }),
          ),
        );

        const retentionPreview = yield* pruneValueReportData(home, {
          apply: false,
          now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-30T00:00:00.000Z')),
          retentionDays: 30,
        });
        expect(retentionPreview).toMatchObject({
          applied: false,
          feedback: {after: 1, before: 2, removed: 1},
          valueEvents: {after: 1, before: 2, removed: 1},
        });
        expect(yield* readRecallFeedbackEvents(home)).toHaveLength(2);
        expect(yield* readLocalValueEvents(home)).toHaveLength(2);

        const retentionApplied = yield* pruneValueReportData(home, {
          apply: true,
          now: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-30T00:00:00.000Z')),
          retentionDays: 30,
        });
        expect(retentionApplied.applied).toBe(true);
        expect(yield* readRecallFeedbackEvents(home)).toHaveLength(1);
        expect(yield* readLocalValueEvents(home)).toHaveLength(1);

        const deletionPreview = yield* deleteValueReportData(home, {
          apply: false,
          exports: true,
          feedback: true,
          valueEvents: true,
        });
        expect(deletionPreview).toMatchObject({
          applied: false,
          exports: {removed: 1, selected: true},
          feedback: {removed: 1, selected: true},
          valueEvents: {removed: 1, selected: true},
        });
        const serialized = JSON.stringify(deletionPreview);
        expect(serialized).not.toContain('private-project');
        expect(serialized).not.toContain('private query');
        expect(serialized).not.toContain('threadnote://');

        const deletionApplied = yield* deleteValueReportData(home, {
          apply: true,
          exports: true,
          feedback: true,
          valueEvents: true,
        });
        expect(deletionApplied.applied).toBe(true);
        expect(yield* readRecallFeedbackEvents(home)).toEqual([]);
        expect(yield* readLocalValueEvents(home)).toEqual([]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
