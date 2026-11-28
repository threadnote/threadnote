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
      // A Darwin child image differs from the expected code identity; it was refused before it ran.
      'image-mismatch',
      // The kernel did not report the code identity of a Darwin child, which was refused before it ran.
      'code-signature-unavailable',
    ]),
    // Value-free name of the Darwin image check behind an `image-mismatch`; it never carries a flag or digest value.
    check: Schema.optionalKey(Schema.Literals(['entitlements', 'valid', 'kill', 'runtime', 'debuggable', 'cdhash'])),
  },
) {}

export const writerFail = (reason: RuntimeWriterFault['reason'], check?: RuntimeWriterFault['check']): never => {
  throw RuntimeWriterFault.make({reason, ...(check === undefined ? {} : {check})});
};
