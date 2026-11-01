import {expect, it} from 'vitest';
import fc from 'fast-check';
import * as EffectArray from 'effect/Array';
import {mkdir, mkdtemp, readdir, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {removeCompiledFixture} from './native-release-cleanup.js';

it('retries transient removal errors with the existing bounded backoff', async () => {
  const delays: number[] = [];
  const failures = ['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'];
  let attempts = 0;
  await removeCompiledFixture('owned-fixture', {
    remove: async (path, options) => {
      expect(path).toBe('owned-fixture');
      expect(options).toEqual({recursive: true, force: true});
      const code = failures[attempts++];
      if (code) throw Object.assign(new Error(code), {code});
    },
    wait: async delay => {
      delays.push(delay);
    },
  });
  expect(attempts).toBe(6);
  expect(delays).toEqual([50, 100, 150, 200, 250]);
});

it('preserves the final busy error after exactly ten retries', async () => {
  const failure = Object.assign(new Error('locked executable'), {code: 'EBUSY'});
  const delays: number[] = [];
  let attempts = 0;
  await expect(
    removeCompiledFixture('owned-fixture', {
      remove: async () => {
        attempts++;
        throw failure;
      },
      wait: async delay => {
        delays.push(delay);
      },
    }),
  ).rejects.toBe(failure);
  expect(attempts).toBe(11);
  expect(delays).toEqual([50, 100, 150, 200, 250, 300, 350, 400, 450, 500]);
});

it('does not retry permanent errors or arbitrary thrown values', async () => {
  for (const failure of [Object.assign(new Error('denied'), {code: 'EACCES'}), new Error('unknown'), null]) {
    let attempts = 0;
    await expect(
      removeCompiledFixture('owned-fixture', {
        remove: async () => {
          attempts++;
          return Promise.reject(failure);
        },
        wait: async () => {
          throw new Error('Permanent errors must not wait.');
        },
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  }
});

it('stops at success or the retry budget for arbitrary transient error sequences', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom('EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'), {maxLength: 16}),
      async codes => {
        const failures = EffectArray.map(codes, code => Object.assign(new Error(code), {code}));
        let attempts = 0;
        const delays: number[] = [];
        const cleanup = removeCompiledFixture('owned-fixture', {
          remove: async () => {
            const failure = failures[attempts++];
            if (failure) throw failure;
          },
          wait: async delay => {
            delays.push(delay);
          },
        });
        if (codes.length > 10) await expect(cleanup).rejects.toBe(failures[10]);
        else await cleanup;
        expect(attempts).toBe(Math.min(codes.length + 1, 11));
        expect(delays.length).toBe(Math.min(codes.length, 10));
        expect(EffectArray.reduce(delays, 0, (sum, delay) => sum + delay)).toBeLessThanOrEqual(2750);
      },
    ),
    {numRuns: 40},
  );
});

it('removes nested owned files and tolerates an already removed fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-release-cleanup-'));
  try {
    const nested = join(root, 'nested');
    await mkdir(nested);
    await writeFile(join(nested, 'fixture'), 'compiled fixture');
    await removeCompiledFixture(nested);
    expect(await readdir(root)).toEqual([]);
    await removeCompiledFixture(nested);
  } finally {
    await removeCompiledFixture(root);
  }
});
