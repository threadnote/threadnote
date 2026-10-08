import {execFile} from '@threadnote/testing/node-child-process';
import {mkdir, mkdtemp, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {promisify} from '@threadnote/testing/node-util';
import {expect, it} from 'vitest';

const execFilePromise = promisify(execFile);

it('delivers a cited action card for an existing Edit file and stays silent for new or outside files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-code-brief-hook-'));
  const repository = join(root, 'repository');
  const home = join(root, 'home');
  const source = join(repository, 'src', 'subject.ts');
  const environment = {THREADNOTE_HOME: home, THREADNOTE_USER: 'local'};
  try {
    await mkdir(join(repository, 'src'), {recursive: true});
    await writeFile(join(repository, 'package.json'), '{"name":"code-brief-hook-fixture"}\n');
    await writeFile(source, 'export const subject = 1;\n');
    await writeFile(join(root, 'outside.ts'), 'export const outside = true;\n');
    await execFilePromise('git', ['init', '--quiet'], {cwd: repository});
    await execFilePromise('git', ['config', 'user.email', 'threadnote@example.test'], {cwd: repository});
    await execFilePromise('git', ['config', 'user.name', 'Threadnote Test'], {cwd: repository});
    await execFilePromise('git', ['add', '.'], {cwd: repository});
    await execFilePromise('git', ['commit', '--quiet', '--message', 'fixture'], {cwd: repository});
    await runCli(['graph', 'index', '--cwd', repository, '--no-vectors', '--json'], environment);
    await runCli(
      [
        'remember',
        '--project',
        'repository',
        '--topic',
        'stable-subject',
        '--code-ref',
        'src/subject.ts',
        '--require-current-code-refs',
        '--text',
        'Applies to: edits to subject.ts\nInvariant: keep the stable value\nAvoid: resetting the identity\nVerify: run the focused test',
      ],
      environment,
      repository,
    );

    const delivered = await runHook(repository, environment, {
      cwd: repository,
      tool_name: 'Edit',
      tool_input: {file_path: source, old_string: 'subject = 1', new_string: 'subject = 2'},
    });
    expect(delivered.exitCode).toBe(0);
    expect(delivered.stderr).toBe('');
    const output = JSON.parse(delivered.stdout) as {
      hookSpecificOutput: {hookEventName: string; additionalContext: string};
    };
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain('Invariant: keep the stable value');
    expect(output.hookSpecificOutput.additionalContext).toContain('Avoid: resetting the identity');

    for (const filePath of [join(repository, 'src', 'new.ts'), join(root, 'outside.ts')]) {
      const ignored = await runHook(repository, environment, {
        cwd: repository,
        tool_name: 'Write',
        tool_input: {file_path: filePath, content: 'export const value = 2;'},
      });
      expect(ignored.exitCode).toBe(0);
      expect(ignored.stdout).toBe('');
      expect(ignored.stderr).toBe('');
    }
  } finally {
    await rm(root, {force: true, recursive: true});
  }
}, 120_000);

function runCli(args: readonly string[], environment: NodeJS.ProcessEnv, cwd = process.cwd()) {
  return execFilePromise(
    process.execPath,
    [join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'), ...args],
    {
      cwd,
      env: {...process.env, ...environment, NO_COLOR: '1'},
    },
  );
}

async function runHook(repository: string, environment: NodeJS.ProcessEnv, payload: unknown) {
  const child = Bun.spawn(
    [process.execPath, join(process.cwd(), 'apps', 'threadnote', 'src', 'standalone.ts'), 'code-brief-hook'],
    {
      cwd: repository,
      env: {...process.env, ...environment, NO_COLOR: '1'},
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  await child.stdin.write(JSON.stringify(payload));
  await child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {exitCode, stdout, stderr};
}
