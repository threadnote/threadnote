import {Array as EffectArray} from 'effect';

export interface ManagerRefreshTask {
  readonly label: string;
  readonly run: () => Promise<void>;
}

export async function settleManagerRefreshTasks(tasks: readonly ManagerRefreshTask[]): Promise<readonly string[]> {
  const outcomes = await Promise.all(
    EffectArray.map(tasks, async task => {
      try {
        await task.run();
        return undefined;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return `${task.label}: ${message}`;
      }
    }),
  );
  return EffectArray.filter(outcomes, (outcome): outcome is string => outcome !== undefined);
}
