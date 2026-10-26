import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {describe, expect} from 'vitest';
import {extractGzipTar, type ArchiveExtractionLimits} from '@threadnote/threadnote/effect/archive';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

const TAR_BLOCK_BYTES = 512;

describe('bounded streaming release extraction', () => {
  effectIt.effect('rejects duplicate files, directories, roots and effective PAX or GNU member paths', () =>
    Effect.gen(function* () {
      for (const entries of [
        [tarEntry('./same.txt', bytes('first')), tarEntry('same.txt', bytes('second'))],
        [tarEntry('./directory/', bytes(''), {type: '5'}), tarEntry('directory', bytes(''), {type: '5'})],
        [tarEntry('./', bytes(''), {type: '5'}), tarEntry('.', bytes(''), {type: '5'})],
        [
          tarEntry('./same.txt', bytes('first')),
          tarEntry('./PaxHeader/alias', paxRecords({path: './same.txt'}), {type: 'x'}),
          tarEntry('./other.txt', bytes('second')),
        ],
        [
          tarEntry('./same.txt', bytes('first')),
          tarEntry('./LongLink', bytes('./same.txt\0'), {type: 'L'}),
          tarEntry('./other.txt', bytes('second')),
        ],
      ]) {
        const result = yield* extractFixture(tarArchive(entries));
        expect(String(result.failure)).toMatch(/duplicate path/);
        if (result.files.has('same.txt')) expect(result.files.get('same.txt')).toBe('first');
      }
    }),
  );

  effectIt.effect.prop(
    'rejects normalized duplicate members without replacing earlier file bytes',
    {value: Schema.Int, backslash: Schema.Boolean},
    ({value, backslash}) =>
      Effect.gen(function* () {
        const name = `file-${value}.txt`;
        const result = yield* extractFixture(
          tarArchive([
            tarEntry(`./nested/${name}`, bytes('first')),
            tarEntry(backslash ? `nested\\${name}` : `nested/${name}`, bytes('second')),
          ]),
        );
        expect(String(result.failure)).toMatch(/duplicate path/);
        expect(result.files.get(`nested/${name}`)).toBe('first');
      }),
    {arbitrary: {runs: 8}},
  );

  effectIt.effect('refuses traversal, absolute paths, links and special members', () =>
    Effect.gen(function* () {
      for (const name of ['../escape.txt', '/absolute.txt', 'C:/absolute.txt', 'nested/../escape.txt']) {
        const result = yield* extractFixture(tarArchive([tarEntry(name, bytes('forbidden'))]));
        expect(String(result.failure)).toMatch(/unsafe path|escapes/);
        expect(result.files.size).toBe(0);
      }
      for (const type of ['1', '2', '3', '6'] as const) {
        const result = yield* extractFixture(tarArchive([tarEntry('special', bytes(''), {type})]));
        expect(String(result.failure)).toMatch(/unsupported tar entry type/);
        expect(result.files.size).toBe(0);
      }
    }),
  );

  effectIt.effect('applies local PAX path and size overrides', () =>
    Effect.gen(function* () {
      const pax = paxRecords({path: './nested/local.txt', size: '5'});
      const result = yield* extractFixture(
        tarArchive([
          tarEntry('./PaxHeader/local.txt', pax, {type: 'x'}),
          tarEntry('./fallback.txt', bytes('hello'), {headerSize: 0}),
        ]),
      );

      expect(result.failure).toBeUndefined();
      expect(result.files.get('nested/local.txt')).toBe('hello');
      expect(result.files.has('fallback.txt')).toBe(false);
    }),
  );

  effectIt.effect('applies global PAX metadata and lets an empty local value clear it', () =>
    Effect.gen(function* () {
      const globalArchive = tarArchive([
        tarEntry('./GlobalHead.1', paxRecords({path: './global.txt'}), {type: 'g'}),
        tarEntry('./fallback.txt', bytes('global')),
      ]);
      const clearedArchive = tarArchive([
        tarEntry('./GlobalHead.1', paxRecords({path: './global.txt'}), {type: 'g'}),
        tarEntry('./PaxHeader/local.txt', paxRecords({path: ''}), {type: 'x'}),
        tarEntry('./fallback.txt', bytes('fallback')),
      ]);
      const [global, cleared] = yield* Effect.all([extractFixture(globalArchive), extractFixture(clearedArchive)], {
        concurrency: 2,
      });

      expect(global.failure).toBeUndefined();
      expect(global.files.get('global.txt')).toBe('global');
      expect(cleared.failure).toBeUndefined();
      expect(cleared.files.get('fallback.txt')).toBe('fallback');
    }),
  );

  effectIt.effect('rejects malformed or truncated PAX records', () =>
    Effect.gen(function* () {
      const malformed = yield* extractFixture(
        tarArchive([
          tarEntry('./PaxHeader/broken', bytes('99 path=broken.txt\n'), {type: 'x'}),
          tarEntry('./fallback.txt', bytes('content')),
        ]),
      );

      expect(String(malformed.failure)).toMatch(/truncated PAX metadata record/);
      expect(malformed.files.has('fallback.txt')).toBe(false);
    }),
  );

  effectIt.effect('bounds independent archive limits independently of file payload sizes', () =>
    Effect.gen(function* () {
      for (const {limits, pattern} of [
        {
          label: 'cumulative decompressed bytes',
          limits: {decompressedBytes: TAR_BLOCK_BYTES * 2},
          pattern: /decompressed tar bytes/,
        },
        {
          label: 'tar entry count',
          limits: {entries: 1},
          pattern: /tar entries/,
        },
        {
          label: 'end padding',
          limits: {endPaddingBytes: TAR_BLOCK_BYTES / 2},
          pattern: /end-padding bytes/,
        },
      ]) {
        const result = yield* extractFixture(
          tarArchive([tarEntry('./first.txt', new Uint8Array()), tarEntry('./second.txt', new Uint8Array())]),
          limits,
        );

        expect(String(result.failure)).toMatch(pattern);
      }
    }),
  );

  effectIt.effect('counts effective PAX sizes against the expanded payload budget', () =>
    Effect.gen(function* () {
      const pax = paxRecords({size: '5'});
      const result = yield* extractFixture(
        tarArchive([
          tarEntry('./PaxHeader/size', pax, {type: 'x'}),
          tarEntry('./payload.txt', bytes('hello'), {headerSize: 0}),
        ]),
        {expandedBytes: pax.length + 4},
      );

      expect(String(result.failure)).toMatch(/expanded bytes/);
      expect(result.files.has('payload.txt')).toBe(false);
    }),
  );
});

