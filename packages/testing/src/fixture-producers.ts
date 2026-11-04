import {Array as EffectArray} from 'effect';

/** Direct-child event evidence; callers register a slot before starting a process. */
export type FixtureProducerResult =
  | {readonly state: 'exited'; readonly code: number | null; readonly signal: NodeJS.Signals | null}
  | {readonly state: 'unknown'};

export interface FixtureProducerObservation {
  readonly spawned: () => void;
  readonly exited: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly closed: () => void;
  readonly failed: () => void;
}

export class FixtureProducers {
  private readonly observations: Array<{readonly result: () => FixtureProducerResult}> = [];
  private sealed = false;

  register(): FixtureProducerObservation {
    if (this.sealed) throw new Error('Fixture producer registry already sealed');
    let didSpawn = false;
    let didClose = false;
    let didFail = false;
    let exit: {readonly code: number | null; readonly signal: NodeJS.Signals | null} | undefined;
    this.observations.push({
      result: () => (didSpawn && didClose && !didFail && exit ? {state: 'exited', ...exit} : {state: 'unknown'}),
    });
    return {
      spawned: () => {
        didSpawn = true;
      },
      exited: (code, signal) => {
        exit = {code, signal};
      },
      closed: () => {
        didClose = true;
      },
      failed: () => {
        didFail = true;
      },
    };
  }

  /** Freeze registration before evaluating evidence so later launches cannot escape cleanup. */
  seal(): readonly FixtureProducerResult[] {
    this.sealed = true;
    return EffectArray.map(this.observations, observation => observation.result());
  }
}
