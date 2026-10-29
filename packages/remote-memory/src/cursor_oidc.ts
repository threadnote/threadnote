import {Array as EffectArray} from 'effect';
import {createRemoteJWKSet, jwtVerify, type JWTPayload} from 'jose';
import type {AuthorizedRemotePrincipal} from './authorization.js';
import {remoteMemoryError} from './errors.js';
import {randomUuidV4} from '@threadnote/platform/uuid';
import type {RemoteMemoryRequestExecution} from './request_execution.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const CHALLENGE_LIFETIME_MILLISECONDS = 2 * 60_000;
const MAX_CURSOR_TOKEN_BYTES = 16 * 1024;
const MAX_CHALLENGE_ATTEMPTS = 8;
const OPAQUE_CURSOR_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CURSOR_OWNER_SUBJECT = /^(?:service_account|user):[0-9]{1,128}$/u;
const CURSOR_REPOSITORY_IDENTITY = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?:\/[A-Za-z0-9._~-]+)+$/u;

export interface CursorAttestationChallenge {
  readonly audience: string;
  readonly challengeId: string;
  readonly completionUrl: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly principalId: string;
  readonly shareId: string;
  readonly tenantId: string;
}

export interface CursorWorkloadClaims {
  readonly cloudAgentId: string;
  readonly expiresAt: string;
  readonly issuer: string;
  readonly jti: string;
  /** Present only while completing a challenge; it is not persisted with attestations. */
  readonly nonce?: string;
  readonly ownerId?: string;
  readonly repositoryUrls?: readonly string[];
  readonly subject: string;
  readonly teamId?: string;
  readonly turnId?: string;
}

export interface CursorWorkloadAttestation extends CursorWorkloadClaims {
  readonly attestationId: string;
  readonly principalId: string;
  readonly shareId: string;
  readonly tenantId: string;
}

export interface CursorAttestationStore {
  readonly consumeChallenge: (
    challengeId: string,
    expected: {
      readonly nonce: string;
      readonly principalId: string;
      readonly shareId: string;
      readonly tenantId: string;
    },
    claims: CursorWorkloadClaims,
    execution?: RemoteMemoryRequestExecution,
  ) => Promise<CursorWorkloadAttestation | undefined>;
  readonly createChallenge: (
    challenge: CursorAttestationChallenge,
    execution?: RemoteMemoryRequestExecution,
  ) => Promise<void>;
  readonly claimChallengeAttempt: (
    challengeId: string,
    execution?: RemoteMemoryRequestExecution,
  ) => Promise<CursorAttestationChallenge | undefined>;
  readonly getValidAttestation: (
    attestationId: string,
    principal: AuthorizedRemotePrincipal,
    execution?: RemoteMemoryRequestExecution,
  ) => Promise<CursorWorkloadAttestation | undefined>;
}

export interface CursorTokenVerifier {
  readonly verify: (token: string, nonce: string) => Promise<CursorWorkloadClaims>;
}

export interface CursorTokenVerifierConfig {
  readonly audience: string;
  readonly issuer: string;
  readonly jwksUrl: URL;
}

export async function beginCursorAttestation(
  store: CursorAttestationStore,
  principal: AuthorizedRemotePrincipal,
  options: {readonly audience: string; readonly completionUrl: string; readonly now?: Date},
  execution?: RemoteMemoryRequestExecution,
): Promise<Omit<CursorAttestationChallenge, 'principalId' | 'shareId' | 'tenantId'>> {
  const now = options.now ?? new Date();
  const challenge: CursorAttestationChallenge = {
    audience: options.audience,
    challengeId: randomUuidV4(),
    completionUrl: options.completionUrl,
    expiresAt: new Date(now.getTime() + CHALLENGE_LIFETIME_MILLISECONDS).toISOString(),
    nonce: randomNonce(),
    principalId: principal.principalId,
    shareId: principal.shareId,
    tenantId: principal.tenantId,
  };
  await store.createChallenge(challenge, execution);
  return {
    audience: challenge.audience,
    challengeId: challenge.challengeId,
    completionUrl: challenge.completionUrl,
    expiresAt: challenge.expiresAt,
    nonce: challenge.nonce,
  };
}

