import {Array as EffectArray, Option as EffectOption} from 'effect';

/**
 * Named code-graph storage and protocol revisions.
 *
 * Persistent extension revisions are durable SQLite values. Keep their
 * numbers here, at the serialization boundary, and use profiles or
 * capabilities everywhere behavior depends on their meaning.
 */

export const CODE_GRAPH_CORE_SCHEMA_VERSION = 3 as const;

export const CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_REVISION = {
  citationAliasPredecessor: 2,
  foldForwardPredecessor: 3,
  endpointIndexPredecessor: 4,
  current: 8,
} as const;
export const CODE_GRAPH_SCHEMA_INITIALIZATION_CITATION_PREDECESSOR_CONTRACT_REVISION =
  CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_REVISION.citationAliasPredecessor;
export const CODE_GRAPH_SCHEMA_INITIALIZATION_CURRENT_CONTRACT_REVISION =
  CODE_GRAPH_SCHEMA_INITIALIZATION_RECEIPT_REVISION.current;

/** SQLite's schema cookie is a separate signed database-header counter. */
export const CODE_GRAPH_SQLITE_SCHEMA_COOKIE = {
  maximum: 2_147_483_647,
  minimum: -2_147_483_648,
} as const;

/** Artifact and receipt protocols evolve independently from the SQLite schema. */
export const CODE_GRAPH_PROTOCOL_VERSIONS = {
  checkpointArtifact: 1,
  checkpointImport: 1,
  checkpointRecordSchema: 1,
  checkpointSemantic: 2,
  inventoryReuseReceipt: 2,
  managerCatalogRevision: 2,
  resolutionSurface: 1,
  reusableBaseReceipt: 2,
} as const;

export const CODE_GRAPH_CHECKPOINT_FORMAT_VERSION = CODE_GRAPH_PROTOCOL_VERSIONS.checkpointArtifact;
export const CODE_GRAPH_CHECKPOINT_IMPORT_FORMAT_VERSION = CODE_GRAPH_PROTOCOL_VERSIONS.checkpointImport;
export const CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION = CODE_GRAPH_PROTOCOL_VERSIONS.checkpointRecordSchema;
export const CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION = CODE_GRAPH_PROTOCOL_VERSIONS.checkpointSemantic;
export const CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION = CODE_GRAPH_PROTOCOL_VERSIONS.inventoryReuseReceipt;
export const CODE_GRAPH_MANAGER_CATALOG_REVISION_VERSION = CODE_GRAPH_PROTOCOL_VERSIONS.managerCatalogRevision;
export const CODE_GRAPH_RESOLUTION_SURFACE_VERSION = CODE_GRAPH_PROTOCOL_VERSIONS.resolutionSurface;
export const CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION = CODE_GRAPH_PROTOCOL_VERSIONS.reusableBaseReceipt;

export const CODE_GRAPH_PERSISTENT_SCHEMA_CAPABILITIES = [
  'background-migration',
  'compact-lexical-authority',
  'worktree-reconciliation-authority',
  'removed-view-cleanup-authority',
  'citation-released-predecessor-authority',
  'citation-column-predecessor-authority',
  'checkpoint-import',
  'direct-current-contract-adoption',
  'explicit-cleanup-preparation',
  'graph-scope-authority',
  'embedding-demand',
] as const;

export type CodeGraphPersistentSchemaCapability = (typeof CODE_GRAPH_PERSISTENT_SCHEMA_CAPABILITIES)[number];

export type CodeGraphPersistentSchemaRevisionKey =
  | 'build-owner-plan'
  | 'reference-candidate'
  | 'legacy-lexical'
  | 'compact-lexical'
  | 'content-shards'
  | 'build-owner-instance'
  | 'removed-view-cleanup'
  | 'component-aggregates'
  | 'query-indexes'
  | 'evidence-cross-repository'
  | 'file-blob-authority'
  | 'inventory-reuse'
  | 'transient-spool'
  | 'sorted-spool-citation-predecessor'
  | 'citation-alias-checkpoint-predecessor'
  | 'checkpoint-import'
  | 'graph-scope-authority'
  | 'embedding-demand';

