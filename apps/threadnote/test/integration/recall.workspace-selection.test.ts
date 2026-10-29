import {Array as EffectArray} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {readMemoryRecordsByUri} from '@threadnote/threadnote/memory/index';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {prepareRecallSections} from '@threadnote/recall/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function liveRecordReader(home: string, user = 'me') {
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath: `${home}/seed-manifest.yaml`,
    user,
  };
  return (uris: readonly string[]) => readMemoryRecordsByUri(config, uris);
}

function memoryContent(
  topic: string,
  workspaceScope: string | undefined,
  body: string,
  project = 'monorepo',
  kind = 'durable',
  timestamp = '2026-08-20T00:00:00.000Z',
): string {
  return EffectArray.join(
    [
      'MEMORY',
      `kind: ${kind}`,
      'status: active',
      `project: ${project}`,
      `topic: ${topic}`,
      ...(workspaceScope === undefined ? [] : [`workspace_scope: ${workspaceScope}`]),
      'source_agent_client: integration-test',
      `timestamp: ${timestamp}`,
      '',
      body,
    ],
    '\n',
  );
}

function handoffContent(topic: string, branch: string, timestamp: string): string {
  return EffectArray.join(
    [
      'MEMORY',
      'kind: handoff',
      'status: active',
      'project: monorepo',
      `topic: ${topic}`,
      'source_agent_client: integration-test',
      `timestamp: ${timestamp}`,
      '',
      'repo: monorepo',
      `branch: ${branch}`,
      'task: Continue the current branch handoff feature implementation.',
    ],
    '\n',
  );
}

effectIt.effect(
  'sources late package and repo-wide targets before limiting misleading scope-text siblings',
  () => {
    let home: string | undefined;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      home = yield* fs.makeTempDirectory({prefix: 'threadnote-workspace-selection-'});
      const memoryRoot = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'projects', 'monorepo');
      yield* fs.makeDirectory(memoryRoot, {recursive: true});
      const localNoise = Array.from({length: 420}, (_unused, index) => ({
        content: memoryContent(`local-noise-${index}`, 'apps/search', 'Unrelated package-local operational note.'),
        filename: `local-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`,
      }));
      const topicalSiblings = Array.from({length: 125}, (_unused, index) => ({
        content: memoryContent(
          'checkout-retry-contract',
          `apps/shadow-${index}`,
          'Checkout retry contract. Checkout retry contract. Checkout retry contract uses bounded attempts.',
        ),
        filename: `sibling-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`,
      }));
      const packageTargetFilename = 'zy-current-package-target.md';
      const repoWideTargetFilename = 'zz-repo-wide-target.md';
      yield* Effect.forEach(
        [
          ...localNoise,
          ...topicalSiblings,
          {
            content: memoryContent(
              'package-retry-policy',
              'apps/search',
              'The package uses a bounded checkout retry contract.',
            ),
            filename: packageTargetFilename,
          },
          {
            content: memoryContent(
              'package-retry-policy',
              undefined,
              'The package uses a bounded checkout retry contract.',
            ),
            filename: repoWideTargetFilename,
          },
        ],
        entry => fs.writeFileString(path.join(memoryRoot, entry.filename), entry.content),
        {concurrency: 32, discard: true},
      );

      const config = {account: 'local', agentContextHome: home, user: 'me'};
      const query = 'checkout retry contract';
      const prepared = yield* prepareRecallSections(config, {
        allowExactRescue: true,
        exactMatches: [],
        feedbackQuery: query,
        includeInactive: false,
        limit: 5,
        passes: [],
        project: 'monorepo',
        query,
        readRecords: liveRecordReader(home),
        semanticResult: Option.none(),
        workspaceScope: 'apps/search',
      });
      const packageTargetUri = `threadnote://user/me/memories/durable/projects/monorepo/${packageTargetFilename}`;
      const repoWideTargetUri = `threadnote://user/me/memories/durable/projects/monorepo/${repoWideTargetFilename}`;
      const globalTopical = yield* loadRecallIndexData(config, {
        includeInactive: false,
        limit: 100,
        query,
      });

      expect(EffectArray.map(globalTopical.candidates, candidate => candidate.uri)).not.toContain(packageTargetUri);
      expect(EffectArray.map(globalTopical.candidates, candidate => candidate.uri)).not.toContain(repoWideTargetUri);
      const preparedUris = EffectArray.map(prepared.ranked, result => result.uri);
      expect(preparedUris).toEqual(expect.arrayContaining([packageTargetUri, repoWideTargetUri]));
      expect(preparedUris.indexOf(packageTargetUri)).toBeLessThan(preparedUris.indexOf(repoWideTargetUri));
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (!home) return;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(home, {force: true, recursive: true}).pipe(Effect.ignore);
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    );
  },
  30_000,
);

