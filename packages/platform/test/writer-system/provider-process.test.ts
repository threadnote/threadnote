import * as EffectString from 'effect/String';
import {expect, it} from 'vitest';
import fc from 'fast-check';
import {decodeUnreapedPosixExitStatus} from '../../src/writer-system/provider-posix.js';
import {
  runtimeSpawnOwnedProviderTree,
  runtimeObserveOwnedProviderTree,
  runtimeTerminateOwnedProviderTree,
  runtimeCloseOwnedProviderTree,
  runtimeProbeProviderTree,
  runtimeNativePlatformSupport,
  type RuntimeOwnedProviderProcess,
} from '../../src/system.js';

const supported = runtimeNativePlatformSupport().providerTree;

it('decodes unreaped kernel exit statuses without treating stop or malformed records as termination', () => {
  expect(decodeUnreapedPosixExitStatus(String(7 * 256))).toBe(7);
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer({min: 0, max: 255}).map(code => ({status: code * 256, code})),
        fc.record({signal: fc.integer({min: 1, max: 64}), core: fc.boolean()}).map(({signal, core}) => ({
          status: signal + (core ? 128 : 0),
          code: 128 + signal,
        })),
      ),
      ({status, code}) => {
        expect(decodeUnreapedPosixExitStatus(String(status))).toBe(code);
      },
    ),
    {numRuns: 100},
  );
  for (const invalid of [
    undefined,
    '',
    '-1',
    '1.5',
    'NaN',
    'Infinity',
    ' 1792',
    '01792',
    '65536',
    '127',
    '65535',
    '128',
    '257',
  ])
    expect(() => decodeUnreapedPosixExitStatus(invalid)).toThrow();
});

const spawn = (source: string) =>
  runtimeSpawnOwnedProviderTree({
    command: process.execPath,
    args: ['-e', source],
    cwd: process.cwd(),
    environment: process.env,
  });
async function until<T>(read: () => T, accept: (value: T) => boolean, milliseconds = 3000): Promise<T> {
  const deadline = Date.now() + milliseconds;
  while (true) {
    const value = read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error('Native provider fixture deadline expired');
    await Bun.sleep(5);
  }
}
async function stop(provider: RuntimeOwnedProviderProcess): Promise<void> {
  if (runtimeObserveOwnedProviderTree(provider.handle).state !== 'drained')
    runtimeTerminateOwnedProviderTree(provider.handle, 'kill');
  await until(
    () => runtimeObserveOwnedProviderTree(provider.handle),
    o => o.state === 'drained',
  );
  runtimeCloseOwnedProviderTree(provider.handle);
}

// These exercise the synchronous native spawn / Promise stdio boundary, rather than an Effect program.
it.skipIf(!supported)(
  'binds actual stdio and refuses close until whole-group zero, EOF and accepted writes settle',
  async () => {
    const provider = spawn(`for await(const bytes of Bun.stdin.stream()) await Bun.write(Bun.stdout,bytes);`);
    const output = new Response(provider.stdout).text(),
      errors = new Response(provider.stderr).text();
    try {
      expect(runtimeObserveOwnedProviderTree(provider.handle).state).toBe('running');
      expect(() => runtimeCloseOwnedProviderTree(provider.handle)).toThrow();
      expect(() => Reflect.apply(runtimeObserveOwnedProviderTree, undefined, [Object.freeze({})])).toThrow();
      expect(runtimeProbeProviderTree({pid: provider.pid, identity: provider.identity})).toBe(
        process.platform === 'win32' ? 'unknown' : 'present',
      );
      expect(runtimeProbeProviderTree({pid: provider.pid, identity: provider.identity + '-different'})).toBe('unknown');
      await provider.write(new TextEncoder().encode('native-stdio-fixture'));
      await provider.closeInput();
      expect(await output).toBe('native-stdio-fixture');
      expect(await errors).toBe('');
      const final = await until(
        () => runtimeObserveOwnedProviderTree(provider.handle),
        o => o.state === 'drained',
      );
      expect(final.leaderExitCode).toBe(0);
      expect(final.stdioClosed).toBe(true);
      expect(runtimeProbeProviderTree({pid: provider.pid, identity: provider.identity})).toBe(
        process.platform === 'win32' ? 'unknown' : 'absent',
      );
    } finally {
      await stop(provider);
    }
  },
);

