import {Effect, FileSystem, Array as EffectArray, String as EffectString} from 'effect';
import {
  nativeVectorReaderSourceSha256,
  nativeVectorReaderTarget,
  parseNativeVectorReaderManifest,
  sameNativeVectorReaderBuildInfo,
  verifyNativeVectorReaderPayload,
  type NativeVectorReaderBuildInfo,
  type NativeVectorReaderManifest,
} from '@threadnote/recall/vector/native-reader-payload';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {platformPathFor, SystemInfo} from '@threadnote/platform/system';

export {nativeVectorReaderTarget, verifyNativeVectorReaderPayload};
const path = platformPathFor(process.platform);

export function nativeReaderGit(root: string, args: readonly string[]): string {
  const result = Bun.spawnSync({cmd: ['git', '-C', root, ...args], stdout: 'pipe', stderr: 'pipe'});
  if (result.exitCode !== 0) throw new Error(`Native vector reader could not inspect Git ${args[0]}.`);
  return EffectString.trim(result.stdout.toString());
}

export async function nativeReaderBuildInputs(root: string, bunTarget: string, development: boolean) {
  if (!development) {
    const status = nativeReaderGit(root, ['status', '--porcelain', '--untracked-files=normal']);
    if (status !== '') {
      throw new Error(
        'Native vector reader release assembly requires a clean committed checkout. ' +
          `Repository-relative Git status (bounded): ${JSON.stringify(EffectString.slice(0, 4096)(status))}`,
      );
    }
  }
  const sourceCommit = nativeReaderGit(root, ['rev-parse', 'HEAD']);
  const sourceTree = nativeReaderGit(root, ['rev-parse', 'HEAD^{tree}']);
  const crateRoot = path.join(root, 'packages', 'recall', 'native-vector-reader');
  const sourceSha256 = await nativeVectorReaderSourceSha256(crateRoot);
  const lockSha256 = sha256HexSync(new Uint8Array(await Bun.file(path.join(crateRoot, 'Cargo.lock')).arrayBuffer()));
  const toolchainSha256 = sha256HexSync(
    new Uint8Array(await Bun.file(path.join(crateRoot, 'rust-toolchain.toml')).arrayBuffer()),
  );
  const target = nativeVectorReaderTarget(bunTarget);
  if (!target) return undefined;
  if (!development) {
    const release: unknown = await Bun.file(path.join(root, 'dist', 'release.json')).json();
    if (
      typeof release !== 'object' ||
      release === null ||
      !('sourceIdentity' in release) ||
      !('target' in release) ||
      release.target !== bunTarget
    ) {
      throw new Error('Build the JavaScript release for this target before native assembly.');
    }
    const identity = release.sourceIdentity;
    if (
      typeof identity !== 'object' ||
      identity === null ||
      !('commit' in identity) ||
      !('tree' in identity) ||
      !('target' in identity) ||
      identity.commit !== sourceCommit ||
      identity.tree !== sourceTree ||
      identity.target !== bunTarget
    ) {
      throw new Error('JavaScript distribution source identity differs from current clean HEAD.');
    }
  }
  return {sourceCommit, sourceTree, sourceSha256, lockSha256, toolchainSha256, target};
}

export async function readNativeReaderBuildInfo(binaryPath: string): Promise<NativeVectorReaderBuildInfo> {
  const nativeModule = {exports: {}};
  process.dlopen(nativeModule, binaryPath);
  const binding: unknown = nativeModule.exports;
  if (
    typeof binding !== 'object' ||
    binding === null ||
    !('buildInfo' in binding) ||
    typeof binding.buildInfo !== 'function'
  ) {
    throw new Error('Native vector reader binary does not export buildInfo().');
  }
  return binding.buildInfo();
}