effectIt.effect(
  'admits the only relevant sibling after project-local filtering beyond a full global window',
  () => {
    let home: string | undefined;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      home = yield* fs.makeTempDirectory({prefix: 'threadnote-cross-scope-selection-'});
      const memoryRoot = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'projects', 'monorepo');
      yield* fs.makeDirectory(memoryRoot, {recursive: true});
      const localDecoys = Array.from({length: 140}, (_unused, index) => ({
        content: memoryContent(`local-decoy-${index}`, 'apps/search', 'Unrelated package-local operational note.'),
        filename: `local-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`,
      }));
      const otherProjectDecoys = Array.from({length: 140}, (_unused, index) => ({
        content: memoryContent('checkout-retry-contract', `apps/shadow-${index}`, 'Checkout retry contract.', 'x'),
        filename: `other-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`,
      }));
      const targetFilename = 'zz-billing-governing-contract.md';
      yield* Effect.forEach(
        [
          ...localDecoys,
          ...otherProjectDecoys,
          {
            content: memoryContent(
              'billing-retry-policy',
              'apps/billing',
              'The billing package uses a bounded checkout retry contract.',
            ),
            filename: targetFilename,
          },
        ],
        entry => fs.writeFileString(path.join(memoryRoot, entry.filename), entry.content),
        {concurrency: 32, discard: true},
      );

      const config = {account: 'local', agentContextHome: home, user: 'me'};
      const query = 'checkout retry contract';
      const targetUri = `threadnote://user/me/memories/durable/projects/monorepo/${targetFilename}`;
      const globalTopical = yield* loadRecallIndexData(config, {
        includeInactive: false,
        limit: 100,
        query,
      });
      let challengerPostingRows = Number.POSITIVE_INFINITY;
      const siblingOnly = yield* loadRecallIndexData(config, {
        includeInactive: false,
        limit: 10,
        onQueryDiagnostics: diagnostics =>
          Effect.sync(() => {
            challengerPostingRows = diagnostics.postingRows;
          }),
        project: 'monorepo',
        query,
        requiredUris: [
          'threadnote://user/me/memories/durable/projects/monorepo/local-000.md',
          'threadnote://user/me/memories/durable/projects/monorepo/other-000.md',
        ],
        workspaceScope: 'apps/search',
        workspaceScopeMode: 'sibling',
      });
      const prepared = yield* prepareRecallSections(config, {
        allowExactRescue: true,
        exactMatches: [],
        feedbackQuery: query,
        includeInactive: false,
        limit: 5,
        passes: [],
        project: 'monorepo',
        query,
        readRecords: liveRecordReader(home),
        semanticResult: Option.some({
          corpusGeneration: Option.some(globalTopical.generation),
          scores: Option.some(new Map([[targetUri, 0.9]])),
          warning: Option.none(),
        }),
        workspaceScope: 'apps/search',
      });

      expect(EffectArray.map(globalTopical.candidates, candidate => candidate.uri)).not.toContain(targetUri);
      expect(EffectArray.map(siblingOnly.candidates, candidate => candidate.uri)).toEqual([targetUri]);
      expect(challengerPostingRows).toBeLessThanOrEqual(5);
      expect(EffectArray.map(prepared.ranked, result => result.uri)).toContain(targetUri);
      expect(Option.isSome(prepared.semanticResult.scores)).toBe(true);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (!home) return;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(home, {force: true, recursive: true}).pipe(Effect.ignore);
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    );
  },
  30_000,
);

