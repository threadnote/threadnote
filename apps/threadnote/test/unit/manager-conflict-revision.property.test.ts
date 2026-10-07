import {it as effectIt} from '@effect/vitest';
import {Effect, Schema} from 'effect';
import {expect} from 'vitest';
import {shareConflictRevision} from '@threadnote/threadnote/share/conflicts';

effectIt.effect.prop(
  'conflict revision is repeatable and changes when any reviewed version changes',
  {
    content: Schema.String.check(Schema.isMaxLength(500)),
    field: Schema.Literals(['localContent', 'sharedContent', 'previousContent']),
  },
  ({content, field}) =>
    Effect.gen(function* () {
      const conflict = {
        id: 'team:memory.md',
        team: 'team',
        uri: 'threadnote://user/tester/memories/shared/team/durable/projects/demo/memory.md',
        relativePath: 'durable/projects/demo/memory.md',
        reason: 'Local changes',
        status: 'modified' as const,
        hasLocalContent: true,
        hasSharedContent: true,
        hasPreviousContent: true,
        localContent: content,
        sharedContent: 'Shared',
        previousContent: 'Base',
      };
      const revision = yield* shareConflictRevision(conflict);
      expect(yield* shareConflictRevision({...conflict})).toBe(revision);
      expect(yield* shareConflictRevision({...conflict, [field]: conflict[field] + '\nEdited'})).not.toBe(revision);
      expect(conflict.localContent).toBe(content);
    }),
  {arbitrary: {runs: 40}},
);
