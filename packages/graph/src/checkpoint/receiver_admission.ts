import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {CommandExecutor, type CommandOptions} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {inventoryRepository} from '../inventory.js';
import {readCodeGraphInventoryReuseEnvironment} from '../inventory/reuse.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {isOpaqueCorpusMediaPath} from '../languages/corpus/policy.js';
import type {CodeGraphInventoryFile, RepositoryIdentity} from '../types.js';
import type {CodeGraphCheckpointFileRecordV1, CodeGraphCheckpointHeaderV1} from './schema.js';

export class CodeGraphCheckpointReceiverAdmissionError extends Schema.TaggedError<
  CodeGraphCheckpointReceiverAdmissionError,
  {readonly brand: unique symbol}
>()('CodeGraphCheckpointReceiverAdmissionError', {message: Schema.String}) {}

type FileIdentity = Pick<CodeGraphInventoryFile, 'path' | 'blobId' | 'contentHash' | 'language' | 'mode'>;

/** Compare the complete input sets, including receiver-admitted files absent from the donor. */
export class CodeGraphCheckpointReceiverFileVerifier {
  readonly #remaining: Map<string, FileIdentity>;
  #valid = true;
  #acceptedOpaque = false;
  readonly #allowStructuralOnly: boolean;

  constructor(files: readonly FileIdentity[], options?: {readonly allowStructuralOnly?: boolean}) {
    this.#remaining = new Map(EffectArray.map(files, file => [file.path, file]));
    this.#allowStructuralOnly = options?.allowStructuralOnly === true;
  }

  accept(file: CodeGraphCheckpointFileRecordV1): boolean {
    const expected = this.#remaining.get(file.path);
    if (
      expected === undefined ||
      file.blobId !== expected.blobId ||
      file.contentHash !== expected.contentHash ||
      file.language !== expected.language ||
      file.mode !== expected.mode
    ) {
      this.#valid = false;
      return false;
    }
    this.#remaining.delete(file.path);
    if (isOpaqueCorpusMediaPath(file.path)) this.#acceptedOpaque = true;
    return true;
  }

  get complete(): boolean {
    return (
      this.#valid &&
      (this.#remaining.size === 0 ||
        (this.#allowStructuralOnly &&
          !this.#acceptedOpaque &&
          EffectArray.every([...this.#remaining.keys()], isOpaqueCorpusMediaPath)))
    );
  }

  get includesOpaqueAssets(): boolean {
    return this.#acceptedOpaque;
  }
}

export const prepareCodeGraphCheckpointReceiverAdmission = Effect.fn('codeGraph.prepareCheckpointReceiverAdmission')(
  function* (
    identity: RepositoryIdentity,
    header: CodeGraphCheckpointHeaderV1,
    languagePacks: CodeGraphLanguagePackRegistryShape,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const command = yield* CommandExecutor;
    const environment = yield* readCodeGraphInventoryReuseEnvironment(identity, fs, path);
    const localOptions = (options?: CommandOptions): CommandOptions => ({
      ...options,
      env: {...system.environment(), ...options?.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'},
    });
    const inventory = yield* inventoryRepository(
      {...identity, headCommit: header.source.commit},
      {
        includeOverlay: false,
        includeOpaqueCorpusAssets: header.reuse?.inventory?.includeOpaqueCorpusAssets,
        languagePacks,
        onContentBatch: () => Effect.void,
      },
    ).pipe(
      Effect.provideService(CommandExecutor, {
        ...command,
        execute: (executable, args, options) => command.execute(executable, args, localOptions(options)),
        ...(command.executeBytes === undefined
          ? {}
          : {
              executeBytes: (executable, args, options) =>
                command.executeBytes!(executable, args, localOptions(options)),
            }),
      }),
    );
    const verifyEnvironment = Effect.gen(function* () {
      const closing = yield* readCodeGraphInventoryReuseEnvironment(identity, fs, path);
      if (closing.fingerprint !== environment.fingerprint) {
        return yield* CodeGraphCheckpointReceiverAdmissionError.make({
          message:
            'Checkpoint receiver admission policy changed during import. Retry or run `threadnote graph index` locally.',
        });
      }
    });
    yield* verifyEnvironment;
    return {
      environmentFingerprint: environment.fingerprint,
      files: new CodeGraphCheckpointReceiverFileVerifier(inventory.files, {
        allowStructuralOnly: header.reuse?.inventory === undefined,
      }),
      verifyEnvironment,
    };
  },
);
