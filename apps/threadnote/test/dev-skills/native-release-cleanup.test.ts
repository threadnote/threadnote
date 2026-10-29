import * as fs from '@threadnote/testing/node-fs';
import {join} from '@threadnote/testing/node-path';
import {tmpdir} from '@threadnote/testing/node-os';
import {expect, it} from 'vitest';
import {
  digest,
  removeOwnedFixture,
  retryOwnedReadonlyFile,
  stage,
  type CleanupFileSystem,
  type StageArguments,
  type StageDependencies,
} from './release-artifact.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const permission = (path: string) => Object.assign(new Error(`read-only Windows fixture: ${path}`), {code: 'EACCES'});
const withFixture = async (program: (base: string) => Promise<void> | void) => {
  const base = fs.mkdtempSync(join(tmpdir(), 'threadnote-cleanup-test-'));
  try {
    await program(base);
  } finally {
    removeOwnedFixture(base, {platform: 'win32'});
  }
};
function owned(base: string, name: string) {
  const root = join(base, name);
  const object = join(root, 'cursor-cloud-personal/home/share/teams/default.gitdir/objects/00/object');
  fs.mkdirSync(join(object, '..'), {recursive: true});
  fs.writeFileSync(object, 'owned Git object');
  fs.chmodSync(object, 0o400);
  return {root, object};
}

it('retries an owned Windows read-only Git object once and preserves external neighbors and symlinks', async () => {
  await withFixture(base => {
    const neighbor = join(base, 'neighbor');
    const sentinel = join(neighbor, 'sentinel');
    fs.mkdirSync(neighbor);
    fs.writeFileSync(sentinel, 'external neighbor');
    fs.chmodSync(sentinel, 0o400);
    const originalMode = fs.statSync(sentinel).mode;
    const {root, object} = owned(base, 'readonly');
    const attempts: number[] = [];
    const readonlyError = permission(object);
    const filesystem: CleanupFileSystem = {
      ...fs,
      unlinkSync: path => {
        if (String(path) === object) {
          const mode = fs.statSync(object).mode;
          attempts.push(mode);
          if (!(mode & 0o200)) throw readonlyError;
        }
        fs.unlinkSync(path);
      },
    };
    expect(() => removeOwnedFixture(root, {platform: 'linux', filesystem})).toThrow(readonlyError);
    expect(fs.existsSync(object)).toBe(true);
    attempts.length = 0;
    removeOwnedFixture(root, {platform: 'win32', filesystem});
    expect(fs.existsSync(root)).toBe(false);
    expect(attempts).toHaveLength(2);
    expect(attempts[0] & 0o200).toBe(0);
    expect(attempts[1] & 0o200).not.toBe(0);
    const links = owned(base, 'links');
    if (process.platform !== 'win32') {
      fs.symlinkSync(sentinel, join(links.root, 'external-file'));
      fs.symlinkSync(neighbor, join(links.root, 'external-directory'), 'dir');
    }
    removeOwnedFixture(links.root, {platform: 'win32'});
    expect(fs.existsSync(links.root)).toBe(false);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('external neighbor');
    expect(fs.statSync(sentinel).mode).toBe(originalMode);
    fs.chmodSync(sentinel, originalMode | 0o200);
  });
});

it('refuses chmod for writable, external, directory, link and unrelated failures and preserves original errors', async () => {
  await withFixture(base => {
    const {root, object} = owned(base, 'guarded');
    const sentinel = join(base, 'sentinel');
    fs.writeFileSync(sentinel, 'external neighbor');
    fs.chmodSync(sentinel, 0o400);
    const writable = join(root, 'writable');
    fs.writeFileSync(writable, 'writable');
    fs.chmodSync(writable, 0o600);
    const cases: [string, Error][] = [
      [writable, permission(writable)],
      [sentinel, permission(sentinel)],
      [join(object, '..'), permission(join(object, '..'))],
      [object, Object.assign(new Error('unrelated I/O failure'), {code: 'EIO'})],
    ];
    if (process.platform !== 'win32') {
      const link = join(root, 'external-link');
      fs.symlinkSync(sentinel, link);
      cases.push([link, permission(link)]);
      const alias = join(root, 'external-directory');
      fs.symlinkSync(base, alias, 'dir');
      cases.push([join(alias, 'sentinel'), permission(join(alias, 'sentinel'))]);
    }
    const filesystem: CleanupFileSystem = {
      ...fs,
      chmodSync: () => {
        throw new Error('unexpected chmod');
      },
    };
    for (const [path, error] of cases) {
      let caught: unknown;
      try {
        retryOwnedReadonlyFile(root, path, error, {platform: 'win32', filesystem});
      } catch (actual) {
        caught = actual;
      }
      expect(caught).toBe(error);
    }
    const nonWindowsError = permission(object);
    expect(() => retryOwnedReadonlyFile(root, object, nonWindowsError, {platform: 'linux', filesystem})).toThrow(
      nonWindowsError,
    );
    const chmodError = permission('chmod remains denied');
    const chmodDenied = {
      ...fs,
      chmodSync: () => {
        throw chmodError;
      },
    };
    expect(() =>
      retryOwnedReadonlyFile(root, object, nonWindowsError, {platform: 'win32', filesystem: chmodDenied}),
    ).toThrow(chmodError);
    const directoryError = permission(root);
    const rmdirDenied = {
      ...fs,
      rmdirSync: () => {
        throw directoryError;
      },
    };
    expect(() => removeOwnedFixture(root, {platform: 'win32', filesystem: rmdirDenied})).toThrow(directoryError);
    fs.chmodSync(sentinel, 0o600);
  });
});

