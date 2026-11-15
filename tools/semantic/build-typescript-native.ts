// oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import, effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-string -- This explicitly invoked offline construction tool owns raw Git/Go process and private filesystem boundaries; no product runtime imports it.
import {createHash} from 'node:crypto';
import {chmod, copyFile, cp, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
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
  apiPipeLifecycleOverlay: {
    path: 'tools/semantic/typescript-native-api-pipe-lifecycle.patch',
    sha256: '9b284492cd4781125607f31de9489faebead13e05724aee4d62f25f9f9893340',
    files: [
      {
        path: 'tsc/cmd/tsc/api.go',
        beforeSha256: '9aa01d0c0e5e531edfb2f39aa2bab00e44b8eb239bd756f7cfbffb2693a72ad3',
        afterSha256: 'd5fa9f01bf113d06a769915efbeee8025ad5893ac30211c371c4f9723da624f2',
      },
      {
        path: 'tsc/internal/api/server.go',
        beforeSha256: 'db8612da28b59416d8e5b7d48bc15f74923b6665d150b27d3e3aeac7c516a5ec',
        afterSha256: 'e838bfb6c45643d94d4fff2767360cc31ec1a84adacd53cfeabbcfd342d0ebca',
      },
      {
        path: 'tsc/internal/api/server_test.go',
        beforeSha256: 'dbd16032cb7a46940bf8db79ee21944e4f0d0db1a7860b7b47a95042239b9bdc',
        afterSha256: '1e288c6e5afbca9f1c969c63b47e68912b70db620e52296787af4eed696e052d',
      },
      {
        path: 'tsc/internal/ipc/transport.go',
        beforeSha256: 'bd5c6d86a4692de217182bebff90667684f5350976edc6d29f96c52b5f7329ab',
        afterSha256: '9d57325d2ccf06d505b3b6e770155f9f794f63815d77ce1054c1cce0ec79eb58',
      },
      {
        path: 'tsc/internal/ipc/transport_unix.go',
        beforeSha256: '11a302dc07a04664e61c7f868969cc72ab87906b144ee6d65428c8880baf52e3',
        afterSha256: '03463c92e288cd7f1d88b1e31aae7dd3420502a2c451e622cdc39cf01126e761',
      },
      {
        path: 'tsc/internal/ipc/transport_unix_test.go',
        beforeSha256: '9e3b2d95760f1a4093703609af03f7a5e62910847ec34e0f13fd194e5dc9f6b0',
        afterSha256: 'eb963e5d7f95c2d8a0a2dbe06eede177b18858f6e9177b7df4696953a71ff8e6',
      },
      {
        path: 'tsc/internal/ipc/transport_windows.go',
        beforeSha256: 'c6d0d74dd86380621b60ee4d0011f18eea967cbe37375e3387b5e0f2a1049802',
        afterSha256: '928140b44d67e93b6a4909f0e69e2510a9176f3f75578e7e7737c6256d6bf2e1',
      },
      {
        path: 'tsc/internal/ipc/transport_windows_test.go',
        beforeSha256: '6cea035970e115896a3dfc92160f39029d8eb17d5bf3ae9a15df818306ea9827',
        afterSha256: '9f2bb17a904768e3d1b3b1280b1bebfbd9ef141ef9e3ad9bfb81b31f0efa09bb',
      },
      {
        path: 'tsc/internal/lsp/server.go',
        beforeSha256: '075c1e2631d0a6caf5b6b452bb6132dbac98dcb98c12f212d2174bcbdcb66f48',
        afterSha256: '138a4aebbecadc9ac0afabaa5276900f43613aa2508243544ce68e47cffa1e1c',
      },
      {
        path: 'tsc/internal/lsp/server_test.go',
        beforeSha256: '4c71593b997514f646b452fe0b04f791c0d32f78af0afd67a599bc1407fffcdb',
        afterSha256: '41594760eb1c61bafa0d3442e7d7b4787f391c0a4b08583dceb9c00d8b1dc764',
      },
    ],
  },
  orderedOverlayDigest: '3ec77e4026b698c701b60fe34238a9ac83eaa73ad33679430fb3bafcef5e607d',
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
    'Source, candidate, HOME and Go caches live under a caller-owned private construction root outside production/default homes. Go socket tests alone use a short private 0700 system-temp directory to fit the Unix socket address bound; retain it on failed or unknown construction.',
    'Fetch exact upstream commit and verify HEAD/tree/clean source, then copy its tracked tree to a separate candidate. Validate no unsafe archive paths/links if an equivalent source archive is used.',
    'Verify modules, bundled subtree and all three ordered patch hashes; require every tracked before/after hash and exactly the one new host-refusal test file.',
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
      'internal/api/server.go',
      'internal/api/server_test.go',
      'internal/ipc/transport.go',
      'internal/ipc/transport_unix.go',
      'internal/ipc/transport_unix_test.go',
      'internal/ipc/transport_windows.go',
      'internal/ipc/transport_windows_test.go',
      'cmd/tsc/api.go',
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
      './internal/api',
      './internal/ipc',
      './internal/lsp',
      './cmd/tsc',
      '-run',
      'TestPipe|TestServerRunError|TestServerAPI|TestAPISystemDeniesExternalProcesses|TestLSPHostDeniesExternalProcesses|TestServerProtocolExit|TestServerShutdownNoDeadlock|TestWriteLoopRecoversFromUnserializableResponse',
    ],
    race: [
      'go',
      'test',
      '-p=2',
      '-mod=readonly',
      '-race',
      '-count=1',
      '-timeout=60s',
      './internal/api',
      './internal/ipc',
      './internal/lsp',
      './cmd/tsc',
      '-run',
      'TestPipe|TestServerRunError|TestServerAPI|TestAPISystemDeniesExternalProcesses|TestLSPHostDeniesExternalProcesses|TestServerProtocolExit|TestServerShutdownNoDeadlock|TestWriteLoopRecoversFromUnserializableResponse',
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
      'Microsoft TypeScript7.1.0-beta source, Apache-2.0. Retain source LICENSE.txt, NOTICE.txt, tsc/LICENSE and bundled CopyrightNotice.txt. Ordered local overlays correct protocol exit/cancellation, deny external process callbacks and retain the original API pipe lifecycle, with focused upstream host tests.',
    go: 'Go Authors toolchain/runtime, BSD-3-Clause; retain original Go LICENSE.',
    thirdParty:
      'Preserve applicable module licenses/notices; complete static-link redistribution/legal closure remains mandatory before release. These attributions do not replace license texts.',
  },
  observedValidation: {
    platform: 'darwin-arm64',
    officialBinary: false,
    sourceOverlay: 'Prior two-overlay Darwin derivative validated; third lifecycle overlay awaits construction.',
    focusedGo: 'Prior derivative pass; third-overlay upstream focused checks separately passed.',
    targetedRace: 'Prior derivative pass; third-overlay upstream race separately passed.',
    nativeVersion: 'Prior binary28eb only; no third-overlay binary identity yet.',
    originalFunctionalProbe:
      'Prior binary28eb passed definition/references/complete unsaved rename/disk nonmutation and strict exit0/no panic/no force/originalgroup drain/stdioEOF once; third overlay must repeat strict probe.',
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

/** Derives the shipped frontend from the exact installed SDK without changing that installation. */
export async function stageNativeTypeScriptFrontendSdk(
  sourceDirectory: string,
  destinationDirectory: string,
  repositoryRoot: string,
): Promise<void> {
  const source = resolve(sourceDirectory);
  const destination = resolve(destinationDirectory);
  const parent = dirname(destination);
  const repository = resolve(repositoryRoot);
  if (
    (await realpath(source)) !== source ||
    (await realpath(parent)) !== parent ||
    (await realpath(repository)) !== repository ||
    source === destination ||
    relative(source, destination) === '' ||
    (!relative(source, destination).startsWith(`..${sep}`) && relative(source, destination) !== '..') ||
    (!relative(destination, source).startsWith(`..${sep}`) && relative(destination, source) !== '..')
  )
    throw new Error('Native TypeScript frontend input and output must be separate canonical trees.');
  try {
    await stat(destination);
    throw new Error('Native TypeScript derived frontend output must be fresh.');
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const frontend = {
    patchSha256: '2d85454eb544d731610470668ec2a2e8b4153b328323ecf3c66a81c9b73dfba2',
    distBeforeSha256: '629dc5e5978c15f93453084e2da86841a21a044d2ff38bcedbde10744adad088',
    distAfterSha256: 'f3c440657da611b7cf002a6c86c83b2c975715b6ffed8f0a48c19fb5e4522822',
  } as const;
  const patch = await exact(
    join(repository, 'tools', 'semantic', 'typescript-native-frontend-bom.patch'),
    frontend.patchSha256,
    16 * 1024,
  );
  const directories: Array<{path: string; mode: number}> = [];
  const pending = [''];
  let entries = 0;
  let bytes = 0;
  await mkdir(destination, {mode: 0o700});
  while (pending.length) {
    const current = pending.pop()!;
    const inputDirectory = join(source, current);
    if ((await realpath(inputDirectory)) !== inputDirectory)
      throw new Error('Native TypeScript SDK directory contains an alias.');
    const info = await stat(inputDirectory);
    if (!info.isDirectory()) throw new Error('Native TypeScript SDK directory changed.');
    directories.push({path: join(destination, current), mode: info.mode & 0o777});
    const names = (await readdir(inputDirectory)).sort();
    for (const name of names) {
      if (name === '.git' || ++entries > 1200) throw new Error('Native TypeScript SDK member inventory is invalid.');
      const relativeName = current ? join(current, name) : name;
      const input = join(source, relativeName);
      if ((await realpath(input)) !== input) throw new Error('Native TypeScript SDK member contains an alias.');
      const member = await stat(input);
      const output = join(destination, relativeName);
      if (member.isDirectory()) {
        await mkdir(output, {mode: 0o700});
        pending.push(relativeName);
        continue;
      }
      if (!member.isFile() || member.size > 8 * 1024 * 1024 || bytes + member.size > 16 * 1024 * 1024)
        throw new Error('Native TypeScript SDK member exceeds its bound.');
      const content = await runtimeReadBoundedStableRegularFile(input, 8 * 1024 * 1024);
      bytes += content.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('Native TypeScript SDK copy exceeds its bound.');
      await writeFile(output, content, {mode: member.mode & 0o777});
      await chmod(output, member.mode & 0o777);
    }
  }
  const target = join(destination, 'dist', 'api', 'node', 'wtf8.js');
  await exact(target, frontend.distBeforeSha256, 16 * 1024);
  const snapshotDirectory = await mkdtemp(join(parent, '.tn-ts71-frontend-'));
  const patchSnapshot = join(snapshotDirectory, 'frontend.patch');
  await writeFile(patchSnapshot, patch, {mode: 0o600});
  const git = Bun.which('git');
  if (!git) throw new Error('Pinned frontend patch requires Git.');
  await command(git, ['apply', '--check', '--include=dist/api/node/wtf8.js', patchSnapshot], destination, {}, 10000);
  await command(git, ['apply', '--include=dist/api/node/wtf8.js', patchSnapshot], destination, {}, 10000);
  await exact(target, frontend.distAfterSha256, 16 * 1024);
  for (const directory of directories.reverse()) await chmod(directory.path, directory.mode);
  await rm(snapshotDirectory, {recursive: true});
}

/** Bundle only the verified SDK's genuine public entrypoints for standalone file-URL loading. */
export async function stageNativeTypeScriptPublicFrontendBundles(
  sdkDirectory: string,
  destinationDirectory: string,
): Promise<Readonly<Record<'api/async/api.js' | 'ast/index.js' | 'chunk.js', string>>> {
  const sdk = resolve(sdkDirectory);
  const destination = resolve(destinationDirectory);
  if (
    (await realpath(sdk)) !== sdk ||
    (await realpath(dirname(destination))) !== dirname(destination) ||
    destination === sdk ||
    destination.startsWith(`${sdk}${sep}`)
  )
    throw new Error('Native TypeScript public frontend bundle paths are invalid.');
  try {
    await stat(destination);
    throw new Error('Native TypeScript public frontend bundle output must be fresh.');
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  await exact(
    join(sdk, 'dist', 'api', 'node', 'wtf8.js'),
    'f3c440657da611b7cf002a6c86c83b2c975715b6ffed8f0a48c19fb5e4522822',
    16 * 1024,
  );
  const entries = ['dist/api/async/api.js', 'dist/ast/index.js'] as const;
  for (const entry of entries) {
    const input = join(sdk, entry);
    if ((await realpath(input)) !== input || !(await stat(input)).isFile())
      throw new Error('Native TypeScript public frontend entrypoint changed.');
  }
  const built = await Bun.build({
    entrypoints: entries.map(entry => join(sdk, entry)),
    root: join(sdk, 'dist'),
    target: 'node',
    format: 'esm',
    splitting: true,
    sourcemap: 'none',
    minify: true,
    naming: {chunk: './chunk.js'},
  });
  if (!built.success || built.outputs.length !== 3)
    throw new Error('Native TypeScript public frontend entrypoints could not be bundled.');
  const outputs: Record<string, string> = {};
  await mkdir(destination, {mode: 0o700});
  for (const output of built.outputs) {
    const name = output.path.replace(/^\.\//u, '');
    if (name in outputs || (name !== 'api/async/api.js' && name !== 'ast/index.js' && name !== 'chunk.js'))
      throw new Error('Native TypeScript public frontend output inventory changed.');
    const bytes = new Uint8Array(await output.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024)
      throw new Error('Native TypeScript public frontend bundle exceeds its bound.');
    const source = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    if (source.includes(sdk) || source.includes(dirname(sdk)) || source.includes('sourceMappingURL'))
      throw new Error('Native TypeScript public frontend bundle exposes a source path or map.');
    const target = join(destination, name);
    await mkdir(dirname(target), {recursive: true, mode: 0o700});
    await writeFile(target, bytes, {mode: 0o600});
    const stable = await runtimeReadBoundedStableRegularFile(target, 16 * 1024 * 1024);
    if (hash(stable) !== hash(bytes)) throw new Error('Native TypeScript public frontend bundle changed.');
    outputs[name] = hash(stable);
  }
  if (!outputs['api/async/api.js'] || !outputs['ast/index.js'] || !outputs['chunk.js'])
    throw new Error('Native TypeScript public frontend output inventory is incomplete.');
  return {
    'api/async/api.js': outputs['api/async/api.js'],
    'ast/index.js': outputs['ast/index.js'],
    'chunk.js': outputs['chunk.js'],
  };
}

/** Never selects or downloads a compiler/toolchain. Module acquisition uses the pinned go.mod graph only. */
export async function buildTypeScriptNativeAsset(input: TypeScriptNativeBuildInput): Promise<string> {
  const {
    upstream,
    overlay,
    noExternalProcessOverlay,
    apiPipeLifecycleOverlay,
    orderedOverlayDigest,
    toolchain,
    offlineCommands,
  } = typescriptNativeBuildRecipe;
  const orderedDescriptor = {
    domain: 'threadnote-typescript-native-ordered-overlays-v1',
    sourceCommit: upstream.commit,
    overlays: [
      {path: overlay.path, sha256: overlay.sha256},
      {path: noExternalProcessOverlay.path, sha256: noExternalProcessOverlay.sha256},
      {path: apiPipeLifecycleOverlay.path, sha256: apiPipeLifecycleOverlay.sha256},
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
  const apiPipePatchBytes = await exact(
    join(input.repositoryRoot, apiPipeLifecycleOverlay.path),
    apiPipeLifecycleOverlay.sha256,
    64 * 1024,
  );
  const apiPipePatch = join(staging, 'typescript-native-api-pipe-lifecycle.patch');
  await writeFile(apiPipePatch, apiPipePatchBytes, {mode: 0o400});
  for (const file of apiPipeLifecycleOverlay.files) await exact(join(candidate, file.path), file.beforeSha256);
  await gitIn(candidate, ['apply', '--check', apiPipePatch]);
  await gitIn(candidate, ['apply', apiPipePatch]);
  for (const file of apiPipeLifecycleOverlay.files) await exact(join(candidate, file.path), file.afterSha256);
  const modified = (await gitIn(candidate, ['diff', '--name-only'])).trim().split('\n').sort();
  const expectedModified = [
    ...new Set([
      ...overlay.files.map(file => file.path),
      ...noExternalProcessOverlay.files.filter(file => file.beforeSha256 !== null).map(file => file.path),
      ...apiPipeLifecycleOverlay.files.map(file => file.path),
    ]),
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
  // The upstream API/IPC tests create another private socket below TMPDIR.
  // Keep only those tests under a short 0700 path; long SSD artifact roots can
  // exceed Darwin's sockaddr_un bound before any test assertion runs.
  const shortTempRoot = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
  if ((await realpath(shortTempRoot)) !== shortTempRoot || !(await stat(shortTempRoot)).isDirectory())
    throw new Error('Native TypeScript short system temp root is unavailable.');
  const testTemp = await mkdtemp(join(shortTempRoot, 'tn-ts71-'));
  if ((await realpath(testTemp)) !== testTemp || ((await stat(testTemp)).mode & 0o077) !== 0)
    throw new Error('Native TypeScript short test temp is not private.');
  const testEnv = {...env, TMPDIR: testTemp};
  await command(go, offlineCommands.focused.slice(1), module, testEnv, 240000);
  await command(go, offlineCommands.race.slice(1), module, testEnv, 240000);
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
  // The existing strict LSP probe consumes this exact constructed executable.
  // Its report is a separate host observation and does not make the candidate qualified.
  const probeConfig = `${JSON.stringify(
    {
      id: 'typescript-native',
      version: upstream.version,
      command: binary,
      args: ['--lsp', '--stdio'],
      language: 'typescript',
    },
    null,
    2,
  )}\n`;
  await writeFile(join(payload, 'probe-config.json'), probeConfig, {mode: 0o600});
  // Written only after this invocation has verified the source tree, ordered patches,
  // pinned toolchain, Go tests, version and exact binary bytes. This is CI evidence,
  // never a caller-supplied production qualification flag or a replacement for a host pin.
  await writeFile(
    join(payload, 'construction-receipt.json'),
    `${JSON.stringify(
      {
        kind: 'threadnote-native-typescript-source-construction-v1',
        version: upstream.version,
        sourceCommit: upstream.commit,
        sourceTree: upstream.tree,
        orderedOverlaySha256: orderedOverlayDigest,
        goArchiveSha256: archive.sha256,
        goVersion: toolchain.version,
        host: `${process.platform}-${process.arch}`,
        binarySha256: hash(bytes),
        binaryBytes: bytes.byteLength,
        probeConfigSha256: hash(new TextEncoder().encode(probeConfig)),
        completedChecks: ['module-verify', 'focused-go', 'race-go', 'build', 'version'],
      },
      null,
      2,
    )}\n`,
    {mode: 0o600},
  );
  await readNativeTypeScriptConstructionReceipt(payload);
  // All original command owners have returned drained with closed stdio and
  // their handles released. Failed/unknown construction retains this scratch.
  await rm(testTemp, {recursive: true});
  return payload;
}

/** Test-only readback of the same-invocation construction output; never production candidate authority. */
export async function readNativeTypeScriptConstructionReceipt(payloadDirectory: string): Promise<{
  readonly host: string;
  readonly binarySha256: string;
}> {
  if (!isAbsolute(payloadDirectory) || (await realpath(payloadDirectory)) !== payloadDirectory)
    throw new Error('Native TypeScript construction payload is not canonical.');
  const receiptBytes = await runtimeReadBoundedStableRegularFile(
    join(payloadDirectory, 'construction-receipt.json'),
    16 * 1024,
  );
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(receiptBytes));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Native TypeScript construction receipt is invalid.');
  const value = (name: string): unknown => Reflect.get(raw, name);
  const fields = [
    'binaryBytes',
    'binarySha256',
    'completedChecks',
    'goArchiveSha256',
    'goVersion',
    'host',
    'kind',
    'orderedOverlaySha256',
    'probeConfigSha256',
    'sourceCommit',
    'sourceTree',
    'version',
  ];
  const host = `${process.platform}-${process.arch}`;
  const hostArch = process.arch === 'x64' ? 'amd64' : process.arch;
  const archive = typescriptNativeBuildRecipe.toolchain.archives.find(
    item => item.os === process.platform && item.arch === hostArch,
  );
  const checks = ['module-verify', 'focused-go', 'race-go', 'build', 'version'];
  if (
    JSON.stringify(Reflect.ownKeys(raw).sort()) !== JSON.stringify(fields) ||
    value('kind') !== 'threadnote-native-typescript-source-construction-v1' ||
    value('version') !== typescriptNativeBuildRecipe.upstream.version ||
    value('sourceCommit') !== typescriptNativeBuildRecipe.upstream.commit ||
    value('sourceTree') !== typescriptNativeBuildRecipe.upstream.tree ||
    value('orderedOverlaySha256') !== typescriptNativeBuildRecipe.orderedOverlayDigest ||
    value('goVersion') !== typescriptNativeBuildRecipe.toolchain.version ||
    value('host') !== host ||
    !archive ||
    value('goArchiveSha256') !== archive.sha256 ||
    JSON.stringify(value('completedChecks')) !== JSON.stringify(checks) ||
    typeof value('binarySha256') !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(String(value('binarySha256'))) ||
    typeof value('binaryBytes') !== 'number' ||
    !Number.isSafeInteger(value('binaryBytes')) ||
    Number(value('binaryBytes')) < 1 ||
    Number(value('binaryBytes')) > 128 * 1024 * 1024
  )
    throw new Error('Native TypeScript construction receipt differs from this source recipe.');
  const binary = await runtimeReadBoundedStableRegularFile(join(payloadDirectory, 'tsc'), 128 * 1024 * 1024);
  const config = await runtimeReadBoundedStableRegularFile(join(payloadDirectory, 'probe-config.json'), 16 * 1024);
  if (
    binary.byteLength !== value('binaryBytes') ||
    hash(binary) !== value('binarySha256') ||
    hash(config) !== value('probeConfigSha256')
  )
    throw new Error('Native TypeScript construction output differs from the receipt.');
  const probe: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(config));
  if (
    !probe ||
    typeof probe !== 'object' ||
    JSON.stringify(probe) !==
      JSON.stringify({
        id: 'typescript-native',
        version: typescriptNativeBuildRecipe.upstream.version,
        command: join(payloadDirectory, 'tsc'),
        args: ['--lsp', '--stdio'],
        language: 'typescript',
      })
  )
    throw new Error('Native TypeScript construction probe configuration differs.');
  return {host, binarySha256: String(value('binarySha256'))};
}

if (import.meta.main) {
  if (process.argv[2] === '--verify-construction') {
    const payloadDirectory = process.argv[3];
    if (!payloadDirectory) throw new Error('Usage: bun build-typescript-native.ts --verify-construction PAYLOAD');
    process.stdout.write(`${JSON.stringify(await readNativeTypeScriptConstructionReceipt(payloadDirectory))}\n`);
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
