import {createHash} from '@threadnote/testing/node-crypto';
import {mkdtempSync, readFileSync, rmSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {expect, it} from 'vitest';
import fc from 'fast-check';
import {ReleaseCommandError, runReleaseCommand} from './native-release-process.js';

// Real binary pipes through a tiny host-runtime producer; no release build needed.
const producer = (program: string, ...args: string[]) => [process.execPath, '-e', program, ...args];
const run = (command: readonly string[], options: Parameters<typeof runReleaseCommand>[3] = {}) =>
  runReleaseCommand(command, {...process.env}, process.cwd(), {timeoutMs: 5000, ...options});
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const normalize = (text: string) => text.replace(/\r\n?/g, '\n');
const echo = producer("const fs = require('fs'); process.stdout.write(fs.readFileSync(0));");
const captureError = (command: readonly string[], options?: Parameters<typeof runReleaseCommand>[3]) => {
  try {
    run(command, options);
    throw new Error('Expected a process failure');
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseCommandError);
    return error as ReleaseCommandError;
  }
};

it('roundtrips UTF-8 stdin and binary document/JSON stdout with explicit newline normalization and independent hashes', () => {
  const body = 'café — λ 測試 🧪\nnext → €\n';
  expect(run(echo, {input: body})).toBe(body);
  const wire = JSON.stringify({body});
  const emitted = run(
    producer("process.stdout.write(Buffer.from(process.argv[1], 'hex'))", Buffer.from(wire).toString('hex')),
  );
  expect(JSON.parse(emitted).body).toBe(body);
  const reader = producer(
    "const fs=require('fs'); const body=fs.readFileSync(0,'utf8'); process.stdout.write(JSON.stringify({body}));",
  );
  const durable = `${JSON.parse(run(reader, {input: run(echo, {input: body.replace(/\n/g, '\r\n')})})).body.trim()}\n`;
  expect(durable).toBe(body);
  expect(digest(durable)).toBe(digest(body));
  expect(run(echo, {input: 'café\r\nline\rlast\n'})).toBe('café\nline\nlast\n');
});

it('roundtrips bounded Unicode and newline combinations through real UTF-8 pipes', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom('é', '—', 'λ', '測', '🧪', '\n', '\r\n', '\r', 'a'), {minLength: 1, maxLength: 12}),
      values => {
        const body = values.join('');
        const actual = run(echo, {input: body});
        expect(actual).toBe(normalize(body));
        expect(digest(actual)).toBe(digest(normalize(body)));
      },
    ),
    {numRuns: 8, seed: 931},
  );
});

it('rejects malformed UTF-8 independently on either successful pipe and retains raw evidence before decoding', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-release-encoding-'));
  try {
    for (const stream of ['stdout', 'stderr']) {
      const path = join(directory, `${stream}.log`);
      expect(() => run(producer(`process.${stream}.write(Buffer.from([255]));`), {evidencePath: path})).toThrow();
      expect(readFileSync(`${path}.${stream}.bin`)).toEqual(Buffer.from([255]));
      expect(readFileSync(path, 'utf8')).toContain('�');
    }
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

it('keeps nonzero status, command arguments and both raw pipes even when UTF-8 is malformed', () => {
  const command = producer(
    'process.stdout.write(Buffer.from([255]));process.stderr.write(Buffer.from([254]));process.exitCode=7;',
  );
  const error = captureError(command);
  expect(error.command).toBe(command);
  expect(error.args).toBe(command);
  expect(error.cmd).toBe(command);
  expect(error.status).toBe(7);
  expect(error.returncode).toBe(7);
  expect(error.stdout).toEqual(Buffer.from([255]));
  expect(error.output).toBe(error.stdout);
  expect(error.stderr).toEqual(Buffer.from([254]));
  expect(error.timedOut).toBe(false);
});

it('writes bounded human diagnostics alongside complete raw failure pipes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-release-diagnostic-'));
  try {
    const path = join(directory, 'failure.log');
    const error = captureError(
      producer(
        "process.stdout.write(Buffer.alloc(20000,255));process.stderr.write(Buffer.from('café\\r\\nline\\rlast\\n'));process.exitCode=7;",
      ),
      {evidencePath: path},
    );
    expect(readFileSync(`${path}.stdout.bin`)).toEqual(error.stdout);
    expect(readFileSync(`${path}.stderr.bin`)).toEqual(error.stderr);
    expect(error.stdout.length).toBe(20000);
    const diagnostic = readFileSync(path, 'utf8');
    expect(diagnostic).toContain('status=7');
    expect(diagnostic).toContain('café\nline\nlast\n');
    expect(diagnostic.length).toBeLessThan(17_000);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

it('preserves timeout cause, status, args and unmodified binary captures without success decoding', () => {
  const command = producer(
    "process.on('SIGTERM',()=>{});const fs=require('fs');fs.writeSync(1,Buffer.from('{\"status\":\"ok\"}'));fs.writeSync(2,Buffer.from([114,97,119,13,10,255]));setTimeout(()=>{},10000);",
  );
  const started = performance.now();
  const error = captureError(command, {timeoutMs: 1000});
  expect(performance.now() - started).toBeLessThan(5000);
  expect(error.timedOut).toBe(true);
  expect(error.cause?.code).toBe('ETIMEDOUT');
  expect(error.args).toBe(command);
  expect(error.status).toBeNull();
  expect(error.stdout).toEqual(Buffer.from('{"status":"ok"}'));
  expect(error.stderr).toEqual(Buffer.from([114, 97, 119, 13, 10, 255]));
});
