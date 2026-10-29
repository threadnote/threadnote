import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_JSON_PROGRESS_INTERVAL_MILLISECONDS,
  codeGraphJsonProgressDecision,
  type CodeGraphJsonProgressState,
} from '@threadnote/graph/json_progress';
import type {CodeGraphProgress} from '@threadnote/graph/types';

describe('code graph JSON progress coalescing', () => {
  it('emits the first observation, periodic liveness, and terminal progress while coalescing a hot stream', () => {
    let state: CodeGraphJsonProgressState = {};
    const emitted: Array<Extract<CodeGraphProgress, {readonly phase: 'scanning'}>> = [];
    for (let completed = 0; completed <= 100_000; completed += 1) {
      const progress = scanning(completed, 100_000, 'extracting');
      const decision = codeGraphJsonProgressDecision(state, progress, completed);
      state = decision.state;
      if (decision.emit) emitted.push(progress);
    }

    expect(emitted).toHaveLength(51);
    expect(emitted[0]).toMatchObject({completed: 0, phase: 'scanning'});
    expect(emitted.at(-1)).toMatchObject({completed: 100_000, phase: 'scanning'});
    expect(EffectArray.every(emitted.slice(1, -1), progress => progress.completed % 2_000 === 0)).toBe(true);
  });

  it('bounds an adversarial stream that alternates previously observed substages', () => {
    let state: CodeGraphJsonProgressState = {};
    let emissionCount = 0;
    for (let observation = 0; observation <= 100_000; observation += 1) {
      const progress = materializing(observation % 2 === 0 ? 'writing-symbols' : 'writing-lookups');
      const decision = codeGraphJsonProgressDecision(state, progress, observation);
      state = decision.state;
      if (decision.emit) emissionCount += 1;
    }

    expect(emissionCount).toBeLessThanOrEqual(52);
  });

  it('preserves phase and substage transitions without waiting for the liveness interval', () => {
    const events: readonly CodeGraphProgress[] = [
      {phase: 'registering'},
      {
        activity: {elapsedMilliseconds: 250, generations: 2, keys: 400, stage: 'loading-cache'},
        phase: 'registering',
      },
      {phase: 'waiting', reason: 'repository-lock'},
      {phase: 'waiting', reason: 'database-writer'},
      scanning(0, 10),
      {completed: 0, pagesCompleted: 0, phase: 'reclaiming', rowsDeleted: 0, total: 1, unit: 'snapshots'},
      scanning(0, 10, 'reading'),
      scanning(0, 10, 'extracting'),
      materializing('loading-cache'),
      materializing('attributing'),
      {phase: 'resolving', subphase: 'references'},
      {edges: 4, phase: 'resolving', resolved: 2, subphase: 'complete', symbols: 3},
      {phase: 'activating', snapshotId: 'snapshot', subphase: 'validating-input'},
      {phase: 'activating', snapshotId: 'snapshot', subphase: 'writing-and-checkpointing'},
      {phase: 'activating', snapshotId: 'snapshot', subphase: 'promoting'},
      {phase: 'activating', snapshotId: 'snapshot', subphase: 'structural-ready'},
      {phase: 'activating', snapshotId: 'snapshot', subphase: 'complete'},
      {completed: 0, embedded: 0, phase: 'embedding', reused: 0, total: 1, unit: 'symbols'},
      {phase: 'sharing', subphase: 'discovering-shared-base'},
      {phase: 'sharing', subphase: 'downloading-checkpoint'},
      {phase: 'sharing', subphase: 'applying-deltas'},
      {phase: 'sharing', subphase: 'building-local-overlay'},
    ];
    let state: CodeGraphJsonProgressState = {};

    for (const progress of events) {
      const decision = codeGraphJsonProgressDecision(state, progress, 0);
      expect(decision.emit).toBe(true);
      state = decision.state;
    }
  });

  it('suppresses duplicate terminal callbacks but emits a terminal callback immediately', () => {
    const before = codeGraphJsonProgressDecision({}, scanning(99, 100), 0);
    const terminal = codeGraphJsonProgressDecision(before.state, scanning(100, 100), 1);
    const duplicate = codeGraphJsonProgressDecision(terminal.state, scanning(100, 100), 2);

    expect(before.emit).toBe(true);
    expect(terminal.emit).toBe(true);
    expect(duplicate.emit).toBe(false);
  });

  it('emits reclamation liveness and completion without inventing an ETA', () => {
    const started = codeGraphJsonProgressDecision(
      {},
      {completed: 0, pagesCompleted: 0, phase: 'reclaiming', rowsDeleted: 0, total: 1, unit: 'snapshots'},
      0,
    );
    const page = codeGraphJsonProgressDecision(
      started.state,
      {completed: 0, pagesCompleted: 1, phase: 'reclaiming', rowsDeleted: 5_000, total: 1, unit: 'snapshots'},
      CODE_GRAPH_JSON_PROGRESS_INTERVAL_MILLISECONDS,
    );
    const complete = codeGraphJsonProgressDecision(
      page.state,
      {completed: 1, pagesCompleted: 2, phase: 'reclaiming', rowsDeleted: 5_001, total: 1, unit: 'snapshots'},
      CODE_GRAPH_JSON_PROGRESS_INTERVAL_MILLISECONDS + 1,
    );

    expect(started.emit).toBe(true);
    expect(page.emit).toBe(true);
    expect(complete.emit).toBe(true);
  });

  it('re-establishes liveness if the wall clock moves backward', () => {
    const first = codeGraphJsonProgressDecision({}, scanning(1, 10), 10_000);
    const rollback = codeGraphJsonProgressDecision(first.state, scanning(2, 10), 9_000);
    const suppressed = codeGraphJsonProgressDecision(rollback.state, scanning(3, 10), 9_001);
    const periodic = codeGraphJsonProgressDecision(
      suppressed.state,
      scanning(4, 10),
      9_000 + CODE_GRAPH_JSON_PROGRESS_INTERVAL_MILLISECONDS,
    );

    expect(rollback.emit).toBe(true);
    expect(suppressed.emit).toBe(false);
    expect(periodic.emit).toBe(true);
  });
});

function scanning(
  completed: number,
  total: number,
  stage?: 'extracting' | 'persisting' | 'reading',
): Extract<CodeGraphProgress, {readonly phase: 'scanning'}> {
  return {
    accepted: completed,
    ...(stage === undefined
      ? {}
      : {
          activity: {
            batchCompleted: completed,
            batchTotal: total,
            bytes: 10,
            language: 'typescript',
            path: 'src/example.ts',
            stage,
          },
        }),
    completed,
    excluded: 0,
    phase: 'scanning',
    skipped: 0,
    total,
    unit: 'files',
  };
}

function materializing(
  stage: 'attributing' | 'loading-cache' | 'writing-lookups' | 'writing-symbols',
): Extract<CodeGraphProgress, {readonly phase: 'materializing'}> {
  return {
    activity: {
      batchCompleted: 0,
      batchTotal: 1,
      sourceBytes: 10,
      stage,
    },
    completed: 0,
    phase: 'materializing',
    reused: 0,
    total: 1,
    unit: 'files',
  };
}
