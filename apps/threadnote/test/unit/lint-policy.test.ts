import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import {antipattern, correctness, effectNative, style} from '@effect/tsgo/oxlint-presets';
import * as FC from 'fast-check';
import {
  isEffectRuntimeMember,
  isNodeBuiltinSpecifier,
  isNodeEffectPackageSpecifier,
} from '../../../../config/lint/threadnote-plugin.js';
import {changedTypeScriptLines, LINT_TARGETS, STRICT_LINT_ARGUMENTS, lint} from '../../../../scripts/lint.js';

const EFFECT_PRESET_PATHS = [
  './node_modules/@effect/tsgo/oxlint-presets/correctness.json',
  './node_modules/@effect/tsgo/oxlint-presets/antipattern.json',
  './node_modules/@effect/tsgo/oxlint-presets/effect-native.json',
  './node_modules/@effect/tsgo/oxlint-presets/style.json',
] as const;

/** Official Effect rules that stay off because they rewrite non-Effect surfaces or default-off mega-channels. */
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

  it('runs one deterministic full-repository pass that rejects every warning', () => {
    const calls: Array<readonly string[]> = [];
    expect(
      lint(arguments_ => {
        calls.push(arguments_);
        return 0;
      }),
    ).toBe(0);
    expect(calls).toEqual([[...STRICT_LINT_ARGUMENTS, ...LINT_TARGETS]]);
    expect(STRICT_LINT_ARGUMENTS).toContain('--threads=1');
    expect(STRICT_LINT_ARGUMENTS).toContain('--deny-warnings');
    expect(STRICT_LINT_ARGUMENTS).toContain('--report-unused-disable-directives-severity=error');
  });

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
