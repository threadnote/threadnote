import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const source = readFileSync(resolve('scripts/windows-process-tree-sampler.ps1'), 'utf8').replaceAll('\r\n', '\n');
const runner = globalThis.Bun ? 'bun' : 'node';
const root = mkdtempSync(join(tmpdir(), 'threadnote-sampler-ready-'));
const stagePath = join(root, 'stages.txt');
const scriptPath = join(root, 'observe.ps1');
const executable = process.argv[2] ?? 'powershell.exe';
const mode = process.argv[3] ?? 'exact';
const started = performance.now();
let stdout = '';
let stderr = '';
let launchError;
let exit;
let firstOutput;
const markOutput = chunk => {
  firstOutput ??= Math.round(performance.now() - started);
  stdout = (stdout + Buffer.from(chunk).toString('utf8')).slice(0, 65536);
};
const markError = chunk => {
  stderr = (stderr + Buffer.from(chunk).toString('utf8')).slice(0, 500);
};

async function boundedWait(observe, limit) {
  const deadline = performance.now() + limit;
  do {
    const value = observe();
    if (value !== undefined) return value;
    await sleep(20);
  } while (performance.now() < deadline);
}

function frame(kind) {
  for (const line of stdout.split('\n').slice(0, -1)) {
    try {
      const result = JSON.parse(line);
      if (result.kind === kind) return result;
    } catch {
      // Keep diagnostic logging bounded and continue to the next complete line.
    }
  }
}

const mark = (match, stage) => `${match}\nWrite-DiagnosticStage '${stage}'`;
const note = `function Write-DiagnosticStage($name) {\n  [IO.File]::AppendAllText($env:TN_SAMPLER_DIAGNOSTIC_STAGE, $name + ' ' + [DateTime]::UtcNow.ToString('o') + [Environment]::NewLine)\n}\nWrite-DiagnosticStage 'script-entered'\n`;
const inputEncoding = '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)';
const outputEncoding = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)';
const readyWrite = "Write-Reply @{protocol=1; kind='ready'; processId=$PID}";
const instrumented = note + source
  .replace(inputEncoding, mark(inputEncoding, 'input-encoding-set'))
  .replace(outputEncoding, mark(outputEncoding, 'output-encoding-set'))
  .replace('  [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 8 -Compress))', "  Write-DiagnosticStage 'before-json'\n  [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 8 -Compress))\n  Write-DiagnosticStage 'after-write-line'")
  .replace('  [Console]::Out.Flush()', "  [Console]::Out.Flush()\n  Write-DiagnosticStage 'after-flush'")
  .replace(readyWrite, mark(readyWrite, 'ready-returned'));
const minimal = `${note}\n[Console]::Out.WriteLine('{"protocol":1,"kind":"ready","processId":' + $PID + '}')\n[Console]::Out.Flush()\nWrite-DiagnosticStage 'ready-returned'\n$null = [Console]::In.ReadLine()\n`;
writeFileSync(scriptPath, mode === 'exact' ? instrumented : minimal);
const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath];
const env = {...process.env, TN_SAMPLER_DIAGNOSTIC_STAGE: stagePath};
let pid;
let send;
let close;
let kill;

try {
  if (globalThis.Bun) {
    const child = Bun.spawn({cmd: [executable, ...args], env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
    pid = child.pid;
    const drain = async (stream, observe) => {
      for await (const chunk of stream) observe(chunk);
    };
    drain(child.stdout, markOutput).catch(() => undefined);
    drain(child.stderr, markError).catch(() => undefined);
    child.exited.then(code => { exit = code; });
    send = async text => { await child.stdin.write(text); await child.stdin.flush(); };
    close = () => child.stdin.end();
    kill = () => child.kill();
  } else {
    const child = spawn(executable, args, {env, stdio: 'pipe'});
    pid = child.pid;
    child.stdout.on('data', markOutput);
    child.stderr.on('data', markError);
    child.stdin.on('error', () => undefined);
    child.on('exit', (code, signal) => { exit = code ?? signal; });
    child.on('error', error => { launchError = error.code ?? error.message; });
    send = async text => { child.stdin.write(text); };
    close = () => child.stdin.end();
    kill = () => child.kill();
  }
} catch (error) {
  launchError = String(error).slice(0, 500);
}

const launched = Math.round(performance.now() - started);
const ready = await boundedWait(() => frame('ready') ?? (exit !== undefined || launchError ? false : undefined), 16_000);
const readyMs = ready ? Math.round(performance.now() - started) : undefined;
let sample;
let sampleMs;
let requestError;
try {
  if (mode === 'exact' && ready?.processId === pid && send) {
    const before = performance.now();
    await Promise.race([send(`${JSON.stringify({protocol: 1, id: '1', rootProcessId: process.pid})}\n`), sleep(1000)]);
    sample = await boundedWait(() => frame('sample'), Math.max(0, 1000 - (performance.now() - before)));
    if (sample) sampleMs = Math.round(performance.now() - before);
  }
} catch (error) {
  requestError = String(error).slice(0, 500);
} finally {
  if (close && exit === undefined && !launchError) {
    await Promise.race([Promise.resolve().then(() => close()).catch(() => undefined), sleep(500)]);
    if ((await boundedWait(() => exit, 1000)) === undefined) kill();
    await boundedWait(() => exit, 1000);
  }
}

let stages;
try {
  stages = readFileSync(stagePath, 'utf8').trim().split(/\r?\n/u).slice(0, 16);
} catch {
  stages = [];
}
console.log(JSON.stringify({runner, architecture: process.arch, executable, mode, launched, firstOutput, readyMs, sampleMs,
  ready: ready?.processId === pid && pid !== undefined,
  sampleOk: sample?.ok,
  sampleReason: sample?.reason,
  stdoutBytes: stdout.length,
  exit, launchError, requestError, stderr: stderr.trim(), stages}));
if (pid !== undefined && exit === undefined) throw new Error('Diagnostic could not confirm exit of its sampler child.');
rmSync(root, {recursive: true, force: true});
