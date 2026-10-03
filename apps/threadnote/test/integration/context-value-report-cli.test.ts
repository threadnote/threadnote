import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {formatMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import {buildCandidateReview, saveCandidateReview, type SessionCloseoutInput} from '@threadnote/memory/candidate';
import {runEffect as run} from '../helpers/effect-runtime.js';
import {afterEach, describe, expect, it} from 'vitest';
import {promisify} from 'node:util';

const execFilePromise = promisify(execFile);
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
});

describe('context health and value report CLI', () => {
  it('shows handler-bearing parent subcommands as optional without relaxing grouping commands', async () => {
    const home = await makeHome();

    const [healthHelp, repairPreviewHelp, repairApplyHelp, reportHelp, contextHelp] = await Promise.all([
      runCli(['context', 'health', '--help'], home),
      runCli(['context', 'repair', 'preview', '--help'], home),
      runCli(['context', 'repair', 'apply', '--help'], home),
      runCli(['value', 'report', '--help'], home),
      runCli(['context', '--help'], home),
    ]);

    expect(healthHelp.stdout).toContain('threadnote context health [<subcommand>] [flags]');
    expect(healthHelp.stdout).toContain('--finding-category');
    expect(healthHelp.stdout).toContain('--kind');
    expect(repairPreviewHelp.stdout).toContain('--finding-category');
    expect(repairPreviewHelp.stdout).toContain('--topic');
    expect(repairApplyHelp.stdout).toContain('--after');
    expect(repairApplyHelp.stdout).toContain('--finding-category');
    expect(reportHelp.stdout).toContain('threadnote value report [<subcommand>] [flags]');
    expect(contextHelp.stdout).toContain('threadnote context <subcommand> [flags]');
  });

  it('returns a bounded empty health report as JSON without creating local state', async () => {
    const home = await makeHome();

    const result = await runCli(['context', 'health', '--project', 'project-a', '--json'], home);

    expect(JSON.parse(result.stdout)).toEqual({
      findings: [],
      limit: 100,
      omittedFindings: 0,
      maintenance: {
        version: 2,
        actionableFindings: 0,
        affectedMemories: 0,
        automaticallyManagedFindings: 0,
        historicalFindings: 0,
        citationCoverage: {
          eligible: 0,
          checked: 0,
          deferred: 0,
          currentVerified: 0,
          historicalVerified: 0,
          unverified: 0,
          state: 'complete',
          reasons: [],
        },
        semanticCoverage: {
          analyzedRecords: 0,
          claimsAnalyzed: 0,
          contradictionCount: 0,
          eligibleRecords: 0,
          omittedContradictions: 0,
          pairsCompared: 0,
          state: 'complete',
          unknownReasons: [],
          unknownRecords: 0,
          version: 1,
        },
      },
      project: 'project-a',
      recordsScanned: 0,
      semanticCompleteness: {
        analyzedRecords: 0,
        claimsAnalyzed: 0,
        contradictionCount: 0,
        eligibleRecords: 0,
        omittedContradictions: 0,
        pairsCompared: 0,
        state: 'complete',
        unknownReasons: [],
        unknownRecords: 0,
        version: 1,
      },
      status: 'clean',
      version: 1,
    });
    await expect(readFile(join(home, 'data'), 'utf8')).rejects.toThrow();
  });

  it('exposes aggregate and provider-neutral schedule subcommands without installing or syncing', async () => {
    const home = await makeHome();

    const aggregate = JSON.parse(
      (await runCli(['context', 'health', 'aggregate', '--project', 'project-a', '--json'], home)).stdout,
    );
    expect(aggregate).toMatchObject({
      completeSources: 1,
      exitCode: 0,
      sources: [expect.objectContaining({sourceKey: 'personal', state: 'complete'})],
      status: 'clean',
      unknownSources: 0,
    });

    const schedule = JSON.parse(
      (
        await runCli(
          ['context', 'health', 'schedule', '--project', 'project-a', '--cadence-minutes', '60', '--json'],
          home,
        )
      ).stdout,
    );
    expect(schedule).toMatchObject({
      argv: ['context', 'health', 'aggregate', '--project', 'project-a', '--json'],
      cadenceMinutes: 60,
      execution: {network: 'disabled', readOnly: true},
      teams: [],
    });
    await expect(readFile(join(home, 'share'), 'utf8')).rejects.toThrow();
  });

  it('reads only the requested project records and does not rewrite them', async () => {
    const home = await makeHome();
    const projectAPath = await storedMemory(home, 'project-a', 'expired.md', {validTo: '2026-09-16T00:00:00.000Z'});
    await storedMemory(home, 'project-b', 'other.md');
    const before = await readFile(projectAPath, 'utf8');

    const result = await runCli(['context', 'health', '--project', 'project-a', '--json'], home);
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly {readonly category: string}[];
      readonly recordsScanned: number;
    };

    expect(report).toMatchObject({recordsScanned: 1});
    expect(report.findings).toEqual([expect.objectContaining({category: 'validity-expired'})]);
    expect(await readFile(projectAPath, 'utf8')).toBe(before);
  });

  it('narrows health and repair preview with the same read-only selector without corrupting the project snapshot', async () => {
    const home = await makeHome();
    await storedMemory(home, 'project-a', 'durable-expired.md', {
      topic: 'durable-maintenance',
      validTo: '2026-09-16T00:00:00.000Z',
    });
    await storedMemoryAt(home, 'handoffs/active/project-a/handoff-expired.md', 'project-a', 'handoff', {
      topic: 'handoff-maintenance',
      validTo: '2026-09-16T00:00:00.000Z',
    });

    await runCli(['context', 'health', '--project', 'project-a', '--json'], home);
    const eventPath = join(home, 'value', 'value-events-v1.jsonl');
    const beforeSelector = await readFile(eventPath, 'utf8');
    const selected = JSON.parse(
      (await runCli(['context', 'health', '--project', 'project-a', '--kind', 'durable', '--json'], home)).stdout,
    );
    const preview = JSON.parse(
      (await runCli(['context', 'repair', 'preview', '--project', 'project-a', '--kind', 'durable', '--json'], home))
        .stdout,
    );

    expect(selected).toMatchObject({
      findings: [expect.objectContaining({category: 'validity-expired'})],
      recordsScanned: 1,
    });
    expect(preview.proposals).toHaveLength(1);
    expect(preview.proposals[0].mutation.subjectUri).toContain('durable-expired.md');
    expect(await readFile(eventPath, 'utf8')).toBe(beforeSelector);
    const human = await runCli(['context', 'health', '--project', 'project-a', '--topic', 'handoff-maintenance'], home);
    expect(human.stdout).toContain('Active selector: topic=handoff-maintenance.');
    const intersection = JSON.parse(
      (
        await runCli(
          [
            'context',
            'health',
            '--project',
            'project-a',
            '--kind',
            'durable',
            '--finding-category',
            'validity-expired',
            '--json',
          ],
          home,
        )
      ).stdout,
    );
    expect(intersection).toMatchObject({
      findings: [expect.objectContaining({category: 'validity-expired'})],
      recordsScanned: 1,
    });
  });

  it('continues an exact scope and applies only the selector-and-cursor-bound proposal', async () => {
    const home = await makeHome();
    const paths = await Promise.all(
      Array.from({length: 125}, (_, index) =>
        storedMemory(home, 'project-a', `overflow-${index.toString().padStart(3, '0')}.md`, {
          topic: 'overflow-topic',
          validTo: '2026-09-16T00:00:00.000Z',
        }),
      ),
    );
    const bytesBeforePreview = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    const selector = [
      '--finding-category',
      'validity-expired',
      '--kind',
      'durable',
      '--topic',
      'overflow-topic',
    ] as const;
    const first = JSON.parse(
      (await runCli(['context', 'repair', 'preview', '--project', 'project-a', ...selector, '--json'], home)).stdout,
    );
    expect(first).toMatchObject({
      nextCursor: expect.stringMatching(/^hcx1_[0-9a-z]+_[0-9a-f]{40}$/u),
      proposals: expect.arrayContaining([expect.objectContaining({selector: expect.any(Object)})]),
      sourceOmittedFindings: 25,
    });
    expect(first.proposals).toHaveLength(100);
    const second = JSON.parse(
      (
        await runCli(
          [
            'context',
            'repair',
            'preview',
            '--project',
            'project-a',
            ...selector,
            '--after',
            first.nextCursor,
            '--json',
          ],
          home,
        )
      ).stdout,
    );
    expect(second.proposals).toHaveLength(25);
    expect(second.nextCursor).toBeUndefined();
    expect(second.sourceOmittedFindings).toBe(100);
    expect(second.remainingFindings).toBeUndefined();
    const selected = second.proposals.at(-1);
    expect(selected).toBeDefined();
    const selectedPath = paths.find(path => memoryUriForPath(home, path) === selected.mutation.subjectUri);
    expect(selectedPath).toBeDefined();
    if (selectedPath === undefined) throw new Error('expected selected proposal path');
    expect(await readFile(selectedPath, 'utf8')).toBe(bytesBeforePreview[paths.indexOf(selectedPath)]);

    const applyBase = [
      'context',
      'repair',
      'apply',
      '--project',
      'project-a',
      '--proposal-id',
      selected.proposalId,
      '--revision',
      selected.revision,
      '--approved',
      '--json',
    ] as const;
    await expect(runCli(applyBase, home)).rejects.toThrow('no longer present');
    await expect(runCli([...applyBase, ...selector], home)).rejects.toThrow('no longer present');
    await expect(
      runCli(
        [
          ...applyBase,
          '--finding-category',
          'validity-expired',
          '--kind',
          'durable',
          '--topic',
          'wrong-topic',
          '--after',
          first.nextCursor,
        ],
        home,
      ),
    ).rejects.toThrow('invalid or stale');
    const applied = JSON.parse((await runCli([...applyBase, ...selector, '--after', first.nextCursor], home)).stdout);
    expect(applied).toMatchObject({status: 'applied', version: 1});
    const repeated = JSON.parse((await runCli([...applyBase, ...selector, '--after', first.nextCursor], home)).stdout);
    expect(repeated).toMatchObject({status: 'already-applied', version: 1});

    const current = JSON.parse(
      (await runCli(['context', 'repair', 'preview', '--project', 'project-a', ...selector, '--json'], home)).stdout,
    );
    const stale = current.proposals[0];
    const stalePath = paths.find(path => memoryUriForPath(home, path) === stale.mutation.subjectUri);
    expect(stalePath).toBeDefined();
    if (stalePath === undefined) throw new Error('expected stale proposal path');
    await storedMemory(
      home,
      'project-a',
      stalePath.slice(stalePath.lastIndexOf('/') + 1),
      {topic: 'overflow-topic', validTo: '2026-09-16T00:00:00.000Z'},
      'Changed after preview.',
    );
    const conflict = JSON.parse(
      (
        await runCli(
          [
            'context',
            'repair',
            'apply',
            '--project',
            'project-a',
            ...selector,
            '--proposal-id',
            stale.proposalId,
            '--revision',
            stale.revision,
            '--approved',
            '--json',
          ],
          home,
        )
      ).stdout,
    );
    expect(conflict).toMatchObject({status: 'conflict', version: 1});
  });

  it('rejects unsafe selector text at the CLI boundary while accepting whitespace-normalized exact topics', async () => {
    const home = await makeHome();
    await storedMemory(home, 'project-a', 'selected.md', {
      topic: 'release / v2: βeta',
      validTo: '2026-09-16T00:00:00.000Z',
    });
    const accepted = JSON.parse(
      (
        await runCli(
          ['context', 'health', '--project', 'project-a', '--topic', '  release / v2: βeta  ', '--json'],
          home,
        )
      ).stdout,
    );
    expect(accepted.recordsScanned).toBe(1);
    await expect(
      runCli(['context', 'health', '--project', 'project-a', '--topic', 'unsafe\nvalue', '--json'], home),
    ).rejects.toThrow('contains control characters');
    for (const character of ['\u0085', '\u009b', '\u2028', '\u2029']) {
      await expect(
        runCli(['context', 'health', '--project', 'project-a', '--topic', `unsafe${character}value`, '--json'], home),
      ).rejects.toThrow('contains control characters');
    }
    await expect(
      runCli(['context', 'health', '--project', 'project-a', '--topic', '🙂'.repeat(65), '--json'], home),
    ).rejects.toThrow('exceeds 256 UTF-8 bytes');
  });

  it('includes preference and smoke records in maintenance health', async () => {
    const home = await makeHome();
    await storedMemoryAt(home, 'preferences/preference.md', 'project-a', 'preference', {
      validTo: '2026-09-16T00:00:00.000Z',
    });
    await storedMemoryAt(home, 'smoke/projects/project-a/smoke.md', 'project-a', 'smoke', {
      reviewAfter: '2026-09-16',
    });

    const result = await runCli(['context', 'health', '--project', 'project-a', '--json'], home);
    const report = JSON.parse(result.stdout);

    expect(report.recordsScanned).toBe(2);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({category: 'validity-expired'}),
        expect.objectContaining({category: 'review-overdue'}),
      ]),
    );
  });

  it('resolves stable relation aliases across active, inactive, and conflicted records', async () => {
    const home = await makeHome();
    await storedMemory(home, 'project-a', 'source.md', {
      memoryId: 'tn_source',
      relations: [
        {type: 'depends_on', uri: 'threadnote://memory/tn_active'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_inactive'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_conflict'},
      ],
    });
    await storedMemory(home, 'project-a', 'active.md', {memoryId: 'tn_active'}, 'active target');
    await storedMemory(
      home,
      'project-a',
      'inactive.md',
      {
        memoryId: 'tn_inactive',
        status: 'archived',
      },
      'inactive target',
    );
    await storedMemory(home, 'project-a', 'conflict-a.md', {memoryId: 'tn_conflict'}, 'conflict target a');
    await storedMemory(home, 'project-a', 'conflict-b.md', {memoryId: 'tn_conflict'}, 'conflict target b');

    const result = await runCli(['context', 'health', '--project', 'project-a', '--json'], home);
    const categories = JSON.parse(result.stdout).findings.map(
      (finding: {readonly category: string}) => finding.category,
    );

    expect(categories).toContain('relation-target-inactive');
    expect(categories).toContain('relation-target-conflicted');
    expect(categories).not.toContain('relation-target-missing');
  });

  it('surfaces pending candidate contradictions through the production health command', async () => {
    const home = await makeHome();
    const target = await storedMemory(home, 'project-a', 'target.md', {memoryId: 'tn_target'});
    await storedMemory(home, 'project-a', 'selected.md', {topic: 'selected-topic'});
    const closeout: SessionCloseoutInput = {
      decisions: ['Replace contradictory guidance after review.'],
      evidence: ['apps/threadnote/test/integration/context-value-report-cli.test.ts'],
      outcome: 'Prepared a contradiction for review.',
      project: 'project-a',
      sourceAgentClient: 'test',
      task: 'Exercise candidate health evidence',
      topic: 'candidate-health',
    };
    const draft = await run(buildCandidateReview(closeout, [], new Date()));
    const candidate = draft.candidates[0];
    expect(candidate).toBeDefined();
    await run(
      saveCandidateReview(home, {
        ...draft,
        candidates: [
          {
            ...candidate,
            comparison: 'contradiction',
            reason: 'The reviewed candidate contradicts current guidance.',
            recommendation: 'manual_review',
            targetUri: memoryUriForPath(home, target),
          },
        ],
      }),
    );

    const result = await runCli(['context', 'health', '--project', 'project-a', '--json'], home);
    expect(JSON.parse(result.stdout).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({category: 'candidate-contradiction'})]),
    );
    const selected = JSON.parse(
      (await runCli(['context', 'health', '--project', 'project-a', '--topic', 'selected-topic', '--json'], home))
        .stdout,
    );
    expect(selected.findings).toEqual([]);
    const preview = JSON.parse(
      (
        await runCli(
          ['context', 'repair', 'preview', '--project', 'project-a', '--topic', 'selected-topic', '--json'],
          home,
        )
      ).stdout,
    );
    expect(preview.proposals).toEqual([]);
    const categoryOnly = JSON.parse(
      (
        await runCli(
          ['context', 'health', '--project', 'project-a', '--finding-category', 'candidate-contradiction', '--json'],
          home,
        )
      ).stdout,
    );
    expect(categoryOnly.findings).toEqual([expect.objectContaining({category: 'candidate-contradiction'})]);
  });

  it('requires a report-bound reviewer direction before proposing semantic supersession', async () => {
    const home = await makeHome();
    const stalePath = await storedMemory(
      home,
      'project-a',
      'stale-policy.md',
      {memoryId: 'tn_cli_stale_policy'},
      'Agents must never reuse verified context.',
    );
    const currentPath = await storedMemory(
      home,
      'project-a',
      'current-policy.md',
      {memoryId: 'tn_cli_current_policy'},
      'Agents must reuse verified context.',
    );
    const staleUri = memoryUriForPath(home, stalePath);
    const currentUri = memoryUriForPath(home, currentPath);
    const health = JSON.parse((await runCli(['context', 'health', '--project', 'project-a', '--json'], home)).stdout);
    const finding = health.findings.find(
      (item: {readonly category: string}) => item.category === 'semantic-contradiction',
    );
    expect(finding?.semanticEvidence?.contradictionId).toMatch(/^[0-9a-f]{64}$/u);

    const neutral = JSON.parse(
      (await runCli(['context', 'repair', 'preview', '--project', 'project-a', '--json'], home)).stdout,
    );
    const neutralProposal = neutral.proposals.find(
      (proposal: {readonly findingId: string}) => proposal.findingId === finding.id,
    );
    expect(neutralProposal.mutation.suggestedMutation).toBeUndefined();

    const directed = JSON.parse(
      (
        await runCli(
          [
            'context',
            'repair',
            'preview',
            '--project',
            'project-a',
            '--contradiction-id',
            finding.semanticEvidence.contradictionId,
            '--report-revision',
            neutral.reportRevision,
            '--stale-uri',
            staleUri,
            '--current-uri',
            currentUri,
            '--json',
          ],
          home,
        )
      ).stdout,
    );
    const directedProposal = directed.proposals.find(
      (proposal: {readonly findingId: string}) => proposal.findingId === finding.id,
    );
    expect(directedProposal.mutation.suggestedMutation).toMatchObject({
      designation: {
        contradictionId: finding.semanticEvidence.contradictionId,
        currentUri,
        reportRevision: neutral.reportRevision,
        staleUri,
        type: 'context-health-semantic-direction',
        version: 1,
      },
      kind: 'supersede-memory',
      subjectUri: staleUri,
      supersededByUri: currentUri,
    });
  });

  it('aggregates only selected-project local feedback and leaves it unchanged', async () => {
    const home = await makeHome();
    const feedbackPath = join(home, 'feedback', 'recall-events-v1.jsonl');
    const content = [
      feedback('applied', 'project-a'),
      feedback('useful', 'project-a'),
      feedback('wrong', 'project-b'),
      feedback('pin', 'project-a'),
    ].join('\n');
    await mkdir(join(home, 'feedback'), {recursive: true});
    await writeFile(feedbackPath, `${content}\n`, 'utf8');

    const result = await runCli(['value', 'report', '--project', 'project-a', '--period', '365', '--json'], home);
    const report = JSON.parse(result.stdout) as {
      readonly feedback: {
        readonly pin: number;
        readonly applied: number;
        readonly total: number;
        readonly useful: number;
        readonly wrong: number;
      };
      readonly scope: string;
      readonly type: string;
      readonly version: number;
    };

    expect(report).toMatchObject({
      feedback: {applied: 1, pin: 1, total: 3, useful: 1, wrong: 0},
      scope: 'local',
      type: 'value-report',
      version: 1,
    });
    expect(await readFile(feedbackPath, 'utf8')).toBe(`${content}\n`);
  });

  it('records applied feedback from the normal CLI without storing the query', async () => {
    const home = await makeHome();
    const query = 'Private applied context query';
    const uri = 'threadnote://user/local/memories/durable/projects/project-a/applied.md';

    const result = await runCli(
      ['recall-feedback', uri, '--action', 'applied', '--project', 'project-a', '--query', query],
      home,
    );

    expect(result.stdout).toContain(`Recorded applied feedback for ${uri}.`);
    const stored = await readFile(join(home, 'feedback', 'recall-events-v1.jsonl'), 'utf8');
    expect(stored).toContain('"action":"applied"');
    expect(stored).not.toContain(query);
  });

  it('includes projectless non-pin feedback in a project-filtered report', async () => {
    const home = await makeHome();
    const feedbackPath = join(home, 'feedback', 'recall-events-v1.jsonl');

    const recorded = await runCli(
      [
        'recall-feedback',
        'threadnote://user/local/memories/global.md',
        '--action',
        'applied',
        '--query',
        'global query',
      ],
      home,
    );
    expect(recorded.stdout).toContain('Recorded applied feedback');
    const beforeReport = await readFile(feedbackPath, 'utf8');

    const result = await runCli(['value', 'report', '--project', 'project-a', '--period', '365', '--json'], home);
    const report = JSON.parse(result.stdout);

    expect(report.feedback).toMatchObject({applied: 1, total: 1});
    expect(JSON.stringify(report)).not.toContain('global');
    expect(JSON.stringify(report)).not.toContain('query');
    expect(JSON.stringify(report)).not.toContain('threadnote://');
    expect(await readFile(feedbackPath, 'utf8')).toBe(beforeReport);
  });

  it('reports locally observed health and Knowledge Delta activity while setup remains explicitly unavailable', async () => {
    const home = await makeHome();
    await storedMemory(
      home,
      'project-a',
      'required.md',
      {},
      '- Agents must load verified context before implementation.',
    );
    await storedMemory(
      home,
      'project-a',
      'forbidden.md',
      {},
      '- Agents must not load verified context before implementation.',
    );
    const closeout: SessionCloseoutInput = {
      decisions: ['Keep value reporting local and count-only.'],
      evidence: ['apps/threadnote/test/integration/context-value-report-cli.test.ts'],
      outcome: 'Recorded a reviewed delta.',
      project: 'project-a',
      sourceAgentClient: 'test',
      task: 'Exercise value event aggregation',
      topic: 'value-events',
    };
    const review = await run(buildCandidateReview(closeout, [], new Date()));
    await run(saveCandidateReview(home, review));

    await runCli(['context', 'health', '--project', 'project-a', '--json'], home);
    const result = await runCli(['value', 'report', '--project', 'project-a', '--period', '1', '--json'], home);
    const report = JSON.parse(result.stdout);

    expect(report.health.opened).toBeGreaterThan(0);
    expect(report.knowledgeDelta.proposed).toBe(review.candidates.length);
    expect(report.setup).toEqual({
      availability: 'unavailable',
      completed: 0,
      failed: 0,
      started: 0,
      supportedAgentReuse: 0,
    });
    expect(JSON.stringify(report)).not.toContain('value-events');
    expect(JSON.stringify(report)).not.toContain('context-value-report-cli.test.ts');
  });
});

