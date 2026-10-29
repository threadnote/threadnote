import {Array as EffectArray, Option as EffectOption} from 'effect';
import {
  assertStage3,
  scanStage3Observations,
  stage3Record,
  stage3Refresh,
  type Stage3Observation,
  type Stage3Phase,
} from './code-graph-stage3-contract.js';
import {Stage3Driver, type Stage3Host, type Stage3Lock, type Stage3Worktree} from './code-graph-stage3-driver.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

type GraphOperation = NonNullable<Stage3Observation['operation']>;
const discovery: readonly GraphOperation[] = ['query', 'node', 'neighbors', 'explain'];

function nodes(data: Record<string, unknown>) {
  assertStage3(EffectArray.isArray(data.nodes), 'graph-nodes');
  return EffectArray.map(data.nodes, stage3Record);
}

function selectors(operation: GraphOperation, entry: string, leaf: string) {
  switch (operation) {
    case 'query':
      return {operation, query: 'stage3Entry'};
    case 'node':
      return {operation, nodeId: entry};
    case 'neighbors':
      return {operation, nodeId: entry, direction: 'outgoing'};
    case 'explain':
      return {operation, symbol: 'stage3Entry'};
    case 'path':
      return {operation, from: entry, to: leaf};
    case 'impact':
      return {operation, query: 'stage3Leaf'};
  }
}

/** Strict reads may return only their typed state envelope, never stale graph evidence. */
export function assertStage3StrictStateEnvelope(operation: 'path' | 'impact', value: unknown) {
  const response = stage3Record(value);
  const state = response.state;
  const type = response.type;
  assertStage3(state === 'indexing' || state === 'deferred' || state === 'timed-out', 'strict-state');
  assertStage3(
    response.operation === operation &&
      ((state === 'timed-out' && type === 'code-graph-query-state') ||
        ((state === 'indexing' || state === 'deferred') && type === 'code-graph-index-state')) &&
      typeof response.version === 'number' &&
      Number.isSafeInteger(response.version) &&
      response.version > 0,
    'strict-state-envelope',
  );
  const allowed =
    state === 'indexing'
      ? new Set([
          'operation',
          'phase',
          'progress',
          'refresh',
          'retryAfterMilliseconds',
          'state',
          'timing',
          'type',
          'version',
        ])
      : state === 'deferred'
        ? new Set(['failure', 'operation', 'refresh', 'state', 'type', 'version'])
        : new Set(['operation', 'retryAfterMilliseconds', 'state', 'type', 'version']);
  assertStage3(
    EffectArray.every(EffectRecord.keys(response), key => allowed.has(key)),
    'strict-stale-leak',
  );
  return state;
}

async function anchors(driver: Stage3Driver, host: Stage3Host, tree: Stage3Worktree) {
  const response = await driver.call(host, tree, {operation: 'query', query: 'stage3'});
  const entry = EffectOption.getOrUndefined(
    EffectArray.findFirst(nodes(response), node => node.name === 'stage3Entry'),
  )?.id;
  const leaf = EffectOption.getOrUndefined(
    EffectArray.findFirst(nodes(response), node => node.name === 'stage3Leaf'),
  )?.id;
  const snapshot = stage3Record(response.snapshot).id;
  assertStage3(typeof entry === 'string' && typeof leaf === 'string' && typeof snapshot === 'string', 'seed-anchors');
  return {entry, leaf, snapshot};
}

async function adopted(driver: Stage3Driver, tree: Stage3Worktree, ownerHost: Stage3Host, lock: Stage3Lock) {
  return driver.until(async () => {
    driver.held(lock);
    const demand = await driver.demand(tree);
    const active = demand?.active;
    if (!active || active.phase === 'claimed' || active.claimOwner?.processId === ownerHost.processId) return undefined;
    const status = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        await driver.statuses(tree),
        candidate =>
          candidate.request?.key === active.targetKey &&
          candidate.owner.processId === active.claimOwner?.processId &&
          candidate.observation.liveness === 'active',
      ),
    );
    return status?.phase === 'waiting' && status.subphase === 'database-writer' ? {active, status} : undefined;
  }, 'adoption-not-observed');
}