export type CodeGraphPersistentSchemaUpgradeRoute =
  | 'adopt-current-contract'
  | 'bridge-build-owner-instance'
  | 'current'
  | 'extend-checkpoint-import'
  | 'extend-graph-scope-authority'
  | 'extend-embedding-demand'
  | 'retire-legacy-references-and-rebuild'
  | 'rebuild-extensions';

export type CodeGraphPersistentSchemaCitationState = 'none' | 'released-predecessor' | 'column-predecessor' | 'current';

export interface CodeGraphPersistentSchemaRevisionProfile {
  readonly capabilities: readonly CodeGraphPersistentSchemaCapability[];
  readonly citationState: CodeGraphPersistentSchemaCitationState;
  readonly key: CodeGraphPersistentSchemaRevisionKey;
  readonly lifecycle: 'background-readable' | 'current' | 'legacy';
  readonly upgradeRoute: CodeGraphPersistentSchemaUpgradeRoute;
  readonly value: number;
}

const compact = ['compact-lexical-authority'] as const satisfies readonly CodeGraphPersistentSchemaCapability[];
const background = [...compact, 'background-migration'] as const;
const reconciliation = [...compact, 'worktree-reconciliation-authority'] as const;
const cleanup = [...reconciliation, 'removed-view-cleanup-authority'] as const;
const citationReleased = [...cleanup, 'citation-released-predecessor-authority'] as const;
const citationColumn = [...citationReleased, 'citation-column-predecessor-authority'] as const;

function profile<
  const Value extends number,
  const Key extends CodeGraphPersistentSchemaRevisionKey,
  const Lifecycle extends CodeGraphPersistentSchemaRevisionProfile['lifecycle'],
  const Route extends CodeGraphPersistentSchemaUpgradeRoute,
  const Capabilities extends readonly CodeGraphPersistentSchemaCapability[],
>(
  value: Value,
  key: Key,
  lifecycle: Lifecycle,
  upgradeRoute: Route,
  capabilities: Capabilities,
  citationState: CodeGraphPersistentSchemaCitationState = 'none',
): CodeGraphPersistentSchemaRevisionProfile & {
  readonly capabilities: Capabilities;
  readonly key: Key;
  readonly lifecycle: Lifecycle;
  readonly upgradeRoute: Route;
  readonly value: Value;
} {
  return {capabilities, citationState, key, lifecycle, upgradeRoute, value};
}

/** Historical catalog: entries and routes are append-only compatibility data. */
export const CODE_GRAPH_PERSISTENT_SCHEMA_REVISIONS = [
  profile(2, 'build-owner-plan', 'legacy', 'rebuild-extensions', []),
  profile(3, 'reference-candidate', 'legacy', 'retire-legacy-references-and-rebuild', []),
  profile(4, 'legacy-lexical', 'legacy', 'rebuild-extensions', []),
  profile(5, 'compact-lexical', 'legacy', 'rebuild-extensions', compact),
  profile(6, 'content-shards', 'background-readable', 'bridge-build-owner-instance', background),
  profile(7, 'build-owner-instance', 'background-readable', 'adopt-current-contract', [
    ...reconciliation,
    'direct-current-contract-adoption',
    'explicit-cleanup-preparation',
  ]),
  profile(8, 'removed-view-cleanup', 'background-readable', 'adopt-current-contract', [
    ...cleanup,
    'direct-current-contract-adoption',
    'explicit-cleanup-preparation',
  ]),
  profile(9, 'component-aggregates', 'background-readable', 'adopt-current-contract', [
    ...cleanup,
    'direct-current-contract-adoption',
    'explicit-cleanup-preparation',
  ]),
  profile(10, 'query-indexes', 'background-readable', 'adopt-current-contract', [
    ...cleanup,
    'direct-current-contract-adoption',
  ]),
  profile(11, 'evidence-cross-repository', 'background-readable', 'adopt-current-contract', [
    ...cleanup,
    'direct-current-contract-adoption',
  ]),
  profile(12, 'file-blob-authority', 'background-readable', 'adopt-current-contract', [
    ...cleanup,
    'direct-current-contract-adoption',
  ]),
  // r13 cannot directly advertise today's extension contract even when a
  // partial database happens to contain similarly named tables.
  profile(13, 'inventory-reuse', 'background-readable', 'rebuild-extensions', cleanup),
  profile(14, 'transient-spool', 'background-readable', 'adopt-current-contract', [
    ...cleanup,
    'direct-current-contract-adoption',
  ]),
  profile(
    15,
    'sorted-spool-citation-predecessor',
    'background-readable',
    'adopt-current-contract',
    [...citationReleased, 'direct-current-contract-adoption'],
    'released-predecessor',
  ),
  profile(
    16,
    'citation-alias-checkpoint-predecessor',
    'background-readable',
    'extend-checkpoint-import',
    [...citationColumn, 'direct-current-contract-adoption'],
    'column-predecessor',
  ),
  profile(
    17,
    'checkpoint-import',
    'background-readable',
    'extend-graph-scope-authority',
    [...citationColumn, 'checkpoint-import', 'direct-current-contract-adoption', 'explicit-cleanup-preparation'],
    'current',
  ),
  profile(
    18,
    'graph-scope-authority',
    'background-readable',
    'extend-embedding-demand',
    [
      ...citationColumn,
      'checkpoint-import',
      'direct-current-contract-adoption',
      'explicit-cleanup-preparation',
      'graph-scope-authority',
    ],
    'current',
  ),
  profile(
    19,
    'embedding-demand',
    'current',
    'current',
    [
      ...citationColumn,
      'checkpoint-import',
      'direct-current-contract-adoption',
      'explicit-cleanup-preparation',
      'graph-scope-authority',
      'embedding-demand',
    ],
    'current',
  ),
] as const satisfies readonly CodeGraphPersistentSchemaRevisionProfile[];

