import {codeGraphRuntimeAdapters} from '../code_graph/runtime_adapters.js';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer} from 'effect';
import {threadnoteCliFormatterLayer} from './cli/help.js';
import {CliOutput} from './cli/output.js';
import {HttpService} from '@threadnote/platform/http';
import {ResourceStore} from '@threadnote/store/resource-store';
import {integrationExternalSourcePolicyLayer} from '../integrations/access-policy.js';
import {sourceConfigurationLayer} from '../integrations/config.js';
import {syncSourcesBeforeRecall} from '../integrations/source.js';
import {SourceSync} from '@threadnote/integration-core/source-sync';
import {integrationCoordinatorClientLayer} from '../integrations/coordinator.js';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
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
  Layer.provide(Layer.mergeAll(resourceStoreLayer, integrationConfigurationLayer, systemLayer, commandLayer)),
);
const sourceSyncLayer = Layer.effect(
  SourceSync,
  Effect.gen(function* () {
    const services = yield* Effect.context<Effect.Services<ReturnType<typeof syncSourcesBeforeRecall>>>();
    return SourceSync.of({beforeRecall: config => syncSourcesBeforeRecall(config).pipe(Effect.provide(services))});
  }),
).pipe(Layer.provide(sourceCoordinatorLayer));
const localModelStoreLayer = LocalModelStore.layer.pipe(
  Layer.provideMerge(HttpService.layer),
  Layer.provide(systemLayer),
);
const localModelCatalogLayer = LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS);

// Keep native inference outside the application process in every runtime,
// including `bun apps/threadnote/src/standalone.ts` during development. A fatal native crash
// must only terminate the worker so optional enrichment can fail closed while
// the CLI or MCP process still stores the canonical memory.
const localModelRuntimeLayer = isolatedLocalModelRuntimeLayer().pipe(Layer.provideMerge(systemLayer));
const codeGraphStoreLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(systemLayer));
const codeGraphMaintenanceCoordinatorLayer = CodeGraphMaintenanceCoordinator.layer.pipe(
  Layer.provideMerge(Layer.merge(codeGraphStoreLayer, commandLayer)),
);
const codeGraphAnalysisLayer = CodeGraphAnalysis.layer.pipe(Layer.provideMerge(codeGraphStoreLayer));
const treeSitterRuntimeLayer = TreeSitterRuntime.layer.pipe(Layer.provide(systemLayer));
const codeGraphParserPoolLayer = CodeGraphParserPool.layer.pipe(Layer.provideMerge(systemLayer));
const codeGraphLanguagePackLayer = CodeGraphLanguagePackRegistry.layer;
const codeGraphEmbeddingLayer = CodeGraphEmbeddingIndex.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(localModelCatalogLayer, localModelRuntimeLayer, localModelStoreLayer)),
);
const codeGraphIndexerDependencies = Layer.mergeAll(
  codeGraphStoreLayer,
  codeGraphMaintenanceCoordinatorLayer,
  codeGraphEmbeddingLayer,
  codeGraphLanguagePackLayer,
  codeGraphParserPoolLayer,
  commandLayer,
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
  cliOutputLayer,
  threadnoteCliFormatterLayer,
  codeGraphQueryLayer,
  codeGraphAnalysisLayer,
  codeGraphWatcherLayer,
  commandLayer,
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

export const ApplicationLayer = ApplicationServicesLayer.pipe(
  Layer.provideMerge(codeGraphRuntimeAdapters),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(BunHttpClient.layer),
);

/**
 * Runtime application layer with explicit-consent anonymous telemetry. The
 * static ApplicationLayer remains telemetry-free for focused tests.
 */
export function applicationLayerForHome(home: string, entrypoint: 'cli' | 'mcp') {
  return telemetryLayerForHome(home, entrypoint === 'cli' ? 'invocation' : 'broker').pipe(
    Layer.provideMerge(deferredCodeAnchorRefreshSchedulerLayer.pipe(Layer.provideMerge(ApplicationLayer))),
  );
}

export {standaloneBrokerLayerForHome, StandaloneBrokerLayer};
export {telemetryLayerForHomeForTest} from './runtime-bootstrap.js';

export type ApplicationServices = Layer.Success<typeof ApplicationLayer>;
