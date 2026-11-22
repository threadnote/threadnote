import {Database} from 'bun:sqlite';
import {writeFileSync} from 'node:fs';

const output = process.env.THREADNOTE_LEXICAL_STATEMENT_TIMINGS_OUT;
if (!output) throw new Error('Missing owned lexical timing output.');

const labels = {
  termCandidates: /\bselect\s+symbol_id\s*,\s*sum\(weight\)\s+as\s+score\b/i,
  symbolHydration: /^\s*with\s+matching_symbols\s+as\s*\(/i,
};
const totals = Object.fromEntries(
  Object.keys(labels).map(label => [label, {calls: 0, rows: 0, cpuMicros: 0, wallMillis: 0}]),
);
const instrumented = new WeakSet();
const query = Database.prototype.query;
Database.prototype.query = function (sql, ...options) {
  const statement = query.call(this, sql, ...options);
  if (typeof sql !== 'string' || instrumented.has(statement)) return statement;
  const label = Object.keys(labels).find(name => labels[name].test(sql));
  if (label === undefined) return statement;

  const all = statement.all;
  instrumented.add(statement);
  statement.all = function (...params) {
    const started = performance.now();
    const cpuBefore = process.cpuUsage();
    const rows = all.apply(this, params);
    const cpu = process.cpuUsage(cpuBefore);
    totals[label].calls += 1;
    totals[label].rows += rows.length;
    totals[label].cpuMicros += cpu.user + cpu.system;
    totals[label].wallMillis += performance.now() - started;
    return rows;
  };
  return statement;
};
process.on('exit', () => {
  writeFileSync(output, JSON.stringify({kind: 'statement-timing-diagnostic', totals}) + '\n');
});