type CatalogProfile = (typeof CODE_GRAPH_PERSISTENT_SCHEMA_REVISIONS)[number];
const profilesByValue: ReadonlyMap<number, CatalogProfile> = new Map(
  EffectArray.map(CODE_GRAPH_PERSISTENT_SCHEMA_REVISIONS, value => [value.value, value]),
);

function requiredProfile<const Key extends CodeGraphPersistentSchemaRevisionKey>(
  key: Key,
): Extract<CatalogProfile, {readonly key: Key}> {
  const value = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      CODE_GRAPH_PERSISTENT_SCHEMA_REVISIONS,
      (profile): profile is Extract<CatalogProfile, {readonly key: Key}> => profile.key === key,
    ),
  );
  if (value === undefined) throw new Error(`Missing code graph persistent schema profile ${key}.`);
  return value;
}

export const CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT = requiredProfile('embedding-demand');
export const CODE_GRAPH_PERSISTENT_SCHEMA_CITATION_PREDECESSOR = requiredProfile('sorted-spool-citation-predecessor');
export const CODE_GRAPH_PERSISTENT_SCHEMA_CHECKPOINT_PREDECESSOR = requiredProfile(
  'citation-alias-checkpoint-predecessor',
);
export const CODE_GRAPH_PERSISTENT_SCHEMA_BACKGROUND_FLOOR = requiredProfile('content-shards');

export const CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION = CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT.value;
export const CODE_GRAPH_MINIMUM_BACKGROUND_SCHEMA_REVISION = CODE_GRAPH_PERSISTENT_SCHEMA_BACKGROUND_FLOOR.value;

export type CodeGraphPersistentSchemaRevisionObservation =
  | {readonly state: 'missing'}
  | {readonly state: 'invalid'; readonly value: unknown}
  | {readonly profile: CodeGraphPersistentSchemaRevisionProfile; readonly state: 'known'}
  | {readonly state: 'unknown-legacy'; readonly value: number}
  | {readonly state: 'newer'; readonly value: number};

export type CodeGraphPersistentSchemaUpgradePlan =
  | {readonly state: 'initialize'}
  | {readonly state: 'reject-invalid'}
  | {readonly state: 'reject-newer'; readonly value: number}
  | {
      readonly profile: CodeGraphPersistentSchemaRevisionProfile;
      readonly route: 'current';
      readonly state: 'ready';
    }
  | {
      readonly profile?: CodeGraphPersistentSchemaRevisionProfile;
      readonly route: Exclude<CodeGraphPersistentSchemaUpgradeRoute, 'current'>;
      readonly state: 'upgrade';
    };

