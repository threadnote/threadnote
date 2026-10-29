import {Array as EffectArray} from 'effect';
import {mkdtemp, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {basename, join} from '@threadnote/testing/node-path';
import {describe, expect, it} from 'vitest';
import {
  enrichRecallQueryWithWorkspaceContext as enrichRecallQueryWithWorkspaceContextEffect,
  enrichRecallQueryWithWorkspaceProjectContext as enrichRecallQueryWithWorkspaceProjectContextEffect,
  runCommand as runCommandEffect,
} from '@threadnote/threadnote/utils';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const enrichRecallQueryWithWorkspaceContext = (
  ...args: Parameters<typeof enrichRecallQueryWithWorkspaceContextEffect>
) => runEffect(enrichRecallQueryWithWorkspaceContextEffect(...args));
const enrichRecallQueryWithWorkspaceProjectContext = (
  ...args: Parameters<typeof enrichRecallQueryWithWorkspaceProjectContextEffect>
) => runEffect(enrichRecallQueryWithWorkspaceProjectContextEffect(...args));
const runCommand = (...args: Parameters<typeof runCommandEffect>) => runEffect(runCommandEffect(...args));

describe('workspace recall enrichment', () => {
  it('uses absolute caller cwd and keeps branch terms out of project inference context', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'threadnote-recall-repo-'));
    const previousCallerCwd = process.env.THREADNOTE_CALLER_CWD;
    const gitEnvKeys = ['GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'] as const;
    const previousGitEnv = new Map(EffectArray.map(gitEnvKeys, key => [key, process.env[key]]));
    delete process.env.THREADNOTE_CALLER_CWD;
    for (const key of gitEnvKeys) {
      delete process.env[key];
    }
    try {
      await runCommand('git', ['init'], {cwd: repoRoot});
      await runCommand('git', ['remote', 'add', 'origin', 'git@github.com:Kashkovsky/threadnote.git'], {cwd: repoRoot});
      await runCommand('git', ['symbolic-ref', 'HEAD', 'refs/heads/mobile-feedback-results-fix'], {cwd: repoRoot});

      await expect(
        enrichRecallQueryWithWorkspaceContext('current repo latest handoff', {
          cwd: repoRoot,
          includeProcessCwd: false,
        }),
      ).resolves.toContain('mobile-feedback-results-fix');
      const projectScoped = await enrichRecallQueryWithWorkspaceProjectContext('current repo latest handoff', {
        cwd: repoRoot,
        includeProcessCwd: false,
      });
      const projectTerms = Effect.pipe(projectScoped, EffectString.split(/\s+/));
      expect(projectTerms).toContain('threadnote');
      expect(projectTerms).not.toContain(basename(repoRoot));
      expect(projectScoped).not.toContain('mobile-feedback-results-fix');
      await expect(
        enrichRecallQueryWithWorkspaceContext('current repo latest handoff', {includeProcessCwd: false}),
      ).resolves.toBe('current repo latest handoff');
      await expect(
        enrichRecallQueryWithWorkspaceContext('current repo latest handoff', {
          cwd: '.',
          includeProcessCwd: false,
        }),
      ).resolves.toBe('current repo latest handoff');
    } finally {
      if (previousCallerCwd === undefined) {
        delete process.env.THREADNOTE_CALLER_CWD;
      } else {
        process.env.THREADNOTE_CALLER_CWD = previousCallerCwd;
      }
      for (const key of gitEnvKeys) {
        const value = previousGitEnv.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(repoRoot, {recursive: true, force: true});
    }
  });
});
