/* oxlint-disable effecttsgo/prefer-effect-string -- Standalone protocol child intentionally has no Effect dependency. */
// An invalid initialize response while the child ignores EOF and SIGTERM reproduces SDK auto-close.
let pending = '';
process.stdin.on('data', chunk => {
  pending += chunk.toString();
  for (;;) {
    const newline = pending.indexOf('\n');
    if (newline < 0) break;
    const request = JSON.parse(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    if (request.method === 'initialize') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: 'invalid',
            capabilities: {},
            serverInfo: {name: 'invalid-initialize-fixture', version: '1'},
          },
        }) + '\n',
      );
    }
  }
});
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
