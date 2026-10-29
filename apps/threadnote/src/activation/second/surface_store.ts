import {Crypto, Effect, FileSystem, Path, Schema} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {constantTimeHexEqual, hmacSha256Hex} from '../../crypto/hmac.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {withActivationReceiptLock} from '../lock.js';
import {
  parseSecondSurfaceProofContextV1,
  parseSecondSurfaceProofReceiptV1,
  secondSurfaceProofContextHashV1,
  secondSurfaceProofMatchesContextV1,
  type SecondSurfaceProofContextV1,
  type SecondSurfaceProofReceiptV1,
} from './surface.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const ATTESTATION_VERSION = 1 as const;
const MAX_ATTESTATION_BYTES = 64 * 1_024;
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const STRICT = {errors: 'all', onExcessProperty: 'error'} as const;

export interface SecondSurfaceProofAttestationV1 {
  readonly attestationHash: string;
  readonly challengeId: string;
  readonly contextHash: string;
  readonly nonceHash: string;
  readonly proof: SecondSurfaceProofReceiptV1;
  readonly runtimeFingerprint: string;
  readonly surfaceId: string;
  readonly transport: 'stdio';
  readonly type: 'threadnote-second-surface-transport-attestation';
  readonly version: typeof ATTESTATION_VERSION;
}

export interface SecondSurfaceProofChallengeV1 {
  readonly challengeId: string;
  readonly context: SecondSurfaceProofContextV1;
  readonly contextHash: string;
  readonly issuedAt: string;
  readonly nonceHash: string;
  readonly receipt?: SecondSurfaceProofAttestationV1;
  readonly type: 'threadnote-second-surface-challenge';
  readonly version: typeof ATTESTATION_VERSION;
}

const AttestationSchema = Schema.Struct({
  attestationHash: Sha256,
  challengeId: Sha256,
  contextHash: Sha256,
  nonceHash: Sha256,
  proof: Schema.Unknown,
  runtimeFingerprint: Sha256,
  surfaceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  transport: Schema.Literal('stdio'),
  type: Schema.Literal('threadnote-second-surface-transport-attestation'),
  version: Schema.Literal(ATTESTATION_VERSION),
});

const ChallengeSchema = Schema.Struct({
  challengeId: Sha256,
  context: Schema.Unknown,
  contextHash: Sha256,
  issuedAt: Schema.String,
  nonceHash: Sha256,
  receipt: Schema.optionalKey(Schema.Unknown),
  type: Schema.Literal('threadnote-second-surface-challenge'),
  version: Schema.Literal(ATTESTATION_VERSION),
});

export const issueSecondSurfaceProofChallengeV1 = Effect.fn('activation.proof.issueChallenge')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  suppliedContext: SecondSurfaceProofContextV1,
) {
  const context = parseSecondSurfaceProofContextV1(suppliedContext);
  const challengeId = secondSurfaceChallengeIdV1(context);
  return yield* withActivationReceiptLock(
    config.agentContextHome,
    challengeId,
    Effect.gen(function* () {
      const existing = yield* readSecondSurfaceProofChallengeV1(config, challengeId);
      if (existing !== undefined) {
        if (challengeBindingHash(existing.context) !== challengeBindingHash(context)) {
          throw new Error('Second-surface challenge inputs changed after issue.');
        }
        return existing;
      }
      const crypto = yield* Crypto.Crypto;
      const challenge: SecondSurfaceProofChallengeV1 = {
        challengeId,
        context,
        contextHash: secondSurfaceProofContextHashV1(context),
        issuedAt: context.startedAt,
        nonceHash: sha256HexSync(yield* crypto.randomBytes(32)),
        type: 'threadnote-second-surface-challenge',
        version: ATTESTATION_VERSION,
      };
      yield* writeChallenge(config, challenge);
      return challenge;
    }),
  );
});

