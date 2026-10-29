import {Array as EffectArray} from 'effect';
import {
  canonicalOAuthUrl,
  oauthCredentialEnvironment,
  parseOAuthM2MProviderConfig,
  type OAuthM2MProviderConfig,
} from './m2m_config.js';
import {
  requestVerifiedOAuthM2MToken,
  type OAuthM2MHelperIO,
  type OAuthM2MTokenDependencies,
} from './m2m_graph_credential.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const MAX_INPUT_BYTES = 512;
const SERVER = /^[a-z0-9.-]+(?::[1-9][0-9]{0,4})?$/u;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const WORKER_SCOPE = 'registry:worker';
const PUBLISHER_SCOPE = 'registry:publisher';

export interface OAuthM2MRegistryCredentialConfig extends OAuthM2MProviderConfig {
  readonly audience: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly issuer: string;
  readonly origin: string;
  readonly subject: string;
}

function credentialFailure(): Error {
  return new Error('OAuth registry credential unavailable.');
}

export function parseOAuthM2MRegistryCredentialConfig(
  environment: NodeJS.ProcessEnv,
): OAuthM2MRegistryCredentialConfig {
  return parseRegistryCredentialConfig(environment, 'worker');
}

export function parseOAuthM2MPublisherRegistryCredentialConfig(
  environment: NodeJS.ProcessEnv,
): OAuthM2MRegistryCredentialConfig {
  return parseRegistryCredentialConfig(environment, 'publisher');
}

function parseRegistryCredentialConfig(
  environment: NodeJS.ProcessEnv,
  role: 'worker' | 'publisher',
): OAuthM2MRegistryCredentialConfig {
  let provider: OAuthM2MProviderConfig;
  try {
    provider = parseOAuthM2MProviderConfig(environment, 'REGISTRY');
    environment = oauthCredentialEnvironment(environment);
  } catch {
    throw credentialFailure();
  }
  const audience = environment.THREADNOTE_OAUTH_REGISTRY_M2M_AUDIENCE;
  const clientId =
    role === 'publisher'
      ? environment.THREADNOTE_OAUTH_PUBLISHER_M2M_CLIENT_ID
      : environment.THREADNOTE_OAUTH_REGISTRY_M2M_CLIENT_ID;
  const clientSecret =
    role === 'publisher'
      ? environment.THREADNOTE_OAUTH_PUBLISHER_M2M_CLIENT_SECRET
      : environment.THREADNOTE_OAUTH_REGISTRY_M2M_CLIENT_SECRET;
  const issuer = environment.THREADNOTE_OAUTH_REGISTRY_M2M_ISSUER;
  const origin = environment.THREADNOTE_OAUTH_REGISTRY_M2M_ORIGIN;
  const subject =
    role === 'publisher'
      ? environment.THREADNOTE_OAUTH_PUBLISHER_M2M_SUBJECT
      : environment.THREADNOTE_OAUTH_REGISTRY_M2M_SUBJECT;
  const otherClientId =
    role === 'publisher'
      ? environment.THREADNOTE_OAUTH_REGISTRY_M2M_CLIENT_ID
      : environment.THREADNOTE_OAUTH_PUBLISHER_M2M_CLIENT_ID;
  const otherClientSecret =
    role === 'publisher'
      ? environment.THREADNOTE_OAUTH_REGISTRY_M2M_CLIENT_SECRET
      : environment.THREADNOTE_OAUTH_PUBLISHER_M2M_CLIENT_SECRET;
  const otherSubject =
    role === 'publisher'
      ? environment.THREADNOTE_OAUTH_REGISTRY_M2M_SUBJECT
      : environment.THREADNOTE_OAUTH_PUBLISHER_M2M_SUBJECT;
  if (
    !origin ||
    !canonicalOrigin(origin) ||
    audience !== origin ||
    !issuer ||
    !canonicalOAuthUrl(issuer) ||
    !clientId ||
    !CLIENT_ID.test(clientId) ||
    !clientSecret ||
    clientSecret.length > 4096 ||
    !subject ||
    !validSubject(subject) ||
    (otherClientId !== undefined && clientId === otherClientId) ||
    (otherClientSecret !== undefined && clientSecret === otherClientSecret) ||
    (otherSubject !== undefined && subject === otherSubject) ||
    (environment.THREADNOTE_OAUTH_GRAPH_M2M_AUDIENCE !== undefined &&
      audience === environment.THREADNOTE_OAUTH_GRAPH_M2M_AUDIENCE) ||
    (environment.THREADNOTE_OAUTH_GRAPH_M2M_CLIENT_ID !== undefined &&
      clientId === environment.THREADNOTE_OAUTH_GRAPH_M2M_CLIENT_ID) ||
    (environment.THREADNOTE_OAUTH_GRAPH_M2M_CLIENT_SECRET !== undefined &&
      clientSecret === environment.THREADNOTE_OAUTH_GRAPH_M2M_CLIENT_SECRET) ||
    (environment.THREADNOTE_OAUTH_GRAPH_M2M_SUBJECT !== undefined &&
      subject === environment.THREADNOTE_OAUTH_GRAPH_M2M_SUBJECT)
  )
    throw credentialFailure();
  return {...provider, audience, clientId, clientSecret, issuer, origin, subject};
}

