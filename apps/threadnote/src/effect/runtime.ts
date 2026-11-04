import {recallReadMaintenanceLayer} from '../recall/read_maintenance.js';
import {readyRecallReadWorkerAdmissionLayer} from '../recall/ready_read_boundary.js';
import {BackgroundInferenceAdmission} from '@threadnote/inference/background/admission';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {resumeExistingCodeGraphEmbeddingDemand} from '@threadnote/graph/indexer';
import {codeGraphEmbeddingWorkerProcessLayer} from '../code_graph/embedding_worker.js';
import {recallEmbeddingWakeLayer, resumeExistingRecallEmbeddingDemand} from '../recall/embedding_worker_process.js';
import {codeGraphRuntimeAdapters} from '../code_graph/runtime_adapters.js';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer} from 'effect';
import {CommandExecutor} from '@threadnote/platform/command';
import {threadnoteCliFormatterLayer} from './cli/help.js';
import {CliOutput} from './cli/output.js';
import {ResourceStore} from '@threadnote/store/resource-store';
import {integrationExternalSourcePolicyLayer} from '../integrations/access-policy.js';
import {sourceConfigurationLayer} from '../integrations/config.js';
import {syncSourcesBeforeRecall} from '../integrations/source.js';
import {SourceSync} from '@threadnote/integration-core/source-sync';
import {integrationCoordinatorClientLayer} from '../integrations/coordinator.js';
import {isolatedLocalModelRuntimeLayer} from './ai/isolated-local-model-runtime.js';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphWatcher} from '@threadnote/graph/watcher';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import {CodeGraphAnalysis} from '@threadnote/graph/analysis';
import {CodeGraphParserPool} from '@threadnote/graph/parser_worker';
import {
  healAfterPublishedGraphIndex,
  withDeferredCodeAnchorIndexHeal,
} from '../memory/deferred/code_anchor_index_heal.js';
import {deferredCodeAnchorRefreshSchedulerLayer} from '../memory/deferred/code_anchor_refresh.js';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';
import {
  commandLayer,
  standaloneBrokerLayerForHome,
  StandaloneBrokerLayer,
  systemLayer,
  telemetryLayerForHome,
} from './runtime-bootstrap.js';
import {localModelCatalogLayer, localModelStoreLayer} from './model-setup-runtime.js';

/** Construct the same production services with request-owned commands captured by graph services. */
export function applicationLayerWithCommands(
  decorate?: (inner: ReturnType<typeof CommandExecutor.of>) => ReturnType<typeof CommandExecutor.of>,
) {
  const selectedCommandLayer =
    decorate === undefined
      ? commandLayer
      : Layer.effect(CommandExecutor, Effect.map(CommandExecutor, decorate)).pipe(Layer.provide(commandLayer));
  const cliOutputLayer = CliOutput.layer.pipe(Layer.provide(systemLayer));
  const integrationConfigurationLayer = sourceConfigurationLayer.pipe(Layer.provide(systemLayer));
  const externalSourcePolicyLayer = integrationExternalSourcePolicyLayer.pipe(
    Layer.provide(integrationConfigurationLayer),
    Layer.provide(systemLayer),
  );
  const resourceStoreLayer = ResourceStore.layer.pipe(
    Layer.provide(externalSourcePolicyLayer),
    Layer.provide(recallResourceInvalidationLayer),
    Layer.provide(systemLayer),
  );
  const sourceCoordinatorLayer = integrationCoordinatorClientLayer.pipe(
    Layer.provide(Layer.mergeAll(resourceStoreLayer, integrationConfigurationLayer, systemLayer, selectedCommandLayer)),
  );
  const sourceSyncLayer = Layer.effect(
    SourceSync,
    Effect.gen(function* () {
      const services = yield* Effect.context<Effect.Services<ReturnType<typeof syncSourcesBeforeRecall>>>();
      return SourceSync.of({beforeRecall: config => syncSourcesBeforeRecall(config).pipe(Effect.provide(services))});
    }),
  ).pipe(Layer.provide(sourceCoordinatorLayer));

  // Keep native inference outside the application process in every runtime,
  // including `bun apps/threadnote/src/standalone.ts` during development. A fatal native crash
  // must only terminate the worker so optional enrichment can fail closed while
  // the CLI or MCP process still stores the canonical memory.
  const localModelRuntimeLayer = isolatedLocalModelRuntimeLayer().pipe(Layer.provideMerge(systemLayer));
  const codeGraphStoreLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(systemLayer));
  const codeGraphMaintenanceCoordinatorLayer = CodeGraphMaintenanceCoordinator.layer.pipe(
    Layer.provideMerge(Layer.merge(codeGraphStoreLayer, selectedCommandLayer)),
  );
  const codeGraphAnalysisLayer = CodeGraphAnalysis.layer.pipe(Layer.provideMerge(codeGraphStoreLayer));
  const treeSitterRuntimeLayer = TreeSitterRuntime.layer.pipe(Layer.provide(systemLayer));
  const codeGraphParserPoolLayer = CodeGraphParserPool.layer.pipe(Layer.provideMerge(systemLayer));
  const codeGraphLanguagePackLayer = CodeGraphLanguagePackRegistry.layer;
  const codeGraphEmbeddingLayer = CodeGraphEmbeddingIndex.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(localModelCatalogLayer, localModelRuntimeLayer, localModelStoreLayer)),
  );
  const graphEmbeddingWorkerProcessLayer = codeGraphEmbeddingWorkerProcessLayer.pipe(
    Layer.provide(Layer.mergeAll(systemLayer, selectedCommandLayer)),
  );
  const codeGraphIndexerDependencies = Layer.mergeAll(
    graphEmbeddingWorkerProcessLayer,
    codeGraphStoreLayer,
    codeGraphMaintenanceCoordinatorLayer,
    codeGraphEmbeddingLayer,
    codeGraphLanguagePackLayer,
    codeGraphParserPoolLayer,
    selectedCommandLayer,
    systemLayer,
    treeSitterRuntimeLayer,
  );
  const codeGraphIndexerLayer = Layer.effect(
    CodeGraphIndexer,
    Effect.gen(function* () {
      const inner = yield* CodeGraphIndexer;
      return CodeGraphIndexer.of(
        withDeferredCodeAnchorIndexHeal(inner, (options, summary) =>
          healAfterPublishedGraphIndex(options.threadnoteHome, options.cwd, summary.identity),
        ),
      );
    }),
  ).pipe(
    Layer.provide(CodeGraphIndexer.layer.pipe(Layer.provideMerge(codeGraphIndexerDependencies))),
    Layer.provideMerge(codeGraphIndexerDependencies),
  );
  const codeGraphQueryLayer = CodeGraphQueryService.layer.pipe(Layer.provideMerge(codeGraphIndexerLayer));
  // MCP hosts detect themselves inside CodeGraphWatcher and spawn CLI `graph index`
  // children so multi-hour builds cannot starve recall_context on the stdio process.
  const codeGraphWatcherLayer = CodeGraphWatcher.layer.pipe(Layer.provideMerge(codeGraphIndexerLayer));

  const ApplicationServicesLayer = Layer.mergeAll(
    BackgroundInferenceAdmission.layer.pipe(Layer.provideMerge(systemLayer)),
    cliOutputLayer,
    graphEmbeddingWorkerProcessLayer,
    threadnoteCliFormatterLayer,
    codeGraphQueryLayer,
    codeGraphStoreLayer,
    codeGraphLanguagePackLayer,
    codeGraphAnalysisLayer,
    codeGraphWatcherLayer,
    selectedCommandLayer,
    localModelCatalogLayer,
    localModelRuntimeLayer,
    localModelStoreLayer,
    resourceStoreLayer,
    externalSourcePolicyLayer,
    integrationConfigurationLayer,
    sourceSyncLayer,
    sourceCoordinatorLayer,
    systemLayer,
  );

  return ApplicationServicesLayer.pipe(
    Layer.provideMerge(codeGraphRuntimeAdapters),
    Layer.provideMerge(Layer.merge(BunServices.layer, cryptoLayer)),
    Layer.provideMerge(BunHttpClient.layer),
  );
}
export {ModelSetupWorkerLayer} from './model-setup-runtime.js';
export const ApplicationLayer = applicationLayerWithCommands();

