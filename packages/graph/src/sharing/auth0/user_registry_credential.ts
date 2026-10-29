import {Effect, Path} from 'effect';
import {fromPromiseInterruptibleAwaiting} from '@threadnote/platform/errors';
import {SystemInfo} from '@threadnote/platform/system';
import {getRegistryAuth0UserCredential, type Auth0UserBackend} from './user.js';
import {graphSharingFailure} from '../errors.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface Auth0UserRegistryHelperIO {
  readonly stdin: AsyncIterable<Uint8Array | string>;
  readonly writeStderr: (text: string) => void;
  readonly writeStdout: (text: string) => void;
}

/** Docker's get protocol sends an exact registry host, never an URL or repository path. */
export const runAuth0UserRegistryCredentialHelper = Effect.fn('codeGraph.sharing.auth0UserRegistryCredentialHelper')(
  function* (arguments_: readonly string[], io: Auth0UserRegistryHelperIO, backendOverride?: Auth0UserBackend) {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    const home = system.environment().THREADNOTE_HOME ?? path.join(system.homeDirectory, '.threadnote');
    const unavailable = () => {
      io.writeStderr('Auth0 registry credential unavailable.\n');
      return 1;
    };
    if (arguments_.length !== 1 || arguments_[0] !== 'get' || !path.isAbsolute(home)) return unavailable();
    const result = yield* fromPromiseInterruptibleAwaiting(
      async () => {
        const chunks: Uint8Array[] = [];
        let length = 0;
        for await (const chunk of io.stdin) {
          const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
          length += bytes.length;
          if (length > 512) throw graphSharingFailure('Registry helper request is too large.');
          chunks.push(bytes);
        }
        const value = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
        if (
          !Effect2.pipe(value, EffectString.endsWith('\n')) ||
          Effect2.pipe(
            value,
            EffectString.indexOf('\n'),
            Effect2.Option.getOrElse(() => -1),
          ) !==
            value.length - 1
        )
          throw graphSharingFailure('Registry helper request is invalid.');
        const server = Effect2.pipe(value, EffectString.slice(0, -1));
        if (!/^[a-z0-9.-]+(?::[1-9][0-9]{0,4})?$/u.test(server))
          throw graphSharingFailure('Registry helper request is invalid.');
        return server;
      },
      () => graphSharingFailure('Registry helper request is invalid.'),
    ).pipe(
      Effect.flatMap(server => getRegistryAuth0UserCredential(home, server, backendOverride)),
      Effect.option,
    );
    if (result._tag === 'None') return unavailable();
    io.writeStdout(
      `${JSON.stringify({
        Secret: result.value.accessToken,
        ServerURL: result.value.audience,
        Username: 'zot',
      })}\n`,
    );
    return 0;
  },
);
