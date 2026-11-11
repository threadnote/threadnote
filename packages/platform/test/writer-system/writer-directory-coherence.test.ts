import {expect, it, vi} from 'vitest';
import * as posix from '../../src/writer-system/posix-native.js';
import {
  runtimeOpenPrivateWriterDirectory,
  runtimeClosePrivateWriterDirectory,
  runtimePublishPrivateWriterFile,
} from '../../src/system.js';

const supported =
  (process.platform === 'darwin' || process.platform === 'linux') &&
  (process.arch === 'arm64' || process.arch === 'x64');
const fs = process.getBuiltinModule('fs'),
  path = process.getBuiltinModule('path'),
  os = process.getBuiltinModule('os');
const bytes = new TextEncoder().encode('owned post-sync publication fixture');

function fixture(run: (folder: string, vault: string) => void): void {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writer-directory-proof-')));
  const vault = path.join(folder, 'vault');
  fs.mkdirSync(vault, {mode: 0o700});
  try {
    run(folder, vault);
  } finally {
    fs.rmSync(folder, {recursive: true, force: true});
    fs.rmSync(`${folder}-moved`, {recursive: true, force: true});
  }
}

it.skipIf(!supported)(
  'keeps exact native flags and link refusal across fresh private-first and facade-first imports',
  () =>
    fixture((folder, vault) => {
      const posixUrl = new URL('../../src/writer-system/posix-native.ts', import.meta.url).href;
      const systemUrl = new URL('../../src/system.ts', import.meta.url).href;
      for (const first of [posixUrl, systemUrl]) {
        const name = first === posixUrl ? 'private-first' : 'facade-first';
        const source = `
        await import(${JSON.stringify(first)});
        const posix = await import(${JSON.stringify(posixUrl)});
        const system = await import(${JSON.stringify(systemUrl)});
        const fs = process.getBuiltinModule('fs');
        const vault = ${JSON.stringify(vault)}, name = ${JSON.stringify(name)};
        const expectedDirectory = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW |
          (process.platform === 'darwin' ? 0x01000000 : 0x00080000);
        const expectedFile = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK |
          (process.platform === 'darwin' ? 0x01000000 : 0x00080000);
        if (posix.posixDirectoryFlags !== expectedDirectory || posix.posixFileFlags !== expectedFile)
          throw new Error('Cold native flags differ from OS flags');
        const opened = [], originalOpen = fs.openSync.bind(fs);
        fs.openSync = (file, flags, mode) => {
          if (file === '/') opened.push(flags);
          return originalOpen(file, flags, mode);
        };
        let directory;
        try {
          directory = system.runtimeOpenPrivateWriterDirectory(vault);
          const bytes = new TextEncoder().encode('owned cold import fixture');
          const published = system.runtimePublishPrivateWriterFile(directory, name, bytes, {
            mode: 'exclusive', nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', assertCurrentSync: () => undefined,
          });
          const read = system.runtimeReadPrivateWriterFile(directory, name, 128);
          if (published.status !== 'published' || !read || !Buffer.from(read.bytes).equals(Buffer.from(bytes)))
            throw new Error('Cold native private operation failed');
          fs.symlinkSync(vault + '/' + name, vault + '/' + name + '-link');
          let refused = false;
          try { system.runtimeReadPrivateWriterFile(directory, name + '-link', 128); }
          catch { refused = true; }
          if (!refused || !opened.length || opened.some(flags => flags !== expectedDirectory))
            throw new Error('Cold native nofollow/directory guard failed');
          process.stdout.write(JSON.stringify({published: true, flagsExact: true, linkRefused: true}));
        } finally {
          fs.openSync = originalOpen;
          if (directory) system.runtimeClosePrivateWriterDirectory(directory);
        }
      `;
        const child = Bun.spawnSync([process.execPath, '-e', source], {
          cwd: folder,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 5000,
        });
        expect(new TextDecoder().decode(child.stderr), name).toBe('');
        expect(child.exitCode, name).toBe(0);
        expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({
          published: true,
          flagsExact: true,
          linkRefused: true,
        });
      }
    }),
);

