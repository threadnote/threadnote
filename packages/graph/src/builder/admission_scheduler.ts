import {Array as EffectArray, Option as EffectOption} from 'effect';
export const CODE_GRAPH_BUILDER_HOME_CAPACITY = 2;
export const CODE_GRAPH_BUILDER_BACKGROUND_AGING_MILLISECONDS = 30_000;

export type CodeGraphBuilderAdmissionClass = 'background' | 'current-required';

export interface CodeGraphBuilderAdmissionIdentity {
  readonly checkoutId: string;
  readonly worktreeId: string;
  readonly requestKey?: string;
  readonly desiredOverlayDigest?: string;
}

export interface CodeGraphBuilderAdmissionQueue {
  readonly admissionClass: CodeGraphBuilderAdmissionClass;
  readonly enqueuedAt: string;
  readonly position: number;
  readonly size: number;
}

export interface CodeGraphBuilderAdmissionCandidate {
  readonly admissionClass: CodeGraphBuilderAdmissionClass;
  readonly checkoutId?: string;
  readonly createdAt: number;
  readonly token: string;
}

function isAgedBackgroundTicket(ticket: CodeGraphBuilderAdmissionCandidate, nowMilliseconds: number): boolean {
  return (
    ticket.admissionClass === 'background' &&
    nowMilliseconds - ticket.createdAt >= CODE_GRAPH_BUILDER_BACKGROUND_AGING_MILLISECONDS
  );
}

function agedBackgroundCheckoutIds(
  tickets: readonly CodeGraphBuilderAdmissionCandidate[],
  nowMilliseconds: number,
): ReadonlySet<string> {
  return new Set(
    EffectArray.flatMap(tickets, ticket =>
      isAgedBackgroundTicket(ticket, nowMilliseconds) && ticket.checkoutId !== undefined ? [ticket.checkoutId] : [],
    ),
  );
}

function isReservedForegroundTicket(
  ticket: CodeGraphBuilderAdmissionCandidate,
  reservedCheckouts: ReadonlySet<string>,
) {
  return (
    ticket.admissionClass === 'current-required' &&
    ticket.checkoutId !== undefined &&
    reservedCheckouts.has(ticket.checkoutId)
  );
}

/** Old callers without a clock retain the original priority/FIFO ordering. */
export function orderCodeGraphBuilderAdmissionTickets<T extends CodeGraphBuilderAdmissionCandidate>(
  tickets: readonly T[],
  nowMilliseconds = 0,
): readonly T[] {
  const rank = (ticket: T) =>
    ticket.admissionClass === 'current-required' || isAgedBackgroundTicket(ticket, nowMilliseconds) ? 0 : 1;
  return [...tickets].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      left.createdAt - right.createdAt ||
      (left.token < right.token ? -1 : left.token > right.token ? 1 : 0),
  );
}

/** Unknown legacy checkout identities count toward capacity, but never imply shared ownership. */
export function selectCodeGraphBuilderAdmissionTickets<T extends CodeGraphBuilderAdmissionCandidate>(
  tickets: readonly T[],
  activeCheckoutIds: readonly (string | undefined)[],
  nowMilliseconds: number,
): readonly T[] {
  const availableSlots = Math.max(0, CODE_GRAPH_BUILDER_HOME_CAPACITY - activeCheckoutIds.length);
  const occupied = new Set(EffectArray.filter(activeCheckoutIds, id => id !== undefined));
  const reservedCheckouts = agedBackgroundCheckoutIds(tickets, nowMilliseconds);
  const selected: T[] = [];
  for (const ticket of orderCodeGraphBuilderAdmissionQueue(tickets, activeCheckoutIds, nowMilliseconds)) {
    if (selected.length === availableSlots) break;
    if (isReservedForegroundTicket(ticket, reservedCheckouts)) continue;
    // Background worktrees of one checkout share a graph database. Avoid two
    // large, speculative materializations competing for its filesystem.
    if (ticket.admissionClass === 'background' && ticket.checkoutId !== undefined && occupied.has(ticket.checkoutId))
      continue;
    selected.push(ticket);
    if (ticket.checkoutId !== undefined) occupied.add(ticket.checkoutId);
  }
  return selected;
}

/** Project an advisory total order from current occupancy; recompute it whenever a slot changes. */
export function orderCodeGraphBuilderAdmissionQueue<T extends CodeGraphBuilderAdmissionCandidate>(
  tickets: readonly T[],
  activeCheckoutIds: readonly (string | undefined)[],
  nowMilliseconds: number,
): readonly T[] {
  const remaining = [...orderCodeGraphBuilderAdmissionTickets(tickets, nowMilliseconds)];
  const occupied = new Set(EffectArray.filter(activeCheckoutIds, id => id !== undefined));
  const reservedCheckouts = agedBackgroundCheckoutIds(tickets, nowMilliseconds);
  const selected: T[] = [];
  while (remaining.length > 0) {
    const nextIndex = EffectOption.getOrElse(
      EffectArray.findFirstIndex(
        remaining,
        ticket =>
          !isReservedForegroundTicket(ticket, reservedCheckouts) &&
          (ticket.checkoutId === undefined || !occupied.has(ticket.checkoutId)),
      ),
      () => -1,
    );
    const reservedIndex = EffectOption.getOrElse(
      EffectArray.findFirstIndex(remaining, ticket => !isReservedForegroundTicket(ticket, reservedCheckouts)),
      () => -1,
    );
    const [next] = remaining.splice(nextIndex >= 0 ? nextIndex : reservedIndex >= 0 ? reservedIndex : 0, 1);
    selected.push(next);
    if (next.checkoutId !== undefined) occupied.add(next.checkoutId);
  }
  return selected;
}
