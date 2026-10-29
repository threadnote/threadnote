import {Schema} from 'effect';

export class NativeRuntimeUnavailable extends Schema.TaggedError<
  NativeRuntimeUnavailable,
  {readonly brand: unique symbol}
>()('NativeRuntimeUnavailable', {
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

export class UnsupportedNativeRuntime extends Schema.TaggedError<
  UnsupportedNativeRuntime,
  {readonly brand: unique symbol}
>()('UnsupportedNativeRuntime', {
  cause: Schema.Defect(),
  message: Schema.String,
}) {}

export class ModelNotInstalled extends Schema.TaggedError<ModelNotInstalled, {readonly brand: unique symbol}>()(
  'ModelNotInstalled',
  {
    modelId: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class ModelManifestInvalid extends Schema.TaggedError<ModelManifestInvalid, {readonly brand: unique symbol}>()(
  'ModelManifestInvalid',
  {
    message: Schema.String,
    modelId: Schema.String,
  },
) {}

export class ModelChecksumMismatch extends Schema.TaggedError<ModelChecksumMismatch, {readonly brand: unique symbol}>()(
  'ModelChecksumMismatch',
  {
    actual: Schema.String,
    expected: Schema.String,
    message: Schema.String,
    modelId: Schema.String,
  },
) {}

export class ModelDownloadFailed extends Schema.TaggedError<ModelDownloadFailed, {readonly brand: unique symbol}>()(
  'ModelDownloadFailed',
  {
    cause: Schema.Defect(),
    message: Schema.String,
    modelId: Schema.String,
  },
) {}

export class InsufficientDiskSpace extends Schema.TaggedError<InsufficientDiskSpace, {readonly brand: unique symbol}>()(
  'InsufficientDiskSpace',
  {
    availableBytes: Schema.Finite,
    message: Schema.String,
    modelId: Schema.String,
    requiredBytes: Schema.Finite,
  },
) {}

export class ModelLoadFailed extends Schema.TaggedError<ModelLoadFailed, {readonly brand: unique symbol}>()(
  'ModelLoadFailed',
  {
    cause: Schema.Defect(),
    message: Schema.String,
    modelId: Schema.String,
  },
) {}

export class InsufficientMemory extends Schema.TaggedError<InsufficientMemory, {readonly brand: unique symbol}>()(
  'InsufficientMemory',
  {
    cause: Schema.Defect(),
    message: Schema.String,
    modelId: Schema.String,
  },
) {}

export class EmbeddingFailed extends Schema.TaggedError<EmbeddingFailed, {readonly brand: unique symbol}>()(
  'EmbeddingFailed',
  {
    cause: Schema.Defect(),
    message: Schema.String,
    modelId: Schema.String,
  },
) {}

export class RerankingFailed extends Schema.TaggedError<RerankingFailed, {readonly brand: unique symbol}>()(
  'RerankingFailed',
  {
    cause: Schema.Defect(),
    message: Schema.String,
    modelId: Schema.String,
  },
) {}

export class GenerationFailed extends Schema.TaggedError<GenerationFailed, {readonly brand: unique symbol}>()(
  'GenerationFailed',
  {
    cause: Schema.Defect(),
    message: Schema.String,
    modelId: Schema.String,
  },
) {}

export class InvalidModelOutput extends Schema.TaggedError<InvalidModelOutput, {readonly brand: unique symbol}>()(
  'InvalidModelOutput',
  {
    message: Schema.String,
    modelId: Schema.String,
  },
) {}

export class InferenceInterrupted extends Schema.TaggedError<InferenceInterrupted, {readonly brand: unique symbol}>()(
  'InferenceInterrupted',
  {
    message: Schema.String,
    modelId: Schema.String,
    operation: Schema.String,
  },
) {}

export type NativeRuntimeError = NativeRuntimeUnavailable | UnsupportedNativeRuntime;
export type ModelSessionError =
  | EmbeddingFailed
  | InferenceInterrupted
  | InsufficientMemory
  | ModelLoadFailed
  | ModelNotInstalled
  | NativeRuntimeError;
