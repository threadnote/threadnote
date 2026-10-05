import * as fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  runMcpBroker,
  type McpBrokerChild,
  type McpBrokerDependencies,
  type McpBrokerFailureEvent,
} from '@threadnote/threadnote/mcp/broker';
import type {StandaloneActiveRelease} from '@threadnote/threadnote/process/standalone_lease';

describe('MCP session broker', () => {
  it('reports missing activation without dispatching any request or changing its id', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.integer(), fc.string({maxLength: 40})), async id => {
        const clientInput = new AsyncByteQueue();
        const clientOutput = new AsyncByteQueue();
        let spawned = 0;
        const running = runMcpBroker({
          input: clientInput,
          readActiveRelease: async () => undefined,
          spawn: () => {
            spawned += 1;
            throw new Error('Unexpected spawn');
          },
          writeOutput: async line => clientOutput.pushLine(line),
        });
        clientInput.pushLine(
          JSON.stringify({id, jsonrpc: '2.0', method: 'tools/call', params: {name: 'remember_context'}}),
        );
        const failure = JSON.parse(await clientOutput.nextLine());
        clientInput.end();
        await running;
        expect(failure).toMatchObject({
          id,
          error: {code: -32_603, data: {reason: 'no-active-release', requestDisposition: 'not-dispatched'}},
        });
        expect(failure.error.message).toContain('threadnote install --no-start');
        expect(failure.error.message).not.toContain('write may have committed');
        expect(spawned).toBe(0);
        expect(clientOutput.availableLines()).toBe(0);
      }),
      {numRuns: 50},
    );
  });

  it('recovers on the same transport after activation without replaying rejected work', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    let active: StandaloneActiveRelease | undefined;
    const child = new FakeMcpChild('activated');
    const running = runMcpBroker({
      input: clientInput,
      readActiveRelease: async () => active,
      spawn: () => child,
      writeOutput: async line => clientOutput.pushLine(line),
    });
    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    expect(JSON.parse(await clientOutput.nextLine()).error.data.reason).toBe('no-active-release');
    active = {releaseRoot: '/threadnote/versions/activated', version: 'activated'};
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'initialize', params: {}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
      id: 2,
      result: {serverInfo: {version: 'activated'}},
    });
    active = undefined;
    clientInput.pushLine(JSON.stringify({id: 3, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({id: 3, result: {version: 'activated'}});
    expect(child.received.map(line => JSON.parse(line).id)).toEqual([2, 3]);
    clientInput.end();
    await running;
  });

  it('keeps an outstanding mutation uncertain when a later request fails before dispatch', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/private-release', version: 'private-version'};
    const child = new FakeMcpChild(release.version, {respondToTools: false});
    let failRead = false;
    const running = runMcpBroker({
      input: clientInput,
      readActiveRelease: async () => {
        if (failRead) throw new Error('Private lookup failure /Users/private/token');
        return release;
      },
      spawn: () => child,
      writeOutput: async line => clientOutput.pushLine(line),
    });
    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(
      JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'remember_context'}}),
    );
    await child.receivedCount(2);
    failRead = true;
    clientInput.pushLine(JSON.stringify({id: 3, jsonrpc: '2.0', method: 'tools/list'}));
    const mutation = JSON.parse(await clientOutput.nextLine());
    const lookup = JSON.parse(await clientOutput.nextLine());
    clientInput.end();
    await running;
    expect(mutation).toMatchObject({
      id: 2,
      error: {
        code: -32_080,
        data: {reason: 'runtime-interrupted', requestDisposition: 'dispatched-or-uncertain', writeOutcome: 'unknown'},
        message: expect.stringContaining('Read the canonical record'),
      },
    });
    expect(lookup).toMatchObject({
      id: 3,
      error: {data: {reason: 'startup-failed', requestDisposition: 'not-dispatched'}},
    });
    expect(JSON.stringify(lookup)).not.toContain('private');
    expect(child.received).toHaveLength(2);
  });

  it('identifies a confirmed runtime replacement without replaying an in-flight write', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const oldRelease = {releaseRoot: '/threadnote/versions/old', version: 'old'};
    const newRelease = {releaseRoot: '/threadnote/versions/new', version: 'new'};
    let active = oldRelease;
    const child = new FakeMcpChild(oldRelease.version, {respondToTools: false});
    let spawnCount = 0;
    const running = runMcpBroker({
      input: clientInput,
      readActiveRelease: async () => active,
      spawn: () => {
        spawnCount += 1;
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });
    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(
      JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'remember_context'}}),
    );
    await child.receivedCount(2);
    active = newRelease;
    child.exitUnexpectedly();

    const failure = JSON.parse(await clientOutput.nextLine());
    expect(failure).toMatchObject({
      id: 2,
      error: {
        code: -32_080,
        data: {
          reason: 'runtime-replaced',
          requestDisposition: 'dispatched-or-uncertain',
          writeOutcome: 'unknown',
        },
        message: expect.stringContaining('old runtime'),
      },
    });
    expect(spawnCount).toBe(1);
    clientInput.end();
    await running;
  });

  it('identifies a replacement when the old runtime closes during the child write', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const oldRelease = {releaseRoot: '/threadnote/versions/old', version: 'old'};
    const newRelease = {releaseRoot: '/threadnote/versions/new', version: 'new'};
    let active = oldRelease;
    const child = new FakeMcpChild(oldRelease.version, {
      exitBeforeFirstToolWrite: true,
      onFailedToolWrite: () => {
        active = newRelease;
      },
    });
    const running = runMcpBroker({
      input: clientInput,
      readActiveRelease: async () => active,
      spawn: () => child,
      writeOutput: async line => clientOutput.pushLine(line),
    });
    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(
      JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'remember_context'}}),
    );
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
      id: 2,
      error: {code: -32_080, data: {reason: 'runtime-replaced', writeOutcome: 'unknown'}},
    });
    clientInput.end();
    await running;
  });

  it('reports a closed spawn failure without allowing the observer to alter recovery', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/private-release', version: 'private-version'};
    const failures: McpBrokerFailureEvent[] = [];
    const running = runMcpBroker({
      input: clientInput,
      onFailure: event => {
        failures.push(event);
        throw new Error('private observer failure');
      },
      readActiveRelease: async () => release,
      spawn: () => {
        throw new Error('private spawn failure');
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    const failure = JSON.parse(await clientOutput.nextLine());
    expect(failure).toMatchObject({
      error: {code: -32_603, data: {reason: 'startup-failed', requestDisposition: 'not-dispatched'}},
      id: 1,
    });
    expect(JSON.stringify(failure)).not.toContain('private');
    clientInput.end();
    await running;

    expect(failures).toEqual([{area: 'child', reason: 'spawn'}]);
  });

  it('promotes the runtime at a request boundary without closing or reinitializing the client transport', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const releases = {
      first: {releaseRoot: '/threadnote/versions/4.2.2-a', version: '4.2.2-a'},
      second: {releaseRoot: '/threadnote/versions/4.2.2-b', version: '4.2.2-b'},
    } satisfies Record<string, StandaloneActiveRelease>;
    let active = releases.first;
    const spawned: FakeMcpChild[] = [];
    const failures: McpBrokerFailureEvent[] = [];
    const dependencies: McpBrokerDependencies = {
      input: clientInput,
      onFailure: event => failures.push(event),
      readActiveRelease: async () => active,
      replayTimeoutMilliseconds: 5,
      spawn: release => {
        const child = new FakeMcpChild(release.version);
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    };
    const running = runMcpBroker(dependencies);

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    expect(await clientOutput.nextLine()).toContain('4.2.2-a');
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(await clientOutput.nextLine()).toContain('4.2.2-a');

    active = releases.second;
    clientInput.pushLine(JSON.stringify({id: 3, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(await clientOutput.nextLine()).toContain('4.2.2-b');
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.received.map(line => JSON.parse(line).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(clientOutput.availableLines()).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(failures).toEqual([]);

    clientInput.end();
    await running;
  });

  it('does not replay a pending tool request when its child exits with an unknown outcome', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
    const spawned: FakeMcpChild[] = [];
    const failures: McpBrokerFailureEvent[] = [];
    const running = runMcpBroker({
      input: clientInput,
      onFailure: event => failures.push(event),
      readActiveRelease: async () => release,
      spawn: () => {
        const child = new FakeMcpChild(release.version, {respondToTools: false});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    clientInput.pushLine(
      JSON.stringify({id: 'mutation-1', jsonrpc: '2.0', method: 'tools/call', params: {name: 'remember_context'}}),
    );
    await spawned[0].receivedCount(3);
    spawned[0].exitUnexpectedly();

    const failure = JSON.parse(await clientOutput.nextLine()) as {
      readonly error: {readonly message: string};
      readonly id: string;
    };
    expect(failure.id).toBe('mutation-1');
    expect(failure.error.message).toContain('Read the canonical record');
    expect(spawned).toHaveLength(1);
    expect(failures).toEqual([{area: 'child', reason: 'exit'}]);

    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    const replacement = await waitForSpawnedChild(spawned, 1);
    await replacement.receivedCount(3);
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(replacement.received.map(line => JSON.parse(line).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);

    clientInput.end();
    await running;
  });

  it('retries a rejected initialization exactly once on a replacement runtime', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      input: clientInput,
      readActiveRelease: async () => release,
      spawn: () => {
        const child = new FakeMcpChild(release.version, {rejectInitialize: spawned.length === 0});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    expect(await clientOutput.nextLine()).toContain('initialization rejected');
    spawned[0].exitUnexpectedly();
    await new Promise(resolve => setTimeout(resolve, 1));
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'initialize', params: {}}));
    expect(await clientOutput.nextLine()).toContain('4.2.2');

    const replacement = await waitForSpawnedChild(spawned, 1);
    expect(replacement.received.map(line => JSON.parse(line).method)).toEqual(['initialize']);

    clientInput.end();
    await running;
  });

  it('promotes after a cancelled request without replaying the cancelled work', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const releases = {
      first: {releaseRoot: '/threadnote/versions/4.2.2-a', version: '4.2.2-a'},
      second: {releaseRoot: '/threadnote/versions/4.2.2-b', version: '4.2.2-b'},
    } satisfies Record<string, StandaloneActiveRelease>;
    let active = releases.first;
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      input: clientInput,
      readActiveRelease: async () => active,
      spawn: release => {
        const child = new FakeMcpChild(release.version, {respondToTools: spawned.length > 0});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    await spawned[0].receivedCount(3);

    active = releases.second;
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 2}}));
    clientInput.pushLine(JSON.stringify({id: 3, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(await clientOutput.nextLine()).toContain('4.2.2-b');

    expect(spawned[0].received.map(line => JSON.parse(line).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'notifications/cancelled',
    ]);
    expect(spawned[1].received.map(line => JSON.parse(line).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);

    clientInput.end();
    await running;
  });

  it('contains a child exit between admission and write and serves the next request on the same transport', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
    const spawned: FakeMcpChild[] = [];
    const failures: McpBrokerFailureEvent[] = [];
    const running = runMcpBroker({
      input: clientInput,
      onFailure: event => failures.push(event),
      readActiveRelease: async () => release,
      spawn: () => {
        const child = new FakeMcpChild(release.version, {exitBeforeFirstToolWrite: spawned.length === 0});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({error: {code: -32_080}, id: 2});
    expect(failures).toContainEqual({area: 'child', reason: 'write'});

    clientInput.pushLine(JSON.stringify({id: 3, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(await clientOutput.nextLine()).toContain('4.2.2');
    expect(spawned).toHaveLength(2);

    clientInput.end();
    await running;
  });

  it('contains a promoted initialization rejection and retries on the next request', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const releases = {
      first: {releaseRoot: '/threadnote/versions/4.2.2-a', version: '4.2.2-a'},
      second: {releaseRoot: '/threadnote/versions/4.2.2-b', version: '4.2.2-b'},
    } satisfies Record<string, StandaloneActiveRelease>;
    let active = releases.first;
    const spawned: FakeMcpChild[] = [];
    const failures: McpBrokerFailureEvent[] = [];
    const running = runMcpBroker({
      input: clientInput,
      onFailure: event => failures.push(event),
      readActiveRelease: async () => active,
      spawn: release => {
        const child = new FakeMcpChild(release.version, {rejectInitialize: spawned.length === 1});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    await spawned[0].receivedCount(2);
    active = releases.second;
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({error: {code: -32_603}, id: 2});
    expect(failures).toEqual([{area: 'promotion', reason: 'protocol'}]);

    clientInput.pushLine(JSON.stringify({id: 3, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(await clientOutput.nextLine()).toContain('4.2.2-b');
    expect(spawned).toHaveLength(3);

    clientInput.end();
    await running;
  });

  it('contains a promoted initialization timeout and retries on the next request', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const releases = {
      first: {releaseRoot: '/threadnote/versions/4.2.2-a', version: '4.2.2-a'},
      second: {releaseRoot: '/threadnote/versions/4.2.2-b', version: '4.2.2-b'},
    } satisfies Record<string, StandaloneActiveRelease>;
    let active = releases.first;
    const spawned: FakeMcpChild[] = [];
    const failures: McpBrokerFailureEvent[] = [];
    const running = runMcpBroker({
      input: clientInput,
      onFailure: event => failures.push(event),
      readActiveRelease: async () => active,
      replayTimeoutMilliseconds: 1,
      spawn: release => {
        const child = new FakeMcpChild(release.version, {ignoreInitialize: spawned.length === 1});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    await spawned[0].receivedCount(2);
    active = releases.second;
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({error: {code: -32_603}, id: 2});
    expect(failures).toEqual([{area: 'promotion', reason: 'timeout'}]);

    clientInput.pushLine(JSON.stringify({id: 3, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(await clientOutput.nextLine()).toContain('4.2.2-b');
    expect(spawned).toHaveLength(3);

    clientInput.end();
    await running;
  });

  it('rewrites server request ids and drops an old-generation late response', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const releases = {
      first: {releaseRoot: '/threadnote/versions/4.2.2-a', version: '4.2.2-a'},
      second: {releaseRoot: '/threadnote/versions/4.2.2-b', version: '4.2.2-b'},
    } satisfies Record<string, StandaloneActiveRelease>;
    let active = releases.first;
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      input: clientInput,
      readActiveRelease: async () => active,
      spawn: release => {
        const child = new FakeMcpChild(release.version);
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    spawned[0].emitServerRequest(7);
    const oldExternalId = (JSON.parse(await clientOutput.nextLine()) as {id: string}).id;
    expect(oldExternalId).not.toBe('7');
    spawned[0].exitUnexpectedly();
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
      method: 'notifications/cancelled',
      params: {requestId: oldExternalId},
    });

    clientInput.pushLine(JSON.stringify({id: oldExternalId, jsonrpc: '2.0', result: {late: true}}));
    active = releases.second;
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    await clientOutput.nextLine();
    spawned[1].emitServerRequest(7);
    const newExternalId = (JSON.parse(await clientOutput.nextLine()) as {id: string}).id;
    expect(newExternalId).not.toBe(oldExternalId);

    clientInput.pushLine(JSON.stringify({id: oldExternalId, jsonrpc: '2.0', result: {late: true}}));
    clientInput.pushLine(JSON.stringify({id: newExternalId, jsonrpc: '2.0', result: {accepted: true}}));
    await spawned[1].receivedCount(4);
    expect(JSON.parse(spawned[1].received[3])).toEqual({id: 7, jsonrpc: '2.0', result: {accepted: true}});

    clientInput.end();
    await running;
  });

  it('retires a server request when the runtime cancels it so promotion can proceed', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const releases = {
      first: {releaseRoot: '/threadnote/versions/4.2.2-a', version: '4.2.2-a'},
      second: {releaseRoot: '/threadnote/versions/4.2.2-b', version: '4.2.2-b'},
    } satisfies Record<string, StandaloneActiveRelease>;
    let active = releases.first;
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      input: clientInput,
      readActiveRelease: async () => active,
      spawn: release => {
        const child = new FakeMcpChild(release.version);
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    spawned[0].emitServerRequest('sample');
    const externalId = (JSON.parse(await clientOutput.nextLine()) as {id: string}).id;
    spawned[0].emitServerCancellation('sample');
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
      method: 'notifications/cancelled',
      params: {requestId: externalId},
    });

    active = releases.second;
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/tools/list_changed'});
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({method: 'notifications/resources/list_changed'});
    expect(await clientOutput.nextLine()).toContain('4.2.2-b');

    clientInput.end();
    await running;
  });

  it('cancels a host-side server request when its runtime exits', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      input: clientInput,
      readActiveRelease: async () => release,
      spawn: () => {
        const child = new FakeMcpChild(release.version);
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    spawned[0].emitServerRequest(7);
    const externalId = (JSON.parse(await clientOutput.nextLine()) as {id: string}).id;
    spawned[0].exitUnexpectedly();
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
      method: 'notifications/cancelled',
      params: {requestId: externalId},
    });

    clientInput.end();
    await running;
  });

  it('cancels outstanding server requests when a child write fails', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      input: clientInput,
      readActiveRelease: async () => release,
      spawn: () => {
        const child = new FakeMcpChild(release.version, {exitBeforeFirstToolWrite: true});
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    await clientOutput.nextLine();
    clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
    spawned[0].emitServerRequest('sample');
    const externalId = (JSON.parse(await clientOutput.nextLine()) as {id: string}).id;
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
      method: 'notifications/cancelled',
      params: {requestId: externalId},
    });
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({error: {code: -32_080}, id: 2});

    clientInput.end();
    await running;
  });

  it('keeps an in-flight tool result when a progress write to the client fails', async () => {
    await expectInFlightToolResultAfterDroppedProgress(1);
  });

  it('does not fail in-flight requests for any number of dropped progress frames while the runtime stays up', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({min: 1, max: 8}), async progressFrames => {
        await expectInFlightToolResultAfterDroppedProgress(progressFrames);
      }),
      {numRuns: 15},
    );
  });

  it('drops non-JSON child stdout lines instead of forwarding them to the client', async () => {
    const clientInput = new AsyncByteQueue();
    const clientOutput = new AsyncByteQueue();
    const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
    const spawned: FakeMcpChild[] = [];
    const running = runMcpBroker({
      input: clientInput,
      readActiveRelease: async () => release,
      spawn: release => {
        const child = new FakeMcpChild(release.version);
        spawned.push(child);
        return child;
      },
      writeOutput: async line => clientOutput.pushLine(line),
    });

    clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
      id: 1,
      result: {serverInfo: {version: '4.2.2'}},
    });
    const child = await waitForSpawnedChild(spawned, 0);
    // A pretty-logger warning that escaped to the child's stdout must never
    // reach the client: Cursor fails the transport on the first non-JSON
    // line ("Expected ',' or ']' after array element in JSON at position 3"
    // for a "[14:26:..." prefix).
    child.emitRawLine(
      '[14:26:54.868] WARN (#755): Code graph background refresh deferred (unknown; recovery: diagnose).',
    );
    clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
    expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
      id: 2,
      result: {version: '4.2.2'},
    });
    expect(clientOutput.availableLines()).toBe(0);

    clientInput.end();
    await running;
  });

  it('only forwards JSON-parseable child lines to the client', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.constant(
              '[14:26:54.868] WARN (#755): Code graph background refresh deferred (unknown; recovery: diagnose).',
            ),
            fc.string({maxLength: 120}).filter(isNonJsonLine),
          ),
          {maxLength: 10},
        ),
        async rawLines => {
          const clientInput = new AsyncByteQueue();
          const clientOutput = new AsyncByteQueue();
          const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
          const spawned: FakeMcpChild[] = [];
          const running = runMcpBroker({
            input: clientInput,
            readActiveRelease: async () => release,
            spawn: release => {
              const child = new FakeMcpChild(release.version);
              spawned.push(child);
              return child;
            },
            writeOutput: async line => clientOutput.pushLine(line),
          });

          clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
          expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
            id: 1,
            result: {serverInfo: {version: '4.2.2'}},
          });
          const child = await waitForSpawnedChild(spawned, 0);
          for (const line of rawLines) child.emitRawLine(line);
          clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
          for (;;) {
            // Must never throw: every line the broker forwards parses as JSON.
            const parsed = JSON.parse(await clientOutput.nextLine()) as {readonly id?: unknown};
            if (parsed.id === 2) break;
          }

          clientInput.end();
          await running;
        },
      ),
      {numRuns: 20},
    );
  });
});

