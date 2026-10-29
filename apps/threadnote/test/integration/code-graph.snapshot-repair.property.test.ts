import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {Effect, Path} from 'effect';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {repairCodeGraphIndexes} from '@threadnote/graph/maintenance';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphSnapshot, RepositoryIdentity} from '@threadnote/graph/types';
import {runEffect} from '../helpers/effect-runtime.js';

type IncompleteState = 'building' | 'failed';

interface SnapshotModel {
  readonly incomplete: Map<number, IncompleteState>;
  readonly secondary: Map<number, {leased: boolean; state: 'failed' | 'ready'}>;
}

interface SnapshotReal {
  readonly baseline: CodeGraphSnapshot;
  readonly databasePath: string;
  readonly home: string;
  readonly identity: RepositoryIdentity;
  readonly leaseTokens: Map<number, string>;
}

class AddBuildingCommand implements FC.AsyncCommand<SnapshotModel, SnapshotReal, false> {
  constructor(readonly slot: number) {}

  check(model: Readonly<SnapshotModel>): boolean {
    return !model.incomplete.has(this.slot);
  }

  async run(model: SnapshotModel, real: SnapshotReal): Promise<void> {
    const id = snapshotId(real, this.slot);
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.markBuilding(real.databasePath, real.identity, {
          ...real.baseline,
          id,
          state: 'building',
        });
      }),
    );
    model.incomplete.set(this.slot, 'building');
    await assertRealMatchesModel(model, real);
  }

  toString(): string {
    return `addBuilding(${this.slot})`;
  }
}

class FailBuildingCommand implements FC.AsyncCommand<SnapshotModel, SnapshotReal, false> {
  constructor(readonly slot: number) {}

  check(model: Readonly<SnapshotModel>): boolean {
    return model.incomplete.get(this.slot) === 'building';
  }

  async run(model: SnapshotModel, real: SnapshotReal): Promise<void> {
    const id = snapshotId(real, this.slot);
    const summary = `property failure ${this.slot}`;
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.markFailed(real.databasePath, id, summary);
      }),
    );
    model.incomplete.set(this.slot, 'failed');
    await assertRealMatchesModel(model, real);
  }

  toString(): string {
    return `failBuilding(${this.slot})`;
  }
}

class RepairCommand implements FC.AsyncCommand<SnapshotModel, SnapshotReal, false> {
  constructor(readonly dryRun: boolean) {}

  check(): boolean {
    return true;
  }

  async run(model: SnapshotModel, real: SnapshotReal): Promise<void> {
    const expectedRemovable =
      model.incomplete.size +
      EffectArray.filter([...model.secondary.values()], snapshot => snapshot.state === 'failed' && !snapshot.leased)
        .length;
    const summary = await runEffect(repairCodeGraphIndexes(real.home, this.dryRun));
    expect(summary).toMatchObject({
      databases: 1,
      deferredDatabases: 0,
      discarded: 0,
      removedIncompleteSnapshots: expectedRemovable,
    });
    if (!this.dryRun) {
      model.incomplete.clear();
      for (const [slot, snapshot] of model.secondary) {
        if (snapshot.state === 'failed' && !snapshot.leased) model.secondary.delete(slot);
      }
    }
    await assertRealMatchesModel(model, real);
  }

  toString(): string {
    return `repair(${this.dryRun ? 'dry-run' : 'apply'})`;
  }
}

class ObserveCommand implements FC.AsyncCommand<SnapshotModel, SnapshotReal, false> {
  check(): boolean {
    return true;
  }

  async run(model: SnapshotModel, real: SnapshotReal): Promise<void> {
    await assertRealMatchesModel(model, real);
  }

  toString(): string {
    return 'observe()';
  }
}

class AddReadyCommand implements FC.AsyncCommand<SnapshotModel, SnapshotReal, false> {
  constructor(readonly slot: number) {}

  check(model: Readonly<SnapshotModel>): boolean {
    return !model.secondary.has(this.slot);
  }

  async run(model: SnapshotModel, real: SnapshotReal): Promise<void> {
    const id = readySnapshotId(real, this.slot);
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(
          real.databasePath,
          real.identity,
          {
            ...real.baseline,
            edgeCount: 0,
            fileCount: 0,
            id,
            state: 'ready',
            symbolCount: 0,
          },
          [],
          [],
          [],
        );
      }),
    );
    model.secondary.set(this.slot, {leased: false, state: 'ready'});
    await assertRealMatchesModel(model, real);
  }

  toString(): string {
    return `addReady(${this.slot})`;
  }
}

class AcquireLeaseCommand implements FC.AsyncCommand<SnapshotModel, SnapshotReal, false> {
  constructor(readonly slot: number) {}

