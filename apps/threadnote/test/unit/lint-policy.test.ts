import {String as EffectString} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import {antipattern, correctness, effectNative, style} from '@effect/tsgo/oxlint-presets';
import * as FC from 'fast-check';
import {
  isEffectRuntimeMember,
  isNodeBuiltinSpecifier,
  isNodeEffectPackageSpecifier,
} from '../../../../config/lint/threadnote-plugin.js';
import {
  changedTypeScriptLines,
  INCREMENTAL_LINT_RULES,
  lintDiagnosticApplies,
  LINT_TARGETS,
  STRICT_LINT_ARGUMENTS,
  lint,
} from '../../../../scripts/lint.js';

const EFFECT_PRESET_PATHS = [
  './node_modules/@effect/tsgo/oxlint-presets/correctness.json',
  './node_modules/@effect/tsgo/oxlint-presets/antipattern.json',
  './node_modules/@effect/tsgo/oxlint-presets/effect-native.json',
  './node_modules/@effect/tsgo/oxlint-presets/style.json',
] as const;

/** Explicit application boundaries that cannot use the corresponding Effect API. */
const EFFECT_APPLICATION_BOUNDARY_RULES = [
  'effecttsgo/any-unknown-in-error-context',
  'effecttsgo/async-function',
  'effecttsgo/global-date',
  'effecttsgo/global-fetch',
  'effecttsgo/global-timers',
  'effecttsgo/missing-pipeable-signature',
  'effecttsgo/prefer-schema-over-json',
  'effecttsgo/process-env',
  'effecttsgo/schema-sync',
  'effecttsgo/strict-boolean-expressions',
  'effecttsgo/unstable-api-usage',
] as const;

function officialEffectRules(): readonly string[] {
  return [
    ...new Set([
      ...Object.keys(correctness.rules ?? {}),
      ...Object.keys(antipattern.rules ?? {}),
      ...Object.keys(effectNative.rules ?? {}),
      ...Object.keys(style.rules ?? {}),
    ]),
  ].sort();
}

