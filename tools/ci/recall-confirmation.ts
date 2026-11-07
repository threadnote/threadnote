import {BunFileSystem} from '@effect/platform-bun';
import {Array as EffectArray, Effect, FileSystem, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';

const receiptSchema = Schema.Struct({
  version: Schema.Literal(1),
  nonce: Schema.String,
  verdict: Schema.Literals(['pass', 'timing-only', 'correctness']),
  diagnosticsSha256: Schema.String,
});
// This standalone process boundary owns its filesystem services.
// oxlint-disable-next-line effecttsgo/strict-effect-provide
const fs = Effect.runSync(Effect.provide(FileSystem.FileSystem, BunFileSystem.layer));
// Fresh process-owned evidence names and producer nonces at this OS orchestration boundary.
// oxlint-disable-next-line effecttsgo/crypto-random-uuid
const freshNonce = () => crypto.randomUUID();
const diagnosticsPath = 'artifacts/recall-production-10000.json';
const receiptPath = `${diagnosticsPath}.receipt.json`;
export interface RecallAttemptStatus {
  readonly exitCode: number | null;
  readonly signal: string | number | null;
}
interface RecallAttempt {
  readonly attempt: number;
  readonly nonce: string;
  readonly status: RecallAttemptStatus;
  readonly verdict: string;
}
const describeAttempts = (attempts: readonly RecallAttempt[]) =>
  EffectArray.join(
    EffectArray.map(
      attempts,
      attempt =>
        `attempt ${attempt.attempt}: ${attempt.verdict} (exit ${attempt.status.exitCode}, signal ${attempt.status.signal ?? 'none'})`,
    ),
    '; ',
  );
type SpawnAttempt = (nonce: string, directory: string) => Promise<RecallAttemptStatus>;

const spawnAttempt: SpawnAttempt = async (nonce, directory) => {
  const child = Bun.spawn(['bun', 'run', 'eval:recall'], {
    env: {...process.env, THREADNOTE_RECALL_ATTEMPT_NONCE: nonce},
    stdout: Bun.file(`${directory}/stdout.log`),
    stderr: Bun.file(`${directory}/stderr.log`),
  });
  const exitCode = await child.exited;
  return {exitCode, signal: child.signalCode ?? null};
};

/** One Recall-specific confirmation; retained evidence must succeed before any second process. */
export async function confirmRecall(
  evidenceRoot = 'artifacts/recall-confirmation',
  spawn: SpawnAttempt = spawnAttempt,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
) {
  const root = `${evidenceRoot}/${freshNonce()}`;
  await Effect.runPromise(fs.makeDirectory(root, {recursive: true}));
  const attempts: RecallAttempt[] = [];
  let classification = 'failed';
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const directory = `${root}/attempt-${attempt}`;
      const nonce = freshNonce();
      await Effect.runPromise(fs.makeDirectory(directory));
      await Effect.runPromise(fs.remove(diagnosticsPath, {force: true}));
      await Effect.runPromise(fs.remove(receiptPath, {force: true}));
      const status = await spawn(nonce, directory);
      await Bun.write(`${directory}/status.json`, `${JSON.stringify(status)}\n`);
      let diagnostics: Uint8Array | undefined;
      let receipt: Uint8Array | undefined;
      // Absence is evidence too; other filesystem failures must stop orchestration.
      if (await Bun.file(diagnosticsPath).exists()) {
        diagnostics = new Uint8Array(await Bun.file(diagnosticsPath).arrayBuffer());
        await Bun.write(`${directory}/diagnostics.json`, diagnostics);
      }
      if (await Bun.file(receiptPath).exists()) {
        receipt = new Uint8Array(await Bun.file(receiptPath).arrayBuffer());
        await Bun.write(`${directory}/receipt.json`, receipt);
      }
      let verdict = 'unproven';
      try {
        const proof = Schema.decodeUnknownSync(receiptSchema, {onExcessProperty: 'error'})(
          JSON.parse(receipt === undefined ? '' : new TextDecoder().decode(receipt)),
        );
        const expectedExit = proof.verdict === 'pass' ? 0 : proof.verdict === 'timing-only' ? 75 : 1;
        if (
          diagnostics &&
          proof.nonce === nonce &&
          proof.diagnosticsSha256 === sha256HexSync(diagnostics) &&
          status.signal === null &&
          status.exitCode === expectedExit
        )
          verdict = proof.verdict;
      } catch {
        // Invalid or absent proof cannot certify either a retry or a pass.
      }
      attempts.push({attempt, nonce, status, verdict});
      await Bun.write(`${directory}/result.json`, `${JSON.stringify(attempts[attempts.length - 1])}\n`);
      if (verdict === 'pass') {
        classification = attempt === 1 ? 'passed' : 'recovered-flaky';
        break;
      }
      if (verdict !== 'timing-only') break;
    }
  } finally {
    const result = {classification, attempts};
    await Bun.write(`${root}/result.json`, `${JSON.stringify(result, undefined, 2)}\n`);
    if (summaryPath) {
      const previous = (await Bun.file(summaryPath).exists()) ? await Bun.file(summaryPath).text() : '';
      await Bun.write(
        summaryPath,
        `${previous}\nRecall: **${classification}** (${attempts.length} attempt(s)); ${describeAttempts(attempts)}; evidence: ${root}\n`,
      );
    }
  }
  return {classification, attempts, exitCode: classification === 'failed' ? 1 : 0, root};
}

if (import.meta.main) {
  try {
    const result = await confirmRecall();
    await Bun.write(
      Bun.stdout,
      `Recall: ${result.classification}; ${describeAttempts(result.attempts)}; evidence: ${result.root}\n`,
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    await Bun.write(Bun.stderr, `Recall confirmation stopped: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
