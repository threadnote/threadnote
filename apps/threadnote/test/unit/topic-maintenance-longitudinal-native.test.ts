import {sha256HexSync} from '@threadnote/platform/sha256';
import {mkdtemp, mkdir, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {tmpdir} from '@threadnote/testing/node-os';
import {describe, expect, it} from 'vitest';
import {
  parseTopicStudyCorpusJsonV1,
  topicStudyProbePromptV1,
  topicStudyBodyV1,
} from '@threadnote/threadnote/evaluation/topic-maintenance-longitudinal';
import {runTopicStudyNativeAdapter} from '../../../../scripts/topic-maintenance-longitudinal-native-adapter.js';

async function fixture(
  index: number,
  outcome: string,
  applyResponse: 'written' | 'preview-write' | 'altered-write' | 'unrelated-error' | 'source-conflict' = 'written',
) {
  const directory = await mkdtemp(join(tmpdir(), 'topic-study-native-'));
  const home = join(directory, 'home'),
    repository = join(directory, 'repo');
  await mkdir(home);
  await mkdir(repository);
  const corpus = parseTopicStudyCorpusJsonV1(
    await readFile('apps/threadnote/test/evaluation/fixtures/topic-maintenance-v1/sequence.json', 'utf8'),
  );
  const event = corpus.events[index - 1];
  const body = ['intro', 'policy', 'history', 'The production fixture timeout is 90 seconds.', 'later exception'];
  const manifest = {
    version: 1,
    memoryId: 'tn_fixture',
    repositoryId: 'repo',
    coverage: 'declared-only',
    bodyHash: sha256HexSync(body.join('\n\n')),
    additionalDependencies: [],
    paragraphs: body.map((text, ordinal) => ({
      ordinal,
      hash: sha256HexSync(text),
      role: 'descriptive',
      support: 'direct',
      citationIds: ['original'],
    })),
  };
  const citation = {
    id: 'original',
    repositoryId: 'repo',
    sourceCommit: 'a'.repeat(40),
    fileContentHash: {algorithm: 'sha256', value: 'b'.repeat(64)},
  };
  const accepted = `MEMORY\nkind: durable\nmemory_id: tn_fixture\nproject: fixture\ncode_citation: ${JSON.stringify(citation)}\ntopic_maintenance: ${JSON.stringify(manifest)}\n\n${body.join('\n\n')}`;
  const nextBody = body.map(text => text.replace('90 seconds', '95 seconds'));
  const nextManifest = {
    ...manifest,
    version: 2,
    bodyHash: sha256HexSync(nextBody.join('\n\n')),
    originCitationIds: ['original'],
    acceptedSources: [{citationId: 'original', acceptedCitationId: 'original'}],
    paragraphs: manifest.paragraphs.map((paragraph, ordinal) => ({
      ...paragraph,
      hash: sha256HexSync(nextBody[ordinal]),
    })),
  };
  const preview =
    accepted.slice(0, accepted.indexOf('topic_maintenance:')) +
    `topic_maintenance: ${JSON.stringify(nextManifest)}\n\n${nextBody.join('\n\n')}`;
  const reviewId = 'review-fixture',
    digest = 'a'.repeat(64);
  await writeFile(join(repository, 'config.ts'), 'export const timeoutSeconds = 95;\n');
  await writeFile(
    join(home, 'study-state.json'),
    JSON.stringify({
      uri: 'threadnote://fixture',
      memoryId: 'tn_fixture',
      caseId: 'case-fixture',
      accepted,
      originalParagraphs: body,
      lastEvidenceRevision: 'prior',
      reviewId: null,
      reviewRevision: null,
      naiveBody: body.join('\n\n'),
      manualUri: null,
      manualBody: body.join('\n\n'),
      lastApplied: {reviewId, revision: 2, digest},
    }),
  );
  const manifestPath = join(directory, 'manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      modelId: 'local',
      alternatePermitted: false,
      alternateModelId: null,
      verifiedModel: {id: 'local', sha256: 'b'.repeat(64), size: 0, path: 'unused-model-port', stamp: 'unused'},
    }),
  );
  const commands: string[][] = [];
  let currentAccepted = accepted;
  let previewRevision = 0;
  const ports = {
    execute: async (command: readonly string[]) => {
      commands.push([...command]);
      let stdout = '',
        stderr = '',
        exitCode = 0;
      if (command[0] === 'git') stdout = 'a'.repeat(40);
      else if (command[1] === 'read') stdout = currentAccepted;
      else if (command.includes('brief'))
        stdout = 'THREADNOTE BRIEF\nState: fresh\nCoverage: declared-only\nconfig.ts: current timeout 95 seconds';
      else if (command.includes('draft'))
        stdout = JSON.stringify({
          reviewId,
          revision: 1,
          maintenance: {
            proposal: {body: body.join('\n\n'), draft: {outcome}},
            generation: {
              model: 'local',
              modelVersion: `actual-v1:${'b'.repeat(64)};maxTokens=4000;seed=0`,
              promptVersion: 'actual-prompt-v1',
              attempts: 2,
              usage: {status: 'unavailable'},
            },
          },
        });
      else if (command.includes('draft-defer')) stdout = JSON.stringify({revision: 3});
      else if (command.includes('draft-resume')) stdout = JSON.stringify({revision: 4});
      else if (command.includes('draft-preview'))
        stdout = JSON.stringify({
          revision: ++previewRevision === 1 ? 2 : 5,
          maintenanceApproval: {preview: {content: preview, approvalDigest: digest}},
        });
      else if (command.includes('draft-apply')) {
        if (
          !command.includes('--approved') ||
          applyResponse === 'unrelated-error' ||
          applyResponse === 'source-conflict'
        ) {
          exitCode = 1;
          stderr = JSON.stringify(
            applyResponse === 'source-conflict'
              ? {_tag: 'TopicReviewSourceError', message: 'The reviewed declared source changed or is unavailable.'}
              : {_tag: 'UnexpectedRuntimeError', message: 'unrelated failure'},
          );
        } else {
          currentAccepted =
            applyResponse === 'preview-write'
              ? preview
              : applyResponse === 'altered-write'
                ? preview.replace('\n\n', '\nlast_reviewed: 2026-10-16T00:00:00Z\n\n')
                : accepted;
          stdout = JSON.stringify({
            reviewId,
            candidates: [{state: 'applied'}],
            maintenanceApproval: {
              stage: 'written',
              reviewRevision: Number(command[command.indexOf('--revision') + 1]),
              preview: {approvalDigest: digest, content: currentAccepted},
            },
          });
        }
      } else if (command.includes('run'))
        stdout = JSON.stringify({
          cases: [
            {
              family: 'topic-maintenance',
              memoryId: 'tn_fixture',
              caseId: 'case-fixture',
              disposition: 'needs-decision',
              evidenceRevision: 'new',
            },
          ],
        });
      return {stdout, stderr, exitCode, elapsed: 1};
    },
    generate: async () => ({
      draft: JSON.stringify(Object.fromEntries(event.probes.map(probe => [probe.id, 'unknown']))),
      elapsedMilliseconds: 1,
      model: {
        backend: 'local-ai',
        id: 'local',
        digest: 'b'.repeat(64),
        modelVersion: 'actual-local-v1',
        settingsHash: 'c'.repeat(64),
        promptVersion: 'probe-v1',
        attempts: 1,
      },
      promptHash: 'd'.repeat(64),
      providerInputTokens: null,
      providerOutputTokens: null,
      providerChargeMicros: 0,
    }),
  };
  return {
    directory,
    repository,
    accepted,
    commands,
    request: {
      version: 1 as const,
      event,
      arm: 'maintained-local' as const,
      manifestPath,
      binary: '/public-threadnote-cli',
      repository,
      home,
      baseline: 'unused-baseline',
    },
    ports,
  };
}

