import {Console, Crypto, Effect, FileSystem, Path, Result, Schema} from 'effect';
import {sha256Hex} from '@threadnote/platform/digest';
import {HttpService} from '@threadnote/platform/http';
import {SystemInfo} from '@threadnote/platform/system';
import {LEGACY_OPENVIKING_HOME_DIRECTORY} from '@threadnote/store/layout';

const LEGACY_LOCAL_AI_SERVICE_ID = 'threadnote-local-ai';
const LEGACY_LOCAL_AI_RECEIPT_VERSION = 1;
const LEGACY_LOCAL_AI_STOP_WAIT_MILLISECONDS = 2_000;
const LEGACY_LOCAL_AI_STOP_POLL_MILLISECONDS = 50;

class LegacyRuntimeMigrationError extends Schema.TaggedError<LegacyRuntimeMigrationError>()(
  'LegacyRuntimeMigrationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

interface LegacyLocalAiReceipt {
  readonly launchId: string;
  readonly pid: number;
  readonly version: typeof LEGACY_LOCAL_AI_RECEIPT_VERSION;
}

interface LegacyLocalAiConfig {
  readonly host: '127.0.0.1' | '::1' | 'localhost';
  readonly model: string;
  readonly port: number;
}

interface LegacyLocalAiHealth {
  readonly launchId: string;
  readonly model: string;
  readonly pid: number;
  readonly proof: string;
  readonly service: typeof LEGACY_LOCAL_AI_SERVICE_ID;
  readonly status: 'ok';
}

export const stopVerifiedLegacyLocalAi = Effect.fn('legacyRuntime.stopLocalAi')(function* (options: {
  readonly dryRun: boolean;
  readonly legacyHome?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const legacyHome = options.legacyHome ?? path.join(system.homeDirectory, LEGACY_OPENVIKING_HOME_DIRECTORY);
  const receiptPath = path.join(legacyHome, 'local-ai-server.json');
  const lockPath = path.join(legacyHome, 'local-ai-server.lock');
  const receipt = yield* readJsonFile(fs, receiptPath, isLegacyLocalAiReceipt);
  if (!receipt) return;
  if (!system.isProcessRunning(receipt.pid)) {
    if (!options.dryRun) {
      yield* fs.remove(receiptPath, {force: true});
      yield* fs.remove(lockPath, {force: true});
    }
    return;
  }

  const configPath = path.join(legacyHome, 'threadnote', 'local-ai.json');
  const tokenPath = path.join(legacyHome, 'threadnote', 'local-ai-token');
  const config = yield* readJsonFile(fs, configPath, isLegacyLocalAiConfig);
  const token = yield* fs.readFileString(tokenPath).pipe(
    Effect.map(value => value.trim()),
    Effect.orElseSucceed(() => ''),
  );
  if (!config || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    yield* Console.warn(`WARN legacy local AI process ${receipt.pid} could not be verified and was left running.`);
    return;
  }

  const crypto = yield* Crypto.Crypto;
  const challenge = yield* crypto.randomUUIDv4();
  const host = config.host === '::1' ? '[::1]' : config.host;
  const response = yield* HttpService.pipe(
    Effect.flatMap(http =>
      http.getJson(`http://${host}:${config.port}/health?challenge=${encodeURIComponent(challenge)}`, {
        timeoutMs: 1_000,
      }),
    ),
    Effect.result,
  );
  if (Result.isFailure(response) || !isLegacyLocalAiHealth(response.success.body)) {
    yield* Console.warn(`WARN legacy local AI process ${receipt.pid} could not be verified and was left running.`);
    return;
  }
  const health = response.success.body;
  const expectedProof = yield* sha256Hex(
    [challenge, LEGACY_LOCAL_AI_SERVICE_ID, config.model, String(receipt.pid), receipt.launchId, token].join('\0'),
  );
  if (
    health.status !== 'ok' ||
    health.service !== LEGACY_LOCAL_AI_SERVICE_ID ||
    health.pid !== receipt.pid ||
    health.launchId !== receipt.launchId ||
    health.model !== config.model ||
    health.proof !== expectedProof
  ) {
    yield* Console.warn(`WARN legacy local AI process ${receipt.pid} could not be verified and was left running.`);
    return;
  }
  if (options.dryRun) {
    yield* Console.log(`Would stop verified legacy local AI process ${receipt.pid}.`);
    return;
  }

  const signalResult = yield* Effect.try({
    try: () => system.signalProcess(receipt.pid, 'SIGTERM'),
    catch: cause =>
      LegacyRuntimeMigrationError.make({cause, message: 'Could not signal the verified legacy local AI process.'}),
  }).pipe(Effect.result);
  if (Result.isFailure(signalResult) && system.isProcessRunning(receipt.pid)) {
    yield* Console.warn(`WARN verified legacy local AI process ${receipt.pid} could not be signaled.`);
    return;
  }
  const attempts = Math.ceil(LEGACY_LOCAL_AI_STOP_WAIT_MILLISECONDS / LEGACY_LOCAL_AI_STOP_POLL_MILLISECONDS);
  for (let attempt = 0; attempt < attempts && system.isProcessRunning(receipt.pid); attempt += 1) {
    yield* Effect.sleep(LEGACY_LOCAL_AI_STOP_POLL_MILLISECONDS);
  }
  if (system.isProcessRunning(receipt.pid)) {
    yield* Console.warn(`WARN verified legacy local AI process ${receipt.pid} did not stop after SIGTERM.`);
    return;
  }
  yield* fs.remove(receiptPath, {force: true});
  yield* fs.remove(lockPath, {force: true});
  yield* Console.log(`Stopped verified legacy local AI process ${receipt.pid}.`);
});

function readJsonFile<A>(
  fs: FileSystem.FileSystem,
  path: string,
  guard: (value: unknown) => value is A,
): Effect.Effect<A | undefined> {
  return fs.readFileString(path).pipe(
    Effect.map(content => {
      const decoded = Result.try(() => JSON.parse(content) as unknown);
      return Result.isSuccess(decoded) && guard(decoded.success) ? decoded.success : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );
}

function isLegacyLocalAiReceipt(value: unknown): value is LegacyLocalAiReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const receipt = value as Partial<LegacyLocalAiReceipt>;
  return (
    receipt.version === LEGACY_LOCAL_AI_RECEIPT_VERSION &&
    Number.isSafeInteger(receipt.pid) &&
    (receipt.pid ?? 0) > 0 &&
    typeof receipt.launchId === 'string' &&
    /^[0-9a-f-]{36}$/i.test(receipt.launchId)
  );
}

function isLegacyLocalAiConfig(value: unknown): value is LegacyLocalAiConfig {
  if (typeof value !== 'object' || value === null) return false;
  const config = value as Partial<LegacyLocalAiConfig>;
  return (
    (config.host === '127.0.0.1' || config.host === '::1' || config.host === 'localhost') &&
    typeof config.model === 'string' &&
    config.model.length > 0 &&
    Number.isSafeInteger(config.port) &&
    (config.port ?? 0) >= 1 &&
    (config.port ?? 0) <= 65_535
  );
}

function isLegacyLocalAiHealth(value: unknown): value is LegacyLocalAiHealth {
  if (typeof value !== 'object' || value === null) return false;
  const health = value as Partial<LegacyLocalAiHealth>;
  return (
    health.status === 'ok' &&
    health.service === LEGACY_LOCAL_AI_SERVICE_ID &&
    Number.isSafeInteger(health.pid) &&
    typeof health.launchId === 'string' &&
    typeof health.model === 'string' &&
    typeof health.proof === 'string' &&
    /^[0-9a-f]{64}$/i.test(health.proof)
  );
}
