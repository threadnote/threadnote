import {Array as EffectArray, Result, String as EffectString, pipe} from 'effect';
import type {DoctorCheck} from '../types.js';

export function parseDoctorChecksFromOutput(output: string): readonly DoctorCheck[] {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  return EffectArray.filterMap(EffectString.split(output, /\r?\n/), line => {
    const plain = pipe(line, EffectString.replace(ansiEscape, ''), EffectString.trim);
    const match = /^(OK|WARN|FAIL)\s+([^:]+):\s*(.*)$/.exec(plain);
    return match === null
      ? Result.failVoid
      : Result.succeed({
          detail: match[3] ?? '',
          name: match[2] ?? '',
          status: doctorStatus(match[1] ?? ''),
        });
  });
}

function doctorStatus(value: string): DoctorCheck['status'] {
  if (value === 'OK') return 'ok';
  if (value === 'FAIL') return 'fail';
  return 'warn';
}
