import assert from 'node:assert/strict';
import {Array as EffectArray} from 'effect';
import {
  buildCandidateReview,
  readActiveProjectMemories,
  saveCandidateReview,
  type SessionCloseoutInput,
} from '@threadnote/memory/candidate';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {isJsonObject} from '@threadnote/platform/json';
import {runEffect as run} from '../helpers/effect-runtime.js';
import {afterEach, describe, expect, it} from 'vitest';
import {promisify} from 'node:util';

const execFilePromise = promisify(execFile);
const homes: string[] = [];

const detailedHandoffBody = EffectArray.join(
  [
    '## Current state',
    '- Release branch and exact head are recorded for the next agent.',
    '- Runtime ownership and active branch coordination are recorded here.',
    '- Pull request status still needs a fresh remote check.',
    '',
    '## Verification evidence',
    '- Focused tests, typecheck, lint, and exact-head smoke passed.',
    '- The retained safety artifact and recovery path are documented.',
    '',
    '## Ordered next steps',
    '- Refresh remote checks before merging.',
    '- Transfer runtime ownership before the next install.',
    '- Run final admission only after every slice is complete.',
  ],
  '\n',
);

const input: SessionCloseoutInput = {
  decisions: ['Keep closeout decisions explicit.'],
  evidence: ['apps/threadnote/test/integration/closeout-cli.test.ts'],
  outcome: 'Added closeout CLI coverage.',
  project: 'threadnote',
  sourceAgentClient: 'test',
  sourceSessionId: 'closeout-cli-test',
  task: 'Exercise candidate closeout commands',
  topic: 'closeout-cli',
};

afterEach(async () => {
  await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
});

