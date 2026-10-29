import {Array as EffectArray} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdtemp, readFile, rm, stat} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {parseValueReportExportV1, VALUE_REPORT_EXPORT_SCHEMA} from '@threadnote/threadnote/value_report/export';
import {afterEach, describe, expect, it} from 'vitest';
import {promisify} from 'node:util';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const execFilePromise = promisify(execFile);
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
});

describe('value report export CLI', () => {
  it('keeps report behavior and exposes preview/apply export beneath it', async () => {
    const home = await makeHome();
    const report = await runCli(['value', 'report', '--period', '1', '--json'], home);
    expect(JSON.parse(report.stdout)).toMatchObject({scope: 'local', type: 'value-report', version: 1});

    const preview = await runCli(['value', 'report', 'export', '--project', 'private-project', '--period', '1'], home);
    const bundle = parseValueReportExportV1(JSON.parse(preview.stdout));
    expect(bundle.schema).toBe(VALUE_REPORT_EXPORT_SCHEMA);
    expect(preview.stdout).not.toContain('private-project');
    await expect(stat(join(home, 'exports', 'value-reports'))).rejects.toThrow();

    const aligned = await runCli(['value', 'report', 'export', '--from', '2026-08-03', '--to', '2026-08-31'], home);
    expect(parseValueReportExportV1(JSON.parse(aligned.stdout)).report.period).toEqual({
      from: '2026-08-03T00:00:00.000Z',
      to: '2026-08-31T00:00:00.000Z',
    });

    const applied = await runCli(
      ['value', 'report', 'export', '--project', 'private-project', '--period', '1', '--apply'],
      home,
    );
    const outputPath = Effect.pipe(applied.stdout, __effectPipeInput => {
      const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.trim);
      const __effectPipeStage1 = Effect.pipe(
        __effectPipeStage0,
        EffectString.match(/^Exported redacted ValueReportExportV1 to (.+)\.$/u),
        Effect.Option.getOrElse(() => null),
      );
      return __effectPipeStage1;
    })?.[1];
    expect(outputPath).toBeDefined();
    expect(
      Effect.pipe(outputPath, effectOptionalString =>
        effectOptionalString == null
          ? undefined
          : Effect.pipe(effectOptionalString, EffectString.startsWith(join(home, 'exports', 'value-reports'))),
      ),
    ).toBe(true);
    const exported = await readFile(outputPath!, 'utf8');
    expect(parseValueReportExportV1(JSON.parse(exported))).toMatchObject({
      schema: VALUE_REPORT_EXPORT_SCHEMA,
      type: 'threadnote-value-report-export',
      version: 1,
    });
    expect(exported).not.toContain('private-project');

    const retention = await runCli(['value', 'report', 'retention', '--days', '30'], home);
    expect(JSON.parse(retention.stdout)).toMatchObject({
      applied: false,
      retentionDays: 30,
      type: 'value-report-retention',
    });

    const deletionPreview = await runCli(['value', 'report', 'delete', '--exports'], home);
    expect(JSON.parse(deletionPreview.stdout)).toMatchObject({
      applied: false,
      exports: {removed: 1, selected: true},
      type: 'value-report-deletion',
    });
    expect(await stat(outputPath!)).toBeDefined();

    const deletionApplied = await runCli(['value', 'report', 'delete', '--exports', '--apply'], home);
    expect(JSON.parse(deletionApplied.stdout)).toMatchObject({
      applied: true,
      exports: {removed: 1, selected: true},
    });
    await expect(stat(outputPath!)).rejects.toThrow();
  });
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-value-report-export-cli-'));
  homes.push(home);
  return home;
}

function runCli(args: readonly string[], home: string) {
  return execFilePromise(
    process.execPath,
    [join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'), ...args],
    {
      env: {...process.env, NO_COLOR: '1', THREADNOTE_HOME: home, THREADNOTE_USER: 'local'},
    },
  );
}
