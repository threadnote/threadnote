import {Result} from 'effect';
import {Base64Url} from 'effect/encoding';
import {sha256HexSync} from '@threadnote/platform/sha256';

export const VECTOR_DATABASE_LIMIT = 64;
export const MODEL_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
export const HASH_ID = /^[0-9a-f]{64}$/;
const ORDINARY_VECTOR_CURSOR = /^ov1:([0-9a-f]{64}):([-_A-Za-z0-9]+)$/u;
export const ORDINARY_VECTOR_CURSOR_LIMIT = 64 * 1_024;
const ORDINARY_VECTOR_GENERATION_BYTES = 256;

export interface OrdinaryVectorModelCursor {
  readonly admissionWrapped: boolean;
  readonly afterGeneration: string;
  readonly phase: 'admission' | 'marker' | 'verified';
}

export interface OrdinaryVectorPhaseCursor {
  readonly digest: string;
  readonly models: ReadonlyMap<string, OrdinaryVectorModelCursor>;
  readonly nextModelName?: string;
  readonly roundDeferred: boolean;
  readonly roundProgressed: boolean;
}

export function ordinaryVectorAdmissionCursor(afterGeneration = ''): OrdinaryVectorModelCursor {
  return {admissionWrapped: false, afterGeneration, phase: 'admission'};
}

export function ordinaryVectorMarkerCursor(
  afterGeneration: string,
  admissionWrapped: boolean,
): OrdinaryVectorModelCursor {
  return {admissionWrapped, afterGeneration, phase: 'marker'};
}

export function initialOrdinaryVectorCursor(digest: string): OrdinaryVectorPhaseCursor {
  return {digest, models: new Map(), roundDeferred: false, roundProgressed: false};
}

export function restartOrdinaryVectorRound(cursor: OrdinaryVectorPhaseCursor): OrdinaryVectorPhaseCursor {
  return {
    digest: cursor.digest,
    models: cursor.models,
    roundDeferred: false,
    roundProgressed: false,
  };
}

export function clearOrdinaryVectorRoundFlags(cursor: OrdinaryVectorPhaseCursor): OrdinaryVectorPhaseCursor {
  return {
    digest: cursor.digest,
    models: cursor.models,
    ...(cursor.nextModelName === undefined ? {} : {nextModelName: cursor.nextModelName}),
    roundDeferred: false,
    roundProgressed: false,
  };
}

export function updateOrdinaryVectorCursor(
  cursor: OrdinaryVectorPhaseCursor,
  modelName: string,
  modelCursor: OrdinaryVectorModelCursor,
  progressed: boolean,
  deferred: boolean,
): OrdinaryVectorPhaseCursor {
  return {
    digest: cursor.digest,
    models: setOrdinaryVectorModelCursor(cursor.models, modelName, modelCursor),
    nextModelName: modelName,
    roundDeferred: cursor.roundDeferred || deferred,
    roundProgressed: cursor.roundProgressed || progressed,
  };
}

export function setOrdinaryVectorModelCursor(
  current: ReadonlyMap<string, OrdinaryVectorModelCursor>,
  modelName: string,
  modelCursor: OrdinaryVectorModelCursor,
): Map<string, OrdinaryVectorModelCursor> {
  const updated = new Map(current);
  if (modelCursor.phase === 'admission' && !modelCursor.admissionWrapped && modelCursor.afterGeneration === '') {
    updated.delete(modelName);
  } else {
    updated.set(modelName, modelCursor);
  }
  return updated;
}

export function encodeOrdinaryVectorPhaseCursor(cursor: OrdinaryVectorPhaseCursor): string {
  const models = [...cursor.models.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([modelName, state]) => [
      modelName,
      state.phase === 'admission' ? 'a' : state.phase === 'marker' ? 'm' : 'v',
      state.admissionWrapped ? 1 : 0,
      state.afterGeneration,
    ]);
  const payload = Base64Url.encode(
    JSON.stringify({
      v: 1,
      d: cursor.digest,
      ...(cursor.nextModelName === undefined ? {} : {n: cursor.nextModelName}),
      m: models,
      p: cursor.roundProgressed ? 1 : 0,
      x: cursor.roundDeferred ? 1 : 0,
    }),
  );
  const seal = sha256HexSync(`code-graph-ordinary-vector-cursor-v1\n${payload}`);
  return `ov1:${seal}:${payload}`;
}

