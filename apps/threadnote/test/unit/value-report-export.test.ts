import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {recordContextBriefValueEvent} from '@threadnote/threadnote/value_report/events';
import {recordRecallFeedback} from '@threadnote/recall/feedback';
import {CliOutput} from '@threadnote/threadnote/effect/cli/output';
import {captureConsole} from '@threadnote/threadnote/effect/console';

import {TestClock} from 'effect/testing';
import {parsePilotInput} from '@threadnote/threadnote/value_report/pilot/contract';
import {pilotInput} from '../helpers/value-pilot-fixture.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runValueReportExport, VALUE_REPORT_EXPORT_DIRECTORY} from '@threadnote/threadnote/value_report/commands';
import {
  buildValueReportExportV1,
  parseValueReportExportV1,
  serializeValueReportExportV1,
  VALUE_REPORT_EXPORT_SCHEMA,
} from '@threadnote/threadnote/value_report/export';
import {aggregateValueReportV1} from '@threadnote/threadnote/value_report/index';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const period = {from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z'} as const;
const forbiddenKeys = new Set([
  'memoryText',
  'path',
  'project',
  'query',
  'rawLogs',
  'repository',
  'repositoryName',
  'sourceFragment',
  'stableUserId',
  'userId',
]);

describe('redacted value-report export', () => {
  it('uses a closed export schema at every level', () => {
    const bundle = buildValueReportExportV1(aggregateValueReportV1({period}));
    expect(parseValueReportExportV1(bundle)).toEqual(bundle);
    expect(() => parseValueReportExportV1({...bundle, path: '/private/repository'})).toThrow();
    expect(() =>
      parseValueReportExportV1({...bundle, report: {...bundle.report, project: 'private-project'}}),
    ).toThrow();
    expect(() =>
      parseValueReportExportV1({
        ...bundle,
        report: {
          ...bundle.report,
          contextBrief: {...bundle.report.contextBrief, attempts: 0, successful: 1},
        },
      }),
    ).toThrow('successful briefs cannot exceed attempts');
  });

  it('serializes deterministically without forbidden keys or caller labels', () => {
    fc.assert(
      fc.property(
        fc.record({
          attempts: fc.integer({min: 0, max: 20_000}),
          completed: fc.integer({min: 0, max: 20_000}),
          opened: fc.integer({min: 0, max: 20_000}),
          projectSuffix: fc.string({
            minLength: 8,
            maxLength: 24,
            unit: fc.constantFrom(...'0123456789abcdef'),
          }),
          proposed: fc.integer({min: 0, max: 20_000}),
        }),
        input => {
          const project = `private-project-${input.projectSuffix}`;
          const report = aggregateValueReportV1({
            counts: {
              contextBrief: {attempts: input.attempts},
              health: {opened: input.opened},
              knowledgeDelta: {proposed: input.proposed},
              setup: {completed: input.completed},
            },
            period,
            project,
          });
          const bundle = buildValueReportExportV1(report);
          const reordered = {
            version: bundle.version,
            type: bundle.type,
            schema: bundle.schema,
            report: bundle.report,
          };
          const serialized = serializeValueReportExportV1(bundle);
          expect(serialized).toBe(serializeValueReportExportV1(reordered));
          expect(serialized).not.toContain(project);
          expect(EffectArray.filter([...objectKeys(JSON.parse(serialized))], key => forbiddenKeys.has(key))).toEqual(
            [],
          );
        },
      ),
      {numRuns: 50},
    );
  });

  effectIt.effect('previews without writing and applies the same private content-addressed bundle', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-value-export-'});
        const config = runtimeConfig(home);
        const options = {period: 7, project: 'private-project'} as const;

        const preview = yield* captureConsole(runValueReportExport(config, options));
        const previewBundle = parseValueReportExportV1(JSON.parse(preview.output));
        expect(previewBundle.schema).toBe(VALUE_REPORT_EXPORT_SCHEMA);
        expect(preview.output).not.toContain('private-project');
        expect(
          yield* fs.exists(path.join(home, ...Effect2.pipe(VALUE_REPORT_EXPORT_DIRECTORY, EffectString.split('/')))),
        ).toBe(false);

        const applied = yield* captureConsole(runValueReportExport(config, {...options, apply: true}));
        const outputPath = Effect2.pipe(
          applied.output,
          EffectString.match(/^Exported redacted ValueReportExportV1 to (.+)\.$/u),
          Effect2.Option.getOrElse(() => null),
        )?.[1];
        expect(outputPath).toBeDefined();
        expect(
          Effect2.pipe(outputPath, effectOptionalString =>
            effectOptionalString == null
              ? undefined
              : Effect2.pipe(
                  effectOptionalString,
                  EffectString.startsWith(
                    path.join(home, ...Effect2.pipe(VALUE_REPORT_EXPORT_DIRECTORY, EffectString.split('/'))),
                  ),
                ),
          ),
        ).toBe(true);
        expect(Effect2.pipe(yield* fs.readFileString(outputPath!), EffectString.trimEnd)).toBe(preview.output);
        expect((yield* fs.stat(outputPath!)).mode & 0o077).toBe(0);

        const repeated = yield* captureConsole(runValueReportExport(config, {...options, apply: true}));
        expect(repeated.output).toBe(applied.output);
      }),
    ).pipe(
      provideTestLayer(
        CliOutput.layer.pipe(Layer.provideMerge(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
      ),
    ),
  );
});

