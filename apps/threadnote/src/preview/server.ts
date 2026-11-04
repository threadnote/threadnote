import {Console, Context, Effect, Option, Schema} from 'effect';
import * as Base64Url from 'effect/encoding/Base64Url';
import * as SecureRandom from 'effect/crypto/SecureRandom';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {decodeMemoryLaunchUri} from '@threadnote/memory/navigation-link';
import {renderMemoryPreview, renderMemoryPreviewError} from '@threadnote/manager/preview';
import {openLoopbackUrl} from '@threadnote/platform/open-url';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ApplicationServices} from '../effect/runtime.js';

const IDLE_MS = 10 * 60 * 1000;
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export class MemoryPreviewStartupError extends Schema.TaggedError<
  MemoryPreviewStartupError,
  {readonly brand: unique symbol}
>()('MemoryPreviewStartupError', {message: Schema.String}) {}

interface PreviewListener {
  readonly port?: number;
  stop(closeActiveConnections?: boolean): void;
}

export interface MemoryPreviewOptions {
  readonly open?: boolean;
  /** Test seam for process and opener failures. */
  readonly listen?: (handler: (request: Request) => Promise<Response>) => PreviewListener;
  readonly openUrl?: (url: string) => Effect.Effect<void, unknown, ApplicationServices>;
  readonly idleMs?: number;
}

export interface PreviewReadResult {
  readonly content: string;
  readonly node: Parameters<typeof renderMemoryPreview>[0]['node'];
  readonly memoryId?: string;
}

export class MemoryPreviewRead extends Context.Service<
  MemoryPreviewRead,
  {readonly read: (config: RuntimeConfig, uri: string) => Promise<PreviewReadResult>}
>()('@threadnote/threadnote/preview/server/MemoryPreviewRead') {}

export function createMemoryPreviewHandler(options: {
  readonly token: string;
  readonly port: () => number;
  readonly read: () => Promise<PreviewReadResult>;
  readonly touched?: () => void;
}): (request: Request) => Promise<Response> {
  return async request => {
    const headers = {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    };
    const url = new URL(request.url);
    const origin = `http://127.0.0.1:${options.port()}`;
    if (
      request.method !== 'GET' ||
      url.origin !== origin ||
      url.pathname !== `/${options.token}` ||
      url.search !== '' ||
      (request.headers.get('origin') && request.headers.get('origin') !== origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return new Response('Not found', {status: 404, headers});
    options.touched?.();
    try {
      const document = await options.read();
      return new Response(renderMemoryPreview(document), {
        status: 200,
        headers: {...headers, 'Content-Type': 'text/html; charset=utf-8'},
      });
    } catch {
      return new Response(renderMemoryPreviewError(), {
        status: 404,
        headers: {...headers, 'Content-Type': 'text/html; charset=utf-8'},
      });
    }
  };
}

export function runMemoryPreview(
  config: RuntimeConfig,
  launchUri: string,
  options: MemoryPreviewOptions = {},
): Effect.Effect<void, unknown, ApplicationServices> {
  return Effect.scoped(
    Effect.gen(function* () {
      // Decode before starting the listener; there is no dynamic target route.
      const target = decodeMemoryLaunchUri(launchUri);
      const uri = target.kind === 'id' ? memoryIdentityAlias(target.ref) : target.ref;
      const reader = yield* Effect.serviceOption(MemoryPreviewRead);
      if (Option.isNone(reader))
        return yield* MemoryPreviewStartupError.make({
          message: 'Private memory reader is unavailable. Run threadnote doctor.',
        });
      const random = yield* SecureRandom.SecureRandom;
      const token = Base64Url.encode(yield* random.randomBytes(24));
      let port = 0;
      let touched = () => {};
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const handler = createMemoryPreviewHandler({
            token,
            port: () => port,
            read: () => reader.value.read(config, uri),
            touched: () => touched(),
          });
          const listener = options.listen
            ? options.listen(handler)
            : Bun.serve({hostname: '127.0.0.1', port: 0, fetch: handler});
          if (listener.port === undefined || listener.port <= 0) {
            listener.stop(true);
            throw new Error('Private preview listener did not bind a port.');
          }
          port = listener.port ?? 0;
          return listener;
        }),
        listener => Effect.sync(() => listener.stop(true)),
      ).pipe(Effect.catchCause(previewStartupFailure));
      const localUrl = `http://127.0.0.1:${server.port}/${token}`;
      if (options.open !== false)
        yield* (options.openUrl ?? openLoopbackUrl)(localUrl).pipe(Effect.catchCause(previewStartupFailure));
      else yield* Console.log(localUrl);
      yield* Effect.callback<void>(resume => {
        let timer: ReturnType<typeof setTimeout>;
        touched = () => {
          clearTimeout(timer);
          timer = setTimeout(() => resume(Effect.void), options.idleMs ?? IDLE_MS);
        };
        touched();
        return Effect.sync(() => clearTimeout(timer));
      });
    }),
  );
}

function previewStartupFailure() {
  return Effect.fail(
    MemoryPreviewStartupError.make({
      message: 'Could not start the private memory preview. Retry, then run threadnote doctor if it persists.',
    }),
  );
}
