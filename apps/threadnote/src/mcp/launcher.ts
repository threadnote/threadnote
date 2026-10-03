export function inspectMcpServerInvocation(arguments_: readonly string[], executableName: string | undefined) {
  let command: string | undefined;
  let help = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--home') {
      index += 1;
      continue;
    }
    if (argument?.startsWith('--home=')) continue;
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    command ??= argument;
  }
  return {
    selected: executableName?.startsWith('threadnote-mcp-server') === true || command === 'mcp-server',
    help,
  };
}

export const mcpServerHelp =
  [
    'Threadnote MCP stdio server',
    '',
    'Usage: threadnote [--home PATH] mcp-server [--help]',
    '       threadnote-mcp-server [--home PATH] [--help]',
    '',
    '--home PATH may appear before or after mcp-server and overrides THREADNOTE_HOME.',
    '--help, -h prints this help without starting the MCP adapter.',
    '',
    'Environment:',
    '  THREADNOTE_HOME          Threadnote data home',
    '  THREADNOTE_MANIFEST      Seed manifest path',
    '  THREADNOTE_MCP_TOOLSET   Toolset selection; use full for the complete tool catalog',
    '',
    'The running server reserves stdout for MCP JSON-RPC; diagnostics go to stderr.',
  ].join('\n') + '\n';
