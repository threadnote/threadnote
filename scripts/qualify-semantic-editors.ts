/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- Disposable qualification harness owns explicit OS process and evidence-file boundaries. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {
  installProbeSignalCleanup,
  ownedProbeGroup,
  releaseProbeHandles,
} from '../tools/semantic/semantic_probe_process.js';
import type {ChildProcess} from 'node:child_process';

const {values} = parseArgs({
  options: {probe: {type: 'boolean'}, editor: {type: 'string'}, output: {type: 'string'}},
  strict: true,
});
if (!values.probe || !values.editor || !values.output) {
  throw new Error('Usage: bun scripts/qualify-semantic-editors.ts --probe --editor <CLI> --output <report.json>');
}

const editor = resolve(values.editor);
const extension = resolve('apps/threadnote/test/fixtures/semantic/editor');
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [
      ['runner', fileURLToPath(import.meta.url)],
      ['probe', join(extension, 'probe.cjs')],
      ['wire', join(extension, 'proposal-wire.cjs')],
      ['process', resolve('tools/semantic/semantic_probe_process.ts')],
    ].map(async ([name, path]) => [
      name,
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    ]),
  ),
);

const scratch = await mkdtemp(join(tmpdir(), 'threadnote-semantic-editor-'));
const workspace = join(scratch, 'workspace');
await mkdir(workspace);
await mkdir(join(scratch, 'user', 'User'), {recursive: true});
await writeFile(
  join(scratch, 'user', 'User', 'settings.json'),
  JSON.stringify({'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false}),
);
let output = '';
let group: ReturnType<typeof ownedProbeGroup> | undefined;
let signalCleanup: ReturnType<typeof installProbeSignalCleanup> | undefined;
let ownedChild: ChildProcess | undefined;
try {
  const child = spawn(
    editor,
    [
      '--new-window',
      '--wait',
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--user-data-dir',
      join(scratch, 'user'),
      '--extensions-dir',
      join(scratch, 'extensions'),
      '--extensionDevelopmentPath',
      extension,
      '--extensionTestsPath',
      join(extension, 'probe.cjs'),
      workspace,
    ],
    {stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'},
  );
  ownedChild = child;
  group = ownedProbeGroup(child);
  signalCleanup = installProbeSignalCleanup(async signal => {
    try {
      const cleanup = await group!.cleanup();
      await writeFile(
        values.output,
        JSON.stringify(
          {
            schemaVersion: 1,
            kind: 'editor-feasibility',
            status: 'interrupted',
            signal,
            cleanup,
            scratchRetained: !cleanup.drained,
          },
          null,
          2,
        ) + '\n',
      );
      if (cleanup.drained) await rm(scratch, {recursive: true, force: true});
      else process.stderr.write(`Owned editor group did not drain; retained disposable workspace: ${scratch}\n`);
    } finally {
      releaseProbeHandles(child);
    }
  });
  child.stdout.on('data', data => {
    output = (output + String(data)).slice(-4096);
  });
  child.stderr.on('data', data => {
    output = (output + String(data)).slice(-4096);
  });
  let completedHostProbe = false;
  const stop = (signal: NodeJS.Signals) => {
    group!.signal(signal);
  };
  const exitCode = await new Promise<number | null>((accept, reject) => {
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const poll = setInterval(() => {
      if (completedHostProbe) return;
      void readFile(join(workspace, 'editor-result.json'), 'utf8')
        .then(text => {
          const result = JSON.parse(text);
          if (result.kind !== 'editor-feasibility' || result.results?.length !== 5) return;
          if (completedHostProbe) return;
          completedHostProbe = true;
          // Cursor keeps its application alive after the test window closes.
          // Terminate only our owned process group after the complete host report.
          stop('SIGTERM');
          escalation = setTimeout(() => stop('SIGKILL'), 2000);
        })
        .catch(() => undefined);
    }, 250);
    const clear = () => {
      clearInterval(poll);
      clearTimeout(timeout);
      clearTimeout(escalation);
    };
    const timeout = setTimeout(() => {
      stop('SIGKILL');
      clear();
      reject(new Error('Editor feasibility probe exceeded 90 seconds'));
    }, 90_000);
    child.once('error', error => {
      clear();
      reject(error);
    });
    child.once('exit', code => {
      clear();
      accept(code);
    });
  });
  if (signalCleanup.interrupted) throw new Error('Editor probe interrupted');
  const cleanup = await group.cleanup();
  releaseProbeHandles(child);
  const report = JSON.parse(await readFile(join(workspace, 'editor-result.json'), 'utf8'));
  const receipt = {
    ...report,
    sourceHashes,
    platform: process.platform,
    architecture: process.arch,
    launcherSha256: createHash('sha256')
      .update(await readFile(editor))
      .digest('hex'),
    probeSha256: createHash('sha256')
      .update(await readFile(join(extension, 'probe.cjs')))
      .digest('hex'),
    exitCode,
    cleanup,
    terminatedAfterHostReport: completedHostProbe,
    limitations: ['Disposable feasibility only; durable journal and cross-process authority are not implemented.'],
  };
  await writeFile(values.output, JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify(receipt) + '\n');
  if (
    (!completedHostProbe && exitCode !== 0) ||
    !cleanup.drained ||
    cleanup.scope !== 'posix-process-group' ||
    !report.results.every((item: {status: string}) => item.status === 'passed')
  )
    process.exitCode = 1;
} catch (error) {
  if (!signalCleanup?.interrupted) {
    const diagnostics: Record<string, string> = {};
    const logs = join(scratch, 'user', 'logs');
    for (const name of await readdir(logs, {recursive: true}).catch(() => [])) {
      if (typeof name === 'string' && /(?:main|exthost|renderer)\.log$/u.test(name)) {
        diagnostics[name] = (await readFile(join(logs, name), 'utf8')).slice(-4096);
      }
    }
    await writeFile(
      values.output,
      JSON.stringify({kind: 'editor-feasibility', status: 'failed', message: String(error), diagnostics}, null, 2) +
        '\n',
    );
    process.stderr.write(String(error) + '\n' + output + '\n');
    process.exitCode = 1;
  }
} finally {
  if (!signalCleanup?.interrupted) {
    try {
      const cleanup = await group?.cleanup();
      if (cleanup?.drained !== false) await rm(scratch, {recursive: true, force: true});
      else process.stderr.write(`Owned editor group did not drain; retained disposable workspace: ${scratch}\n`);
    } finally {
      if (ownedChild) releaseProbeHandles(ownedChild);
      signalCleanup?.dispose();
    }
  }
}
