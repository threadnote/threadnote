import {Array as EffectArray} from 'effect';
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
import * as EffectRecord from 'effect/Record';

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
    if (EffectArray.some(this.#tools, tool => tool.name === name))
      throw new Error(`Tool ${name} is already registered.`);
    const decode = Schema.decodeUnknownSync(config.inputSchema, {errors: 'all', onExcessProperty: 'error'});
    let advertisedSchema: Record<string, unknown> | undefined;
    this.#tools.push({
      name,
      description: config.description,
      annotations: config.annotations,
      inputSchema: () =>
        (advertisedSchema ??= strictObjectSchemas(
          flattenJsonSchemaConstraints(Schema.toJsonSchemaDocument(config.inputSchema).schema),
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
    const tools = new Map(EffectArray.map(this.#tools, tool => [tool.name, tool]));
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: EffectArray.map(this.#tools, ({annotations, description, inputSchema, name}) => ({
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

function strictObjectSchemas(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || EffectArray.isArray(value))
    throw new TypeError('Expected a JSON Schema object.');
  const schema = value;
  const keys = EffectArray.filter(
    Reflect.ownKeys(schema),
    (key): key is string => typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(schema, key),
  );
  const fields = EffectRecord.fromEntries(
    EffectArray.map(keys, key => [key, strictNestedSchema(Reflect.get(schema, key))] as const),
  );
  return Reflect.get(schema, 'type') === 'object' && Reflect.get(schema, 'properties') !== undefined
    ? {...fields, additionalProperties: false}
    : fields;
}

function strictNestedSchema(value: unknown): unknown {
  if (EffectArray.isArray(value)) return EffectArray.map(value, strictNestedSchema);
  if (typeof value === 'object' && value !== null) return strictObjectSchemas(value);
  return value;
}
