import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Console, Effect, Schema} from 'effect';
import {EffectMcpServerRegistry, EffectMcpServerAdapter, McpInput} from '../../effect/ai/mcp.js';
import {enrichMemoryMetadataWithConfiguredLocalAi} from '../../effect/ai/enrichment.js';
import {isInSharedNamespace, sharedTeamNameForUri} from '../../share/index.js';
import {MemoryCodeCitationCaptureError} from '@threadnote/context/citation/capture';
import {MAX_MEMORY_CODE_CITATIONS, MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {
  memoryCodeCitationSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';
import {MAX_MEMORY_RELATIONS, MEMORY_RELATION_TYPES, type MemoryMetadata} from '@threadnote/memory/document';
import {
  tryResolveMemoryKeywordPlan,
  shouldEnrichForKeywordPlan,
  type MemoryKeywordPlan,
} from '../../memory/keywords.js';
import {resolveLocalMemoryReplacementTarget} from '../../memory/replacement_target.js';
import {resolveAuthoredMemoryRelations} from '../../memory/relations.js';
import {
  DEFAULT_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT,
  type DeferredCodeAnchorWriteRequest,
} from '../../memory/deferred/code_anchor.js';
import {finalizeDeferredCodeAnchorsWithDerivedIndexes} from '../../memory/deferred/code_anchor_finalization.js';
import {
  cursorCloudScopeRoots,
  cursorCloudScopeTeams,
  cursorCloudShareForTeam,
  cursorCloudShareForUri,
  cursorCloudUriWithinScope,
  type CursorCloudMemoryScope,
  type CursorCloudShareScope,
} from '../../cursor/cloud.js';
import {resourceIdIsWithin} from '@threadnote/store/resource-id';
import {resolveWorkspaceComponentContext} from '../../utils.js';
import {withCodeAnchorFinalizationAnonymousTelemetry} from '../../telemetry/code_anchor_finalization.js';
import {captureMemoryCodeCitationsForMcp} from '../memory_code_citation.js';
import {
  type RuntimeConfig,
  argumentError,
  mcpErrorResult,
  normalizeOptionalMetadata,
  optionalResourceUri,
  optionalResourceUriList,
  requiredText,
  uriSegment,
  withStaleVersionNotice,
} from './common.js';
import {readMemoryRecordsByUri, writeCursorCloudSharedMemory, writeDurableMemory} from './memory.js';

export function registerStoreTool(
  server: EffectMcpServerRegistry,
  config: RuntimeConfig,
  name: string,
  description: string,
  memoryScope?: CursorCloudMemoryScope,
): void {
  const profileLabel = memoryScope?.label ?? 'Personal Cursor Cloud';
  const handoffDescription =
    name === 'remember_context'
      ? ' Handoff: task; decisions/invariants; verification; blockers/risks; next_step. CodeRefs enable compact resume. Skip Knowledge Delta review.'
      : '';
  server.registerTool(
    name,
    {
      annotations: {readOnlyHint: false, destructiveHint: true},
      description: `${description}${handoffDescription} Never store secrets, credentials, customer data, or raw logs.`,
      inputSchema: {
        callerCwd: McpInput.string('Absolute cwd'),
        codeRefs: McpInput.stringOrStrings(
          `Graph-indexed repository-relative path/cgs_/cgr_; max ${MAX_MEMORY_CODE_CITATIONS}`,
          {maximumItems: MAX_MEMORY_CODE_CITATIONS},
        ),
        citationPolicy: McpInput.literals(
          ['require-current', 'defer'],
          'defer: nonempty codeRefs; status=active (default)',
        ),
        clearKeywords: McpInput.boolean('handoff/smoke allowed'),
        kind: McpInput.literals(['durable', 'handoff', 'incident', 'preference', 'smoke']),
        keywords: McpInput.stringOrStrings('Explicit search keywords; no smoke', {
          maximumItems: 32,
        }),
        project: McpInput.string(),
        references: McpInput.stringOrStrings('Memory URI(s)'),
        relations: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              type: Schema.Literals(MEMORY_RELATION_TYPES),
              uri: Schema.String,
            }),
          )
            .check(Schema.isMaxLength(MAX_MEMORY_RELATIONS))
            .annotate({
              description: `Typed links; max ${MAX_MEMORY_RELATIONS}`,
            }),
        ),
        replaceUri: McpInput.string('Replaced memory URI'),
        regenerateKeywords: McpInput.boolean('no handoff/smoke'),
        text: McpInput.string(),
        sourceAgentClient: McpInput.string(),
        status: McpInput.literals(['active', 'archived', 'expired', 'superseded']),
        ...(memoryScope ? {team: McpInput.string(`Target ${profileLabel} share for durable memory`)} : {}),
        topic: McpInput.string(),
      },
    },
    ({
      callerCwd,
      citationPolicy,
      clearKeywords,
      codeRefs,
      keywords,
      kind,
      project,
      references,
      regenerateKeywords,
      relations,
      replaceUri,
      sourceAgentClient,
      status,
      team,
      text,
      topic,
    }) => {
      const checkedText = requiredText(text, name, 'text', {text: 'Durable engineering note...'});
      if (!checkedText.ok) {
        return checkedText.error;
      }
      const checkedReplaceUri = optionalResourceUri(replaceUri, name, 'replaceUri');
      if (!checkedReplaceUri.ok) {
        return checkedReplaceUri.error;
      }
      const checkedReferences = optionalResourceUriList(references, name);
      if (!checkedReferences.ok) {
        return checkedReferences.error;
      }
      const memoryKind = kind ?? 'durable';
      let selectedShare: CursorCloudShareScope | undefined;
      const requestedTeam = typeof team === 'string' ? team : undefined;
      if (memoryScope) {
        try {
          const teamShare = requestedTeam?.trim() ? cursorCloudShareForTeam(memoryScope, requestedTeam) : undefined;
          const replaceShare = checkedReplaceUri.value
            ? cursorCloudShareForUri(memoryScope, checkedReplaceUri.value)
            : undefined;
          if (requestedTeam?.trim() && !teamShare) {
            return argumentError(`${name} team must be one of: ${cursorCloudScopeTeams(memoryScope).join(', ')}.`);
          }
          if (memoryKind === 'durable' && checkedReplaceUri.value && !replaceShare) {
            return argumentError(`${name} replaceUri must stay within a configured ${profileLabel} share.`);
          }
          if (teamShare && replaceShare && teamShare.team !== replaceShare.team) {
            return argumentError(`${name} team must match the share containing replaceUri.`);
          }
          selectedShare = teamShare ?? replaceShare ?? cursorCloudShareForTeam(memoryScope, undefined);
        } catch (error) {
          return argumentError(error instanceof Error ? error.message : String(error));
        }
        if (memoryKind === 'durable' && !selectedShare) {
          return argumentError(
            `${name} requires team when several ${profileLabel} shares are configured: ${cursorCloudScopeTeams(memoryScope).join(', ')}.`,
          );
        }
      }
      if (memoryScope && memoryKind !== 'durable' && memoryKind !== 'handoff') {
        return argumentError(
          `${name} supports durable shared memories and transient local handoffs in the ${memoryScope?.label ?? 'Cursor Cloud'} profile.`,
        );
      }
      if (memoryScope) {
        const outsideReference = checkedReferences.value?.find(reference =>
          memoryKind === 'durable'
            ? !resourceIdIsWithin(reference, selectedShare!.root)
            : !cursorCloudUriWithinScope(memoryScope, reference),
        );
        if (outsideReference) {
          return argumentError(
            `${name} references must stay within ${memoryKind === 'durable' ? `the selected share ${selectedShare!.team}` : `the configured ${profileLabel} shares`}.`,
          );
        }
        const handoffRoot = `threadnote://user/${uriSegment(config.user)}/memories/handoffs`;
        if (
          memoryKind === 'handoff' &&
          checkedReplaceUri.value &&
          !resourceIdIsWithin(checkedReplaceUri.value, handoffRoot)
        ) {
          return argumentError(`${name} local handoff replaceUri must stay within ${handoffRoot}.`);
        }
      }
      const metadata: MemoryMetadata = {
        kind: memoryKind,
        project: normalizeOptionalMetadata(project),
        references: checkedReferences.value,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        sourceAgentClient: sourceAgentClient ?? 'mcp',
        status: status ?? 'active',
        timestamp: new Date().toISOString(),
        topic: normalizeOptionalMetadata(topic),
      };
      return Effect.gen(function* () {
        const requestedCodeRefs = stringList(codeRefs);
        if (citationPolicy === 'defer' && requestedCodeRefs.length === 0) {
          return argumentError(`${name} citationPolicy=defer requires at least one codeRef.`);
        }
        if (citationPolicy === 'defer' && metadata.status !== 'active') {
          return argumentError(`${name} citationPolicy=defer requires status=active.`);
        }
        if (requestedCodeRefs.length > 0 && !callerCwd) {
          return argumentError(`${name} requires absolute callerCwd when codeRefs are provided.`);
        }
        const replacement =
          memoryScope === undefined && checkedReplaceUri.value
            ? yield* resolveLocalMemoryReplacementTarget(config, checkedReplaceUri.value)
            : undefined;
        const replaceUri = replacement?.canonicalUri ?? checkedReplaceUri.value;
        const sharedTarget =
          (memoryScope !== undefined && memoryKind === 'durable') ||
          (replaceUri !== undefined && isInSharedNamespace(config, replaceUri));
        const effectiveCitationPolicy =
          citationPolicy ??
          (requestedCodeRefs.length > 0 && !sharedTarget && metadata.status === 'active' ? 'defer' : 'require-current');
        const captured = yield* captureMemoryCodeCitationsForMcp(
          config,
          {callerCwd: callerCwd!, ...(project === undefined ? {} : {project}), refs: requestedCodeRefs},
          name,
        );
        const deferredCodeAnchor: DeferredCodeAnchorWriteRequest | undefined =
          !captured.ok &&
          effectiveCitationPolicy === 'defer' &&
          Schema.is(MemoryCodeCitationCaptureError)(captured.failure) &&
          captured.failure.recovery
            ? {
                callerCwd: callerCwd!,
                codeRefs: requestedCodeRefs,
                ...(project === undefined ? {} : {project}),
                recovery: captured.failure.recovery,
              }
            : undefined;
        if (!captured.ok && !deferredCodeAnchor) return captured.error;
        if (deferredCodeAnchor && sharedTarget) {
          return argumentError(`${name} deferred code anchors are private-local and cannot write shared memory.`);
        }
        const codeCitations = captured.ok ? captured.citations : ([] as const);
        const workspaceComponent = callerCwd
          ? yield* resolveWorkspaceComponentContext({cwd: callerCwd, includeProcessCwd: false})
          : undefined;
        const replaced = replacement?.record;
        const [remoteReplaced] =
          replacement === undefined && replaceUri ? yield* readMemoryRecordsByUri(config, [replaceUri]) : [];
        const replaceTarget = replaced ?? remoteReplaced;
        const sharedTeam = replaceUri ? sharedTeamNameForUri(config, replaceUri) : undefined;
        const relationScopes = memoryScope
          ? memoryKind === 'durable'
            ? [selectedShare!.root]
            : cursorCloudScopeRoots(memoryScope)
          : [
              sharedTeam
                ? `threadnote://user/${uriSegment(config.user)}/memories/shared/${uriSegment(sharedTeam)}`
                : `threadnote://user/${uriSegment(config.user)}/memories`,
            ];
        const authoredRelations = yield* resolveAuthoredMemoryRelations(config, relations ?? [], {
          allowedUriScopes: relationScopes,
          sourceMemoryId: replaceTarget?.metadata.memoryId,
          sourceUri: replaceUri,
        });
        const requestedKeywords = stringList(keywords);
        const keywordPlanOutcome = tryResolveMemoryKeywordPlan({
          keywords: requestedKeywords.length > 0 ? requestedKeywords : undefined,
          clearKeywords,
          regenerateKeywords,
          replacedKeywords: replaceTarget?.metadata.keywords,
          shared: sharedTarget,
          kind: memoryKind,
          surface: 'mcp',
        });
        if ('message' in keywordPlanOutcome) {
          return argumentError(keywordPlanOutcome.message);
        }
        const keywordPlan: MemoryKeywordPlan = keywordPlanOutcome.plan;
        const scopedMetadata = {
          ...metadata,
          ...(codeCitations.length === 0 ? {} : {codeCitations}),
          ...(keywordPlan.mode === 'explicit' || keywordPlan.mode === 'preserved'
            ? {keywords: keywordPlan.keywords}
            : {}),
          ...(authoredRelations.relations === undefined ? {} : {relations: authoredRelations.relations}),
          ...(commonCitationSourceCommit(codeCitations) === undefined
            ? {}
            : {sourceCommit: commonCitationSourceCommit(codeCitations)}),
          memoryId: replacement?.memoryId ?? replaceTarget?.metadata.memoryId,
          workspaceScope: replaceTarget ? replaceTarget.metadata.workspaceScope : workspaceComponent?.scope,
        } satisfies MemoryMetadata;
        if (memoryScope && memoryKind === 'durable') {
          const citationBlocker = memoryCodeCitationSharingBlocker(scopedMetadata);
          if (citationBlocker) {
            return argumentError(
              `Refusing shared memory write: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
            );
          }
          const result = yield* writeCursorCloudSharedMemory(config, selectedShare!, {
            bodyText: checkedText.value,
            expectedSourceContent: authoredRelations.targets,
            metadata: scopedMetadata,
            replaceUri,
          });
          return withClearedKeywordReceipt(
            withClearedMemoryRelationReceipt(
              withClearedCodeCitationReceipt(
                result,
                replaceTarget?.metadata.codeCitations?.length,
                codeCitations.length,
              ),
              replaceTarget?.metadata.relations?.length,
              authoredRelations.relations?.length ?? 0,
            ),
            replaceTarget?.metadata.keywords?.length,
            scopedMetadata.keywords?.length ?? 0,
          );
        }
        const enrichedMetadata =
          memoryScope ||
          (replaceUri && isInSharedNamespace(config, replaceUri)) ||
          !shouldEnrichForKeywordPlan(keywordPlan)
            ? scopedMetadata
            : yield* enrichMemoryMetadataWithConfiguredLocalAi(config, scopedMetadata, checkedText.value).pipe(
                Effect.catch(error =>
                  Console.log(
                    `Local AI memory enrichment skipped: ${error instanceof Error ? error.message : String(error)}`,
                  ).pipe(Effect.as(scopedMetadata)),
                ),
              );
        const result = yield* writeDurableMemory(config, {
          bodyText: checkedText.value,
          deferredCodeAnchor,
          expectedReplaceContent: replacement?.record?.content,
          expectedReplaceMemoryId: replacement?.memoryId,
          expectedSourceContent: authoredRelations.targets,
          metadata: enrichedMetadata,
          replaceUri,
        });
        const projectedResult =
          memoryScope && memoryKind === 'handoff'
            ? {
                ...result,
                _meta: {
                  ...result._meta,
                  'threadnote.io/persistence': {
                    durability: 'cloud-workspace-local',
                    note: 'This handoff may not survive a new Cursor Cloud session.',
                    type: 'threadnote-cloud-persistence',
                    version: 1,
                  },
                },
              }
            : result;
        const relationReceiptResult = withClearedMemoryRelationReceipt(
          projectedResult,
          replaceTarget?.metadata.relations?.length,
          authoredRelations.relations?.length ?? 0,
        );
        const keywordReceiptResult =
          keywordPlan.mode === 'cleared'
            ? withClearedKeywordReceipt(
                relationReceiptResult,
                replaceTarget?.metadata.keywords?.length,
                enrichedMetadata.keywords?.length ?? 0,
              )
            : relationReceiptResult;
        const citationReceiptResult = deferredCodeAnchor
          ? withDeferredCodeAnchorWriteReceipt(keywordReceiptResult, deferredCodeAnchor)
          : withClearedCodeCitationReceipt(
              keywordReceiptResult,
              replaceTarget?.metadata.codeCitations?.length,
              codeCitations.length,
            );
        return withHandoffResumeReceipt(citationReceiptResult, {
          capturedCodeCitationCount: codeCitations.length,
          kind: memoryKind,
          pendingCodeRefCount: deferredCodeAnchor?.codeRefs.length ?? 0,
          status: metadata.status,
        });
      }).pipe(Effect.flatMap(withStaleVersionNotice));
    },
  );
}

export function registerFinalizeCodeRefsTool(server: EffectMcpServerAdapter, config: RuntimeConfig): void {
  server.registerTool(
    'finalize_code_refs',
    {
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true},
      description:
        'Finalize deferred private code citations from ready graphs. Never indexes. Omit uri to finalize up to 25 pending personal memories.',
      inputSchema: {
        uri: McpInput.string('Pending memory URI'),
      },
    },
    ({uri}) =>
      Effect.gen(function* () {
        const checkedUri = optionalResourceUri(uri, 'finalize_code_refs');
        if (!checkedUri.ok) return checkedUri.error;
        const receipt = yield* withCodeAnchorFinalizationAnonymousTelemetry(
          'explicit',
          finalizeDeferredCodeAnchorsWithDerivedIndexes(config, {
            limit: DEFAULT_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT,
            ...(checkedUri.value === undefined ? {} : {uris: [checkedUri.value]}),
          }),
        );
        const summary = [
          `Deferred code anchors: ${receipt.finalizedCount} finalized, ${receipt.pendingCount} pending, ${receipt.conflictCount} conflict, ${receipt.failedCount} failed.`,
          ...(receipt.derivedIndexes
            ? [
                `Derived indexes: ${receipt.derivedIndexes.state}${receipt.derivedIndexes.state === 'deferred' ? ' · repair needed' : ''}.`,
              ]
            : []),
          ...receipt.items.map(
            item =>
              `- ${item.memoryUri ?? 'invalid intent'}: ${item.state}` +
              (item.code ? ` [${item.code}]` : '') +
              (item.reason ? ` (${item.reason})` : '') +
              (item.recoveryAction ? ` · next: ${item.recoveryAction}` : '') +
              (item.citationCount === undefined ? '' : ` · ${item.citationCount} citation(s)`),
          ),
        ].join('\n');
        return {content: [{type: 'text' as const, text: summary}], structuredContent: receipt};
      }).pipe(Effect.catch(error => Effect.succeed(mcpErrorResult(error)))),
  );
}

function stringList(value: string | readonly string[] | undefined): readonly string[] {
  return typeof value === 'string' ? [value] : (value ?? []);
}

function commonCitationSourceCommit(citations: readonly {readonly sourceCommit: string}[]): string | undefined {
  const commits = new Set(citations.map(citation => citation.sourceCommit));
  return commits.size === 1 ? citations[0]?.sourceCommit : undefined;
}

function withClearedCodeCitationReceipt(
  result: CallToolResult,
  previousCount: number | undefined,
  currentCount: number,
): CallToolResult {
  if (result.isError === true || !previousCount || currentCount > 0) return result;
  const note = `Cleared ${previousCount} prior code citation(s); provide codeRefs to recapture them.`;
  return {
    ...result,
    content: [...result.content, {type: 'text', text: note}],
    structuredContent: {
      ...(result.structuredContent ?? {}),
      clearedCodeCitations: previousCount,
    },
  };
}

function withHandoffResumeReceipt(
  result: CallToolResult,
  memory: {
    readonly capturedCodeCitationCount: number;
    readonly kind: MemoryMetadata['kind'];
    readonly pendingCodeRefCount: number;
    readonly status: MemoryMetadata['status'];
  },
): CallToolResult {
  if (
    result.isError === true ||
    memory.kind !== 'handoff' ||
    memory.status !== 'active' ||
    memory.capturedCodeCitationCount > 0
  ) {
    return result;
  }
  const pending = memory.pendingCodeRefCount > 0;
  const reason = pending ? 'pending-code-refs' : 'missing-code-refs';
  const note = pending
    ? 'CodeRefs pending: compact exact-current resume remains unavailable until citations finalize.'
    : 'No codeRefs: compact exact-current resume is unavailable for this handoff.';
  return {
    ...result,
    content: [...result.content, {type: 'text', text: note}],
    structuredContent: {
      ...(result.structuredContent ?? {}),
      exactCurrentResume: {eligible: false, reason},
    },
  };
}

function withClearedMemoryRelationReceipt(
  result: CallToolResult,
  previousCount: number | undefined,
  currentCount: number,
): CallToolResult {
  if (result.isError === true || !previousCount || currentCount > 0) return result;
  const note = `Cleared ${previousCount} prior memory relation(s); provide relations to author the replacement edges.`;
  return {
    ...result,
    content: [...result.content, {type: 'text', text: note}],
    structuredContent: {
      ...(result.structuredContent ?? {}),
      clearedMemoryRelations: previousCount,
    },
  };
}

function withClearedKeywordReceipt(
  result: CallToolResult,
  previousCount: number | undefined,
  currentCount: number,
): CallToolResult {
  if (result.isError === true || !previousCount || currentCount > 0) return result;
  const note = `Cleared ${previousCount} prior keyword(s); provide keywords to set them explicitly.`;
  return {
    ...result,
    content: [...result.content, {type: 'text', text: note}],
    structuredContent: {
      ...(result.structuredContent ?? {}),
      clearedKeywords: previousCount,
    },
  };
}

function withDeferredCodeAnchorWriteReceipt(
  result: CallToolResult,
  request: DeferredCodeAnchorWriteRequest,
): CallToolResult {
  if (result.isError === true) return result;
  const memoryUri = (result.structuredContent as {readonly memoryUri?: unknown} | undefined)?.memoryUri;
  const preparation = request.recovery.preparation;
  const recovery = {
    action: preparation.action,
    arguments: preparation.arguments,
    automaticRetry:
      preparation.target === 'callerCwd'
        ? (['after-graph-index', 'next-code-linked-context-brief'] as const)
        : (['after-workset-prepare'] as const),
    command: preparation.command,
    cliCommand: 'threadnote finalize-code-refs',
    replaceUri: typeof memoryUri === 'string' ? memoryUri : undefined,
    retry: 'replace-stored-memory',
    runFrom: preparation.target === 'callerCwd' ? 'callerCwd' : 'any-directory',
    target: preparation.target,
  };
  const note = [
    'Memory stored now without finalized code citations.',
    `${request.codeRefs.length} code reference(s) are pending in a private local outbox.`,
    preparation.target === 'callerCwd'
      ? 'After the graph is prepared, Threadnote retries automatically during graph indexing and the next code-linked Context Brief.'
      : 'After the Workset is prepared, Threadnote retries automatically.',
    typeof memoryUri === 'string'
      ? `If it remains pending, call remember_context with the same content and replaceUri: "${memoryUri}", or run threadnote finalize-code-refs.`
      : 'If it remains pending, replace the stored memory with the same content and codeRefs, or run threadnote finalize-code-refs.',
  ].join(' ');
  return {
    ...result,
    content: [...result.content, {type: 'text', text: note}],
    structuredContent: {
      ...(result.structuredContent ?? {}),
      citationsFinalized: false,
      citationPolicy: 'defer',
      graph: request.recovery.observedGraph,
      memoryStored: true,
      memoryUri,
      pendingCodeRefs: request.codeRefs.length,
      recovery,
      type: 'memory-code-citation-write-receipt',
      version: 1,
    },
  };
}