function feedback(action: 'applied' | 'pin' | 'useful' | 'wrong', project: string): string {
  return JSON.stringify({
    action,
    project,
    queryFingerprint: 'a'.repeat(64),
    rankerVersion: 'test',
    timestamp: '2026-09-16T12:00:00.000Z',
    uri: 'threadnote://user/local/memories/durable/projects/project-a/example.md',
    version: 1,
  });
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-context-value-cli-'));
  homes.push(home);
  return home;
}

async function storedMemory(
  home: string,
  project: string,
  name: string,
  overrides: Partial<MemoryMetadata> = {},
  body = 'Stored integration-test memory.',
): Promise<string> {
  return storedMemoryAt(home, `durable/projects/${project}/${name}`, project, 'durable', overrides, body);
}

async function storedMemoryAt(
  home: string,
  relativePath: string,
  project: string,
  kind: MemoryMetadata['kind'],
  overrides: Partial<MemoryMetadata> = {},
  body = 'Stored integration-test memory.',
): Promise<string> {
  const path = join(home, 'data', 'local', 'user', 'local', 'memories', relativePath);
  const metadata: MemoryMetadata = {
    kind,
    project,
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-09-01T00:00:00.000Z',
    topic: 'context-value-cli',
    ...overrides,
  };
  await mkdir(join(path, '..'), {recursive: true});
  await writeFile(path, formatMemoryDocument(kind === 'handoff' ? 'HANDOFF' : 'MEMORY', metadata, body), 'utf8');
  return path;
}

function memoryUriForPath(home: string, path: string): string {
  const root = join(home, 'data', 'local', 'user', 'local', 'memories');
  return `threadnote://user/local/memories/${path.slice(root.length + 1)}`;
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
