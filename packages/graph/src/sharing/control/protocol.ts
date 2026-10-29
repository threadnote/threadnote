import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {GRAPH_SHARE_ACTION_KEY} from '../action.js';
import {parseSha256Digest, SHA256_DIGEST, SHA256_HEX} from '../digest.js';
import {
  announceGraphShareResult,
  emptyGraphShareReceiptStore,
  type GraphShareReceiptStoreV1,
  type GraphShareResultAnnouncementV1,
} from '../receipts.js';
import type {GraphShareFrontierMachineV1} from '../frontier.js';
import {idleGraphShareFrontier} from '../frontier.js';

export const GRAPH_SHARE_CONTROL_MAX_BODY_BYTES = 64 * 1024;
export const GRAPH_SHARE_CONTROL_STATUS_RECEIPT_LIMIT = 256;
export const GRAPH_SHARE_CONTROL_FORBIDDEN_FIELDS = [
  'blob',
  'files',
  'gitTree',
  'graph',
  'graphRecords',
  'markdownBody',
  'records',
  'registryDestination',
  'source',
  'sourceText',
] as const;

const STRICT = {errors: 'all', onExcessProperty: 'error'} as const;
const HexId = Schema.String.check(Schema.isPattern(SHA256_HEX));
const Digest = Schema.String.check(Schema.isPattern(SHA256_DIGEST));
const ActionKey = Schema.String.check(Schema.isPattern(GRAPH_SHARE_ACTION_KEY));
const BatchId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));

const EnrollRequest = Schema.Struct({
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  repositoryId: HexId,
});

const ResultAnnouncementRequest = Schema.Struct({
  actionKey: ActionKey,
  attestationDigest: Digest,
  batchId: BatchId,
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  resultManifestDigest: Digest,
  semanticDigest: Digest,
});

const ClaimRequest = Schema.Struct({
  actionKey: ActionKey,
  batchId: BatchId,
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});

const AssemblyLeaseRequest = Schema.Struct({
  batchId: BatchId,
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});

export interface GraphShareControlRequest {
  readonly body?: unknown;
  readonly bodyBytes: number;
  readonly method: 'GET' | 'POST';
  readonly path: string;
}

export interface GraphShareControlResponse {
  readonly body: unknown;
  readonly status: number;
}

export interface GraphShareFrontierPointerDigestV1 {
  readonly envelopeDigest: string;
  readonly manifestDigest: string;
}

export interface GraphShareCoordinatorStateV1 {
  readonly claims: Readonly<Record<string, string>>;
  readonly enrollments: Readonly<Record<string, string>>;
  readonly frontierByBranch: Readonly<Record<string, GraphShareFrontierPointerDigestV1>>;
  readonly machine: GraphShareFrontierMachineV1;
  readonly organization: string;
  readonly receipts: GraphShareReceiptStoreV1;
  readonly repositoryId: string;
  readonly workByBatch: Readonly<Record<string, string>>;
}

export function emptyGraphShareCoordinatorState(input: {
  readonly organization: string;
  readonly repositoryId: string;
}): GraphShareCoordinatorStateV1 {
  return {
    claims: {},
    enrollments: {},
    frontierByBranch: {},
    machine: idleGraphShareFrontier(),
    organization: input.organization,
    receipts: emptyGraphShareReceiptStore(),
    repositoryId: input.repositoryId,
    workByBatch: {},
  };
}

export function setGraphShareCoordinatorFrontier(
  state: GraphShareCoordinatorStateV1,
  branchHash: string,
  pointer: GraphShareFrontierPointerDigestV1,
): GraphShareCoordinatorStateV1 {
  return {
    ...state,
    frontierByBranch: {...state.frontierByBranch, [branchHash]: pointer},
  };
}