  check(model: Readonly<SnapshotModel>): boolean {
    const snapshot = model.secondary.get(this.slot);
    return snapshot?.state === 'ready' && !snapshot.leased;
  }

  async run(model: SnapshotModel, real: SnapshotReal): Promise<void> {
    const id = readySnapshotId(real, this.slot);
    const token = await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        return yield* store.acquireSnapshotLease(real.databasePath, id, 60_000);
      }),
    );
    real.leaseTokens.set(this.slot, token);
    model.secondary.set(this.slot, {leased: true, state: 'ready'});
    await assertRealMatchesModel(model, real);
  }

  toString(): string {
    return `acquireLease(${this.slot})`;
  }
}

class ReleaseLeaseCommand implements FC.AsyncCommand<SnapshotModel, SnapshotReal, false> {
  constructor(readonly slot: number) {}

  check(model: Readonly<SnapshotModel>): boolean {
    return model.secondary.get(this.slot)?.leased === true;
  }

  async run(model: SnapshotModel, real: SnapshotReal): Promise<void> {
    const token = real.leaseTokens.get(this.slot);
    if (token === undefined) throw TestError.make({message: `Model lease ${this.slot} has no real token.`});
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.releaseSnapshotLease(real.databasePath, token);
      }),
    );
    real.leaseTokens.delete(this.slot);
    const current = model.secondary.get(this.slot)!;
    model.secondary.set(this.slot, {leased: false, state: current.state});
    await assertRealMatchesModel(model, real);
  }

  toString(): string {
    return `releaseLease(${this.slot})`;
  }
}

class FailReadyCommand implements FC.AsyncCommand<SnapshotModel, SnapshotReal, false> {
  constructor(readonly slot: number) {}

  check(model: Readonly<SnapshotModel>): boolean {
    return model.secondary.get(this.slot)?.state === 'ready';
  }

  async run(model: SnapshotModel, real: SnapshotReal): Promise<void> {
    const id = readySnapshotId(real, this.slot);
    const summary = `property ready failure ${this.slot}`;
    await runEffect(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.markFailed(real.databasePath, id, summary);
      }),
    );
    // A late peer failure is allowed to transition only a building snapshot.
    // Ready receipts stay committed regardless of whether a reader lease exists.
    await assertRealMatchesModel(model, real);
  }

  toString(): string {
    return `failReady(${this.slot})`;
  }
}

class InjectLegacyFailedLeaseCommand implements FC.AsyncCommand<SnapshotModel, SnapshotReal, false> {
  constructor(readonly slot: number) {}

  check(model: Readonly<SnapshotModel>): boolean {
    const snapshot = model.secondary.get(this.slot);
    return snapshot?.leased === true && snapshot.state === 'ready';
  }

  async run(model: SnapshotModel, real: SnapshotReal): Promise<void> {
    const database = new Database(real.databasePath);
    try {
      database.query("UPDATE snapshots SET state = 'failed' WHERE id = ?").run(readySnapshotId(real, this.slot));
    } finally {
      database.close();
    }
    model.secondary.set(this.slot, {leased: true, state: 'failed'});
    await assertRealMatchesModel(model, real);
  }

  toString(): string {
    return `injectLegacyFailedLease(${this.slot})`;
  }
}

const commandArbitraries: readonly FC.Arbitrary<FC.AsyncCommand<SnapshotModel, SnapshotReal, false>>[] = [
  FC.integer({max: 4, min: 0}).map(slot => new AddBuildingCommand(slot)),
  FC.integer({max: 4, min: 0}).map(slot => new FailBuildingCommand(slot)),
  FC.integer({max: 4, min: 0}).map(slot => new AddReadyCommand(slot)),
  FC.integer({max: 4, min: 0}).map(slot => new AcquireLeaseCommand(slot)),
  FC.integer({max: 4, min: 0}).map(slot => new ReleaseLeaseCommand(slot)),
  FC.integer({max: 4, min: 0}).map(slot => new FailReadyCommand(slot)),
  FC.integer({max: 4, min: 0}).map(slot => new InjectLegacyFailedLeaseCommand(slot)),
  FC.boolean().map(dryRun => new RepairCommand(dryRun)),
  FC.constant(new ObserveCommand()),
];

const commandSequenceArbitrary = FC.commands([...commandArbitraries], {maxCommands: 14});

