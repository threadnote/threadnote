import {sha256HexSync} from '@threadnote/platform/sha256';
import {mkdtemp, mkdir, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {tmpdir} from '@threadnote/testing/node-os';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  parseTopicStudyCorpusJsonV1,
  topicStudyProbePromptV1,
  topicStudyBodyV1,
  topicStudyPreconditionFailedV1,
  topicStudyCorpusHashV1,
  topicStudyLedgerRowV1,
  summarizeTopicStudyV1,
} from '@threadnote/threadnote/evaluation/topic-maintenance-longitudinal';
import {
  projectTopicStudySourceBriefV1,
  runTopicStudyNativeAdapter,
} from '../../../../scripts/topic-maintenance-longitudinal-native-adapter.js';
import {appendTopicStudySlotV1} from '../../../../scripts/run-topic-maintenance-longitudinal.js';

function publicSourceBrief(sources: readonly {path: string; content: string}[]) {
  return {
    activeHandoffs: [],
    durableDecisions: [],
    stalenessAndConflicts: [],
    coverage: {
      gaps: [],
      memory: {consideredCandidates: 0, codeAnchors: {matchedMemories: 0}},
      omissions: {sourceExcerpts: 0},
    },
    scope: {freshness: 'fresh'},
    evidenceState: 'fresh',
    output: {truncated: false},
    graph: {
      sources: sources.map(source => ({
        ...source,
        id: 'random-source-id',
        repositoryKey: 'random-repository',
        coveredGraphRefs: ['random-graph-ref'],
        startLine: 1,
        endLine: source.content.split('\n').length,
        freshness: 'fresh',
        evidenceKind: 'graph-snapshot',
        snapshotIdentity: 'current-clean',
        truncated: false,
      })),
    },
  };
}

