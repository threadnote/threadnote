import {Effect, Predicate, Schema} from 'effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';

export class ManagerRequestError extends Schema.TaggedError<ManagerRequestError>()('ManagerRequestError', {
  message: Schema.String,
}) {}

export interface ManagerHttpRequest {
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly method: string;
  readonly url: string;
}

export type ManagerRouteHandler<R = never> = (
  request: ManagerHttpRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse | undefined, unknown, R>;

/** Adapts Effect HTTP requests to the stable Manager route protocol. */
export function createManagerHttpServer<R>(handle: ManagerRouteHandler<R>) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const managerRequest: ManagerHttpRequest = {
      body: request.json.pipe(
        Effect.filterOrFail(
          (parsed): parsed is Schema.JsonObject => Predicate.isObject(parsed),
          () => ManagerRequestError.make({message: 'Expected a JSON object body.'}),
        ),
      ),
      headers: request.headers,
      method: request.method,
      url: request.url,
    };
    return (yield* handle(managerRequest)) ?? HttpServerResponse.empty({status: 204});
  });
}

export const MANAGER_STATIC_FILES: Readonly<
  Record<
    string,
    {
      readonly contentType: string;
      readonly directory?: 'assets/brand' | 'manager';
      readonly path: string;
      readonly sourceDirectory?: 'dist/manager' | 'packages/manager/static' | 'node_modules/@mdxeditor/editor/dist';
    }
  >
> = {
  '/': {contentType: 'text/html; charset=utf-8', path: 'index.html', sourceDirectory: 'packages/manager/static'},
  '/index.html': {
    contentType: 'text/html; charset=utf-8',
    path: 'index.html',
    sourceDirectory: 'packages/manager/static',
  },
  '/app.css': {
    contentType: 'text/css; charset=utf-8',
    path: 'app.css',
    sourceDirectory: 'packages/manager/static',
  },
  '/integrations/obsidian.svg': {
    contentType: 'image/svg+xml',
    path: 'integrations/obsidian.svg',
    sourceDirectory: 'packages/manager/static',
  },
  '/integrations/superhuman-docs.png': {
    contentType: 'image/png',
    path: 'integrations/superhuman-docs.png',
    sourceDirectory: 'packages/manager/static',
  },
  '/integrations/pocket.png': {
    contentType: 'image/png',
    path: 'integrations/pocket.png',
    sourceDirectory: 'packages/manager/static',
  },
  '/integrations/linear.svg': {
    contentType: 'image/svg+xml',
    path: 'integrations/linear.svg',
    sourceDirectory: 'packages/manager/static',
  },
  '/editor.css': {
    contentType: 'text/css; charset=utf-8',
    path: 'style.css',
    sourceDirectory: 'node_modules/@mdxeditor/editor/dist',
  },
  '/app.js': {contentType: 'text/javascript; charset=utf-8', path: 'app.js', sourceDirectory: 'dist/manager'},
  '/favicon.svg': {
    contentType: 'image/svg+xml; charset=utf-8',
    directory: 'assets/brand',
    path: 'continuum/threadnote-circle-brand-dark.svg',
  },
  '/threadnote-logo.svg': {
    contentType: 'image/svg+xml; charset=utf-8',
    directory: 'assets/brand',
    path: 'threadnote-logo.svg',
  },
  '/threadnote-logo-light.svg': {
    contentType: 'image/svg+xml; charset=utf-8',
    directory: 'assets/brand',
    path: 'continuum/threadnote-circle-brand-light.svg',
  },
  '/threadnote-logo-dark.svg': {
    contentType: 'image/svg+xml; charset=utf-8',
    directory: 'assets/brand',
    path: 'continuum/threadnote-circle-brand-dark.svg',
  },
};