it.skipIf(!supported)(
  'retains original group authority after leader exit and terminates its actual surviving descendant',
  async () => {
    const childSource = `process.stdout.write('descendant-ready'+String.fromCharCode(10));setInterval(()=>{},1000);`;
    const provider = spawn(
      `Bun.spawn([process.execPath,'-e',${JSON.stringify(childSource)}],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});setTimeout(()=>process.exit(7),100);`,
    );
    const reader = provider.stdout.getReader();
    let output = '';
    const collect = (async () => {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        output += new TextDecoder().decode(item.value);
      }
    })();
    const errors = new Response(provider.stderr).text();
    try {
      await until(
        () => output,
        text => EffectString.includes('descendant-ready')(text),
      );
      const leaderExited = await until(
        () => runtimeObserveOwnedProviderTree(provider.handle),
        o => o.leaderExitCode === 7,
      );
      expect(leaderExited.state).toBe('running');
      expect(leaderExited.stdioClosed).toBe(false);
      runtimeTerminateOwnedProviderTree(provider.handle, 'kill');
      await provider.closeInput();
      await collect;
      expect(await errors).toBe('');
      const final = await until(
        () => runtimeObserveOwnedProviderTree(provider.handle),
        o => o.state === 'drained',
      );
      expect(final.leaderExitCode).toBe(7);
    } finally {
      await stop(provider);
    }
  },
);

it.skipIf(!supported)(
  'cancels a real full-pipe input without blocking escalation and drains cancelled output readers',
  async () => {
    const provider = spawn('setInterval(()=>{},1000)');
    const controller = new AbortController();
    const output = provider.stdout.cancel(),
      errors = provider.stderr.cancel();
    try {
      const write = provider.write(new Uint8Array(2 * 1024 * 1024), controller.signal);
      const rejection = expect(write).rejects.toThrow();
      await Bun.sleep(20);
      controller.abort(new Error('cancel fixture'));
      await rejection;
      runtimeTerminateOwnedProviderTree(provider.handle, 'kill');
      await provider.closeInput();
      await output;
      await errors;
      expect(
        (
          await until(
            () => runtimeObserveOwnedProviderTree(provider.handle),
            o => o.state === 'drained',
          )
        ).stdioClosed,
      ).toBe(true);
    } finally {
      await stop(provider);
    }
  },
);

it.skipIf(!supported)('allows finite cancellation while an actual provider continuously fills output', async () => {
  const provider = spawn('const bytes=new Uint8Array(65536);while(true)await Bun.write(Bun.stdout,bytes)');
  const stdout = provider.stdout.cancel(),
    stderr = provider.stderr.cancel();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    runtimeTerminateOwnedProviderTree(provider.handle, 'kill');
  }, 30);
  try {
    await stdout;
    await stderr;
    await provider.closeInput();
    expect(fired).toBe(true);
    await until(
      () => runtimeObserveOwnedProviderTree(provider.handle),
      o => o.state === 'drained',
    );
  } finally {
    clearTimeout(timer);
    await stop(provider);
  }
});

it.skipIf(!supported)('retains the native unreaped group anchor while independent Bun children complete', async () => {
  const provider = spawn('process.exit(3)');
  const output = new Response(provider.stdout).text(),
    errors = new Response(provider.stderr).text();
  try {
    await output;
    await errors;
    await provider.closeInput();
    for (let attempt = 0; attempt < 3; attempt++) {
      const other = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], {stdout: 'ignore', stderr: 'ignore'});
      expect(await other.exited).toBe(0);
    }
    const final = await until(
      () => runtimeObserveOwnedProviderTree(provider.handle),
      o => o.state === 'drained',
    );
    expect(final.leaderExitCode).toBe(3);
  } finally {
    await stop(provider);
  }
});

