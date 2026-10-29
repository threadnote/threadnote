import {Schema} from 'effect';

export class ManagerOperationError extends Schema.TaggedError<ManagerOperationError, {readonly brand: unique symbol}>()(
  'ManagerOperationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}
