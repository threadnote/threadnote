import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {Base64Url} from 'effect/encoding';
import {
  anonymousAgentSessionId,
  deriveConsentedAgentSessionPseudonym,
  isTelemetryConsentGeneration,
  resolveAgentSession,
  TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE,
  TELEMETRY_CHILD_ENVIRONMENT_VARIABLE,
  TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE,
  TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE,
  TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE,
  telemetryConsentGeneration,
  telemetryChildEnvironmentPolicy,
  withAgentSessionEnvironment,
  withCurrentAgentSessionEnvironment,
  withoutTelemetrySessionEnvironment,
  type AgentSessionProvider,
} from '@threadnote/threadnote/telemetry/session';
import {commandEnvironment} from '@threadnote/platform/command';

const providers = ['claude', 'codex', 'copilot', 'cursor'] as const satisfies readonly AgentSessionProvider[];
const ENDPOINT = 'https://telemetry.threadnote.io/v1/traces';

describe('anonymous telemetry agent sessions', () => {
  it('formats exactly 128 bits of random session entropy without retaining inherited identity', () => {
    fc.assert(
      fc.property(fc.uint8Array({maxLength: 16, minLength: 16}), bytes => {
        const sessionId = anonymousAgentSessionId(bytes);
        const inherited = {
          PATH: '/usr/bin',
          [TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]: 'codex',
          [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'raw-provider-token',
          [TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]: 'untrusted-provider-session-token',
        };
        const consentGeneration = telemetryConsentGeneration({
          endpoint: ENDPOINT,
          sessionSalt: Base64Url.encode(new Uint8Array(32).fill(7)),
        });
        const child = withAgentSessionEnvironment(inherited, {consentGeneration, id: sessionId}, 'mcp-server');
        const changedBytes = Uint8Array.from(bytes);
        changedBytes[0] = changedBytes[0] ^ 0xff;

        expect(sessionId).toMatch(/^tns_[\da-f]{32}$/u);
        expect(anonymousAgentSessionId(changedBytes)).not.toBe(sessionId);
        expect(child[TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]).toBe(sessionId);
        expect(child[TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]).toBe(consentGeneration);
        expect(child[TELEMETRY_CHILD_ENVIRONMENT_VARIABLE]).toBe('mcp-server');
        expect(child[TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]).toBeUndefined();
        expect(child[TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]).toBeUndefined();
        expect(child).not.toBe(inherited);
        expect(inherited[TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]).toBe('untrusted-provider-session-token');
      }),
      {numRuns: 100},
    );
  });

  it('derives deterministic, domain-separated pseudonyms without exposing provider tokens', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...providers),
        fc.stringMatching(/^[G-Z]{8,128}$/u),
        fc.uint8Array({maxLength: 64, minLength: 32}),
        (provider, providerSessionToken, consentSalt) => {
          const input = {consentSalt, provider, providerSessionToken};
          const first = deriveConsentedAgentSessionPseudonym(input);
          const second = deriveConsentedAgentSessionPseudonym(input);
          const changedSalt = Uint8Array.from(consentSalt);
          changedSalt[0] = changedSalt[0] ^ 0xff;
          const otherProvider = providers[(providers.indexOf(provider) + 1) % providers.length];

          expect(first).toBe(second);
          expect(first).toMatch(/^tns_[\da-f]{32}$/u);
          expect(first).not.toContain(providerSessionToken);
          expect(deriveConsentedAgentSessionPseudonym({...input, consentSalt: changedSalt})).not.toBe(first);
          expect(deriveConsentedAgentSessionPseudonym({...input, provider: otherProvider})).not.toBe(first);
          expect(
            deriveConsentedAgentSessionPseudonym({...input, providerSessionToken: `${providerSessionToken}Z`}),
          ).not.toBe(first);
        },
      ),
      {numRuns: 100},
    );
  });

  it('does not derive provider identity without a consent salt and token', () => {
    expect(
      deriveConsentedAgentSessionPseudonym({
        consentSalt: undefined,
        provider: 'codex',
        providerSessionToken: 'provider-session',
      }),
    ).toBeUndefined();
    expect(
      deriveConsentedAgentSessionPseudonym({
        consentSalt: new Uint8Array(32),
        provider: 'codex',
        providerSessionToken: undefined,
      }),
    ).toBeUndefined();
  });

  it('uses explicit provider correlation only with enabled persisted consent', () => {
    const randomBytes = Uint8Array.from({length: 16}, (_, index) => index);
    const consentSalt = Uint8Array.from({length: 32}, (_, index) => index + 1);
    const environment = {
      [TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]: 'codex',
      [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'host-session-token',
    };
    const environmentWithoutConsent = {...environment};
    const withoutConsent = resolveAgentSession({
      configuration: undefined,
      environment: environmentWithoutConsent,
      randomBytes,
    });
    const withConsent = resolveAgentSession({
      configuration: {endpoint: ENDPOINT, sessionSalt: Base64Url.encode(consentSalt)},
      environment,
      randomBytes,
    });

    expect(withoutConsent).toEqual({correlationScope: 'broker', id: anonymousAgentSessionId(randomBytes)});
    expect(withConsent.correlationScope).toBe('provider-session');
    expect(withConsent.consentGeneration).toBe(
      telemetryConsentGeneration({endpoint: ENDPOINT, sessionSalt: Base64Url.encode(consentSalt)}),
    );
    expect(withConsent.id).toBe('tns_fa8c00ba7723ca763211e426daac5a7a');
    expect(withConsent.id).not.toContain('host-session-token');
    expect(withConsent.id).not.toBe(withoutConsent.id);
    expect(environmentWithoutConsent[TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]).toBeUndefined();
    expect(environmentWithoutConsent[TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]).toBeUndefined();
    expect(environment[TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]).toBeUndefined();
    expect(environment[TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]).toBeUndefined();
  });

  it('falls back to the broker id for malformed integration inputs', () => {
    const randomBytes = new Uint8Array(16);
    const expected = {correlationScope: 'broker', id: anonymousAgentSessionId(randomBytes)};
    expect(
      resolveAgentSession({
        configuration: {endpoint: ENDPOINT, sessionSalt: 'not-a-consent-salt'},
        environment: {
          [TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]: 'codex',
          [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'provider-token',
        },
        randomBytes,
      }),
    ).toEqual(expected);
    expect(
      resolveAgentSession({
        configuration: {endpoint: ENDPOINT, sessionSalt: Base64Url.encode(new Uint8Array(32))},
        environment: {
          [TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]: 'unknown-provider',
          [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'provider-token',
        },
        randomBytes,
      }),
    ).toMatchObject(expected);
  });

  it('trusts inherited aliases only for declared children in the current consent generation', () => {
    const randomBytes = new Uint8Array(16).fill(9);
    const inheritedId = anonymousAgentSessionId(new Uint8Array(16).fill(3));
    const first = {endpoint: ENDPOINT, sessionSalt: Base64Url.encode(new Uint8Array(32).fill(1))};
    const second = {endpoint: ENDPOINT, sessionSalt: Base64Url.encode(new Uint8Array(32).fill(2))};
    const firstGeneration = telemetryConsentGeneration(first);
    const intendedEnvironment = withAgentSessionEnvironment(
      {},
      {consentGeneration: firstGeneration, id: inheritedId},
      'mcp-server',
    );

    const inherited = resolveAgentSession({configuration: first, environment: intendedEnvironment, randomBytes});
    expect(inherited).toMatchObject({
      consentGeneration: firstGeneration,
      correlationScope: 'broker',
      id: inheritedId,
    });
    expect(
      resolveAgentSession({
        configuration: first,
        environment: withAgentSessionEnvironment(
          {},
          {consentGeneration: firstGeneration, id: inheritedId},
          'auto-update-worker',
        ),
        randomBytes,
      }),
    ).toMatchObject({
      consentGeneration: firstGeneration,
      correlationScope: 'broker',
      id: inheritedId,
    });

    for (const environment of [
      {
        [TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]: inheritedId,
        [TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]: firstGeneration,
      },
      {
        [TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]: inheritedId,
        [TELEMETRY_CHILD_ENVIRONMENT_VARIABLE]: 'mcp-server',
        [TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]: telemetryConsentGeneration(second),
      },
      {
        [TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]: inheritedId,
        [TELEMETRY_CHILD_ENVIRONMENT_VARIABLE]: 'external-command',
        [TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]: firstGeneration,
      },
    ]) {
      const resolved = resolveAgentSession({configuration: first, environment, randomBytes});
      expect(resolved.id).toBe(anonymousAgentSessionId(randomBytes));
      expect(resolved.id).not.toBe(inheritedId);
      expect(Object.keys(environment)).toHaveLength(0);
    }

    const staleAfterRotation = resolveAgentSession({
      configuration: second,
      environment: withAgentSessionEnvironment({}, {consentGeneration: firstGeneration, id: inheritedId}, 'mcp-server'),
      randomBytes,
    });
    expect(staleAfterRotation.id).not.toBe(inheritedId);
    expect(staleAfterRotation.consentGeneration).toBe(telemetryConsentGeneration(second));
  });

  it('scrubs every provider and consent marker from generic external commands', () => {
    const consentGeneration = telemetryConsentGeneration({
      endpoint: ENDPOINT,
      sessionSalt: Base64Url.encode(new Uint8Array(32).fill(4)),
    });
    const environment = {
      PATH: '/usr/bin',
      [TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]: anonymousAgentSessionId(new Uint8Array(16)),
      [TELEMETRY_CHILD_ENVIRONMENT_VARIABLE]: 'mcp-server',
      [TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]: consentGeneration,
      [TELEMETRY_PROVIDER_ENVIRONMENT_VARIABLE]: 'codex',
      [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'raw-provider-token',
    };

    for (const sanitized of [
      withoutTelemetrySessionEnvironment(environment),
      commandEnvironment('external-tool', undefined, environment, telemetryChildEnvironmentPolicy),
      commandEnvironment('git', environment, {}, telemetryChildEnvironmentPolicy),
    ]) {
      expect(sanitized).toEqual({PATH: '/usr/bin'});
    }
    expect(environment[TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]).toBe('raw-provider-token');
  });

  it('restores only an explicitly trusted private index for Git cache writes', () => {
    const environment = {
      GIT_INDEX_FILE: '/untrusted/index',
      GIT_OPTIONAL_LOCKS: '0',
      PATH: '/usr/bin',
      [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'raw-provider-token',
    };

    expect(
      commandEnvironment('git', environment, {}, telemetryChildEnvironmentPolicy, '/private/threadnote/index'),
    ).toEqual({
      GIT_INDEX_FILE: '/private/threadnote/index',
      GIT_OPTIONAL_LOCKS: '1',
      PATH: '/usr/bin',
    });
    expect(environment.GIT_INDEX_FILE).toBe('/untrusted/index');
    expect(environment.GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('preserves only a valid current alias when a Threadnote child is selected explicitly', () => {
    const consentGeneration = telemetryConsentGeneration({
      endpoint: ENDPOINT,
      sessionSalt: Base64Url.encode(new Uint8Array(32).fill(5)),
    });
    expect(isTelemetryConsentGeneration(consentGeneration)).toBe(true);
    const id = anonymousAgentSessionId(new Uint8Array(16).fill(6));
    const child = withCurrentAgentSessionEnvironment(
      {
        PATH: '/usr/bin',
        [TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]: id,
        [TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]: consentGeneration,
        [TELEMETRY_PROVIDER_SESSION_TOKEN_ENVIRONMENT_VARIABLE]: 'must-not-pass',
      },
      'graph-builder',
    );

    expect(child).toEqual({
      PATH: '/usr/bin',
      [TELEMETRY_AGENT_SESSION_ENVIRONMENT_VARIABLE]: id,
      [TELEMETRY_CHILD_ENVIRONMENT_VARIABLE]: 'graph-builder',
      [TELEMETRY_CONSENT_GENERATION_ENVIRONMENT_VARIABLE]: consentGeneration,
    });
  });
});
