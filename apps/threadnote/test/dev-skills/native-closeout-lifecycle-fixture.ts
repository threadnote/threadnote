import {Effect, Array as EffectArray, Option as EffectOption} from 'effect';

import {expect} from 'vitest';

import {isJsonObject} from '@threadnote/platform/json';

import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';

import {decodeWorkflowJournal} from '../../src/workflow_memory/journal_codec.js';

import {decodeWorkflowJournalStorageImage} from '../../src/workflow_memory/journal_storage.js';

import {nativeCloseoutFixture} from './native-closeout-fixture.js';

import * as EffectRecord from 'effect/Record';

type Fixture = ReturnType<typeof nativeCloseoutFixture> extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;
export const object = (value: unknown): Record<string, unknown> => {
  if (!isJsonObject(value)) throw new Error('Expected an object response.');
  return value;
};
const objectArray = (value: unknown): Record<string, unknown>[] => {
  if (!EffectArray.isArray(value)) throw new Error('Expected an object array.');
  return EffectArray.map(value, object);
};
const stringArray = (value: unknown): string[] => {
  if (!EffectArray.isArray(value)) throw new Error('Expected a string array.');
  return EffectArray.map(value, item => {
    if (typeof item !== 'string') throw new Error('Expected a string.');
    return item;
  });
};
const artifactReferences = (value: unknown) =>
  EffectRecord.map(object(value), reference => ({
    memoryId: stringField(object(reference), 'memoryId'),
    revision: stringField(object(reference), 'revision'),
    uri: stringField(object(reference), 'uri'),
  }));
export const stringField = (value: Record<string, unknown>, key: string): string => {
  const field = value[key];
  if (typeof field !== 'string') throw new Error(`Expected string field ${key}.`);
  return field;
};
export const validationShape = (value: unknown) => {
  const result = object(value);
  return {
    phases: EffectArray.map(objectArray(result.phases), phase => ({
      id: stringField(phase, 'id'),
      acceptanceCriteria: stringArray(phase.acceptanceCriteria),
    })),
    scenarios: EffectArray.map(objectArray(result.scenarios), scenario => ({id: stringField(scenario, 'id')})),
    decisions: EffectArray.map(objectArray(result.decisions), decision => ({
      id: stringField(decision, 'id'),
      selected: stringField(decision, 'selected'),
    })),
  };
};
export const proposalFor = (value: unknown, includeCodeRefs = true) => {
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
    phaseEvidence: EffectArray.map(input.phases, phase => ({
      id: phase.id,
      acceptance: EffectArray.map(phase.acceptanceCriteria, criterion => ({
        criterion,
        evidence: 'Observed ' + criterion,
      })),
    })),
    scenarios: EffectArray.map(input.scenarios, scenario => ({
      id: scenario.id,
      evidence: 'Observed complete scenario ' + scenario.id,
    })),
    ...(input.scenarios.length > 0 ? {behaviorVerification: 'Verified each approved behavior scenario.'} : {}),
    decisions: EffectArray.map(input.decisions, item => ({
      id: item.id,
      implemented: item.selected,
      rationale: 'Applied the approved choice and preserved its complete rationale: ' + item.id,
    })),
  };
};
export const commandResult = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result);
export const assertOwnedState = (
  f: Fixture,
  items: readonly {runId: string; uri: string; revision: string}[],
  state: 'active' | 'archived',
) =>
  Effect.gen(function* () {
    for (const item of items) {
      const result = object(yield* f.call({...f.base('read', item.runId), uri: item.uri}));
      const artifact = object(result.artifact);
      expect(artifact.state).toBe(state);
      expect(artifact.uri).toBe(item.uri);
    }
  });
export const readArtifact = (f: Fixture, uri: string, runId = f.controllerRunId) =>
  Effect.gen(function* () {
    const response = object(yield* f.call({...f.base('read', runId), uri}));
    return object(response.artifact);
  });
export const relationTargets = (f: Fixture, uri: string, revision?: string) =>
  Effect.gen(function* () {
    const controller = yield* readNativeWorkflowState(f.config, f.controllerRunId);
    if (!controller) throw new Error('Expected controller run.');
    const bytes = yield* f.fs.readFileString(f.journalPath(controller.state.bindingId));
    const logical = yield* Effect.promise(() => decodeWorkflowJournal(bytes));
    const journal = object(decodeWorkflowJournalStorageImage(JSON.parse(logical)));
    const operations = EffectArray.map(EffectRecord.values(object(journal.operations)), object);
    const operation = EffectOption.getOrUndefined(
      EffectArray.findFirst(operations, item => {
        const artifact = object(item.artifact);
        return artifact.canonicalUri === uri && (revision === undefined || artifact.revision === revision);
      }),
    );
    if (!operation) throw new Error('Expected a verified operation for the readback artifact.');
    return EffectArray.map(objectArray(operation.relations), relation => stringField(relation, 'uri'));
  });
export const prepare = (f: Fixture) =>
  Effect.gen(function* () {
    const schema = object(yield* f.closeout('schema'));
    expect(schema.status).toBe('ok');
    expect(schema.schema).toBeDefined();
    const validation = yield* f.closeout('validation-input');
    const proposal = proposalFor(validation);
    const result = yield* f.closeout('prepare', {proposal});
    return {proposal, result, validation};
  });
export const journalImage = (f: Fixture) =>
  Effect.gen(function* () {
    const state = yield* readNativeWorkflowState(f.config, f.controllerRunId);
    if (!state) throw new Error('Expected controller run.');
    const file = f.statePath(f.controllerRunId) + '.closeout.json';
    const image = object(JSON.parse(yield* f.fs.readFileString(file)));
    return {
      archives: artifactReferences(image.archives),
      outputs: artifactReferences(image.outputs),
      status: stringField(image, 'status'),
    };
  });
export const windowsCloseoutTimeout = process.platform === 'win32' ? {timeout: 120_000} : undefined;