async function current(
  driver: Stage3Driver,
  host: Stage3Host,
  tree: Stage3Worktree,
  key: string,
  target: string,
  entry: string,
  leaf: string,
) {
  // Read sidecars between bounded MCP retries; never use sidecar intent as ready authority.
  let nextRequest = 0;
  const ready = await driver.until(async () => {
    const statuses = await driver.statuses(tree);
    const completed = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        statuses,
        status =>
          status.request?.key === key && status.observation.liveness === 'completed' && status.result !== undefined,
      ),
    );
    const demand = await driver.demand(tree);
    if (completed && !demand?.active && !demand?.desired) return completed;
    if (Date.now() >= nextRequest) {
      const response = await driver.call(host, tree, {operation: 'query', query: 'stage3Entry'});
      const refresh = response.refresh === undefined ? undefined : stage3Refresh(response.refresh);
      nextRequest = Date.now() + Math.max(1_000, refresh?.retryAfterMilliseconds ?? 1_000);
    }
    return undefined;
  }, 'latest-target-not-current');
  const exact = await driver.call(host, tree, selectors('path', entry, leaf));
  assertStage3(exact.type === 'code-graph-inspection' && exact.freshness === 'current', 'final-strict-current');
  assertStage3(stage3Record(exact.snapshot).id === ready.result?.snapshotId, 'final-snapshot-binding');
  assertStage3(
    EffectArray.some(nodes(exact), node => node.id === entry) &&
      EffectArray.some(nodes(exact), node => node.id === leaf),
    'final-path-evidence',
  );
  const query = await driver.call(host, tree, {
    operation: 'query',
    query: `stage3Target_${Effect.pipe(target, EffectString.replaceAll('-', '_'))}`,
  });
  assertStage3(stage3Record(query.snapshot).id === ready.result?.snapshotId, 'final-query-binding');
  assertStage3(
    EffectArray.some(
      nodes(query),
      node => node.name === `stage3Target_${Effect.pipe(target, EffectString.replaceAll('-', '_'))}`,
    ),
    'final-target-evidence',
  );
  return ready;
}

async function primeBackgroundRefreshEligibility(
  driver: Stage3Driver,
  host: Stage3Host,
  tree: Stage3Worktree,
  entry: string,
  leaf: string,
) {
  await driver.change(tree, 'eligibility');
  const exact = await driver.until(async () => {
    const response = await driver.call(host, tree, selectors('path', entry, leaf));
    return response.type === 'code-graph-inspection' && response.freshness === 'current' ? response : undefined;
  }, 'eligibility-prime-not-current');
  const snapshot = stage3Record(exact.snapshot).id;
  assertStage3(typeof snapshot === 'string', 'eligibility-prime-snapshot');
  assertStage3(
    EffectArray.some(nodes(exact), node => node.id === entry) &&
      EffectArray.some(nodes(exact), node => node.id === leaf),
    'eligibility-prime-path-evidence',
  );
  const query = await driver.call(host, tree, {operation: 'query', query: 'stage3Target_eligibility'});
  assertStage3(stage3Record(query.snapshot).id === snapshot, 'eligibility-prime-query-binding');
  assertStage3(
    EffectArray.some(nodes(query), node => node.name === 'stage3Target_eligibility'),
    'eligibility-prime-target-evidence',
  );
  const status = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      await driver.statuses(tree),
      candidate => candidate.observation.liveness === 'completed' && candidate.result?.snapshotId === snapshot,
    ),
  );
  assertStage3(status?.result?.overlayAssessment?.outcome === 'overlay-success', 'eligibility-prime-assessment');
  return snapshot;
}

