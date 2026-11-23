import {Layer} from 'effect';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';

export const THREADNOTE_SESSION_ID_ENVIRONMENT_VARIABLE = 'THREADNOTE_TELEMETRY_SESSION_ID';
export const THREADNOTE_SESSION_GENERATION_ENVIRONMENT_VARIABLE = 'THREADNOTE_TELEMETRY_CONSENT_GENERATION';
export const THREADNOTE_CHILD_KIND_ENVIRONMENT_VARIABLE = 'THREADNOTE_TELEMETRY_CHILD';
export const THREADNOTE_PROVIDER_ENVIRONMENT_VARIABLE = 'THREADNOTE_AGENT_SESSION_PROVIDER';
export const THREADNOTE_PROVIDER_TOKEN_ENVIRONMENT_VARIABLE = 'THREADNOTE_AGENT_SESSION_TOKEN';

export type ThreadnoteChildKind =
  'auto-update-worker' | 'graph-builder' | 'local-model-worker' | 'mcp-broker-runtime' | 'mcp-server' | 'parser-worker';

/** Copies an environment while explicitly admitting one intended Threadnote child. */
export function withThreadnoteSessionEnvironment(
  environment: NodeJS.ProcessEnv,
  session: {readonly consentGeneration?: string; readonly id: string},
  childKind: ThreadnoteChildKind,
): NodeJS.ProcessEnv {
  const childEnvironment = withoutThreadnoteSessionEnvironment(environment);
  if (session.consentGeneration === undefined) return childEnvironment;
  if (!isAnonymousAgentSessionId(session.id)) {
    throw new TypeError('Threadnote agent session id has an invalid format.');
  }
  if (!isTelemetryConsentGeneration(session.consentGeneration)) {
    throw new TypeError('Threadnote telemetry consent generation has an invalid format.');
  }
  childEnvironment[THREADNOTE_SESSION_ID_ENVIRONMENT_VARIABLE] = session.id;
  childEnvironment[THREADNOTE_SESSION_GENERATION_ENVIRONMENT_VARIABLE] = session.consentGeneration;
  childEnvironment[THREADNOTE_CHILD_KIND_ENVIRONMENT_VARIABLE] = childKind;
  return childEnvironment;
}

/** Preserves the current opaque alias only for an explicitly selected Threadnote child. */
export function withCurrentThreadnoteSessionEnvironment(
  environment: NodeJS.ProcessEnv,
  childKind: ThreadnoteChildKind,
): NodeJS.ProcessEnv {
  const id = environment[THREADNOTE_SESSION_ID_ENVIRONMENT_VARIABLE];
  const consentGeneration = environment[THREADNOTE_SESSION_GENERATION_ENVIRONMENT_VARIABLE];
  if (
    id === undefined ||
    consentGeneration === undefined ||
    !isAnonymousAgentSessionId(id) ||
    !isTelemetryConsentGeneration(consentGeneration)
  ) {
    return withoutThreadnoteSessionEnvironment(environment);
  }
  return withThreadnoteSessionEnvironment(environment, {consentGeneration, id}, childKind);
}

/** Generic external subprocesses inherit neither raw provider input nor Threadnote correlation state. */
export function withoutThreadnoteSessionEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = {...environment};
  clearThreadnoteSessionEnvironment(sanitized);
  return sanitized;
}

export function clearThreadnoteSessionEnvironment(environment: NodeJS.ProcessEnv): void {
  delete environment[THREADNOTE_PROVIDER_ENVIRONMENT_VARIABLE];
  delete environment[THREADNOTE_PROVIDER_TOKEN_ENVIRONMENT_VARIABLE];
  delete environment[THREADNOTE_SESSION_ID_ENVIRONMENT_VARIABLE];
  delete environment[THREADNOTE_SESSION_GENERATION_ENVIRONMENT_VARIABLE];
  delete environment[THREADNOTE_CHILD_KIND_ENVIRONMENT_VARIABLE];
}

export function isAnonymousAgentSessionId(value: string): boolean {
  return /^tns_[\da-f]{32}$/u.test(value);
}

export function isTelemetryConsentGeneration(value: string): boolean {
  return /^tng_[\da-f]{32}$/u.test(value);
}

export function isTelemetryChildKind(value: string | undefined): value is ThreadnoteChildKind {
  return (
    value === 'auto-update-worker' ||
    value === 'graph-builder' ||
    value === 'local-model-worker' ||
    value === 'mcp-broker-runtime' ||
    value === 'mcp-server' ||
    value === 'parser-worker'
  );
}

export const telemetryChildEnvironmentPolicy = ChildEnvironmentPolicy.of({
  preserveIntendedChild: (environment, childKind) =>
    isTelemetryChildKind(childKind)
      ? withCurrentThreadnoteSessionEnvironment(environment, childKind)
      : withoutThreadnoteSessionEnvironment(environment),
  sanitizeExternal: withoutThreadnoteSessionEnvironment,
});

export const telemetryChildEnvironmentPolicyLayer = Layer.succeed(
  ChildEnvironmentPolicy,
  telemetryChildEnvironmentPolicy,
);
