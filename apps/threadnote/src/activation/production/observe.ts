import {Array as EffectArray} from 'effect';
import {Effect, Path, Schema} from 'effect';
import {getAgentAdapter, type AgentAdapter} from '../../agent_integration/adapters.js';
import {AGENT_CATALOG} from '@threadnote/integrations/catalog';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {readTeamsFile, shareTeamAccess} from '../../share/core.js';
import {parseResourceId} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {collectActivationImportPreview, type ActivationImportPreviewV1} from '../imports.js';
import {createActivationPlanV1} from '../planner.js';
import type {ActivationPlanV1} from '../contract.js';
import type {ActivationProductionRequestV1} from './contract.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export class ActivationProductionError extends Schema.TaggedError<
  ActivationProductionError,
  {readonly brand: unique symbol}
>()('ActivationProductionError', {message: Schema.String}) {}

export interface ActivationProductionObservationV1 {
  readonly imports: ActivationImportPreviewV1;
  readonly plan: ActivationPlanV1;
  readonly primaryAdapter: AgentAdapter;
  readonly repositoryId: string;
  readonly request: ActivationProductionRequestV1;
  readonly secondaryAdapter: AgentAdapter;
}

export const observeActivationProductionV1 = Effect.fn('activation.production.observe')(function* (
  config: RuntimeConfig,
  request: ActivationProductionRequestV1,
) {
  const path = yield* Path.Path;
  if (!path.isAbsolute(request.repositoryRoot)) {
    return yield* activationProductionError('Activation repositoryRoot must be absolute.');
  }
  const repository = yield* resolveRepositoryIdentity(request.repositoryRoot).pipe(
    Effect.mapError(() => activationProductionError('Activation repositoryRoot must be a readable Git repository.')),
  );
  const normalizedRequest = yield* Effect.try({
    try: () => canonicalActivationRequestV1(request),
    catch: () => activationProductionError('Activation replacement target must be a canonical Threadnote URI.'),
  });
  const primaryAdapter = yield* selectedAdapter(normalizedRequest.primarySurfaceId, normalizedRequest.scope);
  const secondaryAdapter = yield* selectedAdapter(normalizedRequest.secondarySurfaceId, normalizedRequest.scope);
  if (primaryAdapter.catalog.id === secondaryAdapter.catalog.id) {
    return yield* activationProductionError('Activation surfaces must resolve to distinct catalog entries.');
  }
  const imports = yield* collectActivationImportPreview({
    adrPaths: normalizedRequest.adrPaths,
    repositoryRoot: repository.repoRoot,
    surfaceIds: [primaryAdapter.catalog.id, secondaryAdapter.catalog.id],
  }).pipe(Effect.mapError(error => activationProductionError(error.message)));
  const teamTargetRepositoryId = yield* validateTeamTarget(config, normalizedRequest, path);
  const decisionIntent = activationDecisionPlanIdentityV1(normalizedRequest);
  const catalogSnapshotHash = sha256HexSync(
    canonicalJson(
      EffectArray.map(
        [primaryAdapter.catalog, secondaryAdapter.catalog].sort((left, right) => compareText(left.id, right.id)),
        entry => ({adapterVersion: 1, entry}),
      ),
    ),
  );
  const plan = createActivationPlanV1({
    catalogSnapshotHash,
    primarySurfaceId: primaryAdapter.catalog.id,
    publicationMode: normalizedRequest.publicationMode,
    repositoryIdentityHash: repository.repositoryId,
    secondarySurfaceId: secondaryAdapter.catalog.id,
    selectedSourceSetHash: imports.sourceSetHash,
    taskHash: sha256HexSync(
      canonicalJson({
        decision: {
          constraints: normalizedRequest.decision.constraints,
          decision: normalizedRequest.decision.decision,
          invalidated: normalizedRequest.decision.invalidated,
          operation: decisionIntent.operation,
          rationale: normalizedRequest.decision.rationale,
          replaceTargetIdentityHash: decisionIntent.replaceTargetIdentityHash,
          unresolvedRisks: normalizedRequest.decision.unresolvedRisks,
          verification: normalizedRequest.decision.verification,
        },
        project: normalizedRequest.project,
        scope: normalizedRequest.scope ?? null,
        task: normalizedRequest.task,
        team: {
          name: normalizedRequest.team.name,
          push: normalizedRequest.team.push,
          setDefault: normalizedRequest.team.setDefault,
        },
        teamTargetRepositoryId,
        topic: normalizedRequest.topic,
      }),
    ),
    teamId: normalizedRequest.team.name,
    teamShareStateHash: sha256HexSync(
      canonicalJson({repositoryId: teamTargetRepositoryId, team: normalizedRequest.team.name, version: 1}),
    ),
    threadnoteVersion: yield* getThreadnoteVersion(),
  });
  return {
    imports,
    plan,
    primaryAdapter,
    repositoryId: repository.repositoryId,
    request: {...normalizedRequest, repositoryRoot: repository.repoRoot},
    secondaryAdapter,
  } satisfies ActivationProductionObservationV1;
});