it('propagates the failed retry unchanged with no loop', async () => {
  await withFixture(base => {
    const {root, object} = owned(base, 'retry-failure');
    const retryError = permission(object);
    let calls = 0;
    const filesystem: CleanupFileSystem = {
      ...fs,
      unlinkSync: () => {
        calls++;
        throw retryError;
      },
    };
    let caught: unknown;
    try {
      removeOwnedFixture(root, {platform: 'win32', filesystem});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(retryError);
    expect(calls).toBe(2);
    expect(fs.statSync(object).mode & 0o200).not.toBe(0);
  });
});

/** Small standard ustar fixture; extraction always uses the production parser. */
function archiveFixture(path: string, payload: Buffer) {
  const header = Buffer.alloc(512);
  header.write('payload', 0);
  const octal = (offset: number, length: number, value: number) =>
    header.write(
      Effect.pipe(value.toString(8), EffectString.padStart(length - 1, '0')) + '\0',
      offset,
      length,
      'ascii',
    );
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, payload.length);
  octal(136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.write(
    Effect.pipe(header.reduce((sum, byte) => sum + byte, 0).toString(8), EffectString.padStart(6, '0')) + '\0 ',
    148,
    8,
    'ascii',
  );
  fs.writeFileSync(
    path,
    Bun.gzipSync(Buffer.concat([header, payload, Buffer.alloc(((512 - (payload.length % 512)) % 512) + 1024)])),
  );
  fs.writeFileSync(path + '.sha256', digest(path));
}

it('copies provenance and raw logs before cleanup; cleanup and workflow failures preserve identity and failed fixtures', async () => {
  await withFixture(async base => {
    const checkout = join(base, 'checkout');
    fs.mkdirSync(join(checkout, 'dist'), {recursive: true});
    const payload = Buffer.from('test payload');
    fs.writeFileSync(join(checkout, 'dist/payload'), payload);
    const archive = join(base, 'release.tar.gz');
    archiveFixture(archive, payload);
    const tool = join(base, 'tool');
    fs.writeFileSync(tool, 'host fixture placeholder');
    const report = join(base, 'result.json');
    const arguments_: StageArguments = {checkout, archive, report, tools: tool, functionalOnly: true};
    const roots: string[] = [];
    const executeFixture: NonNullable<StageDependencies['run']> = (_command, _environment, root) => {
      fs.writeFileSync(
        join(root, 'result.json'),
        JSON.stringify({status: 'functional-passed-isolation-pending', isolation: {enforced: false}}),
      );
      fs.mkdirSync(join(root, 'provenance'));
      fs.writeFileSync(join(root, 'provenance/receipt'), 'saved provenance');
      for (const suffix of ['', '.stdout.bin', '.stderr.bin'])
        fs.writeFileSync(join(root, 'fixture-native.log' + suffix), 'native evidence');
      return '';
    };
    const dependencies: StageDependencies = {
      platform: 'win32',
      findTool: () => tool,
      run: executeFixture,
      allocate: () => {
        const root = join(base, `staged-${roots.length}`);
        fs.mkdirSync(root);
        roots.push(fs.realpathSync(root));
        return root;
      },
      remove: root => {
        expect(JSON.parse(fs.readFileSync(report, 'utf8')).status).toBe('functional-passed-isolation-pending');
        expect(fs.readFileSync(join(base, 'result.provenance/receipt'), 'utf8')).toBe('saved provenance');
        expect(fs.readFileSync(join(base, 'result.provenance/fixture-native.log.stderr.bin'), 'utf8')).toBe(
          'native evidence',
        );
        removeOwnedFixture(root);
      },
    };
    await stage(arguments_, dependencies);
    expect(fs.existsSync(roots.at(-1)!)).toBe(false);
    const cleanupError = permission('cleanup remains denied');
    await expect(
      stage(arguments_, {
        ...dependencies,
        remove: () => {
          throw cleanupError;
        },
      }),
    ).rejects.toBe(cleanupError);
    const failed = JSON.parse(fs.readFileSync(report, 'utf8'));
    expect(failed.status).toBe('failed');
    expect(failed.fixture).toBe(roots.at(-1));
    expect(fs.existsSync(roots.at(-1)!)).toBe(true);
    expect(fs.readFileSync(join(base, 'result.provenance/fixture-native.log'), 'utf8')).toBe('native evidence');
    const primaryError = new Error('original workflow failure');
    await expect(
      stage(arguments_, {
        ...dependencies,
        run: (...args) => {
          executeFixture(...args);
          throw primaryError;
        },
        remove: () => {
          throw new Error('cleanup before workflow success');
        },
      }),
    ).rejects.toBe(primaryError);
    expect(fs.existsSync(roots.at(-1)!)).toBe(true);
    expect(JSON.parse(fs.readFileSync(report, 'utf8')).error).toBe(primaryError.message);
    expect(fs.readFileSync(join(base, 'result.provenance/fixture-native.log.stdout.bin'), 'utf8')).toBe(
      'native evidence',
    );
  });
});
