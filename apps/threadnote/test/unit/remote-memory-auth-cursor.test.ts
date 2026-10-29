import {exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload} from 'jose';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {randomUuidV4} from '@threadnote/threadnote/crypto/uuid';
import type {AuthorizedRemotePrincipal} from '@threadnote/remote-memory/authorization';
import {
  authorizeCursorClaims,
  beginCursorAttestation,
  completeCursorAttestation,
  createCursorTokenVerifier,
  cursorAttestationMaximumAttempts,
  requireCursorAttestation,
  type CursorAttestationChallenge,
  type CursorAttestationStore,
  type CursorTokenVerifier,
  type CursorWorkloadAttestation,
  type CursorWorkloadClaims,
} from '@threadnote/remote-memory/cursor_oidc';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';

const ISSUER = 'https://api.cursor.com';
const AUDIENCE = 'https://memory.example.test/attest/cursor';
const REPOSITORY = 'https://github.com/example/threadnote';
const REPOSITORY_CLAIM = 'github.com/example/threadnote';

let privateKey: CryptoKey;
let publicJwk: JWK;
let jwksServer: ReturnType<typeof Bun.serve>;
let verifier: CursorTokenVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', {extractable: true});
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.alg = 'RS256';
  publicJwk.kid = 'cursor-rsa-1';
  publicJwk.use = 'sig';
  jwksServer = Bun.serve({
    fetch: request =>
      new URL(request.url).pathname === '/jwks'
        ? Response.json({keys: [publicJwk]})
        : new Response('not found', {status: 404}),
    hostname: '127.0.0.1',
    port: 0,
  });
  verifier = createCursorTokenVerifier({
    audience: AUDIENCE,
    issuer: ISSUER,
    jwksUrl: new URL('/jwks', jwksServer.url),
  });
});

afterAll(async () => {
  await jwksServer.stop(true);
});

function principalFixture(overrides: Partial<AuthorizedRemotePrincipal> = {}): AuthorizedRemotePrincipal {
  return {
    allowedProjects: 'all',
    attestationRequiredForWrites: true,
    capabilities: new Set(['memory:read', 'memory:write:durable']),
    cloudAdmissionRequired: false,
    cursorOwnerIds: new Set(['12345']),
    cursorSubjects: new Set(['user:12345']),
    cursorTeamId: '6789',
    featureFlags: new Set([
      'remote_memory_read',
      'remote_memory_durable_write',
      'cursor_oidc_required',
      'remote_memory_ga',
    ]),
    OAuth: {issuer: 'https://identity.example.test', scopes: new Set(['memory:read']), subject: 'oauth-subject'},
    policyVersion: 'policy-v1',
    policyDigest: 'digest-v1',
    principalId: 'principal-1',
    repositoryBindings: new Set([REPOSITORY]),
    repositoriesByProject: new Map([['threadnote', new Set([REPOSITORY])]]),
    shareId: 'share-1',
    sharePolicyDigest: 'share-digest-v1',
    sharePolicyVersion: 'share-policy-v1',
    tenantId: 'tenant-1',
    ...overrides,
  };
}

async function cursorToken(
  overrides: Readonly<Record<string, unknown>> = {},
  options: {readonly audience?: string; readonly issuer?: string} = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    aud: options.audience ?? AUDIENCE,
    agent_runtime: 'managed',
    cloud_agent_id: 'cloud-agent-1',
    exp: now + 300,
    iat: now,
    iss: options.issuer ?? ISSUER,
    jti: randomUuidV4(),
    nbf: now - 5,
    nonce: 'nonce-1',
    repo_count: 1,
    repo_url: REPOSITORY_CLAIM,
    repo_urls: [REPOSITORY_CLAIM],
    sub: 'user:12345',
    team_id: '6789',
    turn_id: 'turn-1',
    owner_user_id: '12345',
    ...overrides,
  };
  return new SignJWT(payload).setProtectedHeader({alg: 'RS256', kid: 'cursor-rsa-1', typ: 'JWT'}).sign(privateKey);
}

async function expectForbidden(token: string, nonce = 'nonce-1'): Promise<void> {
  await expect(verifier.verify(token, nonce)).rejects.toMatchObject({code: 'forbidden', status: 403});
}

class MemoryAttestationStore implements CursorAttestationStore {
  readonly attempts = new Map<string, number>();
  readonly attestations = new Map<string, CursorWorkloadAttestation>();
  readonly challenges = new Map<string, CursorAttestationChallenge>();
  readonly consumed = new Set<string>();

