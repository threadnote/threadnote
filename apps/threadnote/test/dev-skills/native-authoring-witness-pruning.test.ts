import {it} from '@effect/vitest';
import {Effect, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, vi} from 'vitest';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

interface WitnessSample {
  readonly bindingId: string;
  readonly verifiedReceipts: number;
  readonly mapComparisonInputs: number;
  artifactInputs: number;
  invalidJournalErrors: number;
}
const observed = vi.hoisted(() => ({
  enabled: false,
  active: undefined as WitnessSample | undefined,
  samples: [] as WitnessSample[],
}));
vi.mock('../../src/workflow_memory/protocol.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/workflow_memory/protocol.js')>();
  return {
    ...original,
    stableJson: (value: unknown) => {
      if (
        observed.active &&
        value !== null &&
        typeof value === 'object' &&
        'canonicalUri' in value &&
        'artifactKey' in value &&
        'revision' in value
      )
        observed.active.artifactInputs++;
      return original.stableJson(value);
    },
    workflowError: (...args: Parameters<typeof original.workflowError>) => {
      if (observed.active && args[0] === 'invalid-journal') observed.active.invalidJournalErrors++;
      return original.workflowError(...args);
    },
  };
});
vi.mock('../../src/workflow_memory/journal_validation.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/workflow_memory/journal_validation.js')>();
  const {parseMemoryDocument} = await import('@threadnote/memory/document');
  return {
    ...original,
    assertWorkflowJournalIntegrity: (...args: Parameters<typeof original.assertWorkflowJournalIntegrity>) => {
      const [state, current] = args;
      if (
        !observed.enabled ||
        current === undefined ||
        state.manifestCommitted ||
        current === state.manifestContent ||
        current !== state.previousManifestContent ||
        Object.values(state.operations).some(operation => operation.deferredCodeAnchor !== undefined)
      )
        return original.assertWorkflowJournalIntegrity(...args);
      // Real live manifest input, observed only. No replacement state or proof outcome is supplied.
      const memory = parseMemoryDocument(state.manifestUri, current);
      if (!memory) throw new Error('Expected an actual previous manifest');
      const previous = JSON.parse(memory.body) as {artifacts: Record<string, unknown>};
      const sample: WitnessSample = {
        bindingId: state.binding.bindingId,
        verifiedReceipts: Object.values(state.operations).filter(operation => operation.status === 'verified').length,
        mapComparisonInputs: Object.keys(previous.artifacts).length + Object.keys(state.artifacts).length,
        artifactInputs: 0,
        invalidJournalErrors: 0,
      };
      const prior = observed.active;
      observed.active = sample;
      try {
        const result = original.assertWorkflowJournalIntegrity(...args);
        observed.samples.push(sample);
        return result;
      } finally {
        observed.active = prior;
      }
    },
  };
});

const written = Schema.Struct({artifact: Schema.Struct({uri: Schema.String, memoryId: Schema.String})});
it.effect('bounds witness comparisons after real named history without crossing same-store homes', () =>
  Effect.gen(function* () {
    observed.enabled = false;
    observed.samples.length = 0;
    const first = yield* nativeFixture();
    const initialized = yield* first.init();
    const history: string[] = [];
    let firstMemoryId: string | undefined;
    for (let index = 0; index < 6; index++) {
      const saved = yield* Schema.decodeUnknownEffect(written)(
        yield* first.call(
          first.write({
            operationId: `history-${index}`,
            artifactKey: `history-${index}`,
            body: `Verified history ${index}.\n`,
          }),
        ),
      );
      history.push(saved.artifact.uri);
      firstMemoryId ??= saved.artifact.memoryId;
    }
    const second = yield* nativeFixture();
    yield* second.init();
    const other = yield* Schema.decodeUnknownEffect(written)(
      yield* second.call(
        second.write({
          operationId: 'history-0',
          artifactKey: 'history-0',
          body: 'Verified history 0.\n',
        }),
      ),
    );
    expect(first.store).toBe(second.store);
    expect(other.artifact.uri).toBe(history[0]);
    expect(other.artifact.memoryId).not.toBe(firstMemoryId);
    const firstRead = yield* Schema.decodeUnknownEffect(written)(
      yield* first.call({...first.base('read'), uri: history[0]}),
    );
    const secondRead = yield* Schema.decodeUnknownEffect(written)(
      yield* second.call({...second.base('read'), uri: history[0]}),
    );
    expect(firstRead.artifact.memoryId).toBe(firstMemoryId);
    expect(secondRead.artifact.memoryId).toBe(other.artifact.memoryId);
    observed.enabled = true;
    const added = yield* first
      .call(
        first.write({
          operationId: 'new-destination',
          artifactKey: 'new-destination',
          body: 'A new canonical destination.\n',
        }),
      )
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            observed.enabled = false;
          }),
        ),
      );
    const current = yield* Schema.decodeUnknownEffect(written)(added);
    expect(history).not.toContain(current.artifact.uri);
    expect(current.artifact.uri).toMatch(/-v7\.md$/u);
    expect(observed.samples.length).toBeGreaterThan(0);
    for (const sample of observed.samples) {
      expect(sample.bindingId).toBe(initialized.bindingId);
      expect(sample.verifiedReceipts).toBeGreaterThanOrEqual(7);
      // Complete old/new map comparison remains; only the new receipt adds one equality pair.
      expect(sample.artifactInputs).toBe(sample.mapComparisonInputs + 2);
      expect(sample.invalidJournalErrors).toBe(0);
    }
  }).pipe(TestClock.withLive, provideNative),
);
