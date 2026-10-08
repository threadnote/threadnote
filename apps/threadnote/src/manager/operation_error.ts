import {Schema} from 'effect';

export class ManagerOperationError extends Schema.TaggedError<ManagerOperationError>()('ManagerOperationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}