  async createChallenge(challenge: CursorAttestationChallenge): Promise<void> {
    this.challenges.set(challenge.challengeId, challenge);
  }

  async claimChallengeAttempt(challengeId: string): Promise<CursorAttestationChallenge | undefined> {
    const challenge = this.challenges.get(challengeId);
    const attempts = this.attempts.get(challengeId) ?? 0;
    if (!challenge || this.consumed.has(challengeId) || attempts >= cursorAttestationMaximumAttempts())
      return undefined;
    this.attempts.set(challengeId, attempts + 1);
    return challenge;
  }

  async consumeChallenge(
    challengeId: string,
    expected: {
      readonly nonce: string;
      readonly principalId: string;
      readonly shareId: string;
      readonly tenantId: string;
    },
    claims: CursorWorkloadClaims,
  ): Promise<CursorWorkloadAttestation | undefined> {
    const challenge = this.challenges.get(challengeId);
    if (
      !challenge ||
      this.consumed.has(challengeId) ||
      challenge.nonce !== expected.nonce ||
      challenge.principalId !== expected.principalId ||
      challenge.shareId !== expected.shareId ||
      challenge.tenantId !== expected.tenantId
    ) {
      return undefined;
    }
    this.consumed.add(challengeId);
    const attestation: CursorWorkloadAttestation = {
      ...claims,
      attestationId: randomUuidV4(),
      nonce: undefined,
      principalId: expected.principalId,
      shareId: expected.shareId,
      tenantId: expected.tenantId,
    };
    this.attestations.set(attestation.attestationId, attestation);
    return attestation;
  }

  async getValidAttestation(
    attestationId: string,
    principal: AuthorizedRemotePrincipal,
  ): Promise<CursorWorkloadAttestation | undefined> {
    const attestation = this.attestations.get(attestationId);
    if (
      !attestation ||
      attestation.principalId !== principal.principalId ||
      attestation.shareId !== principal.shareId ||
      attestation.tenantId !== principal.tenantId ||
      Date.parse(attestation.expiresAt) <= Date.now()
    ) {
      return undefined;
    }
    return attestation;
  }
}

