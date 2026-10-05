import {Command} from 'effect/cli';
import type {Effect} from 'effect';
import {boolean, optionalString, requiredChoice} from '../../effect/cli/flags.js';
import {codeGraphCliBounds} from '../../effect/code_graph_cli_flags.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  runGraphContributeSetCommand,
  runGraphContributeStatusCommand,
  runGraphOAuthConfigureCommand,
  runGraphOAuthLoginCommand,
  runGraphOAuthLogoutCommand,
  runRegistryOAuthConfigureCommand,
  runRegistryOAuthLoginCommand,
  runRegistryOAuthLogoutCommand,
  runGraphPublisherBootstrapCommand,
  runGraphPublisherProfilePromoteCommand,
  runGraphPublisherServeCommand,
  runGraphPublisherStatusCommand,
  runGraphShareInitCommand,
  runGraphShareJoinCommand,
  runGraphShareLeaveCommand,
  runGraphShareStatusCommand,
  runGraphWorkerCommand,
} from './commands.js';
import {requiredString} from '../../effect/cli/flags.js';

export function makeGraphSharingCommands(
  withRuntimeEffect: <E, R>(effect: (config: RuntimeConfig) => Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>,
) {
  const graphShareInit = Command.make(
    'init',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory for organization-issued profiles'),
      coordinator: optionalString('coordinator', 'HTTPS coordinator URL, or loopback HTTP for local publisher serve'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      organization: optionalString('organization', 'Organization identity recorded in the issued profile'),
      registry: optionalString('registry', 'Canonical OCI repository for an administrator-staged profile'),
      workerRegistry: optionalString(
        'worker-registry',
        'Distinct worker OCI repository for an administrator-staged profile',
      ),
      writeConfig: boolean('write-config', 'Write .threadnote/graph-share.json in the repository'),
    },
    options => withRuntimeEffect(config => runGraphShareInitCommand(config, options)),
  ).pipe(Command.withDescription('Issue a digest-pinned organization profile and optional enrollment pointer'));

  const graphShareJoin = Command.make(
    'join',
    {
      approvalFile: optionalString(
        'approval-file',
        'Private administrator-approved OCI trust and contribution policy file outside the checkout',
      ),
      cas: optionalString('cas', 'Digest-addressed CAS directory that stores the enrolled profile'),
      coordinator: optionalString(
        'coordinator',
        'Coordinator URL used to fetch the enrolled profile and later frontiers without a shared CAS directory',
      ),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      readOnly: boolean(
        'read-only',
        'Trust the enrolled profile without contribution; the next graph index may import a verified base',
      ),
    },
    options => withRuntimeEffect(config => runGraphShareJoinCommand(config, options)),
  ).pipe(Command.withDescription('Trust an enrolled publisher profile for this checkout'));

  const graphShareLeave = Command.make(
    'leave',
    {
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      purge: boolean('purge', 'Leave also clears provenance; this flag is kept for compatibility'),
    },
    options => withRuntimeEffect(config => runGraphShareLeaveCommand(config, options)),
  ).pipe(Command.withDescription('Revoke local graph-sharing consent for this repository'));

  const graphShareStatus = Command.make(
    'status',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory to inspect'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runGraphShareStatusCommand(config, options)),
  ).pipe(Command.withDescription('Report enrollment, trust, and selected shared frontier without printing secrets'));

  const graphShare = Command.make('share').pipe(
    Command.withDescription('Enroll a repository in organization graph sharing and manage local trust'),
    Command.withSubcommands([graphShareInit, graphShareStatus, graphShareJoin, graphShareLeave]),
  );

  const graphPublisherBootstrap = Command.make(
    'bootstrap',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory for signed frontier artifacts'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runGraphPublisherBootstrapCommand(config, options)),
  ).pipe(Command.withDescription('Prepare an initial signed frontier or retry publication of the existing generation'));

  const graphPublisherServe = Command.make(
    'serve',
    {
      authorizationPolicy: optionalString(
        'authorization-policy',
        'Policy file for authenticated graph control; signed worker results require distinct OCI registries; disables HTTP artifact routes',
      ),
      cas: optionalString('cas', 'Digest-addressed CAS directory for signed frontier artifacts'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      listen: optionalString(
        'listen',
        'Loopback host:port for the live coordinator and digest CAS (for example 127.0.0.1:18765)',
      ),
    },
    options => withRuntimeEffect(config => runGraphPublisherServeCommand(config, options)),
  ).pipe(
    Command.withDescription(
      'Observe HEAD, publish the next signed generation when it advances, and optionally listen for contributors',
    ),
  );

  const graphPublisherProfilePromote = Command.make(
    'profile-promote',
    {
      cas: optionalString('cas', 'Persisted CAS directory containing the staged v1 profile'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      registry: requiredString('registry', 'Exact canonical OCI registry reference; publisher M2M push is required'),
    },
    options => withRuntimeEffect(config => runGraphPublisherProfilePromoteCommand(config, options)),
  ).pipe(Command.withDescription('Publish and verify a staged profile, then print a v2 enrollment candidate'));

  const graphPublisherStatus = Command.make(
    'status',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory to inspect'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runGraphPublisherStatusCommand(config, options)),
  ).pipe(Command.withDescription('Report local signed candidates and confirmed or pending registry publication'));

  const graphPublisher = Command.make('publisher').pipe(
    Command.withDescription('Publish signed shared graph checkpoints for enrolled repositories'),
    Command.withSubcommands([
      graphPublisherBootstrap,
      graphPublisherProfilePromote,
      graphPublisherServe,
      graphPublisherStatus,
    ]),
  );

  const graphContributeStatus = Command.make(
    'status',
    {
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runGraphContributeStatusCommand(config, options)),
  ).pipe(Command.withDescription('Report local graph contribution mode without printing secrets'));

  const graphContributeSet = Command.make(
    'set',
    {
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
      mode: requiredChoice('mode', ['off', 'passive', 'idle', 'dedicated'], 'Contribution mode'),
    },
    options => withRuntimeEffect(config => runGraphContributeSetCommand(config, options)),
  ).pipe(Command.withDescription('Set local contribution preference; idle and dedicated currently deliver passively'));

  const graphContribute = Command.make('contribute').pipe(
    Command.withDescription('Control opportunistic graph-sharing contribution from this checkout'),
    Command.withSubcommands([graphContributeStatus, graphContributeSet]),
  );

  const graphWorker = Command.make(
    'worker',
    {
      cas: optionalString('cas', 'Digest-addressed CAS directory for worker results'),
      cwd: codeGraphCliBounds.cwd,
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runGraphWorkerCommand(config, options)),
  ).pipe(Command.withDescription('Report which advertised Git blobs exist locally without executing actions'));

  const graphOAuthConfigure = Command.make(
    'configure',
    {
      audience: requiredString('audience', 'Stable graph API audience registered with the OAuth provider'),
      audienceParameter: optionalString(
        'audience-parameter',
        'Optional provider audience request parameter; omit for Okta custom authorization servers',
      ),
      clientId: requiredString('client-id', 'Public OAuth Native application client ID'),
      clientIdClaim: optionalString(
        'client-id-claim',
        'Access-token client claim: cid, azp, client_id, or azp-or-client_id',
      ),
      coordinatorUrl: requiredString('coordinator', 'Exact HTTPS graph coordinator URL'),
      deviceAuthorizationUrl: optionalString('device-authorization-url', 'Exact OAuth device authorization endpoint'),
      issuer: requiredString('issuer', 'Exact OAuth issuer URL, including any authorization-server path'),
      jwksUrl: optionalString('jwks-url', 'Exact OAuth JSON Web Key Set endpoint'),
      organization: requiredString('organization', 'Graph organization identity'),
      tokenUrl: optionalString('token-url', 'Exact OAuth token endpoint'),
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runGraphOAuthConfigureCommand(config, options)),
  ).pipe(Command.withDescription('Bind a public OAuth Native client to this organization graph'));

  const graphAuthSelection = {
    coordinatorUrl: optionalString('coordinator', 'Select one configured graph coordinator when multiple are present'),
    organization: optionalString('organization', 'Select one configured graph organization when multiple are present'),
  };
  const graphOAuthLogin = Command.make('login', graphAuthSelection, options =>
    withRuntimeEffect(config => runGraphOAuthLoginCommand(config, options)),
  ).pipe(
    Command.withDescription(
      'Authorize graph use once with OAuth Device Flow and save rotating credentials in macOS Keychain',
    ),
  );

  const graphOAuthLogout = Command.make('logout', graphAuthSelection, options =>
    withRuntimeEffect(config => runGraphOAuthLogoutCommand(config, options)),
  ).pipe(Command.withDescription('Remove the saved local OAuth graph session from macOS Keychain'));

  const registryOAuthConfigure = Command.make(
    'configure',
    {
      audience: requiredString('audience', 'Exact registry API audience; must equal the Zot HTTPS origin'),
      audienceParameter: optionalString(
        'audience-parameter',
        'Optional provider audience request parameter; omit for Okta custom authorization servers',
      ),
      clientId: requiredString('client-id', 'Public OAuth Native application client ID'),
      clientIdClaim: optionalString(
        'client-id-claim',
        'Access-token client claim: cid, azp, client_id, or azp-or-client_id',
      ),
      deviceAuthorizationUrl: optionalString('device-authorization-url', 'Exact OAuth device authorization endpoint'),
      issuer: requiredString('issuer', 'Exact OAuth issuer URL, including any authorization-server path'),
      jwksUrl: optionalString('jwks-url', 'Exact OAuth JSON Web Key Set endpoint'),
      organization: requiredString('organization', 'Registry organization identity'),
      origin: requiredString('origin', 'Exact Zot HTTPS origin'),
      subject: requiredString('subject', 'Exact OAuth reader subject admitted by Zot'),
      tokenUrl: optionalString('token-url', 'Exact OAuth token endpoint'),
      json: codeGraphCliBounds.json,
    },
    options => withRuntimeEffect(config => runRegistryOAuthConfigureCommand(config, options)),
  ).pipe(Command.withDescription('Bind a separate OAuth Native registry reader audience to this organization'));
  const registryAuthSelection = {
    origin: optionalString('origin', 'Select one configured Zot registry origin when multiple are present'),
    organization: optionalString(
      'organization',
      'Select one configured registry organization when multiple are present',
    ),
  };
  const registryOAuthLogin = Command.make('login', registryAuthSelection, options =>
    withRuntimeEffect(config => runRegistryOAuthLoginCommand(config, options)),
  ).pipe(Command.withDescription('Authorize read-only Zot access with OAuth Device Flow and macOS Keychain'));
  const registryOAuthLogout = Command.make('logout', registryAuthSelection, options =>
    withRuntimeEffect(config => runRegistryOAuthLogoutCommand(config, options)),
  ).pipe(Command.withDescription('Remove the saved local Zot reader OAuth session from macOS Keychain'));
  const registryAuth = Command.make('registry').pipe(
    Command.withDescription('Set up user-delegated OAuth credentials for Zot registry reads'),
    Command.withSubcommands([registryOAuthConfigure, registryOAuthLogin, registryOAuthLogout]),
  );

  const graphAuth = Command.make('auth').pipe(
    Command.withDescription('Set up user-delegated OAuth credentials for organization graphs'),
    Command.withSubcommands([graphOAuthConfigure, graphOAuthLogin, graphOAuthLogout, registryAuth]),
  );

  return {graphAuth, graphContribute, graphPublisher, graphShare, graphWorker};
}