export const HandoffSaveWorkerLayer = recallEmbeddingWakeLayer.pipe(Layer.provideMerge(ApplicationLayer));

/**
 * Runtime application layer with explicit-consent anonymous telemetry. The
 * static ApplicationLayer remains telemetry-free for focused tests.
 */
export function applicationLayerForHome(home: string, entrypoint: 'cli' | 'mcp') {
  return telemetryLayerForHome(home, entrypoint === 'cli' ? 'invocation' : 'broker').pipe(
    Layer.provideMerge(readyRecallReadWorkerAdmissionLayer),
    Layer.provideMerge(
      deferredCodeAnchorRefreshSchedulerLayer.pipe(
        Layer.provideMerge(
          Layer.effectDiscard(
            Effect.forkScoped(
              Effect.all([resumeExistingCodeGraphEmbeddingDemand(home), resumeExistingRecallEmbeddingDemand(home)], {
                concurrency: 2,
              }).pipe(Effect.asVoid),
            ),
          ).pipe(Layer.provideMerge(recallEmbeddingWakeLayer.pipe(Layer.provideMerge(ApplicationLayer)))),
        ),
      ),
    ),
  );
}

export {standaloneBrokerLayerForHome, StandaloneBrokerLayer};
export {telemetryLayerForHomeForTest} from './runtime-bootstrap.js';

export type ApplicationServices = Layer.Success<typeof ApplicationLayer>;

/** No foreground profile can enter either automatic document worker. */
const backgroundEmbeddingWorkerLayer = Layer.mergeAll(
  localModelCatalogLayer,
  localModelStoreLayer,
  commandLayer,
  systemLayer,
  BackgroundInferenceAdmission.layer.pipe(Layer.provideMerge(systemLayer)),
  isolatedLocalModelRuntimeLayer({background: true, maximumRequestAttempts: 1}).pipe(Layer.provideMerge(systemLayer)),
).pipe(Layer.provideMerge(Layer.merge(BunServices.layer, cryptoLayer)), Layer.provideMerge(BunHttpClient.layer));
export const RecallEmbeddingWorkerLayer = recallReadMaintenanceLayer.pipe(
  Layer.provideMerge(Layer.merge(ApplicationLayer, backgroundEmbeddingWorkerLayer)),
);
export const GraphEmbeddingWorkerLayer = CodeGraphStore.layer.pipe(
  Layer.provideMerge(systemLayer),
  Layer.provideMerge(backgroundEmbeddingWorkerLayer),
);