async function expectInFlightToolResultAfterDroppedProgress(progressFrames: number): Promise<void> {
  const clientInput = new AsyncByteQueue();
  const clientOutput = new AsyncByteQueue();
  const release = {releaseRoot: '/threadnote/versions/4.2.2', version: '4.2.2'};
  const spawned: FakeMcpChild[] = [];
  const failures: McpBrokerFailureEvent[] = [];
  const running = runMcpBroker({
    input: clientInput,
    onFailure: event => failures.push(event),
    readActiveRelease: async () => release,
    spawn: () => {
      const child = new FakeMcpChild(release.version, {progressFramesBeforeToolResult: progressFrames});
      spawned.push(child);
      return child;
    },
    writeOutput: async line => {
      const envelope = JSON.parse(line) as {readonly method?: string};
      if (envelope.method === 'notifications/progress') {
        throw Object.assign(new Error('temporary client write failure'), {code: 'EAGAIN'});
      }
      clientOutput.pushLine(line);
    },
  });

  clientInput.pushLine(JSON.stringify({id: 1, jsonrpc: '2.0', method: 'initialize', params: {}}));
  expect(JSON.parse(await clientOutput.nextLine())).toMatchObject({
    result: {serverInfo: {version: '4.2.2'}},
  });
  clientInput.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}));
  clientInput.pushLine(JSON.stringify({id: 2, jsonrpc: '2.0', method: 'tools/call', params: {name: 'health'}}));
  expect(JSON.parse(await clientOutput.nextLine())).toEqual({
    id: 2,
    jsonrpc: '2.0',
    result: {version: '4.2.2'},
  });
  expect(spawned).toHaveLength(1);
  expect(failures).toEqual([]);

  clientInput.end();
  await running;
}

