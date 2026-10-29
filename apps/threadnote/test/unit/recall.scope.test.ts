import {it as effectIt} from '@effect/vitest';
import {Effect, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {StandaloneBrokerLayer} from '../../src/effect/runtime-bootstrap.js';
import {resolveRecallScope} from '../../src/memory/recall_scope.js';
import {runCommandEffect} from '@threadnote/platform/command';
import {projectRecallMcpResponse} from '@threadnote/recall/mcp/response';
import {SystemInfo} from '@threadnote/platform/system';
import {recallCandidateIsEligible} from '@threadnote/recall/eligibility';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const fixture = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), 'threadnote-recall-scope-'))),
  root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
);

const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', args, {cwd});

const project = (name: string, path: string) => ({
  name,
  path,
  seed: [],
  uri: `threadnote://resources/repos/${name}`,
});

effectIt.effect(
  'resolves all same-checkout projects independently of query names, component roots and repo names',
  () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const repo = join(root, 'checkout');
      const mobile = join(repo, 'apps/mobile');
      const nested = join(repo, 'nested');
      const other = join(root, 'other');
      for (const directory of [mobile, nested, other]) mkdirSync(directory, {recursive: true});
      for (const directory of [repo, nested, other]) yield* git(directory, ['init']);
      yield* git(repo, ['remote', 'add', 'origin', 'https://example.invalid/team/legacy-repo.git']);
      const alias = join(root, 'alias');
      symlinkSync(repo, alias, 'dir');
      const manifestPath = join(root, 'manifest.yaml');
      const projects = [
        project('product', repo),
        project('product-mobile', mobile),
        project('alias-project', alias),
        project('tilde-project', '~/checkout'),
        project('nested-project', nested),
        project('unrelated', other),
      ];
      writeFileSync(
        manifestPath,
        JSON.stringify({
          version: 1,
          projects,
          worksets: [
            {name: 'foreign-workset', projects: ['unrelated']},
            {name: 'empty', projects: []},
            {name: 'bad', projects: ['unknown']},
          ],
        }),
      );
      const system = yield* SystemInfo;
      const resolve = (input: Partial<Parameters<typeof resolveRecallScope>[1]> = {}) =>
        resolveRecallScope({manifestPath}, {callerCwd: mobile, query: 'How does checkout tax work?', ...input}).pipe(
          Effect.provideService(SystemInfo, {...system, homeDirectory: root}),
        );
      for (const query of [
        'How does checkout tax work?',
        'Product mobile checkout tax',
        'foreign-workset tax',
        'product-mobile checkout tax',
      ]) {
        const scope = yield* resolve({query});
        expect(scope.eligibility).toMatchObject({
          projects: {
            mode: 'allow-projects-and-projectless',
            projects: ['alias-project', 'legacy-repo', 'product', 'product-mobile', 'tilde-project'],
          },
        });
        expect(recallCandidateIsEligible(scope.eligibility, {project: 'product-mobile'})).toBe(true);
        expect(recallCandidateIsEligible(scope.eligibility, {project: 'legacy-repo'})).toBe(true);
        expect(recallCandidateIsEligible(scope.eligibility, {project: 'nested-project'})).toBe(false);
        expect(recallCandidateIsEligible(scope.eligibility, {project: 'unrelated'})).toBe(false);
        expect(recallCandidateIsEligible(scope.eligibility, {kind: 'preference', project: 'style'})).toBe(true);
        expect(scope.provenance.reason).toBe('workspace-checkout');
      }
      const unicode = yield* resolve({project: Effect2.pipe('界', EffectString.repeat(100))});
      expect(unicode.provenance.truncatedProjectNames).toBe(true);
      for (const responseFormat of ['agent', 'dual'] as const) {
        const response = projectRecallMcpResponse(
          {projectBoundary: unicode.provenance, queryExpansions: [], rankerVersion: 'test', results: []},
          {budgetTokens: 700, responseFormat},
        );
        expect(response.text).toContain('explicit-project');
        expect(response.measurement.estimatedTokens).toBeLessThanOrEqual(700);
      }
      expect((yield* resolve({inferScope: false})).eligibility).toMatchObject({projects: {mode: 'unrestricted'}});
      expect((yield* resolve({inferScope: false})).preferredProject).toBeUndefined();
      expect((yield* resolve({query: ''})).eligibility).toMatchObject({projects: {mode: 'unrestricted'}});
      expect(
        Result.isFailure(
          yield* resolve({pinnedUri: 'threadnote://user/test/memories', workset: 'unknown'}).pipe(Effect.result),
        ),
      ).toBe(true);
      expect((yield* resolve({callerCwd: undefined})).eligibility).toMatchObject({projects: {mode: 'unrestricted'}});
      expect((yield* resolve({project: ' PRODUCT-MOBILE '})).eligibility).toMatchObject({
        projects: {projects: ['product-mobile']},
      });
      expect((yield* resolve({project: 'mobile', inferScope: false})).eligibility).toMatchObject({
        projects: {projects: ['mobile']},
      });
      expect((yield* resolve({workset: 'foreign-workset'})).eligibility).toMatchObject({
        projects: {projects: ['unrelated']},
      });
      expect((yield* resolve({project: 'product', workset: 'foreign-workset'})).eligibility).toMatchObject({
        projects: {mode: 'deny-all'},
      });
      expect((yield* resolve({workset: 'empty'})).eligibility).toMatchObject({projects: {mode: 'deny-all'}});
      expect(Result.isFailure(yield* resolve({workset: 'bad'}).pipe(Effect.result))).toBe(true);
      expect(Result.isFailure(yield* resolve({workset: 'unknown'}).pipe(Effect.result))).toBe(true);
      expect((yield* resolve({pinnedUri: 'threadnote://user/test/memories', workset: 'empty'})).eligibility.kind).toBe(
        'pinned-hard-uri-bypass',
      );
      const nestedScope = yield* resolve({callerCwd: nested});
      expect(nestedScope.eligibility).toMatchObject({projects: {projects: ['nested', 'nested-project']}});
      writeFileSync(manifestPath, 'invalid: [');
      expect(Result.isFailure(yield* resolve().pipe(Effect.result))).toBe(true);
      const fallback = yield* resolveRecallScope(
        {manifestPath: join(root, 'missing.yaml')},
        {callerCwd: repo, query: 'tax'},
      );
      expect(fallback.eligibility).toMatchObject({projects: {projects: ['legacy-repo']}});
    }).pipe(provideTestLayer(StandaloneBrokerLayer), TestClock.withLive),
  30_000,
);

effectIt.effect(
  'matches a linked worktree through the common Git directory without a graph snapshot',
  () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const repo = join(root, 'main-repo');
      const linked = join(root, 'linked');
      mkdirSync(repo);
      yield* git(repo, ['init']);
      yield* git(repo, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ]);
      yield* git(repo, ['worktree', 'add', '-b', 'fixture-linked', linked]);
      const manifestPath = join(root, 'manifest.yaml');
      writeFileSync(
        manifestPath,
        JSON.stringify({version: 1, projects: [project('product', repo), project('product-mobile', repo)]}),
      );
      const scope = yield* resolveRecallScope({manifestPath}, {callerCwd: linked, query: 'tax'});
      expect(scope.eligibility).toMatchObject({projects: {projects: ['main-repo', 'product', 'product-mobile']}});
    }).pipe(provideTestLayer(StandaloneBrokerLayer), TestClock.withLive),
  30_000,
);