describe('SQLite code graph snapshot repair properties', () => {
  fcEffectProp(
    it,
    'matches a snapshot-state model across arbitrary interrupted builds, failures, observations, and repairs',
    {commands: commandSequenceArbitrary},
    ({commands}) =>
      Effect.promise(async () => {
        const root = createRepository();
        const home = join(root, '.threadnote-test-home');
        try {
          const setup = await runEffect(
            Effect.gen(function* () {
              const indexer = yield* CodeGraphIndexer;
              const path = yield* Path.Path;
              const indexed = yield* indexer.index({cwd: root, threadnoteHome: home});
              return {
                databasePath: codeGraphLayout(path, home, indexed.identity.checkoutId, indexed.identity.worktreeId)
                  .databasePath,
                indexed,
              };
            }),
          );
          const real: SnapshotReal = {
            baseline: setup.indexed.snapshot,
            databasePath: setup.databasePath,
            home,
            identity: setup.indexed.identity,
            leaseTokens: new Map(),
          };
          const model: SnapshotModel = {incomplete: new Map(), secondary: new Map()};
          await FC.asyncModelRun(
            () => ({model, real}),
            [
              ...commands,
              new AddBuildingCommand(98),
              new FailBuildingCommand(98),
              new RepairCommand(true),
              new RepairCommand(false),
              new AddReadyCommand(97),
              new FailReadyCommand(97),
              new RepairCommand(false),
              new AddReadyCommand(99),
              new AcquireLeaseCommand(99),
              new FailReadyCommand(99),
              new RepairCommand(false),
              new InjectLegacyFailedLeaseCommand(99),
              new RepairCommand(true),
              new RepairCommand(false),
              new ReleaseLeaseCommand(99),
              new RepairCommand(false),
            ],
          );
          await assertRealMatchesModel(model, real);
        } finally {
          rmSync(root, {force: true, recursive: true});
        }
      }),
    {
      // Full-suite SQLite contention can push the hosted runtime past twice
      // the isolated duration. Keep all 12 deterministic runs while retaining
      // a bounded failure instead of racing the 90-second ceiling.
      fastCheck: {interruptAfterTimeLimit: 120_000, markInterruptAsFailure: true, numRuns: 12},
      timeout: 130_000,
    },
  );
});

async function assertRealMatchesModel(model: Readonly<SnapshotModel>, real: SnapshotReal): Promise<void> {
  const health = await runEffect(
    Effect.gen(function* () {
      const store = yield* CodeGraphStore;
      const diagnosed = yield* store.diagnose(real.databasePath);
      const ready = yield* store.readySnapshot(real.databasePath, real.identity.worktreeId);
      const graph = yield* store.loadGraph(real.databasePath, real.baseline.id);
      return {diagnosed, graph, ready};
    }),
  );
  const expectedStates = [...model.incomplete.values()];
  const secondary = [...model.secondary.values()];
  expect(health.diagnosed).toMatchObject({
    activeSnapshots: 1,
    buildingSnapshots: EffectArray.filter(expectedStates, state => state === 'building').length,
    failedSnapshots:
      EffectArray.filter(expectedStates, state => state === 'failed').length +
      EffectArray.filter(secondary, snapshot => snapshot.state === 'failed').length,
    foreignKeyViolations: 0,
    integrity: 'ok',
    readySnapshots: 1 + EffectArray.filter(secondary, snapshot => snapshot.state === 'ready').length,
  });
  expect(health.ready?.id).toBe(real.baseline.id);
  expect(health.graph.snapshot.id).toBe(real.baseline.id);

  const database = new Database(real.databasePath, {readonly: true});
  try {
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(database.query('SELECT id, state FROM snapshots ORDER BY id').all()).toEqual(
      [
        {id: real.baseline.id, state: 'ready'},
        ...EffectArray.map([...model.incomplete], ([slot, state]) => ({id: snapshotId(real, slot), state})),
        ...EffectArray.map([...model.secondary], ([slot, snapshot]) => ({
          id: readySnapshotId(real, slot),
          state: snapshot.state,
        })),
      ].sort((left, right) => compareText(left.id, right.id)),
    );
    expect(database.query('SELECT snapshot_id FROM active_snapshots').all()).toEqual([{snapshot_id: real.baseline.id}]);
    expect(database.query('SELECT token, snapshot_id FROM snapshot_leases ORDER BY token').all()).toEqual(
      EffectArray.map(
        EffectArray.filter([...model.secondary], ([, snapshot]) => snapshot.leased),
        ([slot]) => ({
          snapshot_id: readySnapshotId(real, slot),
          token: real.leaseTokens.get(slot),
        }),
      ).sort((left, right) => compareText(left.token ?? '', right.token ?? '')),
    );
  } finally {
    database.close();
  }
}

function snapshotId(real: SnapshotReal, slot: number): string {
  return `${real.baseline.id}-property-${slot}`;
}

function readySnapshotId(real: SnapshotReal, slot: number): string {
  return `${real.baseline.id}-ready-property-${slot}`;
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-repair-property-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, 'src', 'service.ts'), 'export function service(): string { return "ready"; }\n');
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '-qm',
    'property fixture',
  ]);
  return root;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}
