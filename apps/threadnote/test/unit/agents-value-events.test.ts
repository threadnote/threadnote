import {Array as EffectArray} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {getAgentAdapter} from '@threadnote/threadnote/agent_integration/adapters';
import {setupCompletionForRegistrationStates} from '@threadnote/threadnote/agent_integration/registry';
import {planAgentSurface} from '@threadnote/threadnote/agent_integration/surfaces';

import {runAgentCliAction} from '@threadnote/threadnote/effect/agents_cli';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readLocalValueEvents, summarizeLocalValueEvents} from '@threadnote/threadnote/value_report/events';
import {provideTestLayer} from '../helpers/effect-layer.js';

const commandLayer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(BunServices.layer),
  Layer.provide(TestSystemInfoLayer),
);
const testLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer, commandLayer);
const runtime = (home: string): RuntimeConfig => ({
  account: 'local',
  agentContextHome: home,
  agentId: 'threadnote',
  manifestPath: `${home}/manifest.yaml`,
  user: 'tester',
});
const reportPeriod = {
  from: new Date('2000-01-01T00:00:00.000Z'),
  to: new Date('2100-01-01T00:00:00.000Z'),
} as const;

describe('agent setup value events', () => {
  it('classifies only an absent or pending target and reports reuse iff another current registration existed', () => {
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom('current' as const, 'pending' as const), {nil: undefined}),
        fc.array(fc.option(fc.constantFrom('current' as const, 'pending' as const), {nil: undefined}), {
          maxLength: 12,
        }),
        (target, others) => {
          const completion = setupCompletionForRegistrationStates(target, others);
          const expectedCompletion = target !== 'current';
          expect(completion !== undefined).toBe(expectedCompletion);
          if (completion !== undefined) {
            expect(completion).toEqual({
              _tag: 'AgentSetupCompletion',
              supportedAgentReuse: others.includes('current'),
            });
          }
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect('records fresh applied installs but not previews, reinstalls, repairs, or removals', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-value-'});
        const home = path.join(root, 'user');
        const config = runtime(path.join(home, '.threadnote'));
        const testSystem = SystemInfo.of({
          ...system,
          homeDirectory: home,
          environment: () => ({...system.environment(), XDG_CONFIG_HOME: path.join(root, 'config')}),
        });

        yield* Effect.gen(function* () {
          const gemini = getAgentAdapter('gemini-cli')!;
          const amp = getAgentAdapter('amp-cli')!;

          yield* runAgentCliAction(config, gemini, 'install', false);
          expect(yield* readLocalValueEvents(config.agentContextHome)).toEqual([]);

          yield* Effect.all(
            [runAgentCliAction(config, gemini, 'install', true), runAgentCliAction(config, gemini, 'install', true)],
            {concurrency: 'unbounded'},
          );
          yield* runAgentCliAction(config, gemini, 'install', true);
          yield* runAgentCliAction(config, gemini, 'repair', true);
          yield* runAgentCliAction(config, gemini, 'remove', false);
          yield* runAgentCliAction(config, amp, 'install', true);
          yield* runAgentCliAction(config, gemini, 'remove', true);

          const events = yield* readLocalValueEvents(config.agentContextHome);
          expect(events).toHaveLength(2);
          expect(
            EffectArray.map(events, event => (event.kind === 'setup' ? event.supportedAgentReuse : undefined)),
          ).toEqual([0, 1]);
          for (const event of events) {
            // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
            expect(Object.keys(event).sort()).toEqual(
              ['completed', 'kind', 'supportedAgentReuse', 'timestamp', 'version'].sort(),
            );
          }
          const serialized = JSON.stringify(events);
          expect(serialized).not.toContain('gemini');
          expect(serialized).not.toContain('amp-cli');
          expect(serialized).not.toContain(home);
          expect(
            summarizeLocalValueEvents(events, {
              from: reportPeriod.from,
              project: 'project-filter-does-not-enter-setup-events',
              to: reportPeriod.to,
            }).setup,
          ).toEqual({
            completed: 2,
            failed: 0,
            started: 0,
            supportedAgentReuse: 1,
            timeToFirstEvidenceMillisecondsSamples: [],
          });
        }).pipe(Effect.provideService(SystemInfo, testSystem));
      }),
    ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );

  effectIt.effect('does not record an applied install that fails before registration', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-agent-value-failure-'});
        const home = path.join(root, 'user');
        const config = runtime(path.join(home, '.threadnote'));
        const testSystem = SystemInfo.of({...system, homeDirectory: home});

        yield* Effect.gen(function* () {
          const gemini = getAgentAdapter('gemini-cli')!;
          const plan = yield* planAgentSurface(config, gemini);
          yield* fs.makeDirectory(path.dirname(plan.mcpPath), {recursive: true});
          yield* fs.writeFileString(plan.mcpPath, '{"mcpServers":{"threadnote":{"command":"unowned"}}}');

          const exit = yield* runAgentCliAction(config, gemini, 'install', true).pipe(Effect.exit);

          expect(exit._tag).toBe('Failure');
          expect(yield* readLocalValueEvents(config.agentContextHome)).toEqual([]);
        }).pipe(Effect.provideService(SystemInfo, testSystem));
      }),
    ).pipe(TestClock.withLive, provideTestLayer(testLayer)),
  );
});
