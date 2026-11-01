import {Array as EffectArray} from 'effect';
import {readFileSync} from '@threadnote/testing/node-fs';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  hasUndeclaredNodeBuiltinImport,
  hasUndeclaredPythonRuntimeReference,
} from '../../../../scripts/effect/self-contained-source.js';
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
const semanticSources = EffectArray.map(
  [
    'apps/threadnote/src/effect/semantic_cli.ts',
    'apps/threadnote/src/semantic/coordinator.ts',
    'apps/threadnote/src/semantic/provider.ts',
    'apps/threadnote/src/semantic/providers/python.ts',
    'apps/threadnote/src/semantic/providers/python_project.ts',
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

  it.each(semanticSources)('accepts owned static language metadata in $path', ({path, content}) => {
    expect(hasUndeclaredPythonRuntimeReference(path, content)).toBe(false);
    expect(hasUndeclaredPythonRuntimeReference(path, Effect.pipe(content, EffectString.replaceAll('\n', '\r\n')))).toBe(
      false,
    );
  });

  it('consumes the public catalog language declaration only once and only at its owned path', () => {
    const catalog = EffectOption.getOrUndefined(
      EffectArray.findFirst(semanticSources, source => source.path === 'apps/threadnote/src/effect/semantic_cli.ts'),
    )!;
    expect(hasUndeclaredPythonRuntimeReference('apps/threadnote/src/effect/other.ts', catalog.content)).toBe(true);
    for (const extra of ["const extra = {languages: ['python']};", "const extra = {language: 'python'};"])
      expect(hasUndeclaredPythonRuntimeReference(catalog.path, `${catalog.content}\n${extra}`)).toBe(true);
  });

  it('still rejects added interpreter commands in every semantic metadata source', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', '/usr/bin/', './tools/', 'C:\\Python\\', 'C:\\Program Files\\Python\\'),
        fc.integer({min: 1, max: 99}),
        fc.integer({min: 0, max: 99}),
        fc.boolean(),
        fc.constantFrom('', '.exe', '.EXE'),
        fc.constantFrom('', ' -c "pass"', ' -m module', '; echo done'),
        fc.constantFrom('', 'env '),
        (prefix, major, minor, uppercase, suffix, args, shellPrefix) => {
          const command =
            shellPrefix + prefix + (uppercase ? 'Python' : 'python') + major + '.' + minor + suffix + args;
          for (const {path, content} of semanticSources)
            expect(
              hasUndeclaredPythonRuntimeReference(path, `${content}\nspawn(${JSON.stringify(command)}, ['app.py']);`),
            ).toBe(true);
        },
      ),
      {numRuns: 32},
    );
    for (const command of [
      'python',
      'python.exe',
      'python3.13.exe',
      'C:\\Python\\PYTHON.EXE',
      'C:\\Program Files\\Python\\python3.13.exe',
      'python3 -c "pass"',
      'env python3 -m module',
      'python3; echo done',
    ])
      for (const {path, content} of semanticSources)
        expect(
          hasUndeclaredPythonRuntimeReference(path, `${content}\nspawn(${JSON.stringify(command)}, ['app.py']);`),
        ).toBe(true);
  });
});

describe('self-contained source Node boundary', () => {
  const sources = EffectArray.map(
    ['apps/threadnote/src/semantic/lsp_transport.ts', 'apps/threadnote/src/semantic/providers/python_project.ts'],
    path => ({path, content: readFileSync(path, 'utf8')}),
  );

  it.each(sources)('accepts only the declared boundary in $path', ({path, content}) => {
    expect(hasUndeclaredNodeBuiltinImport(path, content)).toBe(false);
    expect(hasUndeclaredNodeBuiltinImport(path, Effect.pipe(content, EffectString.replaceAll('\n', '\r\n')))).toBe(
      false,
    );
    expect(hasUndeclaredNodeBuiltinImport('apps/threadnote/src/semantic/other.ts', content)).toBe(true);
  });

  it('rejects additional static, side-effect, dynamic and require imports even in owned boundaries', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('fs', 'crypto', 'child_process', 'url', 'net'),
        fc.constantFrom('static', 'side-effect', 'dynamic', 'require'),
        (module, form) => {
          const extra =
            form === 'static'
              ? `import * as extra from 'node:${module}';`
              : form === 'side-effect'
                ? `import 'node:${module}';`
                : form === 'dynamic'
                  ? `const extra = import('node:${module}');`
                  : `const extra = require('node:${module}');`;
          for (const {path, content} of sources)
            expect(hasUndeclaredNodeBuiltinImport(path, content + '\n' + extra)).toBe(true);
          expect(hasUndeclaredNodeBuiltinImport('apps/threadnote/src/other.ts', extra)).toBe(true);
        },
      ),
      {numRuns: 32},
    );
  });
});
