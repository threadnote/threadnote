import type {RemoteMemoryServiceConfig} from '@threadnote/remote-memory/config';
import {createRemoteMemoryHttpHandler} from './http_transport.js';
import type {LocalIdp} from './local_idp.js';
import type {RemoteMemoryServiceDependencies} from '@threadnote/remote-memory/service_types';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface RemoteMemoryServer {
  readonly hostname: string;
  readonly port: number;
  readonly stop: (closeActiveConnections?: boolean) => Promise<void>;
  readonly url: URL;
}

export interface StartRemoteMemoryServerOptions {
  readonly config: RemoteMemoryServiceConfig;
  readonly dependencies: RemoteMemoryServiceDependencies;
  readonly localIdp?: LocalIdp;
  readonly serve?: typeof Bun.serve;
}

export function startRemoteMemoryServer(options: StartRemoteMemoryServerOptions): RemoteMemoryServer {
  const fetch = createRemoteMemoryHttpHandler({
    config: options.config,
    dependencies: options.dependencies,
    ...(options.localIdp ? {localIdp: options.localIdp} : {}),
  });
  const server = (options.serve ?? Bun.serve)({
    fetch,
    hostname: options.config.host,
    maxRequestBodySize: options.config.maxBodyBytes,
    port: options.config.port,
  });
  const port = server.port ?? options.config.port;
  const hostname = server.hostname ?? options.config.host;
  let stopped = false;
  return {
    hostname,
    port,
    stop: async (closeActiveConnections = false) => {
      if (stopped) return;
      stopped = true;
      await server.stop(closeActiveConnections);
    },
    url: new URL(`http://${displayHost(hostname)}:${port}`),
  };
}

function displayHost(hostname: string): string {
  if (hostname === '0.0.0.0') return '127.0.0.1';
  if (hostname === '::') return '[::1]';
  return Effect.pipe(hostname, EffectString.includes(':')) && !Effect.pipe(hostname, EffectString.startsWith('['))
    ? `[${hostname}]`
    : hostname;
}
