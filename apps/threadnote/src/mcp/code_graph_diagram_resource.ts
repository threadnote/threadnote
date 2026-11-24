import {Clock, Effect, FileSystem, Option, Path, Predicate, Semaphore, String as Str} from 'effect';
import {McpSchema} from 'effect/ai';
import {SecureRandom} from 'effect/crypto';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {
  IsolatedCodeGraphImpactQueryError,
  type VerifiedCodeGraphDiagram,
} from '@threadnote/graph/isolated/impact_query';
import type {EffectMcpServerAdapter} from '../effect/ai/mcp.js';
import {MCP_RESOURCE_NOT_FOUND_ERROR_DATA} from '../effect/ai/mcp.js';

const DIAGRAM_URI = 'threadnote://graph-diagram/';
const DIAGRAM_PART_MIME_TYPE = 'application/octet-stream';
const DIAGRAM_PART_BYTES = 32 * 1_024;
const DIAGRAM_LIFETIME_MILLISECONDS = 10 * 60 * 1_000;
const DIAGRAM_PART_URI_PATTERN = /^threadnote:\/\/graph-diagram\/([0-9a-f]{64})\/([1-9][0-9]*)$/u;
const DIAGRAM_DIRECTORY_PREFIX = 'threadnote-mcp-diagrams-';
const DIAGRAM_DIRECTORY_PATTERN = /^threadnote-mcp-diagrams-[0-9a-f]{64}$/u;
const DIAGRAM_RESOURCE_FILE = /^[0-9a-f]{64}\.json$/u;
const DIAGRAM_STAGING_DIRECTORY_PREFIX = 'threadnote-graph-diagram-';
const REPEAT_DIAGRAM_QUERY = 'Repeat the original inspect_code_graph query.';
const UNAVAILABLE_DIAGRAM_RESOURCE = 'The diagram resource is unavailable.';
export const MCP_DIAGRAM_OWNER_DIRECTORY_ENV = 'THREADNOTE_MCP_DIAGRAM_OWNER_DIRECTORY';

export type CodeGraphDiagramResources = Effect.Success<ReturnType<typeof makeCodeGraphDiagramResources>>;

