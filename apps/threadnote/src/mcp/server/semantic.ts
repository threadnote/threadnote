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
