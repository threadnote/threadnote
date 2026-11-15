// oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import, effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-string -- This explicitly invoked offline construction tool owns raw Git/Go process and private filesystem boundaries; no product runtime imports it.
import {createHash} from 'node:crypto';
import {copyFile, cp, mkdir, mkdtemp, realpath, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, parse, relative, resolve, sep} from 'node:path';
import {
  runtimeCloseOwnedProviderTree,
  runtimeObserveOwnedProviderTree,
  runtimeSpawnOwnedProviderTree,
  runtimeTerminateOwnedProviderTree,
  runtimeReadBoundedStableRegularFile,
} from '@threadnote/platform/system';

/**
 * Pinned SDK construction resource and explicitly invoked offline builder.
 * Importing this module has no acquisition, process or environment side effects.
 * Only Darwin ARM64 was actually validated; other hosts remain unqualified.
 * Keep source-overlay provenance and upstream notices; never label it an official npm binary.
 */
export const typescriptNativeBuildRecipe = {
  schemaVersion: 1,
  status: 'pinned-source-executor',
  consumer: 'buildTypeScriptNativeAsset',
  purpose:
    'Pinned construction and validation specification; the explicit executor consumes a caller-supplied official source checkout and toolchain archive, then acquires the exact Go module graph once.',
  upstream: {
    repository: 'https://github.com/microsoft/TypeScript.git',
    commit: '3e9236361fa97a9e6c685f4833ac457ae2d8c50a',
    tree: '2a322d5d8eefb3b2f295c5ed6398de7237f6249a',
    version: '7.1.0-beta',
    moduleDirectory: 'tsc',
    goModSha256: '1e0963224f3096e3e8215acea83c033392c8135e7453b8a9680261baa5c18b25',
    goSumSha256: '00f7fee0307755fa8b871cd25a68b8c478341bc2b2af8731b2f2fc4da3739eee',
    submodules: 'none: exact commit contains no .gitmodules; do not resolve an arbitrary recursive dependency',
    bundled: {
      path: 'tsc/internal/bundled',
      gitTree: '651ade10e801903260ead249293bd322d76dbf09',
      trackedFileCount: 125,
      manifestSha256: '7bcf40cb353b0eee18d276b5e254ebb86552b9212480ad88fc92647c33885183',
      manifestAlgorithm:
        'SHA256 UTF8 concatenation in git ls-files order of path+NUL+fileSHA256+NUL+decimalByteLength+newline',
      copyrightNoticeSha256: 'f0dc63a96c37a7f08e97780a36bd84ae705b2e1786df4c1f2ae45dec3874f0f2',
      regenerate: false,
    },
  },
  overlay: {
    path: 'tools/semantic/typescript-native-protocol-exit.patch',
    sha256: 'd77c44ba1c93898f3e8dfbf7c88fd4aec896b0a21c4e1ff990b7083b9fecb322',
    files: [
      {
        path: 'tsc/internal/lsp/server.go',
        beforeSha256: 'f040b217b8b2d37c8906944e94fd9613a0c414b94af059cc24d1d0c0ae83b1b5',
        afterSha256: '075c1e2631d0a6caf5b6b452bb6132dbac98dcb98c12f212d2174bcbdcb66f48',
      },
      {
        path: 'tsc/internal/lsp/server_test.go',
        beforeSha256: '66124cf71b30b7325ff0bff0d263db33bb1281ade4e47a53699a66e4775daaa3',
        afterSha256: '4c71593b997514f646b452fe0b04f791c0d32f78af0afd67a599bc1407fffcdb',
      },
    ],
    distributionIdentity: 'source-overlay derivative; never official npm binary identity',
  },
  noExternalProcessOverlay: {
    path: 'tools/semantic/typescript-native-no-external-process.patch',
    sha256: 'c42a2a592f6ca91ba4fde182b67d574d9ca352b6d50dfe47a88ca3052dc838d1',
    files: [
      {
        path: 'tsc/cmd/tsc/lsp.go',
        beforeSha256: '3dc7774210e7a8ad09adc49f60ce14e85e82a11d2774fe041652a8fc02b5697d',
        afterSha256: 'e76fadd913272381e254c3d59b54f6e2c6186bab200781293ec82e72d56a9f6e',
      },
      {
        path: 'tsc/cmd/tsc/sys.go',
        beforeSha256: '41e7c4d7905a465314f4a541a902de5b84bcfae86dfc24c877f26fcff08caa0b',
        afterSha256: 'b1ed7459a75743ab7a5f7453e4c44542f2ab369cb58ff2d5e504dabc7b988ecd',
      },
      {
        path: 'tsc/cmd/tsc/lsp_external_process_test.go',
        beforeSha256: null,
        afterSha256: '371df62f78798870ad58307ce726dc5827a42d436814534bff121d1cc93566c1',
      },
    ],
  },
  orderedOverlayDigest: 'c9343bec1a4818ea4fa2a56ad0ac6037c8aebdbb904793df75e21eeeac3f2ce8',
  toolchain: {
    version: 'go1.27.4',
    metadataUrl: 'https://go.dev/dl/?mode=json&include=all',
    archives: [
      {
        filename: 'go1.27.4.darwin-amd64.tar.gz',
        os: 'darwin',
        arch: 'amd64',
        sha256: '2b799377704ef12db39bd254995d5c348c9cc8d86562ca817724390e56c38f43',
        size: 71756705,
        url: 'https://go.dev/dl/go1.27.4.darwin-amd64.tar.gz',
        qualification: 'not-qualified',
      },
      {
        filename: 'go1.27.4.darwin-arm64.tar.gz',
        os: 'darwin',
        arch: 'arm64',
        sha256: '91a44a2b8a716600ad94a4f143e156116620db8828086a6e3602291be9bd0bb4',
        size: 68231011,
        url: 'https://go.dev/dl/go1.27.4.darwin-arm64.tar.gz',
        qualification: 'validated',
      },
      {
        filename: 'go1.27.4.linux-amd64.tar.gz',
        os: 'linux',
        arch: 'amd64',
        sha256: '7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840',
        size: 70680823,
        url: 'https://go.dev/dl/go1.27.4.linux-amd64.tar.gz',
        qualification: 'not-qualified',
      },
      {
        filename: 'go1.27.4.linux-arm64.tar.gz',
        os: 'linux',
        arch: 'arm64',
        sha256: '3392582988a273a87ab5043ee1b2c9c17a2c3c00580bf9326c47a2e0aaaeac92',
        size: 67129258,
        url: 'https://go.dev/dl/go1.27.4.linux-arm64.tar.gz',
        qualification: 'not-qualified',
      },
      {
        filename: 'go1.27.4.windows-amd64.zip',
        os: 'windows',
        arch: 'amd64',
        sha256: '178ab98950ac69ab25069307dc6ade79f3816e414cce95b4da166a115cde1e7e',
        size: 79077744,
        url: 'https://go.dev/dl/go1.27.4.windows-amd64.zip',
        qualification: 'not-qualified',
      },
      {
        filename: 'go1.27.4.windows-arm64.zip',
        os: 'windows',
        arch: 'arm64',
        sha256: '9e7a72565792b8ab370b37ac9ac109799237abacb39ff2f541c438b963c0cc64',
        size: 75172694,
        url: 'https://go.dev/dl/go1.27.4.windows-arm64.zip',
        qualification: 'not-qualified',
      },
    ],
    select:
      'Exact current host OS/architecture archive only; no version fallback or automatic toolchain download. Archive paths/types/links and SHA256 must be checked before extraction.',
    executables: {
      unix: 'go/bin/go',
      windows: 'go/bin/go.exe',
    },
    racePrerequisite:
      'Existing compatible host C compiler/race support: retain actual compiler identity and fail if missing; no automatic compiler installation.',
  },
  workspacePolicy: [
    'All source, candidate, HOME/TMP and Go caches live under a caller-owned private construction root outside production/default homes. Never mutate input SDK/source or global Go config.',
    'Fetch exact upstream commit and verify HEAD/tree/clean source, then copy its tracked tree to a separate candidate. Validate no unsafe archive paths/links if an equivalent source archive is used.',
    'Verify modules, bundled subtree and both ordered patch hashes; require every tracked before/after hash and exactly the one new host-refusal test file.',
    'No go generate, latest dependency, loose patch application or unstamped generated-library replacement.',
    'Acquire only exact Go module graph once with checksum verification. Capture additive checksum records outside source; restore exact original go.sum before offline validation. Never upgrade versions.',
  ],
  environment: {
    GOTOOLCHAIN: 'local',
    GOENV: 'off',
    GOWORK: 'off',
    GOFLAGS: '-mod=readonly',
    GOMAXPROCS: '2',
    GOPROXY: 'off',
    GOSUMDB: 'off',
    HOME: 'PRIVATE_ROOT/home',
    TMPDIR: 'PRIVATE_ROOT/tmp',
    GOCACHE: 'PRIVATE_ROOT/go-cache',
    GOMODCACHE: 'PRIVATE_ROOT/module-cache',
    GOPATH: 'PRIVATE_ROOT/gopath',
  },
  onlineModuleAcquisition: {
    environment: {
      GOPROXY: 'https://proxy.golang.org',
      GOSUMDB: 'sum.golang.org',
    },
    argv: ['go', 'mod', 'download', '-json', 'all'],
    then: 'Verify exact modules; restore original go.sum; use only offline commands below.',
  },
  offlineCommands: {
    cwd: 'CANDIDATE_SOURCE/tsc',
    format: [
      'gofmt',
      '-l',
      'internal/lsp/server.go',
      'internal/lsp/server_test.go',
      'cmd/tsc/lsp.go',
      'cmd/tsc/sys.go',
      'cmd/tsc/lsp_external_process_test.go',
    ],
    modules: ['go', 'mod', 'verify'],
    focused: [
      'go',
      'test',
      '-p=2',
      '-mod=readonly',
      '-count=1',
      '-timeout=60s',
      './internal/lsp',
      '-run',
      'TestServerProtocolExit|TestServerShutdownNoDeadlock|TestWriteLoopRecoversFromUnserializableResponse',
    ],
    race: [
      'go',
      'test',
      '-p=2',
      '-mod=readonly',
      '-race',
      '-count=1',
      '-timeout=60s',
      './internal/lsp',
      '-run',
      'TestServerProtocolExit',
    ],
    hostFocused: [
      'go',
      'test',
      '-p=2',
      '-mod=readonly',
      '-count=1',
      '-timeout=60s',
      './cmd/tsc',
      '-run',
      'TestLSPHostDeniesExternalProcesses|TestAPISystemDeniesExternalProcesses',
    ],
    hostRace: [
      'go',
      'test',
      '-p=2',
      '-mod=readonly',
      '-race',
      '-count=1',
      '-timeout=60s',
      './cmd/tsc',
      '-run',
      'TestLSPHostDeniesExternalProcesses|TestAPISystemDeniesExternalProcesses',
    ],
    build: [
      'go',
      'build',
      '-p=2',
      '-mod=readonly',
      '-trimpath',
      '-buildvcs=false',
      '-o',
      'DERIVED_EXECUTABLE',
      './cmd/tsc',
    ],
    version: ['DERIVED_EXECUTABLE', '--version'],
    bounds:
      'Use existing owned-process controls; compile/build and race commands were bounded at240s externally, test execution60s. Observe original child/group termination and pipeEOF; timeout/forced/unknown is failure, not success. No build before focused/race pass.',
  },
  provenanceRequired: [
    'Base commit/tree, actual source overlay and file digests, exact toolchain archive/executable, Go module graph/checksums and bundled library digests.',
    'Actual commands/flags/terminal results and host C compiler for race; actual output binary/hash/platform and version, not a borrowed npm digest.',
    'Retain original licenses/notices and all failures. A version string/hash/test pass is not complete production authority or platform qualification.',
  ],
  attribution: {
    typescript:
      'Microsoft TypeScript7.1.0-beta source, Apache-2.0. Retain source LICENSE.txt, NOTICE.txt, tsc/LICENSE and bundled CopyrightNotice.txt. Ordered local overlays correct protocol exit/cancellation and deny external process callbacks, with focused upstream host tests.',
    go: 'Go Authors toolchain/runtime, BSD-3-Clause; retain original Go LICENSE.',
    thirdParty:
      'Preserve applicable module licenses/notices; complete static-link redistribution/legal closure remains mandatory before release. These attributions do not replace license texts.',
  },
  observedValidation: {
    platform: 'darwin-arm64',
    officialBinary: false,
    sourceOverlay: 'validated ordered private source overlays only',
    focusedGo: 'pass',
    targetedRace: 'pass',
    nativeVersion: '7.1.0-beta; exit0; originalgroup absent/stdiosEOF',
    originalFunctionalProbe:
      'definition/references/complete unsaved rename/disk nonmutation and strict exit0/no panic/no force/originalgroup drain/stdioEOF passed once',
    portableExecutorTested: false,
    otherPlatforms: 'not-qualified',
    releaseOrGA: 'not-qualified',
    performance: 'No speed comparison or benchmark; operational validation only.',
  },
} as const;