export const makeCodeGraphDiagramResources = Effect.fn('mcpServer.makeDiagramResources')(function* (
  owner: 'server' | 'broker' | 'broker-child' = 'server',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const system = yield* SystemInfo;
  const temp = path.resolve(system.tempDirectory);
  const environment = system.environment();
  const providedDirectory = environment[MCP_DIAGRAM_OWNER_DIRECTORY_ENV];
  const sharedDirectory =
    owner === 'broker-child' &&
    providedDirectory !== undefined &&
    path.dirname(providedDirectory) === temp &&
    DIAGRAM_DIRECTORY_PATTERN.test(path.basename(providedDirectory))
      ? providedDirectory
      : undefined;
  const directory =
    sharedDirectory ?? path.join(temp, DIAGRAM_DIRECTORY_PREFIX + sha256HexSync(yield* random.randomBytes(32)));
  const runtimeBound = owner === 'broker-child' && sharedDirectory === undefined;
  const expiration = runtimeBound
    ? 'Parts belong to the current MCP runtime. They expire after 10 idle minutes or as soon as that runtime exits.'
    : 'Parts expire after 10 idle minutes or when this stdio session ends.';
  const recovery = runtimeBound
    ? 'Reconnect to the updated Threadnote MCP broker. Repeat the original inspect_code_graph query.'
    : REPEAT_DIAGRAM_QUERY;
  const gate = yield* Semaphore.make(1);
  const entryPath = (id: string) => path.join(directory, id + '.json');

  const prepareDirectory = Effect.gen(function* () {
    yield* fs.makeDirectory(directory, {mode: 0o700}).pipe(
      Effect.catchIf(
        error => error.reason._tag === 'AlreadyExists',
        () => Effect.void,
      ),
    );
    const stat = yield* fs.stat(directory);
    if (stat.type !== 'Directory' || (system.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      return yield* IsolatedCodeGraphImpactQueryError.make({
        message: 'Threadnote could not open private diagram storage.',
      });
    }
    return directory;
  }).pipe(
    Effect.catchTag('PlatformError', () =>
      Effect.fail(
        IsolatedCodeGraphImpactQueryError.make({message: 'Threadnote could not open private diagram storage.'}),
      ),
    ),
  );

  // Only the session owner removes the shared directory. Runtime children can exit while it is still in use.
  if (sharedDirectory === undefined) {
    yield* Effect.addFinalizer(() => fs.remove(directory, {recursive: true, force: true}).pipe(Effect.ignore));
    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const names = yield* fs.readDirectory(directory);
      for (const name of names) {
        const staging = Str.startsWith(DIAGRAM_STAGING_DIRECTORY_PREFIX)(name);
        if (!staging && !DIAGRAM_RESOURCE_FILE.test(name)) continue;
        const filename = path.join(directory, name);
        yield* gate
          .withPermit(
            Effect.gen(function* () {
              const stat = yield* fs.stat(filename);
              if (diagramExpired(stat, now)) yield* fs.remove(filename, {force: true, recursive: staging});
            }),
          )
          .pipe(Effect.ignore);
      }
    }).pipe(Effect.ignore);
    yield* Effect.forkScoped(Effect.forever(Effect.sleep('1 minute').pipe(Effect.andThen(sweep))));
  }

  const publish = Effect.fn('mcpServer.publishGraphDiagram')(function* (artifact: VerifiedCodeGraphDiagram) {
    const id = sha256HexSync(yield* random.randomBytes(32));
    const now = (yield* Clock.currentTimeMillis) / 1_000;
    yield* fs.utimes(artifact.filename, now, now);
    yield* fs.rename(artifact.filename, entryPath(id));
    return {
      status: 'resource' as const,
      diagramStatus: artifact.status,
      scope: artifact.scope,
      freshness: artifact.freshness,
      resource: {
        uriPrefix: `${DIAGRAM_URI}${id}/`,
        partCount: Math.ceil(artifact.bytes / DIAGRAM_PART_BYTES),
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        idleTimeoutMilliseconds: DIAGRAM_LIFETIME_MILLISECONDS,
        ...(runtimeBound ? {lifetime: 'current-runtime' as const, nextAction: recovery} : {}),
        encoding: 'base64',
        mimeType: 'application/json',
      },
    };
  });

  const readPart = Effect.fn('mcpServer.readGraphDiagramPart')((uri: string) =>
    gate.withPermit(
      Effect.scoped(
        Effect.gen(function* () {
          const match = DIAGRAM_PART_URI_PATTERN.exec(uri);
          if (!match) return undefined;
          const filename = entryPath(match[1]);
          const offset = (Number(match[2]) - 1) * DIAGRAM_PART_BYTES;
          if (!Number.isSafeInteger(offset)) return undefined;
          const now = yield* Clock.currentTimeMillis;
          const stat = yield* fs.stat(filename);
          if (stat.type !== 'File' || diagramExpired(stat, now) || BigInt(offset) >= stat.size) return undefined;
          const file = yield* fs.open(filename, {flag: 'r', ...(system.platform === 'win32' ? {} : {noFollow: true})});
          const size = Math.min(DIAGRAM_PART_BYTES, Number(stat.size - BigInt(offset)));
          const data = new Uint8Array(size);
          let readBytes = 0;
          while (readBytes < size) {
            const count = yield* file.read(data.subarray(readBytes), {position: BigInt(offset + readBytes)});
            if (count === 0) return undefined;
            readBytes += count;
          }
          const touched = (yield* Clock.currentTimeMillis) / 1_000;
          yield* fs.utimes(filename, touched, touched);
          return {uri, mimeType: DIAGRAM_PART_MIME_TYPE, blob: data};
        }).pipe(Effect.catchTag('PlatformError', () => Effect.void)),
      ),
    ),
  );

  return {directory, expiration, recovery, prepareDirectory, publish, readPart};
});

function diagramExpired(stat: FileSystem.File.Info, now: number): boolean {
  return Option.isNone(stat.mtime) || stat.mtime.value.getTime() + DIAGRAM_LIFETIME_MILLISECONDS <= now;
}

function unavailableDiagramResource(recovery: string) {
  return McpSchema.InvalidParams.make({
    data: MCP_RESOURCE_NOT_FOUND_ERROR_DATA,
    message: `${UNAVAILABLE_DIAGRAM_RESOURCE} ${recovery}`,
  });
}

export const readBrokerCodeGraphDiagramResource = Effect.fn('mcpBroker.readGraphDiagramResource')(function* (
  resources: CodeGraphDiagramResources,
  params: unknown,
) {
  if (!Predicate.isObject(params) || typeof params.uri !== 'string' || !Str.startsWith(DIAGRAM_URI)(params.uri)) {
    return undefined;
  }
  const part = yield* resources.readPart(params.uri);
  if (!part) return {error: {code: -32_002, message: `${UNAVAILABLE_DIAGRAM_RESOURCE} ${REPEAT_DIAGRAM_QUERY}`}};
  return {result: {contents: [{...part, blob: Buffer.from(part.blob).toString('base64')}]}};
});

export function registerCodeGraphDiagramResource(server: EffectMcpServerAdapter, resources: CodeGraphDiagramResources) {
  server.registerResourceTemplate(
    {
      name: 'Threadnote diagram part',
      description: `Read a returned diagram part. ${resources.expiration}`,
      mimeType: DIAGRAM_PART_MIME_TYPE,
      routerPath: 'threadnote:://graph-diagram/*',
      uriTemplate: `${DIAGRAM_URI}{id}/{part}`,
    },
    (uri, context) =>
      Effect.gen(function* () {
        const part = context.transport === 'stdio' ? yield* resources.readPart(uri) : undefined;
        if (!part) return yield* unavailableDiagramResource(resources.recovery);
        return {contents: [part]} satisfies McpSchema.ReadResourceResult;
      }),
  );
}
