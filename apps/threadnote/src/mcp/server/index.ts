import {Console, Effect, Logger, Schema} from 'effect';
import {MCP_PROCESS_LIFECYCLE_PROBE_ENV} from '../../constants.js';
import {
  DEFAULT_MCP_TOOLSET,
  MCP_TOOLSET_ENV,
  type McpToolset,
  isCursorCloudPersonalToolset,
  mcpToolCapabilities,
  parseMcpToolset,
} from '../toolset.js';
import {currentPackageVersion} from '../../utils.js';
import {getRuntimeConfig as getApplicationRuntimeConfig} from '../../runtime.js';
import {EffectMcpServerAdapter, McpInput, mcpProgressHeartbeatMilliseconds} from '../../effect/ai/mcp.js';
import {
  MCP_RESOURCE_MIME_TYPE,
  MCP_RESOURCE_READ_MAX_BYTES,
  readThreadnoteMcpResource,
} from '../../effect/ai/mcp_resource.js';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {captureConsole} from '../../effect/console.js';
import {monitorSharedRepositories} from '../../effect/share.js';
import {
  monitorGraphShareContributions,
  monitorGraphShareSignedContributions,
} from '@threadnote/graph/sharing/contribution/retry';
import {runCodeGraphAutomaticCompactionScheduler} from '@threadnote/graph/automatic/compaction';
import {refreshPendingDeferredCodeAnchorWorkspaces} from '../../memory/deferred/code_anchor_refresh.js';
import {runObsidianProjectionPublish} from '@threadnote/integration-obsidian/projection';
import {withProductionLogging} from '../../effect/production_log.js';
import {withAnonymousTelemetry} from '../../effect/telemetry.js';
import {
  CURSOR_CLOUD_LOCAL_MCP_TOOLSET,
  CURSOR_CLOUD_MEMORY_ENDPOINT_ENV,
  CURSOR_CLOUD_MODE_ENV,
  cursorCloudRemoteHybridStatus,
  cursorCloudScopeRoots,
  resolveCursorCloudMemoryScope,
  type CursorCloudMemoryScope,
} from '../../cursor/cloud.js';
import {runCursorAttestationChallenge} from '../../cursor/cloud_attestation.js';
import {
  McpServerOperationError,
  type RecallProgressTiming,
  type RuntimeConfig,
  optionalResourceUri,
  rejectLeadingDash,
  requiredResourceUri,
  requiredResourceUriList,
  requiredText,
  setMcpStartupVersion,
  uriSegment,
  withStaleVersionNotice,
} from './common.js';
import {registerCodeGraphTool, registerContextBriefTool} from './code_graph.js';
import {
  registerArchiveTool,
  registerCandidateMemoryTools,
  registerReadTool,
  registerRecallFeedbackTool,
  registerSearchTool,
} from './recall.js';
import {registerListTool} from './list.js';
import {registerFinalizeCodeRefsTool, registerStoreTool} from './store.js';
import {registerObsidianEvidenceTools} from './obsidian_evidence.js';
import {
  registerCompactTool,
  runNativeAddResourceTool,
  runNativeGlobTool,
  runNativeGrepTool,
  runNativeHealthTool,
  runNativeRemoveTool,
} from './memory.js';
import {runContextMaintenanceScheduler} from '../../memory/context/maintenance.js';
import {registerContextMaintenanceTools} from './context/maintenance.js';
import {registerContextHealthTool} from './context/health.js';
import {registerContextHealthRepairTools} from './context/health_repair.js';
import {registerMaintenanceMetadataTools} from './maintenance_metadata.js';
import {registerKnowledgeDeltaGitProposalTool} from './git_proposal.js';
import {registerProcedurePublicationTools} from './procedure.js';
import {registerActivationProofTool} from './activation.js';
import {
  runInstallSharedSkillTool,
  runListSharedSkillsTool,
  runShareBundleTool,
  runShareConflictResolveTool,
  runShareConflictShowTool,
  runShareConflictsTool,
  runSharePublishTool,
  runShareSkillTool,
  runThreadnoteGuideTool,
} from './share.js';