export async function runStage3Scenarios(driver: Stage3Driver) {
  const observations: Stage3Observation[] = [];
  const [seed, churn, recovery] = driver.worktrees;
  assertStage3(seed && churn && recovery, 'three-worktrees-required');
  let hostA = await driver.host('a');
  const hostB = await driver.host('b');
  assertStage3(hostA.processId !== hostB.processId, 'independent-mcp-hosts');
  let seedAnchor = await anchors(driver, hostB, seed);
  let churnAnchor = await anchors(driver, hostA, churn);
  let recoveryAnchor = await anchors(driver, hostA, recovery);
  assertStage3(
    seedAnchor.entry === churnAnchor.entry && seedAnchor.entry === recoveryAnchor.entry,
    'shared-stable-symbol',
  );
  observations.push({phase: 'linked-worktrees', state: 'observed'});

  // Background refresh is fail-closed per worktree until an explicit current
  // read proves a bounded overlay succeeds. Prime that production contract in
  // every worktree before testing watcher-owned durable demand and recovery.
  seedAnchor = {
    ...seedAnchor,
    snapshot: await primeBackgroundRefreshEligibility(driver, hostB, seed, seedAnchor.entry, seedAnchor.leaf),
  };
  churnAnchor = {
    ...churnAnchor,
    snapshot: await primeBackgroundRefreshEligibility(driver, hostA, churn, churnAnchor.entry, churnAnchor.leaf),
  };
  recoveryAnchor = {
    ...recoveryAnchor,
    snapshot: await primeBackgroundRefreshEligibility(
      driver,
      hostA,
      recovery,
      recoveryAnchor.entry,
      recoveryAnchor.leaf,
    ),
  };

  const writer = await driver.lock(churn, 'writer');
  await driver.change(churn, 'f1', true);
  const f1 = await adopted(driver, churn, hostA, writer);
  for (const host of [hostA, hostB]) {
    for (const operation of discovery) {
      driver.held(writer);
      const response = await driver.call(host, churn, selectors(operation, churnAnchor.entry, churnAnchor.leaf));
      assertStage3(
        response.type === 'code-graph-inspection' && ['stale', 'deferred'].includes(String(response.freshness)),
        'stale-discovery',
      );
      assertStage3(stage3Record(response.snapshot).id === churnAnchor.snapshot, 'stale-snapshot-continuity');
      assertStage3(
        EffectArray.some(nodes(response), node => node.id === churnAnchor.entry),
        'stale-symbol-continuity',
      );
      if (operation === 'neighbors')
        assertStage3(EffectArray.isArray(response.edges) && response.edges.length > 0, 'stale-neighbor-evidence');
      const refresh = stage3Refresh(response.refresh);
      assertStage3(refresh.currentTargetToken === f1.active.targetToken, 'cross-host-continuity-token');
      observations.push({phase: 'blocked-writer-discovery', state: 'stale', operation, host: host.label, refresh});
      driver.held(writer);
    }
  }
  for (const operation of ['path', 'impact'] as const) {
    driver.held(writer);
    const response = await driver.call(hostB, churn, selectors(operation, churnAnchor.entry, churnAnchor.leaf));
    const state = assertStage3StrictStateEnvelope(operation, response);
    const refresh = response.refresh === undefined ? undefined : stage3Refresh(response.refresh);
    observations.push({
      phase: 'strict-current-boundary',
      state,
      operation,
      host: hostB.label,
      ...(refresh ? {refresh} : {}),
      ...(response.retryAfterMilliseconds === undefined
        ? {}
        : {retryAfterMilliseconds: Number(response.retryAfterMilliseconds)}),
    });
    driver.held(writer);
  }

  await driver.change(churn, 'f2');
  const f2 = await driver.until(async () => {
    const demand = await driver.demand(churn);
    return demand?.active?.targetKey === f1.active.targetKey &&
      demand.desired &&
      demand.desired.targetKey !== f1.active.targetKey
      ? demand
      : undefined;
  }, 'f2-not-queued');
  assertStage3(
    f2?.active?.targetKey === f1.active.targetKey && f2.desired && f2.desired.targetKey !== f1.active.targetKey,
    'f2-not-queued',
  );
  const f2Key = f2.desired.targetKey;
  const second = await driver.call(hostA, churn, selectors('query', churnAnchor.entry, churnAnchor.leaf));
  observations.push({
    phase: 'latest-demand-convergence',
    state: 'observed',
    target: 'f2',
    refresh: stage3Refresh(second.refresh),
  });
  await driver.change(churn, 'f3');
  const f3 = await driver.until(async () => {
    const demand = await driver.demand(churn);
    return demand?.active?.targetKey === f1.active.targetKey &&
      demand.desired &&
      demand.desired.targetKey !== f2Key &&
      demand.desired.targetKey !== f1.active.targetKey
      ? demand
      : undefined;
  }, 'f3-not-latest');
  assertStage3(
    f3?.active?.targetKey === f1.active.targetKey &&
      f3.desired &&
      f3.desired.targetKey !== f2Key &&
      f3.desired.targetKey !== f1.active.targetKey,
    'f3-not-latest',
  );
  const f3Key = f3.desired.targetKey;
  const third = await driver.call(hostB, churn, selectors('query', churnAnchor.entry, churnAnchor.leaf));
  const latestRefresh = stage3Refresh(third.refresh);
  assertStage3(
    latestRefresh.currentTargetToken === f1.active.targetToken &&
      latestRefresh.latestDesiredToken === f3.desired.targetToken,
    'latest-continuity-token',
  );
  observations.push({phase: 'latest-demand-convergence', state: 'observed', target: 'f3', refresh: latestRefresh});
  driver.held(writer);
  await driver.statuses(churn);
  await driver.release(writer);
  await current(driver, hostA, churn, f3Key, 'f3', churnAnchor.entry, churnAnchor.leaf);
  assertStage3(
    !EffectArray.some([...driver.history.values()], status => status.request?.key === f2Key),
    'obsolete-target-built',
  );
  const churnHistory = EffectArray.filter(
    [...driver.history.values()],
    status =>
      status.identity.worktreeId === churn.identity.worktreeId &&
      [f1.active.targetKey, f3Key].includes(status.request?.key ?? ''),
  );
  for (const left of churnHistory)
    for (const right of churnHistory) {
      if (left.buildId === right.buildId) continue;
      const leftEnd = Date.parse(left.timestamps.completedAt ?? '');
      const rightEnd = Date.parse(right.timestamps.completedAt ?? '');
      assertStage3(Number.isFinite(leftEnd) && Number.isFinite(rightEnd), 'incomplete-build-history');
      assertStage3(
        Math.max(Date.parse(left.timestamps.startedAt), Date.parse(right.timestamps.startedAt)) >=
          Math.min(leftEnd, rightEnd),
        'overlapping-build-history',
      );
    }
  observations.push({phase: 'latest-demand-convergence', state: 'current', target: 'f3'});

  const spawn = await driver.lock(recovery, 'spawn');
  await driver.change(recovery, 'before-spawn', true);
  await driver.call(hostA, recovery, selectors('query', recoveryAnchor.entry, recoveryAnchor.leaf));
  const before = await driver.until(async () => {
    driver.held(spawn);
    const demand = await driver.demand(recovery);
    return demand?.active?.phase === 'claimed' && demand.active.claimOwner?.processId === hostA.processId
      ? demand.active
      : undefined;
  }, 'pre-spawn-claim');
  assertStage3(
    !EffectArray.some(await driver.statuses(recovery), status => status.request?.key === before.targetKey),
    'pre-spawn-child-exists',
  );
  await driver.killHost(hostA);
  await driver.call(hostB, recovery, selectors('query', recoveryAnchor.entry, recoveryAnchor.leaf));
  const recovered = await driver.until(async () => {
    const demand = await driver.demand(recovery);
    return demand?.active?.phase === 'claimed' && demand.active.claimOwner?.processId === hostB.processId
      ? demand.active
      : undefined;
  }, 'pre-spawn-reclaim');
  assertStage3(recovered.targetKey === before.targetKey, 'pre-spawn-recovery-target');
  await driver.release(spawn);
  await current(
    driver,
    hostB,
    recovery,
    recovered.targetKey,
    'before-spawn',
    recoveryAnchor.entry,
    recoveryAnchor.leaf,
  );
  observations.push({phase: 'pre-spawn-recovery', state: 'current'});

  hostA = await driver.host('a');
  const adoptedWriter = await driver.lock(seed, 'writer');
  await driver.change(seed, 'after-adoption', true);
  await driver.call(hostB, seed, selectors('query', seedAnchor.entry, seedAnchor.leaf));
  const child = await adopted(driver, seed, hostB, adoptedWriter);
  const parent = await driver.command('ps', ['-o', 'ppid=', '-p', String(child.status.owner.processId)]);
  assertStage3(Number(Effect.pipe(parent.stdout, EffectString.trim)) === hostB.processId, 'adopted-child-parent');
  await driver.killHost(hostB);
  const attached = await driver.call(hostA, seed, selectors('query', seedAnchor.entry, seedAnchor.leaf));
  const attachedRefresh = stage3Refresh(attached.refresh);
  assertStage3(attachedRefresh.currentTargetToken === child.active.targetToken, 'adopted-token-changed');
  const reattached = EffectArray.filter(
    await driver.statuses(seed),
    status => status.request?.key === child.active.targetKey && status.observation.liveness === 'active',
  );
  assertStage3(
    reattached.length === 1 &&
      reattached[0].buildId === child.status.buildId &&
      reattached[0].owner.processId === child.status.owner.processId &&
      reattached[0].owner.processStartIdentity === child.status.owner.processStartIdentity,
    'adopted-child-replaced',
  );
  observations.push({phase: 'adopted-child-recovery', state: 'observed', refresh: attachedRefresh});
  await driver.change(seed, 'after-adoption-latest', true);
  await driver.call(hostA, seed, selectors('query', seedAnchor.entry, seedAnchor.leaf));
  const pending = await driver.until(async () => {
    const demand = await driver.demand(seed);
    return demand?.active?.targetKey === child.active.targetKey &&
      demand.desired &&
      demand.desired.targetKey !== child.active.targetKey
      ? demand
      : undefined;
  }, 'adopted-latest-not-queued');
  assertStage3(
    pending?.active?.targetKey === child.active.targetKey &&
      pending.desired &&
      pending.desired.targetKey !== child.active.targetKey,
    'adopted-latest-not-queued',
  );
  await driver.release(adoptedWriter);
  await current(
    driver,
    hostA,
    seed,
    pending.desired.targetKey,
    'after-adoption-latest',
    seedAnchor.entry,
    seedAnchor.leaf,
  );
  assertStage3(
    EffectArray.filter(
      [...driver.history.values()],
      status => status.request?.key === child.active.targetKey && status.result !== undefined,
    ).length <= 1,
    'duplicate-adopted-publication',
  );
  observations.push({phase: 'adopted-child-recovery', state: 'current'});
  observations.push({phase: 'privacy-scan', state: 'observed'});
  scanStage3Observations(observations, [...driver.forbidden]);
  const phases = new Set<Stage3Phase>(EffectArray.map(observations, observation => observation.phase));
  assertStage3(phases.size === 7, 'missing-phase');
  return observations;
}