function extractFixture(tar: Uint8Array, limits: ArchiveExtractionLimits = {}) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-archive-test-'});
      const archive = path.join(root, 'release.tar.gz');
      const destination = path.join(root, 'release');
      yield* fs.writeFile(archive, Bun.gzipSync(new Uint8Array(tar)));
      const failure = yield* extractGzipTar(archive, destination, limits).pipe(
        Effect.as(undefined),
        Effect.catch(cause => Effect.succeed(cause)),
      );
      const files = new Map<string, string>();
      if (yield* fs.exists(destination)) {
        for (const relative of yield* fs.readDirectory(destination, {recursive: true})) {
          const file = path.join(destination, relative);
          if ((yield* fs.stat(file)).type === 'File')
            files.set(relative.replaceAll('\\', '/'), yield* fs.readFileString(file));
        }
      }
      return {failure, files};
    }),
  ).pipe(provideTestLayer(ApplicationLayer));
}

function tarArchive(entries: readonly Uint8Array[]): Uint8Array {
  return joinBytes([...entries, new Uint8Array(TAR_BLOCK_BYTES * 2)]);
}

function tarEntry(
  name: string,
  content: Uint8Array,
  options: {
    readonly headerSize?: number;
    readonly mode?: number;
    readonly type?: '0' | '1' | '2' | '3' | '5' | '6' | 'g' | 'x' | 'L';
  } = {},
): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_BYTES);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, options.mode ?? 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, options.headerSize ?? content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeText(header, 156, 1, options.type ?? '0');
  writeText(header, 257, 6, 'ustar');
  writeText(header, 263, 2, '00');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return joinBytes([header, content, new Uint8Array(tarPadding(content.length))]);
}

function paxRecords(values: Readonly<Record<string, string>>): Uint8Array {
  return bytes(
    Object.entries(values)
      .map(([key, value]) => {
        const body = `${key}=${value}\n`;
        let length = new TextEncoder().encode(body).length + 2;
        while (true) {
          const record = `${length} ${body}`;
          const actual = new TextEncoder().encode(record).length;
          if (actual === length) return record;
          length = actual;
        }
      })
      .join(''),
  );
}

function writeText(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(bytes(value).slice(0, length), offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  writeText(target, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function tarPadding(size: number): number {
  return (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
