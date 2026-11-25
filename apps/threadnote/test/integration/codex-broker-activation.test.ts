import {Array as EffectArray, Option, Record as EffectRecord, String as EffectString} from 'effect';
import {execFile} from '@threadnote/testing/node-child-process';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  writeFile,
} from '@threadnote/testing/node-fs-promises';
import {basename, dirname, join, resolve} from '@threadnote/testing/node-path';
import {fileURLToPath} from '@threadnote/testing/node-url';

import {promisify} from '@threadnote/testing/node-util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {expect, it} from 'vitest';
import {isLive, parentProcessId, until, withRotationProbe} from '../fixtures/codex-broker-rotation.js';

const codex = process.env.THREADNOTE_CODEX_ROTATION_BINARY;
const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../../src/standalone.ts', import.meta.url));
const oldRelease = '6.4.1-dev.aaaaaaaaaaaa';
const newRelease = '6.4.1-dev.bbbbbbbbbbbb';

const publicationModule = fileURLToPath(new URL('../../src/mcp/codex_broker_activation.ts', import.meta.url));
// These are the same production stages used by the standalone installer, run
// in a separate process with the fixture's isolated installation environment.
const activateRelease = `
import {Console, Effect} from 'effect';
import {installCommandShim} from '@threadnote/threadnote/command-shim';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {activateStandaloneRelease, withStandaloneInstallationLock} from '@threadnote/threadnote/installations';
const [publicationModule, releaseRoot, release, home] = process.argv.slice(1);
const {reconcileActivatedCodexMcp} = await import(publicationModule);
await Effect.runPromise(Effect.gen(function* () {
  yield* withStandaloneInstallationLock(Effect.gen(function* () {
    yield* activateStandaloneRelease(releaseRoot, false);
    yield* installCommandShim(false, releaseRoot, home);
  }));
  const status = yield* reconcileActivatedCodexMcp({agentContextHome: home}, release);
  yield* Console.log(JSON.stringify(status));
}).pipe(Effect.provide(ApplicationLayer)));
`;

function shellQuote(value: string): string {
  return "'" + EffectString.replaceAll("'", "'\\''")(value) + "'";
}

async function physicalSocket(socket: string): Promise<string> {
  // Codex may expose a symlink. Discover the actual fixture socket and test
  // that the CLI still rejects a symlink supplied as the endpoint.
  const actual = (await lstat(socket)).isSymbolicLink() ? resolve(dirname(socket), await readlink(socket)) : socket;
  const physical = join(await realpath(dirname(actual)), basename(actual));
  expect((await lstat(physical)).isSocket()).toBe(true);
  return physical;
}

