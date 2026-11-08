import {dlopen} from 'bun:ffi';
import {expect, it} from 'vitest';
import {linuxRuntimeLibc} from '../../src/writer-system/posix-native.js';
import {
  runtimeOpenPrivateWriterDirectory,
  runtimeClosePrivateWriterDirectory,
  runtimePublishPrivateWriterFile,
  runtimeAssertPrivateProviderPath,
} from '../../src/system.js';

it.skipIf(process.platform !== 'linux')(
  'refuses an actual Linux default ACL while the private directory mode remains0700',
  () => {
    const fs = process.getBuiltinModule('fs'),
      os = process.getBuiltinModule('os'),
      path = process.getBuiltinModule('path');
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writer-native-linux-acl-')));
    let directory: ReturnType<typeof runtimeOpenPrivateWriterDirectory> | undefined;
    let release = () => undefined;
    try {
      const lib = dlopen(linuxRuntimeLibc().library, {
        fsetxattr: {args: ['i32', 'buffer', 'buffer', 'u64', 'i32'], returns: 'i32'},
      });
      release = () => {
        lib.close();
        return undefined;
      };
      const opened = runtimeOpenPrivateWriterDirectory(folder);
      directory = opened;
      const fd = fs.openSync(folder, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const acl = new Uint8Array(28),
          view = new DataView(acl.buffer);
        view.setUint32(0, 2, true);
        for (const [index, tag] of [1, 4, 32].entries()) {
          view.setUint16(4 + index * 8, tag, true);
          view.setUint16(6 + index * 8, 7, true);
          view.setUint32(8 + index * 8, 0xffffffff, true);
        }
        expect(lib.symbols.fsetxattr(fd, new TextEncoder().encode('system.posix_acl_default\0'), acl, 28n, 0)).toBe(0);
        expect(fs.fstatSync(fd).mode & 0o777).toBe(0o700);
      } finally {
        fs.closeSync(fd);
      }
      expect(() => runtimeAssertPrivateProviderPath(folder, {kind: 'directory'})).toThrow();
      expect(() =>
        runtimePublishPrivateWriterFile(opened, 'private.json', new TextEncoder().encode('private fixture'), {
          mode: 'exclusive',
          nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          assertCurrentSync: () => undefined,
        }),
      ).toThrow();
      expect(fs.existsSync(path.join(folder, 'private.json'))).toBe(false);
    } finally {
      if (directory) runtimeClosePrivateWriterDirectory(directory);
      release();
      fs.rmSync(folder, {recursive: true, force: true});
    }
  },
);
