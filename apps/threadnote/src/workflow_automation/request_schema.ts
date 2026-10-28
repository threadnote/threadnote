import {Schema} from 'effect';
import {
  NativeWorkflowRequestSchema,
  NativeWorkflowInitRequestSchema,
  NativeWorkflowReadRequestSchema,
} from '@threadnote/workflow-automations/native';
import {
  NativeAuthoringDocumentSchema,
  NativeAuthoringSpecDocumentSchema,
  NativeAuthoringPlanDocumentSchema,
} from '@threadnote/workflow-automations/authoring';
import {NativeCyclePlanSchema, NativeCycleValidationSchema} from '@threadnote/workflow-automations/cycle';
import {NativeCycleReviewSchema, nativeCycleOrchestratorLane} from '@threadnote/workflow-automations/cycle-review';
import {NativeCloseoutProposalSchema} from '@threadnote/workflow-automations/closeout';
import {nativeCycleTextPage} from '@threadnote/workflow-automations/cycle-output';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {nativeAuthoringRequestSchema} from './authoring_request_schema.js';
import {nativeCycleRequestSchema, nativeCycleSemanticPrerequisites} from './cycle.js';
import {nativeWatchRequestSchema} from './watch.js';
import {nativeCloseoutRequestSchema} from './closeout_request_schema.js';
import {nativeJobRequestSchema} from './native_jobs.js';

export const NativeRequestSchemaDiscoverySchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  executorVersion: Schema.Literal(1),
  action: Schema.Literal('request-schema'),
  topic: Schema.Literals([
    'core',
    'init',
    'read',
    'authoring',
    'cycle',
    'watch',
    'closeout',
    'job',
    'authoring-document',
    'cycle-plan',
    'cycle-validation',
    'cycle-review',
    'closeout-proposal',
  ]),
  kind: Schema.optionalKey(Schema.Literals(['spec', 'plan'])),
  command: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
  offsetBytes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 16_777_216}))),
  maxBytes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({minimum: 4096, maximum: 16_384}))),
  sourceDigest: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
});

const invalid = (message: string): never => {
  throw WorkflowAutomationError.make({code: 'invalid-request', message});
};

// Select a command using the same literal decoder used by the production
// envelope, then narrow only that field. Command-dependent semantic checks
// remain in the executor; this is deliberately a decoding-envelope schema.
function commandSchema<
  Fields extends Schema.Struct.Fields & {readonly command: Schema.ConstraintDecoder<unknown, never>},
>(schema: Schema.Struct<Fields>, command: string | undefined) {
  if (command === undefined) return Schema.toJsonSchemaDocument(schema, {onExcessProperty: 'error'});
  Schema.decodeSync(schema.fields.command)(command);
  return Schema.toJsonSchemaDocument(
    schema.mapFields(fields => ({...fields, command: Schema.Literal(command)})),
    {onExcessProperty: 'error'},
  );
}

/** Pure discovery: no configuration, run state, filesystem, graph, or providers. */
export function nativeRequestSchema(input: unknown) {
  const request = Schema.decodeUnknownSync(NativeRequestSchemaDiscoverySchema, {onExcessProperty: 'error'})(input);
  if (request.kind !== undefined && request.topic !== 'authoring-document')
    return invalid('Kind selection is only available for authoring-document.');
  const nestedSchema = (() => {
    switch (request.topic) {
      case 'authoring-document':
        return request.kind === 'spec'
          ? NativeAuthoringSpecDocumentSchema
          : request.kind === 'plan'
            ? NativeAuthoringPlanDocumentSchema
            : NativeAuthoringDocumentSchema;
      case 'cycle-plan':
        return NativeCyclePlanSchema;
      case 'cycle-validation':
        return NativeCycleValidationSchema;
      case 'cycle-review':
        return NativeCycleReviewSchema;
      case 'closeout-proposal':
        return NativeCloseoutProposalSchema;
      default:
        return undefined;
    }
  })();
  const document = (() => {
    if (nestedSchema !== undefined) {
      if (request.command !== undefined) return invalid('Command selection is only available for command topics.');
      return Schema.toJsonSchemaDocument(nestedSchema, {onExcessProperty: 'error'});
    }
    switch (request.topic) {
      case 'authoring':
        return commandSchema(nativeAuthoringRequestSchema, request.command);
      case 'cycle':
        return commandSchema(nativeCycleRequestSchema, request.command);
      case 'watch':
        return commandSchema(nativeWatchRequestSchema, request.command);
      case 'closeout':
        return commandSchema(nativeCloseoutRequestSchema, request.command);
      case 'job':
        return commandSchema(nativeJobRequestSchema, request.command);
      default: {
        if (request.command !== undefined) return invalid('Command selection is only available for command topics.');
        const schema =
          request.topic === 'init'
            ? NativeWorkflowInitRequestSchema
            : request.topic === 'read'
              ? NativeWorkflowReadRequestSchema
              : Schema.Union([NativeWorkflowRequestSchema, NativeRequestSchemaDiscoverySchema]);
        return Schema.toJsonSchemaDocument(schema, {onExcessProperty: 'error'});
      }
    }
  })();
  const source = JSON.stringify(document);
  const maxBytes = request.maxBytes ?? 16_384;
  let pageBytes = maxBytes - 1024;
  for (;;) {
    const response = {
      protocolVersion: 1 as const,
      executorVersion: 1 as const,
      status: 'ok' as const,
      action: 'request-schema' as const,
      topic: request.topic,
      ...(request.kind === undefined ? {} : {kind: request.kind}),
      ...(request.command === undefined ? {} : {command: request.command}),
      schemaKind: 'decoding-envelope' as const,
      runtimeValidationRequired: true as const,
      ...(request.topic === 'cycle' && request.command !== undefined
        ? {semanticPrerequisites: nativeCycleSemanticPrerequisites(request.command)}
        : request.topic === 'cycle-review'
          ? {
              semanticPrerequisites: {
                requiredSelectedLane: nativeCycleOrchestratorLane,
                requiredCompletedLane: nativeCycleOrchestratorLane,
                specialistLanes: 'Optional; every selected lane must have a complete report.',
              },
            }
          : {}),
      constraintNote:
        'This is a decoding envelope. Semantic prerequisites are additional, bounded guidance, not an exhaustive admission schema. Runtime refinements remain authoritative (including reserved identifiers, control characters and UTF-8 byte limits).',
      schemaPage: nativeCycleTextPage(source, {
        maxBytes: pageBytes,
        offsetBytes: request.offsetBytes,
        sourceDigest: request.sourceDigest,
      }),
    };
    if (new TextEncoder().encode(JSON.stringify(response)).byteLength <= maxBytes) return response;
    // The serialized JSON string can expand through escaping. Adjust against
    // the actual complete transport envelope, never truncate JSON metadata.
    if (pageBytes === 1024) return invalid('The requested schema page budget is too small for this envelope.');
    pageBytes = Math.max(1024, Math.floor(pageBytes / 2));
  }
}
