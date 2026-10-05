import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import {Effect, FileSystem, Layer, Option, Path, Ref, Schema} from 'effect';
import * as HttpServer from 'effect/http/HttpServer';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import {readJsonFile, writePrivateJsonFile} from '../atomic.js';
import {putCasBytes, readVerifiedCasBlob, verifyCasBlob} from '../cas.js';
import {
  dispatchGraphShareControl,
  emptyGraphShareCoordinatorState,
  setGraphShareCoordinatorFrontier,
  GRAPH_SHARE_CONTROL_MAX_BODY_BYTES,
  type GraphShareCoordinatorStateV1,
  type GraphShareFrontierPointerDigestV1,
} from './protocol.js';
import {
  parseSha256Digest,
  SHA256_DIGEST,
  SHA256_HEX,
  sha256Digest,
  sha256HexFromDigest,
  type Sha256Digest,
} from '../digest.js';
import {graphSharingFailure, GraphSharingError} from '../errors.js';
import {withCoordinatorStateLock} from '../coordinator_lock.js';
import {graphSharingCasBlobPath, graphSharingLayout, graphSharingTagPath} from '../layout.js';
import {
  GRAPH_SHARE_HTTP_CAS_MAX_BYTES,
  assertGraphShareDiscoveryTag,
  graphSharePayloadLooksLikeGitObject,
  parseGraphShareHttpCasPath,
  parseGraphShareHttpTagPath,
} from '../oci.js';
import {adoptPublishedFrontier} from '../frontier.js';
import {graphShareFrontierDiscoveryTag} from '../namespace.js';
import {makeGraphControlReader, type GraphControlReaderOptions} from './reader.js';

export const GRAPH_SHARE_PUBLISHER_WATCH_INTERVAL = '5 seconds' as const;

export {withCoordinatorStateLock} from '../coordinator_lock.js';

const STRICT = {errors: 'all', onExcessProperty: 'error'} as const;
const GraphShareHttpTagBody = Schema.Struct({
  digest: Schema.Union([
    Schema.String.check(Schema.isPattern(SHA256_DIGEST)),
    Schema.String.check(Schema.isPattern(SHA256_HEX)),
  ]),
});

export interface GraphShareListenAddress {
  readonly hostname: '127.0.0.1' | 'localhost';
  readonly port: number;
}

export interface GraphSharePublishedFrontier {
  readonly branch: string;
  readonly descriptorDigest?: Sha256Digest;
  readonly envelopeDigest: Sha256Digest;
  readonly generation: number;
  readonly manifestDigest: Sha256Digest;
  readonly published?: boolean;
  readonly repositoryId: string;
  readonly sourceCommit: string;
}

export interface GraphShareControlServerOptions<E = never, R = never> {
  readonly authorization?: Pick<
    GraphControlReaderOptions,
    'enrollment' | 'policyFile' | 'profile' | 'repoRoot' | 'enableWorkerResults'
  >;
  readonly casRoot: string;
  readonly listen: GraphShareListenAddress;
  readonly onListening?: (info: {readonly port: number; readonly url: string}) => Effect.Effect<void, E, R>;
  readonly organization: string;
  readonly republish?: (
    stateRef: Ref.Ref<GraphShareCoordinatorStateV1>,
  ) => Effect.Effect<GraphSharePublishedFrontier, E, R>;
  readonly repositoryId: string;
  readonly threadnoteHome: string;
}

export function parseGraphShareListenAddress(value: string): GraphShareListenAddress {
  const match = /^(127\.0\.0\.1|localhost):(\d{1,5})$/u.exec(value.trim());
  if (match?.[1] === undefined || match[2] === undefined) {
    throw graphSharingFailure('Listen address must be 127.0.0.1:port or localhost:port.');
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw graphSharingFailure('Listen port is invalid.');
  }
  return {hostname: match[1] as GraphShareListenAddress['hostname'], port};
}

export const runGraphShareControlServer = Effect.fn('codeGraph.sharing.controlServer')(function* <E, R>(
  options: GraphShareControlServerOptions<E, R>,
) {
  return yield* Effect.scoped(
    Layer.build(BunHttpServer.layer({hostname: options.listen.hostname, port: options.listen.port})).pipe(
      Effect.flatMap(context =>
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          const stateRef = yield* Ref.make(yield* loadGraphShareCoordinatorState(options));
          const authenticatedReader =
            options.authorization === undefined
              ? undefined
              : yield* makeGraphControlReader({
                  ...options.authorization,
                  casRoot: options.casRoot,
                  coordinatorStateRef: stateRef,
                  threadnoteHome: options.threadnoteHome,
                });
          yield* server.serve(authenticatedReader?.handle ?? handleGraphShareHttp(options, stateRef));
          const actualPort =
            server.address._tag === 'InetAddressV4' || server.address._tag === 'InetAddressV6'
              ? server.address.port
              : options.listen.port;
          const url = `http://${options.listen.hostname}:${actualPort}`;
          yield* options.onListening?.({port: actualPort, url}) ?? Effect.void;
          if (options.republish !== undefined) {
            yield* Effect.forkScoped(watchPublishedFrontier(options, stateRef, options.republish(stateRef)));
          }
          return yield* Effect.never;
        }).pipe(Effect.provide(context)),
      ),
    ),
  );
});

