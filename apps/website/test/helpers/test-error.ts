import {Schema} from 'effect';
/** Typed failure for deliberate test-boundary failures and injected faults. */
export class TestError extends Schema.TaggedError<TestError, {readonly brand: unique symbol}>()('TestError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}
