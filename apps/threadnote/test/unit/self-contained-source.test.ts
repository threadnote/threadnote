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
    'apps/threadnote/src/semantic/host_catalog.ts',
    'apps/threadnote/src/semantic/doctor.ts',
    'apps/threadnote/src/semantic/coordinator.ts',
    'apps/threadnote/src/semantic/provider.ts',
    'apps/threadnote/src/semantic/providers/python.ts',
    'apps/threadnote/src/semantic/providers/python_project.ts',
    'apps/threadnote/src/semantic/providers/typescript.ts',
  ],
  path => ({path, content: readFileSync(path, 'utf8')}),
);

const fixtureDrainSources = EffectArray.map(
  ['apps/threadnote/src/recall/embedding_worker_process.ts', 'packages/inference/src/background/worker-control.ts'],
  path => ({path, content: readFileSync(path, 'utf8')}),
);

describe('self-contained source Python boundary', () => {
  it.each(workflowSources)('accepts only retained workflow ownership metadata in $path', ({path, content}) => {
    expect(hasUndeclaredPythonRuntimeReference(path, content)).toBe(false);
    expect(hasUndeclaredPythonRuntimeReference(path, Effect.pipe(content, EffectString.replaceAll('\n', '\r\n')))).toBe(
      false,
    );
  });

  it.each(fixtureDrainSources)('keeps fixture deadline documentation self-contained in $path', ({path, content}) => {
    expect(hasUndeclaredPythonRuntimeReference(path, content)).toBe(false);
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
            ...fixtureDrainSources,
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

  it('consumes only the singular host catalog slot without granting protocol or neighboring-path exceptions', () => {
    const catalog = EffectOption.getOrUndefined(
      EffectArray.findFirst(semanticSources, source => source.path === 'apps/threadnote/src/semantic/host_catalog.ts'),
    )!;
    expect(hasUndeclaredPythonRuntimeReference('apps/threadnote/src/semantic/other.ts', catalog.content)).toBe(true);
    for (const extra of [
      "const extra = {slot: 'python'};",
      "const extra = {language: 'python'};",
      "const extra = {languages: ['python']};",
    ])
      expect(hasUndeclaredPythonRuntimeReference(catalog.path, `${catalog.content}\n${extra}`)).toBe(true);
  });

  it('keeps operational catalog properties scoped to the exact doctor module', () => {
    const doctor = EffectOption.getOrUndefined(
      EffectArray.findFirst(semanticSources, source => source.path === 'apps/threadnote/src/semantic/doctor.ts'),
    )!;
    expect(hasUndeclaredPythonRuntimeReference('apps/threadnote/src/semantic/doctor_extra.ts', doctor.content)).toBe(
      true,
    );
  });

  it('scopes the TypeScript provider language discriminator to its exact source path', () => {
    const provider = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        semanticSources,
        source => source.path === 'apps/threadnote/src/semantic/providers/typescript.ts',
      ),
    )!;
    expect(
      hasUndeclaredPythonRuntimeReference('apps/threadnote/src/semantic/providers/other.ts', provider.content),
    ).toBe(true);
  });

  it('rejects escaped shell-quoted and argv-list Python invocations in the TypeScript provider', () => {
    const provider = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        semanticSources,
        source => source.path === 'apps/threadnote/src/semantic/providers/typescript.ts',
      ),
    )!;
    const examples = [
      String.raw`Bun.spawn(["sh", "-c", "\"python3\" -V"]);`,
      String.raw`Bun.spawn([
  'python',
  '-V',
]);`,
    ];
    expect(
      EffectArray.map(examples, example =>
        hasUndeclaredPythonRuntimeReference(provider.path, `${provider.content}\n${example}`),
      ),
    ).toEqual([true, true]);
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

  it('rejects generated quoted interpreter arguments in argv and shell-serialized source', () => {
    const provider = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        semanticSources,
        source => source.path === 'apps/threadnote/src/semantic/providers/typescript.ts',
      ),
    )!;
    fc.assert(
      fc.property(fc.constantFrom('python', 'Python3', 'python3.13', 'python.exe'), executable => {
        const shellCommand = `${JSON.stringify(executable)} -V`;
        const examples = [
          `Bun.spawn([\n  ${JSON.stringify(executable)},\n  '-V',\n]);`,
          `Bun.spawn(["sh", "-c", ${JSON.stringify(shellCommand)}]);`,
        ];
        expect(
          EffectArray.map(examples, example =>
            hasUndeclaredPythonRuntimeReference(provider.path, `${provider.content}\n${example}`),
          ),
        ).toEqual([true, true]);
      }),
      {numRuns: 32},
    );
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
    expect(hasUndeclaredNodeBuiltinImport('apps/threadnote/src/semantic/other.ts', content)).toBe(
      path !== 'apps/threadnote/src/semantic/lsp_transport.ts',
    );
  });

  it('rejects the removed Node spawn import at both the former LSP owner and neighboring paths', () => {
    const previous = "import {spawn, type ChildProcess} from 'node:child_process';";
    for (const path of ['apps/threadnote/src/semantic/lsp_transport.ts', 'apps/threadnote/src/semantic/other.ts'])
      expect(hasUndeclaredNodeBuiltinImport(path, previous)).toBe(true);
  });

  it('requires one live unchanged bootstrap capsule and its exact publication wiring', () => {
    const path = 'apps/threadnote/src/semantic/providers/python_project.ts';
    const source = readFileSync(path, 'utf8');
    const start = EffectString.indexOf('const pathProbe = ')(source);
    expect(start._tag).toBe('Some');
    if (start._tag !== 'Some') throw new Error('Missing current bootstrap');
    const end = EffectString.indexOf('\n/** Conservative static profile')(source);
    if (end._tag !== 'Some') throw new Error('Missing current bootstrap end');
    const capsule = EffectString.slice(start.value, end.value)(source);
    const mutations = [
      EffectString.replace(capsule, '')(source),
      source + '\n' + capsule,
      EffectString.replace(capsule, 'function nested() {\n' + capsule + '\n}')(source),
      EffectString.replace(
        capsule,
        EffectArray.join(
          EffectArray.map(EffectString.split('\n')(capsule), line => '// ' + line),
          '\n',
        ),
      )(source),
      EffectString.replace(capsule, 'const copiedCapsule = ' + JSON.stringify(capsule) + ';')(source),
      EffectString.replace('const versionProbe =', 'const intervening = 0;\nconst versionProbe =')(source),
      EffectString.replace(
        'd8a7c87965c4ad49200fda06dd4fb09f6229e65c4a188553889562c01c615510',
        EffectString.repeat(64)('0'),
      )(source),
      EffectString.replace(
        '5811c668ec7eb72ffad07fa10823ada5a40e9392137033a876850ac30ebd1230',
        EffectString.repeat(64)('0'),
      )(source),
      EffectString.replace("require('node:crypto')", "require('node:net')")(source),
      EffectString.replace('options.shell!==false', 'false')(source),
      EffectString.replace('${JSON.stringify(metadata)}', '${metadata}')(source),
      EffectString.replace('const deny=()=>', 'const extra=${JSON.stringify(marker)};\nconst deny=()=>')(source),
      EffectString.replace('syncBuiltinESMExports();', "cp.spawn('sh');syncBuiltinESMExports();")(source),
      EffectString.replace(
        capsule,
        "const pathProbe='x';const versionProbe='y';export function pythonProviderBootstrap(){return 'inert';}",
      )(source),
      EffectString.replace('pythonProviderBootstrap(payload, launcher, directory);', "'substituted';")(source),
      EffectString.replace(
        'pythonProviderBootstrap(payload, launcher, directory);',
        "pythonProviderBootstrap(payload, launcher, directory) + 'extra';",
      )(source),
      EffectString.replace('const sourceDigest =', "source += 'extra';\n  const sourceDigest =")(source),
      EffectString.replace(
        "fs.writeFileString(bootstrap, source, {flag: 'wx', mode: 0o600})",
        "fs.writeFileString(bootstrap, 'substituted', {flag: 'wx', mode: 0o600})",
      )(source),
      EffectString.replace("{flag: 'wx', mode: 0o600}", '{mode: 0o600}')(source),
      EffectString.replace(
        'const verifyBootstrap =',
        "yield* fs.writeFileString(bootstrap, source, {flag: 'wx', mode: 0o600});\n  const verifyBootstrap =",
      )(source),
      EffectString.replace("['--require', bootstrap]", "[bootstrap, '--require']")(source),
      EffectString.replace(
        'prefix: metadata.prefix, version: metadata.version};',
        'prefix: String(metadata.prefix), version: metadata.version};',
      )(source),
      source + '\nconst syntax = ;',
    ];
    for (const [index, content] of mutations.entries()) {
      expect(hasUndeclaredNodeBuiltinImport(path, content), 'closed Node capsule mutation ' + index).toBe(true);
      expect(hasUndeclaredPythonRuntimeReference(path, content), 'closed Python capsule mutation ' + index).toBe(true);
    }
    for (const neighbor of [
      'apps/threadnote/src/semantic/providers/other.ts',
      'apps/threadnote/src/semantic/providers/python_project_extra.ts',
    ]) {
      expect(hasUndeclaredNodeBuiltinImport(neighbor, source)).toBe(true);
      expect(hasUndeclaredPythonRuntimeReference(neighbor, source)).toBe(true);
    }
  });

  it('rejects alternate generator bindings while the frozen capsule and call text remain intact', () => {
    const path = 'apps/threadnote/src/semantic/providers/python_project.ts';
    const source = readFileSync(path, 'utf8');
    for (const shadow of [
      "const pythonProviderBootstrap = (..._args: readonly unknown[]) => 'inert substituted image';",
      "const {selected: pythonProviderBootstrap} = {selected: () => 'inert substituted image'};",
      "const [pythonProviderBootstrap] = [() => 'inert substituted image'];",
      'function ignored(pythonProviderBootstrap: unknown) {}',
      'try {} catch (pythonProviderBootstrap) {}',
    ]) {
      const content = EffectString.replace(
        '  const source = pythonProviderBootstrap(',
        shadow + '\n  const source = pythonProviderBootstrap(',
      )(source);
      expect(hasUndeclaredNodeBuiltinImport(path, content), shadow).toBe(true);
      expect(hasUndeclaredPythonRuntimeReference(path, content), shadow).toBe(true);
    }
    for (const content of [
      EffectString.replace("Effect.fn('semantic.makePythonProject')", "Effect.fn('different.owner')")(source),
      EffectString.replace('function* (options: {', 'function* (pythonProviderBootstrap: unknown, options: {')(source),
      source + '\nfunction ignored(makePythonProject: unknown) {}',
    ]) {
      expect(hasUndeclaredNodeBuiltinImport(path, content)).toBe(true);
      expect(hasUndeclaredPythonRuntimeReference(path, content)).toBe(true);
    }
  });

  it('rejects JSON intrinsic shadowing, aliasing and concrete mutation without executing the mutation', () => {
    const path = 'apps/threadnote/src/semantic/providers/python_project.ts';
    const source = readFileSync(path, 'utf8');
    for (const mutation of [
      "JSON.stringify = () => '0;process.exit(0);//';",
      "JSON['stringify'] = () => 'inert';",
      "JSON = {stringify: () => 'inert'};",
      "const JSON = {stringify: () => 'inert'};",
      "const {selected: JSON} = {selected: {stringify: () => 'inert'}};",
      'function ignored(JSON: unknown) {}',
      'try {} catch (JSON) {}',
      'const alias = JSON;',
      'const alias = JSON.stringify;',
      'delete JSON.stringify;',
      "Object.assign(JSON, {stringify: () => 'inert'});",
      "Object.defineProperty(JSON, 'stringify', {value: () => 'inert'});",
      "Reflect.set(JSON, 'stringify', () => 'inert');",
      "globalThis.JSON = {stringify: () => 'inert'};",
      "globalThis['JSON'] = {stringify: () => 'inert'};",
    ]) {
      const content = source + '\n' + mutation;
      expect(hasUndeclaredNodeBuiltinImport(path, content), mutation).toBe(true);
      expect(hasUndeclaredPythonRuntimeReference(path, content), mutation).toBe(true);
    }
  });

  it('rejects all standard global-object dependencies outside the reviewed capsule', () => {
    const path = 'apps/threadnote/src/semantic/providers/python_project.ts';
    const source = readFileSync(path, 'utf8');
    for (const root of ['globalThis', 'global', 'self', 'window']) {
      for (const extra of [
        `Object.defineProperty(${root}, 'JSON', {value: {stringify: () => '0;process.exit(0);//'}});`,
        `Reflect.set(${root}, 'JSON', {stringify: () => 'inert'});`,
        `const alias = ${root}; alias['JSON'] = {stringify: () => 'inert'};`,
        `const alias = ${root};`,
      ]) {
        const content = source + '\n' + extra;
        expect(hasUndeclaredNodeBuiltinImport(path, content), extra).toBe(true);
        expect(hasUndeclaredPythonRuntimeReference(path, content), extra).toBe(true);
      }
    }
  });

  it('rejects concrete additional loading and execution forms outside the reviewed bootstrap', () => {
    const path = 'apps/threadnote/src/semantic/providers/python_project.ts';
    const source = readFileSync(path, 'utf8');
    for (const extra of [
      "import cp from 'child_process';",
      "import 'fs';",
      "const extra = require('child_process');",
      "const extra = import('child_process');",
      "Bun.spawn(['sh']);",
      "Bun . spawn(['sh']);",
      "(eval)('inert');",
      "Bun.spawnSync(['sh']);",
      'Bun.$`echo inert`;',
      "process.dlopen(module, 'extra');",
      "process.getBuiltinModule('child_process');",
      "process.execve('/bin/sh', [], {});",
      "globalThis.process.binding('spawn_sync');",
      "eval('inert');",
      "Function('return 1')();",
      "new Function('return 1');",
      "module.require('child_process');",
    ]) {
      expect(hasUndeclaredNodeBuiltinImport(path, source + '\n' + extra), extra).toBe(true);
      expect(hasUndeclaredPythonRuntimeReference(path, source + '\n' + extra), extra).toBe(true);
    }
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