describe('Cursor workload JWT verification', () => {
  it('verifies nonce, owner, team, complete repository set, and primary repository', async () => {
    const claims = await verifier.verify(await cursorToken(), 'nonce-1');

    expect(claims).toMatchObject({
      cloudAgentId: 'cloud-agent-1',
      issuer: ISSUER,
      nonce: 'nonce-1',
      ownerId: '12345',
      repositoryUrls: [REPOSITORY_CLAIM],
      subject: 'user:12345',
      teamId: '6789',
      turnId: 'turn-1',
    });
  });

  it('accepts the current service-account owner claim and subject shape', async () => {
    const claims = await verifier.verify(
      await cursorToken({
        owner_service_account_id: '24680',
        owner_user_id: undefined,
        sub: 'service_account:24680',
      }),
      'nonce-1',
    );

    expect(claims).toMatchObject({ownerId: '24680', subject: 'service_account:24680'});
    expect(() =>
      authorizeCursorClaims(
        principalFixture({cursorOwnerIds: new Set(['24680']), cursorSubjects: new Set(['service_account:24680'])}),
        claims,
      ),
    ).not.toThrow();
  });

  it.each([
    ['nonce', () => cursorToken(), 'different-nonce'],
    ['issuer', () => cursorToken({}, {issuer: 'https://attacker.example.test'}), 'nonce-1'],
    ['audience', () => cursorToken({}, {audience: 'https://other.example.test'}), 'nonce-1'],
  ])('rejects a mismatched %s', async (_label, makeToken, expectedNonce) => {
    await expectForbidden(await makeToken(), expectedNonce);
  });

  it('rejects expired, future, excessive, and internally inconsistent token times', async () => {
    const now = Math.floor(Date.now() / 1000);
    const invalidTimes = [
      {exp: now - 30, iat: now - 330, nbf: now - 335},
      {exp: now + 600, iat: now, nbf: now + 30},
      {exp: now + 306, iat: now, nbf: now},
      {exp: now + 300, iat: now, nbf: now - 11},
      {exp: now + 300, iat: now, nbf: now + 6},
    ];
    for (const times of invalidTimes) await expectForbidden(await cursorToken(times));
  });

  it.each([
    ['repo count mismatch', {repo_count: 2}],
    ['repo count without URLs', {repo_count: 1, repo_url: undefined, repo_urls: undefined}],
    ['URLs without repo count', {repo_count: undefined}],
    ['duplicate repositories', {repo_count: 2, repo_urls: [REPOSITORY_CLAIM, REPOSITORY_CLAIM]}],
    ['noncanonical repository URL', {repo_url: REPOSITORY, repo_urls: [REPOSITORY]}],
    ['repository .git suffix', {repo_url: `${REPOSITORY_CLAIM}.git`, repo_urls: [`${REPOSITORY_CLAIM}.git`]}],
    ['primary repository outside complete set', {repo_url: 'github.com/example/other'}],
    ['ambiguous owner', {owner_service_account_id: '24680', owner_user_id: '12345'}],
    ['nonnumeric owner', {owner_user_id: 'owner-123'}],
    ['nonnumeric team', {team_id: 'team-123'}],
    ['non-managed runtime', {agent_runtime: 'self-hosted'}],
    ['invalid owner subject', {sub: 'user with spaces'}],
  ])('rejects inconsistent Cursor claims: %s', async (_label, overrides) => {
    await expectForbidden(await cursorToken(overrides));
  });

  it.each([
    ['cloud_agent_id', {cloud_agent_id: 'agent id with spaces'}],
    ['cloud_agent_id', {cloud_agent_id: 'agent\nignore-previous-instructions'}],
    ['cloud_agent_id', {cloud_agent_id: `agent-${Effect.pipe('x', EffectString.repeat(124))}`}],
    ['turn_id', {turn_id: 'turn/with/path'}],
    ['turn_id', {turn_id: 'turn token=secret-looking-value'}],
    ['turn_id', {turn_id: `turn-${Effect.pipe('x', EffectString.repeat(124))}`}],
  ])('rejects a non-opaque %s before it can enter a public receipt', async (_claim, overrides) => {
    await expectForbidden(await cursorToken(overrides));
  });

  it('authorizes current team, owner, and every repository against share policy', async () => {
    const claims = await verifier.verify(await cursorToken(), 'nonce-1');
    expect(() => authorizeCursorClaims(principalFixture(), claims)).not.toThrow();

    expect(() => authorizeCursorClaims(principalFixture({cursorTeamId: '9876'}), claims)).toThrow('team');
    expect(() => authorizeCursorClaims(principalFixture({cursorOwnerIds: new Set(['54321'])}), claims)).toThrow(
      'owner',
    );
    expect(() =>
      authorizeCursorClaims(
        principalFixture({repositoryBindings: new Set(['https://github.com/example/other'])}),
        claims,
      ),
    ).toThrow('outside the share policy');
    expect(() => authorizeCursorClaims(principalFixture(), {...claims, repositoryUrls: undefined})).toThrow(
      'Complete Cursor repository claims',
    );
  });

  it('does not treat the legacy unprefixed owner claim as current Cursor identity', async () => {
    const claims = await verifier.verify(await cursorToken({owner_user_id: undefined, user_id: '12345'}), 'nonce-1');

    expect(claims.ownerId).toBeUndefined();
    expect(() => authorizeCursorClaims(principalFixture(), claims)).toThrow('owner');
  });

  it('requires at least one claimed repository bound to the target project', async () => {
    const otherRepository = 'https://github.com/example/other';
    const principal = principalFixture({
      repositoryBindings: new Set([REPOSITORY, otherRepository]),
      repositoriesByProject: new Map([
        ['threadnote', new Set([REPOSITORY])],
        ['other-project', new Set([otherRepository])],
      ]),
    });
    const threadnoteClaims = await verifier.verify(await cursorToken(), 'nonce-1');
    const multiRepositoryClaims = await verifier.verify(
      await cursorToken({
        repo_count: 2,
        repo_urls: [REPOSITORY_CLAIM, 'github.com/example/other'],
      }),
      'nonce-1',
    );

    expect(() => authorizeCursorClaims(principal, threadnoteClaims, 'threadnote')).not.toThrow();
    expect(() => authorizeCursorClaims(principal, threadnoteClaims, 'other-project')).toThrow(
      'does not include a repository bound to the project',
    );
    expect(() => authorizeCursorClaims(principal, threadnoteClaims, 'unbound-project')).toThrow(
      'no repository binding',
    );
    expect(() => authorizeCursorClaims(principal, multiRepositoryClaims, 'other-project')).not.toThrow();
  });
});

