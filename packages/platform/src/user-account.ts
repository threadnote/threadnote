import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';

/** A primary group classified from the local account files: see `classifyUserPrimaryGroup`. */
export interface UserPrimaryGroup {
  readonly gid: number;
  readonly kind: 'private' | 'shared' | 'unknown';
}

/** The local account databases, read by the caller. */
export interface LocalAccountFiles {
  readonly passwd: string;
  readonly group: string;
  readonly nsswitch: string;
}

/** The minimal synchronous file API needed to read the account databases. */
interface AccountFileSystem {
  readonly openSync: (path: string, flags: string) => number;
  readonly fstatSync: (descriptor: number) => {readonly size: number; isFile(): boolean};
  readonly readSync: (
    descriptor: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly closeSync: (descriptor: number) => void;
}
const ACCOUNT_FILE_MAXIMUM_BYTES = 4 * 1_048_576;
/** Bounded read of one regular file, or undefined when it is missing, irregular, oversized or short. */
function readBoundedText(fs: AccountFileSystem, path: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(path, 'r');
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > ACCOUNT_FILE_MAXIMUM_BYTES) return undefined;
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (read === 0) return undefined;
      offset += read;
    }
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
/** The three local account databases, each size-capped; undefined when any cannot be read. */
export function readLocalAccountFiles(fs: AccountFileSystem): LocalAccountFiles | undefined {
  const passwd = readBoundedText(fs, '/etc/passwd');
  const group = readBoundedText(fs, '/etc/group');
  const nsswitch = readBoundedText(fs, '/etc/nsswitch.conf');
  return passwd === undefined || group === undefined || nsswitch === undefined ? undefined : {passwd, group, nsswitch};
}

const LOCAL_NSS_SOURCES = new Set(['files', 'systemd', 'altfiles']);
const decimalId = (value: string | undefined): number | undefined =>
  value !== undefined && /^\d+$/u.test(value) ? Number(value) : undefined;
const records = (text: string) =>
  EffectArray.filter(
    EffectArray.map(EffectString.split('\n')(text), line => EffectString.trim(line)),
    line => line !== '' && !EffectString.startsWith('#')(line),
  );

/** True when nsswitch.conf resolves `database` from local files only (bracketed actions are ignored). */
function localOnly(nsswitch: string, database: 'passwd' | 'group'): boolean {
  const entries = EffectArray.filter(records(nsswitch), line => EffectString.startsWith(`${database}:`)(line));
  if (entries.length !== 1) return false;
  const tokens = EffectArray.takeWhile(
    EffectString.split(/\s+/u)(EffectString.trim(EffectString.slice(database.length + 1)(entries[0]))),
    token => !EffectString.startsWith('#')(token),
  );
  const sources = EffectArray.filter(tokens, token => token !== '' && !EffectString.startsWith('[')(token));
  return sources.length > 0 && EffectArray.every(sources, source => LOCAL_NSS_SOURCES.has(source));
}

/**
 * Whether a user's primary group is a user-private group (UPG). It answers `private` only when NSS resolves users and
 * groups from local files alone (no compat `+`/`-` entries either), the user's own passwd entry is present, no other
 * account has that primary group, exactly one group entry carries the gid, and it lists no other member. Another
 * account or member makes it `shared`; anything the local files cannot settle is `unknown`. Pure: the caller supplies
 * the files.
 */
export function classifyUserPrimaryGroup(
  uid: number,
  gid: number,
  accounts: LocalAccountFiles | undefined,
): UserPrimaryGroup {
  const unknown = {gid, kind: 'unknown'} as const;
  if (accounts === undefined) return unknown;
  if (!localOnly(accounts.nsswitch, 'passwd') || !localOnly(accounts.nsswitch, 'group')) return unknown;
  const passwd = records(accounts.passwd);
  const group = records(accounts.group);
  const compat = (line: string) => EffectString.startsWith('+')(line) || EffectString.startsWith('-')(line);
  if (EffectArray.some(passwd, compat) || EffectArray.some(group, compat)) return unknown;
  let user: string | undefined;
  for (const fields of EffectArray.map(passwd, EffectString.split(':'))) {
    if (fields.length < 4) continue;
    if (decimalId(fields[2]) === uid) user = fields[0];
    else if (decimalId(fields[3]) === gid) return {gid, kind: 'shared'};
  }
  if (user === undefined) return unknown;
  const entries = EffectArray.filter(
    EffectArray.map(group, EffectString.split(':')),
    fields => fields.length >= 4 && decimalId(fields[2]) === gid,
  );
  if (entries.length === 0) return unknown;
  if (entries.length > 1) return {gid, kind: 'shared'};
  const others = EffectArray.filter(EffectString.split(',')(entries[0][3]), member => member !== '' && member !== user);
  return {gid, kind: others.length === 0 ? 'private' : 'shared'};
}
