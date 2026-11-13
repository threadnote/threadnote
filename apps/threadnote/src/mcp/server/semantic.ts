import {runSemanticAgentChange} from '../../semantic/agent_changes.js';
import {Array as EffectArray, Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runSemanticAgentQuery, runSemanticAgentView} from '../../semantic/agent_queries.js';
import {formatSemanticAgentQuery} from '../../semantic/agent_query_protocol.js';
import {runSemanticReadiness} from '../../semantic/readiness.js';
import {EffectMcpServerRegistry, McpInput} from '../../effect/ai/mcp.js';
import {formatSemanticCapabilities, semanticCapabilities} from '../../effect/semantic_cli.js';

export function registerSemanticTool(server: EffectMcpServerRegistry): void {
  server.registerTool(
    'semantic_capabilities',
    {
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
      description:
        'Discover selected semantic provider candidates and qualification. Catalog only; does not inspect a project, install or launch providers.',
      inputSchema: {language: McpInput.string('Optional exact language; Kotlin is deferred')},
    },
    ({language}) => {
      const result = semanticCapabilities(language === undefined ? {} : {language});
      return {content: [{type: 'text', text: formatSemanticCapabilities(result)}], structuredContent: result};
    },
  );
}

export function registerSemanticQueryTool(
  server: EffectMcpServerRegistry,
  config: RuntimeConfig,
  knowledgeAuthorized = false,
): void {
  server.registerTool(
    'semantic_readiness',
    {
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
      description:
        'Explicit saved-disk startup: request start {action,callerCwd,file,language,project?,environment?}; status/cancel {action,callerCwd,job}. Private volatile job; no edits/import authority. See semantic_capabilities.',
      inputSchema: {request: Schema.Json},
    },
    ({request}) =>
      runSemanticReadiness(config, request).pipe(
        Effect.map(result => ({content: [{type: 'text' as const, text: JSON.stringify(result)}]})),
      ),
  );
  const descriptions = {
    prepare:
      'Read-only V1 preview. request: callerCwd,file,language,operation; rename uses position/newName; code-action uses range and opaque choiceHandle (omit to list). Protected profile required; no writes/writer grant. Details: semantic_capabilities.',
    status:
      'Read-only V1 proposal page. request: callerCwd, private handle, offset=page.next, maxBytes?. No writes/writer grant. Details: semantic_capabilities.',
    preflight:
      'Read-only V1 whole-proposal checks. request: callerCwd, private handle. Returns conflicts; no writes or writer grant. Protected profile required. Details: semantic_capabilities.',
  };
  for (const action of ['prepare', 'status', 'preflight'] as const)
    server.registerTool(
      'semantic_change_' + action,
      {
        annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: action !== 'prepare'},
        description: descriptions[action],
        inputSchema: {request: Schema.Json},
      },
      ({request}) =>
        runSemanticAgentChange(
          config,
          typeof request === 'object' && request !== null && !EffectArray.isArray(request)
            ? {...request, action}
            : request,
        ).pipe(
          Effect.map(result => ({
            content: [{type: 'text' as const, text: JSON.stringify(result)}],
            structuredContent: result,
          })),
        ),
    );
  for (const action of ['apply', 'recover'] as const)
    server.registerTool(
      'semantic_change_' + action,
      {
        annotations: {readOnlyHint: false, destructiveHint: action === 'apply', idempotentHint: true},
        description:
          action === 'apply'
            ? 'Apply an exact operation already admitted by the local CLI. request: {version:1,callerCwd,writer:{operation,capability},milliseconds?,maxBytes?}. Secret capability is required; read profiles/previews never grant writes. Closed disk only; editor integration required for buffers.'
            : 'Reconcile a locally admitted operation against actual source without replay or rollback. Same private writer handle and callerCwd as apply. Persists private recovery evidence; partial/unknown outcomes remain explicit. Never log the capability.',
        inputSchema: {request: Schema.Json},
      },
      ({request}) =>
        runSemanticAgentChange(
          config,
          typeof request === 'object' && request !== null && !EffectArray.isArray(request)
            ? {...request, action}
            : request,
        ).pipe(
          Effect.map(result => ({
            content: [{type: 'text' as const, text: JSON.stringify(result)}],
            structuredContent: result,
          })),
        ),
    );
  server.registerTool(
    'semantic_view',
    {
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false},
      description:
        'Own a volatile unsaved buffer. request: open {action,callerCwd,file,language,text,project?,environment?}; update {action,callerCwd,handle,expectedVersion,text}; close {action,callerCwd,handle}. Open returns a private {id,capability} handle; never log it. No disk writes. Text <=1MiB; 16 buffers/8MiB, expires after 10min. Requires host profile.',
      inputSchema: {request: Schema.Json},
    },
    ({request}) =>
      runSemanticAgentView(config, request).pipe(
        Effect.map(result => ({content: [{type: 'text' as const, text: JSON.stringify(result)}]})),
      ),
  );
  server.registerTool(
    'semantic_query',
    {
      annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true},
      description:
        'Read semantic evidence; disk is the default. Buffer view: {kind:"buffer",handle:{id,capability},documentVersion}. request: {callerCwd,file,language,operation,position?,project?,environment?,maxItems?,maxBytes?,milliseconds?,cursor?}. context also requires task and position; optional budgetTokens 800-1500. Knowledge links are document-scoped. Requires an opt-in host profile; no setup or edits.',
      inputSchema: {
        request: Schema.Json,
        responseFormat: McpInput.literals(
          ['agent', 'dual'],
          'Default agent emits one compact page; dual includes canonical structured content',
        ),
      },
    },
    ({request, responseFormat}) =>
      runSemanticAgentQuery(config, request, knowledgeAuthorized).pipe(
        Effect.map(result => ({
          content: [{type: 'text' as const, text: formatSemanticAgentQuery(result)}],
          ...(responseFormat === 'dual' ? {structuredContent: result} : {}),
        })),
      ),
  );
}
