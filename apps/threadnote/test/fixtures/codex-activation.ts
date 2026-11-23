import {Effect, FileSystem, Path} from 'effect';
import {
  AGENT_INTEGRATION_ARTIFACT_VERSION,
  emptyAgentIntegrationRegistry,
  withAgentIntegrationHost,
  writeAgentIntegrationRegistry,
} from '@threadnote/threadnote/agent_integration/registry';
import {CODEX_MCP_RELEASE_ENV, mcpAdapterCommand} from '@threadnote/threadnote/mcp/index';

export const writeCodexActivationFixture = Effect.fn('test.writeCodexActivationFixture')(function* (
  agentContextHome: string,
  profile: string,
  version: string,
  pinned = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(profile, {recursive: true});
  const hostRoot = yield* fs.realPath(profile);
  const file = path.join(hostRoot, 'config.toml');
  const [command, ...args] = yield* mcpAdapterCommand();
  const name = 'activation-fixture';
  const content = `# Preserve unrelated Codex content\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n[mcp_servers.${name}.env]\nTHREADNOTE_HOME = ${JSON.stringify(agentContextHome)}\n${CODEX_MCP_RELEASE_ENV} = "${version}"\n`;
  yield* fs.writeFileString(file, content, {mode: 0o600});
  yield* writeAgentIntegrationRegistry(
    {agentContextHome},
    withAgentIntegrationHost(emptyAgentIntegrationRegistry(true), 'codex', {
      artifactVersion: AGENT_INTEGRATION_ARTIFACT_VERSION,
      artifacts: {},
      installedVersion: version,
      mcp: {name, repair: true, toolset: 'core', ...(pinned ? {hostRoot} : {})},
      status: 'current',
    }),
  );
  return {content, file, name};
});
