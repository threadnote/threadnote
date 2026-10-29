import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import type {AgentAdapter} from '../agent_integration/adapters/contract.js';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {sha256Hex} from '@threadnote/platform/digest';
import {
  SETUP_PLAN_VERSION,
  SetupOperationError,
  type SetupOperationKind,
  type SetupPlanOperationV1,
  type SetupPlanV1,
} from './contract.js';

export interface SetupPlanInput {
  readonly adapter: AgentAdapter;
  readonly manifestPath: string;
  readonly projectRoot: string;
  readonly scope?: 'user' | 'project' | 'local';
  readonly task: string;
  readonly threadnoteVersion: string;
  readonly workflows?: {readonly bundleDigest: string; readonly disabled: boolean};
}

interface OperationDefinition {
  readonly dependsOn: readonly string[];
  readonly id: string;
  readonly kind: SetupOperationKind;
  readonly reversible: boolean;
}

export const createSetupPlan = Effect.fn('setup.createPlan')(function* (input: SetupPlanInput) {
  if (input.adapter.catalog.capabilities.hooks.status === 'managed' && input.adapter.hooks === undefined)
    return yield* SetupOperationError.make({
      message: `${input.adapter.catalog.displayName} advertises managed hooks without an executable adapter strategy.`,
    });
  const taskHash = yield* sha256Hex(input.task);
  const repositoryIdentity = yield* resolveRepositoryIdentity(input.projectRoot);
  const repositoryIdentityHash = yield* sha256Hex(
    JSON.stringify({
      headCommit: repositoryIdentity.headCommit,
      repositoryId: repositoryIdentity.repositoryId,
      worktreeId: repositoryIdentity.worktreeId,
    }),
  );
  const adapterContractHash = yield* sha256Hex(
    JSON.stringify({
      adapterVersion: input.adapter.adapterVersion,
      agentId: input.adapter.catalog.agentId,
      capabilities: input.adapter.catalog.capabilities,
      hooks: input.adapter.hooks,
      json: input.adapter.json,
      kind: input.adapter.kind,
      lastVerified: input.adapter.catalog.lastVerified,
      scopes: input.adapter.catalog.scopes,
    }),
  );
  const definitions = setupOperationDefinitions(input.adapter, input.workflows !== undefined);
  const operations: SetupPlanOperationV1[] = [];
  for (const operation of definitions) {
    operations.push({
      ...operation,
      inputHash: yield* sha256Hex(
        JSON.stringify({
          kind: operation.kind,
          adapterContractHash,
          manifestPath: input.manifestPath,
          projectRoot: input.projectRoot,
          repositoryIdentityHash,
          scope: input.scope,
          surfaceId: input.adapter.catalog.id,
          taskHash: operation.kind === 'context-brief.verify' ? taskHash : undefined,
          threadnoteVersion: input.threadnoteVersion,
          ...(operation.kind === 'dev-skills.ensure' ? {workflows: input.workflows, profile: 'desktop'} : {}),
        }),
      ),
    });
  }
  const base = {
    ...(input.workflows ? {workflows: input.workflows} : {}),
    adapterContractHash,
    manifestPath: input.manifestPath,
    operations,
    projectRoot: input.projectRoot,
    repositoryIdentityHash,
    ...(input.scope === undefined ? {} : {scope: input.scope}),
    surfaceId: input.adapter.catalog.id,
    taskHash,
    threadnoteVersion: input.threadnoteVersion,
    type: 'threadnote-setup-plan' as const,
    version: SETUP_PLAN_VERSION,
  };
  return {...base, planHash: yield* sha256Hex(JSON.stringify(base))} satisfies SetupPlanV1;
});

export function setupOperationDefinitions(adapter: AgentAdapter, workflows = false): readonly OperationDefinition[] {
  const operations: OperationDefinition[] = [
    {dependsOn: [], id: 'core', kind: 'core.ensure', reversible: false},
    {dependsOn: ['core'], id: 'manifest', kind: 'manifest.ensure', reversible: true},
    {dependsOn: ['manifest'], id: 'seed', kind: 'project.seed', reversible: false},
    {
      dependsOn: ['core'],
      id: `surface:${adapter.catalog.id}`,
      kind: 'surface.ensure',
      reversible: adapter.kind === 'json',
    },
  ];
  const surfaceReady = operations.at(-1)!.id;
  if (adapter.catalog.capabilities.hooks.status === 'managed' && adapter.hooks !== undefined) {
    operations.push({
      dependsOn: [surfaceReady],
      id: `hooks:${adapter.catalog.id}`,
      kind: 'surface.hooks',
      reversible: true,
    });
  }
  if (workflows)
    operations.push({
      dependsOn: [operations.at(-1)!.id],
      id: 'dev-skills',
      kind: 'dev-skills.ensure',
      reversible: true,
    });
  const graphDependencies = ['seed', operations.at(-1)!.id];
  operations.push(
    {dependsOn: graphDependencies, id: 'graph', kind: 'graph.index', reversible: false},
    {dependsOn: ['graph'], id: 'doctor', kind: 'doctor.verify', reversible: false},
    {dependsOn: ['doctor'], id: 'context-brief', kind: 'context-brief.verify', reversible: false},
  );
  return operations;
}

export function renderSetupPlan(plan: SetupPlanV1, displayName: string): string {
  const lines = [
    `Threadnote setup plan v${plan.version} for ${displayName}`,
    `Project: ${plan.projectRoot}`,
    `Manifest: ${plan.manifestPath}`,
    `Plan: ${plan.planHash}`,
  ];
  for (const [index, operation] of plan.operations.entries()) {
    lines.push(
      `${index + 1}. ${operation.kind}${operation.dependsOn.length === 0 ? '' : ` (after ${EffectArray.join(operation.dependsOn, ', ')})`}`,
    );
  }
  return EffectArray.join(lines, '\n');
}