export const updateGraphShareCoordinatorMachine = Effect.fn('codeGraph.sharing.updateCoordinatorMachine')(function* (
  options: Pick<GraphShareControlServerOptions, 'organization' | 'repositoryId' | 'threadnoteHome'>,
  machine: GraphShareCoordinatorStateV1['machine'],
  stateRef?: Ref.Ref<GraphShareCoordinatorStateV1>,
) {
  yield* withCoordinatorStateLock(
    options,
    Effect.gen(function* () {
      const current =
        stateRef === undefined ? yield* loadGraphShareCoordinatorState(options) : yield* Ref.get(stateRef);
      const next = {...current, machine};
      if (stateRef !== undefined) yield* Ref.set(stateRef, next);
      yield* persistCoordinatorState(options, next);
    }),
  );
});

export const recordPublishedFrontier = Effect.fn('codeGraph.sharing.recordPublishedFrontier')(function* (
  options: Pick<GraphShareControlServerOptions, 'casRoot' | 'organization' | 'repositoryId' | 'threadnoteHome'>,
  published: GraphSharePublishedFrontier,
  stateRef?: Ref.Ref<GraphShareCoordinatorStateV1>,
) {
  const path = yield* Path.Path;
  if (published.descriptorDigest === undefined) {
    return yield* graphSharingFailure('Published frontier is missing an OCI descriptor digest.');
  }
  const branchHash = frontierBranchHash(published.repositoryId, published.branch);
  const pointer: GraphShareFrontierPointerDigestV1 = {
    envelopeDigest: published.envelopeDigest,
    manifestDigest: published.manifestDigest,
  };
  yield* writePrivateJsonFile(graphSharingTagPath(path, options.casRoot, `tn-frontier-${branchHash}`), {
    digest: published.descriptorDigest,
    envelopeDigest: published.envelopeDigest,
    schemaVersion: 1,
  });
  yield* withCoordinatorStateLock(
    options,
    Effect.gen(function* () {
      const current =
        stateRef === undefined ? yield* loadGraphShareCoordinatorState(options) : yield* Ref.get(stateRef);
      const next = {
        ...setGraphShareCoordinatorFrontier(current, branchHash, pointer),
        machine: adoptPublishedFrontier(current.machine, {
          generation: published.generation,
          manifestDigest: published.manifestDigest,
          sourceCommit: published.sourceCommit,
        }),
      };
      if (stateRef !== undefined) yield* Ref.set(stateRef, next);
      yield* persistCoordinatorState(options, next);
    }),
  );
  return pointer;
});