export function dispatchGraphShareControl(
  state: GraphShareCoordinatorStateV1,
  request: GraphShareControlRequest,
): {readonly response: GraphShareControlResponse; readonly state: GraphShareCoordinatorStateV1} {
  if (request.bodyBytes > GRAPH_SHARE_CONTROL_MAX_BODY_BYTES) {
    return {response: {body: {error: 'payload-too-large'}, status: 413}, state};
  }
  const forbidden = forbiddenControlField(request.body);
  if (forbidden !== undefined) {
    return {response: {body: {error: 'source-or-graph-payload'}, status: 400}, state};
  }
  if (request.method === 'GET' && request.path === '/.well-known/threadnote-graph') {
    return {
      response: {
        body: {organization: state.organization, protocolVersions: ['v1'], repositoryId: state.repositoryId},
        status: 200,
      },
      state,
    };
  }
  if (request.method === 'GET' && request.path === '/v1/status') {
    return {
      response: {
        body: {
          generation: state.machine.generation,
          organization: state.organization,
          phase: state.machine.phase,
          publishedFrontier: state.machine.publishedFrontier,
          receipts: state.receipts.receipts.slice(-GRAPH_SHARE_CONTROL_STATUS_RECEIPT_LIMIT),
          repositoryId: state.repositoryId,
        },
        status: 200,
      },
      state,
    };
  }
  const frontierMatch = request.method === 'GET' ? /^\/v1\/frontiers\/([0-9a-f]{40})$/u.exec(request.path) : null;
  if (frontierMatch?.[1] !== undefined) {
    const pointer = state.frontierByBranch[frontierMatch[1]];
    if (pointer === undefined) return {response: {body: {error: 'not-found'}, status: 404}, state};
    return {
      response: {
        body: {
          envelopeDigest: pointer.envelopeDigest,
          frontierDigest: pointer.manifestDigest,
          manifestDigest: pointer.manifestDigest,
        },
        status: 200,
      },
      state,
    };
  }
  const workMatch = request.method === 'GET' ? /^\/v1\/work\/([0-9a-f]{40})$/u.exec(request.path) : null;
  if (workMatch?.[1] !== undefined) {
    const digest = state.workByBatch[workMatch[1]];
    if (digest === undefined) return {response: {body: {error: 'not-found'}, status: 404}, state};
    return {response: {body: {cancelled: false, workManifestDigest: digest}, status: 200}, state};
  }
  if (request.method === 'POST' && request.path === '/v1/enroll') {
    const body = decodeEnroll(request.body);
    if (body === undefined) return {response: {body: {error: 'invalid-request'}, status: 400}, state};
    if (body.repositoryId !== state.repositoryId) {
      return {response: {body: {error: 'repository-scope'}, status: 403}, state};
    }
    const existing = state.enrollments[body.idempotencyKey];
    const workerId = existing ?? `worker:${body.idempotencyKey}`;
    return {
      response: {body: {workerId}, status: existing === undefined ? 201 : 200},
      state: {
        ...state,
        enrollments: {...state.enrollments, [body.idempotencyKey]: workerId},
      },
    };
  }
  if (request.method === 'POST' && request.path === '/v1/results') {
    const body = decodeResultAnnouncement(request.body);
    if (body === undefined) return {response: {body: {error: 'invalid-request'}, status: 400}, state};
    const announcement: GraphShareResultAnnouncementV1 = {
      actionKey: body.actionKey,
      attestationDigest: parseSha256Digest(body.attestationDigest),
      batchId: body.batchId,
      resultManifestDigest: parseSha256Digest(body.resultManifestDigest),
      semanticDigest: parseSha256Digest(body.semanticDigest),
    };
    const announced = announceGraphShareResult(state.receipts, announcement);
    const status = announced.status === 'duplicate' ? 200 : announced.status === 'quarantined' ? 409 : 201;
    return {
      response: {body: {status: announced.status}, status},
      state: {...state, receipts: announced.store},
    };
  }
  if (request.method === 'POST' && request.path === '/v1/claims') {
    const body = decodeClaim(request.body);
    if (body === undefined) return {response: {body: {error: 'invalid-request'}, status: 400}, state};
    const existing = state.claims[body.idempotencyKey];
    const claimId = existing ?? `${body.batchId}:${body.actionKey}`;
    return {
      response: {body: {claimId, soft: true}, status: 200},
      state: {...state, claims: {...state.claims, [body.idempotencyKey]: claimId}},
    };
  }
  if (request.method === 'POST' && request.path === '/v1/assembly-leases') {
    const body = decodeAssemblyLease(request.body);
    if (body === undefined) return {response: {body: {error: 'invalid-request'}, status: 400}, state};
    return {response: {body: {batchId: body.batchId, leased: true}, status: 200}, state};
  }
  return {response: {body: {error: 'not-found'}, status: 404}, state};
}

function forbiddenControlField(body: unknown): string | undefined {
  if (body === undefined || body === null || typeof body !== 'object' || EffectArray.isArray(body)) return undefined;
  for (const key of GRAPH_SHARE_CONTROL_FORBIDDEN_FIELDS) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
    if (Object.hasOwn(body, key)) return key;
  }
  return undefined;
}

function decodeEnroll(body: unknown) {
  try {
    return Schema.decodeUnknownSync(EnrollRequest, STRICT)(body);
  } catch {
    return undefined;
  }
}

function decodeResultAnnouncement(body: unknown) {
  try {
    return Schema.decodeUnknownSync(ResultAnnouncementRequest, STRICT)(body);
  } catch {
    return undefined;
  }
}

function decodeClaim(body: unknown) {
  try {
    return Schema.decodeUnknownSync(ClaimRequest, STRICT)(body);
  } catch {
    return undefined;
  }
}

function decodeAssemblyLease(body: unknown) {
  try {
    return Schema.decodeUnknownSync(AssemblyLeaseRequest, STRICT)(body);
  } catch {
    return undefined;
  }
}
