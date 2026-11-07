import {mkdtemp, readFile, rm, writeFile, mkdir} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';
import {tmpdir} from '@threadnote/testing/node-os';
import {expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {confirmRecall} from '../recall-confirmation.js';

it('admits only one proven timing confirmation and retains both attempts before recovery', async () => {
  const previous = process.cwd();
  const root = await mkdtemp(join(tmpdir(), 'recall-confirmation-'));
  process.chdir(root);
  try {
    for (const sequence of [
      ['pass'],
      ['timing-only', 'pass'],
      ['timing-only', 'timing-only'],
      ['correctness'],
      ['generic'],
      ['missing'],
      ['malformed'],
      ['nonce'],
      ['hash'],
      ['signal'],
      ['timing-only', 'missing'],
      ['timing-only', 'pass-missing'],
      ['timing-only', 'pass-malformed'],
      ['timing-only', 'pass-nonce'],
      ['timing-only', 'pass-hash'],
    ]) {
      let calls = 0;
      let firstDirectory = '';
      const receiptBytes: (string | undefined)[] = [];
      const result = await confirmRecall(
        'evidence',
        async (nonce, directory) => {
          if (calls > 0) {
            expect(await readFile(`${firstDirectory}/diagnostics.json`, 'utf8')).toBe('raw attempt 1');
            expect(await readFile(`${firstDirectory}/receipt.json`, 'utf8')).toBe(receiptBytes[0]);
            expect(JSON.parse(await readFile(`${firstDirectory}/status.json`, 'utf8')).exitCode).toBe(75);
            expect(await readFile(`${firstDirectory}/stdout.log`, 'utf8')).toBe('stdout 1');
            expect(await readFile(`${firstDirectory}/stderr.log`, 'utf8')).toBe('stderr 1');
            expect(await Bun.file('artifacts/recall-production-10000.json').exists()).toBe(false);
            expect(await Bun.file('artifacts/recall-production-10000.json.receipt.json').exists()).toBe(false);
          } else firstDirectory = directory;
          const outcome = sequence[calls++];
          const raw = `raw attempt ${calls}`;
          await mkdir('artifacts', {recursive: true});
          await writeFile('artifacts/recall-production-10000.json', raw);
          await writeFile(`${directory}/stdout.log`, `stdout ${calls}`);
          await writeFile(`${directory}/stderr.log`, `stderr ${calls}`);
          const passing =
            outcome === 'pass' ||
            outcome === 'pass-missing' ||
            outcome === 'pass-malformed' ||
            outcome === 'pass-nonce' ||
            outcome === 'pass-hash';
          const verdict = passing ? 'pass' : outcome === 'correctness' ? 'correctness' : 'timing-only';
          const receipt =
            outcome === 'missing' || outcome === 'pass-missing'
              ? undefined
              : outcome === 'malformed' || outcome === 'pass-malformed'
                ? '{'
                : JSON.stringify({
                    version: 1,
                    nonce: outcome === 'nonce' || outcome === 'pass-nonce' ? 'old' : nonce,
                    verdict,
                    diagnosticsSha256: outcome === 'hash' || outcome === 'pass-hash' ? 'old' : sha256HexSync(raw),
                  });
          receiptBytes.push(receipt);
          if (receipt !== undefined) await writeFile('artifacts/recall-production-10000.json.receipt.json', receipt);
          return {
            exitCode: passing ? 0 : outcome === 'correctness' || outcome === 'generic' ? 1 : 75,
            signal: outcome === 'signal' ? 'SIGTERM' : null,
          };
        },
        'summary.md',
      );
      expect(calls).toBe(sequence.length);
      expect(result.classification).toBe(
        sequence[sequence.length - 1] === 'pass' ? (sequence.length === 1 ? 'passed' : 'recovered-flaky') : 'failed',
      );
      expect(result.exitCode).toBe(result.classification === 'failed' ? 1 : 0);
      expect(result.attempts).toHaveLength(calls);
      for (let index = 0; index < receiptBytes.length; index++) {
        if (receiptBytes[index] !== undefined)
          expect(await readFile(`${result.root}/attempt-${index + 1}/receipt.json`, 'utf8')).toBe(receiptBytes[index]);
      }
      expect(JSON.parse(await readFile(`${result.root}/result.json`, 'utf8')).classification).toBe(
        result.classification,
      );
      const summary = await readFile('summary.md', 'utf8');
      expect(summary).toContain(result.classification);
      for (const attempt of result.attempts) {
        expect(summary).toContain(`attempt ${attempt.attempt}: ${attempt.verdict}`);
        expect(summary).toContain(`exit ${attempt.status.exitCode}, signal ${attempt.status.signal ?? 'none'}`);
      }
    }
  } finally {
    process.chdir(previous);
    await rm(root, {recursive: true, force: true});
  }
});

it('does not spawn confirmation if retaining original evidence fails', async () => {
  const previous = process.cwd();
  const root = await mkdtemp(join(tmpdir(), 'recall-confirmation-write-'));
  process.chdir(root);
  try {
    let calls = 0;
    await expect(
      confirmRecall('evidence', async (nonce, directory) => {
        calls++;
        await mkdir('artifacts');
        await writeFile('artifacts/recall-production-10000.json', 'raw');
        await writeFile(
          'artifacts/recall-production-10000.json.receipt.json',
          JSON.stringify({version: 1, nonce, verdict: 'timing-only', diagnosticsSha256: sha256HexSync('raw')}),
        );
        await mkdir(`${directory}/diagnostics.json`);
        return {exitCode: 75, signal: null};
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  } finally {
    process.chdir(previous);
    await rm(root, {recursive: true, force: true});
  }
});

it('retains malformed receipt, diagnostics and log bytes without text normalization', async () => {
  const previous = process.cwd();
  const root = await mkdtemp(join(tmpdir(), 'recall-confirmation-bytes-'));
  process.chdir(root);
  try {
    const raw = new Uint8Array([0, 255, 239, 187, 191, 10]);
    for (const receipt of [new Uint8Array([255, 254, 0]), new Uint8Array([239, 187, 191, 123])]) {
      let calls = 0;
      const result = await confirmRecall('evidence', async (_nonce, directory) => {
        calls++;
        await mkdir('artifacts', {recursive: true});
        await Bun.write('artifacts/recall-production-10000.json', raw);
        await Bun.write('artifacts/recall-production-10000.json.receipt.json', receipt);
        await Bun.write(`${directory}/stdout.log`, raw);
        await Bun.write(`${directory}/stderr.log`, raw);
        return {exitCode: 75, signal: null};
      });
      expect(calls).toBe(1);
      expect(result.exitCode).toBe(1);
      for (const file of ['diagnostics.json', 'stdout.log', 'stderr.log'])
        expect(new Uint8Array(await Bun.file(`${result.root}/attempt-1/${file}`).arrayBuffer())).toEqual(raw);
      expect(new Uint8Array(await Bun.file(`${result.root}/attempt-1/receipt.json`).arrayBuffer())).toEqual(receipt);
    }
  } finally {
    process.chdir(previous);
    await rm(root, {recursive: true, force: true});
  }
});