const MCP_PROGRESS_TEST_SHARED_SYNC_DELAY_ENV = 'THREADNOTE_TEST_MCP_PROGRESS_SHARED_SYNC_DELAY_MILLISECONDS';
const MCP_PROGRESS_TEST_SHARED_SYNC_DELAY_MAX_MILLISECONDS = 1_000;
function mcpProgressTestSharedSyncDelayMilliseconds(environment: NodeJS.ProcessEnv): number {
  if (environment.NODE_ENV !== 'test') return 0;
  const configured = Number(environment[MCP_PROGRESS_TEST_SHARED_SYNC_DELAY_ENV]);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, MCP_PROGRESS_TEST_SHARED_SYNC_DELAY_MAX_MILLISECONDS)
    : 0;
}

export const mcpServerEffect = withAnonymousTelemetry(
  {component: 'mcp', operation: 'mcp-server'},
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    const config = yield* getRuntimeConfig();
    return yield* withProductionLogging(
      config.agentContextHome,
      {component: 'mcp', operation: 'mcp-server'},
      Effect.gen(function* () {
        const toolset = yield* Effect.try({
          try: () => parseMcpToolset(system.environment()[MCP_TOOLSET_ENV] ?? DEFAULT_MCP_TOOLSET),
          catch: cause =>
            Schema.is(McpServerOperationError)(cause)
              ? cause
              : McpServerOperationError.make({message: cause instanceof Error ? cause.message : String(cause), cause}),
        });
        const recallProgressTiming: RecallProgressTiming = {
          heartbeatMilliseconds: mcpProgressHeartbeatMilliseconds(system.environment()),
          sharedSyncDelayMilliseconds: mcpProgressTestSharedSyncDelayMilliseconds(system.environment()),
        };
        const memoryScope = isCursorCloudPersonalToolset(toolset)
          ? yield* resolveCursorCloudMemoryScope(config, system.environment())
          : undefined;
        setMcpStartupVersion(yield* currentPackageVersion().pipe(Effect.orElseSucceed(() => undefined)));
        const instructions = memoryScope
          ? `Personal Cursor Cloud uses one MCP bounded to these Git memory shares: ${memoryScope.shares.map(share => `${share.team} (${share.root})`).join(', ')}. Call recall_context with an absolute callerCwd; optionally pass team to narrow recall. Results are unread pointers, not evidence, so read relevant threadnote:// URIs with read_context. With multiple shares, durable remember_context writes require team; writes are committed and pushed only to that share. Memory tools reject URIs outside the configured share set.`
          : toolset === CURSOR_CLOUD_LOCAL_MCP_TOOLSET
            ? 'Cursor Cloud remote-hybrid mode uses this local server only for checkout-specific code graph evidence, diagnostics, and workload attestation. All historical memory reads and writes belong to the managed threadnote-memory HTTP server. Never fall back to local personal memory or a Git memory share.'
            : 'Threadnote offers bounded context, graph, and memory tools. Choose the tool whose description matches the evidence gap; verify returned evidence in source. Writes stay private unless sharing is confirmed. Never auto-apply/share or store secrets, credentials, customer data, or raw logs.';
        const server = new EffectMcpServerAdapter(
          'threadnote-local-adapter',
          '0.2.0',
          instructions,
          config.agentContextHome,
        );

        if (mcpToolCapabilities(toolset).memoryRead) registerResources(server, config, memoryScope);
        registerTools(server, config, toolset, recallProgressTiming, memoryScope);
        // Packaged lifecycle coverage uses runtime diagnostics to create the real
        // crash-isolated child without requiring an installed or selected model.
        if (system.environment()[MCP_PROCESS_LIFECYCLE_PROBE_ENV] === '1') {
          const runtime = yield* LocalModelRuntime;
          yield* runtime.diagnostics.pipe(Effect.catch(() => Effect.void));
        }
        if (!memoryScope && toolset !== CURSOR_CLOUD_LOCAL_MCP_TOOLSET) {
          yield* Effect.forkScoped(runContextMaintenanceScheduler(config));
        }
        if (!memoryScope && toolset !== CURSOR_CLOUD_LOCAL_MCP_TOOLSET) {
          yield* Effect.forkScoped(monitorSharedRepositories(config));
        }
        if (mcpToolCapabilities(toolset).graphLocal) {
          yield* Effect.forkScoped(runCodeGraphAutomaticCompactionScheduler(config.agentContextHome));
          yield* Effect.forkScoped(monitorGraphShareContributions(config.agentContextHome));
          yield* Effect.forkScoped(monitorGraphShareSignedContributions(config.agentContextHome));
        }
        if (mcpToolCapabilities(toolset).memoryRead && mcpToolCapabilities(toolset).graphLocal) {
          yield* Effect.forkScoped(refreshPendingDeferredCodeAnchorWorkspaces(config));
        }
        yield* Console.error('Threadnote local MCP adapter running');
        return yield* server.run();
      }),
    );
  }).pipe(
    // MCP stdio reserves stdout for JSON-RPC frames. Route every Effect log in
    // this process to stderr. server.run() already does this for protocol
    // handling, but background fibers forked above (share/graph monitors) run
    // outside that scope, and a single pretty-logger warning on stdout
    // interleaves with protocol output and fails the client transport.
    Effect.provideService(Logger.LogToStderr, true),
  ),
);

