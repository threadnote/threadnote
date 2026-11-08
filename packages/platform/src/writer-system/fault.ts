import {Schema} from 'effect';

export class RuntimeWriterFault extends Schema.TaggedError<RuntimeWriterFault, {readonly brand: unique symbol}>()(
  'RuntimeWriterFault',
  {
    reason: Schema.Literals([
      'unsupported-platform',
      'identity',
      'path',
      'readonly',
      'source-changed',
      'private-storage',
      'io',
    ]),
  },
) {}

export const writerFail = (reason: RuntimeWriterFault['reason']): never => {
  throw RuntimeWriterFault.make({reason});
};