const handleGraphShareHttp = (
  options: Pick<GraphShareControlServerOptions, 'casRoot' | 'organization' | 'repositoryId' | 'threadnoteHome'>,
  stateRef: Ref.Ref<GraphShareCoordinatorStateV1>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const pathname = requestUrlPath(request.url);
    const method = request.method;
    if (method === 'POST' && pathname === '/v1/assembly-leases') {
      return HttpServerResponse.jsonUnsafe({error: 'publisher-operation-forbidden'}, {status: 403});
    }
    const casHex = parseGraphShareHttpCasPath(pathname);
    if (casHex !== undefined) {
      if (method === 'GET' || method === 'HEAD') return yield* serveCasBlob(options.casRoot, casHex, method === 'HEAD');
      if (method === 'PUT') return yield* receiveCasBlob(options.casRoot, casHex, request);
      return HttpServerResponse.jsonUnsafe({error: 'method-not-allowed'}, {status: 405});
    }
    const tagName = parseGraphShareHttpTagPath(pathname);
    if (tagName !== undefined) {
      if (method === 'GET' || method === 'HEAD') return yield* serveTag(options.casRoot, tagName);
      if (method === 'PUT') return yield* receiveTag(options.casRoot, tagName, request);
      return HttpServerResponse.jsonUnsafe({error: 'method-not-allowed'}, {status: 405});
    }
    if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
      return HttpServerResponse.jsonUnsafe({error: 'method-not-allowed'}, {status: 405});
    }
    const raw =
      method === 'POST' ? yield* readBoundedBody(request, GRAPH_SHARE_CONTROL_MAX_BODY_BYTES) : new Uint8Array();
    const parsed =
      method === 'POST'
        ? yield* HttpServerRequest.schemaBodyJson(Schema.Json, {errors: 'all'}).pipe(Effect.option)
        : undefined;
    if (parsed?._tag === 'None') {
      return HttpServerResponse.jsonUnsafe({error: 'invalid-request'}, {status: 400});
    }
    const body = parsed?._tag === 'Some' ? parsed.value : undefined;
    const controlRequest = {
      ...(body === undefined ? {} : {body}),
      bodyBytes: raw.byteLength,
      method: method === 'HEAD' ? 'GET' : method,
      path: pathname,
    } as const;
    if (method === 'GET' || method === 'HEAD') {
      const dispatched = dispatchGraphShareControl(yield* Ref.get(stateRef), controlRequest);
      return HttpServerResponse.jsonUnsafe(dispatched.response.body, {status: dispatched.response.status});
    }
    const dispatched = yield* commitCoordinatorDispatch(options, stateRef, controlRequest);
    return HttpServerResponse.jsonUnsafe(dispatched.response.body, {status: dispatched.response.status});
  }).pipe(
    Effect.catch(error =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          {
            error:
              Schema.is(GraphSharingError)(error) && error.message.includes('exceeds')
                ? 'payload-too-large'
                : Schema.isSchemaError(error)
                  ? 'invalid-request'
                  : 'unavailable',
          },
          {
            status:
              Schema.is(GraphSharingError)(error) && error.message.includes('exceeds')
                ? 413
                : Schema.isSchemaError(error)
                  ? 400
                  : 500,
          },
        ),
      ),
    ),
  );

const watchPublishedFrontier = <E, R>(
  options: GraphShareControlServerOptions<E, R>,
  stateRef: Ref.Ref<GraphShareCoordinatorStateV1>,
  republish: Effect.Effect<GraphSharePublishedFrontier, E, R>,
) =>
  Effect.forever(
    Effect.sleep(GRAPH_SHARE_PUBLISHER_WATCH_INTERVAL).pipe(
      Effect.andThen(
        republish.pipe(
          Effect.flatMap(published =>
            published.published === false ? Effect.void : recordPublishedFrontier(options, published, stateRef),
          ),
          Effect.ignore,
        ),
      ),
    ),
  );