export function parseOrdinaryVectorPhaseCursor(cursorToken: string | undefined): OrdinaryVectorPhaseCursor | undefined {
  if (cursorToken === undefined || cursorToken.length > ORDINARY_VECTOR_CURSOR_LIMIT) return undefined;
  const match = ORDINARY_VECTOR_CURSOR.exec(cursorToken);
  if (match === null) return undefined;
  const [, seal, payload] = match;
  if (sha256HexSync(`code-graph-ordinary-vector-cursor-v1\n${payload}`) !== seal) return undefined;
  const decoded = Base64Url.decodeString(payload);
  if (!Result.isSuccess(decoded) || Base64Url.encode(decoded.success) !== payload) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(decoded.success);
  } catch {
    return undefined;
  }
  const cursor = decodeOrdinaryVectorCursorPayload(raw);
  return cursor !== undefined && encodeOrdinaryVectorPhaseCursor(cursor) === cursorToken ? cursor : undefined;
}

function decodeOrdinaryVectorCursorPayload(raw: unknown): OrdinaryVectorPhaseCursor | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const candidate = raw as {
    readonly d?: unknown;
    readonly m?: unknown;
    readonly n?: unknown;
    readonly p?: unknown;
    readonly v?: unknown;
    readonly x?: unknown;
  };
  if (
    candidate.v !== 1 ||
    typeof candidate.d !== 'string' ||
    !HASH_ID.test(candidate.d) ||
    (candidate.p !== 0 && candidate.p !== 1) ||
    (candidate.x !== 0 && candidate.x !== 1)
  ) {
    return undefined;
  }
  if (candidate.n !== undefined && (typeof candidate.n !== 'string' || !MODEL_ID.test(candidate.n))) return undefined;
  if (!Array.isArray(candidate.m) || candidate.m.length > VECTOR_DATABASE_LIMIT) return undefined;
  const models = new Map<string, OrdinaryVectorModelCursor>();
  let previous = '';
  for (const entry of candidate.m) {
    if (!Array.isArray(entry) || entry.length !== 4) return undefined;
    const [modelName, phase, wrapped, afterGeneration] = entry;
    if (
      typeof modelName !== 'string' ||
      !MODEL_ID.test(modelName) ||
      modelName <= previous ||
      (phase !== 'a' && phase !== 'm' && phase !== 'v') ||
      (wrapped !== 0 && wrapped !== 1) ||
      typeof afterGeneration !== 'string' ||
      (afterGeneration !== '' && !validOrdinaryVectorGeneration(afterGeneration)) ||
      (phase === 'a' && wrapped !== 0) ||
      (phase === 'v' && (wrapped !== 1 || afterGeneration !== ''))
    ) {
      return undefined;
    }
    const state: OrdinaryVectorModelCursor = {
      admissionWrapped: wrapped === 1,
      afterGeneration,
      phase: phase === 'a' ? 'admission' : phase === 'm' ? 'marker' : 'verified',
    };
    if (state.phase === 'admission' && state.afterGeneration === '') return undefined;
    models.set(modelName, state);
    previous = modelName;
  }
  return {
    digest: candidate.d,
    models,
    ...(candidate.n === undefined ? {} : {nextModelName: candidate.n}),
    roundDeferred: candidate.x === 1,
    roundProgressed: candidate.p === 1,
  };
}

function validOrdinaryVectorGeneration(generation: string): boolean {
  const bytes = new TextEncoder().encode(generation).byteLength;
  return bytes > 0 && bytes <= ORDINARY_VECTOR_GENERATION_BYTES && !generation.includes('\0');
}