export const readSecondSurfaceProofChallengeV1 = Effect.fn('activation.proof.readChallenge')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  challengeId: string,
) {
  assertSha256(challengeId, 'challenge ID');
  const fs = yield* FileSystem.FileSystem;
  const target = yield* challengePath(config, challengeId);
  if (!(yield* fs.exists(target))) return undefined;
  const raw = yield* fs.readFileString(target);
  if (Buffer.byteLength(raw, 'utf8') > MAX_ATTESTATION_BYTES) throw new Error('Second-surface challenge is oversized.');
  return parseChallenge(JSON.parse(raw) as unknown, challengeId);
});

export const completeSecondSurfaceProofChallengeV1 = Effect.fn('activation.proof.completeChallenge')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  input: {
    readonly challengeId: string;
    readonly proof: SecondSurfaceProofReceiptV1;
    readonly runtimeFingerprint: string;
    readonly surfaceId: string;
  },
) {
  return yield* withActivationReceiptLock(
    config.agentContextHome,
    input.challengeId,
    Effect.gen(function* () {
      const challenge = yield* readSecondSurfaceProofChallengeV1(config, input.challengeId);
      if (challenge === undefined) throw new Error('Second-surface challenge was not found.');
      const proof = parseSecondSurfaceProofReceiptV1(input.proof);
      if (!secondSurfaceProofMatchesContextV1(challenge.context, proof)) {
        throw new Error('Second-surface proof does not match its challenge.');
      }
      if (
        input.surfaceId !== challenge.context.secondary.surfaceId ||
        input.runtimeFingerprint !== challenge.context.secondary.mcpServerFingerprint
      ) {
        throw new Error('Second-surface transport identity does not match its challenge.');
      }
      if (challenge.receipt !== undefined) {
        const receipt = yield* verifySecondSurfaceProofAttestationV1(config, challenge, challenge.receipt);
        if (receipt.proof.proofHash !== proof.proofHash) {
          throw new Error('Second-surface challenge was already completed with different proof evidence.');
        }
        return receipt;
      }
      const key = yield* readOrCreateAttestationKey(config);
      const body = {
        challengeId: challenge.challengeId,
        contextHash: challenge.contextHash,
        nonceHash: challenge.nonceHash,
        proof,
        runtimeFingerprint: input.runtimeFingerprint,
        surfaceId: input.surfaceId,
        transport: 'stdio' as const,
        type: 'threadnote-second-surface-transport-attestation' as const,
        version: ATTESTATION_VERSION,
      };
      const receipt = parseAttestation({...body, attestationHash: hmacSha256Hex(key, canonicalJson(body))});
      yield* writeChallenge(config, {...challenge, receipt});
      return receipt;
    }),
  );
});

export const verifySecondSurfaceProofAttestationV1 = Effect.fn('activation.proof.verifyAttestation')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  challenge: SecondSurfaceProofChallengeV1,
  suppliedReceipt: SecondSurfaceProofAttestationV1,
) {
  const receipt = parseAttestation(suppliedReceipt);
  if (
    receipt.challengeId !== challenge.challengeId ||
    receipt.contextHash !== challenge.contextHash ||
    receipt.nonceHash !== challenge.nonceHash ||
    receipt.surfaceId !== challenge.context.secondary.surfaceId ||
    receipt.runtimeFingerprint !== challenge.context.secondary.mcpServerFingerprint ||
    !secondSurfaceProofMatchesContextV1(challenge.context, receipt.proof)
  ) {
    throw new Error('Second-surface attestation binding is invalid.');
  }
  const {attestationHash, ...body} = receipt;
  const expected = hmacSha256Hex(yield* readAttestationKey(config), canonicalJson(body));
  if (!constantTimeHexEqual(attestationHash, expected)) throw new Error('Second-surface attestation is forged.');
  return receipt;
});