function requestUrlPath(url: string): string {
  try {
    return new URL(url, 'http://127.0.0.1').pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

const serveCasBlob = Effect.fn('codeGraph.sharing.serveCasBlob')(function* (
  casRoot: string,
  hex: string,
  head: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = graphSharingCasBlobPath(path, casRoot, hex);
  if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
    return HttpServerResponse.jsonUnsafe({error: 'not-found'}, {status: 404});
  }
  if (!(yield* fs.exists(target))) return HttpServerResponse.jsonUnsafe({error: 'not-found'}, {status: 404});
  const info = yield* fs.stat(target);
  if (info.size > BigInt(GRAPH_SHARE_HTTP_CAS_MAX_BYTES)) {
    return HttpServerResponse.jsonUnsafe({error: 'payload-too-large'}, {status: 413});
  }
  const bytes = yield* readVerifiedCasBlob(casRoot, `sha256:${hex}`).pipe(Effect.orElseSucceed(() => undefined));
  if (bytes === undefined) return HttpServerResponse.jsonUnsafe({error: 'not-found'}, {status: 404});
  if (graphSharePayloadLooksLikeGitObject(bytes)) {
    return HttpServerResponse.jsonUnsafe({error: 'not-found'}, {status: 404});
  }
  if (head) return HttpServerResponse.empty({status: 200});
  return HttpServerResponse.uint8Array(bytes, {contentType: 'application/octet-stream', status: 200});
});

const receiveCasBlob = Effect.fn('codeGraph.sharing.receiveCasBlob')(function* (
  casRoot: string,
  hex: string,
  request: HttpServerRequest.HttpServerRequest,
) {
  const bytes = yield* readBoundedBody(request, GRAPH_SHARE_HTTP_CAS_MAX_BYTES);
  if (graphSharePayloadLooksLikeGitObject(bytes)) {
    return HttpServerResponse.jsonUnsafe({error: 'git-object-forbidden'}, {status: 400});
  }
  const digest = sha256Digest(bytes);
  if (sha256HexFromDigest(digest) !== hex) {
    return HttpServerResponse.jsonUnsafe({error: 'digest-mismatch'}, {status: 400});
  }
  yield* putCasBytes(casRoot, bytes);
  yield* verifyCasBlob(casRoot, digest);
  return HttpServerResponse.jsonUnsafe({digest}, {status: 201});
});

const serveTag = Effect.fn('codeGraph.sharing.serveTag')(function* (casRoot: string, name: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const tagPath = graphSharingTagPath(path, casRoot, name);
  if (!(yield* fs.exists(tagPath))) return HttpServerResponse.jsonUnsafe({error: 'not-found'}, {status: 404});
  const value = yield* readJsonFile(tagPath);
  return HttpServerResponse.jsonUnsafe(value, {status: 200});
});

const receiveTag = Effect.fn('codeGraph.sharing.receiveTag')(function* (
  casRoot: string,
  name: string,
  request: HttpServerRequest.HttpServerRequest,
) {
  assertGraphShareDiscoveryTag(name);
  if (!name.startsWith('tn-action-')) {
    return HttpServerResponse.jsonUnsafe({error: 'publisher-operation-forbidden'}, {status: 403});
  }
  yield* readBoundedBody(request, GRAPH_SHARE_CONTROL_MAX_BODY_BYTES);
  const decoded = yield* HttpServerRequest.schemaBodyJson(GraphShareHttpTagBody, STRICT).pipe(Effect.option);
  if (decoded._tag === 'None') {
    return HttpServerResponse.jsonUnsafe({error: 'invalid-request'}, {status: 400});
  }
  const digest = parseSha256Digest(decoded.value.digest);
  const path = yield* Path.Path;
  yield* writePrivateJsonFile(graphSharingTagPath(path, casRoot, name), {digest, schemaVersion: 1});
  return HttpServerResponse.jsonUnsafe({digest}, {status: 201});
});

const readBoundedBody = (request: HttpServerRequest.HttpServerRequest, maximum: number) =>
  Effect.gen(function* () {
    const declared = Number(request.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > maximum) {
      return yield* graphSharingFailure('Request body exceeds the transfer limit.');
    }
    const buffer = yield* request.arrayBuffer;
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength > maximum) {
      return yield* graphSharingFailure('Request body exceeds the transfer limit.');
    }
    return bytes;
  });

export const loadGraphShareCoordinatorState = Effect.fn('codeGraph.sharing.loadGraphShareCoordinatorState')(function* (
  options: Pick<GraphShareControlServerOptions, 'organization' | 'repositoryId' | 'threadnoteHome'>,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const layout = graphSharingLayout(path, options.threadnoteHome);
  const empty = emptyGraphShareCoordinatorState({
    organization: options.organization,
    repositoryId: options.repositoryId,
  });
  if (!(yield* fs.exists(layout.coordinatorStatePath))) return empty;
  const loaded = yield* readJsonFile(layout.coordinatorStatePath).pipe(Effect.option);
  if (loaded._tag === 'None' || !isCoordinatorState(loaded.value, options.repositoryId)) return empty;
  return loaded.value;
});

const persistCoordinatorState = Effect.fn('codeGraph.sharing.persistCoordinatorState')(function* (
  options: Pick<GraphShareControlServerOptions, 'threadnoteHome'>,
  state: GraphShareCoordinatorStateV1,
) {
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, options.threadnoteHome);
  yield* writePrivateJsonFile(layout.coordinatorStatePath, state);
});

const commitCoordinatorDispatch = (
  options: Pick<GraphShareControlServerOptions, 'threadnoteHome'>,
  stateRef: Ref.Ref<GraphShareCoordinatorStateV1>,
  request: Parameters<typeof dispatchGraphShareControl>[1],
) =>
  withCoordinatorStateLock(
    options,
    Effect.gen(function* () {
      const dispatched = yield* Ref.modify(stateRef, state => {
        const next = dispatchGraphShareControl(state, request);
        return [{persist: next.state !== state, response: next.response, state: next.state}, next.state] as const;
      });
      if (dispatched.persist) {
        yield* persistCoordinatorState(options, dispatched.state);
      }
      return dispatched;
    }),
  );

function frontierBranchHash(repositoryId: string, branch: string): string {
  return graphShareFrontierDiscoveryTag(repositoryId, branch).slice('tn-frontier-'.length);
}

function isCoordinatorState(value: unknown, repositoryId: string): value is GraphShareCoordinatorStateV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    'repositoryId' in value &&
    (value as GraphShareCoordinatorStateV1).repositoryId === repositoryId
  );
}
