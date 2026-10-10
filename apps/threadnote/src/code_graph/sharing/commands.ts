import {Console, Effect} from 'effect';
import {writeFinalCliOutput} from '../../effect/cli/output.js';
import {captureConsole} from '../../effect/console.js';
import {commandShimCheck, installCommandShim} from '../../command-shim.js';
import {isStandaloneThreadnoteBuild} from '@threadnote/workspace/runtime-version';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {graphSharingFailure} from '@threadnote/graph/sharing/errors';
import {
  configureGraphOAuthUser,
  configureRegistryOAuthUser,
  loginGraphOAuthUser,
  loginRegistryOAuthUser,
  logoutGraphOAuthUser,
  logoutRegistryOAuthUser,
} from '@threadnote/graph/sharing/oauth/user';
import {
  graphPublisherPublicationMessage,
  readGraphPublisherRegistryStatus,
} from '@threadnote/graph/sharing/publisher/registry';
import {
  runGraphContributeSet,
  runGraphContributeStatus,
  runGraphShareJoin,
  runGraphShareLeave,
  runGraphShareStatus,
  runGraphWorker,
  type GraphShareContributeSetOptions,
  type GraphShareContributeStatusOptions,
  type GraphShareJoinOptions,
  type GraphShareLeaveOptions,
  type GraphShareStatusOptions,
  type GraphWorkerOptions,
} from '@threadnote/graph/sharing/client';
import {
  runGraphPublisherBootstrap,
  runGraphPublisherListen,
  runGraphPublisherProfilePromote,
  runGraphPublisherServe,
  runGraphShareInit,
  type GraphPublisherBootstrapOptions,
  type GraphPublisherProfilePromoteOptions,
  type GraphShareInitOptions,
} from './publisher.js';

export const runGraphShareInitCommand = Effect.fn('codeGraph.sharing.initCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareInitOptions,
) {
  const result = yield* runGraphShareInit(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(
    options.registry !== undefined
      ? result.written
        ? `Wrote temporary local-CAS enrollment ${result.enrollmentPath}. Run graph publisher profile-promote --registry ${options.registry}, then replace this file with the verified v2 candidate before committing.`
        : `Staged local-CAS graph profile ${result.profileDigest}. Run again with --write-config for promotion, then replace the v1 file with the verified v2 candidate before committing.`
      : result.written
        ? `Wrote graph share enrollment ${result.enrollmentPath}`
        : `Graph share enrollment preview ${result.profileDigest}; pass --write-config to write ${result.enrollmentPath}`,
  );
  return result;
});

export const runGraphShareJoinCommand = Effect.fn('codeGraph.sharing.joinCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareJoinOptions,
) {
  const result = yield* runGraphShareJoin(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(
    `Joined graph sharing (${result.accessMode}) for ${result.organization} at ${result.profileDigest}`,
  );
  return result;
});

export const runGraphShareLeaveCommand = Effect.fn('codeGraph.sharing.leaveCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareLeaveOptions,
) {
  const result = yield* runGraphShareLeave(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(`Left graph sharing for ${result.repositoryId}`);
  return result;
});

export const runGraphShareStatusCommand = Effect.fn('codeGraph.sharing.statusCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareStatusOptions,
) {
  const result = yield* runGraphShareStatus(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(
    result.enrolled
      ? `Graph sharing enrolled${result.trusted ? `; ${result.accessMode ?? 'trusted'}` : '; not joined'}${
          result.lastImport === undefined ? '' : `; last import ${result.lastImport.reason}`
        }`
      : 'Graph sharing is not enrolled; local graph behavior is unchanged.',
  );
  return result;
});