/** Parse either an in-memory integer or the canonical decimal SQLite value. */
export function observeCodeGraphPersistentSchemaRevision(
  value: number | string | undefined,
): CodeGraphPersistentSchemaRevisionObservation {
  if (value === undefined) return {state: 'missing'};
  const parsed =
    typeof value === 'string' && /^(?:0|[1-9][0-9]{0,14})$/u.test(value)
      ? Number(value)
      : typeof value === 'number'
        ? value
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return {state: 'invalid', value};
  const known = profilesByValue.get(parsed);
  if (known !== undefined) return {profile: known, state: 'known'};
  return parsed > CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION
    ? {state: 'newer', value: parsed}
    : {state: 'unknown-legacy', value: parsed};
}

export function codeGraphPersistentSchemaProfile(
  value: number | string | undefined,
): CodeGraphPersistentSchemaRevisionProfile | undefined {
  const observation = observeCodeGraphPersistentSchemaRevision(value);
  return observation.state === 'known' ? observation.profile : undefined;
}

export function codeGraphPersistentSchemaRevisionValue(value: number | string | undefined): number | undefined {
  const observation = observeCodeGraphPersistentSchemaRevision(value);
  switch (observation.state) {
    case 'known':
      return observation.profile.value;
    case 'newer':
    case 'unknown-legacy':
      return observation.value;
    default:
      return undefined;
  }
}

export function planCodeGraphPersistentSchemaUpgrade(
  value: number | string | undefined,
): CodeGraphPersistentSchemaUpgradePlan {
  const observation = observeCodeGraphPersistentSchemaRevision(value);
  switch (observation.state) {
    case 'missing':
      return {state: 'initialize'};
    case 'invalid':
      return {state: 'reject-invalid'};
    case 'newer':
      return {state: 'reject-newer', value: observation.value};
    case 'unknown-legacy':
      return {route: 'rebuild-extensions', state: 'upgrade'};
    case 'known':
      return observation.profile.upgradeRoute === 'current'
        ? {profile: observation.profile, route: 'current', state: 'ready'}
        : {profile: observation.profile, route: observation.profile.upgradeRoute, state: 'upgrade'};
  }
}

export function codeGraphPersistentSchemaSupports(
  value: number | string | undefined,
  capability: CodeGraphPersistentSchemaCapability,
): boolean {
  return codeGraphPersistentSchemaProfile(value)?.capabilities.includes(capability) === true;
}

export function codeGraphPersistentSchemaIsCurrent(value: number | string | undefined): boolean {
  return codeGraphPersistentSchemaProfile(value)?.key === CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT.key;
}

/** Includes pre-catalog non-negative integer revisions for conservative rebuilds. */
export function codeGraphPersistentSchemaIsOlder(value: number | string | undefined): boolean {
  const observation = observeCodeGraphPersistentSchemaRevision(value);
  return (
    observation.state === 'unknown-legacy' ||
    (observation.state === 'known' && observation.profile.value < CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION)
  );
}

export function codeGraphPersistentSchemaIsCurrentOrNewer(value: number | string | undefined): boolean {
  const observation = observeCodeGraphPersistentSchemaRevision(value);
  return (
    observation.state === 'newer' ||
    (observation.state === 'known' && observation.profile.key === CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT.key)
  );
}

export function codeGraphPersistentSchemaMigrationPending(value: number | string | undefined): boolean {
  return codeGraphPersistentSchemaProfile(value)?.lifecycle === 'background-readable';
}

/** Positive newer-version evidence only; missing or malformed metadata fails through normal validation. */
export function codeGraphRuntimeSchemaRequiresReconnect(
  observedCoreSchemaVersion: number | undefined,
  observedPersistentExtensionRevision: number | undefined,
): boolean {
  return (
    (typeof observedCoreSchemaVersion === 'number' &&
      Number.isSafeInteger(observedCoreSchemaVersion) &&
      observedCoreSchemaVersion > CODE_GRAPH_CORE_SCHEMA_VERSION) ||
    observeCodeGraphPersistentSchemaRevision(observedPersistentExtensionRevision).state === 'newer'
  );
}