/** Read-only refusal before clean, generation or release staging can alter a supplied asset. */
export async function assertNativeTypeScriptAssetOutsideReleaseOutput(
  assetDirectory: string | undefined,
  repositoryRoot: string,
): Promise<void> {
  if (!assetDirectory) return;
  const sourceInput = resolve(assetDirectory);
  const source = await realpath(sourceInput);
  const root = await realpath(repositoryRoot);
  const outputInput = resolve(repositoryRoot, 'dist');
  const output = join(root, 'dist');
  let outputReal = output;
  try {
    outputReal = await realpath(output);
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  if (
    [sourceInput, source].some(candidate =>
      [outputInput, output, outputReal].some(
        protectedPath => contains(candidate, protectedPath) || contains(protectedPath, candidate),
      ),
    )
  )
    throw new Error('Native TypeScript source and release output overlap.');
  let ancestor = parse(sourceInput).root;
  for (const part of relative(ancestor, sourceInput).split(sep)) {
    if (!part) continue;
    ancestor = join(ancestor, part);
    const bound = await realpath(ancestor);
    if (contains(outputInput, bound) || contains(output, bound) || contains(outputReal, bound))
      throw new Error('Native TypeScript source aliases the release output.');
  }
}

export interface TypeScriptNativeBuildInput {
  /** A clean, already acquired checkout of the exact official commit. */
  readonly officialSource: string;
  /** The exact official pinned Go archive for this host. */
  readonly toolchainArchive: string;
  /** Optional preacquired pinned module cache; copied into the private build root. */
  readonly moduleCache?: string;
  /** Fresh caller-owned root. No default home or shared Go cache is used. */
  readonly privateRoot: string;
  readonly repositoryRoot: string;
}

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const exact = async (file: string, digest: string, maximumBytes = 4 * 1024 * 1024) => {
  const bytes = await runtimeReadBoundedStableRegularFile(file, maximumBytes);
  if (hash(bytes) !== digest) throw new Error('Pinned native TypeScript input changed.');
  return bytes;
};
const wait = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));

