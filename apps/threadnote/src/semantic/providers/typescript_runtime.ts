import {Array as EffectArray, Clock, Effect, Path, String as EffectString} from 'effect';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {LspFault} from '../lsp_transport.js';
import {NativeTypeScriptHostCandidate} from '../host_catalog.js';
import {
  verifyNativeTypeScriptAsset,
  type NativeTypeScriptLanguageServerSession,
} from '@threadnote/graph/typescript_runtime';

/** Project closure is read from the same native LSP's current compiler snapshot, never projectInfo JSON. */
export const inspectNativeTypeScriptProject = Effect.fn('semantic.inspectNativeTypeScriptProject')(function* (options: {
  readonly session: NativeTypeScriptLanguageServerSession;
  readonly uri: string;
  readonly text: string;
  readonly worktree: string;
  readonly sdkRoot: string;
  readonly deadline: number;
  readonly maxFiles: number;
}) {
  const path = yield* Path.Path;
  const file = yield* path.fromFileUrl(new URL(options.uri));
  const canonical = (candidate: string) => {
    if (!path.isAbsolute(candidate) || /[\p{Cc}]/u.test(candidate)) return undefined;
    const normalized = path.normalize(candidate);
    return normalized === candidate ? normalized : undefined;
  };
  const worktree = canonical(options.worktree);
  const sdkRoot = canonical(options.sdkRoot);
  const selected = canonical(file);
  if (
    !worktree ||
    !sdkRoot ||
    !selected ||
    !EffectString.startsWith(worktree + path.sep)(selected) ||
    options.text.length > 4 * 1024 * 1024 ||
    !Number.isSafeInteger(options.maxFiles) ||
    options.maxFiles < 1 ||
    options.maxFiles > 100000 ||
    options.deadline <= (yield* Clock.currentTimeMillis)
  )
    return yield* LspFault.make({code: 'prerequisite'});
  const contained = (name: string) => {
    const checked = canonical(name);
    return (
      checked !== undefined &&
      (EffectString.startsWith(worktree + path.sep)(checked) || EffectString.startsWith(sdkRoot + path.sep)(checked))
    );
  };
  // Exact embedded-library names from the pinned Go source's generated LibNames inventory.
  // These are still retained in the complete project closure and never read from host disk.
  const pinnedEmbeddedLibraries = new Set([
    'bundled:///libs/lib.d.ts',
    'bundled:///libs/lib.decorators.d.ts',
    'bundled:///libs/lib.decorators.legacy.d.ts',
    'bundled:///libs/lib.dom.asynciterable.d.ts',
    'bundled:///libs/lib.dom.d.ts',
    'bundled:///libs/lib.dom.iterable.d.ts',
    'bundled:///libs/lib.es2015.collection.d.ts',
    'bundled:///libs/lib.es2015.core.d.ts',
    'bundled:///libs/lib.es2015.d.ts',
    'bundled:///libs/lib.es2015.generator.d.ts',
    'bundled:///libs/lib.es2015.iterable.d.ts',
    'bundled:///libs/lib.es2015.promise.d.ts',
    'bundled:///libs/lib.es2015.proxy.d.ts',
    'bundled:///libs/lib.es2015.reflect.d.ts',
    'bundled:///libs/lib.es2015.symbol.d.ts',
    'bundled:///libs/lib.es2015.symbol.wellknown.d.ts',
    'bundled:///libs/lib.es2016.array.include.d.ts',
    'bundled:///libs/lib.es2016.d.ts',
    'bundled:///libs/lib.es2016.full.d.ts',
    'bundled:///libs/lib.es2016.intl.d.ts',
    'bundled:///libs/lib.es2017.arraybuffer.d.ts',
    'bundled:///libs/lib.es2017.d.ts',
    'bundled:///libs/lib.es2017.date.d.ts',
    'bundled:///libs/lib.es2017.full.d.ts',
    'bundled:///libs/lib.es2017.intl.d.ts',
    'bundled:///libs/lib.es2017.object.d.ts',
    'bundled:///libs/lib.es2017.sharedmemory.d.ts',
    'bundled:///libs/lib.es2017.string.d.ts',
    'bundled:///libs/lib.es2017.typedarrays.d.ts',
    'bundled:///libs/lib.es2018.asyncgenerator.d.ts',
    'bundled:///libs/lib.es2018.asynciterable.d.ts',
    'bundled:///libs/lib.es2018.d.ts',
    'bundled:///libs/lib.es2018.full.d.ts',
    'bundled:///libs/lib.es2018.intl.d.ts',
    'bundled:///libs/lib.es2018.promise.d.ts',
    'bundled:///libs/lib.es2018.regexp.d.ts',
    'bundled:///libs/lib.es2019.array.d.ts',
    'bundled:///libs/lib.es2019.d.ts',
    'bundled:///libs/lib.es2019.full.d.ts',
    'bundled:///libs/lib.es2019.intl.d.ts',
    'bundled:///libs/lib.es2019.object.d.ts',
    'bundled:///libs/lib.es2019.string.d.ts',
    'bundled:///libs/lib.es2019.symbol.d.ts',
    'bundled:///libs/lib.es2020.bigint.d.ts',
    'bundled:///libs/lib.es2020.d.ts',
    'bundled:///libs/lib.es2020.date.d.ts',
    'bundled:///libs/lib.es2020.full.d.ts',
    'bundled:///libs/lib.es2020.intl.d.ts',
    'bundled:///libs/lib.es2020.number.d.ts',
    'bundled:///libs/lib.es2020.promise.d.ts',
    'bundled:///libs/lib.es2020.sharedmemory.d.ts',
    'bundled:///libs/lib.es2020.string.d.ts',
    'bundled:///libs/lib.es2020.symbol.wellknown.d.ts',
    'bundled:///libs/lib.es2021.d.ts',
    'bundled:///libs/lib.es2021.full.d.ts',
    'bundled:///libs/lib.es2021.intl.d.ts',
    'bundled:///libs/lib.es2021.promise.d.ts',
    'bundled:///libs/lib.es2021.string.d.ts',
    'bundled:///libs/lib.es2021.weakref.d.ts',
    'bundled:///libs/lib.es2022.array.d.ts',
    'bundled:///libs/lib.es2022.d.ts',
    'bundled:///libs/lib.es2022.error.d.ts',
    'bundled:///libs/lib.es2022.full.d.ts',
    'bundled:///libs/lib.es2022.intl.d.ts',
    'bundled:///libs/lib.es2022.object.d.ts',
    'bundled:///libs/lib.es2022.regexp.d.ts',
    'bundled:///libs/lib.es2022.string.d.ts',
    'bundled:///libs/lib.es2023.array.d.ts',
    'bundled:///libs/lib.es2023.collection.d.ts',
    'bundled:///libs/lib.es2023.d.ts',
    'bundled:///libs/lib.es2023.full.d.ts',
    'bundled:///libs/lib.es2023.intl.d.ts',
    'bundled:///libs/lib.es2024.arraybuffer.d.ts',
    'bundled:///libs/lib.es2024.collection.d.ts',
    'bundled:///libs/lib.es2024.d.ts',
    'bundled:///libs/lib.es2024.full.d.ts',
    'bundled:///libs/lib.es2024.object.d.ts',
    'bundled:///libs/lib.es2024.promise.d.ts',
    'bundled:///libs/lib.es2024.regexp.d.ts',
    'bundled:///libs/lib.es2024.sharedmemory.d.ts',
    'bundled:///libs/lib.es2024.string.d.ts',
    'bundled:///libs/lib.es2025.collection.d.ts',
    'bundled:///libs/lib.es2025.d.ts',
    'bundled:///libs/lib.es2025.float16.d.ts',
    'bundled:///libs/lib.es2025.full.d.ts',
    'bundled:///libs/lib.es2025.intl.d.ts',
    'bundled:///libs/lib.es2025.iterator.d.ts',
    'bundled:///libs/lib.es2025.promise.d.ts',
    'bundled:///libs/lib.es2025.regexp.d.ts',
    'bundled:///libs/lib.es2026.array.d.ts',
    'bundled:///libs/lib.es2026.collection.d.ts',
    'bundled:///libs/lib.es2026.d.ts',
    'bundled:///libs/lib.es2026.error.d.ts',
    'bundled:///libs/lib.es2026.full.d.ts',
    'bundled:///libs/lib.es2026.iterator.d.ts',
    'bundled:///libs/lib.es2026.json.d.ts',
    'bundled:///libs/lib.es2026.math.d.ts',
    'bundled:///libs/lib.es2026.typedarrays.d.ts',
    'bundled:///libs/lib.es5.d.ts',
    'bundled:///libs/lib.es6.d.ts',
    'bundled:///libs/lib.esnext.d.ts',
    'bundled:///libs/lib.esnext.date.d.ts',
    'bundled:///libs/lib.esnext.decorators.d.ts',
    'bundled:///libs/lib.esnext.disposable.d.ts',
    'bundled:///libs/lib.esnext.full.d.ts',
    'bundled:///libs/lib.esnext.intl.d.ts',
    'bundled:///libs/lib.esnext.iterator.d.ts',
    'bundled:///libs/lib.esnext.modulesource.d.ts',
    'bundled:///libs/lib.esnext.promise.d.ts',
    'bundled:///libs/lib.esnext.sharedmemory.d.ts',
    'bundled:///libs/lib.esnext.temporal.d.ts',
    'bundled:///libs/lib.scripthost.d.ts',
    'bundled:///libs/lib.webworker.asynciterable.d.ts',
    'bundled:///libs/lib.webworker.d.ts',
    'bundled:///libs/lib.webworker.importscripts.d.ts',
    'bundled:///libs/lib.webworker.iterable.d.ts',
  ]);
  const embeddedLibrary = (name: string) => pinnedEmbeddedLibraries.has(name);
  return yield* fromPromiseInterruptible(
    () =>
      options.session.withLanguageServerSnapshot({deadline: options.deadline}, async snapshot => {
        const project = await snapshot.getDefaultProjectForFile({uri: options.uri});
        // The pinned Go compiler identifies an inferred project with this fixed ID
        // and deliberately omits configFileName. It must have no config files.
        if (!project) throw new Error('Native project unavailable.');
        const configured = project.configFileName;
        const inferred = project.id === '/dev/null/inferred' && configured === undefined;
        const configuration = inferred ? '/dev/null/inferred' : configured;
        if (!configuration || (!inferred && !contained(configuration))) throw new Error('Native project unavailable.');
        const names = await project.program.getSourceFileNames();
        const selectedInProject: boolean = EffectArray.some(names, (name: string) => name === selected);
        if (
          names.length < 1 ||
          names.length > options.maxFiles ||
          !selectedInProject ||
          EffectArray.some(names, name => !contained(name) && !embeddedLibrary(name))
        )
          throw new Error('Native project closure unavailable.');
        const configurationFiles = await project.program.getConfigFileNames();
        if (
          (inferred
            ? configurationFiles.length !== 0
            : configured === undefined || !configurationFiles.includes(configured)) ||
          EffectArray.some(configurationFiles, name => !contained(name))
        )
          throw new Error('Native project configuration closure unavailable.');
        if (!(await project.program.getSourceFileMetadata({uri: options.uri})))
          throw new Error('Native source membership unavailable.');
        const actualSource = await project.program.getSourceFile({uri: options.uri});
        if (!actualSource) throw new Error('Native source text unavailable.');
        // Open-document overlays retain the complete LSP text; the verified frontend preserves its leading BOM.
        if (actualSource.text !== options.text)
          throw new Error('Native source text differs from the observed LSP document.');
        return {
          configuration,
          fileCount: names.length,
          files: [...new Set(names)].sort(),
          configurationFiles: [...new Set(configurationFiles)].sort(),
        };
      }),
    () => LspFault.make({code: 'rejected'}),
  );
});

/**
 * A host candidate is admitted only against the staged asset's verified bytes: the graph runtime's single verifier
 * checks the canonical path, manifest schema, reviewed host binary pin, SDK and bundle trees and POSIX ownership.
 * Production qualification is separate.
 */
export const verifyNativeTypeScriptCandidate = Effect.fn('semantic.verifyNativeTypeScriptCandidate')(function* (
  candidate: NativeTypeScriptHostCandidate,
) {
  const path = yield* Path.Path;
  const reject = () => LspFault.make({code: 'prerequisite'});
  if (!path.isAbsolute(candidate.executable) || !path.isAbsolute(candidate.sdkDirectory)) return yield* reject();
  const asset = yield* fromPromiseInterruptible(
    () => verifyNativeTypeScriptAsset(path.dirname(candidate.executable)),
    reject,
  );
  if (
    asset.compilerPath !== candidate.executable ||
    asset.sdkDirectory !== candidate.sdkDirectory ||
    asset.pinned !== candidate.executableDigest ||
    asset.manifest.frontend.derivedSdkTreeSha256 !== candidate.sdkTreeDigest
  )
    return yield* reject();
});
