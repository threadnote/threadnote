import assert from 'node:assert/strict';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectString from 'effect/String';
import * as EffectRecord from 'effect/Record';
import {cpus} from 'node:os';
import {Array as EffectArray} from 'effect';
import {assembleNavigationAnswer} from '../../src/navigation/assemble.js';
import {
  NAVIGATION_INPUT_LIMITS,
  NAVIGATION_ROLES,
  type NavigationCandidate,
  type NavigationInput,
  type NavigationLink,
  type NavigationScope,
  type NavigationSource,
} from '../../src/navigation/model.js';
const arguments_ = process.argv.slice(2);
if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== '--output'))
  throw new Error('Usage: bun navigation-answer.bench.ts [--output /absolute/artifact.json]');
const output = arguments_[1];
const sourceFiles = ['model.ts', 'assemble.ts'];
const source = [];
for (const file of sourceFiles) {
  const bytes = new Uint8Array(await Bun.file(new URL(`../../src/navigation/${file}`, import.meta.url)).arrayBuffer());
  source.push({
    path: `packages/context/src/navigation/${file}`,
    sha256: sha256HexSync(bytes),
  });
}
const git = Bun.spawnSync({cmd: ['git', 'rev-parse', 'HEAD'], stdout: 'pipe', stderr: 'pipe'});
const identity = {
  kind: 'navigation-model-only-benchmark',
  recordedAt: new Date().toISOString(),
  sourceCommit: git.exitCode === 0 ? EffectString.trim(new TextDecoder().decode(git.stdout)) : null,
  source,
  host: {bun: Bun.version, platform: process.platform, architecture: process.arch, cpus: cpus().length},
  warmups: 20,
  samples: 100,
  allocationP95Milliseconds: 150,
  measured:
    'Finite input admission, deterministic normalization and assembly only. No source acquisition, projection, public CLI/MCP, provider or end-to-end latency claim.',
};
function input(longUnicode: boolean): NavigationInput {
  const scope: NavigationScope = {
    repository: 'benchmark-repository',
    worktree: 'file:///benchmark/worktree',
    project: 'file:///benchmark/worktree/project',
    view: {kind: 'disk', id: 'saved', owner: 'benchmark-owner', epoch: 1},
  };
  const suffix = longUnicode ? EffectString.repeat(256)('名😀') : 'fixture';
  const sources: NavigationSource[] = Array.from({length: 32}, (_, index) => {
    const observation = {
      version: 1,
      repository: scope.repository,
      worktree: scope.worktree,
      project: scope.project,
      configuration: EffectString.repeat(64)('a'),
      toolchain: EffectString.repeat(64)('b'),
      provider: {id: 'fixture-provider', version: '1', generation: 1},
      view: scope.view,
      uri: `file:///benchmark/worktree/project/${index}-${suffix}.ts`,
      content: EffectString.repeat(64)('c'),
      documentVersion: null,
      projectEpoch: 1,
    };
    return {
      ...scope,
      id: `source-${index}`,
      path: `${index}-${suffix}.ts`,
      contentHash: EffectString.repeat(64)('c'),
      freshness: 'verified-current',
      semantic: {
        observationKey: JSON.stringify(EffectRecord.values(observation)),
        observationJson: JSON.stringify(observation),
      },
    };
  });
  const candidates: NavigationCandidate[] = Array.from({length: 24}, (_, index) => ({
    id: `node-${EffectString.padStart(2, '0')(String(index))}`,
    sourceId: sources[index].id,
    startLine: 1,
    endLine: 4,
    roles: [NAVIGATION_ROLES[index % 4]],
    basis: ['inspected-source'],
    support: 'evidenced',
    relevance: index,
    reason: longUnicode ? EffectString.repeat(1024)('😀') : 'Inspect the authored bounded fixture role.',
    ...(index % 4 === 2
      ? {possibleEffect: {kind: 'durable-write' as const, target: 'fixture-path', condition: 'persist'}}
      : {}),
    ...(index % 4 === 3 ? {testAssociation: 'source-supported' as const} : {}),
  }));
  const links: NavigationLink[] = Array.from({length: 64}, (_, index) => ({
    from: candidates[index % 24].id,
    to: candidates[(index + 1) % 24].id,
    relation: 'calls',
    basis: 'structural',
    compatibility: 'verified',
    reason: 'Authored fixture relationship.',
  }));
  return {
    scope,
    target: {kind: 'anchors', candidateIds: [candidates[0].id]},
    sources,
    candidates,
    links,
    coverage: {status: 'complete', description: 'The bounded benchmark fixture only.'},
  };
}
function admittedTextBytes(value: NavigationInput): number {
  const scopeTexts = (scope: NavigationScope) => [
    scope.repository,
    scope.worktree,
    scope.project,
    scope.view.id,
    scope.view.owner,
  ];
  const texts = [
    ...scopeTexts(value.scope),
    value.coverage.description,
    ...EffectArray.flatMap(value.sources, source => [
      ...scopeTexts(source),
      source.id,
      source.path,
      source.contentHash,
      ...(source.snapshot === undefined ? [] : [source.snapshot]),
      ...(source.semantic ? [source.semantic.observationKey, source.semantic.observationJson] : []),
    ]),
    ...EffectArray.flatMap(value.candidates, candidate => [
      candidate.id,
      candidate.sourceId,
      candidate.reason,
      ...(candidate.possibleEffect
        ? [
            candidate.possibleEffect.target,
            ...(candidate.possibleEffect.condition === undefined ? [] : [candidate.possibleEffect.condition]),
          ]
        : []),
    ]),
    ...(value.target.kind === 'task' ? [] : value.target.candidateIds),
    ...EffectArray.flatMap(value.links, link => [link.from, link.to, link.reason]),
    ...EffectArray.flatMap(value.roleGaps ?? [], gap => [
      gap.reason,
      ...(gap.sourceProof ? [gap.sourceProof.sourceId] : []),
    ]),
    ...(value.gaps ?? []),
    ...EffectArray.flatMap(value.followUps ?? [], followUp => [followUp.selector, followUp.reason]),
  ];
  const utf8 = new TextEncoder();
  return EffectArray.reduce(texts, 0, (total, text) => total + utf8.encode(text).byteLength);
}
function maxByteInput(): NavigationInput {
  const fixture = input(false);
  const bounded: NavigationInput = {
    ...fixture,
    target: {
      kind: 'anchors',
      candidateIds: EffectArray.map(EffectArray.take(fixture.candidates, 8), candidate => candidate.id),
    },
    links: EffectArray.map(fixture.links, (link, index) => ({
      ...link,
      reason: EffectString.repeat(14000)('x') + String(index),
    })),
    roleGaps: EffectArray.map(NAVIGATION_ROLES, role => ({
      role,
      status: 'unknown',
      reason: `No added ${role} claim.`,
      sourceProof: {sourceId: fixture.sources[0].id, span: {startLine: 1, endLine: 1}},
    })),
    gaps: Array.from({length: NAVIGATION_INPUT_LIMITS.gaps}, (_, index) => `bounded-gap-${index}`),
    followUps: [
      {kind: 'read-source', selector: '0-fixture.ts:1', reason: 'Inspect the admitted location.'},
      {kind: 'query', selector: 'node-00', reason: 'Acquire a bounded related location.'},
    ],
  };
  return fillTextBudget(bounded);
}
function fillTextBudget(bounded: NavigationInput): NavigationInput {
  let missing = NAVIGATION_INPUT_LIMITS.totalStringBytes - admittedTextBytes(bounded);
  assert.ok(missing >= 0);
  const candidates = EffectArray.map(bounded.candidates, candidate => {
    const add = Math.min(
      missing,
      NAVIGATION_INPUT_LIMITS.stringBytes - new TextEncoder().encode(candidate.reason).byteLength,
    );
    missing -= add;
    return {...candidate, reason: candidate.reason + EffectString.repeat(add)('y')};
  });
  const value = {...bounded, candidates};
  assert.equal(missing, 0);
  assert.equal(admittedTextBytes(value), NAVIGATION_INPUT_LIMITS.totalStringBytes);
  return value;
}
function quarantineInput(): NavigationInput {
  const base = input(false);
  const scope: NavigationScope = {...base.scope, view: {...base.scope.view, id: EffectString.repeat(30000)('v')}};
  const sources: NavigationSource[] = Array.from({length: 32}, (_, index) => ({
    ...scope,
    id: 'same-source',
    path: 'same.ts',
    contentHash: EffectString.padStart(64, '0')(String(index)),
    freshness: 'verified-current',
    semantic: {observationKey: `observation-${index}`, observationJson: JSON.stringify({version: index})},
  }));
  const candidates = EffectArray.map(base.candidates, candidate => ({...candidate, sourceId: 'same-source'}));
  return fillTextBudget({
    ...base,
    scope,
    sources,
    candidates,
    target: {
      kind: 'anchors',
      candidateIds: EffectArray.map(EffectArray.take(candidates, 8), candidate => candidate.id),
    },
    roleGaps: EffectArray.map(NAVIGATION_ROLES, role => ({role, status: 'unknown', reason: `Unresolved ${role}.`})),
    gaps: Array.from({length: NAVIGATION_INPUT_LIMITS.gaps}, (_, index) => `quarantine-gap-${index}`),
    followUps: [
      {kind: 'read-source', selector: 'same.ts:1', reason: 'Resolve the conflicting observation.'},
      {kind: 'query', selector: 'node-00', reason: 'Acquire compatible source evidence.'},
    ],
  });
}
function verify(value: ReturnType<typeof assembleNavigationAnswer>, name: string, fixture: NavigationInput): void {
  if (name === 'quarantine-max-admitted-bytes') {
    assert.equal(value.outcome, 'unresolved');
    assert.equal(value.nodes.length, 0);
    assert.equal(value.links.length, 0);
    assert.equal(value.sources.length, 32);
    assert.deepEqual(value.sources, fixture.sources);
    assert.equal(new Set(EffectArray.map(value.sources, item => item.contentHash)).size, 32);
    assert.ok(value.gaps.includes('source-identity-conflict'));
    assert.ok(value.gaps.includes('target-unresolved'));
    assert.deepEqual(
      value.roles,
      EffectArray.map(NAVIGATION_ROLES, role => ({
        role,
        status: 'unknown',
        nodeIds: [],
        candidateIds: [],
        reason: `Unresolved ${role}.`,
      })),
    );
    return;
  }
  const maxBytes = name === 'max-admitted-bytes';

  assert.equal(value.outcome, maxBytes ? 'partial' : 'ok');
  assert.equal(value.nodes.length, 24);
  assert.equal(value.links.length, maxBytes ? 64 : 24);
  assert.equal(value.sources.length, 24);
  assert.deepEqual(
    EffectArray.map(value.roles, role => [role.role, role.status, role.nodeIds.length]),
    EffectArray.map(NAVIGATION_ROLES, role => [role, 'supported', 6]),
  );
}
const results = [];
let failure: string | undefined;
let activeProfile: {name: string; orderedSamplesMilliseconds: number[]} | undefined;
try {
  for (const [name, fixture] of [
    ['bounded', input(false)],
    ['long-unicode', input(true)],
    ['max-admitted-bytes', maxByteInput()],
    ['quarantine-max-admitted-bytes', quarantineInput()],
  ] as const) {
    const samples: number[] = [];
    activeProfile = {name, orderedSamplesMilliseconds: samples};
    for (let index = 0; index < identity.warmups; index++) verify(assembleNavigationAnswer(fixture), name, fixture);
    for (let index = 0; index < identity.samples; index++) {
      const started = performance.now();
      const answer = assembleNavigationAnswer(fixture);
      samples.push(performance.now() - started);
      verify(answer, name, fixture);
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const p50 = sorted[Math.ceil(sorted.length * 0.5) - 1];
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    const max = sorted[sorted.length - 1];
    results.push({
      name,
      candidateCount: fixture.candidates.length,
      linkCount: fixture.links.length,
      sourceCount: fixture.sources.length,
      anchorCount: fixture.target.kind === 'task' ? 0 : fixture.target.candidateIds.length,
      roleGapCount: fixture.roleGaps?.length ?? 0,
      gapCount: fixture.gaps?.length ?? 0,
      followUpCount: fixture.followUps?.length ?? 0,
      inputTextBytes: admittedTextBytes(fixture),
      p50Milliseconds: p50,
      p95Milliseconds: p95,
      maxMilliseconds: max,
      orderedSamplesMilliseconds: samples,
    });
    assert.ok(p95 <= identity.allocationP95Milliseconds, `${name} model p95 exceeded its engineering allocation`);
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
}
const artifact = {
  ...identity,
  status: failure ? 'failed' : 'passed',
  results,
  ...(failure ? {failure, failedProfile: activeProfile} : {}),
};
const text = JSON.stringify(artifact, null, 2) + '\n';
if (output) await Bun.write(output, text);
process.stdout.write(text);
