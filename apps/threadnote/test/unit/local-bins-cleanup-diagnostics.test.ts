import {reportLocalBinsCleanupFailure, type LocalBinsCleanupFacts} from '../helpers/local-bins-cleanup-diagnostics.js';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';

const cleanupFacts: LocalBinsCleanupFacts = {
  coordinatorExitWaitCompleted: true,
  coordinatorPid: 1234,
  coordinatorPidWasRunning: true,
  endpointRead: 'present',
  terminationOutcome: 'tree-kill-returned',
};

describe('local bins cleanup diagnostics', () => {
  it('emits only bounded cleanup facts and rethrows the original error', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (pathSuffix, message) => {
        const cause = Object.assign(new Error(`private-${message} at C:\\fixture\\${pathSuffix}`), {code: 'EACCES'});
        let output = '';
        let caught: unknown;
        try {
          reportLocalBinsCleanupFailure(cause, cleanupFacts, line => {
            output = line;
          });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBe(cause);
        expect(JSON.parse(output)).toEqual({
          event: 'local-bins-cleanup-failure',
          stage: 'remove-temporary-root',
          errorCode: 'OTHER',
          ...cleanupFacts,
        });
        expect(output).not.toContain(`private-${message}`);
        expect(output).not.toContain(`C:\\fixture\\${pathSuffix}`);
      }),
      {numRuns: 100},
    );
  });

  it('preserves the cleanup error if the diagnostic sink throws', () => {
    const cause = Object.assign(new Error('private cleanup failure'), {code: 'EBUSY'});
    let caught: unknown;
    try {
      reportLocalBinsCleanupFailure(cause, cleanupFacts, () => {
        throw new Error('diagnostic sink failure');
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(cause);
  });
});