describe('lint policy', () => {
  it('enforces every official Effect lint category at error except documented application boundaries', async () => {
    const baseConfig = (await Bun.file(new URL('../../../../.oxlintrc.json', import.meta.url)).json()) as {
      readonly extends?: readonly string[];
      readonly rules?: Readonly<Record<string, string>>;
    };
    const strictConfig = (await Bun.file(new URL('../../../../.oxlintrc.strict.json', import.meta.url)).json()) as {
      readonly rules?: Readonly<Record<string, string>>;
    };
    const officialRules = officialEffectRules();
    const offRules = new Set<string>(EFFECT_APPLICATION_BOUNDARY_RULES);

    expect(baseConfig.extends).toEqual([...EFFECT_PRESET_PATHS]);
    expect(officialRules.filter(rule => !offRules.has(rule) && strictConfig.rules?.[rule] !== 'error')).toEqual([]);
    expect(EFFECT_APPLICATION_BOUNDARY_RULES.filter(rule => strictConfig.rules?.[rule] !== 'off')).toEqual([]);
    expect(EFFECT_APPLICATION_BOUNDARY_RULES.filter(rule => baseConfig.rules?.[rule] !== 'off')).toEqual([]);
    expect(strictConfig.rules?.['effecttsgo/node-builtin-import']).toBe('error');
    expect(strictConfig.rules?.['effecttsgo/global-date-in-effect']).toBe('error');
    expect(strictConfig.rules?.['effecttsgo/process-env-in-effect']).toBe('error');
  });

  fcProp(
    it,
    'documents only official Effect rules as application boundaries',
    {rule: FC.constantFrom(...EFFECT_APPLICATION_BOUNDARY_RULES)},
    ({rule}) => {
      expect(officialEffectRules()).toContain(rule);
    },
  );

  it('runs one deterministic full-repository pass that rejects every warning', async () => {
    const calls: Array<readonly string[]> = [];
    expect(
      await lint(arguments_ => {
        calls.push(arguments_);
        return 0;
      }),
    ).toBe(0);
    expect(calls).toEqual([[...STRICT_LINT_ARGUMENTS, ...LINT_TARGETS]]);
    expect(STRICT_LINT_ARGUMENTS).toContain('--threads=1');
    expect(STRICT_LINT_ARGUMENTS).toContain('--deny-warnings');
    expect(STRICT_LINT_ARGUMENTS).toContain('--report-unused-disable-directives-severity=error');
  });

  it('keeps existing debt separate while enforcing every new-file and unrelated-rule diagnostic', () => {
    const diagnostic = {
      code: 'effecttsgo(prefer-effect-array)',
      filename: 'scripts/example.ts',
      labels: [{span: {line: 3, column: 1}}],
    };
    expect(lintDiagnosticApplies(diagnostic, new Map())).toBe(false);
    expect(lintDiagnosticApplies(diagnostic, new Map([[diagnostic.filename, new Set([2])]]))).toBe(false);
    expect(lintDiagnosticApplies(diagnostic, new Map([[diagnostic.filename, new Set([3])]]))).toBe(true);
    expect(lintDiagnosticApplies(diagnostic, new Map([[diagnostic.filename, new Set()]]))).toBe(true);
    expect(lintDiagnosticApplies({...diagnostic, code: 'effecttsgo(floating-effect)'}, new Map())).toBe(true);
    expect(lintDiagnosticApplies({...diagnostic, code: undefined}, new Map())).toBe(true);
  });

  fcProp(
    it,
    'enforces incremental diagnostics exactly on changed lines',
    {
      rule: FC.constantFrom(...INCREMENTAL_LINT_RULES),
      line: FC.integer({min: 1, max: 200}),
      lines: FC.uniqueArray(FC.integer({min: 1, max: 200}), {minLength: 1, maxLength: 30}),
    },
    ({rule, line, lines}) => {
      const changed = new Set(lines);
      expect(
        lintDiagnosticApplies(
          {code: rule, filename: 'example.ts', labels: [{span: {line, column: 1}}]},
          new Map([['example.ts', changed]]),
        ),
      ).toBe(changed.has(line));
    },
  );

  it('runs lint first from the Bun pre-commit hook', async () => {
    const hook = await Bun.file(new URL('../../../../.husky/pre-commit', import.meta.url)).text();
    const packageJson = (await Bun.file(new URL('../../../../package.json', import.meta.url)).json()) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };

    expect(hook).toContain('bun run precommit');
    expect(packageJson.scripts?.precommit).toMatch(/^bun run lint(?:\s|&&)/);
  });

  it('tracks only added TypeScript lines for the unsafe-assertion regression gate', () => {
    const changed = changedTypeScriptLines(
      [
        'diff --git a/src/example.ts b/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -4,2 +4,3 @@',
        ' keep();',
        '-old();',
        '+next();',
        '+added();',
      ].join('\n'),
    );
    expect([...(changed.get('src/example.ts') ?? [])]).toEqual([5, 6]);
  });

  it.each(['packages/example/λ.ts', 'packages/example/a b.ts', 'packages/example/a\tb.ts'])(
    'enforces diagnostics on Git paths with Unicode, spaces or quoted controls: %s',
    path => {
      const header = EffectString.includes('\t')(path) ? JSON.stringify(`b/${path}`) : `b/${path}`;
      const changed = changedTypeScriptLines(`+++ ${header}\n@@ -0,0 +1 @@\n+added();`);
      expect(changed.get(path)).toEqual(new Set([1]));
      expect(
        lintDiagnosticApplies(
          {code: 'effecttsgo(prefer-effect-array)', filename: path, labels: [{span: {line: 1, column: 1}}]},
          changed,
        ),
      ).toBe(true);
    },
  );

  fcProp(it, 'recognizes every explicit node: import as Node-specific', {specifier: FC.string()}, ({specifier}) => {
    expect(isNodeBuiltinSpecifier(`node:${specifier}`)).toBe(true);
  });

  it('recognizes bare built-ins and Effect Node adapters without rejecting ordinary packages', () => {
    expect(isNodeBuiltinSpecifier('fs/promises')).toBe(true);
    expect(isNodeBuiltinSpecifier('node:test/reporters')).toBe(true);
    expect(isNodeBuiltinSpecifier('fs-extra')).toBe(false);
    expect(isNodeEffectPackageSpecifier('@effect/platform-node/NodeRuntime')).toBe(true);
    expect(isNodeEffectPackageSpecifier('@effect/platform-bun/BunRuntime')).toBe(false);
  });

  it('covers Effect execution and runtime construction APIs', () => {
    expect(isEffectRuntimeMember('Effect', 'runPromiseExit')).toBe(true);
    expect(isEffectRuntimeMember('Runtime', 'makeRunMain')).toBe(true);
    expect(isEffectRuntimeMember('ManagedRuntime', 'make')).toBe(true);
    expect(isEffectRuntimeMember('BunRuntime', 'runMain')).toBe(true);
    expect(isEffectRuntimeMember('Effect', 'flatMap')).toBe(false);
  });
});
