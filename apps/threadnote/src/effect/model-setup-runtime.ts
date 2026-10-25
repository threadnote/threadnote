import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import * as BunServices from '@effect/platform-bun/BunServices';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {HttpService} from '@threadnote/platform/http';
import {Layer} from 'effect';
import {StandaloneBrokerLayer, systemLayer} from './runtime-bootstrap.js';

export const localModelStoreLayer = LocalModelStore.layer.pipe(
  Layer.provideMerge(HttpService.layer),
  Layer.provide(systemLayer),
);
export const localModelCatalogLayer = LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS);

export const ModelSetupWorkerLayer = Layer.mergeAll(localModelCatalogLayer, localModelStoreLayer, systemLayer).pipe(
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(BunHttpClient.layer),
);

export const ModelSetupRequestLayer = Layer.merge(ModelSetupWorkerLayer, StandaloneBrokerLayer);
