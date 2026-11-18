import {readdirSync, readFileSync} from 'node:fs';
import {Array as EffectArray, pipe} from 'effect';
import * as EffectString from 'effect/String';
import {configDefaults, mergeConfig} from 'vitest/config';
import {createVitestConfig} from '../../vitest.config.js';
import WindowsSmokeSequencer from './windows-smoke-sequencer.js';

const DEV_SKILLS = 'apps/threadnote/test/dev-skills';

// A dev-skills file joins the Windows lane when it carries Windows-specific behavior or budgets.
// Platform-neutral files stay covered by the Linux Bazel shards.
export const WINDOWS_SENSITIVE_SOURCE = /win32|[Ww]indows|process\.platform|PATHEXT|pwsh|powershell|\.exe\b/u;

// Declared Windows smoke entries (//:windows_smoke_inputs) that are platform-neutral by source but stay on Windows.
export const DECLARED_WINDOWS_DEV_SKILLS: ReadonlySet<string> = new Set([
  `${DEV_SKILLS}/native-cycle-lifecycle.test.ts`,
  `${DEV_SKILLS}/workflow-citation-recovery.test.ts`,
  `${DEV_SKILLS}/workflow-journal-validation.test.ts`,
  `${DEV_SKILLS}/workflow-memory.test.ts`,
]);

export const platformNeutralDevSkills = (root = '.') =>
  pipe(
    readdirSync(`${root}/${DEV_SKILLS}`),
    EffectArray.filter(EffectString.endsWith('.test.ts')),
    EffectArray.map(name => `${DEV_SKILLS}/${name}`),
    EffectArray.filter(path => !DECLARED_WINDOWS_DEV_SKILLS.has(path)),
    EffectArray.filter(path => !WINDOWS_SENSITIVE_SOURCE.test(readFileSync(`${root}/${path}`, 'utf8'))),
    EffectArray.sort(EffectString.Order),
  );

export default mergeConfig(createVitestConfig(), {
  test: {
    exclude: [...configDefaults.exclude, ...platformNeutralDevSkills()],
    sequence: {sequencer: WindowsSmokeSequencer},
  },
});
