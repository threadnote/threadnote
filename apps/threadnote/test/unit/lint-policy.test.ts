import {Array as EffectArray} from 'effect';
import {Record as EffectRecord, Schema} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import {antipattern, correctness, effectNative, style} from '@effect/tsgo/oxlint-presets';
import * as FC from 'fast-check';
import {
  isEffectRuntimeMember,
  isNodeBuiltinSpecifier,
  isNodeEffectPackageSpecifier,
} from '../../../../config/lint/threadnote-plugin.js';
import {LINT_TARGETS, STRICT_LINT_ARGUMENTS, lint} from '../../../../scripts/lint.js';

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

function presetRuleNames(rules: unknown): readonly string[] {
  return EffectRecord.keys(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(rules));
}

function officialEffectRules(): readonly string[] {
  return [
    ...new Set([
      ...presetRuleNames(correctness.rules ?? {}),
      ...presetRuleNames(antipattern.rules ?? {}),
      ...presetRuleNames(effectNative.rules ?? {}),
      ...presetRuleNames(style.rules ?? {}),
    ]),
  ].sort();
}

describe('lint policy', () => {
  it('enforces every official Effect lint category at error except documented application boundaries', async () => {
    const configSchema = Schema.Struct({
      extends: Schema.optionalKey(Schema.Array(Schema.String)),
      rules: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    });
    const baseConfig = Schema.decodeUnknownSync(configSchema)(
      await Bun.file(new URL('../../../../.oxlintrc.json', import.meta.url)).json(),
    );
    const strictConfig = Schema.decodeUnknownSync(configSchema)(
      await Bun.file(new URL('../../../../.oxlintrc.strict.json', import.meta.url)).json(),
    );
    const officialRules = officialEffectRules();
    const offRules = new Set<string>(EFFECT_APPLICATION_BOUNDARY_RULES);

    expect(baseConfig.extends).toEqual([...EFFECT_PRESET_PATHS]);
    expect(
      EffectArray.filter(officialRules, rule => !offRules.has(rule) && strictConfig.rules?.[rule] !== 'error'),
    ).toEqual([]);
    expect(EffectArray.filter(EFFECT_APPLICATION_BOUNDARY_RULES, rule => strictConfig.rules?.[rule] !== 'off')).toEqual(
      [],
    );
    expect(EffectArray.filter(EFFECT_APPLICATION_BOUNDARY_RULES, rule => baseConfig.rules?.[rule] !== 'off')).toEqual(
      [],
    );
    expect(strictConfig.rules?.['effecttsgo/node-builtin-import']).toBe('error');
    expect(strictConfig.rules?.['effecttsgo/global-date-in-effect']).toBe('error');
    expect(strictConfig.rules?.['effecttsgo/process-env-in-effect']).toBe('error');
    expect(baseConfig.rules?.['typescript/no-unsafe-type-assertion']).toBe('error');
    expect(strictConfig.rules?.['typescript/no-unsafe-type-assertion']).toBe('error');
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
    expect(STRICT_LINT_ARGUMENTS).toContain('typescript/no-unsafe-type-assertion');
  });

  it('runs lint first from the Bun pre-commit hook', async () => {
    const hook = await Bun.file(new URL('../../../../.husky/pre-commit', import.meta.url)).text();
    const packageJson = Schema.decodeUnknownSync(Schema.Struct({scripts: Schema.Record(Schema.String, Schema.String)}))(
      await Bun.file(new URL('../../../../package.json', import.meta.url)).json(),
    );

    expect(hook).toContain('bun run precommit');
    expect(packageJson.scripts?.precommit).toMatch(/^bun run lint(?:\s|&&)/);
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
