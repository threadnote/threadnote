import {Array as EffectArray} from 'effect';
import {Effect, Result} from 'effect';
import {
  parseActivationProductionRequestV1,
  type ActivationProductionRequestV1,
} from '../activation/production/contract.js';
import {previewActivationResumeV1} from '../activation/planner.js';
import {readActivationStateV1} from '../activation/store.js';
import {
  observeActivationProductionV1,
  type ActivationProductionObservationV1,
} from '../activation/production/observe.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as EffectRecord from 'effect/Record';

export interface ManagerActivationApiRequest {
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
  readonly config: RuntimeConfig;
  readonly method: string;
  readonly observe?: (
    config: RuntimeConfig,
    request: ActivationProductionRequestV1,
  ) => Effect.Effect<Pick<ActivationProductionObservationV1, 'plan'>, unknown>;
  readonly url: URL;
}

export interface ManagerActivationApiResponse {
  readonly body: unknown;
  readonly status: number;
}

/**
 * This is intentionally a browser-to-CLI bridge: drafts and previews stay in
 * the browser, while existing CLI commands remain the only project-setup writer.
 */
export const handleManagerActivationRequest = Effect.fn('managerActivation.handleRequest')(function* (
  request: ManagerActivationApiRequest,
) {
  if (request.url.pathname === '/api/activation/preview') {
    if (request.method !== 'POST')
      return {body: {error: 'Not found'}, status: 404} satisfies ManagerActivationApiResponse;
    const body = yield* request.body;
    if (EffectRecord.keys(body).length !== 1 || !EffectRecord.has(body, 'request') || !isObject(body.request)) {
      return {
        body: {code: 'invalid-request', error: 'Provide one activation request object.'},
        status: 400,
      } satisfies ManagerActivationApiResponse;
    }
    const parsedResult = yield* Effect.try({
      try: () => parseActivationProductionRequestV1(body.request),
      catch: () => undefined,
    }).pipe(Effect.result);
    if (Result.isFailure(parsedResult)) {
      return {
        body: {code: 'invalid-request', error: 'The activation request is invalid or unsupported.'},
        status: 400,
      } satisfies ManagerActivationApiResponse;
    }
    const parsed = parsedResult.success;
    const observed = yield* (request.observe ?? observeActivationProductionV1)(request.config, parsed).pipe(
      Effect.result,
    );
    if (Result.isFailure(observed)) {
      return {
        body: {code: 'preview-unavailable', error: 'The current activation environment could not be validated.'},
        status: 409,
      } satisfies ManagerActivationApiResponse;
    }
    return {body: activationPreview(parsed, observed.success.plan), status: 200} satisfies ManagerActivationApiResponse;
  }
  if (request.url.pathname === '/api/activation/status') {
    if (request.method !== 'GET')
      return {body: {error: 'Not found'}, status: 404} satisfies ManagerActivationApiResponse;
    const activationId = request.url.searchParams.get('activationId') ?? '';
    if (!/^[0-9a-f]{64}$/u.test(activationId)) {
      return {
        body: {code: 'invalid-activation-id', error: 'Provide an activation ID returned by the CLI.'},
        status: 400,
      };
    }
    const state = yield* readActivationStateV1(request.config, activationId);
    if (state === undefined)
      return {body: {code: 'activation-not-found', error: 'Activation state was not found.'}, status: 404};
    return {
      body: {
        activationId,
        firstBrief: state.receipt.firstBrief,
        next: previewActivationResumeV1(state.plan, state.receipt),
        receiptRevision: state.receipt.revision,
        status: state.receipt.status,
      },
      status: 200,
    } satisfies ManagerActivationApiResponse;
  }
  return undefined;
});

export function activationPreview(
  request: ActivationProductionRequestV1,
  plan: ActivationProductionObservationV1['plan'],
) {
  return {
    activationId: plan.activationId,
    operations: EffectArray.map(plan.operations, operation => ({
      approvalKind: operation.approvalKind,
      id: operation.id,
      kind: operation.kind,
    })),
    planHash: plan.planHash,
    request,
    steps: [
      'Validate the selected project agents.',
      'Preview imports and stop for import review.',
      'Verify the first Context Brief and stop for decision review.',
      request.publicationMode === 'proposal'
        ? 'Create a reviewed local proposal and stop before any push.'
        : 'Publish only after the existing explicit decision approval.',
      'Complete the verification-agent retrieval proof and report its attested result.',
    ],
    verification: 'The Manager can read the content-free receipt after the CLI creates it.',
    writer: 'Use the generated CLI command. Manager preview does not create project setup state.',
  } as const;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}
