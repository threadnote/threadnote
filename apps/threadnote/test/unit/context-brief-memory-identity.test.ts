import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  contextBriefMemoryEligibilityPolicy,
  retrieveContextBriefMemoryEvidence,
} from '@threadnote/threadnote/context_brief/memory_evidence';
import {planContextBrief} from '@threadnote/context/planner';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {recallCandidateIsEligible} from '@threadnote/recall/eligibility';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('Context Brief stable memory identity eligibility', () => {
  effectIt.effect('never emits an alias identity that is divergent in the authorized corpus', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-brief-identity-'});
      const manifestPath = path.join(home, 'seed-manifest.yaml');
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath,
        user: 'me',
      };
      yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
      const root = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'projects', 'threadnote');
      yield* fs.makeDirectory(root, {recursive: true});
      yield* fs.writeFileString(path.join(root, 'first.md'), memory('First conflicting identity evidence.'));
      yield* fs.writeFileString(path.join(root, 'second.md'), memory('Second divergent identity evidence.'));
      const plan = planContextBrief({
        budgetTokens: 1_500,
        codeRefs: ['apps/threadnote/src/context_brief/memory_evidence.ts'],
        mode: 'locate',
        scope: {callerCwd: '/workspace/threadnote', kind: 'repository', project: 'threadnote'},
        task: 'conflicting identity evidence',
      });

      const retrieval = yield* retrieveContextBriefMemoryEvidence(config, plan.memory);

      expect(retrieval.candidates.length).toBeGreaterThan(0);
      expect(retrieval.candidates.every(candidate => candidate.memoryId === undefined)).toBe(true);
      expect(retrieval.gaps).toContain('stable-memory-identity-unavailable');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('limits inferred repository memory retrieval to the caller repo across nested checkouts', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-brief-project-scope-'});
      const repository = path.join(home, 'outer-repository');
      const nestedRepository = path.join(repository, 'nested-independent');
      yield* fs.makeDirectory(nestedRepository, {recursive: true});
      for (const cwd of [repository, nestedRepository]) {
        const initialized = Bun.spawnSync({cmd: ['git', 'init', '--quiet', cwd], stderr: 'pipe', stdout: 'pipe'});
        expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
      }

      const manifestPath = path.join(home, 'seed-manifest.yaml');
      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath,
        user: 'me',
      };
      yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
      const memoryRoot = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'projects');
      yield* fs.makeDirectory(path.join(memoryRoot, 'outer-repository'), {recursive: true});
      yield* fs.makeDirectory(path.join(memoryRoot, 'nested-independent'), {recursive: true});
      yield* fs.writeFileString(
        path.join(memoryRoot, 'outer-repository', 'total-contract.md'),
        memoryForProject(
          'outer-repository',
          'outer-total-contract',
          'The outer repository calculateTotal contract validates input.',
        ),
      );
      yield* fs.writeFileString(
        path.join(memoryRoot, 'nested-independent', 'total-contract.md'),
        memoryForProject(
          'nested-independent',
          'nested-total-contract',
          'The nested repository calculateTotal contract validates input.',
        ),
      );

      const retrieve = (callerCwd: string) => {
        const plan = planContextBrief({
          budgetTokens: 1_500,
          mode: 'brief',
          scope: {callerCwd, kind: 'repository'},
          task: 'Explain the calculateTotal contract for this repository',
        });
        return retrieveContextBriefMemoryEvidence(config, plan.memory);
      };
      const outer = yield* retrieve(repository);
      const nested = yield* retrieve(nestedRepository);

      expect(outer.candidates.map(candidate => candidate.topic)).toContain('outer-total-contract');
      expect(outer.candidates.map(candidate => candidate.topic)).not.toContain('nested-total-contract');
      expect(nested.candidates.map(candidate => candidate.topic)).toContain('nested-total-contract');
      expect(nested.candidates.map(candidate => candidate.topic)).not.toContain('outer-total-contract');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

describe('Context Brief memory project eligibility', () => {
  it('keeps workset eligibility within members and intersects an explicit project', () => {
    const projectName = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/);
    fc.assert(
      fc.property(
        fc.uniqueArray(projectName, {maxLength: 8, minLength: 1}),
        fc.option(projectName, {nil: undefined}),
        fc.option(projectName, {nil: undefined}),
        (members, selectedProject, candidateProject) => {
          const policy = contextBriefMemoryEligibilityPolicy(
            {kind: 'workset', name: 'platform', ...(selectedProject === undefined ? {} : {project: selectedProject})},
            'ordinary project guidance',
            {kind: 'workset', projects: members},
          ).policy;
          const eligible = recallCandidateIsEligible(
            policy,
            candidateProject === undefined ? {} : {project: candidateProject},
          );
          const normalizedMembers = new Set(members.map(project => project.normalize('NFC').toLowerCase()));
          const normalizedSelected = selectedProject?.normalize('NFC').toLowerCase();
          const selectedIsMember = normalizedSelected !== undefined && normalizedMembers.has(normalizedSelected);
          const expected =
            selectedProject !== undefined && !selectedIsMember
              ? false
              : candidateProject === undefined ||
                (selectedProject === undefined
                  ? normalizedMembers.has(candidateProject.normalize('NFC').toLowerCase())
                  : candidateProject.normalize('NFC').toLowerCase() === normalizedSelected);
          expect(eligible).toBe(expected);
        },
      ),
      {numRuns: 64},
    );
  });

  it('keeps only projectless memories when repository identity cannot be resolved', () => {
    const result = contextBriefMemoryEligibilityPolicy(
      {callerCwd: '/not/a/repository', kind: 'repository'},
      'ordinary project guidance',
      {kind: 'repository'},
    );

    expect(result.gap).toBe('memory-project-scope-unavailable');
    expect(recallCandidateIsEligible(result.policy, {})).toBe(true);
    expect(recallCandidateIsEligible(result.policy, {project: 'another-project'})).toBe(false);
  });
});

function memory(body: string): string {
  return [
    'MEMORY',
    'kind: durable',
    'status: active',
    'project: threadnote',
    'topic: conflicting-identity',
    'memory_id: tn_context_brief_conflict',
    'source_agent_client: test',
    'timestamp: 2026-08-31T00:00:00.000Z',
    '',
    body,
  ].join('\n');
}

function memoryForProject(project: string, topic: string, body: string): string {
  return [
    'MEMORY',
    'kind: durable',
    'status: active',
    `project: ${project}`,
    `topic: ${topic}`,
    'source_agent_client: test',
    'timestamp: 2026-10-08T00:00:00.000Z',
    '',
    body,
  ].join('\n');
}
