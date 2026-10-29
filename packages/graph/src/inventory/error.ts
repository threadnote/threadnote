import {Schema} from 'effect';
export class CodeGraphInventoryError extends Schema.TaggedError<
  CodeGraphInventoryError,
  {readonly brand: unique symbol}
>()('CodeGraphInventoryError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {
  static of(message: string, options?: ErrorOptions): CodeGraphInventoryError {
    return CodeGraphInventoryError.make({
      message,
      ...(options?.cause === undefined ? {} : {cause: options.cause}),
    });
  }
}
