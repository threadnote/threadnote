import {Clock, Effect, FileSystem, Redacted} from 'effect';
import {storeExternalCredential} from '@threadnote/integration-core/external-credentials';
import {writeSourceConfiguration} from '@threadnote/integration-core/config';
import {
  githubSourceCodec,
  sourceConfigurationFingerprint as githubFingerprint,
} from '@threadnote/integration-github/config';
import {
  linearSourceCodec,
  sourceConfigurationFingerprint as linearFingerprint,
} from '@threadnote/integration-linear/config';
import {
  pocketSourceCodec,
  sourceConfigurationFingerprint as pocketFingerprint,
} from '@threadnote/integration-pocket/config';
import {
  superhumanSourceCodec,
  sourceConfigurationFingerprint as superhumanFingerprint,
} from '@threadnote/integration-superhuman/config';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  externalDocumentManifestUri,
  externalResourceUri,
  externalSourceReceiptUri,
  renderExternalResource,
  serializeExternalDocumentManifest,
  serializeExternalSourceReceipt,
  type ExternalProvider,
  type ExternalResourceMetadata,
} from '@threadnote/store/external-resource';
import {ResourceStore} from '@threadnote/store/resource-store';
import type {RuntimeConfig} from '@threadnote/workspace/config';

const codecs = {
  github: githubSourceCodec,
  linear: linearSourceCodec,
  pocket: pocketSourceCodec,
  superhuman: superhumanSourceCodec,
};
const fingerprints = {
  github: githubFingerprint,
  linear: linearFingerprint,
  pocket: pocketFingerprint,
  superhuman: superhumanFingerprint,
};
const coverage = {
  github: 'github-conversation',
  linear: 'linear-api-text',
  pocket: 'pocket-api-text',
  superhuman: 'canvas-plain-text',
} as const;
const uuid = '11111111-1111-1111-1111-111111111111';
export const sourceEvidenceFixture = Effect.fn('test.sourceEvidenceFixture')(function* (
  config: RuntimeConfig,
  provider: ExternalProvider,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
  const raw = {
    id: 'fixture',
    type: provider,
    enabled: true,
    credential_storage: 'local',
    project: 'threadnote',
    repositories: ['synthetic/repository'],
    documents: [{id: 'document1'}],
    organization_id: uuid,
    principal_id: uuid,
    team_ids: [uuid],
    project_ids: [uuid],
  };
  const source = codecs[provider].parse(raw, 'fixture');
  // Each codec and matching fingerprint share the same discriminant.
  const configFingerprint = fingerprints[provider](source as never);
  yield* writeSourceConfiguration(config, {version: 2, sources: [source], projections: []});
  const token = 'pk_synthetic_evidence_fixture';
  yield* storeExternalCredential(config, source.id, Redacted.make(token), provider);
  const location = {home: config.agentContextHome, account: config.account, user: config.user};
  const store = yield* ResourceStore;
  const now = yield* Clock.currentTimeMillis;
  const epoch = 'c'.repeat(64);
  const metadata: ExternalResourceMetadata = {
    version: 1,
    provider,
    sourceId: source.id,
    documentId: provider === 'github' ? 'r-7-issue-1' : 'document1',
    pageId: 'page1',
    chunkId: 'chunk1',
    project: 'threadnote',
    title: 'Synthetic reviewed source',
    rendererVersion: 'renderer-v1',
    scrubberVersion: 'scrubber-v1',
    ...(provider === 'github' ? {browserLink: 'https://github.com/synthetic/repository/issues/1'} : {}),
    coverage: coverage[provider],
  };
  const resourceUri = externalResourceUri(metadata);
  const receiptUri = externalSourceReceiptUri(source.id, provider);
  const manifestUri = externalDocumentManifestUri(source.id, metadata.documentId, provider);
  yield* store.write(
    location,
    receiptUri,
    serializeExternalSourceReceipt({
      version: 1,
      provider,
      sourceId: source.id,
      accessEpoch: epoch,
      status: 'active',
      credentialFingerprint: sha256HexSync(token),
    }),
    {mode: 'upsert'},
  );
  const snapshot = (
    body: string,
    removed = false,
    status: 'active' | 'quarantined' | 'pending' = 'active',
    fetchedAt = now,
  ) => {
    const content = renderExternalResource(metadata, body);
    return store.mutateChecked(
      location,
      [
        {type: 'write', uri: resourceUri, content, options: {mode: 'upsert'}},
        {
          type: 'write',
          uri: manifestUri,
          content: serializeExternalDocumentManifest({
            version: 1,
            provider,
            sourceId: source.id,
            documentId: metadata.documentId,
            configFingerprint,
            status,
            fetchedAt,
            maxStaleMilliseconds: 86_400_000,
            accessEpoch: epoch,
            chunks: removed ? {} : {[resourceUri]: sha256HexSync(content)},
          }),
          options: {mode: 'upsert'},
        },
      ],
      Effect.void,
    );
  };
  yield* snapshot('A reviewed fact.\n\n💡 Preserve this exact fragment.');
  return {location, source, resourceUri, snapshot, receiptUri, manifestUri};
});