/** Docker helper `get`: only an exact configured Zot host can receive this role's JWT. */
export async function getOAuthM2MRegistryCredential(
  rawServer: string,
  environment: NodeJS.ProcessEnv,
  dependencies?: Partial<OAuthM2MTokenDependencies>,
): Promise<{readonly Username: 'zot'; readonly Secret: string; readonly ServerURL: string}> {
  return getRegistryCredential(
    rawServer,
    parseOAuthM2MRegistryCredentialConfig(environment),
    WORKER_SCOPE,
    dependencies,
  );
}

export async function getOAuthM2MPublisherRegistryCredential(
  rawServer: string,
  environment: NodeJS.ProcessEnv,
  dependencies?: Partial<OAuthM2MTokenDependencies>,
): Promise<{readonly Username: 'zot'; readonly Secret: string; readonly ServerURL: string}> {
  return getRegistryCredential(
    rawServer,
    parseOAuthM2MPublisherRegistryCredentialConfig(environment),
    PUBLISHER_SCOPE,
    dependencies,
  );
}

async function getRegistryCredential(
  rawServer: string,
  config: OAuthM2MRegistryCredentialConfig,
  scope: typeof WORKER_SCOPE | typeof PUBLISHER_SCOPE,
  dependencies?: Partial<OAuthM2MTokenDependencies>,
): Promise<{readonly Username: 'zot'; readonly Secret: string; readonly ServerURL: string}> {
  if (!SERVER.test(rawServer) || `https://${rawServer}` !== config.origin) throw credentialFailure();
  try {
    const token = await requestVerifiedOAuthM2MToken({...config, scope}, dependencies);
    // The Threadnote Docker credential loader bounds Secret at 8 KiB.
    if (token.accessToken.length > 8192) throw credentialFailure();
    return {Username: 'zot', Secret: token.accessToken, ServerURL: config.origin};
  } catch {
    throw credentialFailure();
  }
}

function canonicalOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.origin === value &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname === '/' &&
      value.length <= 512
    );
  } catch {
    return false;
  }
}

function validSubject(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    EffectArray.every(
      [...value],
      character =>
        Effect.pipe(
          character,
          EffectString.charCodeAt(0),
          Effect.Option.getOrElse(() => NaN),
        ) > 32 &&
        Effect.pipe(
          character,
          EffectString.charCodeAt(0),
          Effect.Option.getOrElse(() => NaN),
        ) !== 127,
    )
  );
}

export async function runOAuthM2MRegistryCredentialHelper(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: OAuthM2MHelperIO,
): Promise<number> {
  return runRegistryCredentialHelper(arguments_, environment, io, getOAuthM2MRegistryCredential);
}

export async function runOAuthM2MPublisherRegistryCredentialHelper(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: OAuthM2MHelperIO,
): Promise<number> {
  return runRegistryCredentialHelper(arguments_, environment, io, getOAuthM2MPublisherRegistryCredential);
}

async function runRegistryCredentialHelper(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: OAuthM2MHelperIO,
  getCredential: typeof getOAuthM2MRegistryCredential,
): Promise<number> {
  try {
    if (arguments_.length !== 1 || arguments_[0] !== 'get') throw credentialFailure();
    let length = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of io.stdin) {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
      length += bytes.length;
      if (length > MAX_INPUT_BYTES) throw credentialFailure();
      chunks.push(bytes);
    }
    const input = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      input.set(chunk, offset);
      offset += chunk.length;
    }
    const value = new TextDecoder('utf-8', {fatal: true}).decode(input);
    if (
      !Effect.pipe(value, EffectString.endsWith('\n')) ||
      Effect.pipe(
        value,
        EffectString.indexOf('\n'),
        Effect.Option.getOrElse(() => -1),
      ) !==
        value.length - 1
    )
      throw credentialFailure();
    io.writeStdout(
      `${JSON.stringify(await getCredential(Effect.pipe(value, EffectString.slice(0, -1)), environment))}\n`,
    );
    return 0;
  } catch {
    io.writeStderr('OAuth registry credential unavailable.\n');
    return 1;
  }
}
