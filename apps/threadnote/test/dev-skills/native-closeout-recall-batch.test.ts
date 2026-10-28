import {it} from '@effect/vitest';
import {Cause, Effect, Exit} from 'effect';
import {expect, vi} from 'vitest';
import {ResourceIoFailed, ResourceStore} from '@threadnote/store/resource-store';
import {nativeCloseoutFixture} from './native-closeout-fixture.js';
import {runCloseout} from './native-closeout-diagnostics.js';

// P0 Windows allowance for three real archive/recovery paths beyond 30s; revisit with performance data.
const windowsArchiveTimeout = process.platform === 'win32' ? {timeout: 120_000} : undefined;

const samples = vi.hoisted(() => ({
  refreshes: [] as {uris: readonly string[]; receipt: boolean}[],
  acknowledgements: [] as {uris: readonly string[]; inactive: boolean; succeeded: boolean}[],
}));
vi.mock('@threadnote/recall/mcp/refresh', async importOriginal => {
  const original = await importOriginal<typeof import('@threadnote/recall/mcp/refresh')>();
  return {
    ...original,
    refreshRecallDerivedIndexesAfterCanonicalMutation: (
      ...args: Parameters<typeof original.refreshRecallDerivedIndexesAfterCanonicalMutation>
    ) =>
      Effect.suspend(() => {
        samples.refreshes.push({uris: [...args[1]], receipt: args[2] !== undefined});
        return original.refreshRecallDerivedIndexesAfterCanonicalMutation(...args);
      }),
  };
});
vi.mock('@threadnote/store/resource/recall-invalidation', async importOriginal => {
  const original = await importOriginal<typeof import('@threadnote/store/resource/recall-invalidation')>();
  return {
    ...original,
    makeResourceRecallInvalidationObservation: (
      ...args: Parameters<typeof original.makeResourceRecallInvalidationObservation>
    ) => {
      const observation = original.makeResourceRecallInvalidationObservation(...args);
      return {
        ...observation,
        observer: {
          begin: (...beginArgs: Parameters<typeof observation.observer.begin>) => {
            const complete = observation.observer.begin(...beginArgs);
            return (succeeded: boolean) => {
              samples.acknowledgements.push({uris: [...beginArgs[1]], inactive: beginArgs[3], succeeded});
              complete(succeeded);
            };
          },
        },
      };
    },
  };
});

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object response.');
  return value as Record<string, unknown>;
};
const validationShape = (value: unknown) => {
  const result = object(value);
  return {
    phases: result.phases as readonly {id: string; acceptanceCriteria: readonly string[]}[],
    scenarios: result.scenarios as readonly {id: string}[],
    decisions: result.decisions as readonly {id: string; selected: string}[],
  };
};
const proposalFor = (value: unknown, includeCodeRefs = true) => {
  const input = validationShape(value);
  return {
    architecture: {
      summary: 'The implemented reader returns the complete saved result.',
      components: ['Reader', 'Store'],
      contracts: ['Preserve complete results.'],
      diagram: 'flowchart TD\n Reader --> Store',
      invariants: ['The reader returns every saved field.'],
      unknowns: ['The fixture does not measure production-scale load.'],
      deviations: [],
      codeRefs: includeCodeRefs ? ['source.ts'] : [],
    },
    architectureVerification: 'Inspected the committed source and exercised the complete read behavior.',
    combinedChecks: [
      {command: 'private combined fixture check', result: 'passed' as const, evidence: 'All fixture checks passed.'},
    ],
    phaseEvidence: input.phases.map(phase => ({
      id: phase.id,
      acceptance: phase.acceptanceCriteria.map(criterion => ({criterion, evidence: 'Observed ' + criterion})),
    })),
    scenarios: input.scenarios.map(scenario => ({
      id: scenario.id,
      evidence: 'Observed complete scenario ' + scenario.id,
    })),
    ...(input.scenarios.length > 0 ? {behaviorVerification: 'Verified each approved behavior scenario.'} : {}),
    decisions: input.decisions.map(item => ({
      id: item.id,
      implemented: item.selected,
      rationale: 'Applied the approved choice and preserved its complete rationale: ' + item.id,
    })),
  };
};

