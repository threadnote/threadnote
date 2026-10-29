import {Array as EffectArray} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {expect, it} from 'vitest';

const execute = promisify(execFile);
const entry = join(process.cwd(), 'apps/threadnote/src/standalone.ts');

it('runs the actual Cursor CLI protocol from a user-hook cwd, recalls the payload repo, and stores a Cursor snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-cursor-cli-'));
  try {
    const home = join(root, 'threadnote-home');
    const userHookCwd = join(root, 'user-home', '.cursor');
    const repo = join(root, 'cursor-hook-workspace');
    await mkdir(userHookCwd, {recursive: true});
    await mkdir(home, {recursive: true});
    await execute('git', ['init', '--initial-branch=cursor-smoke', repo]);
    // Prevent the hook's optional update banner from needing the network.
    await writeFile(
      join(home, '.update-state.json'),
      JSON.stringify({version: 3, channel: 'latest', checkedAt: new Date().toISOString(), latestVersion: '0.0.0'}),
    );
    const memoryRoot = join(home, 'data/local/user/local/memories/handoffs/active/cursor-hook-workspace');
    await mkdir(memoryRoot, {recursive: true});
    await writeFile(
      join(memoryRoot, 'current.md'),
      EffectArray.join(
        [
          'MEMORY',
          'kind: handoff',
          'status: active',
          'project: cursor-hook-workspace',
          'topic: current',
          'source_agent_client: test',
          'timestamp: 2026-09-08T00:00:00.000Z',
          'memory_id: tn_cursor_hook_cli_seed',
          '',
          'Current branch latest handoff for cursor-hook-workspace.',
        ],
        '\n',
      ),
    );
    const payload = {
      conversation_id: 'cursor-conversation',
      workspace_roots: [repo],
      transcript_path: join(root, 'must-not-parse.txt'),
    };
    await writeFile(payload.transcript_path, 'This text is deliberately outside the managed snapshot.');
    const env = {
      ...process.env,
      HOME: join(root, 'user-home'),
      USERPROFILE: join(root, 'user-home'),
      THREADNOTE_HOME: home,
      THREADNOTE_USER: 'local',
      THREADNOTE_CALLER_CWD: userHookCwd,
      THREADNOTE_AUTO_UPDATE: '0',
      NO_COLOR: '1',
    };
    const run = (args: string[]) =>
      new Promise<{stdout: string; stderr: string}>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [entry, ...args],
          {cwd: userHookCwd, env, timeout: 20_000},
          (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve({stdout, stderr});
          },
        );
        child.stdin!.end(JSON.stringify(payload));
      });
    const session = await run(['cursor-hook', 'sessionStart']);
    const response = JSON.parse(session.stdout);
    expect(response.additional_context).toContain('unread context queue for cursor-hook-workspace');
    expect(response.additional_context).toContain(
      'threadnote://user/local/memories/handoffs/active/cursor-hook-workspace/current.md',
    );
    expect(JSON.parse((await run(['cursor-hook', 'preCompact', '--dry-run'])).stdout)).toEqual({});
    expect(await readdir(memoryRoot)).toEqual(['current.md']);
    expect(JSON.parse((await run(['cursor-hook', 'preCompact'])).stdout)).toEqual({});
    const snapshotNames = EffectArray.filter(await readdir(memoryRoot), name => name !== 'current.md');
    expect(snapshotNames).toHaveLength(1);
    const snapshot = await readFile(join(memoryRoot, snapshotNames[0]), 'utf8');
    expect(snapshot).toContain('source_agent_client: cursor');
    expect(snapshot).toContain('session_id: cursor-conversation');
    expect(snapshot).toContain('Auto-snapshot captured at Cursor preCompact');
    expect(snapshot).not.toContain('deliberately outside');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}, 45_000);
