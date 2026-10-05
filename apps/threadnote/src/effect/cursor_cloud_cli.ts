import type {Effect} from 'effect';
import {Command, Flag} from 'effect/cli';
import {boolean, optionalString, repeatedString} from './cli/flags.js';

export interface CursorCloudAttestCliOptions {
  readonly audience: string;
  readonly challenge: string;
  readonly completionUrl: string;
  readonly endpoint: string;
  readonly expiresAt: string;
  readonly json: boolean;
  readonly nonce: string;
}

interface CursorCloudAttestFlagBuilders {
  readonly boolean: (name: string, description: string) => Flag.Flag<boolean>;
  readonly requiredString: (name: string, description: string) => Flag.Flag<string>;
}

type CursorCloudMode = 'org' | 'personal' | 'remote-hybrid';

export function makeCursorCloudIdentityFlags(
  defaultString: (name: string, description: string, value: string) => Flag.Flag<string>,
  optionalString: (name: string, description: string) => Flag.Flag<string | undefined>,
) {
  return {
    agentId: optionalString(
      'agent-id',
      'Stable agent identity; defaults to the saved Personal Cursor Cloud profile or cursor-cloud',
    ),
    team: defaultString('team', 'Shared-memory team reserved for Cursor Cloud', 'cursor-cloud'),
    user: optionalString(
      'user',
      'Stable Threadnote user identity; defaults to the saved Personal Cursor Cloud profile or cursor-cloud',
    ),
  } as const;
}

export function makeCursorCloudModeFlag(
  defaultChoice: (
    name: string,
    choices: readonly ['org', 'personal', 'remote-hybrid'],
    description: string,
    value: 'personal',
  ) => Flag.Flag<CursorCloudMode>,
) {
  return defaultChoice('mode', ['org', 'personal', 'remote-hybrid'], 'Cursor Cloud memory transport mode', 'personal');
}

export function makeCursorCloudAttestCommand<E, R>(
  flags: CursorCloudAttestFlagBuilders,
  handler: (options: CursorCloudAttestCliOptions) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'attest',
    {
      audience: flags.requiredString('audience', 'HTTPS audience returned by begin_cursor_attestation'),
      challenge: flags.requiredString('challenge', 'Opaque challenge ID returned by begin_cursor_attestation'),
      completionUrl: flags.requiredString(
        'completion-url',
        'HTTPS completion URL returned by begin_cursor_attestation',
      ),
      endpoint: flags.requiredString('endpoint', 'Configured managed remote memory MCP endpoint'),
      expiresAt: flags.requiredString('expires-at', 'Challenge expiry returned by begin_cursor_attestation'),
      json: flags.boolean('json', 'Print a machine-readable attestation receipt'),
      nonce: flags.requiredString('nonce', 'Nonce returned by begin_cursor_attestation'),
    },
    handler,
  ).pipe(Command.withDescription('Complete a managed Threadnote challenge with Cursor workload identity'));
}

export function makeCursorCloudRemoteConfigFlags() {
  return {
    clientId: optionalString('client-id', 'Registered public OAuth client ID for the organization composer'),
    contribute: boolean(
      'contribute',
      'Explicitly request organization Cloud durable contribution; current grant and Cursor attestation remain required',
    ),
    repositories: repeatedString(
      'repository',
      'Organization Cloud repository binding; repeat for the complete admitted set',
    ),
    endpoint: optionalString('endpoint', 'Managed remote Streamable HTTP MCP endpoint'),
    shareId: optionalString('share-id', 'Opaque managed remote memory share identifier'),
  };
}