effectIt.effect('preserves rolling non-midnight periods and generates pilot-aligned absolute UTC exports', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'value-export-window-'});
      yield* TestClock.setTime(Date.parse('2026-09-01T15:24:00.000Z'));
      const rolling = yield* captureConsole(runValueReportExport(runtimeConfig(home), {period: 28}));
      expect(JSON.parse(rolling.output).report.period.to).toBe('2026-09-01T15:24:00.000Z');
      for (const timestamp of ['2026-08-03T00:00:00.000Z', '2026-08-30T23:59:59.999Z', '2026-08-31T00:00:00.000Z']) {
        yield* recordContextBriefValueEvent(home, {
          timestamp,
          coverageGaps: 0,
          durationMilliseconds: 1,
          estimatedTokens: 1,
          requestedCodeAnchors: 0,
          resolvedCodeAnchors: 0,
          successful: true,
        });
        yield* recordRecallFeedback(home, {
          timestamp,
          action: 'applied',
          query: 'synthetic boundary',
          uri: 'threadnote://user/tester/memories/test.md',
        });
      }
      const aligned = yield* captureConsole(
        runValueReportExport(runtimeConfig(home), {from: '2026-08-03', to: '2026-08-31'}),
      );
      const value = parseValueReportExportV1(JSON.parse(aligned.output));
      expect(value.report.contextBrief.attempts).toBe(2);
      expect(value.report.feedback.total).toBe(2);
      expect(value.report.period).toEqual({from: '2026-08-03T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z'});
      expect(parsePilotInput({...pilotInput(), sources: [{actor: 0, value}]}).sources).toHaveLength(1);
      for (const options of [
        {from: '2026-08-03'},
        {from: '2026-08-03', to: '2026-08-31', period: 28},
        {from: '2026-02-30', to: '2026-08-31'},
      ]) {
        expect((yield* Effect.result(runValueReportExport(runtimeConfig(home), options)))._tag).toBe('Failure');
      }
    }),
  ).pipe(
    provideTestLayer(CliOutput.layer.pipe(Layer.provideMerge(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)))),
  ),
);

function objectKeys(value: unknown, keys = new Set<string>()): ReadonlySet<string> {
  if (EffectArray.isArray(value)) {
    for (const item of value) objectKeys(item, keys);
    return keys;
  }
  if (typeof value !== 'object' || value === null) return keys;
  for (const [key, item] of EffectRecord.toEntries(value)) {
    keys.add(key);
    objectKeys(item, keys);
  }
  return keys;
}

function runtimeConfig(home: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user: 'tester',
  };
}
