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
