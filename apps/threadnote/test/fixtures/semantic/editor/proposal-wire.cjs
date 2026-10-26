/* oxlint-disable typescript/no-require-imports, effecttsgo/node-builtin-import -- Disposable editor-host protocol fixture cannot load the Bun/TypeScript probe transport. */
/* oxlint-disable eslint/no-undef -- CommonJS is supplied by the desktop extension host. */
/* oxlint-disable effecttsgo/new-promise -- Native socket callbacks run inside the editor host without an Effect runtime. */
const assert = require('node:assert/strict');
const net = require('node:net');
const {randomUUID} = require('node:crypto');

const send = (socket, message) => {
  const body = Buffer.from(JSON.stringify(message));
  socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
};

// Only the small controlled fixture messages are accepted; this is not a product transport.
function receive(socket, handle) {
  let bytes = Buffer.alloc(0);
  let queue = Promise.resolve();
  socket.on('data', chunk => {
    try {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 1024 * 1024) throw new Error('Fixture frame budget exceeded');
      for (;;) {
        const end = bytes.indexOf('\r\n\r\n');
        if (end < 0) break;
        const header = bytes.subarray(0, end).toString('ascii');
        if (!/^Content-Length: [0-9]+$/u.test(header)) throw new Error('Invalid fixture frame');
        const length = Number(header.slice('Content-Length: '.length));
        if (!Number.isSafeInteger(length) || length > 1024 * 1024) throw new Error('Invalid fixture length');
        if (bytes.length < end + 4 + length) break;
        const message = JSON.parse(bytes.subarray(end + 4, end + 4 + length).toString('utf8'));
        bytes = bytes.subarray(end + 4 + length);
        queue = queue.then(() => handle(message)).catch(error => socket.destroy(error));
      }
    } catch (error) {
      socket.destroy(error);
    }
  });
}

/** A private one-use fixture capability, not Threadnote's production bridge enrollment. */
exports.probeGuardedExchange = async candidate => {
  const nonce = randomUUID();
  const proposalId = randomUUID();
  const sockets = new Set();
  let enrolled = false;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    let initialized = false;
    let initializationSent = false;
    let qualified = false;
    receive(socket, async message => {
      if (message.method === 'initialized' && message.id === undefined && initializationSent) {
        initialized = true;
        return;
      }
      let result;
      let error;
      if (message.method === 'initialize' && !initializationSent) {
        initializationSent = true;
        const bridge = message.params?.capabilities?.experimental?.threadnoteProbeBridge;
        qualified = !enrolled && bridge?.version === 1 && bridge.nonce === nonce;
        if (qualified) enrolled = true;
        result = {
          capabilities: {
            renameProvider: false,
            executeCommandProvider: {commands: qualified ? ['probe.prepare', 'probe.apply'] : []},
          },
        };
      } else if (initialized && qualified && message.method === 'workspace/executeCommand') {
        if (message.params?.command === 'probe.prepare') result = {proposalId};
        else if (message.params?.command === 'probe.apply' && message.params.arguments?.[0] === proposalId)
          result = await candidate.apply();
        else error = {code: -32601, message: 'Unsupported fixture command'};
      } else error = {code: -32601, message: 'Guarded bridge required'};
      send(socket, {jsonrpc: '2.0', id: message.id, ...(error ? {error} : {result})});
    });
  });
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const connect = async () => {
      const socket = net.connect(server.address().port, '127.0.0.1');
      sockets.add(socket);
      const pending = new Map();
      let nextId = 0;
      const fail = error => {
        for (const item of pending.values()) {
          clearTimeout(item.timer);
          item.reject(error);
        }
        pending.clear();
      };
      socket.on('error', fail);
      socket.on('close', () => {
        sockets.delete(socket);
        fail(new Error('Fixture connection closed'));
      });
      receive(socket, message => {
        const item = pending.get(message.id);
        if (item) {
          clearTimeout(item.timer);
          pending.delete(message.id);
          item.resolve(message);
        }
      });
      await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
      const request = (method, params) =>
        new Promise((resolve, reject) => {
          const id = ++nextId;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('Fixture RPC deadline'));
          }, 2000);
          pending.set(id, {resolve, reject, timer});
          send(socket, {jsonrpc: '2.0', id, method, params});
        });
      request.notify = (method, params) => send(socket, {jsonrpc: '2.0', method, params});
      return request;
    };
    const generic = await connect();
    assert.ok((await generic('textDocument/rename', {})).error);
    const genericInit = await generic('initialize', {capabilities: {}, clientInfo: {name: 'generic 🧵'}});
    assert.equal(genericInit.result.capabilities.renameProvider, false);
    assert.deepEqual(genericInit.result.capabilities.executeCommandProvider.commands, []);
    generic.notify('initialized', {});
    assert.ok((await generic('textDocument/rename', {})).error);
    assert.ok((await generic('workspace/executeCommand', {command: 'probe.prepare'})).error);
    const forged = await connect();
    const forgedInit = await forged('initialize', {
      capabilities: {experimental: {threadnoteProbeBridge: {version: 1, nonce: 'wrong'}}},
    });
    assert.deepEqual(forgedInit.result.capabilities.executeCommandProvider.commands, []);
    forged.notify('initialized', {});
    const qualified = await connect();
    const qualifiedInit = await qualified('initialize', {
      capabilities: {experimental: {threadnoteProbeBridge: {version: 1, nonce}}},
    });
    assert.deepEqual(qualifiedInit.result.capabilities.executeCommandProvider.commands, [
      'probe.prepare',
      'probe.apply',
    ]);
    qualified.notify('initialized', {});
    const prepared = await qualified('workspace/executeCommand', {command: 'probe.prepare'});
    assert.deepEqual(prepared.result, {proposalId});
    assert.ok((await generic('workspace/executeCommand', {command: 'probe.apply', arguments: [proposalId]})).error);
    assert.ok((await forged('workspace/executeCommand', {command: 'probe.apply', arguments: [proposalId]})).error);
    const first = await qualified('workspace/executeCommand', {command: 'probe.apply', arguments: [proposalId]});
    assert.deepEqual(first.result, {status: 'applied', applied: [0, 1, 2]});
    const retry = await qualified('workspace/executeCommand', {command: 'probe.apply', arguments: [proposalId]});
    assert.deepEqual(retry.result, first.result);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
};