export function secondSurfaceChallengeIdV1(context: SecondSurfaceProofContextV1): string {
  return sha256HexSync(
    canonicalJson({binding: challengeBindingHash(context), type: 'activation-proof-challenge', version: 1}),
  );
}

function challengeBindingHash(context: SecondSurfaceProofContextV1): string {
  const {startedAt: _, ...binding} = parseSecondSurfaceProofContextV1(context);
  return sha256HexSync(canonicalJson(binding));
}

function parseChallenge(value: unknown, expectedId: string): SecondSurfaceProofChallengeV1 {
  const raw = Schema.decodeUnknownSync(ChallengeSchema, STRICT)(value);
  const context = parseSecondSurfaceProofContextV1(raw.context);
  const challenge: SecondSurfaceProofChallengeV1 = {
    challengeId: raw.challengeId,
    context,
    contextHash: raw.contextHash,
    issuedAt: raw.issuedAt,
    nonceHash: raw.nonceHash,
    ...(raw.receipt === undefined ? {} : {receipt: parseAttestation(raw.receipt)}),
    type: raw.type,
    version: raw.version,
  };
  if (
    challenge.challengeId !== expectedId ||
    secondSurfaceChallengeIdV1(context) !== challenge.challengeId ||
    secondSurfaceProofContextHashV1(context) !== challenge.contextHash ||
    challenge.issuedAt !== context.startedAt
  ) {
    throw new Error('Second-surface challenge integrity is invalid.');
  }
  return challenge;
}

export function parseSecondSurfaceProofChallengeV1(value: unknown): SecondSurfaceProofChallengeV1 {
  const raw = Schema.decodeUnknownSync(ChallengeSchema, STRICT)(value);
  return parseChallenge(value, raw.challengeId);
}

export function parseSecondSurfaceProofAttestationV1(value: unknown): SecondSurfaceProofAttestationV1 {
  return parseAttestation(value);
}

function parseAttestation(value: unknown): SecondSurfaceProofAttestationV1 {
  const raw = Schema.decodeUnknownSync(AttestationSchema, STRICT)(value);
  return {...raw, proof: parseSecondSurfaceProofReceiptV1(raw.proof)};
}

const readAttestationKey = Effect.fn('activation.proof.readKey')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* attestationKeyPath(config);
  const raw = Effect2.pipe(yield* fs.readFileString(target), EffectString.trim);
  assertSha256(raw, 'attestation key');
  return raw;
});

const readOrCreateAttestationKey = Effect.fn('activation.proof.key')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* attestationKeyPath(config);
  if (yield* fs.exists(target)) return yield* readAttestationKey(config);
  const crypto = yield* Crypto.Crypto;
  const key = sha256HexSync(yield* crypto.randomBytes(32));
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  yield* fs
    .writeFileString(target, `${key}\n`, {flag: 'wx', mode: 0o600})
    .pipe(Effect.catch(() => readAttestationKey(config).pipe(Effect.asVoid)));
  return yield* readAttestationKey(config);
});

const challengePath = Effect.fn('activation.proof.challengePath')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  challengeId: string,
) {
  const path = yield* Path.Path;
  return path.join(path.resolve(config.agentContextHome), 'activation', 'proofs', `${challengeId}.json`);
});

const attestationKeyPath = Effect.fn('activation.proof.keyPath')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
) {
  const path = yield* Path.Path;
  return path.join(path.resolve(config.agentContextHome), 'activation', 'proof-attestation.key');
});

const writeChallenge = Effect.fn('activation.proof.writeChallenge')(function* (
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  challenge: SecondSurfaceProofChallengeV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const target = yield* challengePath(config, challenge.challengeId);
  const temporary = `${target}.${system.processId}.tmp`;
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  yield* fs.writeFileString(temporary, `${JSON.stringify(challenge)}\n`, {flag: 'wx', mode: 0o600});
  yield* fs.rename(temporary, target).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`Second-surface ${label} must be a SHA-256 hash.`);
}
