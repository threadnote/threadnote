import assert from 'node:assert/strict';

const result = Bun.spawnSync(['tools/bazel/spike/standalone/threadnote-spike'], {stdout: 'pipe', stderr: 'pipe'});
assert.equal(result.exitCode, 0, result.stderr.toString());
assert.deepEqual(JSON.parse(result.stdout.toString()), {result: {answer: 42}, effect: 'ok', bun: '1.4.4'});