const selectedAdapter = Effect.fn('activation.production.selectedAdapter')(function* (
  selector: string,
  scope: ActivationProductionRequestV1['scope'],
) {
  const adapter = getAgentAdapter(selector);
  if (!adapter) return yield* activationProductionError(`Unknown agent surface: ${selector}`);
  if (adapter.kind === 'catalog') {
    return yield* activationProductionError(`${adapter.catalog.id} is catalog-only and cannot be activated locally.`);
  }
  if (adapter.catalog.capabilities.mcp.status === 'unsupported') {
    return yield* activationProductionError(`${adapter.catalog.id} does not support the Threadnote MCP contract.`);
  }
  if (scope !== undefined && !adapter.catalog.scopes.includes(scope)) {
    return yield* activationProductionError(`${adapter.catalog.id} does not support ${scope} scope.`);
  }
  return adapter;
});

const validateTeamTarget = Effect.fn('activation.production.validateTeamTarget')(function* (
  config: RuntimeConfig,
  request: ActivationProductionRequestV1,
  path: Path.Path,
) {
  const teams = yield* readTeamsFile(config).pipe(
    Effect.mapError(() => activationProductionError('Configured team shares could not be read.')),
  );
  const existing = teams.teams[request.team.name];
  if (existing !== undefined) {
    if (shareTeamAccess(existing) !== 'read-write') {
      return yield* activationProductionError(`Activation team ${request.team.name} must be read-write.`);
    }
    if (!path.isAbsolute(existing.worktree)) {
      return yield* activationProductionError('Activation team identity target must be an absolute local path.');
    }
    const existingIdentity = yield* resolveRepositoryIdentity(existing.worktree).pipe(
      Effect.mapError(() => activationProductionError(`Activation team ${request.team.name} is not a Git repository.`)),
    );
    if (request.team.remotePath === undefined) return existingIdentity.repositoryId;
    if (!path.isAbsolute(request.team.remotePath)) {
      return yield* activationProductionError('Activation team identity target must be an absolute local path.');
    }
    const requestedIdentity = yield* resolveRepositoryIdentity(request.team.remotePath).pipe(
      Effect.mapError(() => activationProductionError('Activation team remotePath must be a readable Git repository.')),
    );
    if (requestedIdentity.repositoryId !== existingIdentity.repositoryId) {
      return yield* activationProductionError(
        'Activation team remotePath does not match the configured team repository.',
      );
    }
    return requestedIdentity.repositoryId;
  }
  if (request.team.remotePath === undefined || !path.isAbsolute(request.team.remotePath)) {
    return yield* activationProductionError(
      `New activation team ${request.team.name} requires an absolute local Git remotePath.`,
    );
  }
  return yield* resolveRepositoryIdentity(request.team.remotePath).pipe(
    Effect.mapBoth({
      onSuccess: identity => identity.repositoryId,
      onFailure: () => activationProductionError('Activation team remotePath must be a readable local Git repository.'),
    }),
  );
});

export function activationCatalogRevisionV1(): string {
  return `agent-catalog-v1-${Effect2.pipe(sha256HexSync(canonicalJson(AGENT_CATALOG)), EffectString.slice(0, 16))}`;
}

export function activationReplacementTargetIdentityHashV1(uri: string): string {
  const canonicalUri = parseResourceId(uri).canonicalUri;
  return sha256HexSync(canonicalJson({canonicalUri, type: 'threadnote-activation-replacement-target', version: 1}));
}

export function activationDecisionPlanIdentityV1(request: ActivationProductionRequestV1): {
  readonly operation: ActivationProductionRequestV1['decision']['operation'] | null;
  readonly replaceTargetIdentityHash: string | null;
} {
  return {
    operation: request.decision.operation ?? null,
    replaceTargetIdentityHash:
      request.decision.replaceUri === undefined
        ? null
        : activationReplacementTargetIdentityHashV1(request.decision.replaceUri),
  };
}

function canonicalActivationRequestV1(request: ActivationProductionRequestV1): ActivationProductionRequestV1 {
  if (request.decision.replaceUri === undefined) return request;
  return {
    ...request,
    decision: {...request.decision, replaceUri: parseResourceId(request.decision.replaceUri).canonicalUri},
  };
}

export function activationProductionError(message: string): ActivationProductionError {
  return ActivationProductionError.make({message});
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
