import {Array as EffectArray} from 'effect';
import {readFileSync} from '@threadnote/testing/node-fs';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {hasUndeclaredPythonRuntimeReference} from '../../../../scripts/effect/self-contained-source.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const workflowSources = EffectArray.map(
  [
    'apps/threadnote/src/dev_skills/contract.ts',
    'apps/threadnote/src/dev_skills/manifest.ts',
    'apps/threadnote/src/dev_skills/readiness.ts',
    'packages/manager/src/dev_skills/contracts.ts',
  ],
  path => ({path, content: readFileSync(path, 'utf8')}),
);

describe('self-contained source Python boundary', () => {
  it.each(workflowSources)('accepts only retained workflow ownership metadata in $path', ({path, content}) => {
    expect(hasUndeclaredPythonRuntimeReference(path, content)).toBe(false);
    expect(hasUndeclaredPythonRuntimeReference(path, Effect.pipe(content, EffectString.replaceAll('\n', '\r\n')))).toBe(
      false,
    );
  });

  it('rejects Python execution added to every workflow metadata source or another runtime file', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom('python', 'python3', 'Python'),
          fc
            .tuple(fc.integer({min: 1, max: 99}), fc.integer({min: 0, max: 99}))
            .map(([major, minor]) => `python${major}.${minor}`),
        ),
        command => {
          for (const {path, content} of [
            ...workflowSources,
            {path: 'apps/threadnote/src/threadnote.ts', content: ''},
          ]) {
            expect(hasUndeclaredPythonRuntimeReference(path, `${content}\nspawn('${command}', ['app.py']);`)).toBe(
              true,
            );
          }
        },
      ),
      {numRuns: 32},
    );
  });

  it('rejects interpreter probes and prerequisites even in workflow metadata files', () => {
    const readiness = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        workflowSources,
        __effectArrayValue =>
          !!(source => Effect.pipe(source.path, EffectString.endsWith('/readiness.ts')))(__effectArrayValue),
      ),
    )!;
    expect(
      hasUndeclaredPythonRuntimeReference(
        readiness.path,
        `${readiness.content}\nconst python = findWorkingExecutable(['python3']).pipe(Effect.orElseSucceed(() => undefined));`,
      ),
    ).toBe(true);
    for (const contract of EffectArray.filter(workflowSources, source => /\/contracts?\.ts$/u.test(source.path)))
      for (const field of ['readonly python?: string;', 'readonly python: string;'])
        expect(
          hasUndeclaredPythonRuntimeReference(
            contract.path,
            Effect.pipe(
              contract.content,
              EffectString.replace('readonly prerequisites: {', `readonly prerequisites: {\n    ${field}`),
            ),
          ),
        ).toBe(true);
    const manifest = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        workflowSources,
        __effectArrayValue =>
          !!(source => Effect.pipe(source.path, EffectString.endsWith('/manifest.ts')))(__effectArrayValue),
      ),
    )!;
    expect(
      hasUndeclaredPythonRuntimeReference(
        manifest.path,
        Effect.pipe(manifest.content, EffectString.replace("python: '>=3.10'", "python: '>=3.11'")),
      ),
    ).toBe(true);
  });

  it('rejects undeclared metadata in a neighboring file', () => {
    expect(
      hasUndeclaredPythonRuntimeReference('apps/threadnote/src/dev_skills/new.ts', "const python = 'required';"),
    ).toBe(true);
  });

  it('preserves existing migration and language metadata exceptions', () => {
    expect(
      hasUndeclaredPythonRuntimeReference('packages/manager/src/memory_editor_languages.ts', "python: 'Python'"),
    ).toBe(false);
    expect(
      hasUndeclaredPythonRuntimeReference('apps/threadnote/src/migration/legacy-installations.ts', "'python'"),
    ).toBe(false);
  });
});
