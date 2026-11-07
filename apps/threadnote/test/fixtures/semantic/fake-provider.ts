import * as EffectString from 'effect/String';
import {ProbeFrameDecoder, encodeProbeFrame} from '../../../../../tools/semantic/semantic_lsp_probe.js';
/* oxlint-disable effecttsgo/node-builtin-import -- Fixture deliberately leaves an owned child alive to exercise process cleanup. */
import {spawn} from 'node:child_process';
import {closeSync, writeFileSync} from 'node:fs';
const mode = process.argv[2];
if (mode === 'deny-exit' || mode === 'interrupt-provider' || mode === 'interrupt-editor') {
  const descendant =
    mode === 'deny-exit'
      ? undefined
      : spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
  descendant?.unref();
  writeFileSync(
    process.argv[3],
    JSON.stringify({
      pid: process.pid,
      descendant: descendant?.pid,
      cwd: mode === 'interrupt-editor' ? process.argv.at(-1) : process.cwd(),
    }),
  );
  setInterval(() => {}, 1000);
}
const decoder = new ProbeFrameDecoder();
process.stdin.on('data', chunk => {
  for (const message of decoder.push(Buffer.from(chunk))) {
    if (mode === 'close-input-on-shutdown' && message.method === 'shutdown') {
      process.stdin.on('error', () => {});
      closeSync(0);
      process.stdout.write(encodeProbeFrame({jsonrpc: '2.0', method: 'probe/input-closed'}));
      process.stdout.write(encodeProbeFrame({jsonrpc: '2.0', id: message.id, result: null}));
      setTimeout(() => process.exit(0), 100);
      continue;
    }
    if (message.method === 'exit') {
      if (mode === 'deny-exit') continue;
      if (mode === 'panic-on-exit') {
        process.stderr.write("thread 'Worker9' pani", () => {
          process.stderr.write('cked at fixture.rs:1\n' + EffectString.repeat(1500)('backtrace\n'), () =>
            process.exit(0),
          );
        });
        continue;
      }
      process.exit(0);
    }
    if (message.method === 'exit-early') {
      process.stdout.write(encodeProbeFrame({jsonrpc: '2.0', id: message.id, result: null}), () => process.exit(0));
      continue;
    }
    if (mode === 'interrupt-provider' && message.method === 'initialize') continue;
    if (message.method === 'hang') continue;
    if (message.method === 'emit-status') {
      process.stdout.write(
        encodeProbeFrame({jsonrpc: '2.0', method: 'experimental/serverStatus', params: message.params}),
      );
    }
    if (message.method === 'spawn-descendant') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
      child.unref();
      process.stdout.write(encodeProbeFrame({jsonrpc: '2.0', id: message.id, result: child.pid}));
      continue;
    }
    if (message.method === '$/cancelRequest') {
      process.stdout.write(encodeProbeFrame({jsonrpc: '2.0', method: 'probe/cancelled'}));
      continue;
    }
    if (message.id !== undefined)
      process.stdout.write(encodeProbeFrame({jsonrpc: '2.0', id: message.id, result: message.params ?? null}));
  }
});
