import {Schema, type Crypto, type FileSystem, type Path} from 'effect';
import type {Effect} from 'effect';
import type {CommandExecutor} from '@threadnote/platform/command';
import type {SystemInfo} from '@threadnote/platform/system';
import type {McpToolset} from '../../mcp/toolset.js';
import type {AgentClient, DoctorCheck} from '../../types.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {AgentCatalogEntry} from '@threadnote/integrations/catalog';
import type {AgentIntegrationRegistry, AgentSetupCompletion} from '../registry.js';

export class AgentAdapterActionError extends Schema.TaggedError<AgentAdapterActionError>()('AgentAdapterActionError', {
  message: Schema.String,
}) {}

export interface JsonAgentStrategy {
  readonly root: string;
  readonly rootEnvironment?: string;
  readonly xdg?: boolean;
  readonly windowsAppData?: boolean;
  readonly windowsRoot?: string;
  readonly defaultScope?: 'user' | 'project';
  readonly projectRoot?: string;
  readonly projectMcpFile?: string;
  readonly localMcpFile?: string;
  readonly codec?: 'json' | 'jsonc';
  readonly commandArray?: boolean;
  readonly mcpRoot?: string;
  readonly mcpRootEnvironment?: string;
  readonly mcpFile: string;
  /** Existing files in host precedence order, before falling back to mcpFile. */
  readonly mcpFileAlternatives?: readonly string[];
  readonly container: string;
  readonly instructionFile?: string;
  readonly projectInstructionFile?: string;
  readonly instructionPrefix?: string;
  readonly instructionContent?: string;
  readonly projectInstructionPrefix?: string;
  readonly skillRoot: 'native' | 'shared' | 'none' | {readonly user: string; readonly project: string};
  readonly projectSkillRoot?: string;
  readonly skillLayout?: 'flat';
  readonly entryType?: 'stdio' | 'local';
  readonly policyGlobs?: boolean;
  readonly unverifiedPolicyFile?: string;
}

export type AgentAdapterAction = 'install' | 'remove' | 'repair';

export interface AgentAdapterStatus {
  readonly state: 'absent' | 'current' | 'disabled' | 'manual' | 'stale' | 'unsupported';
  readonly detail: string;
}

export interface AgentAdapterStatusContext {
  readonly registry: AgentIntegrationRegistry | undefined;
  readonly legacyChecks: readonly DoctorCheck[];
  readonly mcpChecks: readonly DoctorCheck[];
}

/** Project-local guidance is deliberately adapter-declared, not selected by orchestration brand branches. */
export interface AgentGuidanceContract {
  /** Some hosts combine every source; others load only the first existing path in precedence order. */
  readonly importMode?: 'all-existing' | 'first-existing';
  readonly importPaths: readonly string[];
  readonly importDirectories?: readonly {
    readonly extensions: readonly string[];
    readonly relativePath: string;
  }[];
  /** Exact legacy files loaded only when no file was discovered in importDirectories. */
  readonly directoryFallbackPaths?: readonly string[];
  /** Threadnote-owned envelopes removed when their managed payload is stripped during import. */
  readonly importWrappers?: readonly {readonly prefix: string; readonly suffix: string}[];
  /** Maximum Unicode characters accepted by this host for the complete projected file. */
  readonly maxProjectionCharacters?: number;
  readonly projection: {
    readonly activeFallbackBlocker?: {
      readonly inactiveWhenImportDirectoryHasFiles?: boolean;
      readonly reason: string;
      readonly relativePath: string;
    };
    readonly relativePath: string;
    readonly wrapper?: {readonly prefix: string; readonly required?: boolean; readonly suffix: string};
  };
}

export interface AgentAdapterActionOptions {
  readonly apply: boolean;
  readonly cwd?: string;
  readonly excludedConsumers?: ReadonlySet<string>;
  readonly inTransaction?: boolean;
  readonly registry?: AgentIntegrationRegistry;
  /** @internal The caller already holds the home-wide setup mutation lock. */
  readonly setupLockHeld?: boolean;
  readonly toolset?: McpToolset;
  readonly scope?: 'user' | 'project' | 'local';
}

export type AgentAdapterRuntimeServices =
  CommandExecutor | Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo;

export type AgentAdapterMutation = (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  options: AgentAdapterActionOptions,
) => Effect.Effect<AgentIntegrationRegistry | AgentSetupCompletion | void, unknown, AgentAdapterRuntimeServices>;

export interface AgentAdapterActions {
  readonly install: AgentAdapterMutation;
  readonly remove: AgentAdapterMutation;
  readonly repair: AgentAdapterMutation;
  readonly status: (
    config: RuntimeConfig,
    adapter: AgentAdapter,
    context: AgentAdapterStatusContext,
  ) => Effect.Effect<AgentAdapterStatus, unknown, AgentAdapterRuntimeServices>;
}

export interface AgentAdapterDefinition {
  readonly actions: AgentAdapterActions;
  readonly adapterVersion: 1;
  readonly hooks?: {
    readonly client: AgentClient;
    readonly kind: 'legacy-client';
  };
  readonly guidance?: AgentGuidanceContract;
  readonly id: string;
  readonly kind: 'catalog' | 'json' | 'legacy';
  readonly legacyClient?: AgentClient;
  readonly json?: JsonAgentStrategy;
}

export interface AgentAdapter extends Omit<AgentAdapterDefinition, 'id'> {
  readonly catalog: AgentCatalogEntry;
}
