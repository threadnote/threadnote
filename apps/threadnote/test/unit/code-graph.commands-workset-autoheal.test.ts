import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {beforeEach, describe, expect, vi} from 'vitest';
import type {CodeGraphWorksetPrepareResultV1} from '@threadnote/graph/workset_catalog/workset';
import {runCodeGraphWorksetPrepare} from '@threadnote/threadnote/code_graph/commands';
import {CliOutput} from '@threadnote/threadnote/effect/cli/output';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const mocks = vi.hoisted(() => ({
  healWorkset: vi.fn(),
  prepareWorkset: vi.fn(),
}));

vi.mock('@threadnote/graph/workset_catalog/workset', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/graph/workset_catalog/workset')>()),
  prepareCodeGraphWorkset: mocks.prepareWorkset,
}));

vi.mock('@threadnote/threadnote/memory/deferred/code_anchor_recovery', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/threadnote/memory/deferred/code_anchor_recovery')>()),
  healAnchorsAfterWorksetPrepare: mocks.healWorkset,
}));

const config: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/threadnote-home',
  agentId: 'threadnote',
  manifestPath: '/threadnote-home/manifest.yaml',
  user: 'tester',
};

describe('Workset prepare deferred-anchor recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.healWorkset.mockReturnValue(Effect.void);
  });

  effectIt.effect('heals the canonical ready Workset when invocation casing differs', () => {
    const output: string[] = [];
    mocks.prepareWorkset.mockReturnValue(Effect.succeed(worksetResult('ready')));

    return Effect.gen(function* () {
      yield* runCodeGraphWorksetPrepare(config, {json: true, name: 'PLATFORM'});

      expect(mocks.prepareWorkset).toHaveBeenCalledWith(
        config,
        'PLATFORM',
        expect.objectContaining({isolateBuilds: false}),
      );
      expect(mocks.healWorkset).toHaveBeenCalledOnce();
      expect(mocks.healWorkset).toHaveBeenCalledWith(config, 'platform');
      expect(JSON.parse(output[0])).toMatchObject({state: 'ready', workset: 'platform'});
    }).pipe(Effect.provideService(CliOutput, collectingCliOutput(output)), provideTestLayer(ApplicationLayer));
  });

  effectIt.effect('does not heal when preparation did not publish a ready Workset', () => {
    const output: string[] = [];
    mocks.prepareWorkset.mockReturnValue(Effect.succeed(worksetResult('failed')));

    return Effect.gen(function* () {
      const failure = yield* runCodeGraphWorksetPrepare(config, {json: true, name: 'PLATFORM'}).pipe(Effect.flip);

      expect(failure.message).toContain('preparation was incomplete');
      expect(mocks.healWorkset).not.toHaveBeenCalled();
      expect(JSON.parse(output[0])).toMatchObject({state: 'failed', workset: 'platform'});
    }).pipe(Effect.provideService(CliOutput, collectingCliOutput(output)), provideTestLayer(ApplicationLayer));
  });
});

function collectingCliOutput(output: string[]) {
  return CliOutput.of({
    drain: Effect.void,
    enqueueError: () => undefined,
    enqueueOutput: () => undefined,
    flush: Effect.void,
    writeError: value => Effect.sync(() => output.push(value)),
    writeFinal: value => Effect.sync(() => output.push(value)),
  });
}

function worksetResult(state: 'failed' | 'ready'): CodeGraphWorksetPrepareResultV1 {
  return {
    coverage: {
      complete: state === 'ready',
      excluded: 0,
      failed: state === 'failed' ? 1 : 0,
      missing: 0,
      ready: state === 'ready' ? 1 : 0,
      requested: 1,
    },
    manifestDigest: Effect2.pipe('a', EffectString.repeat(64)),
    members: [],
    state,
    type: 'code-graph-workset-prepare',
    version: 1,
    workset: 'platform',
  };
}
