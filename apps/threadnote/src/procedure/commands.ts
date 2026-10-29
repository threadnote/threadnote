import {DateTime, Effect, FileSystem, Path} from 'effect';
import {sha256FileHex} from '@threadnote/platform/digest';
import {writeFinalCliOutput} from '../effect/cli/output.js';
import {SystemInfo} from '@threadnote/platform/system';
import {currentPackageVersion} from '../release/index.js';
import {parseProcedureManifest, type ProcedureManifest} from '@threadnote/context/procedure/contract';
import {ProcedureRuntimeError, procedureRuntimeStatus, verifyLocalProcedure} from './runtime.js';
import {publishVerifiedProcedure, type ProcedurePublishOptions} from './publication.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface ProcedureVerifyOptions {
  readonly apply?: boolean;
  readonly artifact?: string;
  readonly dryRun?: boolean;
  readonly fixture: readonly string[];
  readonly json?: boolean;
  readonly manifest: string;
  readonly preview?: boolean;
}

export interface ProcedureStatusOptions {
  readonly artifact: string;
  readonly availableManifest?: string;
  readonly capability: readonly string[];
  readonly json?: boolean;
  readonly manifest: string;
  readonly receipt?: string;
  readonly surface: readonly string[];
}

export interface ProcedurePublishCommandOptions extends ProcedurePublishOptions {
  readonly json?: boolean;
}

export const runProcedurePublish = Effect.fn('procedure.publish.command')(function* (
  config: RuntimeConfig,
  options: ProcedurePublishCommandOptions,
) {
  const result = yield* publishVerifiedProcedure(config, options);
  yield* writeFinalCliOutput(JSON.stringify(result));
});

export const runProcedureVerify = Effect.fn('procedure.verify.command')(function* (options: ProcedureVerifyOptions) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const manifestPath = yield* localPath(options.manifest);
  const manifest = yield* readManifest(manifestPath);
  const preview = options.apply !== true || options.preview === true || options.dryRun === true;
  if (preview) {
    yield* writeFinalCliOutput(
      JSON.stringify({
        commands: manifest.verification.commands,
        mode: 'preview',
        notice:
          'Review these local commands. --apply executes them in the manifest directory; provide --artifact and every --fixture id=path. Commands run with your user permissions.',
        version: 1,
      }),
    );
    return;
  }
  const evidence = yield* localVerificationEvidence(manifest, options.artifact, options.fixture);
  yield* verifyDigests(evidence);
  const [now, threadnoteVersion] = yield* Effect.all([DateTime.nowAsDate, currentPackageVersion()]);
  const result = yield* verifyLocalProcedure({
    cwd: path.dirname(manifestPath),
    manifest,
    manifestPath,
    metadata: {
      hostVersion: `bun-${system.runtimeVersion}`,
      threadnoteVersion,
      verifiedAt: now.toISOString(),
      verifier: 'local-cli',
    },
  });
  // A verification command must not silently change the bytes certified by its receipt.
  yield* verifyDigests(evidence);
  const currentManifest = yield* readManifest(manifestPath);
  if (JSON.stringify(currentManifest) !== JSON.stringify(manifest)) {
    return yield* failure('The procedure manifest changed during verification; no receipt was emitted.');
  }
  yield* writeFinalCliOutput(JSON.stringify(result));
});

export const runProcedureStatus = Effect.fn('procedure.status.command')(function* (options: ProcedureStatusOptions) {
  const manifest = yield* readManifest(yield* localPath(options.manifest));
  const availableManifest =
    options.availableManifest === undefined
      ? undefined
      : yield* readManifest(yield* localPath(options.availableManifest));
  const artifact = yield* localPath(options.artifact);
  const receiptValue = options.receipt === undefined ? undefined : yield* readJson(yield* localPath(options.receipt));
  const receipt =
    typeof receiptValue === 'object' && receiptValue !== null && 'receipt' in receiptValue
      ? receiptValue.receipt
      : receiptValue;
  const localArtifactSha256 = yield* sha256FileHex(artifact).pipe(
    Effect.mapError(() => failure('Could not read the local artifact.')),
  );
  const status = procedureRuntimeStatus({
    ...(availableManifest === undefined ? {} : {availableArtifact: availableManifest.artifact}),
    capabilities: options.capability,
    localArtifactSha256,
    manifest,
    receipt,
    surfaceIds: options.surface,
  });
  yield* writeFinalCliOutput(options.json ? JSON.stringify({status, version: 1}) : `Procedure status: ${status}.`);
});

const localPath = Effect.fn('procedure.localPath')(function* (value: string) {
  if (!Effect2.pipe(value, EffectString.trim) || Effect2.pipe(value, EffectString.includes('://')))
    return yield* failure('Select an explicit local file path.');
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  return path.resolve(system.currentDirectory(), value);
});

const readJson = Effect.fn('procedure.readJson')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const stat = yield* fs.stat(path);
    if (stat.type !== 'File' || stat.size > 262_144n)
      return yield* failure('Procedure JSON must be a file of at most 256 KiB.');
    const text = yield* fs.readFileString(path);
    return yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => failure('Procedure JSON is invalid.'),
    });
  }).pipe(Effect.mapError(() => failure('Could not read bounded local procedure JSON.')));
});

const readManifest = Effect.fn('procedure.readManifest')(function* (path: string) {
  const value = yield* readJson(path);
  return yield* Effect.try({
    try: () => parseProcedureManifest(value),
    catch: () => failure('Procedure manifest is invalid.'),
  });
});

interface FileEvidence {
  readonly path: string;
  readonly sha256: string;
}

const localVerificationEvidence = Effect.fn('procedure.localEvidence')(function* (
  manifest: ProcedureManifest,
  artifact: string | undefined,
  fixtures: readonly string[],
) {
  if (artifact === undefined) return yield* failure('Verification --apply requires --artifact for content binding.');
  const mappings = new Map<string, string>();
  for (const fixture of fixtures) {
    const separator = Effect2.pipe(
      fixture,
      EffectString.indexOf('='),
      Effect2.Option.getOrElse(() => -1),
    );
    const id = Effect2.pipe(fixture, EffectString.slice(0, separator));
    if (separator <= 0 || mappings.has(id) || !Effect2.pipe(fixture, EffectString.slice(separator + 1))) {
      return yield* failure('Use each --fixture id=path exactly once.');
    }
    mappings.set(id, Effect2.pipe(fixture, EffectString.slice(separator + 1)));
  }
  if (mappings.size !== manifest.verification.fixtures.length) {
    return yield* failure('Provide an exact local path mapping for every declared fixture.');
  }
  const evidence: FileEvidence[] = [{path: yield* localPath(artifact), sha256: manifest.artifact.sha256}];
  for (const fixture of manifest.verification.fixtures) {
    const location = mappings.get(fixture.id);
    if (location === undefined)
      return yield* failure('Provide an exact local path mapping for every declared fixture.');
    evidence.push({path: yield* localPath(location), sha256: fixture.sha256});
  }
  return evidence;
});

const verifyDigests = Effect.fn('procedure.verifyDigests')(function* (evidence: readonly FileEvidence[]) {
  for (const item of evidence) {
    const digest = yield* sha256FileHex(item.path).pipe(
      Effect.mapError(() => failure('Could not read verification evidence.')),
    );
    if (digest !== item.sha256)
      return yield* failure('Artifact or fixture content does not match the manifest; no receipt was emitted.');
  }
});

function failure(message: string): ProcedureRuntimeError {
  return ProcedureRuntimeError.make({message});
}