class FakeMcpChild implements McpBrokerChild {
  readonly #output = new AsyncByteQueue();
  readonly #resolveExit: (code: number) => void;
  readonly exited: Promise<number>;
  readonly input;
  readonly output = this.#output;
  readonly processId = 1;
  readonly received: string[] = [];
  readonly #receivedWaiters: Array<() => void> = [];
  #ended = false;

  constructor(
    readonly version: string,
    readonly options: {
      readonly exitBeforeFirstToolWrite?: boolean;
      readonly ignoreInitialize?: boolean;
      readonly onFailedToolWrite?: () => void;
      readonly progressFramesBeforeToolResult?: number;
      readonly rejectInitialize?: boolean;
      readonly respondToTools?: boolean;
    } = {},
  ) {
    let resolveExit: (code: number) => void = () => undefined;
    this.exited = new Promise<number>(resolve => {
      resolveExit = resolve;
    });
    this.#resolveExit = resolveExit;
    this.input = {
      end: () => this.#end(),
      flush: async () => undefined,
      write: (value: string) => {
        for (const line of value.trimEnd().split('\n')) this.#handle(line);
        return value.length;
      },
    };
  }

  kill(): void {
    this.#end();
  }

  exitUnexpectedly(): void {
    this.#end();
  }

  async receivedCount(count: number): Promise<void> {
    while (this.received.length < count) {
      await new Promise<void>(resolve => this.#receivedWaiters.push(resolve));
    }
  }

  emitServerCancellation(requestId: string | number): void {
    this.#output.pushLine(JSON.stringify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId}}));
  }

  emitServerRequest(id: string | number): void {
    this.#output.pushLine(JSON.stringify({id, jsonrpc: '2.0', method: 'sampling/createMessage', params: {}}));
  }

  emitRawLine(line: string): void {
    this.#output.pushLine(line);
  }

  #handle(line: string): void {
    if (this.#ended) throw new Error('Child input is closed.');
    this.received.push(line);
    for (const resolve of this.#receivedWaiters.splice(0)) resolve();
    const envelope = JSON.parse(line) as {readonly id?: string | number; readonly method?: string};
    if (envelope.method === 'initialize') {
      if (this.options.ignoreInitialize) return;
      this.#output.pushLine(
        this.options.rejectInitialize
          ? JSON.stringify({
              error: {code: -32_602, message: 'initialization rejected'},
              id: envelope.id,
              jsonrpc: '2.0',
            })
          : JSON.stringify({
              id: envelope.id,
              jsonrpc: '2.0',
              result: {protocolVersion: '2025-11-25', serverInfo: {name: 'threadnote', version: this.version}},
            }),
      );
    } else if (envelope.method === 'tools/call' && this.options.exitBeforeFirstToolWrite) {
      this.options.onFailedToolWrite?.();
      this.#end();
      throw new Error('Child exited before accepting the request.');
    } else if (envelope.method === 'tools/call' && this.options.respondToTools !== false) {
      const progressFrames = this.options.progressFramesBeforeToolResult ?? 0;
      for (let index = 0; index < progressFrames; index += 1) {
        this.#output.pushLine(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: {progress: index + 1, progressToken: envelope.id},
          }),
        );
      }
      this.#output.pushLine(JSON.stringify({id: envelope.id, jsonrpc: '2.0', result: {version: this.version}}));
    }
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#output.end();
    this.#resolveExit(0);
  }
}

