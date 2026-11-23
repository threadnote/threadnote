import {Array as EffectArray, Option} from 'effect';
import {expect, it} from 'vitest';
import {isLive, until, withRotationProbe} from '../fixtures/codex-broker-rotation.js';

// Set this to the absolute path of an installed Codex binary with `app-server proxy` support.
const codex = process.env.THREADNOTE_CODEX_ROTATION_BINARY;
const smoke = it.skipIf(!codex);

smoke(
  'reloads the same two loaded chats through an independent Unix-socket peer',
  async () => {
    if (!codex) return;
    await withRotationProbe(codex, async probe => {
      const target = await probe.profile('target');
      const other = await probe.profile('other');
      await Promise.all([target.config('old'), other.config('other')]);
      const [owner, otherOwner] = await Promise.all([target.listen(), other.listen()]);
      expect(owner.pid).not.toBe(otherOwner.pid);
      const [desktop, installer, otherDesktop, wrongEndpoint] = await Promise.all([
        target.proxy(target.socket),
        target.proxy(target.socket),
        other.proxy(other.socket),
        target.proxy(other.socket),
      ]);
      await Promise.all([
        desktop.initialize(),
        installer.initialize(),
        otherDesktop.initialize(),
        wrongEndpoint.initialize(),
      ]);
      const first = await desktop.start(target.cwd);
      const second = await desktop.start(target.cwd);
      const unrelatedThread = await otherDesktop.start(other.cwd);
      expect((await installer.rpc('thread/loaded/list', {})).data).toEqual(expect.arrayContaining([first, second]));
      expect((await wrongEndpoint.rpc('thread/loaded/list', {})).data).toEqual([unrelatedThread]);
      const foreign = await otherDesktop.identity(otherDesktop.tool(unrelatedThread, 'threadnote'));
      const calls = EffectArray.map(
        [
          {thread: first, server: 'threadnote', token: 'first'},
          {thread: second, server: 'threadnote', token: 'second'},
          {thread: first, server: 'unrelated', token: 'unrelated'},
        ],
        call => ({...call, id: desktop.tool(call.thread, call.server, call.token)}),
      );
      const oldPids = await Promise.all(
        EffectArray.map(calls, call =>
          until(async () => {
            const entered = Option.getOrUndefined(
              EffectArray.findFirst(
                await target.events(),
                event => event.event === 'entered' && event.token === call.token,
              ),
            );
            return typeof entered?.pid === 'number' ? entered.pid : undefined;
          }, call.token),
        ),
      );
      expect(new Set(oldPids).size).toBe(3);

      await target.config('new');
      expect(await installer.rpc('config/mcpServer/reload')).toEqual({});
      const replacements = await Promise.all([
        desktop.identity(desktop.tool(first, 'threadnote')),
        desktop.identity(desktop.tool(second, 'threadnote')),
      ]);
      for (const [index, replacement] of replacements.entries()) {
        expect(replacement.release).toBe('new');
        expect(replacement.pid).not.toBe(oldPids[index]);
        expect(isLive(replacement.pid)).toBe(true);
      }
      EffectArray.forEach(calls, (call, index) => {
        expect(desktop.count(call.id)).toBe(0);
        expect(isLive(oldPids[index])).toBe(true);
      });
      await Promise.all(EffectArray.map(calls, call => target.release(call.token)));
      await Promise.all(
        EffectArray.map(calls, async (call, index) => {
          expect(await desktop.identity(call.id)).toEqual({
            token: call.token,
            pid: oldPids[index],
            release: call.server === 'threadnote' ? 'old' : 'unrelated',
          });
          expect(await desktop.catalog(call.thread, call.server)).toEqual(['identity']);
        }),
      );

      for (const [index, call] of calls.entries()) {
        const identity = await desktop.identity(desktop.tool(call.thread, call.server));
        if (call.server === 'threadnote') {
          expect(identity).toEqual(replacements[index]);
          await until(async () => !isLive(oldPids[index]) || undefined, 'retired fixture process');
        } else {
          expect(identity).toMatchObject({pid: oldPids[index], release: 'unrelated'});
        }
        expect(isLive(identity.pid)).toBe(true);
        expect(desktop.count(call.id)).toBe(1);
        const events = EffectArray.filter(await target.events(), event => event.token === call.token);
        expect(EffectArray.map(events, event => event.event)).toEqual(['entered', 'returned']);
      }
      expect(await otherDesktop.identity(otherDesktop.tool(unrelatedThread, 'threadnote'))).toEqual(foreign);
    });
  },
  30000,
);

smoke(
  'keeps a stdio owner pending and preserves its connection in the individual controls',
  async () => {
    if (!codex) return;
    await withRotationProbe(codex, async probe => {
      const profile = await probe.profile('desktop');
      await profile.config('old');
      const desktop = profile.start('--stdio');
      await desktop.initialize();
      const thread = await desktop.start(profile.cwd);
      const old = await desktop.identity(desktop.tool(thread, 'threadnote'));
      // An unexpectedly reachable default endpoint has no ownership proof. Send no RPC to it.
      await expect(profile.proxy()).rejects.toThrow(/No such file or directory/);
      const incompatible = await profile.serveIncompatibleProtocol();
      await expect(profile.proxy(incompatible.endpoint)).rejects.toThrow(/Unavailable WebSocket control channel/);
      await incompatible.witness();
      await desktop.rpc('config/mcpServer/reload');
      await desktop.turn(thread);
      expect(await desktop.identity(desktop.tool(thread, 'threadnote'))).toEqual(old);

      await profile.config('new', 'pending-unrelated-edit');
      await desktop.turn(thread);
      expect(await desktop.identity(desktop.tool(thread, 'threadnote'))).toEqual(old);
      const unrelated = await desktop.identity(desktop.tool(thread, 'unrelated'));
      expect(unrelated.release).toBe('unrelated');
      expect(isLive(old.pid)).toBe(true);

      // A host-owned reload also reads pending edits to other MCP entries.
      await desktop.rpc('config/mcpServer/reload');
      const refreshed = await desktop.identity(desktop.tool(thread, 'threadnote'));
      const refreshedUnrelated = await desktop.identity(desktop.tool(thread, 'unrelated'));
      expect(refreshed).toMatchObject({release: 'new'});
      expect(refreshed.pid).not.toBe(old.pid);
      expect(refreshedUnrelated).toMatchObject({release: 'pending-unrelated-edit'});
      expect(refreshedUnrelated.pid).not.toBe(unrelated.pid);
      await until(
        async () => (!isLive(old.pid) && !isLive(unrelated.pid)) || undefined,
        'both obsolete connections to exit',
      );
    });
  },
  30000,
);
