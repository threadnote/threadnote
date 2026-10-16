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
} from '@threadnote/threadnote/evaluation/topic-maintenance-longitudinal';
import {runTopicStudyNativeAdapter} from '../../../../scripts/topic-maintenance-longitudinal-native-adapter.js';
import {appendTopicStudySlotV1} from '../../../../scripts/run-topic-maintenance-longitudinal.js';

async function fixture(
  index: number,
  outcome: string,
  applyResponse: 'written' | 'preview-write' | 'altered-write' | 'unrelated-error' | 'source-conflict' = 'written',
  startingRevision = 1,
  badProtectedPreview = false,
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
  const nextBody = body.map((text, ordinal) =>
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
      if (command[0] === 'git') stdout = 'a'.repeat(40);
      else if (command[1] === 'read') stdout = currentAccepted;
      else if (command.includes('brief'))
        stdout = 'THREADNOTE BRIEF\nState: fresh\nCoverage: declared-only\nconfig.ts: current timeout 95 seconds';
      else if (command.includes('draft')) {
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

it('publicly rejects the exact prepared revision after a bad preview and admits the next material source change', async () => {
  const value = await fixture(8, 'propose-update', 'written', 9, true);
  try {
    const first = await runTopicStudyNativeAdapter(value.request, value.ports);
    expect(first.status).toBe('failed');
    expect(first.reason).toBe('Independent protected-content/current-value check rejected draft.');
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
          if (mismatch === 'case' && command.includes('status')) {
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
