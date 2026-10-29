import {Database} from 'bun:sqlite';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Probe the sandbox's declared input boundary.
import {existsSync} from 'node:fs';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {expect} from 'vitest';
import {answer} from '@threadnote/spike-library';

effectIt.effect('runs Effect and Bun SQLite inside the declared source closure', () =>
  Effect.gen(function* () {
    expect(Bun.version).toBe('1.4.4');
    expect(answer).toBe(42);
    expect(existsSync('src/code_graph')).toBe(false);
    expect(existsSync('packages/graph')).toBe(false);
    expect(existsSync('node_modules/web-tree-sitter')).toBe(false);
    const database = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(':memory:')),
      database => Effect.sync(() => database.close()),
    );
    database.run('CREATE TABLE items (value INTEGER NOT NULL)');
    database.query('INSERT INTO items VALUES (?)').run(42);
    expect(database.query('SELECT value FROM items').get()).toEqual({value: 42});
    expect(yield* Effect.succeed('effect')).toBe('effect');
  }),
);
