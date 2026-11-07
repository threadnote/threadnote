import type {FullConfig, Reporter, Suite} from '@playwright/test/reporter';
import {Array as EffectArray} from 'effect';

export default class RequiredCasesReporter implements Reporter {
  private suite?: Suite;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.suite = suite;
  }

  async onEnd(): Promise<{status: 'failed'} | undefined> {
    const nonPassing = EffectArray.filter(
      this.suite?.allTests() ?? [],
      test => test.expectedStatus !== 'passed' || EffectArray.some(test.results, result => result.status === 'skipped'),
    );
    if (nonPassing.length === 0) return undefined;
    process.stderr.write(
      'Manager E2E cannot pass with non-passing cases: ' +
        EffectArray.join(
          EffectArray.map(nonPassing, test => EffectArray.join(test.titlePath(), ' > ')),
          ', ',
        ) +
        '\n',
    );
    return {status: 'failed'};
  }
}
