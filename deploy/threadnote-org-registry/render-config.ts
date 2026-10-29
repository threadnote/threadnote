import * as Effect from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {readFileSync} from 'node:fs';

type Environment = Readonly<Record<string, string | undefined>>;

const REPOSITORY = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/u;

function hasControlCharacter(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- Reject literal C0 and DEL control characters from configured registry values.
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function required(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function httpsUrl(value: string, name: string, allowPath: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS URL`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (!allowPath && url.pathname !== '/') ||
    value !== (allowPath ? url.href : url.origin)
  )
    throw new Error(`${name} must be a canonical HTTPS URL`);
  return url;
}

function subjects(env: Environment, name: string, requiredArray: boolean): string[] {
  let value: unknown;
  try {
    value = JSON.parse(requiredArray ? required(env, name) : (env[name] ?? '[]'));
  } catch {
    throw new Error(`${name} must be a JSON array`);
  }
  if (
    !Array.isArray(value) ||
    (requiredArray && value.length === 0) ||
    value.length > 8 ||
    value.some(
      item => typeof item !== 'string' || item.length === 0 || item.length > 256 || hasControlCharacter(item),
    ) ||
    new Set(value).size !== value.length
  )
    throw new Error(`${name} must contain distinct nonempty subjects`);
  return value;
}

function roleScopeValidation(publisher: string, workers: readonly string[], readers: readonly string[]) {
  const hasScope = (scope: string) => `(' ' + claims.scope + ' ').contains(' ${scope} ')`;
  const roles = [
    `(claims.sub == ${JSON.stringify(publisher)} && ${hasScope('registry:publisher')})`,
    `(claims.sub in ${JSON.stringify(workers)} && ${hasScope('registry:worker')})`,
    `(claims.sub in ${JSON.stringify(readers)} && ${hasScope('registry:read')})`,
  ];
  return {
    expression: `'scope' in claims && type(claims.scope) == string && (${roles.join(' || ')})`,
    message: 'Registry role scope is required.',
  };
}

export function buildZotConfig(env: Environment) {
  const origin = httpsUrl(required(env, 'ZOT_PUBLIC_ORIGIN'), 'ZOT_PUBLIC_ORIGIN', false).origin;
  const issuer = httpsUrl(required(env, 'ZOT_OIDC_ISSUER'), 'ZOT_OIDC_ISSUER', true).href;
  const audience = required(env, 'ZOT_OIDC_AUDIENCE');
  if (audience !== origin) throw new Error('ZOT_OIDC_AUDIENCE must equal ZOT_PUBLIC_ORIGIN');
  const canonical = required(env, 'ZOT_CANONICAL_REPOSITORY');
  const worker = required(env, 'ZOT_WORKER_REPOSITORY');
  if (!REPOSITORY.test(canonical) || !REPOSITORY.test(worker) || canonical === worker)
    throw new Error('Canonical and worker repositories must be distinct OCI repository paths');
  const publisher = required(env, 'ZOT_PUBLISHER_SUBJECT');
  if (publisher.length > 256 || hasControlCharacter(publisher)) throw new Error('ZOT_PUBLISHER_SUBJECT is invalid');
  const workers = subjects(env, 'ZOT_WORKER_SUBJECTS_JSON', true);
  const readers = subjects(env, 'ZOT_READER_SUBJECTS_JSON', false);
  if (new Set([publisher, ...workers, ...readers]).size !== 1 + workers.length + readers.length)
    throw new Error('Publisher, worker, and reader subjects must be disjoint');

  const readOnly = [...workers, ...readers];
  return {
    distSpecVersion: '1.1.0',
    storage: {rootDirectory: '/data/registry', commit: true, gc: false},
    http: {
      address: '0.0.0.0',
      port: '5000',
      auth: {
        bearer: {
          realm: `${origin}/zot/auth/token`,
          service: 'threadnote-org-registry-e2e',
          oidc: [
            {
              issuer,
              audiences: [audience],
              claimMapping: {
                username: 'claims.sub',
                validations: [roleScopeValidation(publisher, workers, readers)],
              },
            },
          ],
        },
      },
      accessControl: {
        repositories: {
          '**': {defaultPolicy: [], anonymousPolicy: []},
          [canonical]: {
            policies: [
              {users: [publisher], actions: ['read', 'create', 'update']},
              {users: readOnly, actions: ['read']},
            ],
          },
          [worker]: {
            policies: [
              {users: workers, actions: ['read', 'create', 'update']},
              {users: [publisher, ...readers], actions: ['read']},
            ],
          },
        },
      },
    },
  };
}

export function assertProfileMatches(config: ReturnType<typeof buildZotConfig>, profile: unknown): void {
  const registry = (profile as {registry?: {canonical?: unknown; worker?: unknown}} | null)?.registry;
  const origin = Effect.pipe(config.http.auth.bearer.realm, EffectString.slice(0, -'/zot/auth/token'.length));
  const [canonical, worker] = EffectRecord.keys(config.http.accessControl.repositories).filter(key => key !== '**');
  if (
    registry?.canonical !== `oci://${Effect.pipe(origin, EffectString.slice('https://'.length))}/${canonical}` ||
    registry?.worker !== `oci://${Effect.pipe(origin, EffectString.slice('https://'.length))}/${worker}`
  )
    throw new Error('Profile registry references do not match the Zot deployment');
}

if (import.meta.main) {
  try {
    const config = buildZotConfig(process.env);
    if (process.argv[2] === '--preflight' && process.argv.length === 4) {
      assertProfileMatches(config, JSON.parse(readFileSync(process.argv[3], 'utf8')));
      process.stdout.write('Zot configuration and profile references match.\n');
    } else if (process.argv.length === 2) {
      process.stdout.write(`${JSON.stringify(config)}\n`);
    } else {
      throw new Error('Usage: render-config.ts [--preflight profile.json]');
    }
  } catch (error) {
    process.stderr.write(`Zot configuration invalid: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
