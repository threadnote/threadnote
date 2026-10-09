import {isLinearSource} from './config.js';
import {Clock, Effect, FileSystem, Path, Redacted, Result, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ResourceStore, type ResourceStoreMutation} from '@threadnote/store/resource-store';
import {
  externalDocumentManifestUri,
  externalResourceUri,
  externalSourceReceiptUri,
  readExternalDocumentManifest,
  readExternalSourceReceipt,
  renderExternalResource,
  serializeExternalDocumentManifest,
  serializeExternalSourceReceipt,
  type ExternalDocumentManifest,
  type ExternalSourceReceipt,
} from '@threadnote/store/external-resource';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readSourceConfiguration, sourceConfigurationFingerprint, type LinearSourceConfig} from './config.js';
import {resolveLinearCredential} from './credentials.js';
import {LINEAR_RENDERER_VERSION, type LinearRenderedObject} from './render.js';
export class LinearSourceError extends Schema.TaggedError<LinearSourceError>()('LinearSourceError', {
  message: Schema.String,
}) {}
export const sourceError = (message: string) => LinearSourceError.make({message});
export const location = (config: RuntimeConfig) => ({
  account: config.account,
  home: config.agentContextHome,
  user: config.user,
});
export const linearRoot = (id: string) => `threadnote://resources/external/linear/${id}`;
export const receiptUri = (id: string) => externalSourceReceiptUri(id, 'linear');
export const receipt = (config: RuntimeConfig, id: string) => readExternalSourceReceipt(location(config), id, 'linear');
export const manifest = (config: RuntimeConfig, id: string, doc: string) =>
  readExternalDocumentManifest(location(config), id, doc, 'linear');