for (const outcome of ['success', 'lost-response', 'interrupted'] as const) {
  // prettier-ignore
  it.effect(`batches real owned archives and resumes ${outcome}`, () =>
    Effect.gen(function* () {
      const f = yield* nativeCloseoutFixture(false);
      const loaded = yield* f.load();
      const proposal = proposalFor(yield* f.closeout('validation-input'));
      yield* f.closeout('prepare', {proposal});
      expect(loaded.owned.length).toBeGreaterThan(1);
      const originalBodies = new Map<string, unknown>();
      for (const item of loaded.owned) {
        const response = object(yield* f.call({...f.base('read', item.runId), uri: item.uri}));
        originalBodies.set(item.uri, object(response.artifact).body);
      }
      samples.refreshes.length = 0;
      samples.acknowledgements.length = 0;
      const target = loaded.owned[1];
      let injected = false;
      const removed: string[] = [];
      const store = f.store;
      const intercepted = {
        ...store,
        remove: (...args: Parameters<typeof store.remove>) =>
          store.remove(...args).pipe(
            Effect.andThen(() => {
              removed.push(args[1]);
              if (outcome === 'success' || injected || args[1] !== target.uri) return Effect.void;
              injected = true;
              return outcome === 'interrupted'
                ? Effect.interrupt
                : Effect.fail(
                    ResourceIoFailed.make({
                      uri: args[1],
                      operation: 'write',
                      message: 'Lost batch archive response.',
                      cause: new Error('Lost batch archive response.'),
                    }),
                  );
            }),
          ),
      };
      const result = yield* f.closeout('finish').pipe(Effect.provideService(ResourceStore, intercepted), Effect.exit);
      const archiveRefreshes = () =>
        samples.refreshes.filter(sample => loaded.owned.some(item => sample.uris.includes(item.uri)));
      expect(archiveRefreshes()).toHaveLength(1);
      if (outcome === 'success') {
        expect(Exit.isSuccess(result)).toBe(true);
        if (!Exit.isSuccess(result)) throw new Error(Cause.pretty(result.cause));
        expect(object(result.value).closeout).toMatchObject({
          state: 'complete',
          archived: loaded.owned.length,
        });
        expect(removed).toEqual(loaded.owned.map(item => item.uri));
      } else {
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          if (outcome === 'interrupted') expect(Cause.hasInterrupts(result.cause)).toBe(true);
          else expect(Cause.pretty(result.cause)).toContain('Lost batch archive response.');
        }
        expect(injected).toBe(true);
        expect(removed).toEqual(loaded.owned.slice(0, 2).map(item => item.uri));
        expect(archiveRefreshes()[0].receipt).toBe(false);
        const partial = JSON.parse(yield* f.fs.readFileString(f.statePath(f.controllerRunId) + '.closeout.json')) as {
          status: string;
          archives: Record<string, unknown>;
        };
        expect(partial.status).toBe('archiving');
        expect(Object.keys(partial.archives)).toEqual([loaded.owned[0].uri]);
        const resumed = object(yield* f.closeout('finish'));
        expect(resumed.closeout).toMatchObject({state: 'complete', archived: loaded.owned.length});
      }
      // Observe acknowledgements from the actual prebuilt store, including both scopes.
      for (const item of loaded.owned) {
        for (const inactive of [false, true])
          expect(
            samples.acknowledgements.some(
              ack => ack.uris.includes(item.uri) && ack.inactive === inactive && ack.succeeded,
            ),
          ).toBe(true);
      }
      const complete = JSON.parse(yield* f.fs.readFileString(f.statePath(f.controllerRunId) + '.closeout.json')) as {
        archives: Record<string, {uri: string; memoryId: string; revision: string}>;
      };
      expect(Object.keys(complete.archives)).toHaveLength(loaded.owned.length);
      for (const item of loaded.owned) {
        const archive = complete.archives[item.uri];
        if (outcome === 'success') {
          expect(archiveRefreshes()[0].uris).toContain(archive.uri);
          for (const uri of [item.uri, archive.uri]) {
            expect(samples.acknowledgements.filter(ack => ack.uris.includes(uri))).toHaveLength(2);
          }
        }
        const response = object(yield* f.call({...f.base('read', item.runId), uri: archive.uri}));
        expect(object(response.artifact)).toMatchObject({
          uri: archive.uri,
          memoryId: item.memoryId,
          revision: archive.revision,
          state: 'archived',
          body: originalBodies.get(item.uri),
        });
      }
      const unrelated = object(yield* f.call({...f.base('read', 'plan-run'), uri: f.unrelated.uri}));
      expect(object(unrelated.artifact).state).toBe('active');
    }).pipe(runCloseout),
    windowsArchiveTimeout,
  );
}
