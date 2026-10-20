import * as BunPath from '@effect/platform-bun/BunPath';
import {it as effectIt} from '@effect/vitest';
import {Context, Effect, Layer, Path, Schema} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {AGENT_CATALOG} from '@threadnote/integrations/catalog';
import {SystemInfo} from '@threadnote/platform/system';
import {
  legacyDevSkillsDiscoveryRoots,
  listDevSkillsTargets,
  resolveDevSkillsIdentity,
  resolveDevSkillsTarget,
} from '../../src/agent_integration/skill_targets.js';
import {getAgentAdapter} from '../../src/agent_integration/adapters.js';
import {resolveJsonAgentSkillPaths} from '../../src/agent_integration/surface_plan.js';
import type {DevSkillsSelector, DevSkillsTarget} from '../../src/dev_skills/contract.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

type Platform = 'darwin' | 'linux' | 'win32';
const config = {
  account: 'local',
  user: 'fixture',
  agentId: 'fixture',
  agentContextHome: '/unused-home',
  manifestPath: '/unused.yaml',
};
const platforms: readonly Platform[] = ['darwin', 'linux', 'win32'];
const expectedUserRoots: Record<string, string> = {
  'codex-cli': '.agents/skills',
  'codex-cloud': '.agents/skills',
  'cursor-cloud-personal': '.cursor/skills',
  'claude-code': '.claude/skills',
  'cursor-desktop': '.cursor/skills',
  'copilot-vscode': '.copilot/skills',
  'omp-agent': '.omp/agent/skills',
  'gemini-cli': '.gemini/skills',
  'qwen-code': '.qwen/skills',
  opencode: '.config/opencode/skills',
  'zeno-desktop': 'Library/Application Support/ai.zeno.desktop/config/opencode/skills',
  'amp-cli': '.agents/skills',
  'factory-droid': '.factory/skills',
  cline: '.cline/skills',
  'kiro-cli': '.kiro/skills',
  'devin-local': '.config/devin/skills',
  'junie-cli': '.junie/skills',
  'zed-native': '.agents/skills',
  'antigravity-cli': '.gemini/antigravity-cli/skills',
  'antigravity-ide': '.gemini/config/skills',
  kilo: '.kilo/skills',
  'windsurf-legacy': '.codeium/windsurf/skills',
};
const projectRoots: Record<string, string> = {
  opencode: '.opencode/skills',
  'kiro-cli': '.kiro/skills',
  'devin-local': '.devin/skills',
  'junie-cli': '.junie/skills',
  'roo-project': '.roo/skills',
};

const context = Effect.fn('test.skillTargets.context')(function* (
  platform: Platform,
  environment: NodeJS.ProcessEnv = {},
) {
  const system = yield* SystemInfo;
  const pathContext = yield* Layer.build(platform === 'win32' ? BunPath.layerWin32 : BunPath.layerPosix);
  const native = Context.get(pathContext, Path.Path);
  const home = platform === 'win32' ? 'C:\\Users\\Fixture' : '/home/fixture';
  const cwd = native.join(home, 'work', 'project');
  const path = Path.Path.of({...native, resolve: (...parts) => native.resolve(cwd, ...parts)});
  return {
    path,
    home,
    cwd,
    system: SystemInfo.of({
      ...system,
      platform,
      homeDirectory: home,
      currentDirectory: () => cwd,
      environment: () => environment,
    }),
  };
});
const run = Effect.fn('test.skillTargets.resolve')(function* (
  platform: Platform,
  selector: DevSkillsSelector,
  environment: NodeJS.ProcessEnv = {},
  recorded?: DevSkillsTarget,
) {
  const f = yield* context(platform, environment);
  // Deliberately no FileSystem, commands, templates, or application layer: even
  // unsupported/recorded target lookup must be pure and work in an absent home.
  return yield* resolveDevSkillsTarget(config, selector, recorded).pipe(
    Effect.provideService(Path.Path, f.path),
    Effect.provideService(SystemInfo, f.system),
  );
});
const provide = provideTestLayer(Layer.mergeAll(TestSystemInfoLayer, Path.layer));

