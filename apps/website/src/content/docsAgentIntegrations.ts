import {Array as EffectArray} from 'effect';
import {agentCapabilityNames, agentIntegrations, capabilityLabel, tierLabels} from './agentIntegrations.js';
import type {DocsArticle, DocsSection} from './docsTypes.js';

function agentDetailsArticle(integration: (typeof agentIntegrations)[number]): DocsArticle {
  const capabilityRows = EffectArray.map(agentCapabilityNames, capability => {
    const details = integration.capabilities[capability];
    return [capabilityLabel(capability), details.status, details.reason ?? 'Managed as described by this surface.'];
  });
  capabilityRows.push([
    'Project guidance',
    integration.projectGuidance.status,
    integration.projectGuidance.status === 'managed'
      ? `Managed target: ${integration.projectGuidance.targetPath}.`
      : integration.projectGuidance.reason,
  ]);
  const officialLinks = EffectArray.join(
    EffectArray.map(integration.officialDocs, (url, index) => `[Official documentation ${index + 1}](${url})`),
    ' · ',
  );

  return {
    id: `agent-${integration.id}`,
    title: integration.displayName,
    summary: `${tierLabels[integration.tier]} support for the ${integration.id} surface.`,
    keywords: [integration.agentId, integration.id, ...integration.aliases],
    body: [
      {
        type: 'paragraph',
        text: `**Surface:** \`${integration.id}\` · **Product:** ${integration.agentId} · **Tier:** ${tierLabels[integration.tier]}.`,
      },
      {type: 'table', headers: ['Capability', 'Status', 'Notes'], rows: capabilityRows},
      {type: 'heading', text: 'Bundled development workflows'},
      {
        type: 'paragraph',
        text:
          integration.devSkills.status === 'managed'
            ? `Profile: ${integration.devSkills.profile}. Native skill scopes: ${EffectArray.join(integration.devSkills.scopes, ', ')}. Platforms: ${EffectArray.join(integration.devSkills.platforms, ', ')}. Layout: ${integration.devSkills.layout}. ${integration.devSkills.scopeReason ?? ''} See [Development workflows](/docs/development-workflows/).`
            : `Bundled development workflow installation is unsupported: ${integration.devSkills.reason}`,
      },
      {type: 'heading', text: 'Scope and platform'},
      {
        type: 'paragraph',
        text: `Scopes: ${integration.scopes.length ? EffectArray.join(integration.scopes, ', ') : 'No managed install scope.'} · Platforms: ${EffectArray.join(integration.platforms, ', ')}.`,
      },
      {type: 'heading', text: 'Setup and verification'},
      {
        type: 'list',
        items: [...integration.setup, `Last verified: ${integration.lastVerified}.`, integration.verification],
      },
      ...(integration.caveats.length
        ? ([{type: 'warning' as const, text: EffectArray.join(integration.caveats, ' ')}] as const)
        : []),
      {type: 'paragraph', text: officialLinks},
    ],
  };
}

