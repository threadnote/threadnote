import {Predicate} from 'effect';
import {rm} from '@threadnote/testing/node-fs-promises';

/** Bun 1.4.4 parses fs.rm retry options but does not execute their retry policy. */
export async function removeCompiledFixture(
  root: string,
  dependencies: {remove?: typeof rm; wait?: (milliseconds: number) => Promise<void>} = {},
): Promise<void> {
  const remove = dependencies.remove ?? rm;
  const wait = dependencies.wait ?? (milliseconds => new Promise<void>(done => setTimeout(done, milliseconds)));
  for (let attempt = 0; ; attempt++) {
    try {
      await remove(root, {recursive: true, force: true});
      return;
    } catch (error) {
      if (
        attempt >= 10 ||
        !Predicate.hasProperty(error, 'code') ||
        !['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'].includes(String(error.code))
      )
        throw error;
      await wait(50 * (attempt + 1));
    }
  }
}
