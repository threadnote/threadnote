import {Array as EffectArray} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {afterEach, describe, expect, it} from 'vitest';

const execFilePromise = promisify(execFile);
const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(EffectArray.map(temporaryHomes.splice(0), home => rm(home, {force: true, recursive: true})));
});

describe('recall CLI explicit memory navigation', () => {
  it('documents the conditional query and rejects requests with neither input lane', async () => {
    const home = await temporaryHome();
    const help = await runCli(['recall', '--help'], home);
    expect(help.stdout).toContain('optional when --memory-ref supplies an explicit navigation seed');

    const missingInput = await runCli(['recall'], home).catch(cliFailure);
    expect(missingInput).toMatchObject({code: 1});
    expect(missingInput.stderr).toContain(
      'Threadnote recall needs either a non-empty --query or at least one --memory-ref seed.',
    );

    const missingPremise = await runCli(['recall', '--relation-type', 'depends_on'], home).catch(cliFailure);
    expect(missingPremise).toMatchObject({code: 1});
    expect(missingPremise.stderr).toContain('--relation-type requires at least one --memory-ref.');
  });

  it('runs a seed-only one-hop journey without inventing a semantic query', async () => {
    const home = await temporaryHome();
    const memoryRoot = join(home, 'data', 'local', 'user', 'local', 'memories', 'durable', 'projects', 'threadnote');
    const seedUri = 'threadnote://user/local/memories/durable/projects/threadnote/cli-seed.md';
    const targetUri = 'threadnote://user/local/memories/durable/projects/threadnote/cli-target.md';
    await mkdir(memoryRoot, {recursive: true});
    await writeFile(
      join(memoryRoot, 'cli-seed.md'),
      memoryDocument(
        'cli-seed',
        'tn_cli_seed_only_journey',
        'Seed body must not become a topical query.',
        'depends_on threadnote://memory/tn_cli_target_only_journey',
      ),
    );
    await writeFile(
      join(memoryRoot, 'cli-target.md'),
      memoryDocument('cli-target', 'tn_cli_target_only_journey', 'Explicit one-hop target.'),
    );

    const recalled = await runCli(
      [
        'recall',
        '--project',
        'threadnote',
        '--memory-ref',
        'tn_cli_seed_only_journey',
        '--relation-type',
        'depends_on',
      ],
      home,
    );

    expect(recalled.stdout).toContain(`premise 1: ${seedUri} [current]`);
    expect(recalled.stdout).toContain(`outgoing depends_on: ${targetUri} [current; resolved]`);
    expect(recalled.stdout).toContain(
      'Recall confidence: high (1.00; explicit-memory-connection) — Verified one-hop relation; confidence covers navigation only, not entailment.',
    );
    expect(recalled.stdout).toContain(`Next: threadnote read ${targetUri}`);
    expect(recalled.stdout).toContain('Relations are navigation evidence, not entailment.');
    expect(recalled.stdout).not.toContain('Recall confidence: no answer');
    expect(recalled.stdout).not.toContain('No semantically-relevant matches');
    expect(recalled.stdout).not.toContain('Recall query expansion:');
  });
});

function isCliFailure(error: unknown): error is Error & {readonly stderr: string} {
  return error instanceof Error && 'stderr' in error && typeof error.stderr === 'string';
}

function cliFailure(error: unknown) {
  if (!isCliFailure(error)) throw error;
  return error;
}

function memoryDocument(topic: string, memoryId: string, body: string, relation?: string): string {
  return EffectArray.join(
    [
      'MEMORY',
      'kind: durable',
      'status: active',
      'project: threadnote',
      `topic: ${topic}`,
      'source_agent_client: integration-test',
      'timestamp: 2026-09-01T00:00:00.000Z',
      `memory_id: ${memoryId}`,
      ...(relation ? [`relation: ${relation}`] : []),
      '',
      body,
    ],
    '\n',
  );
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-cli-recall-'));
  temporaryHomes.push(home);
  return home;
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
