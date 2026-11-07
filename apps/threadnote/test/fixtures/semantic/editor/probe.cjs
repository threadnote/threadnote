/* oxlint-disable typescript/no-require-imports, effecttsgo/node-builtin-import -- VS Code extension tests load CommonJS and the host filesystem APIs; Bun/Effect are not present in the editor runtime. */
/* oxlint-disable eslint/no-undef -- CommonJS exports/require are supplied by the real VS Code extension host. */
/* oxlint-disable effecttsgo/prefer-effect-array -- This standalone extension fixture declares no Effect dependency and runs in the real editor host. */
/* Disposable extension-host feasibility experiment. Never loaded by the product. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const {probeGuardedExchange} = require('./proposal-wire.cjs');

const original = 'const before = 1;\r\n// unsaved 🧵\r\n';
// oxlint-disable-next-line effecttsgo/prefer-effect-string -- This standalone editor-host fixture cannot import Effect.
const changed = original.replace('before', 'after');
const concurrent = '// concurrent user change 🧵\r\n';
const whole = doc => new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));

async function fixtures(name) {
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const targets = [];
  for (const id of ['a', 'b', 'c']) {
    const filename = path.join(folder, `${name}-${id}.txt`);
    await fs.writeFile(filename, '// saved baseline\r\n');
    const doc = await vscode.workspace.openTextDocument(filename);
    const editor = await vscode.window.showTextDocument(doc, {preview: false});
    assert.equal(await editor.edit(edit => edit.replace(whole(doc), original)), true);
    assert.equal(doc.isDirty, true);
    targets.push({doc, text: doc.getText(), version: doc.version});
  }
  return targets;
}

// The editor's actual version-conditioned edit operation is the subject here.
// This local authority/journal is only a fixture; P08 must supply durable authority.
function bridge(targets) {
  let owner = 1;
  let result;
  return {
    apply: async ({raceIndex = -1, transferAfterFirst = false} = {}) => {
      if (result) return result;
      const applied = [];
      const finish = status => (result = {status, applied: [...applied]});
      if (targets.some(t => t.doc.version !== t.version || t.doc.getText() !== t.text)) return finish('conflict');
      const expectedOwner = owner;
      for (const [index, t] of targets.entries()) {
        const editor = await vscode.window.showTextDocument(t.doc, {preview: false});
        if (owner !== expectedOwner || t.doc.version !== t.version || t.doc.getText() !== t.text) {
          return finish(applied.length ? 'partial' : 'conflict');
        }
        /** @type {PromiseLike<boolean> | undefined} */
        let competingWrite;
        const accepted = await editor.edit(edit => {
          // Both operations enter the real host queue after proposal preflight.
          // The inner edit commits first; the outer edit carries the old version.
          if (index === raceIndex) competingWrite = editor.edit(other => other.replace(whole(t.doc), concurrent));
          edit.replace(whole(t.doc), changed);
        });
        if (competingWrite) assert.equal(await competingWrite, true);
        if (!accepted) return finish(applied.length ? 'partial' : 'conflict');
        applied.push(index);
        if (index === 0 && transferAfterFirst) owner++;
      }
      return finish('applied');
    },
  };
}

exports.run = async () => {
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const results = [];
  const record = async (name, test) => {
    try {
      await test();
      results.push({name, status: 'passed'});
    } catch (error) {
      results.push({name, status: 'failed', message: String(error)});
    }
  };
  await record('dirty-buffer-apply-and-idempotent-retry', async () => {
    const targets = await fixtures('normal');
    const candidate = bridge(targets);
    const first = await candidate.apply();
    assert.deepEqual(first, {status: 'applied', applied: [0, 1, 2]});
    const versions = targets.map(t => t.doc.version);
    assert.deepEqual(await candidate.apply(), first);
    assert.deepEqual(
      targets.map(t => t.doc.version),
      versions,
    );
    for (const t of targets) {
      assert.equal(t.doc.getText(), changed);
      assert.equal(await fs.readFile(t.doc.uri.fsPath, 'utf8'), '// saved baseline\r\n');
    }
  });
  for (const raceIndex of [0, 1]) {
    await record(`concurrent-host-write-at-target-${raceIndex}`, async () => {
      const targets = await fixtures(`race${raceIndex}`);
      const candidate = bridge(targets);
      const result = await candidate.apply({raceIndex});
      assert.deepEqual(result, {status: raceIndex ? 'partial' : 'conflict', applied: raceIndex ? [0] : []});
      for (let i = 0; i < raceIndex; i++) assert.equal(targets[i].doc.getText(), changed);
      assert.equal(targets[raceIndex].doc.getText(), concurrent);
      for (let i = raceIndex + 1; i < targets.length; i++) assert.equal(targets[i].doc.getText(), original);
      const texts = targets.map(t => t.doc.getText());
      const versions = targets.map(t => t.doc.version);
      assert.deepEqual(await candidate.apply(), result);
      assert.deepEqual(
        targets.map(t => t.doc.getText()),
        texts,
      );
      assert.deepEqual(
        targets.map(t => t.doc.version),
        versions,
      );
    });
  }
  await record('ownership-transfer-stops-after-first-target', async () => {
    const targets = await fixtures('ownership');
    assert.deepEqual(await bridge(targets).apply({transferAfterFirst: true}), {status: 'partial', applied: [0]});
    assert.deepEqual(
      targets.map(t => t.doc.getText()),
      [changed, original, original],
    );
  });
  await record('unqualified-client-receives-no-edit', async () => {
    const targets = await fixtures('wire');
    const candidate = bridge(targets);
    await probeGuardedExchange(candidate);
    const versions = targets.map(t => t.doc.version);
    await candidate.apply();
    assert.deepEqual(
      targets.map(t => t.doc.version),
      versions,
    );
    for (const target of targets) {
      assert.equal(target.doc.getText(), changed);
      assert.equal(await fs.readFile(target.doc.uri.fsPath, 'utf8'), '// saved baseline\r\n');
    }
  });
  const report = {
    schemaVersion: 1,
    kind: 'editor-feasibility',
    editor: vscode.env.appName,
    version: vscode.version,
    results,
  };
  await fs.writeFile(path.join(folder, 'editor-result.json'), JSON.stringify(report, null, 2) + '\n');
  try {
    assert.ok(
      results.every(r => r.status === 'passed'),
      JSON.stringify(report),
    );
  } finally {
    // Cursor may retain a tray process after extension tests close their window.
    // This command targets only this disposable user-data-dir application.
    await vscode.commands.executeCommand('workbench.action.quit');
  }
};