export const configFence = Effect.fn('linear.configFence')(function* (
  config: RuntimeConfig,
  id: string,
  fingerprint: string,
  enabled = true,
) {
  const source = (yield* readSourceConfiguration(config)).sources.find(s => s.id === id);
  if (
    !source ||
    !isLinearSource(source) ||
    (enabled && !source.enabled) ||
    sourceConfigurationFingerprint(source) !== fingerprint
  )
    return yield* sourceError('Linear source configuration changed during refresh.');
});
const credentialFence = Effect.fn('linear.credentialFence')(function* (
  config: RuntimeConfig,
  source: LinearSourceConfig,
  hash: string | undefined,
) {
  if (hash === undefined) return;
  const token = yield* resolveLinearCredential(config, source).pipe(
    Effect.mapError(() => sourceError('Linear credential changed during refresh.')),
  );
  if (sha256HexSync(Redacted.value(token)) !== hash)
    return yield* sourceError('Linear credential changed during refresh.');
});
export const saveReceipt = Effect.fn('linear.saveReceipt')(function* (
  config: RuntimeConfig,
  source: LinearSourceConfig,
  value: ExternalSourceReceipt,
  enabled = true,
) {
  yield* (yield* ResourceStore).mutateChecked(
    location(config),
    [
      {
        type: 'write',
        uri: receiptUri(source.id),
        content: serializeExternalSourceReceipt(value),
        options: {mode: 'upsert'},
      },
    ],
    configFence(config, source.id, sourceConfigurationFingerprint(source), enabled).pipe(
      Effect.andThen(
        value.status === 'active' ? credentialFence(config, source, value.credentialFingerprint) : Effect.void,
      ),
    ),
  );
});
export const listLocalDocuments = Effect.fn('linear.localDocuments')(function* (config: RuntimeConfig, id: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    config.agentContextHome,
    'data',
    config.account,
    'resources',
    'external',
    'linear',
    id,
    'docs',
  );
  if ((yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined))) !== path.resolve(directory))
    return [];
  return (yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as string[])))
    .filter(n => /^(issue|project|document|update)-[a-f0-9]{40}$/.test(n))
    .sort();
});
export const writeObject = Effect.fn('linear.writeObject')(function* (
  config: RuntimeConfig,
  source: LinearSourceConfig,
  object: LinearRenderedObject,
  access: ExternalSourceReceipt,
) {
  const fingerprint = sourceConfigurationFingerprint(source);
  const previous = yield* manifest(config, source.id, object.documentId);
  const files = object.chunks.map(chunk => {
    const metadata = {
      version: 1 as const,
      provider: 'linear' as const,
      sourceId: source.id,
      documentId: object.documentId,
      pageId: chunk.pageId,
      chunkId: chunk.chunkId,
      project: source.project,
      title: chunk.title,
      browserLink: chunk.browserLink,
      remoteRevision: chunk.remoteRevision,
      rendererVersion: LINEAR_RENDERER_VERSION,
      scrubberVersion: 'linear-no-attachments-v1',
      coverage: 'linear-api-text' as const,
    };
    const uri = externalResourceUri(metadata);
    const content = renderExternalResource(metadata, chunk.body);
    return {uri, content, hash: sha256HexSync(content)};
  });
  if (files.length > 2048) return yield* sourceError('Linear logical object exceeds chunk budget.');
  const base: ExternalDocumentManifest = {
    version: 1,
    provider: 'linear',
    sourceId: source.id,
    documentId: object.documentId,
    configFingerprint: fingerprint,
    status: 'active',
    fetchedAt: yield* Clock.currentTimeMillis,
    maxStaleMilliseconds: source.maxStaleHours * 3600000,
    chunks: Object.fromEntries(files.map(f => [f.uri, f.hash])),
    accessEpoch: access.accessEpoch,
  };
  const store = yield* ResourceStore;
  const fence = configFence(config, source.id, fingerprint).pipe(
    Effect.andThen(credentialFence(config, source, access.credentialFingerprint)),
  );
  yield* store.mutateChecked(
    location(config),
    [
      {
        type: 'write',
        uri: externalDocumentManifestUri(source.id, object.documentId, 'linear'),
        content: serializeExternalDocumentManifest({...base, status: 'pending', chunks: previous?.chunks ?? {}}),
        options: {mode: 'upsert'},
      },
    ],
    fence,
  );
  const changes: ResourceStoreMutation[] = [];
  for (const f of files) {
    if (previous?.chunks[f.uri] === f.hash) {
      const actual = yield* store.read(location(config), f.uri).pipe(Effect.result);
      if (Result.isSuccess(actual) && sha256HexSync(actual.success) === f.hash) continue;
    }
    changes.push({type: 'write', uri: f.uri, content: f.content, options: {mode: 'upsert'}});
  }
  const retained = new Set(files.map(f => f.uri));
  for (const uri of Object.keys(previous?.chunks ?? {}))
    if (!retained.has(uri)) changes.push({type: 'remove', uri, ignoreMissing: true});
  changes.push({
    type: 'write',
    uri: externalDocumentManifestUri(source.id, object.documentId, 'linear'),
    content: serializeExternalDocumentManifest(base),
    options: {mode: 'upsert'},
  });
  yield* store.mutateChecked(location(config), changes, fence);
});
export const quarantineObject = Effect.fn('linear.quarantineObject')(function* (
  config: RuntimeConfig,
  source: LinearSourceConfig,
  doc: string,
) {
  const previous = yield* manifest(config, source.id, doc);
  if (!previous) return;
  yield* (yield* ResourceStore).mutateChecked(
    location(config),
    [
      {
        type: 'write',
        uri: externalDocumentManifestUri(source.id, doc, 'linear'),
        content: serializeExternalDocumentManifest({...previous, status: 'quarantined'}),
        options: {mode: 'upsert'},
      },
    ],
    configFence(config, source.id, sourceConfigurationFingerprint(source)),
  );
});
export const removeObject = Effect.fn('linear.removeObject')(function* (
  config: RuntimeConfig,
  source: LinearSourceConfig,
  doc: string,
) {
  yield* (yield* ResourceStore).mutateChecked(
    location(config),
    [{type: 'remove', uri: `${linearRoot(source.id)}/docs/${doc}`, options: {recursive: true}, ignoreMissing: true}],
    configFence(config, source.id, sourceConfigurationFingerprint(source)),
  );
});