describe('closeout CLI', () => {
  it('previews the bounded KnowledgeDeltaV1 without mutating its review', async () => {
    const {home, review, reviewId, reviewPath} = await storedReview();
    const before = await readFile(reviewPath, 'utf8');

    const result = await runCli(['closeout', 'preview', '--review-id', reviewId, '--json'], home);
    const human = await runCli(['closeout', 'preview', '--review-id', reviewId], home);

    expect(JSON.parse(result.stdout)).toMatchObject({reviewId, revision: 1, type: 'knowledge-delta', version: 1});
    expect(human.stdout).toContain(`Knowledge delta for ${reviewId} (revision 1)`);
    const edited = await runCli(
      [
        'closeout',
        'preview',
        '--review-id',
        reviewId,
        '--candidate-id',
        review.candidates[0]?.candidateId ?? '',
        '--revision',
        '1',
        '--edited-text',
        '## Decisions\n- Preview the reviewed edit.',
        '--json',
      ],
      home,
    );
    expect(JSON.parse(edited.stdout).items[0].mutationPreview.bodyText).toContain('reviewed edit');
    expect(await readFile(reviewPath, 'utf8')).toBe(before);
  });

  it('rejects stale revisions and approval without explicit confirmation', async () => {
    const {home, review, reviewId} = await storedReview();
    const candidateId = review.candidates[0]?.candidateId ?? '';

    const missingApproval = await runCli(
      [
        'closeout',
        'apply',
        '--action',
        'approve',
        '--review-id',
        reviewId,
        '--candidate-id',
        candidateId,
        '--revision',
        '1',
      ],
      home,
    ).catch(cliFailure);
    expect(missingApproval).toMatchObject({code: 1});
    expect(missingApproval.stderr).toContain('approve requires approved=true');

    const staleRevision = await runCli(
      [
        'closeout',
        'apply',
        '--action',
        'defer',
        '--review-id',
        reviewId,
        '--candidate-id',
        candidateId,
        '--revision',
        '2',
      ],
      home,
    ).catch(cliFailure);
    expect(staleRevision).toMatchObject({code: 1});
    expect(staleRevision.stderr).toContain('Candidate review revision changed: expected 2, current 1');

    const deferred = await runCli(
      [
        'closeout',
        'apply',
        '--action',
        'defer',
        '--review-id',
        reviewId,
        '--candidate-id',
        candidateId,
        '--revision',
        '1',
      ],
      home,
    );
    expect(deferred.stdout).toContain(`Deferred candidate ${candidateId}`);
  });

  it('persists and projects the exact approved edit', async () => {
    const {home, review, reviewId} = await storedReview();
    const candidateId = review.candidates[0]?.candidateId ?? '';
    const editedText = '## Decisions\n- Persist this exact reviewed edit.';

    const applied = await runCli(
      [
        'closeout',
        'apply',
        '--action',
        'approve',
        '--approved',
        '--review-id',
        reviewId,
        '--candidate-id',
        candidateId,
        '--revision',
        '1',
        '--edited-text',
        editedText,
      ],
      home,
    );
    expect(applied.stdout).toContain('Stored memory:');

    const preview = await runCli(['closeout', 'preview', '--review-id', reviewId, '--json'], home);
    expect(JSON.parse(preview.stdout).items[0]).toMatchObject({
      candidateId,
      mutationPreview: {bodyText: editedText},
      state: 'applied',
    });
    const stored = await readFile(
      join(home, 'data', 'local', 'user', 'local', 'memories', 'durable', 'projects', 'threadnote', 'closeout-cli.md'),
      'utf8',
    );
    expect(stored).toContain(editedText);
    expect(stored).not.toContain('Keep closeout decisions explicit.');
  });

  it('fails closed when approval would erase most of a detailed handoff', async () => {
    const {candidateId, home, proposedText, reviewId, targetPath, targetUri} =
      await storedReplacementReview('destructive-handoff');
    const before = await readFile(targetPath, 'utf8');

    const preview = await runCli(['closeout', 'preview', '--review-id', reviewId, '--json'], home);
    expect(JSON.parse(preview.stdout).items[0].mutationPreview.replacementSafety).toMatchObject({
      classification: 'destructive-loss-risk',
      requiresExplicitApproval: true,
    });
    const human = await runCli(['closeout', 'preview', '--review-id', reviewId], home);
    expect(human.stdout).toContain('WARNING: Destructive replacement risk');

    const blocked = await runCli(
      [
        'closeout',
        'apply',
        '--action',
        'approve',
        '--approved',
        '--review-id',
        reviewId,
        '--candidate-id',
        candidateId,
        '--revision',
        '1',
        '--operation',
        'replace',
        '--replace-uri',
        targetUri,
      ],
      home,
    ).catch(cliFailure);
    expect(blocked).toMatchObject({code: 1});
    expect(blocked.stderr).toContain('allowDestructiveReplacement=true');
    expect(await readFile(targetPath, 'utf8')).toBe(before);

    const applied = await runCli(
      [
        'closeout',
        'apply',
        '--action',
        'approve',
        '--approved',
        '--allow-destructive-replacement',
        '--review-id',
        reviewId,
        '--candidate-id',
        candidateId,
        '--revision',
        '1',
        '--operation',
        'replace',
        '--replace-uri',
        targetUri,
      ],
      home,
    );
    expect(applied.stdout).toContain('Stored memory:');
    expect(await readFile(targetPath, 'utf8')).toContain(proposedText);

    const appliedPreview = await runCli(['closeout', 'preview', '--review-id', reviewId, '--json'], home);
    expect(JSON.parse(appliedPreview.stdout).items[0].mutationPreview.replacementSafety).toMatchObject({
      acknowledged: true,
      requiresExplicitApproval: false,
    });
  });

  it('requires a fresh review before applying a legacy replacement without a safety baseline', async () => {
    const {candidateId, home, reviewId, reviewPath, targetPath, targetUri} =
      await storedReplacementReview('legacy-replacement-safety');
    const before = await readFile(targetPath, 'utf8');
    const persisted: unknown = JSON.parse(await readFile(reviewPath, 'utf8'));
    assert(isJsonObject(persisted));
    assert(EffectArray.isArray(persisted.candidates));
    assert(isJsonObject(persisted.candidates[0]));
    delete persisted.candidates[0].replacementSafetyBaseline;
    await writeFile(reviewPath, `${JSON.stringify(persisted, undefined, 2)}\n`, 'utf8');

    const preview = await runCli(['closeout', 'preview', '--review-id', reviewId, '--json'], home);
    expect(JSON.parse(preview.stdout).items[0].mutationPreview.replacementSafety).toMatchObject({
      classification: 'review-required',
      requiresExplicitApproval: true,
      warning: expect.stringContaining('Run review_session_context again'),
    });

    const blocked = await runCli(
      [
        'closeout',
        'apply',
        '--action',
        'approve',
        '--approved',
        '--allow-destructive-replacement',
        '--review-id',
        reviewId,
        '--candidate-id',
        candidateId,
        '--revision',
        '1',
        '--operation',
        'replace',
        '--replace-uri',
        targetUri,
      ],
      home,
    ).catch(cliFailure);
    expect(blocked).toMatchObject({code: 1});
    expect(blocked.stderr).toContain('Run review_session_context again');
    expect(await readFile(targetPath, 'utf8')).toBe(before);
  });

  it('allows an edited replacement that preserves the detailed handoff', async () => {
    const {candidateId, home, reviewId, targetPath, targetUri} = await storedReplacementReview('preserving-handoff');
    const editedText = `${detailedHandoffBody}\n- Continue coordinated release work after checks finish.`;

    const preview = await runCli(
      [
        'closeout',
        'preview',
        '--review-id',
        reviewId,
        '--candidate-id',
        candidateId,
        '--revision',
        '1',
        '--edited-text',
        editedText,
        '--json',
      ],
      home,
    );
    expect(JSON.parse(preview.stdout).items[0].mutationPreview.replacementSafety).toMatchObject({
      classification: 'preserving',
      requiresExplicitApproval: false,
    });

    const applied = await runCli(
      [
        'closeout',
        'apply',
        '--action',
        'approve',
        '--approved',
        '--review-id',
        reviewId,
        '--candidate-id',
        candidateId,
        '--revision',
        '1',
        '--edited-text',
        editedText,
        '--operation',
        'replace',
        '--replace-uri',
        targetUri,
      ],
      home,
    );
    expect(applied.stdout).toContain('Stored memory:');
    expect(await readFile(targetPath, 'utf8')).toContain(editedText);
  });
});

