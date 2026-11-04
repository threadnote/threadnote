import {Array as EffectArray, Console, Context, Effect, Option, Schema, String as EffectString} from 'effect';
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
const BOOTSTRAP_POLICY =
  "default-src 'none'; script-src 'nonce-preview-bootstrap'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const BOOTSTRAP_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Private memory preview</title></head><body><p>Opening private memory…</p><script nonce="preview-bootstrap">
const secret = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
if (secret) fetch('/session', {method: 'POST', headers: {'Content-Type': 'text/plain'}, body: secret, credentials: 'same-origin'}).then(response => { if (response.ok) location.replace('/'); else document.body.textContent = 'Private preview unavailable.'; }).catch(() => { document.body.textContent = 'Private preview unavailable.'; });
else document.body.textContent = 'Private preview unavailable.';
</script></body></html>`;

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
  {
    readonly prepare: (
      config: RuntimeConfig,
      uri: string,
      signal: AbortSignal,
    ) => Promise<() => Promise<PreviewReadResult>>;
  }
>()('@threadnote/threadnote/preview/server/MemoryPreviewRead') {}

export function createMemoryPreviewHandler(options: {
  readonly token: string;
  readonly port: () => number;
  readonly read?: () => Promise<PreviewReadResult>;
  readonly prepare?: (signal: AbortSignal) => Promise<() => Promise<PreviewReadResult>>;
  readonly signal?: AbortSignal;
  readonly touched?: () => void;
}): (request: Request) => Promise<Response> {
  let reading = false;
  let job:
    {state: 'pending'} | {state: 'ready'; read: () => Promise<PreviewReadResult>} | {state: 'failed'} | undefined;
  const signal = options.signal ?? new AbortController().signal;
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
      url.origin !== origin ||
      url.search !== '' ||
      (request.headers.get('origin') && request.headers.get('origin') !== origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return new Response('Not found', {status: 404, headers});
    const cookieName = `threadnote_preview_${options.port()}`;
    if (request.method === 'POST' && url.pathname === '/session') {
      if (
        request.headers.get('origin') !== origin ||
        request.headers.get('content-type') !== 'text/plain' ||
        request.headers.get('sec-fetch-site') !== 'same-origin' ||
        request.headers.get('content-length') !== String(options.token.length)
      )
        return new Response('Not found', {status: 404, headers});
      if ((await request.text()) !== options.token) return new Response('Not found', {status: 404, headers});
      options.touched?.();
      return new Response(null, {
        status: 204,
        headers: {...headers, 'Set-Cookie': `${cookieName}=${options.token}; HttpOnly; SameSite=Strict; Path=/`},
      });
    }
    if (request.method !== 'GET' || url.pathname !== '/') return new Response('Not found', {status: 404, headers});
    const cookie = request.headers.get('cookie') ?? '';
    if (
      !EffectArray.some(
        EffectString.split(';')(cookie),
        part => EffectString.trim(part) === `${cookieName}=${options.token}`,
      )
    )
      return new Response(BOOTSTRAP_PAGE, {
        status: 200,
        headers: {...headers, 'Content-Security-Policy': BOOTSTRAP_POLICY, 'Content-Type': 'text/html; charset=utf-8'},
      });
    if (reading)
      return new Response(
        '<!doctype html><title>Preview busy</title><h1>Preview busy</h1><p>A previous read is still running. Wait a moment, then reload this page.</p>',
        {
          status: 503,
          headers: {...headers, 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '1'},
        },
      );
    options.touched?.();
    if (!job) {
      job = {state: 'pending'};
      const prepare = options.prepare ?? (() => Promise.resolve(options.read!));
      void Promise.resolve()
        .then(() => prepare(signal))
        .then(
          read => {
            job = {state: 'ready', read};
          },
          () => {
            job = {state: 'failed'};
          },
        );
    }
    if (job.state === 'pending')
      return new Response(
        '<!doctype html><meta http-equiv="refresh" content="1"><title>Opening memory</title><h1>Opening memory</h1><p>Checking local memory identities. This page will retry automatically.</p>',
        {status: 202, headers: {...headers, 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '1'}},
      );
    if (job.state === 'failed') {
      job = undefined;
      return new Response(renderMemoryPreviewError(), {
        status: 404,
        headers: {...headers, 'Content-Type': 'text/html; charset=utf-8'},
      });
    }
    const ready = job;
    reading = true;
    try {
      const document = await ready.read();
      return new Response(renderMemoryPreview(document), {
        status: 200,
        headers: {...headers, 'Content-Type': 'text/html; charset=utf-8'},
      });
    } catch {
      return new Response(renderMemoryPreviewError(), {
        status: 404,
        headers: {...headers, 'Content-Type': 'text/html; charset=utf-8'},
      });
    } finally {
      job = undefined;
      reading = false;
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
      // oxlint-disable-next-line effecttsgo/abort-controller-in-effect -- The listener owns a Promise-backed job that must also be aborted on normal scope release.
      const controller = new AbortController();
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const handler = createMemoryPreviewHandler({
            token,
            port: () => port,
            prepare: signal => reader.value.prepare(config, uri, signal),
            signal: controller.signal,
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
        listener =>
          Effect.sync(() => {
            controller.abort();
            listener.stop(true);
          }),
      ).pipe(Effect.catchCause(previewStartupFailure));
      const localUrl = `http://127.0.0.1:${server.port}/#${token}`;
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
