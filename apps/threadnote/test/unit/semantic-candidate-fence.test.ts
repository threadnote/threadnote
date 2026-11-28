import {mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {semanticCandidateMetadata} from '../../src/semantic/candidate_fence.js';

// The fence is synchronous host file metadata, so this is a plain operating-system file test.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tn-candidate-fence-')));
  roots.push(root);
  mkdirSync(join(root, 'sdk', 'bin'), {recursive: true});
  writeFileSync(join(root, 'sdk', 'bin', 'tool'), 'reviewed');
  writeFileSync(join(root, 'provider'), 'provider');
  return {root, candidateRoots: [join(root, 'provider'), join(root, 'sdk')]};
}

it('stays equal for unchanged candidate trees and changes for any byte, entry or link change', () => {
  const f = fixture();
  const first = semanticCandidateMetadata(f.candidateRoots);
  expect(first).toMatch(/^[0-9a-f]{64}$/u);
  expect(semanticCandidateMetadata(f.candidateRoots)).toBe(first);
  // Same length, restored modification time: the change time still moves.
  const tool = join(f.root, 'sdk', 'bin', 'tool');
  const before = statSync(tool);
  writeFileSync(tool, 'tampered');
  utimesSync(tool, before.atime, before.mtime);
  const changed = semanticCandidateMetadata(f.candidateRoots);
  expect(changed).not.toBe(first);
  writeFileSync(join(f.root, 'sdk', 'bin', 'extra'), '');
  expect(semanticCandidateMetadata(f.candidateRoots)).not.toBe(changed);
});

it('reports an incomplete snapshot instead of a fence for a missing root', () => {
  const f = fixture();
  expect(semanticCandidateMetadata([...f.candidateRoots, join(f.root, 'absent')])).toBeUndefined();
});

it('does not fence a native SDK with Git metadata that may reference files outside the candidate roots', () => {
  const f = fixture();
  const sdk = join(f.root, 'sdk');
  expect(semanticCandidateMetadata(f.candidateRoots, sdk)).toMatch(/^[0-9a-f]{64}$/u);
  writeFileSync(join(sdk, '.git'), 'gitdir: ../external');
  expect(semanticCandidateMetadata(f.candidateRoots, sdk)).toBeUndefined();
});
