import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Option, Path} from 'effect';
import {sha256FileHex} from '@threadnote/platform/digest';
import {
  codeMemoryLinkClientArgumentVectorHash,
  codeMemoryLinkClientPathDigest,
  codeMemoryLinkClientProjectionHash,
  parseCodeMemoryLinkClientImplementationDescriptorV1,
  type CodeMemoryLinkClientArtifactBindingV2,
  type CodeMemoryLinkClientImplementationDescriptorV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-client-descriptor';
import {
  CODE_MEMORY_LINK_CODEX_ENVIRONMENT_POLICY_V1,
  CODE_MEMORY_LINK_PROXY_SERVER_NAME,
  parseCodeMemoryLinkCodexClientConfigV1,
  projectCodeMemoryLinkCodexClientConfigV1,
} from './code-memory-link-codex-isolation.js';
import {ScriptError} from './effect/errors.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface CodeMemoryLinkClientFileBindingInput {
  readonly path: string;
  readonly role: string;
}

export interface CodeMemoryLinkClientImplementationInput {
  readonly clientArguments: readonly string[];
  readonly clientArtifactBindings: readonly CodeMemoryLinkClientFileBindingInput[];
  readonly clientBinaryBindings: readonly CodeMemoryLinkClientFileBindingInput[];
  readonly clientCommand: string;
  readonly clientConfigurationPath: string;
  readonly clientConfigurationProjectionPath: string;
  readonly clientDependenciesLockPath: string;
}

export interface CollectedCodeMemoryLinkClientImplementation {
  readonly command: string;
  readonly configuration: string;
  readonly descriptor: CodeMemoryLinkClientImplementationDescriptorV1;
}

export const collectCodeMemoryLinkClientImplementation = Effect.fn('codeMemoryLinkClientImplementation.collect')(
  function* (input: CodeMemoryLinkClientImplementationInput) {
    const path = yield* Path.Path;
    if (!path.isAbsolute(input.clientCommand)) {
      return yield* ScriptError.make({message: '--client-command must be an absolute reviewed executable path.'});
    }
    const command = yield* canonicalClientFile(input.clientCommand, 'client command');
    const artifactBindings = yield* collectBindings(input.clientArtifactBindings, 'artifact');
    const binaryBindings = yield* collectBindings(input.clientBinaryBindings, 'binary');
    const configuration = yield* canonicalClientFile(input.clientConfigurationPath, 'client configuration');
    const configurationProjection = yield* canonicalClientFile(
      input.clientConfigurationProjectionPath,
      'client configuration projection',
    );
    const dependenciesLock = yield* canonicalClientFile(input.clientDependenciesLockPath, 'client dependency lock');
    const fs = yield* FileSystem.FileSystem;
    const parsedConfig = yield* parseJsonFile(fs, configuration, 'client configuration');
    const config = yield* Effect.try({
      try: () => parseCodeMemoryLinkCodexClientConfigV1(parsedConfig),
      catch: cause => ScriptError.make({message: 'The reviewed client configuration is invalid.', cause}),
    });
    const parsedProjection = yield* parseJsonFile(fs, configurationProjection, 'client configuration projection');
    const expectedProjection = projectCodeMemoryLinkCodexClientConfigV1(config);
    if (JSON.stringify(parsedProjection) !== JSON.stringify(expectedProjection)) {
      return yield* ScriptError.make({
        message: 'The retained client configuration projection differs from the exact private configuration.',
      });
    }
    const bundle = exactlyOneRole(artifactBindings, 'client-bundle');
    const entrypoint = exactlyOneRole(artifactBindings, 'client-entrypoint');
    exactlyOneRole(artifactBindings, 'proxy-bundle');
    const runtime = exactlyOneRole(binaryBindings, 'client-runtime');
    exactlyOneRole(binaryBindings, 'codex-app-server');
    exactlyOneRole(binaryBindings, 'git');
    if (runtime.path !== command) {
      return yield* ScriptError.make({message: 'The invoked client command differs from its client-runtime role.'});
    }
    if (input.clientArguments.length !== 1 || input.clientArguments[0] !== bundle.path) {
      return yield* ScriptError.make({message: 'The client must execute exactly the reviewed client-bundle path.'});
    }
    const expectedClientProjection = {
      appServerVersion: Effect2.pipe(config.appServer.version, EffectString.replace('codex-cli ', '')),
      model: config.model.id,
      modelProvider: config.model.provider,
      proxyTool: {server: CODE_MEMORY_LINK_PROXY_SERVER_NAME, tool: 'context_brief'},
      reasoningEffort: config.model.reasoningEffort,
    };
    const descriptor = parseCodeMemoryLinkClientImplementationDescriptorV1({
      argumentVectorHash: codeMemoryLinkClientArgumentVectorHash(input.clientArguments),
      artifactBindings: EffectArray.map(artifactBindings, ({path: _path, ...binding}) => binding),
      binaryBindings: EffectArray.map(binaryBindings, ({path: _path, ...binding}) => binding),
      configurationHash: yield* sha256FileHex(configuration),
      configurationProjectionHash: yield* sha256FileHex(configurationProjection),
      dependenciesLockHash: yield* sha256FileHex(dependenciesLock),
      entrypointHash: entrypoint.sha256,
      environmentPolicyHash: codeMemoryLinkClientProjectionHash(
        'environment-policy',
        CODE_MEMORY_LINK_CODEX_ENVIRONMENT_POLICY_V1,
      ),
      executionBundleHash: bundle.sha256,
      expectedClientProjectionHash: codeMemoryLinkClientProjectionHash('expected-client', expectedClientProjection),
      version: 2,
    });
    return {command, configuration, descriptor};
  },
);

