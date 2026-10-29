#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';
import {
  assertStage3,
  parseStage3Arguments,
  scanStage3Observations,
  stage3Plan,
  stage3Usage,
} from './support/code-graph-stage3-contract.js';
import {Stage3Driver} from './support/code-graph-stage3-driver.js';
import {runStage3Scenarios} from './support/code-graph-stage3-scenarios.js';
import {Schema} from 'effect';
import {ScriptError} from './effect/errors.js';
import {withStage3Cleanup} from './support/code-graph-stage3-lifecycle.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export async function runStage3Gate(arguments_: readonly string[]) {
  const options = parseStage3Arguments(arguments_);
  if (options.mode === 'plan') return stage3Plan();
  const driver = new Stage3Driver(options);
  return withStage3Cleanup(
    async () => {
      const candidate = await driver.preflight();
      await driver.setup();
      const observations = await runStage3Scenarios(driver);
      const after = await driver.preflight();
      assertStage3(JSON.stringify(candidate) === JSON.stringify(after), 'candidate-changed-during-gate');
      scanStage3Observations(observations, [...driver.forbidden]);
      const result = {
        type: 'code-graph-stage3-release-gate',
        version: 1,
        gate: {status: 'passed'},
        candidate,
        harnessCommit: options.candidateCommit,
        topology: {linkedWorktrees: 3, simultaneousMcpHosts: 2, isolatedHome: true},
        observations,
        retryGuidance: 'Retry only before a strict current claim or when no usable cards survive.',
        claim: 'State, continuity, convergence, and crash recovery observations; no latency claim.',
      } as const;
      // The full artifact is constructed here, never accepted from an input file.
      const encoded = `${JSON.stringify(result, undefined, 2)}\n`;
      assertStage3(
        encoded.length < 64 * 1024 &&
          !EffectArray.some(
            EffectArray.filter([...driver.forbidden], value => Effect.pipe(value, EffectString.startsWith('/'))),
            value => Effect.pipe(encoded, EffectString.includes(value)),
          ),
        'artifact-privacy',
      );
      return result;
    },
    () => driver.cleanup(),
    async result => {
      const encoded = `${JSON.stringify(result, undefined, 2)}\n`;
      const {fs, path} = await driver.services();
      const temporary = await driver.runtime.runPromise(
        fs.makeTempFile({directory: path.dirname(options.output), prefix: '.stage3-'}),
      );
      try {
        await driver.runtime.runPromise(fs.writeFileString(temporary, encoded, {mode: 0o600}));
        // Atomic visibility without replacing an output another invocation created after preflight.
        await driver.runtime.runPromise(fs.link(temporary, options.output));
      } finally {
        await driver.runtime.runPromise(fs.remove(temporary));
      }
    },
    () => driver.runtime.dispose(),
  );
}

if (import.meta.main) {
  if (process.argv.slice(2).includes('--help') || process.argv.slice(2).includes('-h')) {
    process.stdout.write(`${stage3Usage()}\n`);
  } else {
    try {
      const result = await runStage3Gate(process.argv.slice(2));
      process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
    } catch (cause) {
      // Native exceptions and subprocess output are deliberately excluded from retained output.
      const reason =
        Schema.is(ScriptError)(cause) && /^Stage 3 gate refused: [a-z0-9-]+\.$/u.test(cause.message)
          ? cause.message
          : 'Stage 3 gate failed closed.';
      process.stderr.write(`${reason} No passing observation was returned.\n`);
      process.exitCode = 1;
    }
  }
}
