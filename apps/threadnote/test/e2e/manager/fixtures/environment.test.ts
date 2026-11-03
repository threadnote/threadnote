import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {join} from '@threadnote/testing/node-path';
import {tmpdir} from '@threadnote/testing/node-os';
import {fixtureEnvironment} from './environment.js';
import {redactManagerLog} from './runtime.js';
import * as EffectRecord from 'effect/Record';

describe('Manager E2E isolation', () => {
  it('keeps generated fixture roots separate and never inherits unrelated credentials', () => {
    const previous = process.env.MANAGER_E2E_UNRELATED_SECRET;
    process.env.MANAGER_E2E_UNRELATED_SECRET = 'inherited-secret-canary';
    try {
      fc.assert(
        fc.property(fc.array(fc.stringMatching(/^[A-Za-z0-9 é_-]{1,12}$/u), {minLength: 1, maxLength: 4}), segments => {
          const root = join(tmpdir(), 'manager-fixture', ...segments);
          const environment = fixtureEnvironment(root);
          for (const key of ['HOME', 'USERPROFILE', 'THREADNOTE_HOME'])
            expect(environment[key]).toBe(join(root, 'home'));
          for (const key of ['TMPDIR', 'TMP', 'TEMP']) expect(environment[key]).toBe(join(root, 'tmp'));
          expect(environment.THREADNOTE_MANIFEST).toBe(join(root, 'manifest.json'));
          expect(environment.MANAGER_E2E_UNRELATED_SECRET).toBeUndefined();
          expect(EffectRecord.values(environment)).not.toContain('inherited-secret-canary');
          expect(fixtureEnvironment(root)).toEqual(environment);
          expect(fixtureEnvironment(root + '-other').THREADNOTE_HOME).not.toBe(environment.THREADNOTE_HOME);
        }),
        {numRuns: 40},
      );
    } finally {
      if (previous === undefined) delete process.env.MANAGER_E2E_UNRELATED_SECRET;
      else process.env.MANAGER_E2E_UNRELATED_SECRET = previous;
    }
  });

  it('redacts disposable Manager URL and authorization tokens in diagnostics', () => {
    expect(redactManagerLog('http://127.0.0.1:1/?token=private Bearer private')).toBe(
      'http://127.0.0.1:1/?token=<redacted> Bearer <redacted>',
    );
  });
});
