import catalog from '@threadnote/integrations/catalog.json' with {type: 'json'};

export type AgentCapabilityName = 'mcp' | 'instructions' | 'skills' | 'hooks';
export type AgentCapabilityStatus = 'managed' | 'partial' | 'unsupported';
export type AgentIntegrationTier = 'full' | 'core' | 'project' | 'manual' | 'experimental';

export interface AgentIntegration {
  readonly id: string;
  readonly agentId: string;
  readonly displayName: string;
  readonly tier: AgentIntegrationTier;
  readonly aliases: readonly string[];
  readonly scopes: readonly string[];
  readonly platforms: readonly string[];
  readonly capabilities: Readonly<
    Record<AgentCapabilityName, Readonly<{status: AgentCapabilityStatus; reason?: string}>>
  >;
  readonly projectGuidance:
    Readonly<{status: 'managed'; targetPath: string}> | Readonly<{status: 'unsupported'; reason: string}>;
  readonly officialDocs: readonly string[];
  readonly lastVerified: string;
  readonly caveats: readonly string[];
  readonly setup: readonly string[];
  readonly verification: string;
  readonly devSkills:
    | Readonly<{status: 'unsupported'; reason: string}>
    | Readonly<{
        status: 'managed';
        profile: 'desktop' | 'codex-cloud-personal' | 'cursor-cloud-personal';
        scopes: readonly string[];
        platforms: readonly string[];
        layout: 'directory' | 'flat';
        scopeReason?: string;
      }>;
}

interface AgentIntegrationCatalog {
  readonly version: number;
  readonly agents: readonly AgentIntegration[];
}

const agentIntegrationCatalog = catalog as unknown as AgentIntegrationCatalog;

export const agentIntegrationCatalogVersion = agentIntegrationCatalog.version;
export const agentIntegrations = agentIntegrationCatalog.agents;
export const agentCapabilityNames: readonly AgentCapabilityName[] = ['mcp', 'instructions', 'skills', 'hooks'];

export const tierLabels: Readonly<Record<AgentIntegrationTier, string>> = {
  full: 'Full',
  core: 'Core',
  project: 'Project-only',
  manual: 'Manual / compatible',
  experimental: 'Experimental',
};

export function capabilityLabel(capability: AgentCapabilityName): string {
  return capability === 'mcp' ? 'MCP' : capability[0].toUpperCase() + capability.slice(1);
}

export function capabilitySummary(integration: AgentIntegration): string {
  return agentCapabilityNames
    .map(capability => `${capabilityLabel(capability)}: ${integration.capabilities[capability].status}`)
    .join(' · ');
}