/** Publish the descriptor only after the copied binary and its build identity have been verified. */
export async function publishNativeReaderManifest(
  directory: string,
  fields: Omit<NativeVectorReaderManifest, 'schemaVersion' | 'binary' | 'binarySha256'>,
) {
  const binary = path.join(directory, 'threadnote-vector-reader.node');
  const manifest = parseNativeVectorReaderManifest({
    schemaVersion: 1,
    binary: 'threadnote-vector-reader.node',
    binarySha256: sha256HexSync(new Uint8Array(await Bun.file(binary).arrayBuffer())),
    ...fields,
  });
  if (!sameNativeVectorReaderBuildInfo(await readNativeReaderBuildInfo(binary), manifest.buildInfo)) {
    throw new Error('Native vector reader staged binary identity differs from the build inputs.');
  }
  await Bun.write(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** GCC 12 config/libgcc-glibc.ver and config/t-linux retain GLIBC_2.0 for libgcc's historical helpers. */
function isMuslLibgccCompatibility(elf: string, definedSymbols: string, target: string): boolean {
  if (target !== 'bun-linux-arm64-musl' || /\bGLIBC_/u.test(definedSymbols)) return false;
  const needed = EffectArray.map(
    [...EffectString.matchAll(/^\s*0x[0-9a-f]+\s+\(NEEDED\)\s+Shared library: \[([A-Za-z0-9_.+-]+)\]\s*$/gmu)(elf)],
    match => match[1] ?? '',
  );
  if (
    needed.length !== [...EffectString.matchAll(/\(NEEDED\)/gu)(elf)].length ||
    !needed.includes('libgcc_s.so.1') ||
    !needed.includes('libc.musl-aarch64.so.1') ||
    EffectArray.some(needed, name => /^(?:ld-linux|lib(?:c|m|dl|pthread|rt|resolv|util|anl)\.so(?:\.|$))/u.test(name))
  )
    return false;
  const needs = [
    ...EffectString.matchAll(
      /(?:^|\n)Version needs section '\.gnu\.version_r' contains (\d+) entr(?:y|ies):\n([\s\S]*?)(?=\nVersion [^\n]+ section|$)/gu,
    )(elf),
  ];
  const symbols = [
    ...EffectString.matchAll(
      /(?:^|\n)Version symbols section '\.gnu\.version'[^\n]*\n([\s\S]*?)(?=\nVersion [^\n]+ section|$)/gu,
    )(elf),
  ];
  const section = needs[0];
  const symbolSection = symbols[0];
  if (needs.length !== 1 || symbols.length !== 1 || !section || !symbolSection) return false;
  let owner = '';
  let remaining = 0;
  let files = 0;
  const seenFiles: string[] = [];
  const seenIndices: number[] = [];
  const compatibilityIndices: number[] = [];
  for (const line of EffectString.split(/\r?\n/)(section[2] ?? '')) {
    if (/^\s*$/u.test(line)) continue;
    if (/^\s*Addr: 0x[0-9a-f]+\s+Offset: 0x[0-9a-f]+\s+Link: \d+ \(\.dynstr\)\s*$/u.test(line)) continue;
    const file = /^\s*(?:0x)?[0-9a-f]+:\s+Version: 1\s+File: ([A-Za-z0-9_.+-]+)\s+Cnt: (\d+)\s*$/u.exec(line);
    if (file) {
      if (remaining !== 0 || !file[1] || seenFiles.includes(file[1])) return false;
      owner = file[1];
      seenFiles.push(owner);
      remaining = Number(file[2]);
      if (remaining < 1 || !needed.includes(owner)) return false;
      files++;
      continue;
    }
    const name =
      /^\s*(?:0x)?[0-9a-f]+:\s+Name: ([A-Za-z0-9_.+-]+)\s+Flags: (?:none|[A-Z_ |]+)\s+Version: (\d+)\s*$/u.exec(line);
    if (!name || !owner || remaining < 1) return false;
    const index = Number(name[2]);
    if (index < 2 || index > 0x7fff || seenIndices.includes(index)) return false;
    seenIndices.push(index);
    remaining--;
    if (EffectString.startsWith('GLIBC_')(name[1] ?? '')) {
      if (owner !== 'libgcc_s.so.1' || name[1] !== 'GLIBC_2.0') return false;
      compatibilityIndices.push(index);
    }
  }
  if (remaining !== 0 || files !== Number(section[1]) || compatibilityIndices.length !== 1) return false;
  const symbolPattern = /\b([0-9a-f]+)(?:h|\s+)\(GLIBC_2\.0\)/gu;
  const references = [...EffectString.matchAll(symbolPattern)(symbolSection[1] ?? '')];
  if (
    references.length === 0 ||
    EffectArray.some(references, match => !compatibilityIndices.includes(Number.parseInt(match[1] ?? '', 16)))
  )
    return false;
  if (/\bGLIBC_/u.test(EffectString.replaceAll(symbolPattern, '')(symbolSection[1] ?? ''))) return false;
  return !/\bGLIBC_/u.test(EffectString.replace(section[0], '')(EffectString.replace(symbolSection[0], '')(elf)));
}

/** Created only when inference assembly captures the selected compiler's resolved runtime bytes. */
export interface CompilerLibgccProvider {
  readonly sourcePath: string;
  readonly sha256: string;
}

function isMuslLibgccProvider(elf: string, definedSymbols: string): boolean {
  if (
    [...EffectString.matchAll(/\(NEEDED\)/gu)(elf)].length !== 1 ||
    !/^\s*0x[0-9a-f]+\s+\(NEEDED\)\s+Shared library: \[libc\.musl-aarch64\.so\.1\]\s*$/mu.test(elf) ||
    [...EffectString.matchAll(/\(SONAME\)/gu)(elf)].length !== 1 ||
    !/^\s*0x[0-9a-f]+\s+\(SONAME\)\s+Library soname: \[libgcc_s\.so\.1\]\s*$/mu.test(elf) ||
    /Version needs section/u.test(elf)
  )
    return false;
  const definitions = [
    ...EffectString.matchAll(
      /(?:^|\n)Version definition section '\.gnu\.version_d' contains (\d+) entr(?:y|ies):\n([\s\S]*?)(?=\nVersion [^\n]+ section|$)/gu,
    )(elf),
  ];
  const symbols = [
    ...EffectString.matchAll(
      /(?:^|\n)Version symbols section '\.gnu\.version'[^\n]*\n([\s\S]*?)(?=\nVersion [^\n]+ section|$)/gu,
    )(elf),
  ];
  const section = definitions[0];
  const symbolSection = symbols[0];
  if (definitions.length !== 1 || symbols.length !== 1 || !section || !symbolSection) return false;
  let remaining = 0;
  let parentNumber = 1;
  let compatibilityIndex = 0;
  let bases = 0;
  const names: string[] = [];
  const indices: number[] = [];
  const parents: string[] = [];
  for (const line of EffectString.split(/\r?\n/)(section[2] ?? '')) {
    if (/^\s*$/u.test(line)) continue;
    if (/^\s*Addr: 0x[0-9a-f]+\s+Offset: 0x[0-9a-f]+\s+Link: \d+ \(\.dynstr\)\s*$/u.test(line)) continue;
    const entry =
      /^\s*(?:0x)?[0-9a-f]+:\s+Rev: 1\s+Flags: (BASE|WEAK|none)\s+Index: (\d+)\s+Cnt: (\d+)\s+Name: ([A-Za-z0-9_.+-]+)\s*$/u.exec(
        line,
      );
    if (entry) {
      const name = entry[4] ?? '';
      const index = Number(entry[2]);
      if (
        remaining !== 0 ||
        Number(entry[3]) < 1 ||
        index < 1 ||
        index > 0x7fff ||
        indices.includes(index) ||
        names.includes(name)
      )
        return false;
      if (entry[1] === 'BASE') {
        if (name !== 'libgcc_s.so.1' || index !== 1 || Number(entry[3]) !== 1) return false;
        bases++;
      } else if (name === 'GLIBC_2.0') {
        if (entry[1] !== 'none' || index < 2 || Number(entry[3]) !== 1) return false;
        compatibilityIndex = index;
      } else if (!/^GCC_\d+(?:\.\d+)+$/u.test(name) || index < 2) return false;
      names.push(name);
      indices.push(index);
      remaining = Number(entry[3]) - 1;
      parentNumber = 1;
      continue;
    }
    const parent = /^\s*(?:0x)?[0-9a-f]+:\s+Parent (\d+): ([A-Za-z0-9_.+-]+)\s*$/u.exec(line);
    if (!parent || remaining < 1 || Number(parent[1]) !== parentNumber++) return false;
    parents.push(parent[2] ?? '');
    remaining--;
  }
  if (
    remaining !== 0 ||
    bases !== 1 ||
    compatibilityIndex === 0 ||
    names.length !== Number(section[1]) ||
    EffectArray.some(parents, name => !names.includes(name))
  )
    return false;
  const symbolPattern = /\b([0-9a-f]+)(?:h|\s+)\(GLIBC_2\.0\)/gu;
  const references = [...EffectString.matchAll(symbolPattern)(symbolSection[1] ?? '')];
  if (
    references.length === 0 ||
    EffectArray.some(references, match => Number.parseInt(match[1] ?? '', 16) !== compatibilityIndex)
  )
    return false;
  if (/\bGLIBC_/u.test(EffectString.replaceAll(symbolPattern, '')(symbolSection[1] ?? ''))) return false;
  if (/\bGLIBC_/u.test(EffectString.replace(section[0], '')(EffectString.replace(symbolSection[0], '')(elf))))
    return false;
  // Exact exports from pinned GCC config/libgcc-glibc.ver; ordinary consumers never receive this rule.
  const allowed = [
    '__divdi3',
    '__moddi3',
    '__udivdi3',
    '__umoddi3',
    '__register_frame',
    '__register_frame_table',
    '__deregister_frame',
    '__register_frame_info',
    '__deregister_frame_info',
    '__frame_state_for',
    '__register_frame_info_table',
  ];
  let namespace = 0;
  const exports: string[] = [];
  for (const line of EffectString.split(/\r?\n/)(definedSymbols)) {
    if (!/\bGLIBC_/u.test(line)) continue;
    if (/^\s*[0-9a-f]+\s+A\s+GLIBC_2\.0\s*$/u.test(line)) {
      namespace++;
      continue;
    }
    const symbol = /^\s*[0-9a-f]+\s+[TW]\s+([A-Za-z0-9_]+)@@GLIBC_2\.0\s*$/u.exec(line)?.[1];
    if (!symbol || !allowed.includes(symbol) || exports.includes(symbol)) return false;
    exports.push(symbol);
  }
  return namespace === 1 && exports.length > 0;
}

/** Inspect the actual native artifact, including dependencies hidden from source metadata. */
export const auditNativeReaderBinary = Effect.fn('nativeReader.auditBinary')(function* (
  binaryPath: string,
  bunTarget: string,
  options: {readonly inference?: boolean; readonly compilerLibgccProvider?: CompilerLibgccProvider} = {},
) {
  const {platform} = yield* SystemInfo;
  if (options.compilerLibgccProvider) {
    const fs = yield* FileSystem.FileSystem;
    const provider = options.compilerLibgccProvider;
    if (
      platform !== 'linux' ||
      !options.inference ||
      bunTarget !== 'bun-linux-arm64-musl' ||
      path.basename(binaryPath) !== 'libgcc_s.so.1' ||
      !/^[a-f0-9]{64}$/u.test(provider.sha256) ||
      !path.isAbsolute(provider.sourcePath) ||
      path.basename(provider.sourcePath) !== 'libgcc_s.so.1'
    )
      throw new Error('Invalid compiler libgcc provider audit role.');
    const source = yield* fs.realPath(provider.sourcePath);
    if (
      source !== provider.sourcePath ||
      source === (yield* fs.realPath(binaryPath)) ||
      sha256HexSync(yield* fs.readFile(source)) !== provider.sha256 ||
      sha256HexSync(yield* fs.readFile(binaryPath)) !== provider.sha256
    )
      throw new Error('Compiler libgcc provider source/copy identity differs from its captured bytes.');
  }
  // Windows inference permits upstream C++ exports; only the reader checks private SQLite export leakage.
  const commands: readonly (readonly [string, readonly string[]])[] =
    platform === 'linux'
      ? [
          ['readelf', ['--file-header', '--dynamic', '--version-info', binaryPath]],
          ['nm', ['-D', '--defined-only', binaryPath]],
        ]
      : platform === 'darwin'
        ? [
            ['otool', ['-L', binaryPath]],
            ['xcrun', ['vtool', '-show-build', binaryPath]],
            ['nm', ['-gU', binaryPath]],
          ]
        : [['dumpbin', ['/HEADERS', '/DEPENDENTS', ...(options.inference ? [] : ['/EXPORTS']), binaryPath]]];
  let output = '';
  let elfOutput = '';
  let definedSymbolsOutput = '';
  for (const [command, arguments_] of commands) {
    const result = yield* runCommandEffect(command, arguments_, {timeoutMs: 30_000, maxOutputBytes: 512 * 1024});
    output += result.stdout;
    if (command === 'readelf') elfOutput = result.stdout;
    if (command === 'nm') definedSymbolsOutput = result.stdout;
  }
  if (/(?:libsqlite3(?:\.so|\.dylib)|sqlite3\.dll)/iu.test(output))
    throw new Error('Native payload unexpectedly depends on external SQLite.');
  if (!options.inference && /\b_?sqlite3_[A-Za-z0-9_]+\b/u.test(output))
    throw new Error('Native vector reader unexpectedly exports private SQLite symbols.');
  if (platform === 'linux') {
    const versions = [...EffectString.matchAll(/\bGLIBC_(\d+)\.(\d+)/gu)(output)];
    if (
      EffectString.endsWith('-musl')(bunTarget) &&
      /\bGLIBC_/u.test(output) &&
      !(options.compilerLibgccProvider
        ? isMuslLibgccProvider(elfOutput, definedSymbolsOutput)
        : isMuslLibgccCompatibility(elfOutput, definedSymbolsOutput, bunTarget))
    ) {
      const names = (value: string) =>
        EffectArray.map([...EffectString.matchAll(/\bGLIBC_[A-Za-z0-9_.]+/gu)(value)], match => match[0]);
      const sample = (values: readonly string[]) => {
        const unique = EffectArray.dedupe(values);
        return {count: unique.length, values: EffectArray.map(EffectArray.take(unique, 8), EffectString.slice(0, 64))};
      };
      // Keep requirement identities separate from definitions and defined exports in the bounded failure report.
      const needs =
        /(?:^|\n)Version needs section[^\n]*\n([\s\S]*?)(?=\nVersion [^\n]+ section|$)/u.exec(elfOutput)?.[1] ?? '';
      const definitions =
        /(?:^|\n)Version definition section[^\n]*\n([\s\S]*?)(?=\nVersion [^\n]+ section|$)/u.exec(elfOutput)?.[1] ??
        '';
      const diagnostic = {
        target: EffectString.slice(0, 128)(bunTarget),
        domain: options.inference ? 'inference' : 'vector-reader',
        matchedVersions: sample(names(output)),
        requiredVersions: sample(names(needs)),
        definedVersions: sample(names(definitions)),
        definedSymbolVersions: sample(names(definedSymbolsOutput)),
        neededLibraries: sample(
          EffectArray.map(
            [...EffectString.matchAll(/\(NEEDED\)[^\r\n]*Shared library: \[([A-Za-z0-9_.+-]{1,128})\]/gu)(elfOutput)],
            match => match[1] ?? '',
          ),
        ),
        versionNeedFiles: sample(
          EffectArray.map(
            [...EffectString.matchAll(/\bFile: ([A-Za-z0-9_.+-]{1,128})(?=\s|$)/gu)(needs)],
            match => match[1] ?? '',
          ),
        ),
      };
      throw new Error(
        'Musl native payload contains GNU libc symbol dependencies. Bounded audit: ' +
          EffectString.slice(0, 4096)(JSON.stringify(diagnostic)),
      );
    }
    if (options.compilerLibgccProvider && !/\bGLIBC_/u.test(output))
      throw new Error('Compiler libgcc provider is missing its required compatibility namespace.');
    if (
      !EffectString.endsWith('-musl')(bunTarget) &&
      EffectArray.some(versions, match => Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) > 17))
    )
      throw new Error('Native payload raises the supported glibc 2.17 floor.');
  }
  if (platform === 'darwin') {
    const floor = options.inference ? 14 : 13;
    if (
      EffectArray.some(
        [...EffectString.matchAll(/\bminos\s+(\d+)(?:\.(\d+))?/gu)(output)],
        match => Number(match[1]) > floor || (Number(match[1]) === floor && Number(match[2] ?? 0) > 0),
      )
    )
      throw new Error(`Native payload raises the supported macOS ${floor}.0 floor.`);
  }
  if (
    platform === 'win32' &&
    (!options.inference || bunTarget === 'bun-windows-arm64') &&
    /\b(?:vcruntime\d*|msvcp\d*|msvcr\d*|msvcrt)(?:_[a-z0-9]+)?\.dll\b/iu.test(output)
  )
    throw new Error('Native payload requires an external Visual C++ runtime instead of the pinned static CRT.');
  return sha256HexSync(output);
});
