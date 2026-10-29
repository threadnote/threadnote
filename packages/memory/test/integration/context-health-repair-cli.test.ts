import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  canonicalMemoryDocumentContent,
  formatMemoryDocument,
  memoryArchiveBody,
  memoryArchiveMetadata,
  parseMemoryDocument,
  type MemoryMetadata,
} from '@threadnote/memory/document';
import {afterEach, describe, expect, it} from 'vitest';
import {promisify} from 'node:util';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const execFilePromise = promisify(execFile);
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
});

describe('context health repair CLI', () => {
  it('keeps preview read-only and applies an approved archive idempotently', async () => {
    const home = await makeHome();
    const sourcePath = await storedMemory(home, 'expired', {validTo: '2000-01-01T00:00:00.000Z'});
    const before = await readFile(sourcePath, 'utf8');

    const preview = await runCli(['context', 'repair', 'preview', '--project', 'project-a', '--json'], home);
    const plan = parseRepairPlan(JSON.parse(preview.stdout));
    const proposal = EffectOption.getOrUndefined(
      EffectArray.findFirst(plan.proposals, item => item.mutation.kind === 'archive-memory'),
    );

    expect(proposal).toBeDefined();
    expect(await readFile(sourcePath, 'utf8')).toBe(before);
    await expect(readFile(join(home, 'threadnote', 'context-health-repairs'), 'utf8')).rejects.toThrow();

    const withoutApproval = await runCli(
      [
        'context',
        'repair',
        'apply',
        '--project',
        'project-a',
        '--proposal-id',
        proposal?.proposalId ?? '',
        '--revision',
        proposal?.revision ?? '',
        '--json',
      ],
      home,
    ).catch(error => {
      if (!isCliFailure(error)) throw error;
      return error;
    });
    expect(withoutApproval).toMatchObject({code: 1});
    expect(withoutApproval.stderr).toContain('requires --approved');

    const args = [
      'context',
      'repair',
      'apply',
      '--project',
      'project-a',
      '--proposal-id',
      proposal?.proposalId ?? '',
      '--revision',
      proposal?.revision ?? '',
      '--approved',
      '--json',
    ] as const;
    const applied = JSON.parse((await runCli(args, home)).stdout);
    const retried = JSON.parse((await runCli(args, home)).stdout);

    expect(applied).toMatchObject({proposalId: proposal?.proposalId, status: 'applied', version: 1});
    expect(retried).toMatchObject({proposalId: proposal?.proposalId, status: 'already-applied', version: 1});
    await expect(readFile(sourcePath, 'utf8')).rejects.toThrow();
    const memoryRoot = join(home, 'data', 'local', 'user', 'local', 'memories');
    const archived = EffectArrayPipe(await readdir(memoryRoot, {recursive: true}), __effectArrayValues =>
      EffectArray.filter(
        __effectArrayValues,
        (name, __effectArrayIndex) =>
          __effectArrayIndex in __effectArrayValues && Effect.pipe(name, EffectString.endsWith('.md')),
      ),
    );
    expect(EffectArray.some(archived, name => Effect.pipe(name, EffectString.includes('archived')))).toBe(true);
  });

  it('removes only the reviewed missing relation and preserves stable identity', async () => {
    const home = await makeHome();
    const missingUri = 'threadnote://user/local/memories/durable/projects/project-a/missing.md';
    const sourcePath = await storedMemory(home, 'source', {
      memoryId: 'tn_source',
      relations: [
        {type: 'depends_on', uri: missingUri},
        {type: 'references', uri: 'threadnote://memory/tn_active'},
      ],
    });
    await storedMemory(home, 'active', {memoryId: 'tn_active'});

    const preview = parseRepairPlan(
      JSON.parse((await runCli(['context', 'repair', 'preview', '--project', 'project-a', '--json'], home)).stdout),
    );
    const proposal = EffectOption.getOrUndefined(
      EffectArray.findFirst(preview.proposals, item => item.mutation.kind === 'remove-relations'),
    );
    expect(proposal).toBeDefined();

    const result = JSON.parse(
      (
        await runCli(
          [
            'context',
            'repair',
            'apply',
            '--project',
            'project-a',
            '--proposal-id',
            proposal?.proposalId ?? '',
            '--revision',
            proposal?.revision ?? '',
            '--approved',
            '--json',
          ],
          home,
        )
      ).stdout,
    );
    const updated = parseMemoryDocument('threadnote://memory/source', await readFile(sourcePath, 'utf8'));

    expect(result).toMatchObject({status: 'applied', version: 1});
    expect(updated?.metadata.memoryId).toBe('tn_source');
    expect(updated?.metadata.relations).toEqual([{type: 'references', uri: 'threadnote://memory/tn_active'}]);
  });

  it('keeps malformed direct targets review-only and removes missing or inactive stable aliases', async () => {
    const home = await makeHome();
    const malformedUri = 'threadnote://user/local/memories/durable/projects/project-a/malformed-target.md';
    const missingAlias = 'threadnote://memory/tn_missing_alias';
    const inactiveAlias = 'threadnote://memory/tn_inactive_alias';
    const sourcePath = await storedMemory(home, 'source', {
      relations: [
        {type: 'depends_on', uri: malformedUri},
        {type: 'references', uri: missingAlias},
        {type: 'references', uri: inactiveAlias},
      ],
    });
    await storedMemory(home, 'inactive', {memoryId: 'tn_inactive_alias', status: 'archived'});
    const malformedPath = join(
      home,
      'data',
      'local',
      'user',
      'local',
      'memories',
      'durable',
      'projects',
      'project-a',
      'malformed-target.md',
    );
    await writeFile(malformedPath, 'not a memory document\n', 'utf8');

    const preview = parseRepairPlan(
      JSON.parse((await runCli(['context', 'repair', 'preview', '--project', 'project-a', '--json'], home)).stdout),
    );
    const malformed = EffectOption.getOrUndefined(
      EffectArray.findFirst(preview.proposals, item => item.mutation.targetUri === malformedUri),
    );
    const missing = EffectOption.getOrUndefined(
      EffectArray.findFirst(preview.proposals, item => item.mutation.targetUri === missingAlias),
    );
    const inactive = EffectOption.getOrUndefined(
      EffectArray.findFirst(preview.proposals, item => item.mutation.targetUri === inactiveAlias),
    );

    expect(malformed).toMatchObject({category: 'relation-target-missing', mutation: {kind: 'review-only'}});
    expect(missing).toMatchObject({category: 'relation-target-missing', mutation: {kind: 'remove-relations'}});
    expect(inactive).toMatchObject({category: 'relation-target-inactive', mutation: {kind: 'remove-relations'}});
    await applyProposal(home, missing);

    const refreshed = parseRepairPlan(
      JSON.parse((await runCli(['context', 'repair', 'preview', '--project', 'project-a', '--json'], home)).stdout),
    );
    await applyProposal(
      home,
      EffectOption.getOrUndefined(
        EffectArray.findFirst(refreshed.proposals, item => item.mutation.targetUri === inactiveAlias),
      ),
    );

    const updated = parseMemoryDocument('threadnote://memory/source', await readFile(sourcePath, 'utf8'));
    expect(updated?.metadata.memoryId).toBe('tn_source');
    expect(updated?.metadata.relations).toEqual([{type: 'depends_on', uri: malformedUri}]);
  });

  it('resumes an applying archive journal by reusing its exact revision-addressed archive', async () => {
    const home = await makeHome();
    const sourcePath = await storedMemory(home, 'crash-recovery', {validTo: '2000-01-01T00:00:00.000Z'});
    const sourceUri = 'threadnote://user/local/memories/durable/projects/project-a/crash-recovery.md';
    const source = parseMemoryDocument(sourceUri, await readFile(sourcePath, 'utf8'));
    if (!source) throw new Error('Expected source memory.');
    const plan = parseRepairPlan(
      JSON.parse((await runCli(['context', 'repair', 'preview', '--project', 'project-a', '--json'], home)).stdout),
    );
    const proposal = EffectOption.getOrUndefined(
      EffectArray.findFirst(plan.proposals, item => item.mutation.kind === 'archive-memory'),
    );
    if (!proposal) throw new Error('Expected archive proposal.');
    const timestamp = '2026-09-17T21:00:00.000Z';
    const archiveContent = formatMemoryDocument(
      'MEMORY',
      memoryArchiveMetadata(source.metadata, {
        archivedFrom: source.uri,
        kind: 'durable',
        project: 'project-a',
        sourceAgentClient: 'threadnote',
        timestamp,
        topic: source.metadata.topic,
      }),
      memoryArchiveBody(source.body),
    );
    const archiveName = `${proposal.proposalId}-${proposal.revision}.md`;
    const archiveDirectory = join(
      home,
      'data',
      'local',
      'user',
      'local',
      'memories',
      'durable',
      'archived',
      'project-a',
    );
    await mkdir(archiveDirectory, {recursive: true});
    await writeFile(join(archiveDirectory, archiveName), archiveContent, 'utf8');
    const journalDirectory = join(home, 'threadnote', 'context-health-repairs', 'v1');
    await mkdir(journalDirectory, {recursive: true});
    await writeFile(
      join(journalDirectory, `${proposal.proposalId}-${proposal.revision}.json`),
      `${JSON.stringify({
        archive: {
          contentHash: sha256HexSync(canonicalMemoryDocumentContent(archiveContent)),
          kind: 'durable',
          timestamp,
          uri: `threadnote://user/local/memories/durable/archived/project-a/${archiveName}`,
        },
        proposal,
        state: 'applying',
        version: 1,
      })}\n`,
      'utf8',
    );

    const applied = JSON.parse(
      (
        await runCli(
          [
            'context',
            'repair',
            'apply',
            '--project',
            'project-a',
            '--proposal-id',
            proposal.proposalId,
            '--revision',
            proposal.revision,
            '--approved',
            '--json',
          ],
          home,
        )
      ).stdout,
    );

    expect(applied).toMatchObject({status: 'applied'});
    await expect(readFile(sourcePath, 'utf8')).rejects.toThrow();
    expect(
      EffectArrayPipe(await readdir(archiveDirectory), __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (name, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues && Effect.pipe(name, EffectString.endsWith('.md')),
        ),
      ),
    ).toEqual([archiveName]);
  });

  it('rejects a non-hash revision before constructing a repair journal path', async () => {
    const home = await makeHome();
    await storedMemory(home, 'expired', {validTo: '2000-01-01T00:00:00.000Z'});
    const preview = parseRepairPlan(
      JSON.parse((await runCli(['context', 'repair', 'preview', '--project', 'project-a', '--json'], home)).stdout),
    );
    const proposal = preview.proposals[0];
    const escaped = join(home, 'escaped.json');

    const rejected = await runCli(
      [
        'context',
        'repair',
        'apply',
        '--project',
        'project-a',
        '--proposal-id',
        proposal?.proposalId ?? '',
        '--revision',
        '../../../../escaped',
        '--approved',
        '--json',
      ],
      home,
    ).catch(error => {
      if (!isCliFailure(error)) throw error;
      return error;
    });

    expect(rejected).toMatchObject({code: 1});
    expect(rejected.stderr).toContain('valid exact proposal revision');
    await expect(readFile(escaped, 'utf8')).rejects.toThrow();
  });

  it('reports a stable conflict for a stale proposal revision without writing a journal', async () => {
    const home = await makeHome();
    await storedMemory(home, 'expired', {validTo: '2000-01-01T00:00:00.000Z'});
    const preview = parseRepairPlan(
      JSON.parse((await runCli(['context', 'repair', 'preview', '--project', 'project-a', '--json'], home)).stdout),
    );
    const proposal = preview.proposals[0];
    expect(proposal).toBeDefined();

    const result = JSON.parse(
      (
        await runCli(
          [
            'context',
            'repair',
            'apply',
            '--project',
            'project-a',
            '--proposal-id',
            proposal?.proposalId ?? '',
            '--revision',
            Effect.pipe('f', EffectString.repeat(64)),
            '--approved',
            '--json',
          ],
          home,
        )
      ).stdout,
    );

    expect(result).toMatchObject({conflict: {code: 'revision-mismatch'}, status: 'conflict', version: 1});
    await expect(readFile(join(home, 'threadnote', 'context-health-repairs'), 'utf8')).rejects.toThrow();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function parseRepairPlan(value: unknown): RepairPlan {
  if (!isRepairPlan(value)) throw new Error('Context health repair preview returned an invalid proposal plan.');
  return value;
}

function isRepairPlan(value: unknown): value is RepairPlan {
  return (
    isRecord(value) &&
    EffectArray.isArray(value.proposals) &&
    EffectArray.every(value.proposals, proposal => {
      if (
        !isRecord(proposal) ||
        typeof proposal.category !== 'string' ||
        typeof proposal.proposalId !== 'string' ||
        typeof proposal.revision !== 'string' ||
        !isRecord(proposal.mutation) ||
        typeof proposal.mutation.kind !== 'string'
      ) {
        return false;
      }
      return proposal.mutation.targetUri === undefined || typeof proposal.mutation.targetUri === 'string';
    })
  );
}

function isCliFailure(error: unknown): error is CliFailure {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'number' &&
    'stderr' in error &&
    typeof error.stderr === 'string'
  );
}

interface RepairPlan {
  readonly proposals: readonly {
    readonly category: string;
    readonly mutation: {readonly kind: string; readonly targetUri?: string};
    readonly proposalId: string;
    readonly revision: string;
    readonly [key: string]: unknown;
  }[];
}

interface CliFailure extends Error {
  readonly code?: number;
  readonly stderr: string;
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-context-repair-'));
  homes.push(home);
  return home;
}

async function storedMemory(home: string, topic: string, metadata: Partial<MemoryMetadata> = {}): Promise<string> {
  const directory = join(home, 'data', 'local', 'user', 'local', 'memories', 'durable', 'projects', 'project-a');
  const path = join(directory, `${topic}.md`);
  await mkdir(directory, {recursive: true});
  await writeFile(
    path,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        memoryId: `tn_${topic}`,
        project: 'project-a',
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: '2026-09-17T00:00:00.000Z',
        topic,
        ...metadata,
      },
      `Body for ${topic}.`,
    ),
    'utf8',
  );
  return path;
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

async function applyProposal(home: string, proposal: RepairPlan['proposals'][number] | undefined): Promise<void> {
  expect(proposal).toBeDefined();
  const result = JSON.parse(
    (
      await runCli(
        [
          'context',
          'repair',
          'apply',
          '--project',
          'project-a',
          '--proposal-id',
          proposal?.proposalId ?? '',
          '--revision',
          proposal?.revision ?? '',
          '--approved',
          '--json',
        ],
        home,
      )
    ).stdout,
  );
  expect(result).toMatchObject({status: 'applied', version: 1});
}