export const agentIntegrationDocsSection: DocsSection = {
  id: 'agent-integrations',
  title: 'Agent integrations',
  description: 'Catalog-backed support tiers, lifecycle guidance, limitations, and exact surface details.',
  articles: [
    {
      id: 'development-workflows',
      title: 'Development workflows',
      summary: 'Specify, plan, implement and verify with the workflows shipped in Threadnote.',
      keywords: ['dev-spec', 'dev-plan', 'dev-cycle', 'watch-pr', 'dev-skills', 'cloud'],
      body: [
        {
          type: 'paragraph',
          text: 'Standard agent setup installs dev-spec, dev-plan, dev-cycle and watch-pr by default. They use Threadnote context, graph evidence and linked memory to connect requirements, implementation and verified closeout. Installation makes skills discoverable; it does not execute development.',
        },
        {
          type: 'table',
          headers: ['Workflow', 'Purpose'],
          rows: [
            ['dev-spec', 'Define behavior, requirements and acceptance scenarios.'],
            ['dev-plan', 'Ground architecture and implementation phases in current source.'],
            ['dev-cycle', 'Implement, review, validate and preserve verified knowledge.'],
            [
              'watch-pr',
              'Investigate CI and review issues, make scoped fixes and keep watching unless monitor-only was requested.',
            ],
          ],
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote dev-skills list
threadnote dev-skills install --agent codex --dry-run
threadnote dev-skills install --agent codex
threadnote dev-skills status --agent codex
threadnote dev-skills update --agent codex
threadnote dev-skills remove --agent codex`,
        },
        {
          type: 'paragraph',
          text: 'Use --no-dev-skills during setup to opt out. Setup, repair and start respect disabled or removed enrollment; an explicit dev-skills install enables it again. Mutation commands apply immediately; --dry-run previews without writes. The catalog and each surface page declare native skill scopes and platforms independently of MCP or instruction support.',
        },
        {type: 'heading', text: 'Manage through the app'},
        {
          type: 'paragraph',
          text: 'Open threadnote manage → Development workflows. Choose a host/profile and scope, select the exact project when needed, inspect status, preview an action and confirm it. The preview shows destinations and shared consumers. A changed target or file requires a new preview. Reload your host after installation or updates, then choose a workflow in its skill picker; Codex also supports $dev-spec, $dev-plan and $dev-cycle.',
        },
        {type: 'heading', text: 'Updates and ownership'},
        {
          type: 'paragraph',
          text: 'Manual and automatic Threadnote updates refresh enabled workflow targets across accessible data homes, even with --no-repair or --no-post-update. A laptop update does not update another machine. Edited, unowned or inaccessible targets remain pending; inspect the conflict and retry threadnote update, including at the same version. Running tasks retain their original helpers and evidence. Removal disables enrollment and preserves other consumers, edits and retained helper generations.',
        },
        {
          type: 'paragraph',
          text: 'Legacy manual or team-pack copies with the same names are reported without deletion or adoption. Move reviewed old copies out of host discovery roots before retrying. The first public default-install release includes update refresh; pre-feature updater processes cannot retroactively run that stage. An unpublished development installation crossing that first hop must retry using the newly active runtime.',
        },
        {type: 'heading', text: 'Prerequisites and personal cloud'},
        {
          type: 'paragraph',
          text: 'File installation works offline without a sharing team. Planning requires Python 3.10+, Git, ripgrep and the host’s core Threadnote integration; PR work also needs gh and repository credentials. Installation and operation readiness are shown separately. Watching does not authorize merging, force-pushing or changing protections.',
        },
        {
          type: 'paragraph',
          text: 'Personal Codex and Cursor cloud bootstrap installs workflows by default on catalog-supported platforms. Run setup, update and start inside that environment; startup maintains existing enabled enrollment. Select codex-cloud-personal or cursor-cloud-personal explicitly when managing files. Task drafts remain private and may disappear with an ephemeral workspace. Only concretely approved, sanitized durable knowledge is published and read back before draft retirement; denied or unavailable publication stays pending. Corporate and remote server profiles are outside this feature.',
        },
      ],
    },
    {
      id: 'agent-integrations',
      title: 'Supported agents',
      summary: 'Choose an exact product surface from the catalog-backed support matrix.',
      keywords: ['agents', 'integrations', 'support matrix', 'support tiers', 'catalog'],
      body: [
        {
          type: 'paragraph',
          text: 'Threadnote supports concrete host surfaces, not an undifferentiated product list. See the [supported agents matrix](/agents/) for the current catalog, including official sources and verification dates.',
        },
        {type: 'heading', text: 'Support tiers'},
        {
          type: 'table',
          headers: ['Tier', 'Meaning'],
          rows: [
            ['Full', 'Threadnote manages MCP, instructions, skills, and the lifecycle hooks the host exposes.'],
            ['Core', 'Threadnote manages MCP, instructions, and skills; the host has no suitable lifecycle API.'],
            [
              'Project-only',
              'A dedicated project artifact is safe to manage, but no stable global surface is claimed.',
            ],
            [
              'Manual / compatible',
              'Threadnote CLI and shared conventions work, but this surface has no stable managed MCP install.',
            ],
            [
              'Experimental',
              'The schema, path, or upstream contract remains version-sensitive; read the capability row before applying.',
            ],
          ],
        },
        {
          type: 'note',
          text: 'A catalog entry is not a blanket promise that every capability is managed. Use the exact surface page to check MCP, instructions, skills, hooks, scope, caveats, and setup.',
        },
      ],
    },
    {
      id: 'agent-integration-lifecycle',
      title: 'Install and manage an integration',
      summary:
        'Preview a selected supported surface, apply only the planned changes, then use doctor, repair, and uninstall.',
      keywords: ['mcp-install', 'dry run', 'doctor', 'repair', 'uninstall', 'scope'],
      body: [
        {type: 'heading', text: 'Choose a surface and scope'},
        {
          type: 'paragraph',
          text: 'Start from the [supported agents matrix](/agents/) and select the exact surface rather than assuming a product name maps to one config location. A surface may support user scope, project scope, neither, or a compatibility-only path.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `# Inspect a supported surface's setup instructions first.
threadnote agents install <surface>
threadnote agents install <surface> --apply
threadnote doctor
threadnote doctor --repair
threadnote agents remove <surface>
threadnote agents remove <surface> --apply`,
        },
        {
          type: 'paragraph',
          text: 'Dry run is the review boundary: inspect the selected root, scope, and owned artifacts before applying. Doctor reports the registered integration state; repair and uninstall must preserve unrelated host configuration and use the recorded installation root.',
        },
      ],
    },
    {
      id: 'agent-integration-limitations',
      title: 'Capabilities and limitations',
      summary: 'Interpret managed, partial, and unsupported capability states without overclaiming host support.',
      keywords: ['managed', 'partial', 'unsupported', 'hooks', 'cloud', 'legacy'],
      body: [
        {
          type: 'table',
          headers: ['Status', 'Meaning'],
          rows: [
            ['managed', 'Threadnote owns a documented integration artifact for that capability.'],
            [
              'partial',
              'The host exposes some related behavior, but the catalog caveat or reason limits what Threadnote installs or verifies.',
            ],
            ['unsupported', 'Do not expect Threadnote to write or repair this capability for that surface.'],
          ],
        },
        {type: 'heading', text: 'Project-only, cloud, and legacy surfaces'},
        {
          type: 'paragraph',
          text: 'Project-only surfaces intentionally avoid global configuration. Cloud surfaces can have different writable roots and lifecycle events from their desktop counterpart. Legacy and migration entries document compatibility boundaries; they are not a recommendation to start a new managed installation.',
        },
      ],
    },
    {
      id: 'contributing-agent-integrations',
      title: 'Contribute an agent integration',
      summary:
        'Add a static adapter, one catalog surface, representative fixtures, and the shared conformance coverage together.',
      keywords: ['adapter', 'catalog', 'fixtures', 'conformance', 'contributor'],
      body: [
        {
          type: 'list',
          items: [
            'Add one static adapter for the concrete host surface; keep product identity separate from install roots and schema details.',
            'Add the matching catalog row with tier, capability status/reasons, scope, platform, official docs, setup, caveats, verification text, and last-verified date.',
            'Add path/version fixtures and run the shared conformance checks for plan, dry run, install, doctor, repair, and uninstall.',
            'Verify catalog, adapter registry, CLI output, and this site agree before requesting review.',
          ],
        },
        {
          type: 'note',
          text: 'Do not add a hand-maintained public support list. The catalog is the source for the supported-agents page and per-surface documentation.',
        },
      ],
    },
    ...EffectArray.map(agentIntegrations, agentDetailsArticle),
  ],
};
