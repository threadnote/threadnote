import {Array as Arr} from 'effect';
export const liveFrame = (type: string, rest: Record<string, unknown> = {}) =>
  JSON.stringify({type, version: 1, ...rest});

export class FakeManagerSocket {
  static instances: FakeManagerSocket[] = [];
  readyState: 0 | 1 | 2 | 3 = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  constructor(_url: string) {
    FakeManagerSocket.instances.push(this);
  }
  send(value: string) {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    this.sent.push(parsed);
    if (parsed.type === 'heartbeat') this.emit(liveFrame('heartbeat', {epoch: 'epoch-one'}));
  }
  close() {
    this.readyState = 3;
  }
  emit(value: string) {
    this.onmessage?.({data: value} as MessageEvent);
  }
  open(topics: string[], snapshots?: string[]) {
    this.readyState = 1;
    this.onopen?.({} as Event);
    this.emit(liveFrame('welcome', {epoch: 'epoch-one', topics, heartbeatMilliseconds: 15_000, snapshots}));
  }
  ack(startingSequence = 0) {
    const generation = Arr.filter(this.sent, item => item.type === 'subscribe').at(-1)?.generation;
    this.emit(liveFrame('subscribed', {epoch: 'epoch-one', generation, startingSequence}));
  }
  invalidate(sequence: number, resource: Record<string, unknown>) {
    const generation = Arr.filter(this.sent, item => item.type === 'subscribe').at(-1)?.generation;
    this.emit(
      liveFrame('invalidation', {epoch: 'epoch-one', generation, sequence, resource, revision: String(sequence)}),
    );
  }
  snapshot(sequence: number, resource: Record<string, unknown>, data: unknown) {
    const generation = Arr.filter(this.sent, item => item.type === 'subscribe').at(-1)?.generation;
    this.emit(liveFrame('snapshot', {epoch: 'epoch-one', generation, sequence, resource, data}));
  }
}