export const runGraphPublisherBootstrapCommand = Effect.fn('codeGraph.sharing.publisherBootstrapCommand')(function* (
  config: RuntimeConfig,
  options: GraphPublisherBootstrapOptions,
) {
  const result = yield* runGraphPublisherBootstrap(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(graphPublisherPublicationMessage(result));
  return result;
});

export const runGraphPublisherProfilePromoteCommand = Effect.fn('codeGraph.sharing.publisherProfilePromoteCommand')(
  function* (config: RuntimeConfig, options: GraphPublisherProfilePromoteOptions) {
    const result = yield* runGraphPublisherProfilePromote(config, options);
    const candidate = JSON.stringify(result.enrollment, undefined, 2);
    if (options.json) yield* writeFinalCliOutput(JSON.stringify(result));
    else
      yield* Console.log(
        `Verified OCI profile artifact. Review this candidate enrollment; no repository file was changed:\n${candidate}`,
      );
    return result;
  },
);

export const runGraphPublisherServeCommand = Effect.fn('codeGraph.sharing.publisherServeCommand')(function* (
  config: RuntimeConfig,
  options: GraphPublisherBootstrapOptions,
) {
  if (options.authorizationPolicy !== undefined && !options.listen?.trim()) {
    return yield* graphSharingFailure('Graph control authorization requires --listen.');
  }
  if (options.listen !== undefined && options.listen.trim().length > 0) {
    return yield* runGraphPublisherListen(config, {
      ...options,
      listen: options.listen,
      onReady: output => writeFinalCliOutput(JSON.stringify(output)),
    });
  }
  const result = yield* runGraphPublisherServe(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(graphPublisherPublicationMessage(result));
  return result;
});

export const runGraphContributeStatusCommand = Effect.fn('codeGraph.sharing.contributeStatusCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareContributeStatusOptions,
) {
  const result = yield* runGraphContributeStatus(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(
    `Graph contribution mode ${result.mode}${result.requestedMode === result.mode ? '' : ` (requested ${result.requestedMode})`}`,
  );
  if (result.resourcePolicy?.verification === 'unavailable')
    yield* Console.log('Trusted organization profile is unavailable; contribution uploads fail closed.');
  else if (result.resourcePolicy?.deliveryPausedReason === 'organization-upload-disabled')
    yield* Console.log('Organization profile disables contribution uploads (0 bytes/second).');
  else if (result.resourcePolicy !== undefined && result.mode !== 'off')
    yield* Console.log(
      `Organization upload limit ${result.resourcePolicy.declaredMaximumUploadBytesPerSecond} bytes/second is declared but not enforced; active resource limits are not enforced.`,
    );
  return result;
});

export const runGraphContributeSetCommand = Effect.fn('codeGraph.sharing.contributeSetCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareContributeSetOptions,
) {
  const result = yield* runGraphContributeSet(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(
    `Set graph contribution mode ${result.mode}${result.requestedMode === result.mode ? '' : ` (requested ${result.requestedMode})`}`,
  );
  return result;
});

export const runGraphWorkerCommand = Effect.fn('codeGraph.sharing.workerCommand')(function* (
  config: RuntimeConfig,
  options: GraphWorkerOptions,
) {
  const result = yield* runGraphWorker(config, options);
  if (options.json) {
    yield* writeFinalCliOutput(JSON.stringify(result));
    return result;
  }
  yield* Console.log(
    `Advertised Git blobs present ${result.eligible}; missing ${result.skippedMissingBlob}; no work executed`,
  );
  return result;
});

export const runGraphPublisherStatusCommand = Effect.fn('codeGraph.sharing.publisherStatusCommand')(function* (
  config: RuntimeConfig,
  options: GraphShareStatusOptions,
) {
  const result = yield* readGraphPublisherRegistryStatus(config, options);
  if (options.json) yield* writeFinalCliOutput(JSON.stringify(result));
  else
    yield* Console.log(
      !result.enrolled
        ? 'Repository is not enrolled for graph publication.'
        : result.localCandidate === undefined || result.publication === undefined
          ? 'No local signed frontier has been prepared.'
          : `${graphPublisherPublicationMessage({...result.localCandidate, publication: result.publication})}${
              result.contributionEvidenceStatus === 'unavailable'
                ? '; source-use evidence unavailable'
                : result.contributionEvidence === undefined
                  ? ''
                  : `; source-used ${result.contributionEvidence.contributionEvidence.sourceUse.consumedActions} of ${result.contributionEvidence.contributionEvidence.selectedResults} selected results`
            }`,
    );
  return result;
});

interface OAuthProviderOptions {
  readonly audienceParameter?: string;
  readonly clientIdClaim?: string;
  readonly deviceAuthorizationUrl?: string;
  readonly jwksUrl?: string;
  readonly tokenUrl?: string;
}

function legacyAuth0Provider(issuer: string, audience: string) {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw graphSharingFailure('Legacy Auth0 setup requires an exact HTTPS tenant root issuer.');
  }
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.href !== issuer ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw graphSharingFailure('Legacy Auth0 setup requires an exact HTTPS tenant root issuer.');
  return {
    audienceParameter: audience,
    clientIdClaim: 'azp-or-client_id' as const,
    deviceAuthorizationUrl: new URL('oauth/device/code', issuer).href,
    jwksUrl: new URL('.well-known/jwks.json', issuer).href,
    tokenUrl: new URL('oauth/token', issuer).href,
  };
}

function explicitOAuthProvider(options: OAuthProviderOptions):
  | {
      readonly audienceParameter?: string;
      readonly clientIdClaim: 'azp' | 'client_id' | 'cid' | 'azp-or-client_id';
      readonly deviceAuthorizationUrl: string;
      readonly jwksUrl: string;
      readonly tokenUrl: string;
    }
  | undefined {
  const values = [
    options.audienceParameter,
    options.clientIdClaim,
    options.deviceAuthorizationUrl,
    options.jwksUrl,
    options.tokenUrl,
  ];
  if (values.every(value => value === undefined)) return undefined;
  if (
    options.clientIdClaim === undefined ||
    options.deviceAuthorizationUrl === undefined ||
    options.jwksUrl === undefined ||
    options.tokenUrl === undefined ||
    !['azp', 'client_id', 'cid', 'azp-or-client_id'].includes(options.clientIdClaim)
  )
    throw graphSharingFailure(
      'Explicit OAuth setup requires --device-authorization-url, --token-url, --jwks-url, and --client-id-claim.',
    );
  return {
    ...(options.audienceParameter === undefined ? {} : {audienceParameter: options.audienceParameter}),
    clientIdClaim: options.clientIdClaim as 'azp' | 'client_id' | 'cid' | 'azp-or-client_id',
    deviceAuthorizationUrl: options.deviceAuthorizationUrl,
    jwksUrl: options.jwksUrl,
    tokenUrl: options.tokenUrl,
  };
}

export const runGraphOAuthConfigureCommand = Effect.fn('codeGraph.sharing.oauthConfigureCommand')(function* (
  config: RuntimeConfig,
  options: OAuthProviderOptions & {
    readonly audience: string;
    readonly clientId: string;
    readonly coordinatorUrl: string;
    readonly issuer: string;
    readonly organization: string;
    readonly json: boolean;
  },
) {
  const selection = yield* Effect.try({
    try: () => {
      const explicit = explicitOAuthProvider(options);
      return {
        profile: explicit === undefined ? ('legacy-auth0' as const) : ('generic' as const),
        provider: explicit ?? legacyAuth0Provider(options.issuer, options.audience),
      };
    },
    catch: error => error as ReturnType<typeof graphSharingFailure>,
  });
  const base = {
    audience: options.audience,
    clientId: options.clientId,
    coordinatorUrl: options.coordinatorUrl,
    issuer: options.issuer,
    organization: options.organization,
  };
  const result = yield* configureGraphOAuthUser(
    config,
    {
      ...base,
      ...selection.provider,
    },
    {profile: selection.profile},
  );
  if (options.json) yield* writeFinalCliOutput(JSON.stringify(result));
  else yield* Console.log('Configured the public OAuth graph client. Run `threadnote graph auth login` once.');
});

export const runGraphOAuthLoginCommand = Effect.fn('codeGraph.sharing.oauthLoginCommand')(function* (
  config: RuntimeConfig,
  options: {readonly coordinatorUrl?: string; readonly organization?: string},
) {
  if ((options.coordinatorUrl === undefined) !== (options.organization === undefined))
    return yield* graphSharingFailure('Specify both --coordinator and --organization.');
  const selector =
    options.coordinatorUrl === undefined || options.organization === undefined
      ? undefined
      : {coordinatorUrl: options.coordinatorUrl, organization: options.organization};
  yield* loginGraphOAuthUser(config.agentContextHome, undefined, selector);
  yield* Console.log('Graph OAuth login complete. Background graph contributions can refresh silently.');
});

export const runGraphOAuthLogoutCommand = Effect.fn('codeGraph.sharing.oauthLogoutCommand')(function* (
  config: RuntimeConfig,
  options: {readonly coordinatorUrl?: string; readonly organization?: string},
) {
  if ((options.coordinatorUrl === undefined) !== (options.organization === undefined))
    return yield* graphSharingFailure('Specify both --coordinator and --organization.');
  const selector =
    options.coordinatorUrl === undefined || options.organization === undefined
      ? undefined
      : {coordinatorUrl: options.coordinatorUrl, organization: options.organization};
  yield* logoutGraphOAuthUser(config.agentContextHome, undefined, selector);
  yield* Console.log('Removed the local graph OAuth session. Run `threadnote graph auth login` to reconnect.');
});

export const runRegistryOAuthConfigureCommand = Effect.fn('codeGraph.sharing.registryOAuthConfigureCommand')(function* (
  config: RuntimeConfig,
  options: OAuthProviderOptions & {
    readonly audience: string;
    readonly clientId: string;
    readonly issuer: string;
    readonly organization: string;
    readonly origin: string;
    readonly subject: string;
    readonly json: boolean;
  },
) {
  const selection = yield* Effect.try({
    try: () => {
      const explicit = explicitOAuthProvider(options);
      return {
        profile: explicit === undefined ? ('legacy-auth0' as const) : ('generic' as const),
        provider: explicit ?? legacyAuth0Provider(options.issuer, options.audience),
      };
    },
    catch: error => error as ReturnType<typeof graphSharingFailure>,
  });
  const legacy = {
    audience: options.audience,
    clientId: options.clientId,
    issuer: options.issuer,
    organization: options.organization,
    origin: options.origin,
    subject: options.subject,
  };
  const result = yield* configureRegistryOAuthUser(
    config,
    {
      ...legacy,
      ...selection.provider,
    },
    {profile: selection.profile},
  );
  if (isStandaloneThreadnoteBuild()) {
    yield* captureConsole(installCommandShim(false, undefined, config.agentContextHome));
    const launcherCheck = yield* commandShimCheck(config.agentContextHome);
    if (launcherCheck.status !== 'ok')
      return yield* graphSharingFailure('Registry credential launcher is unavailable; run `threadnote repair`.');
  }
  if (options.json) yield* writeFinalCliOutput(JSON.stringify(result));
  else
    yield* Console.log('Configured the public OAuth registry reader. Run `threadnote graph auth registry login` once.');
});

export const runRegistryOAuthLoginCommand = Effect.fn('codeGraph.sharing.registryOAuthLoginCommand')(function* (
  config: RuntimeConfig,
  options: {readonly origin?: string; readonly organization?: string},
) {
  if ((options.origin === undefined) !== (options.organization === undefined))
    return yield* graphSharingFailure('Specify both --origin and --organization.');
  const selector =
    options.origin === undefined || options.organization === undefined
      ? undefined
      : {coordinatorUrl: options.origin, organization: options.organization};
  yield* loginRegistryOAuthUser(config.agentContextHome, undefined, selector);
  yield* Console.log('Registry OAuth login complete. Verified registry reads can refresh silently.');
});

export const runRegistryOAuthLogoutCommand = Effect.fn('codeGraph.sharing.registryOAuthLogoutCommand')(function* (
  config: RuntimeConfig,
  options: {readonly origin?: string; readonly organization?: string},
) {
  if ((options.origin === undefined) !== (options.organization === undefined))
    return yield* graphSharingFailure('Specify both --origin and --organization.');
  const selector =
    options.origin === undefined || options.organization === undefined
      ? undefined
      : {coordinatorUrl: options.origin, organization: options.organization};
  yield* logoutRegistryOAuthUser(config.agentContextHome, undefined, selector);
  yield* Console.log(
    'Removed the local registry OAuth session. Run `threadnote graph auth registry login` to reconnect.',
  );
});