/** A command owns its original native process tree, both pipes and its finite deadline. */
async function command(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  milliseconds: number,
): Promise<string> {
  const owner = runtimeSpawnOwnedProviderTree({command: executable, args, cwd, environment});
  let bytes = 0,
    overflow = false,
    pumpFailure: unknown,
    pumpSettled = false;
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 256 * 1024) overflow = true;
      if (!overflow) chunks.push(next.value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  };
  const output = Promise.all([collect(owner.stdout), collect(owner.stderr)]).then(
    value => {
      pumpSettled = true;
      return value;
    },
    error => {
      pumpFailure = error;
      pumpSettled = true;
      return ['', ''] as [string, string];
    },
  );
  const deadline = performance.now() + milliseconds;
  try {
    await owner.closeInput();
    let observation = runtimeObserveOwnedProviderTree(owner.handle);
    while (observation.state !== 'drained' && performance.now() < deadline) {
      if (pumpFailure !== undefined) throw new Error('Native TypeScript build output pump failed.');
      await wait(20);
      observation = runtimeObserveOwnedProviderTree(owner.handle);
    }
    if (observation.state !== 'drained') throw new Error('Native TypeScript build command did not drain.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Native TypeScript build pipes did not close.')),
        Math.max(0, deadline - performance.now()),
      );
    });
    let stdout: string, stderr: string;
    try {
      [stdout, stderr] = await Promise.race([output, expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (pumpFailure !== undefined || overflow)
      throw new Error('Native TypeScript build output was incomplete or excessive.');
    if (!observation.stdioClosed || observation.leaderExitCode !== 0)
      throw new Error(
        `Native TypeScript build command failed: ${basename(executable)} (${observation.leaderExitCode ?? 'unknown'}).`,
      );
    runtimeCloseOwnedProviderTree(owner.handle);
    return stdout + stderr;
  } catch (error) {
    try {
      let observation = runtimeObserveOwnedProviderTree(owner.handle);
      if (observation.state !== 'drained') {
        runtimeTerminateOwnedProviderTree(owner.handle, 'terminate');
        const grace = performance.now() + 1000;
        while (observation.state !== 'drained' && performance.now() < grace) {
          await wait(20);
          observation = runtimeObserveOwnedProviderTree(owner.handle);
        }
        if (observation.state !== 'drained') {
          runtimeTerminateOwnedProviderTree(owner.handle, 'kill');
          const killed = performance.now() + 2000;
          while (observation.state !== 'drained' && performance.now() < killed) {
            await wait(20);
            observation = runtimeObserveOwnedProviderTree(owner.handle);
          }
        }
      }
      if (observation.state === 'drained' && observation.stdioClosed && pumpSettled)
        runtimeCloseOwnedProviderTree(owner.handle);
    } catch {
      // Unknown ownership remains a failure and the native capability is retained.
    }
    throw error;
  }
}

/** Never selects or downloads a compiler/toolchain. Module acquisition uses the pinned go.mod graph only. */
export async function buildTypeScriptNativeAsset(input: TypeScriptNativeBuildInput): Promise<string> {
  const {upstream, overlay, noExternalProcessOverlay, orderedOverlayDigest, toolchain, offlineCommands} =
    typescriptNativeBuildRecipe;
  const orderedDescriptor = {
    domain: 'threadnote-typescript-native-ordered-overlays-v1',
    sourceCommit: upstream.commit,
    overlays: [
      {path: overlay.path, sha256: overlay.sha256},
      {path: noExternalProcessOverlay.path, sha256: noExternalProcessOverlay.sha256},
    ],
  };
  if (hash(new TextEncoder().encode(JSON.stringify(orderedDescriptor))) !== orderedOverlayDigest)
    throw new Error('Native TypeScript ordered overlay identity differs.');
  if (
    ![input.officialSource, input.toolchainArchive, input.privateRoot, input.repositoryRoot].every(isAbsolute) ||
    (input.moduleCache !== undefined && !isAbsolute(input.moduleCache)) ||
    !['darwin', 'linux'].includes(process.platform) ||
    !['arm64', 'x64'].includes(process.arch)
  )
    throw new Error('Native TypeScript build host or input paths are unsupported.');
  const hostArch = process.arch === 'x64' ? 'amd64' : 'arm64';
  const archive = toolchain.archives.find(item => item.os === process.platform && item.arch === hostArch);
  if (!archive) throw new Error('Native TypeScript toolchain has no pinned host archive.');
  const root = await realpath(input.privateRoot);
  const overlaps = (other: string) => root === other || root.startsWith(other + sep) || other.startsWith(root + sep);
  const related = await Promise.all(
    [input.officialSource, input.toolchainArchive, input.repositoryRoot, input.moduleCache]
      .filter((value): value is string => value !== undefined)
      .map(value => realpath(value)),
  );
  if (related.some(overlaps)) throw new Error('Native TypeScript private root overlaps an input.');
  const staging = await mkdtemp(join(root, 'native-ts71-'));
  const home = join(staging, 'home');
  const temporary = join(staging, 'tmp');
  const candidate = join(staging, 'candidate');
  const payload = join(staging, 'payload');
  for (const directory of [home, temporary, payload, join(staging, 'go-cache'), join(staging, 'module-cache')])
    await mkdir(directory, {recursive: true, mode: 0o700});
  if (input.moduleCache) await cp(await realpath(input.moduleCache), join(staging, 'module-cache'), {recursive: true});
  const git = Bun.which('git');
  if (!git) throw new Error('A Git executable is required for exact source verification.');
  const toolchainInput = await realpath(input.toolchainArchive);
  const archiveInfo = await stat(toolchainInput);
  if (!archiveInfo.isFile() || archiveInfo.size !== archive.size)
    throw new Error('Native TypeScript Go archive size differs.');
  const toolchainBytes = await exact(toolchainInput, archive.sha256, archive.size);
  const tar = Bun.which('tar');
  if (!tar) throw new Error('An archive extractor is required.');
  const go = join(staging, 'go', 'bin', 'go');
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    TMPDIR: temporary,
    PATH: `${dirname(go)}:/usr/bin:/bin`,
    GOENV: 'off',
    GOTOOLCHAIN: 'local',
    GOWORK: 'off',
    GOFLAGS: '-mod=readonly',
    GOMAXPROCS: '2',
    GOPROXY: 'off',
    GOSUMDB: 'off',
    GOCACHE: join(staging, 'go-cache'),
    GOMODCACHE: join(staging, 'module-cache'),
    GOPATH: join(staging, 'gopath'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  const gitIn = (cwd: string, args: readonly string[]) => command(git, args, cwd, env, 30000);
  const privateArchive = join(staging, archive.filename);
  await writeFile(privateArchive, toolchainBytes, {mode: 0o400});
  await command(tar, ['-xzf', privateArchive, '-C', staging], staging, env, 60000);
  const source = await realpath(input.officialSource);
  if ((await gitIn(source, ['rev-parse', 'HEAD'])).trim() !== upstream.commit)
    throw new Error('Official TypeScript commit differs.');
  if ((await gitIn(source, ['rev-parse', 'HEAD^{tree}'])).trim() !== upstream.tree)
    throw new Error('Official TypeScript tree differs.');
  if ((await gitIn(source, ['status', '--porcelain'])).trim()) throw new Error('Official TypeScript source is dirty.');
  await gitIn(staging, ['clone', '--no-local', '--no-hardlinks', '--no-checkout', source, candidate]);
  await gitIn(candidate, ['checkout', '--detach', upstream.commit]);
  await exact(join(candidate, 'tsc', 'go.mod'), upstream.goModSha256);
  await exact(join(candidate, 'tsc', 'go.sum'), upstream.goSumSha256);
  const bundledPaths = (await gitIn(candidate, ['ls-files', '-z', '--', upstream.bundled.path]))
    .split('\0')
    .filter(Boolean);
  if (bundledPaths.length !== upstream.bundled.trackedFileCount)
    throw new Error('Native TypeScript bundled source inventory differs.');
  const bundledManifest = createHash('sha256');
  for (const file of bundledPaths) {
    const bytes = await runtimeReadBoundedStableRegularFile(join(candidate, file), 4 * 1024 * 1024);
    bundledManifest.update(`${file}\0${hash(bytes)}\0${bytes.byteLength}\n`);
  }
  if (bundledManifest.digest('hex') !== upstream.bundled.manifestSha256)
    throw new Error('Native TypeScript bundled source bytes differ.');
  await exact(join(candidate, upstream.bundled.path, 'CopyrightNotice.txt'), upstream.bundled.copyrightNoticeSha256);
  const patchBytes = await exact(join(input.repositoryRoot, overlay.path), overlay.sha256, 64 * 1024);
  const patch = join(staging, 'typescript-native-protocol-exit.patch');
  await writeFile(patch, patchBytes, {mode: 0o400});
  for (const file of overlay.files) await exact(join(candidate, file.path), file.beforeSha256);
  await gitIn(candidate, ['apply', '--check', patch]);
  await gitIn(candidate, ['apply', patch]);
  for (const file of overlay.files) await exact(join(candidate, file.path), file.afterSha256);
  const noExternalPatchBytes = await exact(
    join(input.repositoryRoot, noExternalProcessOverlay.path),
    noExternalProcessOverlay.sha256,
    64 * 1024,
  );
  const noExternalPatch = join(staging, 'typescript-native-no-external-process.patch');
  await writeFile(noExternalPatch, noExternalPatchBytes, {mode: 0o400});
  for (const file of noExternalProcessOverlay.files) {
    if (file.beforeSha256 === null) {
      if (await Bun.file(join(candidate, file.path)).exists())
        throw new Error('Native TypeScript new host-refusal test already exists.');
    } else await exact(join(candidate, file.path), file.beforeSha256);
  }
  await gitIn(candidate, ['apply', '--check', noExternalPatch]);
  await gitIn(candidate, ['apply', noExternalPatch]);
  for (const file of noExternalProcessOverlay.files) await exact(join(candidate, file.path), file.afterSha256);
  const modified = (await gitIn(candidate, ['diff', '--name-only'])).trim().split('\n').sort();
  const expectedModified = [
    ...overlay.files.map(file => file.path),
    ...noExternalProcessOverlay.files.filter(file => file.beforeSha256 !== null).map(file => file.path),
  ].sort();
  if (JSON.stringify(modified) !== JSON.stringify(expectedModified))
    throw new Error('Native TypeScript overlay changed unexpected tracked source.');
  const newFiles = (await gitIn(candidate, ['ls-files', '--others'])).trim().split('\n').sort();
  if (
    JSON.stringify(newFiles) !==
    JSON.stringify(
      noExternalProcessOverlay.files
        .filter(file => file.beforeSha256 === null)
        .map(file => file.path)
        .sort(),
    )
  )
    throw new Error('Native TypeScript overlay introduced untracked or ignored source.');
  const version = (await command(go, ['version'], candidate, env, 10000)).trim();
  if (version !== `go version ${toolchain.version} ${process.platform}/${hostArch}`)
    throw new Error('Native TypeScript Go toolchain version differs.');
  const module = join(candidate, upstream.moduleDirectory);
  const originalGoSum = await runtimeReadBoundedStableRegularFile(join(module, 'go.sum'), 1024 * 1024);
  await command(
    go,
    ['mod', 'download', '-json', 'all'],
    module,
    input.moduleCache
      ? {...env, GOFLAGS: ''}
      : {...env, GOFLAGS: '', GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org'},
    120000,
  );
  await writeFile(join(module, 'go.sum'), originalGoSum);
  await exact(join(module, 'go.sum'), upstream.goSumSha256);
  await command(go, offlineCommands.modules.slice(1), module, env, 60000);
  await command(go, offlineCommands.focused.slice(1), module, env, 240000);
  await command(go, offlineCommands.race.slice(1), module, env, 240000);
  await command(go, offlineCommands.hostFocused.slice(1), module, env, 240000);
  await command(go, offlineCommands.hostRace.slice(1), module, env, 240000);
  const binary = join(payload, 'tsc');
  await command(go, [...offlineCommands.build.slice(1, -2), binary, './cmd/tsc'], module, env, 240000);
  const output = (await command(binary, ['--version'], module, env, 10000)).trim();
  if (output !== `Version ${upstream.version}`) throw new Error('Native TypeScript binary version differs.');
  const bytes = await runtimeReadBoundedStableRegularFile(binary, 128 * 1024 * 1024);
  if (bytes.byteLength === 0) throw new Error('Native TypeScript binary exceeds its bound.');
  const provenance = {
    kind: 'private-source-overlay',
    baseVersion: upstream.version,
    officialSourceCommit: upstream.commit,
    officialSourceTree: upstream.tree,
    sourceOverlaySha256: orderedOverlayDigest,
    platform: `${process.platform}-${process.arch}`,
    binarySha256: hash(bytes),
    binaryBytes: bytes.byteLength,
    officialNpmBinary: false,
    focusedTestsPass: true,
    raceTestsPass: true,
    versionOnlyPass: true,
    qualification:
      'Constructed from pinned source with one explicit module acquisition; platform runtime/API and release gates remain separate.',
  };
  await writeFile(join(payload, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  await copyFile(join(candidate, 'LICENSE.txt'), join(payload, 'TYPESCRIPT_LICENSE.txt'));
  await copyFile(join(candidate, 'NOTICE.txt'), join(payload, 'TYPESCRIPT_NOTICE.txt'));
  await copyFile(join(candidate, 'tsc', 'LICENSE'), join(payload, 'TSC_LICENSE.txt'));
  await copyFile(
    join(candidate, 'tsc', 'internal', 'bundled', 'CopyrightNotice.txt'),
    join(payload, 'BUNDLED_NOTICE.txt'),
  );
  await copyFile(join(staging, 'go', 'LICENSE'), join(payload, 'GO_LICENSE.txt'));
  return payload;
}

/** Materialize the already validated Darwin candidate without re-running Go or inventing a new qualification result. */
export async function assembleValidatedTypeScriptNativeAsset(input: {
  readonly evidenceRoot: string;
  readonly goLicense: string;
  readonly privateRoot: string;
}): Promise<string> {
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    ![input.evidenceRoot, input.goLicense, input.privateRoot].every(isAbsolute)
  )
    throw new Error('Validated native TypeScript payload is limited to the observed Darwin ARM64 host.');
  const evidence = await realpath(input.evidenceRoot);
  const privateRoot = await realpath(input.privateRoot);
  if (evidence === privateRoot || evidence.startsWith(privateRoot + sep) || privateRoot.startsWith(evidence + sep))
    throw new Error('Validated native TypeScript evidence and output overlap.');
  const pinned = async (file: string, sha256: string, maximum: number) => {
    const bytes = await runtimeReadBoundedStableRegularFile(file, maximum);
    if (hash(bytes) !== sha256) throw new Error('Validated native TypeScript receipt or payload differs.');
    return bytes;
  };
  const validationManifest = await pinned(
    join(evidence, 'final-freeze-v1', 'manifest.json'),
    '9f5c2932cd2e45c5e2b98b97f0cd43129b1e1f6d464ede7b883886375611aea1',
    64 * 1024,
  );
  await pinned(
    join(evidence, 'final-freeze-v1', 'receipt-binding-and-next-step.json'),
    '4b77b1708eab24ea1c9cebcdb912b8404c61a2744a593afef7e03cd4cc017868',
    64 * 1024,
  );
  await pinned(
    join(evidence, 'validation-v1', 'probe-01', 'report.json'),
    '72e6dc8831dea02bae78b0c8a82b5ff0eacc2394c63df53aa21af9d2769b8aef',
    64 * 1024,
  );
  const binary = await pinned(
    join(evidence, 'validation-v1', 'payload', 'tsc'),
    '28eb8b850cde747a69589e9dc2c3348b2083c21b9de6db99ec6d7a456260f2a3',
    128 * 1024 * 1024,
  );
  const notices = await Promise.all(
    [
      ['LICENSE.txt', 'TYPESCRIPT_LICENSE.txt', 'a7d00bfd54525bc694b6e32f64c7ebcf5e6b7ae3657be5cc12767bce74654a47'],
      ['tsc/LICENSE', 'TSC_LICENSE.txt', 'a7d00bfd54525bc694b6e32f64c7ebcf5e6b7ae3657be5cc12767bce74654a47'],
      ['NOTICE.txt', 'TYPESCRIPT_NOTICE.txt', '317cd4d9d8a4de4971222bd232bc45c010424bf0dae61be830e49532e62e4d33'],
      [
        'tsc/internal/bundled/CopyrightNotice.txt',
        'BUNDLED_NOTICE.txt',
        typescriptNativeBuildRecipe.upstream.bundled.copyrightNoticeSha256,
      ],
    ].map(async ([source, name, sha256]) => ({
      name,
      bytes: await pinned(join(evidence, 'validation-v1', 'candidate', source), sha256, 128 * 1024),
    })),
  );
  notices.push({
    name: 'GO_LICENSE.txt',
    bytes: await pinned(
      input.goLicense,
      '911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad',
      128 * 1024,
    ),
  });
  const field = (value: unknown, name: string): unknown =>
    typeof value === 'object' && value !== null && name in value ? Reflect.get(value, name) : undefined;
  const commands = field(JSON.parse(new TextDecoder().decode(validationManifest)), 'commands');
  const passed = (name: string) => field(field(commands, name), 'exit') === 0;
  if (!passed('module-verify') || !passed('focused') || !passed('race') || !passed('build') || !passed('version'))
    throw new Error('Validated native TypeScript command receipt is incomplete.');
  const payload = join(privateRoot, 'payload');
  await mkdir(payload, {mode: 0o700});
  await writeFile(join(payload, 'tsc'), binary, {mode: 0o700});
  for (const notice of notices) await writeFile(join(payload, notice.name), notice.bytes, {mode: 0o600});
  // These historical pass fields are derived only from the exact pinned final validation receipt above.
  // They describe the private candidate; the release stager separately checks source and executable bytes.
  await writeFile(
    join(payload, 'provenance.json'),
    `${JSON.stringify(
      {
        kind: 'private-source-overlay',
        baseVersion: typescriptNativeBuildRecipe.upstream.version,
        officialSourceCommit: typescriptNativeBuildRecipe.upstream.commit,
        officialSourceTree: typescriptNativeBuildRecipe.upstream.tree,
        sourceOverlaySha256: typescriptNativeBuildRecipe.orderedOverlayDigest,
        platform: 'darwin-arm64',
        binarySha256: hash(binary),
        binaryBytes: binary.byteLength,
        officialNpmBinary: false,
        focusedTestsPass: passed('focused'),
        raceTestsPass: passed('race'),
        versionOnlyPass: passed('version'),
        qualification: 'Private validation receipt only; integrated product, other platforms and release remain gated.',
      },
      null,
      2,
    )}\n`,
    {mode: 0o600},
  );
  return payload;
}

if (import.meta.main) {
  if (process.argv[2] === '--assemble-validated') {
    const [evidenceRoot, goLicense, privateRoot] = process.argv.slice(3);
    if (!evidenceRoot || !goLicense || !privateRoot)
      throw new Error(
        'Usage: bun build-typescript-native.ts --assemble-validated EVIDENCE_ROOT GO_LICENSE PRIVATE_ROOT',
      );
    process.stdout.write(`${await assembleValidatedTypeScriptNativeAsset({evidenceRoot, goLicense, privateRoot})}\n`);
  } else {
    const [officialSource, toolchainArchive, privateRoot, repositoryRoot, moduleCache] = process.argv.slice(2);
    if (!officialSource || !toolchainArchive || !privateRoot || !repositoryRoot)
      throw new Error(
        'Usage: bun build-typescript-native.ts OFFICIAL_SOURCE GO_ARCHIVE PRIVATE_ROOT REPOSITORY_ROOT [MODULE_CACHE]',
      );
    process.stdout.write(
      `${await buildTypeScriptNativeAsset({officialSource, toolchainArchive, privateRoot, repositoryRoot, moduleCache})}\n`,
    );
  }
}