describe('development native skill targets', () => {
  for (const entry of AGENT_CATALOG)
    for (const platform of platforms) {
      const capability = entry.devSkills;
      const scopes = capability.status === 'managed' ? capability.scopes : (['user'] as const);
      for (const scope of scopes)
        effectIt.effect(`${entry.id}/${scope}/${platform}`, () =>
          Effect.gen(function* () {
            if (capability.status === 'unsupported' || !capability.platforms.includes(platform)) {
              expect(yield* run(platform, {agent: entry.id, scope}).pipe(Effect.result)).toMatchObject({
                _tag: 'Failure',
              });
              return;
            }
            const f = yield* context(platform);
            const expected =
              scope === 'user'
                ? platform === 'win32' && entry.id === 'devin-local'
                  ? 'AppData/Roaming/devin/skills'
                  : expectedUserRoots[entry.id]
                : projectRoots[entry.id];
            expect(expected, `${entry.id} needs an independently authored fixture root`).toBeDefined();
            const target = yield* run(platform, {agent: entry.id, scope});
            expect(target).toMatchObject({
              surfaceId: entry.id,
              agentId: entry.agentId,
              profile: capability.profile,
              scope,
              layout: entry.id === 'antigravity-cli' ? 'flat' : 'directory',
              skillRoot: f.path.join(scope === 'user' ? f.home : f.cwd, ...expected.split('/')),
            });
            expect(target.cwd).toBe(scope === 'user' ? undefined : f.cwd);
            expect(target.discoveryRoots).toContain(target.skillRoot);
            expect(target.discoveryRoots.every(root => f.path.isAbsolute(root))).toBe(true);
          }).pipe(provide),
        );
    }

  it('projects capability status independently from readiness and without mutable catalog references', () => {
    const catalog = listDevSkillsTargets();
    expect(catalog).toHaveLength(AGENT_CATALOG.length);
    expect(catalog.find(entry => entry.surfaceId === 'cursor-cloud-personal')).toMatchObject({
      status: 'managed',
      scopes: ['user'],
    });
    fc.assert(
      fc.property(fc.integer({min: 0, max: catalog.length - 1}), fc.string({maxLength: 40}), (index, value) => {
        const changed = listDevSkillsTargets();
        changed[index].aliases.push(value);
        const selected = changed[index];
        if (selected.status === 'managed') {
          selected.scopes.pop();
          selected.platforms.reverse();
        }
        expect(listDevSkillsTargets()).toEqual(catalog);
      }),
      {numRuns: 40},
    );
  });

  effectIt.effect(
    'resolves aliases and personal identity without mutable roots and rejects cross-profile selectors',
    () =>
      Effect.gen(function* () {
        expect(yield* resolveDevSkillsIdentity({agent: 'codex'})).toEqual({
          surfaceId: 'codex-cli',
          agentId: 'codex',
          profile: 'desktop',
        });
        expect(yield* resolveDevSkillsIdentity({agent: 'codex', profile: 'codex-cloud-personal'})).toEqual({
          surfaceId: 'codex-cloud',
          agentId: 'codex',
          profile: 'codex-cloud-personal',
        });
        expect(yield* resolveDevSkillsIdentity({agent: 'cursor', profile: 'cursor-cloud-personal'})).toMatchObject({
          surfaceId: 'cursor-cloud-personal',
        });
        for (const selector of [
          {agent: 'codex-cloud', profile: 'desktop'},
          {agent: 'claude', profile: 'codex-cloud-personal'},
          {agent: 'cursor', profile: 'org'},
          {agent: 'unknown'},
        ])
          expect(yield* resolveDevSkillsIdentity(selector as DevSkillsSelector).pipe(Effect.result)).toMatchObject({
            _tag: 'Failure',
          });
      }),
  );

  effectIt.effect('rejects malformed or mismatched recorded target paths and layouts', () =>
    Effect.gen(function* () {
      const recorded = yield* run('linux', {agent: 'codex'});
      for (const changed of [
        {...recorded, profile: 'codex-cloud-personal' as const},
        {...recorded, layout: 'flat' as const},
        {...recorded, skillRoot: 'relative'},
        {...recorded, skillRoot: '/'},
        {...recorded, discoveryRoots: []},
        {...recorded, discoveryRoots: [recorded.skillRoot, 'relative']},
        {...recorded, cwd: '/unexpected-project'},
      ])
        expect(yield* run('linux', {agent: 'codex'}, {}, changed).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'target-conflict'},
        });
    }).pipe(provide),
  );

  effectIt.effect('keeps pinned OMP/JSON roots through env changes and rejects different identity/scope/project', () =>
    Effect.gen(function* () {
      for (const agent of ['omp', 'opencode', 'kiro', 'devin']) {
        const initial = yield* run(
          'linux',
          {agent},
          {
            OMP_PROFILE: 'first',
            OPENCODE_CONFIG_DIR: '/first',
            KIRO_HOME: '/kiro-first',
            XDG_CONFIG_HOME: '/xdg-first',
          },
        );
        expect(
          yield* run(
            'linux',
            {agent},
            {
              OMP_PROFILE: '../escape',
              OPENCODE_CONFIG_DIR: 'relative',
              KIRO_HOME: 'relative',
              XDG_CONFIG_HOME: 'relative',
            },
            initial,
          ),
        ).toEqual(initial);
        expect(yield* run('linux', {agent: 'codex'}, {}, initial).pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
      }
      const initial = yield* run('linux', {agent: 'devin', scope: 'project', cwd: '/first/project'});
      expect(yield* run('linux', {agent: 'devin', scope: 'local'}, {}, initial).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
      expect(
        yield* run('linux', {agent: 'devin', scope: 'project', cwd: '/another/project'}, {}, initial).pipe(
          Effect.result,
        ),
      ).toMatchObject({_tag: 'Failure'});
      const windows = yield* run('win32', {agent: 'devin', scope: 'project', cwd: 'C:\\Work\\Project'});
      expect(yield* run('win32', {agent: 'devin', scope: 'project', cwd: 'c:\\work\\project'}, {}, windows)).toEqual(
        windows,
      );
    }).pipe(provide),
  );

  effectIt.effect('honors custom roots and separates settings-only roots from skill discovery', () =>
    Effect.gen(function* () {
      const cases = [
        ['opencode', {OPENCODE_CONFIG_DIR: '/custom/open'}, '/custom/open/skills'],
        ['opencode', {XDG_CONFIG_HOME: '/custom/xdg'}, '/custom/xdg/opencode/skills'],
        ['kiro', {KIRO_HOME: '/custom/kiro'}, '/custom/kiro/skills'],
        ['omp', {OMP_PROFILE: 'named'}, '/home/fixture/.omp/profiles/named/agent/skills'],
        ['omp', {PI_PROFILE: 'named'}, '/home/fixture/.omp/profiles/named/agent/skills'],
        ['omp', {OMP_PROFILE: 'work.v2'}, '/home/fixture/.omp/profiles/work.v2/agent/skills'],
        ['omp', {PI_CODING_AGENT_DIR: '/custom/agent'}, '/custom/agent/skills'],
        ['cline', {CLINE_DATA_DIR: 'invalid-mcp-only'}, '/home/fixture/.cline/skills'],
        ['amp', {XDG_CONFIG_HOME: '/custom/xdg'}, '/home/fixture/.agents/skills'],
        ['kilo', {XDG_CONFIG_HOME: '/custom/xdg'}, '/home/fixture/.kilo/skills'],
      ] as const;
      for (const [agent, environment, expected] of cases)
        expect((yield* run('linux', {agent}, environment)).skillRoot).toBe(expected);
      expect((yield* run('win32', {agent: 'devin'}, {APPDATA: 'D:\\Roaming'})).skillRoot).toBe(
        'D:\\Roaming\\devin\\skills',
      );
      expect(
        (yield* run('win32', {agent: 'opencode'}, {OPENCODE_CONFIG_DIR: '\\\\server\\share\\open'})).skillRoot,
      ).toBe('\\\\server\\share\\open\\skills');
      for (const [agent, environment] of [
        ['opencode', {OPENCODE_CONFIG_DIR: 'relative'}],
        ['kiro', {KIRO_HOME: 'relative'}],
        ['omp', {OMP_PROFILE: '../escape'}],
      ] as const)
        expect(yield* run('linux', {agent}, environment).pipe(Effect.result)).toMatchObject({_tag: 'Failure'});
      expect(yield* run('win32', {agent: 'devin'}, {APPDATA: 'relative'}).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
      });
    }).pipe(provide),
  );

  effectIt.effect('bounds Codex and legacy-pack discovery and rejects org before target lookup', () =>
    Effect.gen(function* () {
      const target = yield* run('linux', {agent: 'codex-cloud'}, {CODEX_HOME: '/different/start-helper'});
      expect(target.discoveryRoots).toEqual(['/home/fixture/.agents/skills', '/home/fixture/.codex/skills']);
      expect(yield* legacyDevSkillsDiscoveryRoots(target)).toEqual([
        '/home/fixture/.agents/skills/threadnote',
        '/home/fixture/.agents/skills/threadnote-packs',
        '/home/fixture/.codex/skills/threadnote',
        '/home/fixture/.codex/skills/threadnote-packs',
      ]);
      for (const environment of [
        {THREADNOTE_CURSOR_CLOUD_MODE: 'org'},
        {THREADNOTE_CURSOR_MEMORY_ENDPOINT: 'https://example.invalid'},
        {THREADNOTE_MCP_TOOLSET: 'cursor-cloud-local'},
      ])
        expect(yield* run('linux', {agent: 'cursor'}, environment).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'unsupported-profile'},
        });
      expect(yield* run('linux', {agent: 'claude', scope: 'local'}).pipe(Effect.result)).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'unsupported-scope'},
      });
    }).pipe(provide),
  );

  effectIt.effect.prop(
    'normalizes equivalent declared project paths deterministically',
    {
      names: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 1000}))).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(4),
      ),
    },
    ({names}) =>
      Effect.gen(function* () {
        for (const platform of platforms) {
          const f = yield* context(platform);
          const cwd = f.path.join(f.home, ...names.map(value => `part-${value}`));
          const first = yield* run(platform, {agent: 'roo', cwd});
          const second = yield* run(platform, {agent: 'roo', cwd: f.path.join(cwd, 'ignored', '..')});
          expect(first).toEqual(second);
          expect(yield* run(platform, {agent: 'roo', cwd}, {}, first)).toEqual(first);
        }
      }).pipe(provide),
    {arbitrary: {runs: 20}},
  );

  effectIt.effect('extracts JSON roots without an MCP document/template filesystem dependency', () =>
    Effect.gen(function* () {
      const adapter = getAgentAdapter('opencode')!;
      expect(yield* resolveJsonAgentSkillPaths(adapter.json!, 'project', {cwd: '/repo'})).toMatchObject({
        root: '/repo',
        skillRoot: '/repo/.opencode/skills',
        cwd: '/repo',
      });
    }).pipe(provide),
  );
});