export async function completeCursorAttestation(
  store: CursorAttestationStore,
  verifier: CursorTokenVerifier,
  principal: AuthorizedRemotePrincipal,
  input: {readonly challengeId: string; readonly token: string},
  now = new Date(),
  execution?: RemoteMemoryRequestExecution,
): Promise<CursorWorkloadAttestation> {
  if (Buffer.byteLength(input.token, 'utf8') > MAX_CURSOR_TOKEN_BYTES) {
    throw remoteMemoryError('invalid_request', 'The Cursor workload token is too large.');
  }
  const challenge = await store.claimChallengeAttempt(input.challengeId, execution);
  if (
    !challenge ||
    challenge.principalId !== principal.principalId ||
    challenge.shareId !== principal.shareId ||
    challenge.tenantId !== principal.tenantId ||
    Date.parse(challenge.expiresAt) <= now.getTime()
  ) {
    throw remoteMemoryError('forbidden', 'The Cursor attestation challenge is invalid or expired.');
  }
  const claims = await verifier.verify(input.token, challenge.nonce);
  authorizeCursorClaims(principal, claims);
  const attestation = await store.consumeChallenge(
    challenge.challengeId,
    {
      nonce: challenge.nonce,
      principalId: principal.principalId,
      shareId: principal.shareId,
      tenantId: principal.tenantId,
    },
    claims,
    execution,
  );
  if (!attestation) throw remoteMemoryError('conflict', 'The Cursor attestation challenge was already consumed.');
  return attestation;
}

export async function requireCursorAttestation(
  store: CursorAttestationStore,
  principal: AuthorizedRemotePrincipal,
  attestationId: string | undefined,
  project?: string,
  execution?: RemoteMemoryRequestExecution,
): Promise<CursorWorkloadAttestation | undefined> {
  if (!principal.attestationRequiredForWrites && !attestationId) return undefined;
  if (!attestationId)
    throw remoteMemoryError('attestation_required', 'A fresh Cursor workload attestation is required.');
  const attestation = await store.getValidAttestation(attestationId, principal, execution);
  if (!attestation)
    throw remoteMemoryError('attestation_required', 'The Cursor workload attestation is invalid or expired.');
  authorizeCursorClaims(principal, attestation, project);
  return attestation;
}

export function createCursorTokenVerifier(config: CursorTokenVerifierConfig): CursorTokenVerifier {
  const jwks = createRemoteJWKSet(config.jwksUrl, {cacheMaxAge: 5 * 60_000, timeoutDuration: 3000});
  return {
    verify: async (token, nonce) => {
      let payload: JWTPayload;
      try {
        ({payload} = await jwtVerify(token, jwks, {
          algorithms: ['RS256'],
          audience: config.audience,
          clockTolerance: 5,
          issuer: config.issuer,
          maxTokenAge: '5 minutes',
          requiredClaims: ['sub', 'iat', 'nbf', 'exp', 'jti', 'cloud_agent_id', 'nonce', 'agent_runtime'],
        }));
      } catch {
        throw remoteMemoryError('forbidden', 'The Cursor workload token could not be verified.');
      }
      return parseCursorClaims(payload, nonce);
    },
  };
}

