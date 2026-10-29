import {Array as EffectArray, Option as EffectOption, pipe as EffectPipe} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {classifyCodeGraphStoreFailure, codeGraphStoreSchemaAdditiveRequired} from '@threadnote/graph/store/failure';
import {
  CodeGraphStoreBusyError,
  CodeGraphStoreCorruptionError,
  CodeGraphStoreError,
  CodeGraphStoreNoSpaceError,
  CodeGraphStorePermissionError,
  CodeGraphStoreSchemaAdditiveError,
  CodeGraphStoreTransientIoError,
} from '@threadnote/graph/types';

describe('code graph store failure classification', () => {
  it.each([
    [{code: 'SQLITE_BUSY_TIMEOUT'}, CodeGraphStoreBusyError, 'busy', true, 'defer'],
    [{code: 5}, CodeGraphStoreBusyError, 'busy', true, 'defer'],
    [{code: 'SQLITE_FULL'}, CodeGraphStoreNoSpaceError, 'no-space', false, 'free-space'],
    [{code: 13 + 2 * 256}, CodeGraphStoreNoSpaceError, 'no-space', false, 'free-space'],
    [{code: 'ENOSPC'}, CodeGraphStoreNoSpaceError, 'no-space', false, 'free-space'],
    [{code: 'SQLITE_READONLY_DIRECTORY'}, CodeGraphStorePermissionError, 'permission', false, 'fix-permissions'],
    [{code: 'EACCES'}, CodeGraphStorePermissionError, 'permission', false, 'fix-permissions'],
    [{reason: {_tag: 'PermissionDenied'}}, CodeGraphStorePermissionError, 'permission', false, 'fix-permissions'],
    [{code: 'SQLITE_IOERR_READ'}, CodeGraphStoreTransientIoError, 'transient-io', true, 'retry-read-only'],
    [{code: 'SQLITE_CANTOPEN'}, CodeGraphStoreTransientIoError, 'transient-io', true, 'retry-read-only'],
    [{reason: {_tag: 'TimedOut'}}, CodeGraphStoreTransientIoError, 'transient-io', true, 'retry-read-only'],
    [{reason: {_tag: 'WouldBlock'}}, CodeGraphStoreTransientIoError, 'transient-io', true, 'retry-read-only'],
    [{reason: {_tag: 'UnexpectedEof'}}, CodeGraphStoreTransientIoError, 'transient-io', true, 'retry-read-only'],
    [{reason: {_tag: 'WriteZero'}}, CodeGraphStoreTransientIoError, 'transient-io', true, 'retry-read-only'],
    [
      {reason: {_tag: 'UnknownError', cause: {code: 'SQLITE_CORRUPT_INDEX'}}},
      CodeGraphStoreCorruptionError,
      'confirmed-corruption',
      false,
      'manual-rebuild',
    ],
    [{code: 26}, CodeGraphStoreCorruptionError, 'confirmed-corruption', false, 'manual-rebuild'],
  ] as const)(
    'classifies structured cause %# without reading its message',
    (cause, ErrorClass, code, retryable, recovery) => {
      const failure = classifyCodeGraphStoreFailure('load code graph snapshot', cause);

      expect(failure).toBeInstanceOf(ErrorClass);
      expect(failure).toMatchObject({code, operation: 'load code graph snapshot', recovery, retryable});
    },
  );

  it('preserves the existing busy subtype constructor API with typed metadata defaults', () => {
    const failure = CodeGraphStoreBusyError.of('fixture busy');

    expect(failure).toMatchObject({
      code: 'busy',
      message: 'fixture busy',
      operation: 'code graph storage',
      recovery: 'defer',
      retryable: true,
    });
  });

  it('lets a specific nested no-space code outrank a generic outer connection failure', () => {
    const failure = classifyCodeGraphStoreFailure('initialize code graph database', {
      code: 'SQLITE_CANTOPEN',
      cause: {code: 'ENOSPC'},
    });

    expect(failure).toBeInstanceOf(CodeGraphStoreNoSpaceError);
  });

  it('fails closed when mixed busy and corruption evidence is aggregated', () => {
    const failure = classifyCodeGraphStoreFailure('load code graph snapshot', {
      errors: [{code: 'SQLITE_CORRUPT'}, {code: 'SQLITE_BUSY'}],
    });

    expect(failure).toBeInstanceOf(CodeGraphStoreBusyError);
    expect(failure.code).toBe('busy');
  });

  it('never infers additive schema or corruption from free-form diagnostic text', () => {
    const failure = classifyCodeGraphStoreFailure('initialize code graph database', {
      message: 'SQLITE_CORRUPT: no such table snapshot_leases at /Users/private/store.sqlite',
      reason: {_tag: 'SqlSyntaxError'},
    });

    expect(failure).toMatchObject({code: 'unknown', recovery: 'diagnose', retryable: false});
    expect(failure).not.toBeInstanceOf(CodeGraphStoreCorruptionError);
    expect(failure).not.toBeInstanceOf(CodeGraphStoreSchemaAdditiveError);
    expect(failure.message).not.toContain('/Users/private');
  });

  it('keeps Bun SQLite errno values in the SQLite domain instead of misclassifying EPERM', () => {
    const failure = classifyCodeGraphStoreFailure('load code graph adjacency', {
      errno: 1,
      message: 'no query solution',
      name: 'SQLiteError',
    });

    expect(failure).toMatchObject({code: 'unknown', recovery: 'diagnose', retryable: false});
    expect(failure).not.toBeInstanceOf(CodeGraphStorePermissionError);
  });

  it('constructs schema-additive recovery only through the explicit preflight result', () => {
    const failure = codeGraphStoreSchemaAdditiveRequired('initialize code graph database', {
      createsOnly: true,
      preservesActivePointers: true,
      preservesSnapshots: true,
    });

    expect(failure).toBeInstanceOf(CodeGraphStoreSchemaAdditiveError);
    expect(failure).toMatchObject({
      code: 'schema-additive',
      recovery: 'migrate-additive',
      retryable: false,
    });
  });

  it('fails closed when an additive-schema preflight does not prove every non-destructive invariant', () => {
    expect(() =>
      codeGraphStoreSchemaAdditiveRequired('initialize code graph database', {
        // @ts-expect-error -- This negative fixture verifies rejection of a preflight that does not prove createsOnly.
        createsOnly: false,
        preservesActivePointers: true,
        preservesSnapshots: true,
      }),
    ).toThrow(CodeGraphStoreError);
  });

  it('deterministically classifies bounded nested causes without leaking arbitrary diagnostics', () => {
    const stableCodes = fc.constantFrom(
      ['SQLITE_FULL', 'no-space'] as const,
      ['SQLITE_READONLY', 'permission'] as const,
      ['SQLITE_BUSY', 'busy'] as const,
      ['SQLITE_IOERR_SHORT_READ', 'transient-io'] as const,
      ['SQLITE_CORRUPT', 'confirmed-corruption'] as const,
      ['UNRECOGNIZED_NATIVE_CODE', 'unknown'] as const,
    );
    fc.assert(
      fc.property(
        stableCodes,
        fc
          .array(fc.constantFrom(...'0123456789abcdef'), {maxLength: 32, minLength: 8})
          .map(characters => `PRIVATE_${EffectArray.join(characters, '')}`),
        fc.integer({max: 5, min: 0}),
        ([code, expected], privateToken, depth) => {
          const privatePath = `/Users/private/${privateToken}/graph.sqlite`;
          let cause: unknown = {code, message: `${privateToken} ${privatePath}`};
          for (let index = 0; index < depth; index += 1) cause = {cause, message: privatePath};

          const first = classifyCodeGraphStoreFailure('read /Users/private/graph.sqlite', cause);
          const second = classifyCodeGraphStoreFailure('read /Users/private/graph.sqlite', cause);
          const projection = (failure: typeof first) => ({
            code: failure.code,
            message: failure.message,
            operation: failure.operation,
            recovery: failure.recovery,
            retryable: failure.retryable,
          });

          expect(projection(first)).toEqual(projection(second));
          expect(first.code).toBe(expected);
          expect(first.operation).toBe('code graph storage');
          expect(first.message).not.toContain('/Users/private');
          expect(first.message).not.toContain(privateToken);
          if (expected === 'unknown') {
            expect(first.code).not.toBe('confirmed-corruption');
            expect(first.code).not.toBe('schema-additive');
          }
        },
      ),
      {numRuns: 250},
    );
  });

  it('bounds cause traversal and fails closed when stable evidence is beyond the limit', () => {
    let cause: unknown = {code: 'SQLITE_CORRUPT'};
    for (let index = 0; index < 100; index += 1) cause = {cause};

    expect(classifyCodeGraphStoreFailure('diagnose code graph database', cause)).toMatchObject({code: 'unknown'});
  });

  it('selects the fail-closed precedence model independently of aggregate order', () => {
    const evidence = fc.constantFrom(
      {code: 'SQLITE_FULL', expected: 'no-space', rank: 0},
      {code: 'SQLITE_READONLY', expected: 'permission', rank: 1},
      {code: 'SQLITE_BUSY', expected: 'busy', rank: 2},
      {code: 'SQLITE_IOERR', expected: 'transient-io', rank: 3},
      {code: 'SQLITE_CORRUPT', expected: 'confirmed-corruption', rank: 4},
      {code: 'UNRECOGNIZED_NATIVE_CODE', expected: 'unknown', rank: 5},
    );
    fc.assert(
      fc.property(fc.array(evidence, {maxLength: 20, minLength: 1}), observations => {
        const expected = EffectPipe(observations, __effectReduceValues =>
          EffectArray.reduce(
            EffectArray.drop(__effectReduceValues, 1),
            EffectOption.getOrElse(EffectArray.head(__effectReduceValues), () => {
              throw new TypeError('Reduce of empty array with no initial value');
            }),
            (best, candidate) => (candidate.rank < best.rank ? candidate : best),
          ),
        );
        const forward = classifyCodeGraphStoreFailure('load code graph snapshot', {
          errors: EffectArray.map(observations, ({code}) => ({code})),
        });
        const reversed = classifyCodeGraphStoreFailure('load code graph snapshot', {
          errors: EffectArray.map([...observations].reverse(), ({code}) => ({code})),
        });

        expect(forward.code).toBe(expected.expected);
        expect(reversed.code).toBe(expected.expected);
      }),
      {numRuns: 250},
    );
  });

  it('bounds admission from a wide proxied AggregateError array', () => {
    let elementReads = 0;
    const errors = new Proxy(
      Array.from({length: 10_000}, (_, index) =>
        index === 9_999 ? {code: 'SQLITE_CORRUPT'} : {code: 'UNRECOGNIZED_NATIVE_CODE'},
      ),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/u.test(property)) elementReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(classifyCodeGraphStoreFailure('diagnose code graph database', {errors})).toMatchObject({code: 'unknown'});
    expect(elementReads).toBeLessThanOrEqual(30);
  });
});
