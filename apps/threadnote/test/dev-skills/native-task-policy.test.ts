import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {it as effectIt} from '@effect/vitest';
import {describe, expect} from 'vitest';
import {EffectMcpServerAdapter, mcpToolFailureResult} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);

describe('dev-cycle workflow policy', () => {
  effectIt.effect('records the configured default policy on a new run and keeps it on replay', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const standard = {...f.config, workflowPolicyDefault: 'standard' as const};
      const init = {...f.base('init'), project: 'fixture', featureId: 'feature', profile: 'desktop'};
      expect(yield* f.call(init, standard)).toMatchObject({status: 'ok', policy: 'standard'});
      expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.state.policy).toEqual({mode: 'standard'});
      expect(yield* f.call({...init, policy: 'standard'}, standard)).toMatchObject({status: 'ok'});
      expect(yield* f.call({...init, policy: 'strict'}, standard).pipe(Effect.flip)).toMatchObject({
        code: 'binding-drift',
      });
    }).pipe(run),
  );

  effectIt.effect('leaves a run without a configured default unmarked, which reads as strict', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const initialized = yield* f.init();
      expect(initialized).not.toHaveProperty('policy');
      expect((yield* readNativeWorkflowState(f.config, 'native-run'))?.state).not.toHaveProperty('policy');
    }).pipe(run),
  );

  effectIt.effect('returns an MCP workflow refusal with its code as structured content', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const mcp = new EffectMcpServerAdapter('test', '1', 'workflow policy fixture');
      registerWorkflowTaskTool(mcp, f.config);
      const result = yield* mcp
        .invokeTool('workflow_task_view', {runId: 'missing-run', callerCwd: f.repo})
        .pipe(Effect.matchCauseEffect({onFailure: mcpToolFailureResult, onSuccess: Effect.succeed}));
      expect(result).toMatchObject({isError: true, structuredContent: {status: 'error', code: 'run-not-found'}});
    }).pipe(run),
  );
});
