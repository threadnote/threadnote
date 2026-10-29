import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {AGENT_ADAPTERS, getAgentAdapter} from '@threadnote/threadnote/agent_integration/adapters';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {isJsonObject} from '@threadnote/platform/json';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {
  GUIDANCE_BLOCK_START,
  guidanceBlock,
  guidanceHealthEvidence,
  guidanceImportReviewId,
  hasMalformedGuidanceBlock,
  normalizeGuidanceImportPath,
  parseGuidanceReceiptV1,
  parseGuidanceReceiptV2,
  removeGuidanceBlock,
  renderManagedGuidanceBlock,
  runGuidanceImport,
  runGuidanceProject,
  runGuidanceRemove,
  runGuidanceStatus,
  stripThreadnoteManagedGuidance,
  upsertGuidanceBlock,
} from '@threadnote/threadnote/guidance/index';
import {listCandidateReviews} from '@threadnote/memory/candidate';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {runRemember} from '@threadnote/threadnote/memory/index';
import {localMemoryPathForUri} from '@threadnote/threadnote/memory/migrations';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runCommand} from '@threadnote/threadnote/utils';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const first = {
  contentHash: Effect2.pipe('a', EffectString.repeat(64)),
  text: 'Use reviewed context.',
  uri: 'threadnote://memory/a',
};
const second = {
  contentHash: Effect2.pipe('b', EffectString.repeat(64)),
  text: 'Keep evidence current.',
  uri: 'threadnote://memory/b',
};

function requireJsonObject(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error('Expected a JSON object.');
  return value;
}

