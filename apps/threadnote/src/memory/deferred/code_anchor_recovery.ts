import {Effect} from 'effect';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import type {AnonymousTelemetryCodeAnchorFinalizationTrigger} from '../../effect/telemetry.js';
import {refreshRecallDerivedIndexesFromSelection} from '@threadnote/recall/mcp/refresh';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {withCodeAnchorFinalizationAnonymousTelemetry} from '../../telemetry/code_anchor_finalization.js';
import {finalizeDeferredCodeAnchorsForRoute, type DeferredCodeAnchorFinalizationRoute} from './code_anchor.js';

const AUTOMATIC_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT = 8;
// A first cold publication may need to open the graph, memory store, and recall
// invalidation boundary before it can commit the citation. Keep the ordinary
// Context Brief pass short, but give an explicit preparation command and the
// background recall worker enough bounded time to complete the recovery.
export const AUTOMATIC_DEFERRED_CODE_ANCHOR_PASS_TIMEOUT_MILLISECONDS = 5_000;

/** Fail-soft product hook for an already-published exact repository graph. */
export const healAnchorsAfterGraphIndex = Effect.fn('memoryCodeAnchor.healAfterGraphIndex')(function* (
  config: RuntimeConfig,
  callerCwd: string,
  identity: Pick<RepositoryIdentity, 'repositoryId' | 'worktreeId'>,
) {
  yield* healAnchorsForRoute(config, 'graph-index', {
    callerCwd,
    kind: 'repository',
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
  }).pipe(Effect.ignoreCause);
});

/** Fail-soft product hook for an already-published ready Workset generation. */
export const healAnchorsAfterWorksetPrepare = Effect.fn('memoryCodeAnchor.healAfterWorksetPrepare')(function* (
  config: RuntimeConfig,
  name: string,
) {
  yield* healAnchorsForRoute(config, 'workset-prepare', {kind: 'workset', name}).pipe(Effect.ignoreCause);
});

const healAnchorsForRoute = Effect.fn('memoryCodeAnchor.healForRoute')(function* (
  config: RuntimeConfig,
  trigger: AnonymousTelemetryCodeAnchorFinalizationTrigger,
  route: DeferredCodeAnchorFinalizationRoute,
) {
  yield* withCodeAnchorFinalizationAnonymousTelemetry(
    trigger,
    Effect.gen(function* () {
      const finalizedUris: string[] = [];
      const receipt = yield* finalizeDeferredCodeAnchorsForRoute(config, route, {
        limit: AUTOMATIC_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT,
        onFinalizedUri: uri => finalizedUris.push(uri),
        passTimeoutMilliseconds: AUTOMATIC_DEFERRED_CODE_ANCHOR_PASS_TIMEOUT_MILLISECONDS,
        waitTimeoutMilliseconds: trigger === 'graph-index' ? 2_000 : 0,
      });
      if (finalizedUris.length > 0) {
        yield* refreshRecallDerivedIndexesFromSelection(config, finalizedUris);
      }
      return receipt;
    }),
  );
});
