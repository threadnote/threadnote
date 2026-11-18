/** Private smoke pipeline endpoint. stdout remains the shell pipeline, never diagnostics. */
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';

const [receipt, token, executable, ...args] = process.argv.slice(2);
if (!receipt || !token || !executable) process.exit(2);

const child = spawn(executable, args, {stdio: 'inherit', windowsHide: true});
let spawned = false;
let failure = false;
let exit: {code: number | null; signal: NodeJS.Signals | null} | undefined;
child.once('spawn', () => {
  spawned = true;
});
child.once('error', () => {
  failure = true;
});
child.once('exit', (code, signal) => {
  exit = {code, signal};
});
child.once('close', () => {
  void (async () => {
    if (!spawned || failure || !exit) {
      process.exitCode = 1;
      return;
    }
    try {
      await writeFile(receipt, JSON.stringify({version: 1, token, ...exit}), {flag: 'wx', mode: 0o600});
      process.exitCode = exit.code === 0 && exit.signal === null ? 0 : 1;
    } catch {
      process.exitCode = 1;
    }
  })();
});
