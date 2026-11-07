import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {expect, it} from 'vitest';
import {emptyManagerTree, externalResourceTree, readManagerTreeRoot} from '@threadnote/manager/tree';

effectIt.effect('does not mistake a disappearing descendant for an absent Manager tree root', () =>
  Effect.gen(function* () {
    const missingDescendant = {reason: {_tag: 'NotFound'}} as const;
    const failure = yield* readManagerTreeRoot(
      Effect.void,
      Effect.fail(missingDescendant),
      emptyManagerTree('memories', 'threadnote://user/denys/memories'),
    ).pipe(Effect.flip);

    expect(failure).toBe(missingDescendant);
  }),
);

it('external tree name eligibility excludes only type-independent hidden names inside the external namespace', () => {
  for (const relative of ['external', 'external/pocket/source', 'external/pocket/source/docs']) {
    for (const name of ['.access.json', '..access.json.00000000-0000-4000-8000-000000000001.tmp', '.hidden-folder']) {
      expect(externalResourceTree.entryNameVisible(relative, name)).toBe(false);
      for (const directory of [false, true])
        expect(externalResourceTree.entryVisible(relative, {name, isDirectory: () => directory})).toBe(false);
    }
    for (const name of ['content.md', 'valid.json', 'extensionless']) {
      expect(externalResourceTree.entryNameVisible(relative, name)).toBe(true);
      expect(externalResourceTree.entryVisible(relative, {name, isDirectory: () => true})).toBe(true);
    }
    expect(externalResourceTree.entryVisible(relative, {name: 'valid.json', isDirectory: () => false})).toBe(false);
  }
  for (const relative of ['', 'agent-skills/codex-global', 'external-looking']) {
    expect(externalResourceTree.entryNameVisible(relative, '.keep.json')).toBe(true);
    expect(externalResourceTree.entryVisible(relative, {name: '.keep.json', isDirectory: () => false})).toBe(true);
  }
});

effectIt.effect('only an absent Manager tree root becomes the existing empty tree', () =>
  Effect.gen(function* () {
    const empty = emptyManagerTree('resources', 'threadnote://resources');
    for (const failure of [{code: 'ENOENT'}, {reason: {_tag: 'NotFound'}}]) {
      expect(
        yield* readManagerTreeRoot(Effect.fail(failure), Effect.die('Absent roots must not be read.'), empty),
      ).toBe(empty);
    }
    const denied = {reason: {_tag: 'PermissionDenied'}};
    expect(yield* readManagerTreeRoot(Effect.fail(denied), Effect.succeed(empty), empty).pipe(Effect.flip)).toBe(
      denied,
    );
  }),
);
