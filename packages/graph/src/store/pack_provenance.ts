import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import type {CodeGraphLanguagePackProvenance} from './models.js';
import {configureConnection, tableExists} from './session.js';
import {CODE_GRAPH_EXTRACTOR_GENERATION, CodeGraphStoreError} from '../types.js';

export const selectSnapshotPackProvenance = Effect.fn('codeGraph.selectSnapshotPackProvenance')(function* (
  snapshotId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  if (
    !(yield* tableExists(sql, 'snapshot_pack_provenance')) ||
    !(yield* tableExists(sql, 'snapshot_extractor_generations'))
  ) {
    return undefined;
  }
  const currentGeneration = yield* sql<{readonly snapshot_id: string}>`
    SELECT snapshot_id
    FROM snapshot_extractor_generations
    WHERE snapshot_id = ${snapshotId}
      AND generation >= ${CODE_GRAPH_EXTRACTOR_GENERATION}
    LIMIT 1
  `;
  if (!currentGeneration[0]) return undefined;
  const rows = yield* sql<{
    readonly cache_identity: string;
    readonly derivation_identity: string;
    readonly pack_id: string;
    readonly resolution_domain: string;
    readonly resolution_version: string;
  }>`
    SELECT pack_id, cache_identity, derivation_identity, resolution_domain, resolution_version
    FROM snapshot_pack_provenance
    WHERE snapshot_id = ${snapshotId}
    ORDER BY pack_id
  `;
  return rows.map((pack): CodeGraphLanguagePackProvenance => ({
    cacheIdentity: pack.cache_identity,
    derivationIdentity: pack.derivation_identity,
    id: pack.pack_id,
    resolutionDomain: pack.resolution_domain,
    resolutionVersion: pack.resolution_version,
  }));
});

export const recordSnapshotPackProvenance = Effect.fn('codeGraph.recordSnapshotPackProvenance')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  provenance: readonly CodeGraphLanguagePackProvenance[],
) {
  const ids = new Set<string>();
  for (const pack of provenance) {
    if (!pack.id || ids.has(pack.id)) {
      return yield* CodeGraphStoreError.of('Code graph language-pack provenance is invalid.');
    }
    ids.add(pack.id);
  }
  yield* sql`DELETE FROM snapshot_pack_provenance WHERE snapshot_id = ${snapshotId}`;
  for (const pack of provenance) {
    yield* sql`
      INSERT INTO snapshot_pack_provenance (
        snapshot_id, pack_id, cache_identity, derivation_identity,
        resolution_domain, resolution_version
      ) VALUES (
        ${snapshotId}, ${pack.id}, ${pack.cacheIdentity}, ${pack.derivationIdentity},
        ${pack.resolutionDomain}, ${pack.resolutionVersion}
      )
    `;
  }
});