interface CollectedBinding extends CodeMemoryLinkClientArtifactBindingV2 {
  readonly path: string;
}

const collectBindings = Effect.fn('codeMemoryLinkClientImplementation.collectBindings')(function* (
  values: readonly CodeMemoryLinkClientFileBindingInput[],
  label: string,
) {
  if (values.length === 0 || values.length > 64) {
    return yield* ScriptError.make({message: `--client-${label} requires a bounded non-empty roster.`});
  }
  const collected = yield* Effect.forEach(
    values,
    value =>
      Effect.gen(function* () {
        const path = yield* canonicalClientFile(value.path, `client ${label} ${value.role}`);
        return {
          path,
          pathDigest: codeMemoryLinkClientPathDigest(path),
          role: value.role,
          sha256: yield* sha256FileHex(path),
        } satisfies CollectedBinding;
      }),
    {concurrency: 4},
  );
  collected.sort((left, right) => (left.role < right.role ? -1 : left.role > right.role ? 1 : 0));
  if (new Set(EffectArray.map(collected, binding => binding.role)).size !== collected.length) {
    return yield* ScriptError.make({message: `Client ${label} binding roles must be unique.`});
  }
  return collected;
});

function exactlyOneRole(bindings: readonly CollectedBinding[], role: string): CollectedBinding {
  const matching = EffectArray.filter(bindings, binding => binding.role === role);
  if (matching.length !== 1)
    throw ScriptError.make({message: `Client implementation requires exactly one ${role} binding.`});
  return matching[0];
}

const canonicalClientFile = Effect.fn('codeMemoryLinkClientImplementation.canonicalFile')(function* (
  file: string,
  label: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(file);
  if (Option.isSome(yield* fs.readLink(resolved).pipe(Effect.option))) {
    return yield* ScriptError.make({message: `The reviewed ${label} must not be a symbolic link.`});
  }
  const canonical = yield* fs.realPath(resolved);
  const metadata = yield* fs.stat(canonical);
  if (metadata.type !== 'File') {
    return yield* ScriptError.make({message: `The reviewed ${label} must be a regular file.`});
  }
  const linkCount = Option.getOrUndefined(metadata.nlink);
  if (linkCount !== undefined && linkCount > 1) {
    return yield* ScriptError.make({message: `The reviewed ${label} must not be hard-linked.`});
  }
  return canonical;
});

const parseJsonFile = Effect.fn('codeMemoryLinkClientImplementation.parseJsonFile')(function* (
  fs: FileSystem.FileSystem,
  file: string,
  label: string,
) {
  const content = yield* fs.readFileString(file);
  return yield* Effect.try({
    try: () => JSON.parse(content) as unknown,
    catch: cause => ScriptError.make({message: `The reviewed ${label} is not valid JSON.`, cause}),
  });
});