describe('native public CLI longitudinal contract', () => {
  it.each(['policy-conflict', 'insufficient-evidence'])(
    'observes safe %s without preview/apply or accepted changes',
    async outcome => {
      const value = await fixture(17, outcome);
      try {
        const result = await runTopicStudyNativeAdapter(value.request, value.ports);
        expect(result.status).toBe('observed');
        expect(result.actualClass).toBe(outcome);
        expect(result.targetBeforeHash).toBe(result.targetAfterHash);
        expect(
          value.commands.some(command => command.includes('draft-preview') || command.includes('draft-apply')),
        ).toBe(false);
        expect(result.model?.modelVersion).toBe(`actual-v1:${'b'.repeat(64)};maxTokens=4000;seed=0`);
        expect(result.model?.promptVersion).toBe('actual-prompt-v1');
        expect(result.model?.attempts).toBe(2);
        expect(result.promptHash).toBeNull();
      } finally {
        await rm(value.directory, {recursive: true, force: true});
      }
    },
  );

  it.each([37, 28])('binds normal and resumed apply to the reviewed preview (event %s)', async index => {
    for (const response of ['written', 'altered-write', 'preview-write'] as const) {
      const value = await fixture(index, 'propose-update', response);
      try {
        const result = await runTopicStudyNativeAdapter(value.request, value.ports);
        expect(result.status).toBe(response === 'preview-write' ? 'observed' : 'failed');
        expect(result.accepted).toBe(response === 'preview-write');
        expect(result.approved).toBe(response === 'preview-write');
      } finally {
        await rm(value.directory, {recursive: true, force: true});
      }
    }
  });

  it('replays final source changes even if a post-preview apply fails for an unrelated reason', async () => {
    const value = await fixture(24, 'propose-update', 'unrelated-error');
    try {
      const result = await runTopicStudyNativeAdapter(value.request, value.ports);
      expect(result.reason).toContain('lacks a supported exact structured domain error');
      expect(result.status).toBe('unavailable');
      expect(result.actualClass).not.toBe('stale-conflict');
      expect(await readFile(join(value.repository, 'config.ts'), 'utf8')).toContain('timeoutSeconds = 90');
      expect(result.targetBeforeHash).toBe(result.targetAfterHash);
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  });

  it('counts an exact typed stale-source refusal with unchanged accepted bytes as observed conflict', async () => {
    const value = await fixture(24, 'propose-update', 'source-conflict');
    try {
      const result = await runTopicStudyNativeAdapter(value.request, value.ports);
      expect(result.status).toBe('observed');
      expect(result.actualClass).toBe('stale-conflict');
      expect(result.targetBeforeHash).toBe(result.targetAfterHash);
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  });

  it.each(['written', 'unrelated-error'] as const)(
    'accepts replay only with an exact written public receipt (%s)',
    async response => {
      const value = await fixture(25, 'propose-update', response);
      try {
        const result = await runTopicStudyNativeAdapter(value.request, value.ports);
        expect(result.status).toBe(response === 'written' ? 'observed' : 'failed');
        expect(result.targetBeforeHash).toBe(result.targetAfterHash);
      } finally {
        await rm(value.directory, {recursive: true, force: true});
      }
    },
  );

  it('updates the scripted manual staging claim from source 45 to 50 without changing production scope', async () => {
    const value = await fixture(41, 'propose-revalidation');
    try {
      const statePath = join(value.request.home, 'study-state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {manualUri: string | null; manualBody: string};
      state.manualUri = 'threadnote://manual';
      state.manualBody =
        topicStudyBodyV1(value.accepted).replace('90 seconds', '100 seconds') +
        '\n\nThe staging fixture timeout is 45 seconds.';
      await writeFile(statePath, JSON.stringify(state));
      await writeFile(
        join(value.repository, 'config.ts'),
        'export const timeoutSeconds = 100;\nexport const stagingTimeoutSeconds = 50;\n',
      );
      const header = 'MEMORY\nkind: durable\nmemory_id: tn_manual\nproject: fixture\n\n';
      let manual = header + state.manualBody;
      const result = await runTopicStudyNativeAdapter(
        {...value.request, arm: 'scripted-manual'},
        {
          ...value.ports,
          execute: async command => {
            if (command[1] === 'read' && command[2] === 'threadnote://manual')
              return {stdout: manual, stderr: '', exitCode: 0, elapsed: 1};
            if (command[1] === 'remember') {
              manual = header + command[command.indexOf('--text') + 1];
              return {stdout: 'Stored memory: threadnote://manual', stderr: '', exitCode: 0, elapsed: 1};
            }
            return value.ports.execute(command);
          },
        },
      );
      expect(result.status).toBe('observed');
      expect(result.accepted).toBe(true);
      expect(manual).toContain('The staging fixture timeout is 50 seconds.');
      expect(manual).toContain('The production fixture timeout is 100 seconds.');
      expect(manual).not.toContain('production fixture timeout is 50 seconds');
      expect(manual).toContain('later exception');
      expect(manual).not.toContain('staging fixture timeout is 45 seconds');
      expect(manual.match(/The staging fixture timeout/g)).toHaveLength(1);
      expect(result.unrelatedBodyPreserved).toBe(true);
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  });

  it('gives identical accepted bytes distinct public current-evidence inputs after source deletion without leaking gold', () => {
    const questions = [{id: 'current', question: 'Verified current timeout?', answer: 'SECRET-GOLD'}];
    const present = topicStudyProbePromptV1(
      'Accepted current value 60 seconds.',
      'State fresh; config.ts source current and covered',
      questions,
    );
    const missing = topicStudyProbePromptV1(
      'Accepted current value 60 seconds.',
      'State unavailable; config.ts deleted; current support missing',
      questions,
    );
    expect(present).not.toBe(missing);
    expect(missing).toContain('current support missing');
    expect(present).not.toContain('SECRET-GOLD');
    expect(missing).not.toContain('SECRET-GOLD');
  });
});
