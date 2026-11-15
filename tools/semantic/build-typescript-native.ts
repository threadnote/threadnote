/**
 * Portable, pinned SDK construction resource; NOT an executable build command.
 * No downloads, process launch, environment mutation or import-time side effects.
 * Only Darwin ARM64 was actually validated; an executor/consumer is not yet wired.
 * Keep source-overlay provenance and upstream notices; never label it an official npm binary.
 */
export const typescriptNativeBuildRecipe = {
  schemaVersion: 1,
  status: 'resource-only-no-executor',
  consumer: null,
  purpose:
    'Pinned portable construction/validation specification; importing or invoking this file performs no acquisition/build. No production installer/runtime is wired to it.',
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
    'Verify module, bundled subtree/manifest and patch hashes; apply overlay only to exact two before-hashes; after-hashes and all other tracked files must match.',
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
    format: ['gofmt', '-l', 'internal/lsp/server.go', 'internal/lsp/server_test.go'],
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
    build: ['go', 'build', '-p=2', '-mod=readonly', '-trimpath', '-o', 'DERIVED_EXECUTABLE', './cmd/tsc'],
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
      'Microsoft TypeScript7.1.0-beta source, Apache-2.0. Retain source LICENSE.txt, NOTICE.txt, tsc/LICENSE and bundled CopyrightNotice.txt. Local overlay changes protocol exit/cancellation classification and adds upstream lifecycle regression tests.',
    go: 'Go Authors toolchain/runtime, BSD-3-Clause; retain original Go LICENSE.',
    thirdParty:
      'Preserve applicable module licenses/notices; complete static-link redistribution/legal closure remains mandatory before release. These attributions do not replace license texts.',
  },
  observedValidation: {
    platform: 'darwin-arm64',
    officialBinary: false,
    sourceOverlay: 'validated private build only',
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