// Use the actual native publisher. Only the owned fixture's post-file-sync stat
// boundary is intercepted; no lease/assertion/publication action is retried.
function publication(folder: string, vault: string, change: (sample: number) => void) {
  const directory = runtimeOpenPrivateWriterDirectory(vault),
    anchor = fs.statSync(folder, {bigint: true}),
    originalStat = fs.fstatSync.bind(fs),
    originalSync = fs.fsyncSync.bind(fs);
  let synced = false,
    samples = 0;
  const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    originalSync(fd);
    if (originalStat(fd).isFile()) synced = true;
  });
  const stat = vi.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
    const current = originalStat(fd, options);
    if (synced && options?.bigint && current.dev === anchor.dev && current.ino === anchor.ino) {
      change(++samples);
      return originalStat(fd, options);
    }
    return current;
  });
  try {
    const result = runtimePublishPrivateWriterFile(directory, 'receipt', bytes, {
      mode: 'exclusive',
      nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      assertCurrentSync: () => undefined,
    });
    return {result, samples};
  } finally {
    stat.mockRestore();
    sync.mockRestore();
    runtimeClosePrivateWriterDirectory(directory);
  }
}

it.skipIf(!supported)('publishes once after one owned sibling movement during a post-sync directory ACL sample', () =>
  fixture((folder, vault) => {
    const {result, samples} = publication(folder, vault, sample => {
      if (sample === 5) fs.mkdirSync(path.join(folder, 'owned-sibling'), {mode: 0o700});
    });
    expect(result.status).toBe('published');
    expect(samples).toBeGreaterThanOrEqual(10);
    expect(fs.readFileSync(path.join(vault, 'receipt'))).toEqual(Buffer.from(bytes));
  }),
);

it.skipIf(!supported)('keeps UNKNOWN after a second movement exhausts the one fresh directory ACL sample', () =>
  fixture((folder, vault) => {
    const {result, samples} = publication(folder, vault, sample => {
      if (sample === 5 || sample === 9) fs.mkdirSync(path.join(folder, `owned-sibling-${sample}`), {mode: 0o700});
    });
    expect(result.status).toBe('unknown');
    expect(samples).toBe(10);
    expect(fs.readFileSync(path.join(vault, 'receipt'))).toEqual(Buffer.from(bytes));
  }),
);

it.skipIf(!supported)('refuses a changed private ancestor mode without retrying it into acceptance', () =>
  fixture((folder, vault) => {
    const {result, samples} = publication(folder, vault, sample => {
      if (sample === 5) fs.chmodSync(folder, 0o750);
      if (sample === 9) fs.chmodSync(folder, 0o700);
    });
    expect(result.status).toBe('unknown');
    expect(samples).toBe(6);
    expect(fs.statSync(folder).mode & 0o777).toBe(0o750);
  }),
);

it.skipIf(!supported)('refuses a replaced current parent name and preserves both owned directory trees', () =>
  fixture((folder, vault) => {
    const {result} = publication(folder, vault, sample => {
      if (sample === 5) {
        fs.renameSync(folder, `${folder}-moved`);
        fs.mkdirSync(folder, {mode: 0o700});
      }
    });
    expect(result.status).toBe('unknown');
    expect(fs.readdirSync(folder)).toEqual([]);
    expect(fs.readFileSync(path.join(`${folder}-moved`, 'vault', 'receipt'))).toEqual(Buffer.from(bytes));
  }),
);

it.skipIf(!supported)('does not retry a failed native ACL proof even when a later call would succeed', () =>
  fixture((folder, vault) => {
    const anchor = fs.statSync(folder, {bigint: true}),
      original = posix.assertPosixPrivateAcl;
    let postSync = false,
      attempts = 0;
    const acl = vi.spyOn(posix, 'assertPosixPrivateAcl').mockImplementation((fd, privateObject, before) => {
      if (postSync && before.dev === anchor.dev && before.ino === anchor.ino && ++attempts === 1)
        throw new Error('owned unknown native security proof');
      original(fd, privateObject, before);
    });
    try {
      const {result} = publication(folder, vault, () => {
        postSync = true;
      });
      expect(result.status).toBe('unknown');
      expect(attempts).toBe(1);
    } finally {
      acl.mockRestore();
    }
  }),
);

it.skipIf(!supported || process.platform !== 'darwin')(
  'rejects an actual ACL made unsafe after the first allowed sample instead of retrying into a restored ACL',
  () =>
    fixture((folder, vault) => {
      let unsafe = false;
      const chmod = (...args: string[]) =>
        expect(
          Bun.spawnSync(['/bin/chmod', ...args, folder], {
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 5000,
          }).exitCode,
        ).toBe(0);
      try {
        const {result, samples} = publication(folder, vault, sample => {
          if (sample === 5) {
            chmod('+a', 'everyone allow write,execute,delete_child');
            unsafe = true;
          }
          if (sample === 9) {
            chmod('-N');
            unsafe = false;
          }
        });
        expect(result.status).toBe('unknown');
        expect(samples).toBe(8);
        expect(unsafe).toBe(true);
      } finally {
        if (unsafe) chmod('-N');
      }
    }),
);