it.skipIf(process.platform !== 'win32' || !supported)(
  'atomically contains native child creation and refuses an actual Job breakaway request',
  async () => {
    const fixture = `
    import {dlopen} from 'bun:ffi';
    const k=dlopen('kernel32.dll',{
      CreateProcessW:{args:['buffer','buffer','ptr','ptr','i32','u32','ptr','ptr','buffer','buffer'],returns:'i32'},
      CloseHandle:{args:['u64'],returns:'i32'},GetLastError:{args:[],returns:'u32'}
    });
    const wide=s=>{const b=new Uint16Array(s.length+1);for(let i=0;i<s.length;i++)b[i]=s.charCodeAt(i);return b;};
    const app=process.execPath;
    const run=flags=>{const start=new BigUint64Array(13);new DataView(start.buffer).setUint32(0,104,true);const info=new BigUint64Array(3);
      const ok=k.symbols.CreateProcessW(wide(app),wide('"'+app+'" -e "process.exit(0)"'),null,null,0,0x08000000|flags,null,null,start,info);
      const error=ok?0:k.symbols.GetLastError();if(ok){k.symbols.CloseHandle(info[1]);k.symbols.CloseHandle(info[0]);}return {ok,error};};
    process.stdout.write(JSON.stringify({contained:run(0),breakaway:run(0x01000000)})+String.fromCharCode(10));k.close();
  `;
    const provider = spawn(fixture);
    const output = new Response(provider.stdout).text(),
      errors = new Response(provider.stderr).text();
    try {
      await provider.closeInput();
      expect(JSON.parse(await output)).toEqual({contained: {ok: 1, error: 0}, breakaway: {ok: 0, error: 5}});
      expect(await errors).toBe('');
      await until(
        () => runtimeObserveOwnedProviderTree(provider.handle),
        o => o.state === 'drained',
      );
    } finally {
      await stop(provider);
    }
  },
);

it.skipIf(!supported)(
  'signals only the captured original group or Job and leaves a separate owned provider running',
  async () => {
    const first = spawn('setInterval(()=>{},1000)'),
      second = spawn('setInterval(()=>{},1000)');
    const outputs = [first.stdout.cancel(), first.stderr.cancel(), second.stdout.cancel(), second.stderr.cancel()];
    try {
      runtimeTerminateOwnedProviderTree(first.handle, 'kill');
      await first.closeInput();
      await outputs[0];
      await outputs[1];
      await until(
        () => runtimeObserveOwnedProviderTree(first.handle),
        o => o.state === 'drained',
      );
      expect(runtimeObserveOwnedProviderTree(second.handle).state).toBe('running');
    } finally {
      await stop(first);
      await stop(second);
      await Promise.all(outputs);
    }
  },
);

it.skipIf(process.platform !== 'win32' || !supported)(
  'round-trips actual Windows argv without a shell, including empty, quote, backslash and metacharacter arguments',
  async () => {
    const expected = ['', 'space value', 'quote"value', 'tail\\', '\\"', '%PATH%&|^<>'];
    const provider = runtimeSpawnOwnedProviderTree({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1))+String.fromCharCode(10))',
        '--',
        ...expected,
      ],
      cwd: process.cwd(),
      environment: process.env,
    });
    const output = new Response(provider.stdout).text(),
      errors = new Response(provider.stderr).text();
    try {
      await provider.closeInput();
      expect(JSON.parse(await output)).toEqual(expected);
      expect(await errors).toBe('');
      await until(
        () => runtimeObserveOwnedProviderTree(provider.handle),
        o => o.state === 'drained',
      );
    } finally {
      await stop(provider);
    }
  },
);

it.skipIf(!supported)(
  'drains actual stdout through EOF when its reader cancels immediately after one delivered chunk',
  async () => {
    const provider = spawn("process.stdout.write('one'+String.fromCharCode(10));setInterval(()=>{},1000)");
    const reader = provider.stdout.getReader();
    const errors = provider.stderr.cancel();
    try {
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value!.length).toBeGreaterThan(0);
      const cancelled = reader.cancel();
      runtimeTerminateOwnedProviderTree(provider.handle, 'kill');
      await provider.closeInput();
      await cancelled;
      await errors;
      const final = await until(
        () => runtimeObserveOwnedProviderTree(provider.handle),
        o => o.state === 'drained',
      );
      expect(final.stdioClosed).toBe(true);
    } finally {
      reader.releaseLock();
      await stop(provider);
    }
  },
);