function isNonJsonLine(line: string): boolean {
  if (line.length === 0) return false;
  try {
    JSON.parse(line);
    return false;
  } catch {
    return true;
  }
}

async function waitForSpawnedChild(children: readonly FakeMcpChild[], index: number): Promise<FakeMcpChild> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const child = children[index];
    if (child !== undefined) return child;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`MCP broker did not spawn child ${index}.`);
}

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  readonly #queued: Array<IteratorResult<Uint8Array>> = [];
  readonly #waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  #ended = false;

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {next: () => this.#next()};
  }

  availableLines(): number {
    return this.#queued.filter(entry => !entry.done).length;
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#deliver({done: true, value: undefined});
  }

  async nextLine(): Promise<string> {
    const next = await this.#next();
    if (next.done) throw new Error('Queue ended before a line was available.');
    return new TextDecoder().decode(next.value).trimEnd();
  }

  pushLine(line: string): void {
    if (this.#ended) throw new Error('Cannot write to an ended queue.');
    this.#deliver({done: false, value: new TextEncoder().encode(`${line}\n`)});
  }

  #deliver(value: IteratorResult<Uint8Array>): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(value);
    else this.#queued.push(value);
  }

  #next(): Promise<IteratorResult<Uint8Array>> {
    const queued = this.#queued.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#ended) return Promise.resolve({done: true, value: undefined});
    return new Promise(resolve => this.#waiters.push(resolve));
  }
}
