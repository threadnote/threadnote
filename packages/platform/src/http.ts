import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import {Context, Effect, FileSystem, Layer, Schema, Stream} from 'effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type {HttpClientResponse} from 'effect/http/HttpClientResponse';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';

export class HttpRequestFailed extends Schema.TaggedError<HttpRequestFailed>()('HttpRequestFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  method: Schema.String,
  url: Schema.String,
}) {}

export class HttpStatusError extends Schema.TaggedError<HttpStatusError>()('HttpStatusError', {
  message: Schema.String,
  method: Schema.String,
  status: Schema.Finite,
  url: Schema.String,
}) {}

export type HttpError = HttpRequestFailed | HttpStatusError;

export interface HttpResponse<A> {
  readonly body: A;
  readonly status: number;
}

export interface HttpGetOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface HttpDownloadOptions extends HttpGetOptions {
  readonly offset?: number;
}

const dynamicFetch = Object.assign((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args), {
  preconnect: (...args: Parameters<typeof globalThis.fetch.preconnect>) => globalThis.fetch.preconnect(...args),
}) satisfies typeof globalThis.fetch;

export interface HttpServiceShape {
  readonly downloadToFile: (
    url: string | URL,
    path: string,
    options?: HttpDownloadOptions,
  ) => Effect.Effect<{readonly resumed: boolean; readonly status: number}, HttpError>;
  readonly getJson: (url: string | URL, options?: HttpGetOptions) => Effect.Effect<HttpResponse<unknown>, HttpError>;
  readonly getStatus: (url: string | URL, options?: HttpGetOptions) => Effect.Effect<number, HttpRequestFailed>;
  readonly getText: (url: string | URL, options?: HttpGetOptions) => Effect.Effect<HttpResponse<string>, HttpError>;
}

export class HttpService extends Context.Service<HttpService, HttpServiceShape>()(
  '@threadnote/platform/http/HttpService',
) {
  static readonly layer = Layer.effect(
    HttpService,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const fs = yield* FileSystem.FileSystem;
      return HttpService.of({
        downloadToFile: (url, path, options) => download(client, fs, url, path, options),
        getJson: (url, options) => execute(client, url, options, response => response.json),
        getStatus: (url, options) => executeStatus(client, url, options),
        getText: (url, options) => execute(client, url, options, response => response.text),
      });
    }),
  ).pipe(Layer.provide(BunHttpClient.layer));
}

const download = (
  client: HttpClient.HttpClient,
  fs: FileSystem.FileSystem,
  url: string | URL,
  path: string,
  options: HttpDownloadOptions | undefined,
): Effect.Effect<{readonly resumed: boolean; readonly status: number}, HttpError> => {
  const urlText = String(url);
  const offset = options?.offset && options.offset > 0 ? options.offset : 0;
  let request = HttpClientRequest.get(url);
  request = HttpClientRequest.setHeaders(request, {
    ...(options?.headers ?? {}),
    ...(offset > 0 ? {Range: `bytes=${offset}-`} : {}),
  });
  const operation = Effect.gen(function* () {
    const response = yield* client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, dynamicFetch),
      Effect.mapError(cause =>
        HttpRequestFailed.make({
          cause,
          message: `GET ${urlText} failed`,
          method: 'GET',
          url: urlText,
        }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* HttpStatusError.make({
        message: `GET ${urlText} returned HTTP ${response.status}`,
        method: 'GET',
        status: response.status,
        url: urlText,
      });
    }
    const resumed = offset > 0 && response.status === 206;
    yield* Stream.run(response.stream, fs.sink(path, {flag: resumed ? 'a' : 'w', mode: 0o600})).pipe(
      Effect.mapError(cause =>
        HttpRequestFailed.make({
          cause,
          message: `GET ${urlText} response could not be written`,
          method: 'GET',
          url: urlText,
        }),
      ),
    );
    return {resumed, status: response.status};
  });
  return operation.pipe(
    Effect.timeout(options?.timeoutMs ?? 30 * 60_000),
    Effect.mapError(cause =>
      Schema.is(HttpRequestFailed)(cause) || Schema.is(HttpStatusError)(cause)
        ? cause
        : HttpRequestFailed.make({
            cause,
            message: `GET ${urlText} failed`,
            method: 'GET',
            url: urlText,
          }),
    ),
  );
};

const execute = <A>(
  client: HttpClient.HttpClient,
  url: string | URL,
  options: HttpGetOptions | undefined,
  readBody: (response: HttpClientResponse) => Effect.Effect<A, unknown>,
): Effect.Effect<HttpResponse<A>, HttpError> => {
  const urlText = String(url);
  let request = HttpClientRequest.get(url);
  if (options?.headers) {
    request = HttpClientRequest.setHeaders(request, options.headers);
  }
  const response = client.execute(request).pipe(
    Effect.provideService(FetchHttpClient.Fetch, dynamicFetch),
    Effect.mapError(cause =>
      HttpRequestFailed.make({
        cause,
        message: `GET ${urlText} failed`,
        method: 'GET',
        url: urlText,
      }),
    ),
  );
  const completeResponse = Effect.gen(function* () {
    const current = yield* response;
    if (current.status < 200 || current.status >= 300) {
      return yield* HttpStatusError.make({
        message: `GET ${urlText} returned HTTP ${current.status}`,
        method: 'GET',
        status: current.status,
        url: urlText,
      });
    }
    const body = yield* readBody(current).pipe(
      Effect.mapError(cause =>
        HttpRequestFailed.make({
          cause,
          message: `GET ${urlText} response could not be decoded`,
          method: 'GET',
          url: urlText,
        }),
      ),
    );
    return {body, status: current.status};
  });
  return completeResponse.pipe(
    Effect.timeout(options?.timeoutMs ?? 3000),
    Effect.mapError(cause =>
      Schema.is(HttpRequestFailed)(cause) || Schema.is(HttpStatusError)(cause)
        ? cause
        : HttpRequestFailed.make({
            cause,
            message: `GET ${urlText} failed`,
            method: 'GET',
            url: urlText,
          }),
    ),
  );
};

const executeStatus = (
  client: HttpClient.HttpClient,
  url: string | URL,
  options: HttpGetOptions | undefined,
): Effect.Effect<number, HttpRequestFailed> => {
  const urlText = String(url);
  let request = HttpClientRequest.get(url);
  if (options?.headers) {
    request = HttpClientRequest.setHeaders(request, options.headers);
  }
  return client.execute(request).pipe(
    Effect.provideService(FetchHttpClient.Fetch, dynamicFetch),
    Effect.timeout(options?.timeoutMs ?? 3000),
    Effect.map(response => response.status),
    Effect.mapError(cause =>
      HttpRequestFailed.make({
        cause,
        message: `GET ${urlText} failed`,
        method: 'GET',
        url: urlText,
      }),
    ),
  );
};

export const getJsonEffect = Effect.fn('HttpService.getJson')(function* (url: string | URL, options?: HttpGetOptions) {
  const http = yield* HttpService;
  return yield* http.getJson(url, options);
});

export const getTextEffect = Effect.fn('HttpService.getText')(function* (url: string | URL, options?: HttpGetOptions) {
  const http = yield* HttpService;
  return yield* http.getText(url, options);
});

export const getStatusEffect = Effect.fn('HttpService.getStatus')(function* (
  url: string | URL,
  options?: HttpGetOptions,
) {
  const http = yield* HttpService;
  return yield* http.getStatus(url, options);
});
