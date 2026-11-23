import {Console, Effect} from 'effect';
import {readAgentIntegrationRegistry} from '../agent_integration/registry.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  CODEX_MCP_LAUNCHER_DEFERRED,
  inspectRegisteredCodexMcp,
  reconcileRegisteredCodexMcp,
  verifyRegisteredCodexMcp,
} from './codex_broker_rotation.js';
import {describeCodexMcpConfiguration} from './install.js';

export type CodexMcpActivationStatus =
  | {readonly configuration: 'skipped'}
  | {readonly configuration: 'deferred'; readonly refresh: 'pending'; readonly reason: string}
  | {
      readonly configuration: 'current' | 'saved';
      readonly refresh: 'pending';
      readonly name: string;
      readonly release: string;
    };

const skipped: CodexMcpActivationStatus = {configuration: 'skipped'};

/** Call only after the installation lock has released the committed pointer and launchers. */
export const reconcileActivatedCodexMcp = Effect.fn('mcp.reconcileActivatedCodex')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  expectedRelease?: string,
  options: {readonly dryRun?: boolean} = {},
) {
  const reportDeferred = (reason: string) =>
    Console.warn(`Codex MCP configuration deferred. Live refresh pending. ${reason}`).pipe(
      Effect.as({configuration: 'deferred', refresh: 'pending', reason} as const satisfies CodexMcpActivationStatus),
    );
  const registry = yield* readAgentIntegrationRegistry(config).pipe(Effect.result);
  if (registry._tag === 'Failure') {
    return yield* reportDeferred(
      'Could not verify the registered Codex profile. Check the local integration registry.',
    );
  }
  const receipt = registry.success?.hosts.codex?.mcp;
  if (
    !receipt ||
    receipt.external ||
    receipt.transport === 'cli' ||
    (receipt.artifactProfile !== undefined && receipt.artifactProfile !== 'default')
  )
    return skipped;
  if (options.dryRun === true) {
    yield* Console.log(
      `Would reconcile Codex MCP ${receipt.name}${expectedRelease ? ` for Threadnote ${expectedRelease}` : ''} in the registered profile.`,
    );
    return skipped;
  }
  const result = yield* reconcileRegisteredCodexMcp(config, expectedRelease, {requireActiveMcpLauncher: true});
  if (result.state === 'skipped') return skipped;
  if (result.state === 'deferred') {
    const inspection = yield* inspectRegisteredCodexMcp(config, receipt);
    if (inspection.state !== 'current' && inspection.state !== 'stale' && inspection.state !== 'legacy') {
      return yield* reportDeferred(describeCodexMcpConfiguration(receipt.name, inspection).detail);
    }
    if (result.reason === CODEX_MCP_LAUNCHER_DEFERRED) {
      return yield* reportDeferred(
        'The MCP launcher does not match the active Threadnote release. Inspect its path and resolve any foreign file or symbolic link before running threadnote repair --mcp codex.',
      );
    }
    const transient =
      result.reason === 'the expected release is no longer active' ||
      result.reason === 'the active release changed during reconciliation' ||
      result.reason === 'Codex config changed during reconciliation';
    return yield* reportDeferred(
      `${result.reason}. ${
        transient
          ? 'Run threadnote repair --mcp codex after the concurrent change finishes.'
          : 'Check access to the recorded Codex configuration before retrying.'
      }`,
    );
  }
  if (!(yield* verifyRegisteredCodexMcp(config, result))) {
    return yield* reportDeferred(
      'The active release or registered profile changed. Run threadnote repair --mcp codex.',
    );
  }
  yield* Console.log(
    `Codex MCP configuration ${result.state === 'saved' ? 'saved' : 'already current'} for Threadnote ${result.release}. ` +
      'Live refresh pending. Restart Codex to refresh open Threadnote connections. ' +
      'For a private app-server socket, see threadnote repair --help for an explicit owner refresh.',
  );
  return {
    configuration: result.state,
    refresh: 'pending',
    name: result.name,
    release: result.release,
  } as const satisfies CodexMcpActivationStatus;
});
