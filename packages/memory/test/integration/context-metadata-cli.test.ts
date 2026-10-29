import {Array as EffectArray} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {afterEach, describe, expect, it} from 'vitest';
import {promisify} from 'node:util';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';

const execFilePromise = promisify(execFile);
const homes: string[] = [];
const URI = 'threadnote://user/local/memories/durable/projects/project-a/topic.md';

afterEach(async () => {
  await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
});

describe('context metadata CLI', () => {
  it('previews and applies an approved metadata-only CAS update with a calendar review date', async () => {
    const home = await makeHome();
    const path = await storedMemory(home);
    const before = await readFile(path, 'utf8');
    const preview = JSON.parse(
      (
        await runCli(
          [
            'context',
            'metadata',
            'preview',
            '--uri',
            URI,
            '--owner',
            'maintainer',
            '--review-after',
            '2026-12-31',
            '--json',
          ],
          home,
        )
      ).stdout,
    );
    expect(preview).toMatchObject({status: 'preview', proposal: {targetUri: URI}});
    expect(await readFile(path, 'utf8')).toBe(before);
    const applied = JSON.parse(
      (
        await runCli(
          [
            'context',
            'metadata',
            'apply',
            '--uri',
            URI,
            '--owner',
            'maintainer',
            '--review-after',
            '2026-12-31',
            '--proposal-id',
            preview.proposal.proposalId,
            '--revision',
            preview.proposal.revision,
            '--content-hash',
            preview.proposal.expectedContentHash,
            '--approved',
            '--json',
          ],
          home,
        )
      ).stdout,
    );
    expect(applied).toMatchObject({status: 'applied'});
    const updated = parseMemoryDocument(URI, await readFile(path, 'utf8'));
    expect(updated?.metadata.owner).toBe('maintainer');
    expect(updated?.metadata.reviewAfter).toBe('2026-12-31');
    expect(updated?.body).toBe('Body is preserved.');
  });
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-context-metadata-'));
  homes.push(home);
  return home;
}

async function storedMemory(home: string): Promise<string> {
  const directory = join(home, 'data', 'local', 'user', 'local', 'memories', 'durable', 'projects', 'project-a');
  const path = join(directory, 'topic.md');
  await mkdir(directory, {recursive: true});
  await writeFile(
    path,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        memoryId: 'tn_topic',
        project: 'project-a',
        sourceAgentClient: 'test',
        status: 'active',
        timestamp: '2026-09-17T00:00:00.000Z',
        topic: 'topic',
      },
      'Body is preserved.',
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