it.skipIf(!codex || process.platform === 'win32')(
  'activates a release with connected clients and requests an owner-bound Codex refresh through repair',
  async () => {
    if (!codex) return;
    await withRotationProbe(
      codex,
      async probe => {
        const target = await probe.profile('target');
        const other = await probe.profile('other');
        await Promise.all([target.config(undefined), other.config('foreign')]);
        const installRoot = join(probe.root, 'install');
        const toolHome = join(probe.root, 'threadnote');
        const bin = join(probe.root, 'bin');
        await mkdir(bin);
        await symlink(codex, join(bin, 'codex'));
        const env = {
          HOME: target.home,
          USERPROFILE: target.home,
          PATH: bin + ':' + (process.env.PATH ?? ''),
          CODEX_HOME: target.home,
          THREADNOTE_HOME: toolHome,
          THREADNOTE_BIN_DIR: bin,
          THREADNOTE_INSTALL_ROOT: installRoot,
          THREADNOTE_TELEMETRY: 'off',
          THREADNOTE_NO_UPDATE_CHECK: '1',
          DO_NOT_TRACK: '1',
        };
        const cli = (...args: string[]) =>
          execute(process.execPath, [entry, ...args], {cwd: target.cwd, env, timeout: 12000, maxBuffer: 1000000});
        const activate = async (release: string) => {
          const releaseRoot = join(installRoot, 'versions', release);
          await mkdir(releaseRoot, {recursive: true});
          await writeFile(join(releaseRoot, 'release.json'), JSON.stringify({version: release}));
          const shellEnv = {
            PATH: env.PATH,
            HOME: env.HOME,
            THREADNOTE_HOME: toolHome,
            THREADNOTE_INSTALL_ROOT: installRoot,
            THREADNOTE_TELEMETRY: 'off',
            THREADNOTE_NO_UPDATE_CHECK: '1',
          };
          await writeFile(
            join(releaseRoot, 'threadnote'),
            EffectArray.join(
              [
                '#!/bin/sh',
                ...EffectArray.map(
                  EffectRecord.toEntries(shellEnv),
                  ([key, value]) => `export ${key}=${shellQuote(value)}`,
                ),
                'if [ "$1" = mcp-server ]; then',
                `export PROBE_RELEASE=${shellQuote(release)}`,
                `exec ${shellQuote(process.execPath)} ${shellQuote(probe.mcpFixture)} ${shellQuote(target.home)} threadnote`,
                'fi',
                `exec ${shellQuote(process.execPath)} ${shellQuote(entry)} "$@"`,
                '',
              ],
              '\n',
            ),
            {mode: 0o700},
          );
          return execute(process.execPath, ['-e', activateRelease, publicationModule, releaseRoot, release, toolHome], {
            cwd: dirname(entry),
            env,
            timeout: 12000,
            maxBuffer: 1000000,
          });
        };

        await activate(oldRelease);
        await cli('mcp-install', 'codex', '--apply', '--no-dev-skills');
        const [owner, otherOwner] = await Promise.all([target.listen(), other.listen()]);
        expect(owner.pid).not.toBe(otherOwner.pid);
        expect((await stat(target.home)).mode & 0o777).toBe(0o700);
        const [desktop, otherDesktop] = await Promise.all([target.proxy(target.socket), other.proxy(other.socket)]);
        await Promise.all([desktop.initialize(), otherDesktop.initialize()]);
        const first = await desktop.start(target.cwd);
        const second = await desktop.start(target.cwd);
        const otherChat = await otherDesktop.start(other.cwd);
        const foreign = await otherDesktop.identity(otherDesktop.tool(otherChat, 'threadnote'));
        const unrelated = await desktop.identity(desktop.tool(first, 'unrelated'));

        const stdio = target.start('--stdio');
        await stdio.initialize();
        const retainedChat = await stdio.start(target.cwd, false);
        await stdio.turn(retainedChat);
        const initialStdio = await stdio.identity(stdio.tool(retainedChat, 'threadnote'));
        expect(initialStdio.release).toBe(oldRelease);
        const retainedBroker = parentProcessId(initialStdio.pid);
        await expect(target.proxy()).rejects.toThrow(/No such file or directory/);

        const generic = new Client({name: 'non-codex-client', version: '1'});
        const transport = new StdioClientTransport({command: join(bin, 'threadnote-mcp-server'), env, stderr: 'pipe'});
        let promotedPid: number | undefined;
        try {
          await generic.connect(transport);
          const genericBroker = transport.pid;
          expect(genericBroker).toBeGreaterThan(0);
          const threads = [first, second];
          const held = EffectArray.map(threads, (thread, index) => ({
            thread,
            token: `codex-${index}`,
            request: desktop.tool(thread, 'threadnote', `codex-${index}`),
          }));
          const genericCall = Promise.allSettled([generic.callTool({name: 'identity', arguments: {token: 'generic'}})]);
          const tokens = [...EffectArray.map(held, call => call.token), 'generic'];
          const oldPids = await Promise.all(
            EffectArray.map(tokens, token =>
              until(async () => {
                const entered = Option.getOrUndefined(
                  EffectArray.findFirst(
                    await target.events(),
                    event => event.event === 'entered' && event.token === token,
                  ),
                );
                return typeof entered?.pid === 'number' ? entered.pid : undefined;
              }, token),
            ),
          );
          expect(new Set(oldPids).size).toBe(3);

          const activation = await activate(newRelease);
          expect(activation.stdout).toContain('"configuration":"saved","refresh":"pending"');
          expect(await readFile(join(target.home, 'config.toml'), 'utf8')).toContain(newRelease);
          const endpoint = await physicalSocket(target.socket);
          const repair = (socket: string, thread = first) =>
            cli('repair', '--mcp', 'codex', '--codex-reload-socket', socket, '--codex-reload-thread', thread);
          const absent = await repair(join(target.home, 'absent.sock'));
          expect(absent.stdout + absent.stderr).toMatch(/pending/i);
          const redirected = join(target.home, 'redirect.sock');
          await symlink(endpoint, redirected);
          const unsafe = await repair(redirected);
          expect(unsafe.stdout + unsafe.stderr).toMatch(/physical Codex Unix socket/i);
          const incompatible = await target.serveIncompatibleProtocol();
          const unsupported = await repair(incompatible.endpoint);
          expect(unsupported.stdout + unsupported.stderr).toMatch(/supported Codex app-server protocol/i);
          await incompatible.witness();
          const wrong = await repair(await physicalSocket(other.socket), otherChat);
          expect(wrong.stdout + wrong.stderr).toMatch(
            /effective configuration does not match the registered Codex home/i,
          );
          expect(await otherDesktop.identity(otherDesktop.tool(otherChat, 'threadnote'))).toEqual(foreign);
          const refresh = await repair(endpoint);
          expect(refresh.stdout + refresh.stderr).toMatch(/reload accepted/i);
          expect(refresh.stdout + refresh.stderr).toMatch(/rotation remains unverified/i);
          const replacements = await Promise.all(
            EffectArray.map(threads, thread => desktop.identity(desktop.tool(thread, 'threadnote'))),
          );
          for (const [index, replacement] of replacements.entries()) {
            expect(replacement).toMatchObject({release: newRelease});
            expect(replacement.pid).not.toBe(oldPids[index]);
          }
          EffectArray.forEach(held, call => expect(desktop.count(call.request)).toBe(0));
          EffectArray.forEach(oldPids, pid => expect(isLive(pid)).toBe(true));

          await Promise.all(EffectArray.map(tokens, token => target.release(token)));
          for (const [index, call] of held.entries()) {
            expect(await desktop.identity(call.request)).toEqual({
              pid: oldPids[index],
              release: oldRelease,
              token: call.token,
            });
            expect(desktop.count(call.request)).toBe(1);
          }
          expect(await genericCall).toMatchObject([
            {
              status: 'fulfilled',
              value: {content: [{text: JSON.stringify({pid: oldPids[2], release: oldRelease, token: 'generic'})}]},
            },
          ]);
          await target.release('generic-promoted');
          const promoted = await generic.callTool({name: 'identity', arguments: {token: 'generic-promoted'}});
          expect(promoted).toMatchObject({content: [{text: expect.stringContaining(newRelease)}]});
          const entered = Option.getOrUndefined(
            EffectArray.findFirst(
              await target.events(),
              event => event.event === 'entered' && event.token === 'generic-promoted',
            ),
          );
          if (typeof entered?.pid !== 'number') throw new Error('Missing the promoted generic child identity');
          promotedPid = entered.pid;
          expect(transport.pid).toBe(genericBroker);
          for (const [index, pid] of oldPids.entries()) {
            await until(async () => !isLive(pid) || undefined, `retired child ${index}`);
          }
          expect(await desktop.identity(desktop.tool(first, 'unrelated'))).toEqual(unrelated);
          // The stdio-only session remains on its original broker even after the
          // reachable owner refreshes. Its broker can still promote an idle child.
          const retained = await stdio.identity(stdio.tool(retainedChat, 'threadnote'));
          expect(parentProcessId(retained.pid)).toBe(retainedBroker);
          expect(isLive(retainedBroker)).toBe(true);
          expect(await stdio.closeInput()).toBe(0);
          await until(
            async () => (!isLive(retainedBroker) && !isLive(retained.pid) && !isLive(initialStdio.pid)) || undefined,
            'stdio owner EOF to retire the original broker and children',
          );

          const restarted = target.start('--stdio');
          await restarted.initialize();
          expect(await restarted.resume(retainedChat)).toBe(retainedChat);
          const recovered = await restarted.identity(restarted.tool(retainedChat, 'threadnote'));
          expect(recovered.release).toBe(newRelease);
          const restartedBroker = parentProcessId(recovered.pid);
          expect(restartedBroker).not.toBe(retainedBroker);
          expect(await restarted.closeInput()).toBe(0);
          await until(
            async () => (!isLive(restartedBroker) && !isLive(recovered.pid)) || undefined,
            'restarted stdio owner EOF to retire the new broker and child',
          );

          const events = await target.events();
          for (const token of tokens) {
            expect(
              EffectArray.map(
                EffectArray.filter(events, event => event.token === token),
                event => event.event,
              ),
            ).toEqual(['entered', 'returned']);
          }
        } finally {
          const pid = transport.pid;
          await generic.close();
          if (pid) await until(async () => !isLive(pid) || undefined, 'generic broker EOF');
          const childPid = promotedPid;
          if (childPid) await until(async () => !isLive(childPid) || undefined, 'generic broker child EOF');
        }
        // Keep the Unix socket paths short enough for the operating system.
      },
      process.platform === 'darwin' ? '/tmp' : undefined,
    );
  },
  60000,
);