export function authorizeCursorClaims(
  principal: AuthorizedRemotePrincipal,
  claims: CursorWorkloadClaims,
  project?: string,
): void {
  if (principal.cursorSubjects.size === 0 || !principal.cursorSubjects.has(claims.subject)) {
    throw remoteMemoryError('forbidden', 'The Cursor workload subject does not match the member policy.');
  }
  if (principal.cursorTeamId && claims.teamId !== principal.cursorTeamId) {
    throw remoteMemoryError('forbidden', 'The Cursor workload team does not match the share policy.');
  }
  if (principal.cursorOwnerIds.size > 0 && (!claims.ownerId || !principal.cursorOwnerIds.has(claims.ownerId))) {
    throw remoteMemoryError('forbidden', 'The Cursor workload owner does not match the member policy.');
  }
  const repositoryClaims = EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(claims.repositoryUrls), __effectArrayReceiver2 =>
      EffectArray.map(__effectArrayReceiver2, canonicalRepositoryClaim),
    ),
  );
  if (principal.repositoryBindings.size > 0) {
    if (!repositoryClaims || repositoryClaims.length === 0) {
      throw remoteMemoryError('forbidden', 'Complete Cursor repository claims are required by the share policy.');
    }
    const allowedRepositories = new Set(
      EffectArray.map([...principal.repositoryBindings], canonicalCursorRepositoryBinding),
    );
    if (EffectArray.some(repositoryClaims, repository => !allowedRepositories.has(repository))) {
      throw remoteMemoryError('forbidden', 'The Cursor workload includes a repository outside the share policy.');
    }
  }
  if (project) {
    const projectRepositories = principal.repositoriesByProject.get(project);
    if (!projectRepositories || projectRepositories.size === 0) {
      throw remoteMemoryError('forbidden', 'The project has no repository binding for managed-cloud writes.');
    }
    const allowedForProject = new Set(EffectArray.map([...projectRepositories], canonicalCursorRepositoryBinding));
    if (
      !EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(repositoryClaims), __effectArrayReceiver =>
          EffectArray.some(
            __effectArrayReceiver,
            __effectArrayValue => !!(repository => allowedForProject.has(repository))(__effectArrayValue),
          ),
        ),
      )
    ) {
      throw remoteMemoryError('forbidden', 'The Cursor workload does not include a repository bound to the project.');
    }
  }
}

function parseCursorClaims(payload: JWTPayload, expectedNonce: string): CursorWorkloadClaims {
  const issuedAt = numericDateClaim(payload, 'iat');
  const notBefore = numericDateClaim(payload, 'nbf');
  const expiresAt = numericDateClaim(payload, 'exp');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 305 || notBefore < issuedAt - 10 || notBefore > issuedAt + 5) {
    throw remoteMemoryError('forbidden', 'The Cursor workload token lifetime is invalid.');
  }
  const cloudAgentId = opaqueIdentifierClaim(payload, 'cloud_agent_id', true);
  const jti = opaqueIdentifierClaim(payload, 'jti', true);
  const nonce = stringClaim(payload, 'nonce', true);
  if (nonce !== expectedNonce) throw remoteMemoryError('forbidden', 'The Cursor workload nonce does not match.');
  if (stringClaim(payload, 'agent_runtime', true) !== 'managed') {
    throw remoteMemoryError('forbidden', 'The Cursor workload is not running in a managed Cloud Agent VM.');
  }
  const rawRepositoryUrls = stringArrayClaim(payload, 'repo_urls');
  const repositoryUrls = EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(rawRepositoryUrls), __effectArrayReceiver2 =>
      EffectArray.map(__effectArrayReceiver2, canonicalRepositoryClaim),
    ),
  );
  if (repositoryUrls) {
    const count = payload.repo_count;
    if (
      !Number.isSafeInteger(count) ||
      count !== repositoryUrls.length ||
      new Set(rawRepositoryUrls).size !== count ||
      new Set(repositoryUrls).size !== count
    ) {
      throw remoteMemoryError('forbidden', 'The Cursor repository claim set is inconsistent.');
    }
  } else if (payload.repo_count !== undefined) {
    throw remoteMemoryError('forbidden', 'The Cursor repository count is present without a complete repository set.');
  }
  const primaryRepository = stringClaim(payload, 'repo_url', false);
  const canonicalPrimaryRepository = primaryRepository ? canonicalRepositoryClaim(primaryRepository) : undefined;
  if (canonicalPrimaryRepository && (!repositoryUrls || !repositoryUrls.includes(canonicalPrimaryRepository))) {
    throw remoteMemoryError('forbidden', 'The Cursor primary repository is absent from the complete repository set.');
  }
  const userId = decimalIdentifierClaim(payload, 'owner_user_id');
  const serviceAccountId = decimalIdentifierClaim(payload, 'owner_service_account_id');
  if (userId && serviceAccountId) {
    throw remoteMemoryError('forbidden', 'The Cursor workload token has ambiguous owner claims.');
  }
  return {
    cloudAgentId: cloudAgentId!,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    issuer: payload.iss!,
    jti: jti!,
    nonce,
    ownerId: userId ?? serviceAccountId,
    repositoryUrls,
    subject: cursorOwnerSubject(payload.sub),
    teamId: decimalIdentifierClaim(payload, 'team_id'),
    turnId: opaqueIdentifierClaim(payload, 'turn_id', false),
  };
}

