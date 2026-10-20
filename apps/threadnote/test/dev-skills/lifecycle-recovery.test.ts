import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {applyDevSkills} from '../../src/dev_skills/index.js';
import {homeIndexPath, runtimeIndexPath} from '../../src/dev_skills/registry.js';
import {devSkillsTestLayer, fixture, snapshot} from './service-fixture.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const selector = {agent: 'codex'};
const interrupted = Effect.fn(function* () {
  const f = yield* fixture();
  let failed = false;
  const failing = FileSystem.FileSystem.of({
    ...f.fs,
    rename: (from, to) => {
      if (!failed && f.path.basename(to) === 'journal.json') {
        failed = true;
        return f.fs.rename(from, to).pipe(Effect.andThen(f.fs.rename(f.path.join(f.root, 'missing'), to)));
      }
      return f.fs.rename(from, to);
    },
  });
  expect(
    yield* f
      .run(applyDevSkills(f.config, 'install', selector))
      .pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.result),
  ).toMatchObject({_tag: 'Failure'});
  expect(failed).toBe(true);
  const journalFile = f.path.join(f.host, '.agents/skills/.threadnote-dev-skills/journal.json');
  const journal = JSON.parse(yield* f.fs.readFileString(journalFile)) as {
    changes: {path: string; before: string | null; after: string | null}[];
  };
  return {...f, journalFile, journal};
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(TestClock.withLive, provideTestLayer(devSkillsTestLayer));

describe('complete persisted transition coverage', () => {
  effectIt.effect.prop(
    'preserves an incomplete intent before any recovery publication',
    {
      omitted: Schema.Array(
        Schema.Literals(['home', 'runtime', 'dev-spec', 'dev-plan', 'dev-cycle', 'watch-pr']),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
    },
    ({omitted}) =>
      Effect.gen(function* () {
        const f = yield* interrupted();
        const omittedPaths = new Set(
          omitted.map(member =>
            member === 'home'
              ? homeIndexPath(f.path, f.home)
              : member === 'runtime'
                ? runtimeIndexPath(f.path, f.runtime)
                : f.path.join(f.host, '.agents/skills', member, 'SKILL.md'),
          ),
        );
        f.journal.changes = f.journal.changes.filter(change => !omittedPaths.has(change.path));
        yield* f.fs.writeFileString(f.journalFile, JSON.stringify(f.journal));
        const before = yield* snapshot(f.root);
        expect(yield* f.run(applyDevSkills(f.config, 'install', selector)).pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'invalid-state'},
        });
        expect(yield* snapshot(f.root)).toEqual(before);
      }).pipe(provide),
    {arbitrary: {runs: 12}},
  );

  effectIt.effect('accepts omitted entries only when their exact postimages already exist', () =>
    Effect.gen(function* () {
      const f = yield* interrupted();
      const completed = f.journal.changes.filter(
        change =>
          change.path === homeIndexPath(f.path, f.home) || change.path.endsWith(f.path.join('dev-spec', 'SKILL.md')),
      );
      for (const change of completed) {
        yield* f.fs.makeDirectory(f.path.dirname(change.path), {recursive: true});
        yield* f.fs.writeFileString(change.path, change.after!);
      }
      f.journal.changes = f.journal.changes.filter(change => !completed.includes(change));
      yield* f.fs.writeFileString(f.journalFile, JSON.stringify(f.journal));
      expect(yield* f.run(applyDevSkills(f.config, 'install', selector))).toMatchObject({recovered: true});
      expect(yield* f.fs.exists(f.journalFile)).toBe(false);
      expect(yield* f.run(applyDevSkills(f.config, 'install', selector))).toMatchObject({applied: false});
    }).pipe(provide),
  );
});