effectIt.effect(
  'still queries a supplied-variant sibling lane when mediocre siblings fill its global reserve ahead of the target',
  () => {
    let home: string | undefined;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      home = yield* fs.makeTempDirectory({prefix: 'threadnote-cross-scope-exhaustion-'});
      const memoryRoot = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'durable', 'projects', 'monorepo');
      yield* fs.makeDirectory(memoryRoot, {recursive: true});
      const currentDecoys = Array.from({length: 98}, (_unused, index) => ({
        content: memoryContent(
          `checkout-retry-contract-${index}`,
          'apps/search',
          `Checkout retry contract superseded operational history ${index}.`,
          'monorepo',
          'durable',
          '2020-01-01T00:00:00.000Z',
        ),
        filename: `current-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`,
      }));
      const mediocreSiblings = Array.from({length: 2}, (_unused, index) => ({
        content: memoryContent(
          `checkout-retry-contract-sibling-${index}`,
          `apps/legacy-${index}`,
          `Checkout retry contract superseded sibling history ${index}.`,
          'monorepo',
          'durable',
          '2020-01-01T00:00:00.000Z',
        ),
        filename: `sibling-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`,
      }));
      const targetFilename = 'zz-billing-governing-contract.md';
      yield* Effect.forEach(
        [
          ...currentDecoys,
          ...mediocreSiblings,
          {
            content: memoryContent(
              'billing-retry-policy',
              'apps/billing',
              'The current governing decision is the bounded checkout retry contract.',
            ),
            filename: targetFilename,
          },
        ],
        entry => fs.writeFileString(path.join(memoryRoot, entry.filename), entry.content),
        {concurrency: 32, discard: true},
      );

      const config = {account: 'local', agentContextHome: home, user: 'me'};
      const query = 'checkout retry contract';
      const originalQuery = 'find applicable note';
      const targetUri = `threadnote://user/me/memories/durable/projects/monorepo/${targetFilename}`;
      const globalTopical = yield* loadRecallIndexData(config, {
        includeInactive: false,
        limit: 100,
        query,
      });
      const prepared = yield* prepareRecallSections(config, {
        allowExactRescue: true,
        exactMatches: [],
        feedbackQuery: originalQuery,
        includeInactive: false,
        limit: 3,
        passes: [],
        project: 'monorepo',
        query: originalQuery,
        queryVariants: [query],
        readRecords: liveRecordReader(home),
        semanticResult: Option.none(),
        workspaceScope: 'apps/search',
      });
      const candidates = globalTopical.candidates;
      const globalSiblingUris = EffectArray.map(
        EffectArray.filter(
          candidates,
          (candidate, index) =>
            index in candidates &&
            Boolean(
              Effect2.pipe(candidate.fields?.workspaceScope, effectOptionalString =>
                effectOptionalString == null
                  ? undefined
                  : Effect2.pipe(effectOptionalString, EffectString.startsWith('apps/legacy-')),
              ),
            ),
        ),
        candidate => candidate.uri,
      );

      expect(globalTopical.queryExhaustive).toBe(false);
      expect(globalTopical.candidates).toHaveLength(100);
      expect(globalSiblingUris).toHaveLength(2);
      expect(EffectArray.map(globalTopical.candidates, candidate => candidate.uri)).not.toContain(targetUri);
      expect(EffectArray.map(prepared.ranked, result => result.uri)).toContain(targetUri);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (!home) return;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(home, {force: true, recursive: true}).pipe(Effect.ignore);
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    );
  },
  30_000,
);

effectIt.effect(
  'admits a custom-topic handoff by its recorded branch beyond a full sibling preselection window',
  () => {
    let home: string | undefined;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      home = yield* fs.makeTempDirectory({prefix: 'threadnote-branch-selection-'});
      const handoffRoot = path.join(home, 'data', 'local', 'user', 'me', 'memories', 'handoffs', 'active', 'monorepo');
      yield* fs.makeDirectory(handoffRoot, {recursive: true});
      const siblings = Array.from({length: 125}, (_unused, index) => ({
        content: handoffContent(
          `current-branch-latest-handoff-durable-feature-memory-${index}`,
          `feature/shadow-${index}`,
          '2026-08-20T00:00:00.000Z',
        ),
        filename: `sibling-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}.md`,
      }));
      const targetFilename = 'zz-recorded-selection.md';
      yield* Effect.forEach(
        [
          ...siblings,
          {
            content: handoffContent(
              'current-branch-latest-handoff-durable-feature-memory-target',
              'feature/search-recall',
              '2026-07-01T00:00:00.000Z',
            ),
            filename: targetFilename,
          },
        ],
        entry => fs.writeFileString(path.join(handoffRoot, entry.filename), entry.content),
        {concurrency: 32, discard: true},
      );

      const config = {account: 'local', agentContextHome: home, user: 'me'};
      const query = 'current branch latest handoff durable feature memory';
      const targetUri = `threadnote://user/me/memories/handoffs/active/monorepo/${targetFilename}`;
      const globalTopical = yield* loadRecallIndexData(config, {
        includeInactive: false,
        limit: 100,
        query,
      });
      const branchSupplemental = yield* loadRecallIndexData(config, {
        includeInactive: false,
        limit: 100,
        query: `${query} feature/search-recall`,
      });
      const prepared = yield* prepareRecallSections(config, {
        allowExactRescue: true,
        exactMatches: [],
        feedbackQuery: query,
        includeInactive: false,
        limit: 5,
        passes: [],
        project: 'monorepo',
        query,
        readRecords: liveRecordReader(home),
        semanticResult: Option.none(),
        workspaceBranch: 'feature/search-recall',
      });

      expect(EffectArray.map(globalTopical.candidates, candidate => candidate.uri)).not.toContain(targetUri);
      const sourcedTarget = Option.getOrUndefined(
        EffectArray.findFirst(branchSupplemental.candidates, candidate => candidate.uri === targetUri),
      );
      expect(sourcedTarget?.fields?.topic).toBe('current-branch-latest-handoff-durable-feature-memory-target');
      expect(sourcedTarget?.text).toMatch(/^branch: feature\/search-recall$/m);
      expect(prepared.ranked[0]?.uri).toBe(targetUri);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          if (!home) return;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(home, {force: true, recursive: true}).pipe(Effect.ignore);
        }),
      ),
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
    );
  },
  30_000,
);