describe('project guidance blocks', () => {
  it('declares every safe verified project-guidance target explicitly', () => {
    expect(
      EffectRecord.fromEntries(
        EffectArray.map(
          EffectArray.filter(
            AGENT_ADAPTERS,
            (adapter: (typeof AGENT_ADAPTERS)[number], __effectArrayIndex) =>
              __effectArrayIndex in AGENT_ADAPTERS && Boolean(adapter.guidance),
          ),
          adapter => [adapter.catalog.id, adapter.guidance?.projection.relativePath],
        ),
      ),
    ).toEqual({
      'amp-cli': 'AGENTS.md',
      'claude-code': 'CLAUDE.md',
      cline: '.clinerules/threadnote.md',
      'codex-cli': 'AGENTS.md',
      'continue-project': '.continue/rules/threadnote-guidance.md',
      'copilot-vscode': '.github/instructions/threadnote.instructions.md',
      'cursor-desktop': '.cursor/rules/threadnote.mdc',
      'devin-local': '.devin/global_rules.md',
      'factory-droid': 'AGENTS.md',
      'gemini-cli': 'GEMINI.md',
      'kiro-cli': '.kiro/steering/threadnote.md',
      'omp-agent': '.omp/AGENTS.md',
      opencode: 'AGENTS.md',
      'qwen-code': 'QWEN.md',
      'roo-project': '.roo/rules/threadnote.md',
      'windsurf-legacy': '.windsurf/rules/threadnote.md',
      'zeno-desktop': 'AGENTS.md',
    });
    expect(getAgentAdapter('junie-cli')?.guidance).toBeUndefined();
    expect(getAgentAdapter('zed-native')?.guidance).toBeUndefined();
    expect(getAgentAdapter('antigravity-ide')?.guidance).toBeUndefined();
  });

  it('is source-order invariant and idempotent', () => {
    const forward = renderManagedGuidanceBlock([first, second]);
    const reverse = renderManagedGuidanceBlock([second, first]);
    expect(forward).toBe(reverse);
    expect(upsertGuidanceBlock(upsertGuidanceBlock('local\n', forward), forward)).toBe(
      upsertGuidanceBlock('local\n', forward),
    );
  });

  it('preserves unmanaged content through projection and removal', () => {
    const block = renderManagedGuidanceBlock([first]);
    const projected = upsertGuidanceBlock('before\n\nafter\n', block);
    expect(guidanceBlock(projected)).toBe(block);
    expect(removeGuidanceBlock(projected)).toBe('before\n\nafter\n');
  });

  it('keeps provider-neutral managed bytes across plain and wrapped adapters', () => {
    const codex = getAgentAdapter('codex-cli')!;
    const cursor = getAgentAdapter('cursor-desktop')!;
    const block = renderManagedGuidanceBlock([first, second]);
    const codexDocument = upsertGuidanceBlock(undefined, block, codex.guidance?.projection.wrapper);
    const cursorDocument = upsertGuidanceBlock(undefined, block, cursor.guidance?.projection.wrapper);
    expect(codex.guidance?.projection.relativePath).not.toBe(cursor.guidance?.projection.relativePath);
    expect(codexDocument).not.toBe(cursorDocument);
    expect(guidanceBlock(codexDocument)).toBe(block);
    expect(guidanceBlock(cursorDocument)).toBe(block);
  });

  it('does not import its own project or bootstrap blocks', () => {
    const projected = upsertGuidanceBlock('human rules\n', renderManagedGuidanceBlock([first]));
    expect(stripThreadnoteManagedGuidance(projected)).toBe('human rules\n');
    expect(
      stripThreadnoteManagedGuidance(
        'before\n<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->\nmanaged\n<!-- END THREADNOTE USER INSTRUCTIONS -->\nafter\n',
      ),
    ).toBe('before\nafter\n');
  });

  it('refuses incomplete or duplicate managed markers', () => {
    expect(hasMalformedGuidanceBlock('before\n<!-- threadnote:project-guidance:start v1 -->')).toBe(true);
    expect(
      hasMalformedGuidanceBlock(
        '<!-- threadnote:project-guidance:start v1 --><!-- threadnote:project-guidance:end --><!-- threadnote:project-guidance:start v1 --><!-- threadnote:project-guidance:end -->',
      ),
    ).toBe(true);
    expect(() => upsertGuidanceBlock('<!-- threadnote:project-guidance:start v1 -->', 'block')).toThrow();
    expect(() => renderManagedGuidanceBlock([{...first, text: GUIDANCE_BLOCK_START}])).toThrow(/reserved/u);
    expect(() =>
      stripThreadnoteManagedGuidance(
        '<!-- END THREADNOTE USER INSTRUCTIONS --><!-- BEGIN THREADNOTE USER INSTRUCTIONS -->',
      ),
    ).toThrow(/incomplete, reversed, or duplicated/u);
  });

  it('uses a deterministic import review identity', () => {
    expect(guidanceImportReviewId('codex-cli', 'threadnote', 'rules')).toBe(
      guidanceImportReviewId('codex-cli', 'threadnote', 'rules'),
    );
    expect(guidanceImportReviewId('codex-cli', 'threadnote', 'rules')).not.toBe(
      guidanceImportReviewId('claude-code', 'threadnote', 'rules'),
    );
  });

  it('normalizes Windows import paths to the catalog path convention', () => {
    expect(normalizeGuidanceImportPath('.roo\\rules\\threadnote.md')).toBe('.roo/rules/threadnote.md');
  });

  it('is idempotent and round-trips arbitrary unmanaged content byte-for-byte', () => {
    fc.assert(
      fc.property(
        fc.string().filter(value => !Effect2.pipe(value, EffectString.includes('threadnote:project-guidance:'))),
        text => {
          const block = renderManagedGuidanceBlock([first]);
          const projected = upsertGuidanceBlock(text, block);
          expect(upsertGuidanceBlock(projected, block)).toBe(projected);
          expect(removeGuidanceBlock(projected)).toBe(text);
        },
      ),
      {numRuns: 50},
    );
  });

  it('strictly validates bounded receipt identity and shape', () => {
    const expected = {
      project: 'threadnote',
      repositoryId: 'repo',
      targetIdentity: Effect2.pipe('c', EffectString.repeat(64)),
      targetPath: 'AGENTS.md',
    };
    const receipt = {
      expectedManagedBlockHash: Effect2.pipe('a', EffectString.repeat(64)),
      previousManagedBlockHash: null,
      project: expected.project,
      removeTargetWhenEmpty: true,
      repositoryId: expected.repositoryId,
      sources: [{contentHash: Effect2.pipe('b', EffectString.repeat(64)), uri: 'threadnote://memory/tn_guidance'}],
      state: 'current',
      targetIdentity: expected.targetIdentity,
      targetPath: expected.targetPath,
      version: 2,
      wrapperOwned: false,
    } as const;
    expect(parseGuidanceReceiptV2(receipt, expected)).toEqual(receipt);
    expect(() => parseGuidanceReceiptV2({...receipt, targetPath: 'other'}, expected)).toThrow();
    expect(() => parseGuidanceReceiptV2({...receipt, unexpected: true}, expected)).toThrow();
    expect(() => parseGuidanceReceiptV2({...receipt, expectedManagedBlockHash: 'short'}, expected)).toThrow();
    const legacy = {...receipt, surface: 'codex-cli', version: 1} as Record<string, unknown>;
    delete legacy.targetIdentity;
    expect(
      parseGuidanceReceiptV1(legacy, {
        project: expected.project,
        repositoryId: expected.repositoryId,
        surface: 'codex-cli',
        targetPath: expected.targetPath,
      }),
    ).toEqual(legacy);
  });

  effectIt.effect('imports exact Markdown once without mutating during preview', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture();
        const source = '# Rules\n\n- Keep lists\n\n```ts\nconst exact = true;\n```\n';
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.repository, 'AGENTS.md'), source);
        const adapter = getAgentAdapter('codex-cli')!;
        expect(
          yield* runGuidanceImport(fixture.config, adapter, {
            apply: false,
            cwd: fixture.repository,
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'preview'});
        expect(yield* listCandidateReviews(fixture.home)).toEqual([]);
        expect(
          yield* runGuidanceImport(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'created'});
        const reviews = yield* listCandidateReviews(fixture.home);
        expect(reviews).toHaveLength(1);
        expect(reviews[0]?.candidates[0]?.proposedText).toBe(Effect2.pipe(source, EffectString.trim));
        expect(
          yield* runGuidanceImport(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'reused'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('honors adapter import precedence instead of mixing dormant fallback files', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture();
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.repository, 'AGENTS.md'), 'Primary rules.\n');
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.repository, 'CLAUDE.md'), 'Fallback rules.\n');
        yield* runGuidanceImport(fixture.config, getAgentAdapter('amp-cli')!, {
          apply: true,
          cwd: fixture.repository,
          project: 'threadnote',
        });
        const [review] = yield* listCandidateReviews(fixture.home);
        expect(review?.candidates[0]?.proposedText).toBe('Primary rules.');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not validate a malformed dormant first-existing fallback', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture();
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.repository, 'AGENTS.md'), 'Primary rules.\n');
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.repository, 'CLAUDE.md'),
          `${GUIDANCE_BLOCK_START}\nmalformed fallback\n`,
        );
        expect(
          yield* runGuidanceImport(fixture.config, getAgentAdapter('amp-cli')!, {
            apply: false,
            cwd: fixture.repository,
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'preview'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not inspect an unsafe dormant first-existing fallback', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture();
        const outside = fixture.path.join(fixture.root, 'outside.md');
        yield* fixture.fs.writeFileString(outside, 'outside\n');
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.repository, 'AGENTS.md'), 'Primary rules.\n');
        yield* fixture.fs.symlink(outside, fixture.path.join(fixture.repository, 'CLAUDE.md'));
        expect(
          yield* runGuidanceImport(fixture.config, getAgentAdapter('amp-cli')!, {
            apply: false,
            cwd: fixture.repository,
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'preview'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('imports native rule directories deterministically without duplicating declared paths', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture();
        const rules = fixture.path.join(fixture.repository, '.roo/rules');
        yield* fixture.fs.makeDirectory(fixture.path.join(rules, 'nested'), {recursive: true});
        yield* fixture.fs.writeFileString(fixture.path.join(rules, 'threadnote.md'), 'Dedicated.\n');
        yield* fixture.fs.writeFileString(fixture.path.join(rules, 'nested/01-first.md'), 'First.\n');
        yield* fixture.fs.writeFileString(fixture.path.join(rules, '02-second.txt'), 'Second.\n');
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.repository, '.roorules'), 'Dormant legacy.\n');
        yield* runGuidanceImport(fixture.config, getAgentAdapter('roo-project')!, {
          apply: true,
          cwd: fixture.repository,
          project: 'threadnote',
        });
        const [review] = yield* listCandidateReviews(fixture.home);
        expect(review?.candidates[0]?.proposedText).toBe('Second.\n\nFirst.\n\nDedicated.');
        expect(
          Effect2.pipe(review?.candidates[0]?.proposedText, effectOptionalString =>
            effectOptionalString == null
              ? undefined
              : Effect2.pipe(
                  effectOptionalString,
                  EffectString.match(/Dedicated\./gu),
                  Effect2.Option.getOrElse(() => null),
                ),
          ),
        ).toHaveLength(1);
        expect(review?.candidates[0]?.proposedText).not.toContain('Dormant legacy.');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('imports Roo legacy rules only when its rules directory has no files', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Projected Roo guidance.');
        const legacy = fixture.path.join(fixture.repository, '.roorules');
        yield* fixture.fs.writeFileString(legacy, 'Legacy Roo.\n');
        const adapter = getAgentAdapter('roo-project')!;
        yield* runGuidanceImport(fixture.config, getAgentAdapter('roo-project')!, {
          apply: true,
          cwd: fixture.repository,
          project: 'threadnote',
        });
        const [review] = yield* listCandidateReviews(fixture.home);
        expect(review?.candidates[0]?.proposedText).toBe('Legacy Roo.');
        const failure = yield* runGuidanceProject(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        }).pipe(Effect.flip);
        expect(String(failure)).toContain('must be migrated to .roo/rules/');
        expect(yield* fixture.fs.readFileString(legacy)).toBe('Legacy Roo.\n');
        expect(yield* runGuidanceStatus(fixture.config, adapter, 'threadnote', fixture.repository)).toMatchObject({
          state: 'unavailable',
        });
        expect(
          yield* runGuidanceRemove(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            force: false,
            project: 'threadnote',
          }),
        ).toEqual({mode: 'absent'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses symlinked native rule directories during import', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture();
        const outside = fixture.path.join(fixture.root, 'outside-rules');
        yield* fixture.fs.makeDirectory(outside, {recursive: true});
        yield* fixture.fs.writeFileString(fixture.path.join(outside, 'rule.md'), 'outside\n');
        yield* fixture.fs.makeDirectory(fixture.path.join(fixture.repository, '.roo'), {recursive: true});
        yield* fixture.fs.symlink(outside, fixture.path.join(fixture.repository, '.roo/rules'));
        const failure = yield* runGuidanceImport(fixture.config, getAgentAdapter('roo-project')!, {
          apply: false,
          cwd: fixture.repository,
          project: 'threadnote',
        }).pipe(Effect.flip);
        expect(String(failure)).toContain('symbolic link');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not re-import Threadnote-owned projection or setup wrappers', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const id of ['cursor-desktop', 'continue-project', 'windsurf-legacy'] as const) {
          const fixture = yield* makeGuidanceFixture(`Owned wrapper for ${id}.`);
          const adapter = getAgentAdapter(id)!;
          yield* runGuidanceProject(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            force: false,
            memory: [fixture.memoryUri],
            project: 'threadnote',
          });
          expect(
            yield* runGuidanceImport(fixture.config, adapter, {
              apply: false,
              cwd: fixture.repository,
              project: 'threadnote',
            }),
          ).toEqual({mode: 'empty'});
        }
        const fixture = yield* makeGuidanceFixture();
        const cursor = getAgentAdapter('cursor-desktop')!;
        const setupWrapper = cursor.guidance!.importWrappers![0];
        const setupTarget = fixture.path.join(fixture.repository, '.cursor/rules/threadnote.mdc');
        yield* fixture.fs.makeDirectory(fixture.path.dirname(setupTarget), {recursive: true});
        yield* fixture.fs.writeFileString(
          setupTarget,
          `${setupWrapper.prefix}<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->\nmanaged\n<!-- END THREADNOTE USER INSTRUCTIONS -->${setupWrapper.suffix}`,
        );
        expect(
          yield* runGuidanceImport(fixture.config, cursor, {
            apply: false,
            cwd: fixture.repository,
            project: 'threadnote',
          }),
        ).toEqual({mode: 'empty'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('imports Factory-compatible CLAUDE casing through documented precedence', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture();
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.repository, 'Claude.md'), 'Factory fallback.\n');
        expect(
          yield* runGuidanceImport(fixture.config, getAgentAdapter('factory-droid')!, {
            apply: false,
            cwd: fixture.repository,
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'preview'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses to deactivate an active first-existing fallback during projection', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const [id, fallback] of [
          ['claude-code', '.claude/CLAUDE.md'],
          ['omp-agent', 'AGENTS.md'],
          ['amp-cli', 'AGENT.md'],
          ['factory-droid', 'Claude.md'],
        ] as const) {
          const fixture = yield* makeGuidanceFixture(`Projected ${id} guidance.`);
          const adapter = getAgentAdapter(id)!;
          const fallbackTarget = fixture.path.join(fixture.repository, fallback);
          yield* fixture.fs.makeDirectory(fixture.path.dirname(fallbackTarget), {recursive: true});
          yield* fixture.fs.writeFileString(fallbackTarget, `Active ${id} fallback.\n`);
          const failure = yield* runGuidanceProject(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            force: false,
            memory: [fixture.memoryUri],
            project: 'threadnote',
          }).pipe(Effect.flip);
          expect(String(failure)).toContain('must be migrated before projecting');
          expect(yield* fixture.fs.readFileString(fallbackTarget)).toBe(`Active ${id} fallback.\n`);
          expect(yield* runGuidanceStatus(fixture.config, adapter, 'threadnote', fixture.repository)).toMatchObject({
            state: 'unavailable',
          });
          expect(
            yield* runGuidanceRemove(fixture.config, adapter, {
              apply: true,
              cwd: fixture.repository,
              force: false,
              project: 'threadnote',
            }),
          ).toEqual({mode: 'absent'});
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('applies first-existing precedence blockers across consumers of a candidate path', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const fallback of ['AGENT.md', 'Claude.md']) {
          const fixture = yield* makeGuidanceFixture(`Shared fallback guard for ${fallback}.`);
          yield* fixture.fs.writeFileString(
            fixture.path.join(fixture.repository, fallback),
            `Active ${fallback} fallback.\n`,
          );
          const failure = yield* runGuidanceProject(fixture.config, getAgentAdapter('codex-cli')!, {
            apply: false,
            cwd: fixture.repository,
            force: false,
            memory: [fixture.memoryUri],
            project: 'threadnote',
          }).pipe(Effect.flip);
          expect(String(failure)).toContain('fallback must be migrated before projecting AGENTS.md');
          expect(yield* fixture.fs.exists(fixture.path.join(fixture.repository, 'AGENTS.md'))).toBe(false);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('probes projection precedence without applying import content limits', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const factory = yield* makeGuidanceFixture('Small projected guidance.');
        yield* factory.fs.writeFileString(
          factory.path.join(factory.repository, 'AGENTS.md'),
          Effect2.pipe('x', EffectString.repeat(70_000)),
        );
        expect(
          yield* runGuidanceProject(factory.config, getAgentAdapter('factory-droid')!, {
            apply: false,
            cwd: factory.repository,
            force: false,
            memory: [factory.memoryUri],
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'preview'});

        const roo = yield* makeGuidanceFixture('Small Roo projection.');
        const rules = roo.path.join(roo.repository, '.roo/rules');
        yield* roo.fs.makeDirectory(rules, {recursive: true});
        yield* roo.fs.writeFileString(
          roo.path.join(rules, 'existing.md'),
          Effect2.pipe('x', EffectString.repeat(70_000)),
        );
        yield* roo.fs.writeFileString(roo.path.join(roo.repository, '.roorules'), 'Dormant fallback.\n');
        expect(
          yield* runGuidanceProject(roo.config, getAgentAdapter('roo-project')!, {
            apply: false,
            cwd: roo.repository,
            force: false,
            memory: [roo.memoryUri],
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'preview'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps the Roo fallback active for ignored, empty, and uncertain directory entries', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const inactive = yield* makeGuidanceFixture('Small Roo projection.');
        const inactiveRules = inactive.path.join(inactive.repository, '.roo/rules');
        yield* inactive.fs.makeDirectory(inactiveRules, {recursive: true});
        yield* inactive.fs.writeFileString(inactive.path.join(inactiveRules, '.DS_Store'), 'metadata');
        yield* inactive.fs.writeFileString(inactive.path.join(inactiveRules, 'empty.md'), '');
        yield* inactive.fs.writeFileString(inactive.path.join(inactive.repository, '.roorules'), 'Active fallback.\n');
        const adapter = getAgentAdapter('roo-project')!;
        const inactiveFailure = yield* runGuidanceProject(inactive.config, adapter, {
          apply: false,
          cwd: inactive.repository,
          force: false,
          memory: [inactive.memoryUri],
          project: 'threadnote',
        }).pipe(Effect.flip);
        expect(String(inactiveFailure)).toContain('.roorules fallback must be migrated');
        expect(yield* runGuidanceStatus(inactive.config, adapter, 'threadnote', inactive.repository)).toMatchObject({
          state: 'unavailable',
        });
        expect(
          yield* runGuidanceRemove(inactive.config, adapter, {
            apply: true,
            cwd: inactive.repository,
            force: false,
            project: 'threadnote',
          }),
        ).toEqual({mode: 'absent'});

        const rootFile = yield* makeGuidanceFixture('Small Roo projection.');
        yield* rootFile.fs.makeDirectory(rootFile.path.join(rootFile.repository, '.roo'), {recursive: true});
        yield* rootFile.fs.writeFileString(rootFile.path.join(rootFile.repository, '.roo/rules'), 'not a directory');
        yield* rootFile.fs.writeFileString(rootFile.path.join(rootFile.repository, '.roorules'), 'Active fallback.\n');
        const rootFileFailure = yield* runGuidanceProject(rootFile.config, adapter, {
          apply: false,
          cwd: rootFile.repository,
          force: false,
          memory: [rootFile.memoryUri],
          project: 'threadnote',
        }).pipe(Effect.flip);
        expect(String(rootFileFailure)).toContain('.roorules fallback must be migrated');

        const uncertain = yield* makeGuidanceFixture('Small Roo projection.');
        const uncertainRules = uncertain.path.join(uncertain.repository, '.roo/rules');
        yield* uncertain.fs.makeDirectory(uncertainRules, {recursive: true});
        for (let index = 0; index <= 256; index += 1)
          yield* uncertain.fs.makeDirectory(uncertain.path.join(uncertainRules, `directory-${index}`));
        yield* uncertain.fs.writeFileString(
          uncertain.path.join(uncertain.repository, '.roorules'),
          'Active fallback.\n',
        );
        const uncertainFailure = yield* runGuidanceProject(uncertain.config, adapter, {
          apply: false,
          cwd: uncertain.repository,
          force: false,
          memory: [uncertain.memoryUri],
          project: 'threadnote',
        }).pipe(Effect.flip);
        expect(String(uncertainFailure)).toContain('rules directory exceeds its entry limit');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('imports both Cline single-file and directory rule layouts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const singleFile = yield* makeGuidanceFixture('Projected Cline guidance.');
        yield* singleFile.fs.writeFileString(singleFile.path.join(singleFile.repository, '.clinerules'), 'Legacy.\n');
        expect(
          yield* runGuidanceImport(singleFile.config, getAgentAdapter('cline')!, {
            apply: false,
            cwd: singleFile.repository,
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'preview'});
        const adapter = getAgentAdapter('cline')!;
        const failure = yield* runGuidanceProject(singleFile.config, adapter, {
          apply: true,
          cwd: singleFile.repository,
          force: false,
          memory: [singleFile.memoryUri],
          project: 'threadnote',
        }).pipe(Effect.flip);
        expect(String(failure)).toContain('must be migrated to .clinerules/');
        expect(yield* runGuidanceStatus(singleFile.config, adapter, 'threadnote', singleFile.repository)).toMatchObject(
          {
            state: 'unavailable',
          },
        );
        expect(
          yield* runGuidanceRemove(singleFile.config, adapter, {
            apply: true,
            cwd: singleFile.repository,
            force: false,
            project: 'threadnote',
          }),
        ).toEqual({mode: 'absent'});

        const directory = yield* makeGuidanceFixture();
        const rules = directory.path.join(directory.repository, '.clinerules');
        yield* directory.fs.makeDirectory(rules, {recursive: true});
        yield* directory.fs.writeFileString(directory.path.join(rules, 'rule.md'), 'Directory.\n');
        expect(
          yield* runGuidanceImport(directory.config, getAgentAdapter('cline')!, {
            apply: false,
            cwd: directory.repository,
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'preview'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves a wrapped surface preimage and force-removes only the managed block', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Keep project memory.');
        const adapter = getAgentAdapter('cursor-desktop')!;
        const target = fixture.path.join(fixture.repository, '.cursor/rules/threadnote.mdc');
        const wrapper = adapter.guidance!.projection.wrapper!;
        const original = `${wrapper.prefix}Keep local.\n${wrapper.suffix}`;
        yield* fixture.fs.makeDirectory(fixture.path.dirname(target), {recursive: true});
        yield* fixture.fs.writeFileString(target, original);
        yield* runGuidanceProject(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        });
        const projected = yield* fixture.fs.readFileString(target);
        expect(Effect2.pipe(projected, EffectString.startsWith(`${original}${GUIDANCE_BLOCK_START}`))).toBe(true);
        expect(
          Effect2.pipe(
            projected,
            EffectString.match(/^---/g),
            Effect2.Option.getOrElse(() => null),
          ),
        ).toHaveLength(1);
        expect(yield* runGuidanceStatus(fixture.config, adapter, 'threadnote', fixture.repository)).toMatchObject({
          state: 'current',
        });
        yield* fixture.fs.writeFileString(
          target,
          Effect2.pipe(projected, EffectString.replace('Keep project memory.', 'Locally changed.')),
        );
        expect(yield* runGuidanceStatus(fixture.config, adapter, 'threadnote', fixture.repository)).toMatchObject({
          state: 'locally-modified',
        });
        const refused = yield* runGuidanceRemove(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          project: 'threadnote',
        }).pipe(Effect.flip);
        expect(String(refused)).toContain('rerun with --force');
        yield* runGuidanceRemove(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: true,
          project: 'threadnote',
        });
        expect(yield* fixture.fs.readFileString(target)).toBe(original);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses a nonempty required-wrapper target that the host would not activate', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Activation matters.');
        const adapter = getAgentAdapter('windsurf-legacy')!;
        const target = fixture.path.join(fixture.repository, adapter.guidance!.projection.relativePath);
        yield* fixture.fs.makeDirectory(fixture.path.dirname(target), {recursive: true});
        yield* fixture.fs.writeFileString(target, 'Existing conditional rule.\n');
        const failure = yield* runGuidanceProject(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: true,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        }).pipe(Effect.flip);
        expect(String(failure)).toContain('requires its project-guidance wrapper');
        expect(yield* fixture.fs.readFileString(target)).toBe('Existing conditional rule.\n');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('imports the primary declared source for every project-guidance adapter', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const adapter of EffectArray.filter(AGENT_ADAPTERS, candidate => candidate.guidance !== undefined)) {
          const fixture = yield* makeGuidanceFixture();
          const source = adapter.guidance!.importPaths[0];
          const target = fixture.path.join(fixture.repository, source);
          yield* fixture.fs.makeDirectory(fixture.path.dirname(target), {recursive: true});
          yield* fixture.fs.writeFileString(target, `Import ${adapter.catalog.id}.\n`);
          expect(
            yield* runGuidanceImport(fixture.config, adapter, {
              apply: false,
              cwd: fixture.repository,
              project: 'threadnote',
            }),
          ).toMatchObject({mode: 'preview'});
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('round-trips every catalog-declared guidance adapter through its native target', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const adapter of EffectArray.filter(AGENT_ADAPTERS, candidate => candidate.guidance !== undefined)) {
          const fixture = yield* makeGuidanceFixture(`Round trip ${adapter.catalog.id}.`);
          const target = fixture.path.join(fixture.repository, adapter.guidance!.projection.relativePath);
          yield* runGuidanceProject(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            force: false,
            memory: [fixture.memoryUri],
            project: 'threadnote',
          });
          const projected = yield* fixture.fs.readFileString(target);
          const wrapper = adapter.guidance!.projection.wrapper;
          if (wrapper?.required === true)
            expect(Effect2.pipe(projected, EffectString.startsWith(wrapper.prefix))).toBe(true);
          expect(yield* runGuidanceStatus(fixture.config, adapter, 'threadnote', fixture.repository)).toMatchObject({
            state: 'current',
          });
          yield* runGuidanceRemove(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            force: false,
            project: 'threadnote',
          });
          expect(yield* fixture.fs.exists(target)).toBe(false);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('removes a setup-owned target after setup is removed before guidance', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Cohabiting guidance.');
        const adapter = getAgentAdapter('roo-project')!;
        const target = fixture.path.join(fixture.repository, adapter.guidance!.projection.relativePath);
        const setup = '<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->\nsetup\n<!-- END THREADNOTE USER INSTRUCTIONS -->';
        yield* fixture.fs.makeDirectory(fixture.path.dirname(target), {recursive: true});
        yield* fixture.fs.writeFileString(target, setup);
        yield* runGuidanceProject(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        });
        const projected = yield* fixture.fs.readFileString(target);
        yield* fixture.fs.writeFileString(target, `${guidanceBlock(projected)!}\n`);
        yield* runGuidanceRemove(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          project: 'threadnote',
        });
        expect(yield* fixture.fs.exists(target)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('cohabits with wrapped setup artifacts and removes their orphaned wrapper', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const id of ['cursor-desktop', 'copilot-vscode'] as const) {
          const fixture = yield* makeGuidanceFixture(`Cohabiting ${id}.`);
          const adapter = getAgentAdapter(id)!;
          const setupWrapper = adapter.guidance!.importWrappers![0];
          const target = fixture.path.join(fixture.repository, adapter.guidance!.projection.relativePath);
          const setupBlock =
            '<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->\nsetup\n<!-- END THREADNOTE USER INSTRUCTIONS -->';
          yield* fixture.fs.makeDirectory(fixture.path.dirname(target), {recursive: true});
          yield* fixture.fs.writeFileString(target, `${setupWrapper.prefix}${setupBlock}${setupWrapper.suffix}`);
          yield* runGuidanceProject(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            force: false,
            memory: [fixture.memoryUri],
            project: 'threadnote',
          });
          const projected = yield* fixture.fs.readFileString(target);
          yield* fixture.fs.writeFileString(
            target,
            `${setupWrapper.prefix}${guidanceBlock(projected)!}${setupWrapper.suffix}`,
          );
          yield* runGuidanceRemove(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            force: false,
            project: 'threadnote',
          });
          expect(yield* fixture.fs.exists(target)).toBe(false);
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('resumes a pending receipt and removes a created target without force', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Resume exact projection.');
        const adapter = getAgentAdapter('codex-cli')!;
        const target = fixture.path.join(fixture.repository, 'AGENTS.md');
        expect(
          yield* runGuidanceProject(fixture.config, adapter, {
            apply: false,
            cwd: fixture.repository,
            force: false,
            memory: [fixture.memoryUri],
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'preview'});
        expect(yield* fixture.fs.exists(target)).toBe(false);
        yield* runGuidanceProject(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        });
        const receiptDirectory = fixture.path.join(fixture.home, 'guidance/v2/receipts');
        const [receiptName] = yield* fixture.fs.readDirectory(receiptDirectory);
        const receiptPath = fixture.path.join(receiptDirectory, receiptName);
        const receipt = requireJsonObject(JSON.parse(yield* fixture.fs.readFileString(receiptPath)));
        yield* fixture.fs.writeFileString(
          receiptPath,
          `${JSON.stringify({...receipt, state: 'pending'}, undefined, 2)}\n`,
        );
        expect(
          yield* runGuidanceProject(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            force: false,
            memory: [fixture.memoryUri],
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'resumed'});
        yield* runGuidanceRemove(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          project: 'threadnote',
        });
        expect(yield* fixture.fs.exists(target)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('migrates and permanently retires compatible local-build v1 receipts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const id of ['codex-cli', 'claude-code', 'cursor-desktop', 'copilot-vscode'] as const) {
          const memoryText = `Legacy local-build projection for ${id}.`;
          const fixture = yield* makeGuidanceFixture(memoryText);
          const adapter = getAgentAdapter(id)!;
          const options = {
            apply: false,
            cwd: fixture.repository,
            force: false,
            memory: [fixture.memoryUri],
            project: 'threadnote',
          } as const;
          const preview = yield* runGuidanceProject(fixture.config, adapter, options);
          const block = renderManagedGuidanceBlock([
            {contentHash: sha256HexSync(memoryText), text: memoryText, uri: fixture.memoryUri},
          ]);
          const legacyWrapperOwned = id === 'cursor-desktop';
          const legacyContent = legacyWrapperOwned
            ? `${adapter.guidance!.projection.wrapper!.prefix}${block}${adapter.guidance!.projection.wrapper!.suffix}`
            : block;
          const target = fixture.path.join(fixture.repository, adapter.guidance!.projection.relativePath);
          yield* fixture.fs.makeDirectory(fixture.path.dirname(target), {recursive: true});
          yield* fixture.fs.writeFileString(target, legacyContent);
          const repository = yield* resolveRepositoryIdentity(fixture.repository);
          const legacyDirectory = fixture.path.join(fixture.home, 'guidance/v1/receipts');
          const legacyPath = fixture.path.join(
            legacyDirectory,
            `${sha256HexSync(EffectArray.join([repository.repositoryId, 'threadnote', id], '\n'))}.json`,
          );
          const {targetIdentity: _targetIdentity, ...withoutTargetIdentity} = preview.receipt;
          const legacy = {
            ...withoutTargetIdentity,
            expectedManagedBlockHash: sha256HexSync(block),
            surface: id,
            version: 1,
            wrapperOwned: legacyWrapperOwned,
          };
          yield* fixture.fs.makeDirectory(legacyDirectory, {recursive: true});
          yield* fixture.fs.writeFileString(legacyPath, `${JSON.stringify(legacy, undefined, 2)}\n`);
          yield* runGuidanceProject(fixture.config, adapter, {...options, apply: true});
          expect(yield* runGuidanceStatus(fixture.config, adapter, 'threadnote', fixture.repository)).toMatchObject({
            state: 'current',
          });
          if (adapter.guidance!.projection.wrapper?.required === true)
            expect(
              Effect2.pipe(
                yield* fixture.fs.readFileString(target),
                EffectString.startsWith(adapter.guidance!.projection.wrapper.prefix),
              ),
            ).toBe(true);
          expect(yield* fixture.fs.readDirectory(fixture.path.join(fixture.home, 'guidance/v2/receipts'))).toHaveLength(
            1,
          );
          yield* runGuidanceRemove(fixture.config, adapter, {
            apply: true,
            cwd: fixture.repository,
            force: false,
            project: 'threadnote',
          });
          expect(yield* runGuidanceStatus(fixture.config, adapter, 'threadnote', fixture.repository)).toMatchObject({
            state: 'unavailable',
          });
          expect(
            yield* runGuidanceRemove(fixture.config, adapter, {
              apply: true,
              cwd: fixture.repository,
              force: false,
              project: 'threadnote',
            }),
          ).toEqual({mode: 'absent'});
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('shares one target receipt across AGENTS.md-compatible surfaces', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Shared project guidance.');
        const options = {
          apply: true,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        } as const;
        yield* runGuidanceProject(fixture.config, getAgentAdapter('codex-cli')!, options);
        const target = fixture.path.join(fixture.repository, 'AGENTS.md');
        const projected = yield* fixture.fs.readFileString(target);
        expect(
          yield* runGuidanceStatus(fixture.config, getAgentAdapter('amp-cli')!, 'threadnote', fixture.repository),
        ).toMatchObject({state: 'current', surface: 'amp-cli'});
        yield* runGuidanceProject(fixture.config, getAgentAdapter('factory-droid')!, options);
        expect(yield* fixture.fs.readFileString(target)).toBe(projected);
        const receipts = yield* fixture.fs.readDirectory(fixture.path.join(fixture.home, 'guidance/v2/receipts'));
        expect(receipts).toHaveLength(1);
        yield* runGuidanceRemove(fixture.config, getAgentAdapter('amp-cli')!, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          project: 'threadnote',
        });
        expect(yield* fixture.fs.exists(target)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('enforces a host project-guidance file limit before writing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture(Effect2.pipe('x', EffectString.repeat(12_000)));
        const failure = yield* runGuidanceProject(fixture.config, getAgentAdapter('windsurf-legacy')!, {
          apply: false,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        }).pipe(Effect.flip);
        expect(String(failure)).toContain('12000-character file limit');
        expect(yield* fixture.fs.exists(fixture.path.join(fixture.repository, '.windsurf/rules/threadnote.md'))).toBe(
          false,
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('counts host limits in Unicode characters', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unicodeFixture = yield* makeGuidanceFixture(Effect2.pipe('é', EffectString.repeat(10_000)));
        expect(
          yield* runGuidanceProject(unicodeFixture.config, getAgentAdapter('windsurf-legacy')!, {
            apply: false,
            cwd: unicodeFixture.repository,
            force: false,
            memory: [unicodeFixture.memoryUri],
            project: 'threadnote',
          }),
        ).toMatchObject({mode: 'preview'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('applies the strictest shared-target limit', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sharedFixture = yield* makeGuidanceFixture(Effect2.pipe('x', EffectString.repeat(80_000)));
        const failure = yield* runGuidanceProject(sharedFixture.config, getAgentAdapter('codex-cli')!, {
          apply: false,
          cwd: sharedFixture.repository,
          force: false,
          memory: [sharedFixture.memoryUri],
          project: 'threadnote',
        }).pipe(Effect.flip);
        expect(String(failure)).toContain('80000-character file limit');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('reports oversized shared-target status and health', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const statusFixture = yield* makeGuidanceFixture('Small shared guidance.');
        yield* runGuidanceProject(statusFixture.config, getAgentAdapter('codex-cli')!, {
          apply: true,
          cwd: statusFixture.repository,
          force: false,
          memory: [statusFixture.memoryUri],
          project: 'threadnote',
        });
        const target = statusFixture.path.join(statusFixture.repository, 'AGENTS.md');
        yield* statusFixture.fs.writeFileString(
          target,
          `${yield* statusFixture.fs.readFileString(target)}${Effect2.pipe('x', EffectString.repeat(80_000))}`,
        );
        expect(
          yield* runGuidanceStatus(
            statusFixture.config,
            getAgentAdapter('factory-droid')!,
            'threadnote',
            statusFixture.repository,
          ),
        ).toMatchObject({state: 'unavailable'});
        expect(yield* guidanceHealthEvidence(statusFixture.config, 'threadnote', statusFixture.repository)).toEqual([
          {sourceUris: [statusFixture.memoryUri], state: 'unavailable'},
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('isolates receipts across linked worktrees and same-repository project roots', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Isolated receipt.');
        yield* fixture.fs.writeFileString(fixture.path.join(fixture.repository, 'seed.txt'), 'seed\n');
        yield* runCommand('git', ['add', 'seed.txt'], {cwd: fixture.repository});
        yield* runCommand(
          'git',
          ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.invalid', 'commit', '-m', 'seed'],
          {cwd: fixture.repository},
        );
        const linked = fixture.path.join(fixture.root, 'linked');
        yield* runCommand('git', ['worktree', 'add', '-b', 'linked-guidance', linked], {cwd: fixture.repository});
        const adapter = getAgentAdapter('codex-cli')!;
        const options = (cwd: string) => ({
          apply: true,
          cwd,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        });
        yield* runGuidanceProject(fixture.config, adapter, options(fixture.repository));
        yield* runGuidanceProject(fixture.config, adapter, options(linked));
        const subproject = fixture.path.join(fixture.repository, 'packages/app');
        yield* fixture.fs.makeDirectory(subproject, {recursive: true});
        yield* runGuidanceProject(fixture.config, adapter, options(subproject));
        const receipts = yield* fixture.fs.readDirectory(fixture.path.join(fixture.home, 'guidance/v2/receipts'));
        expect(receipts).toHaveLength(3);
        yield* runGuidanceRemove(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          project: 'threadnote',
        });
        expect(yield* fixture.fs.exists(fixture.path.join(linked, 'AGENTS.md'))).toBe(true);
        expect(yield* fixture.fs.exists(fixture.path.join(subproject, 'AGENTS.md'))).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('removes an owned wrapper after unmanaged text is prepended and appended', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Wrapped projection.');
        const adapter = getAgentAdapter('cursor-desktop')!;
        const target = fixture.path.join(fixture.repository, '.cursor/rules/threadnote.mdc');
        yield* runGuidanceProject(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        });
        const projected = yield* fixture.fs.readFileString(target);
        yield* fixture.fs.writeFileString(target, `before\n${projected}after\n`);
        expect(yield* runGuidanceStatus(fixture.config, adapter, 'threadnote', fixture.repository)).toMatchObject({
          state: 'unavailable',
        });
        yield* runGuidanceProject(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: true,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        });
        expect(
          Effect2.pipe(
            yield* fixture.fs.readFileString(target),
            EffectString.startsWith(adapter.guidance!.projection.wrapper!.prefix),
          ),
        ).toBe(true);
        yield* runGuidanceRemove(fixture.config, adapter, {
          apply: true,
          cwd: fixture.repository,
          force: true,
          project: 'threadnote',
        });
        expect(yield* fixture.fs.readFileString(target)).toBe('before\nafter\n');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('resumes an interrupted update before and after its target write', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Original projection.');
        const adapter = getAgentAdapter('codex-cli')!;
        const options = {
          apply: true,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        } as const;
        yield* runGuidanceProject(fixture.config, adapter, options);
        const receiptDirectory = fixture.path.join(fixture.home, 'guidance/v2/receipts');
        const [receiptName] = yield* fixture.fs.readDirectory(receiptDirectory);
        const receiptPath = fixture.path.join(receiptDirectory, receiptName);
        const oldReceipt = requireJsonObject(JSON.parse(yield* fixture.fs.readFileString(receiptPath)));
        if (typeof oldReceipt.expectedManagedBlockHash !== 'string')
          throw new Error('Expected the stored guidance block hash.');
        const system = yield* SystemInfo;
        yield* runRemember(fixture.config, {
          kind: 'durable',
          project: 'threadnote',
          replace: fixture.memoryUri,
          sourceAgentClient: 'test',
          text: 'Updated projection.',
          topic: 'guidance',
        }).pipe(
          Effect.provideService(SystemInfo, SystemInfo.of({...system, currentDirectory: () => fixture.repository})),
        );
        const memoryPath = yield* localMemoryPathForUri(fixture.config, fixture.memoryUri);
        if (memoryPath === undefined) {
          throw new Error(`Unable to resolve fixture memory URI: ${fixture.memoryUri}`);
        }
        expect(
          parseMemoryDocument(fixture.memoryUri, yield* fixture.fs.readFileString(memoryPath))?.metadata.memoryId,
        ).toBe('tn_guidance');
        const preview = yield* runGuidanceProject(fixture.config, adapter, {...options, apply: false});
        const pendingReceipt = {
          ...preview.receipt,
          previousManagedBlockHash: oldReceipt.expectedManagedBlockHash,
          state: 'pending',
        };
        yield* fixture.fs.writeFileString(receiptPath, `${JSON.stringify(pendingReceipt, undefined, 2)}\n`);
        expect(yield* runGuidanceProject(fixture.config, adapter, options)).toMatchObject({mode: 'applied'});
        expect(yield* fixture.fs.readFileString(fixture.path.join(fixture.repository, 'AGENTS.md'))).toContain(
          'Updated projection.',
        );
        yield* fixture.fs.writeFileString(receiptPath, `${JSON.stringify(pendingReceipt, undefined, 2)}\n`);
        expect(yield* runGuidanceProject(fixture.config, adapter, options)).toMatchObject({mode: 'resumed'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('skips non-repositories for health but surfaces invalid guidance receipts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Health evidence.');
        const outsideRepository = fixture.path.join(fixture.root, 'outside-repository');
        yield* fixture.fs.makeDirectory(outsideRepository);
        expect(yield* guidanceHealthEvidence(fixture.config, 'threadnote', outsideRepository)).toEqual([]);

        yield* runGuidanceProject(fixture.config, getAgentAdapter('codex-cli')!, {
          apply: true,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        });
        const receiptDirectory = fixture.path.join(fixture.home, 'guidance/v2/receipts');
        const [receiptName] = yield* fixture.fs.readDirectory(receiptDirectory);
        yield* fixture.fs.writeFileString(fixture.path.join(receiptDirectory, receiptName), '{"invalid":true}\n');
        const failure = yield* guidanceHealthEvidence(fixture.config, 'threadnote', fixture.repository).pipe(
          Effect.flip,
        );
        expect(String(failure)).toContain('Guidance receipt is invalid');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refuses to read a symlinked project target during preview', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeGuidanceFixture('Do not follow links.');
        const outside = fixture.path.join(fixture.root, 'outside.md');
        yield* fixture.fs.writeFileString(outside, 'outside\n');
        yield* fixture.fs.symlink(outside, fixture.path.join(fixture.repository, 'AGENTS.md'));
        const failure = yield* runGuidanceProject(fixture.config, getAgentAdapter('codex-cli')!, {
          apply: false,
          cwd: fixture.repository,
          force: false,
          memory: [fixture.memoryUri],
          project: 'threadnote',
        }).pipe(Effect.flip);
        expect(String(failure)).toContain('symbolic link');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

const makeGuidanceFixture = Effect.fn('test.guidanceFixture')(function* (memoryText?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-guidance-'});
  const repository = path.join(root, 'repository');
  const home = path.join(root, 'home');
  yield* fs.makeDirectory(repository, {recursive: true});
  yield* runCommand('git', ['init'], {cwd: repository});
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: path.join(home, 'seed-manifest.yaml'),
    user: 'tester',
  };
  const memoryUri = 'threadnote://user/tester/memories/durable/projects/threadnote/guidance.md';
  if (memoryText !== undefined) {
    const memoryPath = yield* localMemoryPathForUri(config, memoryUri);
    if (memoryPath === undefined) {
      throw new Error(`Unable to resolve fixture memory URI: ${memoryUri}`);
    }
    yield* fs.makeDirectory(path.dirname(memoryPath), {recursive: true});
    yield* fs.writeFileString(
      memoryPath,
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          memoryId: 'tn_guidance',
          project: 'threadnote',
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'test',
          status: 'active',
          timestamp: '2024-01-01T00:00:00.000Z',
          topic: 'guidance',
        },
        memoryText,
      ),
    );
  }
  return {config, fs, home, memoryUri, path, repository, root};
});
