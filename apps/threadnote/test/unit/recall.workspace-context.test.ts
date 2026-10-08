import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {resolveRecallWorkspaceContext} from '../../src/mcp/server/recall_workspace_context.js';
import {runCommand} from '@threadnote/threadnote/utils';

effectIt.effect(
  'restricts inferred workspace recall to the caller repository project',
  () => {
    let root: string | undefined;
    return Effect.gen(function* () {
      root = mkdtempSync(join(tmpdir(), 'threadnote-recall-project-scope-'));
      const projectRoot = join(root, 'independent-checkout');
      mkdirSync(projectRoot, {recursive: true});
      writeFileSync(join(projectRoot, 'package.json'), '{"name":"independent-checkout","private":true}\n');
      yield* runCommand('git', ['init'], {cwd: projectRoot});
      yield* runCommand('git', ['remote', 'add', 'origin', 'https://github.com/synthetic/independent-repo.git'], {
        cwd: projectRoot,
      });

      const context = yield* resolveRecallWorkspaceContext(
        {
          account: 'local',
          agentContextHome: join(root, '.threadnote'),
          agentId: 'threadnote',
          manifestPath: join(root, 'seed-manifest.yaml'),
          user: 'fixture-user',
        },
        {
          allowedUriScopes: undefined,
          callerCwd: projectRoot,
          includeArchived: false,
          pinnedUri: undefined,
          project: undefined,
          query: 'How does a voucher affect checkout tax?',
          threshold: undefined,
          workset: undefined,
        },
      );

      expect(context.recallProjectName).toBe('independent-repo');
      if (context.eligibility.kind !== 'candidate-policy') {
        throw new Error('Workspace recall should use candidate eligibility.');
      }
      expect(context.eligibility.projects).toEqual({
        mode: 'allow-projects-and-projectless',
        projects: ['independent-repo'],
      });
    }).pipe(
      Effect.ensuring(Effect.sync(() => (root ? rmSync(root, {force: true, recursive: true}) : undefined))),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    );
  },
  30_000,
);

effectIt.effect(
  'keeps an explicit workset limited to its members when the caller belongs to another repository',
  () => {
    let root: string | undefined;
    return Effect.gen(function* () {
      root = mkdtempSync(join(tmpdir(), 'threadnote-recall-workset-scope-'));
      const projectRoot = join(root, 'independent-checkout');
      mkdirSync(projectRoot, {recursive: true});
      writeFileSync(join(projectRoot, 'package.json'), '{"name":"independent-checkout","private":true}\n');
      yield* runCommand('git', ['init'], {cwd: projectRoot});
      yield* runCommand('git', ['remote', 'add', 'origin', 'https://github.com/synthetic/independent-repo.git'], {
        cwd: projectRoot,
      });
      const manifestPath = join(root, 'seed-manifest.yaml');
      writeFileSync(
        manifestPath,
        [
          'version: 1',
          'projects:',
          '  - name: declared-member',
          '    path: /synthetic/declared-member',
          '    uri: threadnote://resources/repos/declared-member',
          '    seed: []',
          'worksets:',
          '  - name: selected',
          '    projects: [declared-member]',
          '',
        ].join('\n'),
      );

      const context = yield* resolveRecallWorkspaceContext(
        {
          account: 'local',
          agentContextHome: join(root, '.threadnote'),
          agentId: 'threadnote',
          manifestPath,
          user: 'fixture-user',
        },
        {
          allowedUriScopes: undefined,
          callerCwd: projectRoot,
          includeArchived: false,
          pinnedUri: undefined,
          project: undefined,
          query: 'How does a voucher affect checkout tax?',
          threshold: undefined,
          workset: 'selected',
        },
      );

      expect(context.recallProjectName).toBe('independent-repo');
      if (context.eligibility.kind !== 'candidate-policy') {
        throw new Error('Explicit workset recall should use candidate eligibility.');
      }
      expect(context.eligibility.projects).toEqual({
        mode: 'allow-projects-and-projectless',
        projects: ['declared-member'],
      });
    }).pipe(
      Effect.ensuring(Effect.sync(() => (root ? rmSync(root, {force: true, recursive: true}) : undefined))),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    );
  },
  30_000,
);
