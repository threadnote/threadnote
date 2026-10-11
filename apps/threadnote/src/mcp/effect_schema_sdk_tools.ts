import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {Schema} from 'effect';
import {flattenJsonSchemaConstraints} from './json_schema_constraints.js';

interface ToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly annotations?: {
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly readOnlyHint?: boolean;
  };
  readonly inputSchema: () => Record<string, unknown>;
  readonly invoke: (input: unknown) => Promise<CallToolResult>;
}

/** Register Effect Schema tools on an SDK server that also owns resources or a stdio transport. */
export class EffectSchemaSdkTools {
  readonly #tools: ToolRegistration[] = [];

  register<S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(
    name: string,
    config: {
      readonly annotations?: ToolRegistration['annotations'];
      readonly description: string;
      readonly inputSchema: S;
    },
    handler: (input: S['Type']) => Promise<CallToolResult>,
  ): void {
    if (this.#tools.some(tool => tool.name === name)) throw new Error(`Tool ${name} is already registered.`);
    const decode = Schema.decodeUnknownSync(config.inputSchema, {errors: 'all', onExcessProperty: 'error'});
    let advertisedSchema: Record<string, unknown> | undefined;
    this.#tools.push({
      name,
      description: config.description,
      annotations: config.annotations,
      inputSchema: () =>
        (advertisedSchema ??= strictObjectSchemas(
          flattenJsonSchemaConstraints(Schema.toJsonSchemaDocument(config.inputSchema).schema) as Record<
            string,
            unknown
          >,
        )),
      invoke: input => {
        let parsed: S['Type'];
        try {
          parsed = decode(input);
        } catch {
          return Promise.resolve(toolError(`Invalid or unexpected arguments for tool ${name}.`));
        }
        return handler(parsed);
      },
    });
  }

  install(server: McpServer): void {
    const tools = new Map(this.#tools.map(tool => [tool.name, tool]));
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.#tools.map(({annotations, description, inputSchema, name}) => ({
        annotations,
        description,
        inputSchema: inputSchema(),
        name,
      })),
    }));
    server.server.setRequestHandler(CallToolRequestSchema, async request => {
      if (request.params.task) throw new McpError(ErrorCode.MethodNotFound, 'Tool tasks are not supported.');
      const tool = tools.get(request.params.name);
      if (!tool) return toolError(`Tool ${request.params.name} not found.`);
      try {
        return await tool.invoke(request.params.arguments ?? {});
      } catch (cause) {
        return toolError(cause instanceof Error ? cause.message : String(cause));
      }
    });
  }
}

function toolError(message: string): CallToolResult {
  return {content: [{type: 'text', text: message}], isError: true};
}

function strictObjectSchemas(schema: Record<string, unknown>): Record<string, unknown> {
  const fields = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, strictNestedSchema(value)]));
  return schema.type === 'object' && schema.properties !== undefined
    ? {...fields, additionalProperties: false}
    : fields;
}

function strictNestedSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictNestedSchema);
  if (typeof value === 'object' && value !== null) return strictObjectSchemas(value as Record<string, unknown>);
  return value;
}