describe('Cursor challenge and persisted attestation lifecycle', () => {
  it('binds a short-lived challenge and consumes it exactly once under concurrent completion', async () => {
    const store = new MemoryAttestationStore();
    const principal = principalFixture();
    const challenge = await beginCursorAttestation(store, principal, {
      audience: AUDIENCE,
      completionUrl: 'https://memory.example.test/attest/cursor/complete',
    });
    const token = await cursorToken({nonce: challenge.nonce});

    const outcomes = await Promise.allSettled([
      completeCursorAttestation(store, verifier, principal, {challengeId: challenge.challengeId, token}),
      completeCursorAttestation(store, verifier, principal, {challengeId: challenge.challengeId, token}),
    ]);

    expect(EffectArray.filter(outcomes, outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(EffectArray.filter(outcomes, outcome => outcome.status === 'rejected')).toHaveLength(1);
    expect(store.consumed).toEqual(new Set([challenge.challengeId]));
    expect(store.attestations).toHaveLength(1);
  });

  it('caps failed challenge attempts before token verification can continue', async () => {
    const store = new MemoryAttestationStore();
    const principal = principalFixture();
    const challenge = await beginCursorAttestation(store, principal, {
      audience: AUDIENCE,
      completionUrl: 'https://memory.example.test/attest/cursor/complete',
    });
    const wrongNonceToken = await cursorToken({nonce: 'wrong-nonce'});

    for (let index = 0; index < cursorAttestationMaximumAttempts(); index += 1) {
      await expect(
        completeCursorAttestation(store, verifier, principal, {
          challengeId: challenge.challengeId,
          token: wrongNonceToken,
        }),
      ).rejects.toThrow('nonce');
    }
    await expect(
      completeCursorAttestation(store, verifier, principal, {
        challengeId: challenge.challengeId,
        token: wrongNonceToken,
      }),
    ).rejects.toThrow('invalid or expired');
    expect(store.attempts.get(challenge.challengeId)).toBe(cursorAttestationMaximumAttempts());
  });

  it('rejects an oversized workload token before spending a challenge attempt', async () => {
    const store = new MemoryAttestationStore();
    const principal = principalFixture();
    const challenge = await beginCursorAttestation(store, principal, {
      audience: AUDIENCE,
      completionUrl: 'https://memory.example.test/attest/cursor/complete',
    });

    await expect(
      completeCursorAttestation(store, verifier, principal, {
        challengeId: challenge.challengeId,
        token: Effect.pipe('x', EffectString.repeat(16 * 1024 + 1)),
      }),
    ).rejects.toMatchObject({code: 'invalid_request', status: 400});
    expect(store.attempts.has(challenge.challengeId)).toBe(false);
  });

  it('rejects expired and differently bound challenges before verifying the token', async () => {
    const store = new MemoryAttestationStore();
    const principal = principalFixture();
    const challenge = await beginCursorAttestation(store, principal, {
      audience: AUDIENCE,
      completionUrl: 'https://memory.example.test/attest/cursor/complete',
      now: new Date('2026-08-13T08:00:00.000Z'),
    });
    const token = await cursorToken({nonce: challenge.nonce});

    await expect(
      completeCursorAttestation(
        store,
        verifier,
        principal,
        {challengeId: challenge.challengeId, token},
        new Date('2026-08-13T08:02:00.000Z'),
      ),
    ).rejects.toThrow('invalid or expired');
    await expect(
      completeCursorAttestation(
        store,
        verifier,
        principalFixture({principalId: 'principal-2'}),
        {challengeId: challenge.challengeId, token},
        new Date('2026-08-13T08:01:00.000Z'),
      ),
    ).rejects.toThrow('invalid or expired');
  });

  it('reauthorizes persisted claims against current bindings before every write', async () => {
    const store = new MemoryAttestationStore();
    const principal = principalFixture();
    const challenge = await beginCursorAttestation(store, principal, {
      audience: AUDIENCE,
      completionUrl: 'https://memory.example.test/attest/cursor/complete',
    });
    const completed = await completeCursorAttestation(store, verifier, principal, {
      challengeId: challenge.challengeId,
      token: await cursorToken({nonce: challenge.nonce}),
    });

    await expect(
      requireCursorAttestation(store, principal, completed.attestationId, 'threadnote'),
    ).resolves.toMatchObject({
      attestationId: completed.attestationId,
    });
    const changedPolicy = principalFixture({
      repositoryBindings: new Set(['https://github.com/example/revoked-repository']),
    });
    await expect(requireCursorAttestation(store, changedPolicy, completed.attestationId)).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
    await expect(
      requireCursorAttestation(store, principal, completed.attestationId, 'different-project'),
    ).rejects.toMatchObject({code: 'forbidden', status: 403});
  });
});