function numericDateClaim(payload: JWTPayload, name: 'exp' | 'iat' | 'nbf'): number {
  const value = payload[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw remoteMemoryError('forbidden', `The Cursor workload ${name} claim is invalid.`);
  }
  return value;
}

export function cursorAttestationMaximumAttempts(): number {
  return MAX_CHALLENGE_ATTEMPTS;
}

function stringClaim(payload: JWTPayload, name: string, required: boolean): string | undefined {
  const value = payload[name];
  if (typeof value === 'string' && value.length > 0 && value.length <= 512) return value;
  if (!required && value === undefined) return undefined;
  throw remoteMemoryError('forbidden', `The Cursor workload ${name} claim is invalid.`);
}

function opaqueIdentifierClaim(payload: JWTPayload, name: string, required: boolean): string | undefined {
  const value = payload[name];
  if (typeof value === 'string' && OPAQUE_CURSOR_IDENTIFIER.test(value)) return value;
  if (!required && value === undefined) return undefined;
  throw remoteMemoryError('forbidden', `The Cursor workload ${name} claim is invalid.`);
}

function stringArrayClaim(payload: JWTPayload, name: string): readonly string[] | undefined {
  const value = payload[name];
  if (value === undefined) return undefined;
  if (
    !EffectArray.isArray(value) ||
    value.length > 32 ||
    !EffectArray.every(
      value,
      (item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 2048,
    )
  ) {
    throw remoteMemoryError('forbidden', `The Cursor workload ${name} claim is invalid.`);
  }
  return value;
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('base64url');
}

function canonicalRepositoryClaim(value: string): string {
  if (
    !CURSOR_REPOSITORY_IDENTITY.test(value) ||
    Effect.pipe(value, EffectString.endsWith('.git')) ||
    Effect.pipe(value, EffectString.includes('//'))
  ) {
    throw remoteMemoryError('forbidden', 'The Cursor workload repository identity is invalid.');
  }
  const slash = Effect.pipe(
    value,
    EffectString.indexOf('/'),
    Effect.Option.getOrElse(() => -1),
  );
  const hostname = Effect.pipe(value, EffectString.slice(0, slash));
  if (hostname !== Effect.pipe(hostname, EffectString.toLowerCase) || !validRepositoryHostname(hostname)) {
    throw remoteMemoryError('forbidden', 'The Cursor workload repository identity is invalid.');
  }
  return value;
}

export function canonicalCursorRepositoryBinding(value: string): string {
  if (!Effect.pipe(value, EffectString.includes('://'))) return canonicalRepositoryClaim(value);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw remoteMemoryError('forbidden', 'The Cursor workload repository URL is invalid.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.port && parsed.port !== '443')
  ) {
    throw remoteMemoryError('forbidden', 'The Cursor workload repository URL is invalid.');
  }
  const pathname = Effect.pipe(parsed.pathname, EffectString.replace(/\/+$/u, ''), EffectString.replace(/\.git$/u, ''));
  return canonicalRepositoryClaim(`${Effect.pipe(parsed.hostname, EffectString.toLowerCase)}${pathname}`);
}

function cursorOwnerSubject(value: string | undefined): string {
  if (!value || !CURSOR_OWNER_SUBJECT.test(value)) {
    throw remoteMemoryError('forbidden', 'The Cursor workload subject is invalid.');
  }
  return value;
}

function decimalIdentifierClaim(payload: JWTPayload, name: string): string | undefined {
  const value = stringClaim(payload, name, false);
  if (value !== undefined && !/^[0-9]{1,128}$/u.test(value)) {
    throw remoteMemoryError('forbidden', `The Cursor workload ${name} claim is invalid.`);
  }
  return value;
}

function validRepositoryHostname(value: string): boolean {
  return EffectArray.every(Effect.pipe(value, EffectString.split('.')), label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
  );
}
