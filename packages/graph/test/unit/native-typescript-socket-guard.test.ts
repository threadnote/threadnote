import {expect, it} from 'vitest';
import {guardNativeApiSocket} from '@threadnote/graph/typescript_runtime';

const failure = (code?: string) => Object.assign(new Error('write failed'), code === undefined ? {} : {code});

/** A socket shape whose write callback fails with `error` while the socket has not yet observed its own close. */
function liveSocket(error: Error, destroyable = true) {
  const socket: {destroyed: boolean; destroys: number; write: unknown; destroy?: () => void} = {
    destroyed: false,
    destroys: 0,
    write: (_chunk: unknown, callback: (error?: unknown) => void) => {
      callback(error);
      return false;
    },
  };
  if (destroyable)
    socket.destroy = () => {
      socket.destroys++;
      socket.destroyed = true;
    };
  guardNativeApiSocket(socket);
  const write = (): unknown => {
    let received: unknown = 'not-called';
    const guarded: unknown = socket.write;
    if (typeof guarded !== 'function') throw new Error('guarded write is missing');
    Reflect.apply(guarded, socket, [
      'frame',
      (value?: unknown) => {
        received = value;
      },
    ]);
    return received;
  };
  return {socket, write};
}

it('turns a peer-loss write error on a not-yet-closed socket into transport loss without a callback error', () => {
  for (const code of ['EPIPE', 'ECONNRESET', 'ERR_SOCKET_CLOSED', 'ECANCELED']) {
    const {socket, write} = liveSocket(failure(code));
    expect(write(), code).toBeUndefined();
    expect(socket.destroys, code).toBe(1);
    expect(socket.destroyed, code).toBe(true);
  }
});

it('keeps every other write error on a live socket, and a peer-loss error the socket cannot close', () => {
  for (const error of [failure('EACCES'), failure('ENOBUFS'), failure()]) {
    const {socket, write} = liveSocket(error);
    expect(write()).toBe(error);
    expect(socket.destroys).toBe(0);
    expect(socket.destroyed).toBe(false);
  }
  const epipe = failure('EPIPE');
  expect(liveSocket(epipe, false).write()).toBe(epipe);
});
