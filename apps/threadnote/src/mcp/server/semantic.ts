import {Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runSemanticAgentQuery, runSemanticAgentView} from '../../semantic/agent_queries.js';
import {formatSemanticAgentQuery} from '../../semantic/agent_query_protocol.js';
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