function registerResources(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  memoryScope?: CursorCloudMemoryScope,
): void {
  server.registerResourceTemplate(
    {
      description: `Read one canonical Threadnote URI or bounded threadnote://memory/tn_ identity selector already returned by Threadnote. This template does not enumerate private memories; resources/read and read_context cap complete text at ${MCP_RESOURCE_READ_MAX_BYTES} bytes.`,
      meta: {'threadnote.io/max-resource-bytes': MCP_RESOURCE_READ_MAX_BYTES},
      mimeType: MCP_RESOURCE_MIME_TYPE,
      name: 'Threadnote canonical resource',
      // Effect's MCP registry uses find-my-way route syntax internally. A
      // catch-all lets the handler return an explicit invalid-URI protocol
      // error instead of the registry's ambiguous empty-content fallback.
      routerPath: '*',
      uriTemplate: 'threadnote://{+resourcePath}',
    },
    uri => readThreadnoteMcpResource(config, uri, memoryScope ? cursorCloudScopeRoots(memoryScope) : undefined),
  );
}

function registerCursorCloudLocalTools(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'cursor_cloud_status',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Check the local graph plane and remote-memory configuration independently. This never reads local memory or tests Cursor-managed OAuth credentials.',
      inputSchema: {
        callerCwd: McpInput.string('Required absolute path to the current Cursor Cloud checkout'),
      },
    },
    Effect.fn('mcp_server.cursorCloudStatus')(function* ({callerCwd}) {
      const checkedCwd = requiredText(callerCwd, 'cursor_cloud_status', 'callerCwd', {
        callerCwd: '/workspace/repository',
      });
      if (!checkedCwd.ok) return checkedCwd.error;
      const system = yield* SystemInfo;
      const environment = system.environment();
      const endpoint = environment[CURSOR_CLOUD_MEMORY_ENDPOINT_ENV]?.trim();
      if (!endpoint) {
        throw McpServerOperationError.make({
          message: `${CURSOR_CLOUD_MEMORY_ENDPOINT_ENV} is required when ${CURSOR_CLOUD_LOCAL_MCP_TOOLSET} is selected.`,
        });
      }
      const mode = environment[CURSOR_CLOUD_MODE_ENV]?.trim() === 'org' ? 'org' : undefined;
      const receipt = yield* cursorCloudRemoteHybridStatus(config, {
        cwd: checkedCwd.value,
        endpoint,
        ...(mode ? {mode} : {}),
      });
      return {
        content: [{type: 'text' as const, text: JSON.stringify(receipt)}],
        structuredContent: receipt,
      };
    }),
  );

  server.registerTool(
    'complete_cursor_attestation',
    {
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
      description:
        'Complete a Threadnote challenge with Cursor workload identity. The local server mints the nonce-bound OIDC JWT and sends it directly to the configured Threadnote origin; the token is never returned to the model.',
      inputSchema: {
        audience: McpInput.string('HTTPS audience returned by begin_cursor_attestation'),
        challengeId: McpInput.string('Opaque challenge ID returned by begin_cursor_attestation'),
        completionUrl: McpInput.string('HTTPS completion URL returned by begin_cursor_attestation'),
        expiresAt: McpInput.string('Challenge expiry returned by begin_cursor_attestation'),
        nonce: McpInput.string('Nonce returned by begin_cursor_attestation'),
      },
    },
    Effect.fn('mcp_server.completeCursorAttestation')(function* (challenge) {
      const system = yield* SystemInfo;
      const endpoint = system.environment()[CURSOR_CLOUD_MEMORY_ENDPOINT_ENV]?.trim();
      if (!endpoint) {
        throw McpServerOperationError.make({
          message: `${CURSOR_CLOUD_MEMORY_ENDPOINT_ENV} is required when ${CURSOR_CLOUD_LOCAL_MCP_TOOLSET} is selected.`,
        });
      }
      const receipt = yield* runCursorAttestationChallenge(challenge, endpoint);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Cursor workload attestation completed: ${receipt.attestationId}`,
          },
        ],
        structuredContent: receipt,
      };
    }),
  );
}

const getRuntimeConfig = Effect.fn('mcpServer.getRuntimeConfig')(function* () {
  return yield* getApplicationRuntimeConfig();
});

function registerTools(
  server: EffectMcpServerAdapter,
  config: RuntimeConfig,
  toolset: McpToolset,
  recallProgressTiming: RecallProgressTiming,
  memoryScope?: CursorCloudMemoryScope,
): void {
  const capabilities = mcpToolCapabilities(toolset);
  if (capabilities.memoryRead) {
    registerActivationProofTool(server, config);
    registerSearchTool(
      server,
      config,
      'recall_context',
      'Search memory by query, or navigate verified one-hop relations with memoryRefs alone. Results are unread threadnote:// pointers, not evidence; read useful ones with read_context.',
      recallProgressTiming,
      memoryScope,
    );
  }
  if (toolset === 'full') {
    registerSearchTool(
      server,
      config,
      'search',
      'Compatibility alias for recall_context. Searches both personal memories and seeded project resources; see recall_context for the query conventions.',
      recallProgressTiming,
    );
  }

  if (capabilities.graphLocal) registerCodeGraphTool(server, config, {allowWorkset: capabilities.graphWorkset});
  if (capabilities.contextBrief) registerContextBriefTool(server, config);

  if (capabilities.memoryRead) {
    registerReadTool(
      server,
      config,
      'read_context',
      'Read a recalled threadnote:// or compact memories/ pointer as evidence.',
      memoryScope,
    );
  }
  if (toolset === 'full') {
    registerReadTool(server, config, 'read', 'Compatibility alias for read_context.');
  }

  if (capabilities.memoryRead) {
    registerListTool(
      server,
      config,
      'list_context',
      'List a threadnote:// directory returned by recall_context.',
      memoryScope,
    );
  }
  if (toolset === 'full') {
    registerListTool(server, config, 'list', 'Compatibility alias for list_context.');
  }

  if (capabilities.memoryWrite) {
    registerStoreTool(server, config, 'remember_context', 'Store memory.', memoryScope);
    registerFinalizeCodeRefsTool(server, config);
  }
  if (toolset === 'core' || toolset === 'full') registerObsidianEvidenceTools(server, config);
  if (toolset === 'full') {
    registerStoreTool(server, config, 'store', 'Compatibility alias for remember_context.');
  }

  if (capabilities.memoryReview) registerCandidateMemoryTools(server, config);

  if (toolset === CURSOR_CLOUD_LOCAL_MCP_TOOLSET) registerCursorCloudLocalTools(server, config);

  if (capabilities.memoryPublish)
    server.registerTool(
      'obsidian_publish',
      {
        annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true},
        description:
          'Preview or publish selected memories to a configured Obsidian projection. Preview is the default.',
        inputSchema: {
          apply: McpInput.boolean('Write selected memories and persist the projection'),
          force: McpInput.boolean('Regenerate managed files already in this projection'),
          projection: McpInput.string('Configured Obsidian projection identifier'),
          uri: McpInput.stringOrStrings('Canonical Threadnote memory URI(s)'),
          uris: McpInput.stringOrStrings('Alias for uri'),
        },
      },
      ({apply, force, projection, uri, uris}) => {
        const checkedProjection = requiredText(projection, 'obsidian_publish', 'projection', {
          projection: 'engineering-memory',
          uri: 'threadnote://user/example/memories/durable/projects/threadnote/obsidian.md',
        });
        if (!checkedProjection.ok) {
          return checkedProjection.error;
        }
        const checkedUris = requiredResourceUriList(
          uris ?? uri,
          'obsidian_publish',
          'threadnote://user/example/memories/durable/projects/threadnote/obsidian.md',
        );
        if (!checkedUris.ok) {
          return checkedUris.error;
        }
        return captureConsole(
          runObsidianProjectionPublish(config, {
            apply,
            force,
            id: checkedProjection.value,
            uris: checkedUris.value,
          }),
        ).pipe(
          Effect.map(({output, value}) => ({
            content: [{type: 'text' as const, text: output}],
            structuredContent: {
              applied: apply === true,
              entries: value,
              projection: checkedProjection.value,
              uris: checkedUris.value,
            },
          })),
        );
      },
    );

  if (capabilities.lifecycle) {
    registerContextHealthTool(server, config);
    if (toolset === 'full') registerContextMaintenanceTools(server, config);
    registerContextHealthRepairTools(server, config);
    registerMaintenanceMetadataTools(server, config);
    registerRecallFeedbackTool(server, config);
  }

  if (capabilities.maintenance) {
    registerArchiveTool(
      server,
      config,
      'archive_context',
      'Archive a memory so it remains readable as provenance but is no longer current working context.',
    );
    registerArchiveTool(server, config, 'archive', 'Compatibility alias for archive_context.');
    registerCompactTool(server, config);
  }

  server.registerTool(
    'threadnote_guide',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Return a state-aware Threadnote capability tour. Present it conversationally, one step at a time.',
      inputSchema: {},
    },
    Effect.fn('mcp_server.callback')(function* () {
      return yield* runThreadnoteGuideTool(config, toolset);
    }),
  );

  if (capabilities.memoryPublish) {
    registerKnowledgeDeltaGitProposalTool(server, config);
    if (capabilities.lifecycle) registerProcedurePublicationTools(server, config);
  }

  if (capabilities.memoryPublish)
    server.registerTool(
      'share_publish',
      {
        annotations: {readOnlyHint: false, destructiveHint: true},
        description:
          'Publish a personal durable to the team repo after scanning; removes the source after push. Confirm first; never publish handoffs or preferences.',
        inputSchema: {
          allowUncitedPendingCodeRefs: McpInput.boolean(
            'Allow pending citations; discard private intent only after source removal.',
          ),
          message: McpInput.string('Commit message override; defaults to "share: publish <path>"'),
          preview: McpInput.boolean('Shared bytes without writing or committing.'),
          push: McpInput.boolean('Push to remote after committing; defaults to true'),
          redact: McpInput.boolean('Replace soft-leak local paths with placeholders; credentials still block.'),
          team: McpInput.string('Team name; defaults to the configured default team'),
          uri: McpInput.string('Required threadnote:// memory URI to publish'),
        },
      },
      ({allowUncitedPendingCodeRefs, message, preview, push, redact, team, uri}) => {
        const checkedUri = requiredResourceUri(
          uri,
          'share_publish',
          'threadnote://user/example/memories/durable/projects/foo/bar.md',
        );
        if (!checkedUri.ok) {
          return checkedUri.error;
        }
        return runSharePublishTool(config, checkedUri.value, {
          allowUncitedPendingCodeRefs,
          message,
          preview,
          push,
          redact,
          team,
        });
      },
    );

  if (!capabilities.maintenance) {
    return;
  }

  server.registerTool(
    'forget',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: 'Remove a resource from Threadnote canonical storage.',
      inputSchema: {
        recursive: McpInput.boolean('Remove a directory recursively'),
        uri: McpInput.string('Required threadnote:// URI to remove'),
      },
    },
    ({recursive, uri}) => {
      const checkedUri = requiredResourceUri(uri, 'forget', 'threadnote://user/you/memories/example.md');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return runNativeRemoveTool(config, checkedUri.value, recursive === true);
    },
  );

  server.registerTool(
    'add_resource',
    {
      annotations: {readOnlyHint: false, destructiveHint: false},
      description: 'Copy a local text file or directory into Threadnote canonical resources.',
      inputSchema: {
        description: McpInput.string('Optional import reason/description'),
        path: McpInput.string('Local source file or directory'),
        sourcePath: McpInput.string('Required local source file or directory'),
        source_path: McpInput.string('Compatibility alias for path'),
        tempFileId: McpInput.string('Native progressive upload temp file id'),
        temp_file_id: McpInput.string('Native progressive upload temp file id'),
        to: McpInput.string('Optional destination threadnote:// URI'),
        wait: McpInput.boolean('Wait for processing to finish'),
        watchInterval: McpInput.integer('Watch interval in minutes', {minimum: 0}),
        watch_interval: McpInput.integer('Watch interval in minutes', {minimum: 0}),
      },
    },
    Effect.fn('mcp_server.callback')(function* (args) {
      return yield* runNativeAddResourceTool(config, 'add_resource', {
        description: args.description,
        path: args.sourcePath ?? args.path ?? args.source_path,
        tempFileId: args.tempFileId ?? args.temp_file_id,
        to: args.to,
        wait: args.wait,
        watchInterval: args.watchInterval ?? args.watch_interval,
      });
    }),
  );

  server.registerTool(
    'grep',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Run exact text search in Threadnote canonical storage. Defaults to your memories subtree.',
      inputSchema: {
        caseInsensitive: McpInput.boolean('Case-insensitive search'),
        case_insensitive: McpInput.boolean('Case-insensitive search'),
        nodeLimit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 1000}),
        node_limit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 1000}),
        pattern: McpInput.string('Required text or regex pattern'),
        uri: McpInput.string('Optional threadnote:// subtree (defaults to your memories root)'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({
      caseInsensitive,
      case_insensitive,
      nodeLimit,
      node_limit,
      pattern,
      uri,
    }) {
      const checkedPattern = requiredText(pattern, 'grep', 'pattern', {pattern: 'unity-ui-ccc'});
      if (!checkedPattern.ok) {
        return checkedPattern.error;
      }
      const checkedLiteralPattern = rejectLeadingDash(checkedPattern.value, 'grep', 'pattern');
      if (!checkedLiteralPattern.ok) {
        return checkedLiteralPattern.error;
      }
      const checkedUri = optionalResourceUri(uri, 'grep');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return yield* runNativeGrepTool(config, {
        caseInsensitive: caseInsensitive ?? case_insensitive,
        nodeLimit: nodeLimit ?? node_limit,
        pattern: checkedLiteralPattern.value,
        uri: checkedUri.value ?? `threadnote://user/${uriSegment(config.user)}/memories`,
      });
    }),
  );

  server.registerTool(
    'glob',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Run glob file search in Threadnote canonical storage.',
      inputSchema: {
        nodeLimit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 1000}),
        node_limit: McpInput.integer('Maximum result count', {minimum: 1, maximum: 1000}),
        pattern: McpInput.string('Required glob pattern'),
        uri: McpInput.string('Optional threadnote:// subtree'),
      },
    },
    Effect.fn('mcp_server.callback')(function* ({nodeLimit, node_limit, pattern, uri}) {
      const checkedPattern = requiredText(pattern, 'glob', 'pattern', {pattern: '**/AGENTS.md'});
      if (!checkedPattern.ok) {
        return checkedPattern.error;
      }
      const checkedLiteralPattern = rejectLeadingDash(checkedPattern.value, 'glob', 'pattern');
      if (!checkedLiteralPattern.ok) {
        return checkedLiteralPattern.error;
      }
      const checkedUri = optionalResourceUri(uri, 'glob');
      if (!checkedUri.ok) {
        return checkedUri.error;
      }
      return yield* runNativeGlobTool(config, {
        nodeLimit: nodeLimit ?? node_limit,
        pattern: checkedLiteralPattern.value,
        uri: checkedUri.value ?? `threadnote://user/${uriSegment(config.user)}/memories`,
      });
    }),
  );

  server.registerTool(
    'health',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description: 'Check the self-contained Threadnote runtime and home.',
      inputSchema: {},
    },
    Effect.fn('mcp_server.callback')(function* () {
      return yield* withStaleVersionNotice(yield* runNativeHealthTool(config));
    }),
  );

  server.registerTool(
    'share_conflicts',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'List pending shared memory conflicts left by share sync reindex failures. Use this when recall/read/sync reports pending shared memory conflicts. Each result includes a stable id plus exact next-step guidance for show/resolve.',
      inputSchema: {
        team: McpInput.string('Team name; omit to inspect all configured teams'),
      },
    },
    ({team}) => runShareConflictsTool(config, {team}),
  );

  server.registerTool(
    'share_conflict_show',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'Show one pending shared memory conflict, including local native canonical store content vs shared file diff and safe resolution options. The id comes from share_conflicts and has the form team:durable/projects/.../topic.md; a shared threadnote:// URI also works.',
      inputSchema: {
        id: McpInput.string(
          'Required conflict id from share_conflicts, relative path plus team, or shared threadnote:// URI',
        ),
        team: McpInput.string('Team name when id is only a relative path'),
      },
    },
    ({id, team}) => {
      const checkedId = requiredText(id, 'share_conflict_show', 'id', {
        id: 'default:durable/projects/foo/bar.md',
      });
      if (!checkedId.ok) {
        return checkedId.error;
      }
      return runShareConflictShowTool(config, checkedId.value, {team});
    },
  );

  server.registerTool(
    'share_conflict_resolve',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Resolve one pending shared memory conflict on the user’s behalf after they choose a winner. Use take="shared" to accept the shared git file into native canonical store, take="local" to publish local native canonical store content back to the shared repo, or mergedContent to write explicit merged markdown to both places. Creates a local backup before mutation and clears only the resolved pending entry.',
      inputSchema: {
        dryRun: McpInput.boolean(
          'Preview without writing native canonical store, shared files, git commits, or pending state',
        ),
        id: McpInput.string(
          'Required conflict id from share_conflicts, relative path plus team, or shared threadnote:// URI',
        ),
        mergedContent: McpInput.string(
          'Explicit merged memory markdown. Mutually exclusive with take. MCP equivalent of CLI --from-file.',
        ),
        message: McpInput.string('Commit message when writing local or merged content to the shared repo'),
        push: McpInput.boolean('Push local/merged resolution commit to remote; defaults to true'),
        take: McpInput.literals(['shared', 'local'], 'Resolution side. Mutually exclusive with mergedContent.'),
        team: McpInput.string('Team name when id is only a relative path'),
      },
    },
    ({dryRun, id, mergedContent, message, push, take, team}) => {
      const checkedId = requiredText(id, 'share_conflict_resolve', 'id', {
        id: 'default:durable/projects/foo/bar.md',
      });
      if (!checkedId.ok) {
        return checkedId.error;
      }
      return runShareConflictResolveTool(config, checkedId.value, {
        dryRun,
        mergedContent,
        message,
        push,
        take,
        team,
      });
    },
  );

  server.registerTool(
    'share_skill',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        "Publish a local Codex/Claude/Cursor skill or Claude command markdown file into a team's shared artifact catalog. Path inference handles ~/.codex/skills/**/SKILL.md, ~/.claude/skills/**/SKILL.md, ~/.cursor/skills/**/SKILL.md, and ~/.claude/commands/**/*.md; pass agent/kind/name when sharing from another path. A skill is shared as its whole directory: companion files (scripts, references, assets) beside the SKILL.md travel with it. Default team is used unless team is provided. Pass preview=true to inspect what would land without writing or committing.",
      inputSchema: {
        agent: McpInput.literals(['codex', 'claude', 'cursor'], 'Agent owner when path inference is ambiguous'),
        allowBinary: McpInput.boolean(
          'Include binary skill files; embedded binary credentials and machine-local paths in binaries still block',
        ),
        force: McpInput.boolean('Replace an existing shared artifact with different content'),
        kind: McpInput.literals(['skill', 'command'], 'Artifact kind when path inference is ambiguous'),
        message: McpInput.string('Commit message override; defaults to "share: publish <path>"'),
        name: McpInput.string('Shared artifact name; defaults to skill directory or command file stem'),
        path: McpInput.string('Required local path to SKILL.md or a Claude command markdown file'),
        preview: McpInput.boolean('Return the bytes that would land in the shared git repo'),
        push: McpInput.boolean('Push to remote after committing; defaults to true'),
        redact: McpInput.boolean(
          'Ignored for agent artifacts. The memory-share scrubber does not run on skills, commands, or packs.',
        ),
        team: McpInput.string('Team name; defaults to the configured default team'),
      },
    },
    ({agent, allowBinary, force, kind, message, name, path, preview, push, redact, team}) => {
      const checkedPath = requiredText(path, 'share_skill', 'path', {
        path: '~/.codex/skills/example/SKILL.md',
      });
      if (!checkedPath.ok) {
        return checkedPath.error;
      }
      return runShareSkillTool(config, checkedPath.value, {
        agent,
        allowBinary,
        force,
        kind,
        message,
        name,
        preview,
        push,
        redact,
        team,
      });
    },
  );

  server.registerTool(
    'share_bundle',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        "Publish a multi-skill constellation (pack) into a team's shared artifact catalog from a threadnote-bundle.json manifest. Use this when several skills share code that lives outside any single skill directory (e.g. repo-root scripts/lib). The manifest declares name, agent, skills, include paths, external deps, and pathRewrites. Hardcoded repo-root paths are rewritten to a portable token and expanded on install. Pass preview=true to inspect what would land without writing or committing.",
      inputSchema: {
        allowBinary: McpInput.boolean(
          'Include binary files; embedded binary credentials and machine-local paths in binaries still block',
        ),
        force: McpInput.boolean('Replace existing shared pack files with different content'),
        message: McpInput.string('Commit message override'),
        path: McpInput.string('Required local path to a threadnote-bundle.json manifest'),
        preview: McpInput.boolean('Return what would land in the shared git repo without writing'),
        push: McpInput.boolean('Push to remote after committing; defaults to true'),
        redact: McpInput.boolean(
          'Ignored for agent artifacts. The memory-share scrubber does not run on skills, commands, or packs.',
        ),
        team: McpInput.string('Team name; defaults to the configured default team'),
      },
    },
    ({allowBinary, force, message, path, preview, push, redact, team}) => {
      const checkedPath = requiredText(path, 'share_bundle', 'path', {
        path: '~/src/reviewer/threadnote-bundle.json',
      });
      if (!checkedPath.ok) {
        return checkedPath.error;
      }
      return runShareBundleTool(config, checkedPath.value, {allowBinary, force, message, preview, push, redact, team});
    },
  );

  server.registerTool(
    'list_shared_skills',
    {
      annotations: {readOnlyHint: true, destructiveHint: false},
      description:
        'List shared Codex/Claude/Cursor skills, Claude commands, and skill packs available in a configured Threadnote team repo, including whether each one is already installed locally.',
      inputSchema: {
        agent: McpInput.literals(['codex', 'claude', 'cursor'], 'Optional agent filter'),
        kind: McpInput.literals(['skill', 'command', 'pack'], 'Optional kind filter'),
        name: McpInput.string('Optional shared artifact name filter'),
        team: McpInput.string('Team name; defaults to the configured default team'),
      },
    },
    ({agent, kind, name, team}) => runListSharedSkillsTool(config, {agent, kind, name, team}),
  );

  server.registerTool(
    'install_shared_skill',
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description:
        'Install one shared Codex/Claude/Cursor skill or Claude command from a configured Threadnote team repo into the local agent skill/command directory. Use list_shared_skills first to find names and disambiguate agent/kind.',
      inputSchema: {
        agent: McpInput.literals(['codex', 'claude', 'cursor'], 'Agent owner; required when name is ambiguous'),
        dryRun: McpInput.boolean('Preview install without writing local files'),
        force: McpInput.boolean('Replace an existing installed artifact with different content'),
        kind: McpInput.literals(['skill', 'command', 'pack'], 'Artifact kind; required when name is ambiguous'),
        name: McpInput.string('Required shared artifact name to install'),
        team: McpInput.string('Team name; defaults to the configured default team'),
      },
    },
    ({agent, dryRun, force, kind, name, team}) => {
      const checkedName = requiredText(name, 'install_shared_skill', 'name', {name: 'reviewer'});
      if (!checkedName.ok) {
        return checkedName.error;
      }
      return runInstallSharedSkillTool(config, checkedName.value, {agent, dryRun, force, kind, team});
    },
  );
}

export {
  codeGraphAnalysisMcpResponse,
  codeGraphAnalysisRefreshResult,
  codeGraphInspectionAllowsStaleReady,
  codeGraphInspectionObservesWorktree,
  codeGraphInspectionObservation,
  codeGraphInspectionRequestsBackgroundRefresh,
  codeGraphInspectionStartsRefresh,
  codeGraphMcpAnalysisBudget,
  codeGraphMcpAnalysisLimits,
  codeGraphMcpResponse,
  codeGraphQueryTimeoutResult,
  codeGraphRefreshBlocksReadyInspection,
  codeGraphResultWithRefreshContinuity,
  codeGraphRetryAfterMilliseconds,
  codeGraphWorksetMcpResponse,
  compactCodeGraphMcpProgress,
  compactCodeGraphMcpResult,
  compactCodeGraphMcpTiming,
  selectCodeGraphReadySnapshotForInspection,
} from './code_graph.js';
