import {expect, it} from 'vitest';
import fc from 'fast-check';
import {Array as EffectArray} from 'effect';
import {parseDoctorChecksFromOutput} from '../../src/manager/doctor_output.js';

it('preserves doctor row order and values across plain and ANSI-colored output', () => {
  const statuses = {OK: 'ok', WARN: 'warn', FAIL: 'fail'} as const;
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          status: fc.constantFrom('OK', 'WARN', 'FAIL'),
          name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,20}$/),
          detail: fc.stringMatching(/^[A-Za-z0-9._-]{0,30}$/),
          colored: fc.boolean(),
        }),
        {maxLength: 20},
      ),
      rows => {
        const escape = String.fromCharCode(27);
        const output = EffectArray.join(
          EffectArray.map(rows, row => {
            const status = row.colored ? `${escape}[32m${row.status}${escape}[0m` : row.status;
            return `${status} ${row.name}: ${row.detail}`;
          }),
          '\n',
        );
        expect(parseDoctorChecksFromOutput(output)).toEqual(
          EffectArray.map(rows, row => ({
            detail: row.detail,
            name: row.name,
            status: statuses[row.status],
          })),
        );
      },
    ),
    {numRuns: 100},
  );
});