async function comparatorFixture(arm: 'scripted-manual' | 'naive-local') {
  const value = await fixture(37, 'propose-update');
  const statePath = join(value.request.home, 'study-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const header = 'MEMORY\nkind: durable\nmemory_id: tn_manual\nproject: fixture\n\n';
  let manual = header + state.manualBody;
  if (arm === 'scripted-manual') {
    state.manualUri = 'threadnote://manual';
    await writeFile(statePath, JSON.stringify(state));
  }
  const prompts: string[] = [];
  const ports = {
    ...value.ports,
    execute: async (command: readonly string[]) => {
      if (command[1] === 'read' && command[2] === 'threadnote://manual') {
        value.commands.push([...command]);
        return {stdout: manual, stderr: '', exitCode: 0, elapsed: 1};
      }
      if (command[1] === 'remember') {
        value.commands.push([...command]);
        manual = header + command[command.indexOf('--text') + 1];
        return {stdout: 'Stored memory: threadnote://manual', stderr: '', exitCode: 0, elapsed: 1};
      }
      const response = await value.ports.execute(command);
      if (!command.includes('run')) return response;
      const payload = JSON.parse(response.stdout);
      return {
        ...response,
        stdout: JSON.stringify({
          ...payload,
          state: 'idle',
          cases: payload.cases.map((item: object) => ({...item, disposition: 'resolved', evidenceRevision: 'prior'})),
        }),
      };
    },
    generate: async (prompt: string) => {
      prompts.push(prompt);
      const generated = await value.ports.generate();
      return prompt.startsWith('Rewrite')
        ? {
            ...generated,
            draft: 'intro\n\npolicy\n\nhistory\n\nThe production fixture timeout is 95 seconds.\n\nlater exception',
          }
        : generated;
    },
  };
  return {...value, request: {...value.request, arm}, ports, prompts, manual: () => manual};
}

async function fixture(
  index: number,
  outcome: string,
  applyResponse: 'written' | 'preview-write' | 'altered-write' | 'unrelated-error' | 'source-conflict' = 'written',
  startingRevision = 1,
  badProtectedPreview = false,
  previewBody?: readonly string[],
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
  const body = [
    'intro',
    'policy',
    'history',
    'The production fixture timeout is 90 seconds.',
    'The display heading is Context Health.',
  ];
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
  const nextBody =
    previewBody ??
    body.map((text, ordinal) =>
      badProtectedPreview
        ? ordinal === 0
          ? 'The initial fixture used a 30-second timeout.'
          : text
        : text.replace('90 seconds', '95 seconds'),
    );
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
  await writeFile(join(repository, 'config.ts'), `export const timeoutSeconds = ${badProtectedPreview ? 90 : 95};\n`);
  await writeFile(
    join(repository, 'health.ts'),
    'export const title = "Context Health";\nexport const preserveUntilReview = true;\n',
  );
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
  const generation = {
    model: 'local',
    modelVersion: `actual-v1:${'b'.repeat(64)};maxTokens=4000;seed=0`,
    promptVersion: 'actual-prompt-v1',
    attempts: 2,
    usage: {status: 'unavailable'},
  };
  type Review = {
    reviewId: string;
    revision: number;
    project: string;
    candidates: {candidateId: string; state: string}[];
    maintenance: {
      basis: {targetUri: string; observationRevision: string};
      proposal: {body: string; draft: {outcome: string}};
      generation: typeof generation;
    };
    auditEvents: {action: string; revision: number; candidateId: string; reviewId: string}[];
    maintenanceApproval?: {stage: string; preview: {content: string; approvalDigest: string}};
  };
  let review: Review = {
    reviewId,
    revision: startingRevision,
    project: 'fixture',
    candidates: [{candidateId: `${reviewId}-1`, state: 'pending'}],
    maintenance: {
      basis: {targetUri: 'threadnote://fixture', observationRevision: 'new'},
      proposal: {body: body.join('\n\n'), draft: {outcome}},
      generation,
    },
    auditEvents: [],
  };
  let draftCount = 0;
  let lastDraftSource = '';

  const ports = {
    execute: async (command: readonly string[]) => {
      commands.push([...command]);
      let stdout = '',
        stderr = '',
        exitCode = 0;
      if (command[0] === 'git') stdout = command[1] === 'status' ? '' : 'a'.repeat(40);
      else if (command[1] === 'read') stdout = currentAccepted;
      else if (command.includes('brief')) {
        expect(command).toContain('--home');
        expect(command).toContain('--json');
        const sources = [];
        for (const path of ['health.ts', 'config.ts']) {
          const content = await readFile(join(repository, path), 'utf8').catch(() => null);
          if (content !== null) sources.push({path, content});
        }
        stdout = JSON.stringify(publicSourceBrief(sources));
      } else if (command.includes('draft')) {
        const source =
          (await readFile(join(repository, 'config.ts'), 'utf8')) +
          (await readFile(join(repository, 'health.ts'), 'utf8').catch(() => ''));
        if (draftCount > 0 && review.candidates[0].state === 'pending') {
          exitCode = 1;
          stderr = 'A reviewed topic preview is pending. Resolve it before regenerating.';
        } else if (draftCount > 0 && review.candidates[0].state === 'rejected' && source === lastDraftSource) {
          exitCode = 1;
          stderr = 'This exact topic evidence was rejected. A material change is required before redrafting.';
        } else {
          if (draftCount > 0)
            review = {
              ...review,
              revision: review.revision + 1,
              candidates: [{candidateId: `${reviewId}-1`, state: 'pending'}],
              maintenanceApproval: undefined,
            };
          draftCount++;
          lastDraftSource = source;
          stdout = JSON.stringify(review);
        }
      } else if (command.includes('draft-view')) stdout = JSON.stringify(review);
      else if (command.includes('draft-reject')) {
        if (
          Number(command[command.indexOf('--revision') + 1]) !== review.revision ||
          command[command.indexOf('--case-id') + 1] !== 'case-fixture' ||
          review.candidates[0].state !== 'pending'
        ) {
          exitCode = 1;
          stderr = 'Exact pending review revision/case required.';
        } else {
          review = {
            ...review,
            revision: review.revision + 1,
            candidates: [{candidateId: `${reviewId}-1`, state: 'rejected'}],
            maintenanceApproval: undefined,
          };
          review.auditEvents.push({
            action: 'reject',
            revision: review.revision,
            candidateId: `${reviewId}-1`,
            reviewId,
          });
          stdout = JSON.stringify(review);
        }
      } else if (command.includes('draft-defer') || command.includes('draft-resume')) {
        review = {
          ...review,
          revision: review.revision + 1,
          candidates: [{candidateId: `${reviewId}-1`, state: command.includes('draft-defer') ? 'deferred' : 'pending'}],
        };
        stdout = JSON.stringify(review);
      } else if (command.includes('draft-preview')) {
        review = {
          ...review,
          revision: review.revision + 1,
          maintenanceApproval: {stage: 'preview', preview: {content: preview, approvalDigest: digest}},
        };
        stdout = JSON.stringify(review);
      } else if (command.includes('draft-apply')) {
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
      } else if (command.includes('status'))
        stdout = JSON.stringify({
          cases: [
            {
              caseId: 'case-fixture',
              family: 'topic-maintenance',
              project: 'fixture',
              slot: 'declared-support',
              subjectUri: 'threadnote://fixture',
            },
          ],
        });
      else if (command.includes('run'))
        stdout = JSON.stringify({
          state: 'needs-decision',
          cases: [
            {
              family: 'topic-maintenance',
              memoryId: 'tn_fixture',
              caseId: 'case-fixture',
              disposition: 'needs-decision',
              evidenceRevision: 'new',
              lastChecked: new Date().toISOString(),
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
    getReview: () => review,
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
  it.each(['resolved', 'needs-decision'])(
    'waits past a retained %s case until the current event has been observed',
    async disposition => {
      const value = await fixture(17, 'policy-conflict');
      let turns = 0;
      try {
        const result = await runTopicStudyNativeAdapter(value.request, {
          ...value.ports,
          execute: async command => {
            if (command.includes('run') && ++turns === 1)
              return {
                stdout: JSON.stringify({
                  state: disposition === 'resolved' ? 'running' : 'needs-decision',
                  cases: [
                    {
                      family: 'topic-maintenance',
                      memoryId: 'tn_fixture',
                      caseId: 'case-fixture',
                      disposition,
                      evidenceRevision: 'prior',
                      lastChecked: '2000-01-01T00:00:00.000Z',
                    },
                  ],
                }),
                stderr: '',
                exitCode: 0,
                elapsed: 1,
              };
            if (command.includes('draft')) expect(turns).toBeGreaterThan(1);
            return value.ports.execute(command);
          },
        });
        expect(turns).toBe(2);
        expect(result.status).toBe('observed');
        expect(result.actualClass).toBe('policy-conflict');
      } finally {
        await rm(value.directory, {recursive: true, force: true});
      }
    },
  );

  it('accepts a newly checked unchanged case without requiring its revision to change', async () => {
    const value = await fixture(17, 'policy-conflict');
    try {
      const result = await runTopicStudyNativeAdapter(value.request, {
        ...value.ports,
        execute: async command => {
          const response = await value.ports.execute(command);
          if (!command.includes('run')) return response;
          const payload = JSON.parse(response.stdout);
          return {
            ...response,
            stdout: JSON.stringify({
              ...payload,
              state: 'idle',
              cases: payload.cases.map((item: object) => ({
                ...item,
                disposition: 'resolved',
                evidenceRevision: 'prior',
              })),
            }),
          };
        },
      });
      expect(result.status).toBe('observed');
      expect(result.actualClass).toBe('unchanged');
      expect(result.draftAttempted).toBe(false);
      expect(value.commands.filter(command => command.includes('run'))).toHaveLength(1);
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  });

  it('records an unavailable precondition after bounded stale responses without calling a model', async () => {
    const value = await fixture(17, 'policy-conflict');
    let turns = 0,
      generations = 0;
    try {
      const result = await runTopicStudyNativeAdapter(value.request, {
        ...value.ports,
        execute: async command => {
          if (command.includes('run')) {
            turns++;
            return {
              stdout: JSON.stringify({
                state: 'running',
                cases: [
                  {
                    family: 'topic-maintenance',
                    memoryId: 'tn_fixture',
                    caseId: 'case-fixture',
                    disposition: 'needs-decision',
                    evidenceRevision: 'prior',
                    lastChecked: '2000-01-01T00:00:00.000Z',
                  },
                ],
              }),
              stderr: '',
              exitCode: 0,
              elapsed: 1,
            };
          }
          return value.ports.execute(command);
        },
        generate: async () => {
          generations++;
          return value.ports.generate();
        },
      });
      expect(turns).toBe(8);
      expect(result.status).toBe('unavailable');
      expect(result.reason).toContain('current-event observation');
      expect(generations).toBe(0);
      expect(value.commands.some(command => command.includes('draft'))).toBe(false);
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  });

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
        expect(value.commands.filter(command => command.includes('draft-reject'))).toHaveLength(1);
        expect(value.getReview().candidates[0].state).toBe('rejected');
        expect(value.getReview().maintenanceApproval).toBeUndefined();
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
        if (response === 'preview-write')
          expect(value.commands.some(command => command.includes('draft-reject'))).toBe(false);
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
      expect(value.getReview().candidates[0].state).toBe('rejected');
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
      expect(value.getReview().candidates[0].state).toBe('rejected');
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
      expect(manual).toContain('history');
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

it('publicly rejects the exact prepared revision after a bad preview and admits the next material source change', async () => {
  const value = await fixture(8, 'propose-update', 'written', 9, true);
  try {
    const first = await runTopicStudyNativeAdapter(value.request, value.ports);
    expect(first.status).toBe('failed');
    expect(first.reason).toBe('Independent protected-content/current-value check rejected draft.');
    expect(first.identityPreserved).toBe(true);
    expect(first.provenancePreserved).toBe(true);
    expect(first.unrelatedBodyPreserved).toBe(true);
    expect(first.draftAttempted).toBe(true);
    expect(first.draftCompleted).toBe(true);
    expect(first.computeMilliseconds).toBe(1);
    expect(first.accepted).toBe(false);
    const rejected = value.commands.find(command => command.includes('draft-reject'));
    expect(rejected?.[rejected.indexOf('--revision') + 1]).toBe('10');
    expect(rejected?.[rejected.indexOf('--case-id') + 1]).toBe('case-fixture');
    const state = JSON.parse(await readFile(join(value.request.home, 'study-state.json'), 'utf8'));
    expect(state.reviewRevision).toBe(11);
    expect(first.targetBeforeHash).toBe(first.targetAfterHash);
    await writeFile(join(value.repository, 'health.ts'), 'export const title = "material change";\n');
    const second = await runTopicStudyNativeAdapter(
      {...value.request, event: {...value.request.event, index: 9, id: 'material-change'}},
      {
        ...value.ports,
        execute: async command => {
          const response = await value.ports.execute(command);
          if (!command.includes('run')) return response;
          const result = JSON.parse(response.stdout);
          return {
            ...response,
            stdout: JSON.stringify({
              ...result,
              cases: result.cases.map((item: object) => ({...item, evidenceRevision: 'material-two'})),
            }),
          };
        },
      },
    );
    expect(second.draftCompleted).toBe(true);
    expect(value.commands.filter(command => command.includes('draft'))).toHaveLength(2);
    expect(second.reason).not.toBe('Draft generation failed.');
  } finally {
    await rm(value.directory, {recursive: true, force: true});
  }
});

it('fails closed when public review cleanup fails instead of repeating blocked model requests', async () => {
  const value = await fixture(8, 'propose-update', 'written', 9, true);
  try {
    const ports = {
      ...value.ports,
      execute: async (command: readonly string[]) =>
        command.includes('draft-reject')
          ? {stdout: '', stderr: 'cleanup failed', exitCode: 1, elapsed: 1}
          : value.ports.execute(command),
    };
    const first = await runTopicStudyNativeAdapter(value.request, ports);
    expect(first.status).toBe('failed');
    expect(first.reason).toContain('precondition failure');
    expect(topicStudyPreconditionFailedV1(first)).toBe(true);
    expect(first.reason).toContain('Independent protected-content/current-value check rejected draft.');
    expect(first.draftCompleted).toBe(true);
    expect(first.computeMilliseconds).toBe(1);
    const count = value.commands.length;
    const next = await runTopicStudyNativeAdapter({...value.request, event: {...value.request.event, index: 9}}, ports);
    expect(next.reason).toContain('precondition failure');
    expect(value.commands).toHaveLength(count);
  } finally {
    await rm(value.directory, {recursive: true, force: true});
  }
});

it('closes safe non-applicable reviews at exactly the next revision for bounded arbitrary revisions', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({min: 1, max: 1_000_000}),
      fc.constantFrom('policy-conflict', 'insufficient-evidence'),
      async (revision, outcome) => {
        const value = await fixture(17, outcome, 'written', revision);
        try {
          const result = await runTopicStudyNativeAdapter(value.request, value.ports);
          expect(result.status).toBe('observed');
          expect(result.accepted).toBe(false);
          expect(value.getReview().revision).toBe(revision + 1);
          expect(value.getReview().candidates[0].state).toBe('rejected');
          expect(value.getReview().maintenanceApproval).toBeUndefined();
          const state = JSON.parse(await readFile(join(value.request.home, 'study-state.json'), 'utf8'));
          expect(state.reviewRevision).toBe(revision + 1);
          expect(state.accepted).toBe(value.accepted);
          expect(result.targetBeforeHash).toBe(result.targetAfterHash);
          expect(result.draftCompleted).toBe(true);
          expect(result.computeMilliseconds).toBe(1);
        } finally {
          await rm(value.directory, {recursive: true, force: true});
        }
      },
    ),
    {numRuns: 12},
  );
});

it.each(['generation-receipt', 'unknown-proposal', 'preview-refusal', 'apply-refusal', 'resumed-check'] as const)(
  'closes a produced review after %s failure without crediting its unsuccessful attempt',
  async failure => {
    const value = await fixture(failure === 'resumed-check' ? 28 : 37, 'propose-update', 'written', 9);
    let previews = 0;
    try {
      const result = await runTopicStudyNativeAdapter(value.request, {
        ...value.ports,
        execute: async command => {
          if (failure === 'preview-refusal' && command.includes('draft-preview'))
            return {stdout: '', stderr: 'preview refused', exitCode: 1, elapsed: 1};
          if (failure === 'apply-refusal' && command.includes('draft-apply') && command.includes('--approved'))
            return {stdout: '', stderr: 'apply refused', exitCode: 1, elapsed: 1};
          const response = await value.ports.execute(command);
          if (command.includes('draft') && ['generation-receipt', 'unknown-proposal'].includes(failure)) {
            const review = JSON.parse(response.stdout);
            if (failure === 'generation-receipt') review.maintenance.generation.modelVersion = 'unverified';
            else review.maintenance.proposal = {};
            return {...response, stdout: JSON.stringify(review)};
          }
          if (failure === 'resumed-check' && command.includes('draft-preview') && ++previews === 2) {
            const review = JSON.parse(response.stdout);
            review.maintenanceApproval.preview.content = review.maintenanceApproval.preview.content.replace(
              '\n\nintro\n\n',
              '\n\ncorrupted protected intro\n\n',
            );
            return {...response, stdout: JSON.stringify(review)};
          }
          return response;
        },
      });
      expect(result.status).toBe('failed');
      expect(topicStudyPreconditionFailedV1(result)).toBe(false);
      expect(result.draftAttempted).toBe(true);
      expect(result.draftCompleted).toBe(true);
      expect(result.accepted).toBe(false);
      expect(result.approved).toBe(false);
      expect(result.computeMilliseconds).toBe(1);
      expect(result.targetBeforeHash).toBe(result.targetAfterHash);
      expect(value.getReview().candidates[0].state).toBe('rejected');
      const rejection = value.commands.filter(command => command.includes('draft-reject'));
      expect(rejection).toHaveLength(1);
      const expectedRevision =
        failure === 'resumed-check'
          ? 13
          : ['generation-receipt', 'unknown-proposal', 'preview-refusal'].includes(failure)
            ? 9
            : 10;
      expect(rejection[0][rejection[0].indexOf('--revision') + 1]).toBe(String(expectedRevision));
      expect(value.getReview().revision).toBe(expectedRevision + 1);
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  },
);

it('keeps the authored rejection as one exact public decision without applying', async () => {
  const value = await fixture(27, 'propose-update', 'written', 9);
  try {
    const result = await runTopicStudyNativeAdapter(value.request, value.ports);
    expect(result.status).toBe('observed');
    expect(result.accepted).toBe(false);
    expect(value.commands.filter(command => command.includes('draft-reject'))).toHaveLength(1);
    expect(value.commands.some(command => command.includes('draft-apply') && command.includes('--approved'))).toBe(
      false,
    );
    expect(value.getReview().revision).toBe(11);
    expect(result.targetBeforeHash).toBe(result.targetAfterHash);
  } finally {
    await rm(value.directory, {recursive: true, force: true});
  }
});

it.each(['draft', 'draft-preview'] as const)(
  'stops when a successful %s response cannot identify its exact produced revision',
  async action => {
    const value = await fixture(8, 'propose-update', 'written', 9, true);
    try {
      const result = await runTopicStudyNativeAdapter(value.request, {
        ...value.ports,
        execute: async command => {
          const response = await value.ports.execute(command);
          return command.includes(action) ? {...response, stdout: '{invalid json'} : response;
        },
      });
      expect(topicStudyPreconditionFailedV1(result)).toBe(true);
      expect(result.accepted).toBe(false);
      expect(result.draftAttempted).toBe(true);
      expect(result.draftCompleted).toBe(action === 'draft-preview');
      expect(result.computeMilliseconds).toBe(1);
      expect(result.commandReceiptHashes.length).toBeGreaterThan(0);
      expect(value.commands.some(command => command.includes('draft-reject'))).toBe(false);
      expect(value.getReview().candidates[0].state).toBe('pending');
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  },
);

it.each(['case', 'revision', 'terminal-state', 'audit', 'approval'] as const)(
  'stops on an unverifiable %s cleanup receipt without erasing the failed draft',
  async mismatch => {
    const value = await fixture(8, 'propose-update', 'written', 9, true);
    let generations = 0;
    try {
      const result = await runTopicStudyNativeAdapter(value.request, {
        ...value.ports,
        execute: async command => {
          const response = await value.ports.execute(command);
          if (mismatch === 'case' && command.includes('status') && command.includes('--case-id')) {
            const status = JSON.parse(response.stdout);
            status.cases[0].subjectUri = 'threadnote://other';
            return {...response, stdout: JSON.stringify(status)};
          }
          if (command.includes('draft-reject') && mismatch !== 'case') {
            const review = JSON.parse(response.stdout);
            if (mismatch === 'revision') review.revision++;
            else if (mismatch === 'terminal-state') review.candidates[0].state = 'pending';
            else if (mismatch === 'audit') review.auditEvents[0].candidateId = 'other-candidate';
            else review.maintenanceApproval = {stage: 'preview'};
            return {...response, stdout: JSON.stringify(review)};
          }
          return response;
        },
        generate: async () => {
          generations++;
          return value.ports.generate();
        },
      });
      expect(topicStudyPreconditionFailedV1(result)).toBe(true);
      expect(result.draftCompleted).toBe(true);
      expect(result.computeMilliseconds).toBe(1);
      expect(result.commandReceiptHashes.length).toBeGreaterThan(0);
      expect(result.accepted).toBe(false);
      expect(result.targetBeforeHash).toBe(result.targetAfterHash);
      expect(generations).toBe(0);
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  },
);

it('returns the failed attempt for durable runner capture even when reviewer state cannot be persisted', async () => {
  const value = await fixture(17, 'policy-conflict', 'written', 9);
  try {
    const result = await runTopicStudyNativeAdapter(value.request, {
      ...value.ports,
      execute: async command => {
        const response = await value.ports.execute(command);
        if (command.includes('draft')) {
          const path = join(value.request.home, 'study-state.json');
          await rm(path);
          await mkdir(path);
        }
        return response;
      },
    });
    expect(topicStudyPreconditionFailedV1(result)).toBe(true);
    expect(result.draftAttempted).toBe(true);
    expect(result.draftCompleted).toBe(true);
    expect(result.computeMilliseconds).toBe(1);
    expect(result.commandReceiptHashes.length).toBeGreaterThan(0);
    expect(result.accepted).toBe(false);
    expect(result.targetBeforeHash).toBe(result.targetAfterHash);
    expect(value.getReview().candidates[0].state).toBe('rejected');
    expect(result.reason).toContain('could not be persisted');
  } finally {
    await rm(value.directory, {recursive: true, force: true});
  }
});

it('durably stops after a successful public draft whose command trace cannot be appended', async () => {
  const value = await fixture(24, 'propose-update', 'written', 9);
  const tracePath = join(value.request.home, 'command-trace.jsonl');
  let generations = 0;
  try {
    const ports = {
      ...value.ports,
      execute: async (command: readonly string[]) => {
        const response = await value.ports.execute(command);
        if (command.includes('draft')) {
          await rm(tracePath);
          await mkdir(tracePath);
        }
        return response;
      },
      generate: async () => {
        generations++;
        return value.ports.generate();
      },
    };
    const result = await runTopicStudyNativeAdapter(value.request, ports);
    expect(topicStudyPreconditionFailedV1(result)).toBe(true);
    expect(result.draftAttempted).toBe(true);
    expect(result.accepted).toBe(false);
    expect(result.computeMilliseconds).toBe(1);
    expect(value.commands.at(-1)).toContain('draft');
    expect(generations).toBe(0);
    const evidence = JSON.parse(await readFile(join(value.request.home, 'command-trace-failure.json'), 'utf8'));
    expect(evidence.trace.command).toContain('draft');
    expect(evidence.trace).toMatchObject({exitCode: 0, elapsed: 1});
    expect(JSON.parse(evidence.trace.stdout)).toMatchObject({reviewId: 'review-fixture', revision: 9});
    expect(result.commandReceiptHashes.at(-1)).toBe(evidence.receiptHash);
    const state = JSON.parse(await readFile(join(value.request.home, 'study-state.json'), 'utf8'));
    expect(state.preconditionFailure).toBe(result.reason);
    expect(state.reviewRevision).toBeNull();
    expect(value.getReview().candidates[0].state).toBe('pending');
    const corpus = parseTopicStudyCorpusJsonV1(
      await readFile('apps/threadnote/test/evaluation/fixtures/topic-maintenance-v1/sequence.json', 'utf8'),
    );
    const row = topicStudyLedgerRowV1({
      corpusHash: topicStudyCorpusHashV1(corpus),
      runNonce: 'trace-failure',
      arm: value.request.arm,
      repetition: 1,
      eventIndex: value.request.event.index,
      eventId: value.request.event.id,
      previousHash: null,
      observation: result,
    });
    const ledgerPath = join(value.directory, 'outcomes.jsonl');
    expect(await appendTopicStudySlotV1(ledgerPath, row)).toBe(true);
    expect(await readFile(ledgerPath, 'utf8')).toBe(JSON.stringify(row) + '\n');
    const count = value.commands.length;
    const next = await runTopicStudyNativeAdapter(
      {...value.request, event: {...value.request.event, index: 25}},
      ports,
    );
    expect(topicStudyPreconditionFailedV1(next)).toBe(true);
    expect(value.commands).toHaveLength(count);
    expect(generations).toBe(0);
  } finally {
    await rm(value.directory, {recursive: true, force: true});
  }
});

it.each(['scripted-manual', 'naive-local'] as const)(
  'updates %s from declared bytes when the control detector is unchanged',
  async arm => {
    const value = await comparatorFixture(arm);
    try {
      const result = await runTopicStudyNativeAdapter(value.request, value.ports);
      expect(result.status).toBe('observed');
      expect(result.detected).toBe(false);
      expect(result.actualClass).toBe('review-required');
      const state = JSON.parse(await readFile(join(value.request.home, 'study-state.json'), 'utf8'));
      expect(arm === 'scripted-manual' ? state.manualBody : state.naiveBody).toContain(
        'production fixture timeout is 95 seconds',
      );
      expect(value.commands.some(command => command.includes('packet'))).toBe(false);
      if (arm === 'scripted-manual') {
        expect(result.accepted).toBe(true);
        expect(
          value.commands.some(
            command => command.includes('remember') && command.includes('--require-current-code-refs'),
          ),
        ).toBe(true);
      } else {
        expect(result.draftAttempted).toBe(true);
        const rewrite = value.prompts.find(prompt => prompt.startsWith('Rewrite'))!;
        expect(rewrite).toContain('export const timeoutSeconds = 95;');
        expect(rewrite).toContain('export const preserveUntilReview = true;');
        expect(rewrite).not.toContain('case-fixture');
        expect(rewrite).not.toContain('Current evidence packet');
        const before = value.prompts.filter(prompt => prompt.startsWith('Rewrite')).length;
        const second = await runTopicStudyNativeAdapter(
          {...value.request, event: {...value.request.event, index: 38, indexGraph: false}},
          value.ports,
        );
        expect(second.draftAttempted).toBe(false);
        expect(value.prompts.filter(prompt => prompt.startsWith('Rewrite'))).toHaveLength(before);
      }
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  },
);

it('provides the same common source facts to every arm and the evaluated topic exactly once', async () => {
  const evidences: string[] = [];
  for (const arm of ['scripted-manual', 'naive-local', 'maintained-local', 'maintained-alternate'] as const) {
    const value =
      arm === 'scripted-manual' || arm === 'naive-local'
        ? await comparatorFixture(arm)
        : await fixture(37, 'policy-conflict');
    const prompts: string[] = [];
    try {
      const result = await runTopicStudyNativeAdapter(
        {...value.request, arm},
        {
          ...value.ports,
          generate: async prompt => {
            prompts.push(prompt);
            return value.ports.generate(prompt);
          },
        },
      );
      const answer = prompts.find(prompt => prompt.startsWith('Answer every question'))!;
      expect(answer.match(/\nintro\n/g)).toHaveLength(1);
      expect(answer).not.toContain('threadnote://');
      expect(answer).not.toContain('review-fixture');
      expect(answer).not.toContain('case-fixture');
      expect(answer).not.toContain('random-source-id');
      const evidence = answer.split('(budget 1500 tokens):\n')[1].split('\n\nQuestions:')[0];
      evidences.push(evidence);
      expect(result.retrievalHash).toBe(sha256HexSync(evidence));
      expect(JSON.parse(evidence).refs.map((ref: {path: string}) => ref.path)).toEqual(['health.ts', 'config.ts']);
      const commonCommands = value.commands.filter(command =>
        command.includes(join(value.request.home, 'common-source-home')),
      );
      expect(
        commonCommands.some(
          command => command.includes('brief') && command.includes('--json') && command.includes('1500'),
        ),
      ).toBe(true);
      expect(commonCommands.every(command => command.includes('index') || command.includes('brief'))).toBe(true);
      expect(result.evidenceMilliseconds).toBeGreaterThanOrEqual(1);
      const trace = (await readFile(join(value.request.home, 'command-trace.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      const publicReceipt = trace.find(item => item.command.includes('brief'));
      expect(JSON.parse(publicReceipt.stdout).graph.sources[0].id).toBe('random-source-id');
      const reviewerReceipts =
        arm === 'naive-local'
          ? []
          : (await readFile(join(value.request.home, 'reviewer-expectations.jsonl'), 'utf8')).trim().split('\n');
      expect(result.commandReceiptHashes.length).toBe(trace.length + reviewerReceipts.length);
      expect(result.reviewerExpectation?.before.eligible ?? arm === 'naive-local').toBe(true);
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  }
  expect(new Set(evidences).size).toBe(1);
});

it.each(['scripted-manual', 'naive-local'] as const)(
  'lets %s proceed independently when the control scan is unavailable',
  async arm => {
    const value = await comparatorFixture(arm);
    try {
      const result = await runTopicStudyNativeAdapter(value.request, {
        ...value.ports,
        execute: async command => {
          const response = await value.ports.execute(command);
          if (!command.includes('run')) return response;
          const payload = JSON.parse(response.stdout);
          return {
            ...response,
            stdout: JSON.stringify({
              ...payload,
              state: 'running',
              cases: payload.cases.map((item: object) => ({...item, lastChecked: '2000-01-01T00:00:00Z'})),
            }),
          };
        },
      });
      expect(result.detected).toBeNull();
      expect(result.status).toBe('observed');
      expect(result.reason).toContain('detector unavailable');
      expect(arm === 'scripted-manual' ? result.accepted : result.draftCompleted).toBe(true);
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  },
);

it.each(['dirty', 'missing', 'stale-index', 'over-budget'] as const)(
  'refuses comparator updates with %s declared evidence without cold indexing',
  async unavailable => {
    for (const arm of ['scripted-manual', 'naive-local'] as const) {
      const value = await comparatorFixture(arm);
      try {
        await runTopicStudyNativeAdapter(value.request, value.ports);
        const statePath = join(value.request.home, 'study-state.json');
        const before = JSON.parse(await readFile(statePath, 'utf8'));
        if (unavailable === 'missing') await rm(join(value.repository, 'health.ts'));
        else if (unavailable === 'over-budget') await writeFile(join(value.repository, 'health.ts'), 'x'.repeat(9000));
        else await writeFile(join(value.repository, 'config.ts'), 'export const timeoutSeconds = 110;\n');
        const prior = value.commands.length;
        const result = await runTopicStudyNativeAdapter(
          {
            ...value.request,
            event: {
              ...value.request.event,
              index: 38,
              indexGraph: unavailable === 'missing' || unavailable === 'over-budget',
            },
          },
          {
            ...value.ports,
            execute: async command => {
              const response = await value.ports.execute(command);
              if (unavailable === 'dirty' && command[0] === 'git' && command[1] === 'status')
                return {...response, stdout: ' M config.ts'};
              if (['dirty', 'stale-index'].includes(unavailable) && command.includes('brief')) {
                const brief = JSON.parse(response.stdout);
                brief.scope.freshness = 'stale';
                delete brief.graph.sources;
                return {...response, stdout: JSON.stringify(brief)};
              }
              return response;
            },
          },
        );
        const after = JSON.parse(await readFile(statePath, 'utf8'));
        expect(after.manualBody).toBe(before.manualBody);
        expect(after.naiveBody).toBe(before.naiveBody);
        expect(result.accepted).toBe(false);
        expect(result.draftAttempted).toBe(false);
        expect(result.actualClass).toBe('unavailable');
        expect(result.reason).toContain('abstained');
        const later = value.commands.slice(prior);
        expect(later.some(command => command.includes('remember') || command.includes('packet'))).toBe(false);
        expect(later.filter(command => command.includes('index') && command.includes('--home'))).toHaveLength(
          ['missing', 'over-budget'].includes(unavailable) ? 1 : 0,
        );
      } finally {
        await rm(value.directory, {recursive: true, force: true});
      }
    }
  },
);

it('admits a naive rewrite when the same dirty bytes become clean and explicitly indexed', async () => {
  const value = await comparatorFixture('naive-local');
  try {
    await runTopicStudyNativeAdapter(value.request, value.ports);
    await writeFile(join(value.repository, 'config.ts'), 'export const timeoutSeconds = 100;\n');
    const dirty = await runTopicStudyNativeAdapter(
      {...value.request, event: {...value.request.event, index: 38, indexGraph: false}},
      {
        ...value.ports,
        execute: async command => {
          const response = await value.ports.execute(command);
          return command[0] === 'git' && command[1] === 'status' ? {...response, stdout: ' M config.ts'} : response;
        },
      },
    );
    expect(dirty.draftAttempted).toBe(false);
    const committed = await runTopicStudyNativeAdapter(
      {...value.request, event: {...value.request.event, index: 39, indexGraph: true}},
      {
        ...value.ports,
        generate: async prompt => {
          const generated = await value.ports.generate(prompt);
          return prompt.startsWith('Rewrite')
            ? {...generated, draft: 'The production fixture timeout is 100 seconds.'}
            : generated;
        },
      },
    );
    expect(committed.detected).toBe(false);
    expect(committed.draftCompleted).toBe(true);
    const state = JSON.parse(await readFile(join(value.request.home, 'study-state.json'), 'utf8'));
    expect(state.naiveBody).toBe('The production fixture timeout is 100 seconds.');
  } finally {
    await rm(value.directory, {recursive: true, force: true});
  }
});

it.each(['unsupported', 'failed'] as const)(
  'retains %s comparator slots and probe denominators under the new evidence boundary',
  async kind => {
    const value = await comparatorFixture('naive-local');
    try {
      const corpus = parseTopicStudyCorpusJsonV1(
        await readFile('apps/threadnote/test/evaluation/fixtures/topic-maintenance-v1/sequence.json', 'utf8'),
      );
      const event = kind === 'unsupported' ? corpus.events[12] : value.request.event;
      const result = await runTopicStudyNativeAdapter(
        {...value.request, event},
        {
          ...value.ports,
          generate: async prompt =>
            prompt.startsWith('Rewrite') && kind === 'failed' ? null : value.ports.generate(prompt),
        },
      );
      expect(result.status).toBe(kind === 'unsupported' ? 'unavailable' : 'failed');
      const row = topicStudyLedgerRowV1({
        corpusHash: topicStudyCorpusHashV1(corpus),
        runNonce: 'method-denominators',
        arm: 'naive-local',
        repetition: 1,
        eventIndex: event.index,
        eventId: event.id,
        previousHash: null,
        observation: result,
      });
      const summary = summarizeTopicStudyV1(
        [row],
        corpus,
        {
          realTopicPilotObserved: false,
          alternatePermittedAndMeasured: false,
          pairedHumanMedianReduction: null,
          totalCostMeasured: false,
          disagreementsAdjudicated: false,
          downstreamNoRegression: null,
        },
        1,
      );
      expect(summary.denominators.recordedEvents).toBe(1);
      expect(summary.denominators.plannedEvents).toBe(200);
      expect(summary.denominators.recordedSlotProbePlanned).toBe(7);
      expect(summary.denominators.unsupportedFaultEvents).toBe(kind === 'unsupported' ? 1 : 0);
      expect(summary.denominators.probePlanned).toBe(kind === 'unsupported' ? 0 : 7);
      expect(summary.denominators.failedEvents).toBe(kind === 'failed' ? 1 : 0);
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  },
);

it.each(['decision', 'handoff', 'anchor', 'warning', 'candidate'] as const)(
  'rejects accidental %s memory contamination before source projection',
  contamination => {
    const brief = publicSourceBrief([{path: 'config.ts', content: 'export const timeoutSeconds = 60;'}]);
    const input = JSON.parse(JSON.stringify(brief));
    if (contamination === 'decision') input.durableDecisions = [{uri: 'threadnote://control'}];
    else if (contamination === 'handoff') input.activeHandoffs = [{uri: 'threadnote://control'}];
    else if (contamination === 'anchor') input.coverage.memory.codeAnchors.matchedMemories = 1;
    else if (contamination === 'warning')
      input.stalenessAndConflicts = [{kind: 'topic-support', message: 'Control has pending review'}];
    else input.coverage.memory.consideredCandidates = 1;
    expect(() =>
      projectTopicStudySourceBriefV1(input, {hash: 'unneeded', clean: true, indexFresh: true, files: []}),
    ).toThrow('precondition failure');
  },
);

it('keeps public omissions and omitted-source DTOs explicit without inventing source facts', () => {
  const declared = {
    hash: 'unneeded',
    clean: true,
    indexFresh: true,
    files: [
      {path: 'health.ts', availability: 'present', content: 'PRIVATE-RAW-HEALTH'},
      {path: 'config.ts', availability: 'present', content: 'PRIVATE-RAW-CONFIG'},
    ],
  };
  const brief = publicSourceBrief([{path: 'health.ts', content: 'export const title = "Context Health";'}]);
  brief.coverage.omissions.sourceExcerpts = 1;
  const result = JSON.parse(projectTopicStudySourceBriefV1(brief, declared));
  expect(result.refs[1]).toMatchObject({path: 'config.ts', selection: 'not-returned-by-public-brief', sources: []});
  expect(result.publicSourceOmissions).toBe(1);
  expect(JSON.stringify(result)).not.toContain('PRIVATE-RAW');
  const stale = JSON.parse(JSON.stringify(brief));
  delete stale.graph.sources;
  stale.scope.freshness = 'stale';
  expect(
    JSON.parse(projectTopicStudySourceBriefV1(stale, declared)).refs.every(
      (ref: {sources: unknown[]}) => ref.sources.length === 0,
    ),
  ).toBe(true);
});

it('projects equivalent source facts independently of private identifiers within a fixed byte budget', () => {
  fc.assert(
    fc.property(
      fc.integer({min: 1, max: 200}),
      fc.string({maxLength: 40}),
      fc.integer({min: 0, max: 10000}),
      (seconds, id, size) => {
        const brief = publicSourceBrief([
          {path: 'health.ts', content: `export const title = "Context Health";\n${'x'.repeat(size)}`},
          {path: 'config.ts', content: `export const timeoutSeconds = ${seconds};`},
        ]);
        const changed = JSON.parse(JSON.stringify(brief));
        changed.graph.sources.forEach((source: {id: string; repositoryKey: string; coveredGraphRefs: string[]}) => {
          source.id = id;
          source.repositoryKey = `threadnote://repo/${id}`;
          source.coveredGraphRefs = [id];
        });
        const declared = {
          hash: id,
          clean: true,
          indexFresh: true,
          files: ['health.ts', 'config.ts'].map(path => ({path, availability: 'present', content: null})),
        };
        const projected = projectTopicStudySourceBriefV1(brief, declared);
        expect(projectTopicStudySourceBriefV1(changed, declared)).toBe(projected);
        expect(new TextEncoder().encode(projected).byteLength).toBeLessThanOrEqual(6000);
        const refs = JSON.parse(projected).refs;
        expect(refs.map((ref: {path: string}) => ref.path)).toEqual(['health.ts', 'config.ts']);
        expect(
          refs.every(
            (ref: {sources: unknown[]; selection: string}) => ref.sources.length || ref.selection.includes('omitted'),
          ),
        ).toBe(true);
      },
    ),
    {numRuns: 20},
  );
});

it.each([18, 28])(
  'accepts exact actual-state production and heading catch-up independently of ideal allowances (event %s)',
  async index => {
    const value = await fixture(index, 'propose-update', 'preview-write', 9, false, [
      'intro',
      'policy',
      'history',
      'The production fixture timeout is 95 seconds.',
      'The display heading is Context Health v2.',
    ]);
    try {
      await writeFile(
        join(value.repository, 'health.ts'),
        'export const title = "Context Health v2";\nexport const preserveUntilReview = true;\n',
      );
      const result = await runTopicStudyNativeAdapter(
        {...value.request, event: {...value.request.event, allowedEditOrdinals: []}},
        value.ports,
      );
      expect(result.status).toBe('observed');
      expect(result.accepted).toBe(true);
      expect(result.unrelatedBodyPreserved).toBe(true);
      expect(result.provenancePreserved).toBe(true);
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  },
);

it('rejects a production-only catch-up for residual heading debt and closes its exact public review', async () => {
  const value = await fixture(18, 'propose-update', 'preview-write', 9);
  try {
    await writeFile(
      join(value.repository, 'health.ts'),
      'export const title = "Context Health v2";\nexport const preserveUntilReview = true;\n',
    );
    const result = await runTopicStudyNativeAdapter(value.request, value.ports);
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('Unresolved registered literal claims: 4');
    expect(result.accepted).toBe(false);
    expect(value.getReview().candidates[0].state).toBe('rejected');
    expect(result.targetBeforeHash).toBe(result.targetAfterHash);
  } finally {
    await rm(value.directory, {recursive: true, force: true});
  }
});

it('manual repairs existing direct claims without acquiring newly available staging claims', async () => {
  const value = await comparatorFixture('scripted-manual');
  try {
    await writeFile(
      join(value.repository, 'config.ts'),
      'export const timeoutSeconds = 95;\nexport const stagingTimeoutSeconds = 50;\n',
    );
    await writeFile(join(value.repository, 'health.ts'), 'export const title = "Context Health v2";\n');
    const result = await runTopicStudyNativeAdapter(
      {...value.request, event: {...value.request.event, allowedEditOrdinals: []}},
      value.ports,
    );
    expect(result.accepted).toBe(true);
    expect(result.reviewerExpectation?.before.repairOrdinals).toEqual([3, 4]);
    expect(result.reviewerExpectation?.after?.repairOrdinals).toEqual([]);
    expect(value.manual()).toContain('The display heading is Context Health v2.');
    expect(value.manual()).not.toContain('The staging fixture timeout');
    const receipt = (await readFile(join(value.request.home, 'reviewer-expectations.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(receipt.map(item => item.phase)).toEqual(['before', 'manual-preview', 'manual-readback', 'after']);
    expect(receipt[0].expectation.beforeHash).toBe(result.targetBeforeHash);
  } finally {
    await rm(value.directory, {recursive: true, force: true});
  }
});

it.each(['none', 'manual-readback', 'after'] as const)(
  'retains known physical manual provenance loss across a %s receipt failure',
  async failedPhase => {
    const value = await comparatorFixture('scripted-manual');
    let written = false;
    let postWriteReads = 0;
    let generations = 0;
    try {
      const ports = {
        ...value.ports,
        execute: async (command: readonly string[]) => {
          const response = await value.ports.execute(command);
          if (command[1] === 'remember') written = true;
          if (command[1] !== 'read' || command[2] !== 'threadnote://manual') return response;
          if (
            written &&
            ++postWriteReads === (failedPhase === 'manual-readback' ? 1 : failedPhase === 'after' ? 2 : -1)
          ) {
            const receiptPath = join(value.request.home, 'reviewer-expectations.jsonl');
            await rm(receiptPath);
            await mkdir(receiptPath);
          }
          return {
            ...response,
            stdout: response.stdout.replace(
              'project: fixture',
              `project: fixture\nsource_commit: ${written ? 'b' : 'a'}`,
            ),
          };
        },
        generate: async (prompt: string) => {
          generations++;
          return value.ports.generate(prompt);
        },
      };
      const result = await runTopicStudyNativeAdapter(value.request, ports);
      expect(result.status).toBe('failed');
      expect(result.accepted).toBe(true);
      expect(result.approved).toBe(true);
      expect(result.provenancePreserved).toBe(false);
      expect(result.identityPreserved).toBe(true);
      expect(result.unrelatedBodyPreserved).toBe(true);
      expect(result.targetBeforeHash).not.toBe(result.targetAfterHash);
      const actualAfter = value.manual().replace('project: fixture', 'project: fixture\nsource_commit: b');
      expect(result.targetAfterHash).toBe(sha256HexSync(actualAfter));
      expect(value.manual()).toContain('The production fixture timeout is 95 seconds.');
      if (failedPhase === 'none') {
        expect(result.reviewerExpectation?.after?.repairOrdinals).toEqual([]);
        return;
      }
      expect(topicStudyPreconditionFailedV1(result)).toBe(true);
      const state = JSON.parse(await readFile(join(value.request.home, 'study-state.json'), 'utf8'));
      expect(state.preconditionFailure).toBe(result.reason);
      const corpus = parseTopicStudyCorpusJsonV1(
        await readFile('apps/threadnote/test/evaluation/fixtures/topic-maintenance-v1/sequence.json', 'utf8'),
      );
      const row = topicStudyLedgerRowV1({
        corpusHash: topicStudyCorpusHashV1(corpus),
        runNonce: 'reviewer-receipt-failure',
        arm: value.request.arm,
        repetition: 1,
        eventIndex: value.request.event.index,
        eventId: value.request.event.id,
        previousHash: null,
        observation: result,
      });
      const ledgerPath = join(value.directory, 'outcomes.jsonl');
      expect(await appendTopicStudySlotV1(ledgerPath, row)).toBe(true);
      expect(await readFile(ledgerPath, 'utf8')).toBe(JSON.stringify(row) + '\n');
      const summary = summarizeTopicStudyV1(
        [row],
        corpus,
        {
          realTopicPilotObserved: false,
          alternatePermittedAndMeasured: false,
          pairedHumanMedianReduction: null,
          totalCostMeasured: false,
          disagreementsAdjudicated: false,
          downstreamNoRegression: null,
        },
        1,
      );
      expect(summary.comparatorHardFailureCount).toBe(1);
      expect(summary.hardFailureCount).toBe(0);
      const commands = value.commands.length;
      const next = await runTopicStudyNativeAdapter(
        {...value.request, event: {...value.request.event, index: 38}},
        ports,
      );
      expect(topicStudyPreconditionFailedV1(next)).toBe(true);
      expect(value.commands).toHaveLength(commands);
      expect(generations).toBe(0);
    } finally {
      await rm(value.directory, {recursive: true, force: true});
    }
  },
);

it('resumed review uses the same complete current-claim oracle and rejects residual debt', async () => {
  const value = await fixture(28, 'propose-update', 'preview-write', 9, false, [
    'intro',
    'policy',
    'history',
    'The production fixture timeout is 95 seconds.',
    'The display heading is Context Health v2.',
  ]);
  let previews = 0;
  try {
    await writeFile(join(value.repository, 'health.ts'), 'export const title = "Context Health v2";\n');
    const result = await runTopicStudyNativeAdapter(
      {...value.request, event: {...value.request.event, allowedEditOrdinals: []}},
      {
        ...value.ports,
        execute: async command => {
          const response = await value.ports.execute(command);
          if (!command.includes('draft-preview') || ++previews !== 2) return response;
          const preview = JSON.parse(response.stdout);
          const content: string = preview.maintenanceApproval.preview.content;
          const body = topicStudyBodyV1(content).replace('Context Health v2.', 'Context Health.');
          preview.maintenanceApproval.preview.content =
            content
              .slice(0, content.indexOf('\n\n') + 2)
              .replace(/^topic_maintenance: (.+)$/mu, (_line: string, json: string) => {
                const manifest = JSON.parse(json);
                manifest.bodyHash = sha256HexSync(body);
                manifest.paragraphs[4].hash = sha256HexSync(body.split('\n\n')[4]);
                return `topic_maintenance: ${JSON.stringify(manifest)}`;
              }) + body;
          return {...response, stdout: JSON.stringify(preview)};
        },
      },
    );
    expect(previews).toBe(2);
    expect(result.status).toBe('failed');
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('Unresolved registered literal claims: 4');
    expect(value.getReview().candidates[0].state).toBe('rejected');
    expect(value.getReview().revision).toBe(14);
    expect(result.targetBeforeHash).toBe(result.targetAfterHash);
  } finally {
    await rm(value.directory, {recursive: true, force: true});
  }
});