interface CliFailure extends Error {
  readonly code?: number;
  readonly stderr: string;
}

function isCliFailure(error: unknown): error is CliFailure {
  return (
    error instanceof Error &&
    'stderr' in error &&
    typeof error.stderr === 'string' &&
    (!('code' in error) || typeof error.code === 'number')
  );
}

function cliFailure(error: unknown): CliFailure {
  assert(isCliFailure(error), 'Expected a failed CLI result.');
  return error;
}

async function storedReview() {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-closeout-cli-'));
  homes.push(home);
  const review = await run(buildCandidateReview(input, [], new Date('2026-09-17T10:00:00.000Z')));
  await run(saveCandidateReview(home, review));
  return {
    home,
    review,
    reviewId: review.reviewId,
    reviewPath: join(home, 'threadnote', 'candidates', 'v1', 'reviews', `${review.reviewId}.json`),
  };
}

async function storedReplacementReview(topic: string) {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-closeout-replacement-'));
  homes.push(home);
  const targetPath = join(
    home,
    'data',
    'local',
    'user',
    'local',
    'memories',
    'handoffs',
    'active',
    'threadnote',
    `${topic}.md`,
  );
  const targetUri = `threadnote://user/local/memories/handoffs/active/threadnote/${topic}.md`;
  await mkdir(join(targetPath, '..'), {recursive: true});
  await writeFile(
    targetPath,
    EffectArray.join(
      [
        'HANDOFF',
        'kind: handoff',
        'status: active',
        'project: threadnote',
        `topic: ${topic}`,
        'source_agent_client: test',
        'timestamp: 2026-09-17T09:00:00.000Z',
        '',
        detailedHandoffBody,
      ],
      '\n',
    ),
    'utf8',
  );
  const proposedText = '## Handoff state\n- Continue coordinated release work after checks finish.';
  const replacementInput: SessionCloseoutInput = {
    evidence: ['apps/threadnote/test/integration/closeout-cli.test.ts'],
    handoff: ['Continue coordinated release work after checks finish.'],
    outcome: 'Prepared the next release coordination step.',
    project: 'threadnote',
    sourceAgentClient: 'test',
    sourceSessionId: `closeout-cli-${topic}`,
    task: 'Update release coordination handoff',
    topic,
  };
  const config = {account: 'local', agentContextHome: home, user: 'local'} as const;
  const existing = await run(readActiveProjectMemories(config, 'threadnote'));
  const review = await run(buildCandidateReview(replacementInput, existing, new Date('2026-09-17T10:00:00.000Z')));
  await run(saveCandidateReview(home, review));
  return {
    candidateId: review.candidates[0]?.candidateId ?? '',
    home,
    proposedText,
    reviewId: review.reviewId,
    reviewPath: join(home, 'threadnote', 'candidates', 'v1', 'reviews', `${review.reviewId}.json`),
    targetPath,
    targetUri,
  };
}

function runCli(args: readonly string[], home: string) {
  return execFilePromise(
    process.execPath,
    [join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'), ...args],
    {
      env: {...process.env, NO_COLOR: '1', THREADNOTE_HOME: home, THREADNOTE_USER: 'local'},
    },
  );
}
