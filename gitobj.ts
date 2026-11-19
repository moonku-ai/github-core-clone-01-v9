// gitobj.ts — the git object layer: hashing, commit/tree/tag parsing and building,
// packfile read/write (full objects only, no deltas on the wire), pkt-lines, and the
// graph walks fetch, merge-base and the REST surface need.
//
// Everything here is pure and synchronous except the pack reader's rare fallback path
// (a stream inflate, used only when a pack's zlib stream was not produced by Node's
// default deflater). The hot path re-deflates to recover each object's stream length:
// zlib is deterministic, so deflateSync(inflateSync(rest)) reproduces the exact bytes
// the client wrote, and its length is the consumed length.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync, createInflate } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** SHA-1 of `<type> <size>\0` + data: the object's id. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 40) return false;
  for (let i = 0; i < 40; i += 1) {
    const c = value.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    const lowerHex = c >= 97 && c <= 102;
    if (!digit && !lowerHex) return false;
  }
  return true;
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes. Tolerates missing author/committer lines. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. The message is used verbatim. */
export function buildCommit(info: CommitInfo): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const parent of info.parents) head += `parent ${parent}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n`;
  return Buffer.concat([Buffer.from(`${head}\n`, 'utf8'), Buffer.from(info.message, 'utf8')]);
}

/** A commit timestamp line's seconds, or 0 when it does not parse. */
export function commitTimestamp(authorLine: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(authorLine);
  return match ? Number(match[1]) : 0;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into entries (in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries ordered by name, directories compared as if suffixed with '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's bytes from entries (sorted git's way). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- tags

export interface TagInfo {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pkt-lines

export const PKT_FLUSH = '0000';
export const PKT_DELIM = '0001';
export const PKT_MAX = 65520;

/** One pkt-line: 4 hex length digits (the length counts itself) + payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export function pktFlush(): Buffer {
  return Buffer.from(PKT_FLUSH, 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from(PKT_DELIM, 'ascii');
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** One hex digit's value, or -1 when the byte is not a hex digit. */
function hexValue(byte: number): number {
  if (byte >= 48 && byte <= 57) return byte - 48;
  if (byte >= 97 && byte <= 102) return byte - 87;
  if (byte >= 65 && byte <= 70) return byte - 55;
  return -1;
}

/**
 * The pkt-line length at `offset` (4 hex digits, the length counts itself), or -1
 * when the prefix is not four hex digits. The caller checks the bounds first.
 */
export function pktLengthAt(buf: Buffer, offset: number): number {
  const d0 = hexValue(buf[offset]!);
  const d1 = hexValue(buf[offset + 1]!);
  const d2 = hexValue(buf[offset + 2]!);
  const d3 = hexValue(buf[offset + 3]!);
  if (d0 < 0 || d1 < 0 || d2 < 0 || d3 < 0) return -1;
  return (d0 << 12) | (d1 << 8) | (d2 << 4) | d3;
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed length prefix. */
export function decodePktLines(buf: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const len = pktLengthAt(buf, offset);
    if (len < 0) {
      const hex = buf.subarray(offset, offset + 4).toString('ascii');
      throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    }
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return packets;
}

/** Encode lines ('flush'/'delim' markers allowed) into one buffer. */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Split a sideband payload into pkt-lines of at most PKT_MAX bytes (band byte + data). */
export function sidebandPackets(band: 1 | 2, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxData = PKT_MAX - 5; // 4 length bytes + 1 band byte
  for (let offset = 0; offset < data.length || out.length === 0; offset += maxData) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxData));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    out.push(pktLine(payload));
    if (offset + maxData >= data.length) break;
  }
  return out;
}

// ---------------------------------------------------------------- packs

const PACK_TYPE_COMMIT = 1;
const PACK_TYPE_TREE = 2;
const PACK_TYPE_BLOB = 3;
const PACK_TYPE_TAG = 4;
const PACK_TYPE_OFS_DELTA = 6;
const PACK_TYPE_REF_DELTA = 7;

const TYPE_TO_PACK: Record<ObjectType, number> = { commit: PACK_TYPE_COMMIT, tree: PACK_TYPE_TREE, blob: PACK_TYPE_BLOB, tag: PACK_TYPE_TAG };
const PACK_TO_TYPE: Record<number, ObjectType> = { [PACK_TYPE_COMMIT]: 'commit', [PACK_TYPE_TREE]: 'tree', [PACK_TYPE_BLOB]: 'blob', [PACK_TYPE_TAG]: 'tag' };

/** Write a packfile version 2 of full objects (no deltas), with the SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const deflated = deflateSync(object.data);
    // Object header: varint size with the type in the first byte's high bits.
    const typeCode = TYPE_TO_PACK[object.type];
    let size = object.data.length;
    const headBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headBytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a pack's trailer checksum. */
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  const expected = pack.subarray(pack.length - 20).toString('hex');
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex') === expected;
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Inflate one zlib stream starting at `start`, returning its data and consumed length. */
async function inflateOne(buf: Buffer, start: number): Promise<{ data: Buffer; consumed: number }> {
  const rest = buf.subarray(start);
  const data = inflateSync(rest);
  // Re-deflate: zlib is deterministic, so the client's default deflate reproduces
  // the exact stream bytes; its length is the consumed length.
  const redeflated = deflateSync(data);
  if (redeflated.length <= rest.length && rest.subarray(0, redeflated.length).equals(redeflated)) {
    return { data, consumed: redeflated.length };
  }
  // Fallback for streams another deflater wrote: the stream's bytesWritten counts
  // only the bytes the zlib engine consumed.
  return new Promise((resolve, reject) => {
    const inf = createInflate();
    const chunks: Buffer[] = [];
    inf.on('data', (chunk: Buffer) => chunks.push(chunk));
    inf.on('error', reject);
    inf.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: inf.bytesWritten }));
    inf.end(rest);
  });
}

/**
 * Adler-32 of `data` (the checksum a zlib stream ends with), as 4 big-endian bytes.
 * The modulo is deferred to the end of each 5552-byte chunk (zlib's NMAX): inside a
 * chunk the sums stay far below 2^53, so the result is identical to the per-byte
 * version at a fraction of the cost.
 */
function adler32Bytes(data: Buffer): Buffer {
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < data.length) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i += 1) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  const out = Buffer.alloc(4);
  out.writeUInt32BE(((b << 16) | a) >>> 0, 0);
  return out;
}

/**
 * The length of the zlib stream at `start`, found by its adler-32 trailer instead
 * of re-deflating: the trailer is the checksum of the inflated data, so it is
 * known before the search starts. Returns -1 when the stream cannot be located
 * with confidence (the caller falls back to the re-deflate path). `isLast` means
 * the stream runs to `end` (the pack trailer), so no search is needed.
 */
function zlibLength(data: Buffer, rest: Buffer, start: number, end: number, isLast: boolean): number {
  if (isLast) {
    const length = end - start;
    if (length < 6) return -1; // a zlib stream is at least 2 header + 4 adler bytes
    if (!rest.subarray(length - 4, length).equals(adler32Bytes(data))) return -1;
    return length;
  }
  const trailer = adler32Bytes(data);
  let searchFrom = 2; // the adler-32 cannot start inside the 2-byte zlib header
  for (;;) {
    const found = rest.indexOf(trailer, searchFrom);
    if (found < 0) return -1;
    const candidate = found + 4;
    if (start + candidate >= end) return -1;
    // The byte after the trailer must start a plausible next object header.
    const next = rest[candidate]!;
    const typeCode = (next >> 4) & 0x07;
    if (typeCode === 1 || typeCode === 2 || typeCode === 3 || typeCode === 4 || typeCode === 6 || typeCode === 7) {
      return candidate;
    }
    searchFrom = found + 1;
  }
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * The fast pack reader: synchronous, full objects only, lengths via adler-32.
 * Returns null on any doubt (a delta, a length it cannot verify, a short pack):
 * the caller then uses the complete async reader below.
 */
function readPackFast(pack: Buffer): ReadPackResult | null {
  if (pack.length < 12 || pack[0] !== 0x50 || pack[1] !== 0x41 || pack[2] !== 0x43 || pack[3] !== 0x4b) return null;
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) return null;
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const end = pack.length - 20;
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    if (offset >= end) return null;
    let byte = pack[offset++]!;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= end) return null;
      byte = pack[offset++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = PACK_TO_TYPE[typeCode];
    if (type === undefined) return null; // a delta (or unknown type): use the slow path
    const rest = pack.subarray(offset, end);
    let data: Buffer;
    try {
      data = inflateSync(rest);
    } catch {
      return null;
    }
    if (data.length !== size) return null;
    const consumed = zlibLength(data, rest, offset, end, index === count - 1);
    if (consumed < 0) return null;
    offset += consumed;
    const oid = hashObject(type, data);
    objects.set(oid, { type, data });
  }
  if (offset !== end) return null;
  return { objects, deltaCount: 0 };
}

/**
 * Read a packfile (version 2), resolving OFS_DELTA and REF_DELTA against objects in
 * the pack and, for REF_DELTA, against `resolveBase` (the store's objects).
 * The fast synchronous path handles the common case (full objects only); anything
 * it cannot verify falls back to the complete reader below.
 */
export async function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Promise<ReadPackResult> {
  const fast = readPackFast(pack);
  if (fast !== null) return fast;
  return readPackSlow(pack, resolveBase);
}

/** The complete pack reader: deltas included, lengths via re-deflate (or a stream). */
async function readPackSlow(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Promise<ReadPackResult> {
  if (pack.length < 12 || pack[0] !== 0x50 || pack[1] !== 0x41 || pack[2] !== 0x43 || pack[3] !== 0x4b) throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  // Deltas whose base appears later in the pack are retried after the first pass.
  const pending: Array<{ baseOid: string; delta: Buffer }> = [];
  let offset = 12;
  const end = pack.length - 20; // the trailer
  for (let index = 0; index < count; index += 1) {
    if (offset >= end) throw new Error('pack is truncated');
    const objectOffset = offset;
    let byte = pack[offset++]!;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === PACK_TYPE_OFS_DELTA) {
      byte = pack[offset++]!;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++]!;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const basePos = objectOffset - baseOffset;
      const { data: delta, consumed } = await inflateOne(pack, offset);
      offset += consumed;
      const base = byOffset.get(basePos);
      if (base === undefined) throw new Error('ofs-delta base is missing');
      const resolved = applyDelta(base.data, delta);
      const object: GitObject = { type: base.type, data: resolved };
      const oid = hashObject(object.type, resolved);
      objects.set(oid, object);
      byOffset.set(objectOffset, object);
      deltaCount += 1;
      continue;
    }
    if (typeCode === PACK_TYPE_REF_DELTA) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data: delta, consumed } = await inflateOne(pack, offset);
      offset += consumed;
      const base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (base === undefined) {
        pending.push({ baseOid, delta });
        // Placeholder so later offsets stay aligned; resolved below.
        byOffset.set(objectOffset, { type: 'blob', data: Buffer.alloc(0) });
        deltaCount += 1;
        continue;
      }
      const resolved = applyDelta(base.data, delta);
      const object: GitObject = { type: base.type, data: resolved };
      const oid = hashObject(object.type, resolved);
      objects.set(oid, object);
      byOffset.set(objectOffset, object);
      deltaCount += 1;
      continue;
    }
    const type = PACK_TO_TYPE[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    const { data, consumed } = await inflateOne(pack, offset);
    offset += consumed;
    if (data.length !== size) throw new Error('pack object size mismatch');
    const object: GitObject = { type, data };
    const oid = hashObject(type, data);
    objects.set(oid, object);
    byOffset.set(objectOffset, object);
  }
  for (const item of pending) {
    const base = objects.get(item.baseOid) ?? resolveBase?.(item.baseOid);
    if (base === undefined) throw new Error(`ref-delta base ${item.baseOid} is missing`);
    const resolved = applyDelta(base.data, item.delta);
    const object: GitObject = { type: base.type, data: resolved };
    objects.set(hashObject(object.type, resolved), object);
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------- graph walks

export interface ObjectStore {
  get(oid: string): GitObject | undefined;
  has(oid: string): boolean;
}

/** Peel a tag (repeatedly) to its non-tag target. */
export function peelToNonTag(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 32; depth += 1) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** The commit a ref points at (peeling tags), or null when it is not a commit. */
export function refCommit(store: ObjectStore, oid: string): string | null {
  const peeled = peelToNonTag(store, oid);
  const object = store.get(peeled);
  return object !== undefined && object.type === 'commit' ? peeled : null;
}

/** Is `ancestor` reachable from `tip` (following commit parents)? */
export function isAncestor(store: ObjectStore, tip: string, ancestor: string): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>([tip]);
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  return false;
}

/** The merge-base of two commits: the first common ancestor found walking from `b`. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stackA.push(parent);
  }
  // Breadth-first from b so the nearest common ancestor wins.
  const queue = [b];
  const seenB = new Set<string>([b]);
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsA.has(oid)) return oid;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seenB.has(parent)) {
        seenB.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

/** All commits reachable from `tip`, newest-first (depth-first pre-order from the tip). */
export function commitHistory(store: ObjectStore, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return out;
}

/** Flatten a tree (recursively) into path -> {oid, mode} for files. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const object = store.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Read one file's blob oid from a tree, following `path`'s segments. */
export function treeLookup(store: ObjectStore, treeOid: string, path: string): { oid: string; mode: string; isDir: boolean; treeOid: string } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) {
      return { oid: entry.oid, mode: entry.mode, isDir: entry.mode === '40000', treeOid: entry.oid };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { oid: treeOid, mode: '40000', isDir: true, treeOid };
}

export interface ClosureOptions {
  /** Commit generations from each want (1 = the want commit only). Undefined = unlimited. */
  depth?: number;
  /** Commits the client already holds completely; their closure is excluded. */
  haves?: ReadonlySet<string>;
  /** The client's shallow boundaries: the held closure stops at these commits. */
  shallow?: ReadonlySet<string>;
}

export interface FetchClosure {
  /** Object ids to send (commits, trees, blobs, tags), in walk order. */
  send: string[];
  /** Commits at the depth boundary whose parents are not all available after the fetch. */
  shallow: string[];
  /** Client shallow boundaries whose parents are all available after the fetch. */
  unshallow: string[];
}

/**
 * The fetch closure: objects reachable from `wants` (depth-limited), minus what the
 * client holds. Held = closure(haves), stopping at the client's shallow boundaries.
 */
export function fetchClosure(store: ObjectStore, wants: readonly string[], options: ClosureOptions = {}): FetchClosure {
  const depth = options.depth;
  const haves = options.haves ?? new Set<string>();
  const clientShallow = options.shallow ?? new Set<string>();

  // 1. The wanted commits, with their generation (want = 0).
  const wantedCommits = new Map<string, number>();
  const queue: Array<{ oid: string; level: number }> = [];
  const wantedTags = new Set<string>();
  for (const want of wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      wantedTags.add(want);
      const peeled = peelToNonTag(store, want);
      const target = store.get(peeled);
      if (target !== undefined && target.type === 'commit') queue.push({ oid: peeled, level: 0 });
      else if (target !== undefined) wantedCommits.set(peeled, 0); // a tag of a tree/blob: send it directly
      continue;
    }
    if (object.type === 'commit') queue.push({ oid: want, level: 0 });
    else wantedCommits.set(want, 0); // a tree/blob want: send it directly
  }
  while (queue.length > 0) {
    const { oid, level } = queue.shift()!;
    if (wantedCommits.has(oid)) continue;
    wantedCommits.set(oid, level);
    if (depth !== undefined && level + 1 >= depth) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!wantedCommits.has(parent)) queue.push({ oid: parent, level: level + 1 });
    }
  }

  // 2. The held set: closure(haves), stopping at the client's shallow boundaries.
  const held = new Set<string>();
  const heldStack: string[] = [...haves];
  while (heldStack.length > 0) {
    const oid = heldStack.pop()!;
    if (held.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'tag') {
      heldStack.push(parseTag(object.data).object);
      continue;
    }
    if (object.type !== 'commit') continue;
    if (clientShallow.has(oid)) continue; // the client holds this commit but not its parents
    for (const parent of parseCommit(object.data).parents) heldStack.push(parent);
  }
  // Held trees/blobs: everything under held commits (and held tags' targets).
  const heldTrees = new Set<string>();
  const expandHeld = (oid: string): void => {
    const object = store.get(oid);
    if (object === undefined) return;
    if (object.type === 'commit') {
      const tree = parseCommit(object.data).tree;
      held.add(tree);
      if (!heldTrees.has(tree)) {
        heldTrees.add(tree);
        expandHeld(tree);
      }
      return;
    }
    if (object.type === 'tree') {
      held.add(oid);
      for (const entry of parseTree(object.data)) {
        held.add(entry.oid);
        if (entry.mode === '40000') expandHeld(entry.oid);
      }
    }
  };
  for (const oid of [...held]) expandHeld(oid);

  // 3. Objects to send: the wanted closure minus the held set.
  const send: string[] = [];
  const sendSet = new Set<string>();
  const push = (oid: string): void => {
    if (!sendSet.has(oid) && !held.has(oid) && store.get(oid) !== undefined) {
      sendSet.add(oid);
      send.push(oid);
    }
  };
  for (const tag of wantedTags) push(tag);
  // Commits first (in generation order), then their trees and blobs.
  const commitsByLevel = [...wantedCommits.entries()].sort((a, b) => a[1] - b[1]);
  const treesToExpand: string[] = [];
  for (const [oid, level] of commitsByLevel) {
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      push(oid);
      const tree = parseCommit(object.data).tree;
      if (!held.has(tree)) treesToExpand.push(tree);
    } else {
      push(oid); // a directly wanted tree/blob/tag target
      if (object.type === 'tree') treesToExpand.push(oid);
    }
    void level;
  }
  const expandedTrees = new Set<string>();
  while (treesToExpand.length > 0) {
    const treeOid = treesToExpand.pop()!;
    if (expandedTrees.has(treeOid) || held.has(treeOid)) continue;
    expandedTrees.add(treeOid);
    push(treeOid);
    const object = store.get(treeOid);
    if (object === undefined || object.type !== 'tree') continue;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') {
        if (!held.has(entry.oid)) treesToExpand.push(entry.oid);
      } else {
        push(entry.oid);
      }
    }
  }

  // 4. Shallow-info. Available after the fetch = held + sent.
  const available = new Set<string>([...held, ...sendSet]);
  const shallow: string[] = [];
  for (const [oid] of commitsByLevel) {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (!sendSet.has(oid) && !wants.includes(oid)) continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.some((parent) => !available.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((parent) => available.has(parent))) unshallow.push(oid);
  }
  return { send, shallow, unshallow };
}

// ---------------------------------------------------------------- diffs and merges

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Count added/removed lines between two texts (multiset line difference). */
export function countLineChanges(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const remaining = oldCounts.get(line) ?? 0;
    if (remaining > 0) oldCounts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of oldCounts.values()) deletions += remaining;
  return { additions, deletions };
}

/** The file-level diff between two trees (base -> head). */
export function diffTrees(store: ObjectStore, baseTree: string | null, headTree: string | null): FileChange[] {
  const baseFiles = baseTree === null ? new Map() : flattenTree(store, baseTree);
  const headFiles = headTree === null ? new Map() : flattenTree(store, headTree);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
    if (base === undefined && head !== undefined) {
      const blob = store.get(head.oid);
      const text = blob?.data.toString('utf8') ?? '';
      const lines = text === '' ? 0 : text.split('\n').length;
      changes.push({ filename: path, status: 'added', additions: Math.max(lines, 1), deletions: 0, changes: Math.max(lines, 1) });
    } else if (base !== undefined && head === undefined) {
      const blob = store.get(base.oid);
      const text = blob?.data.toString('utf8') ?? '';
      const lines = text === '' ? 0 : text.split('\n').length;
      changes.push({ filename: path, status: 'removed', additions: 0, deletions: Math.max(lines, 1), changes: Math.max(lines, 1) });
    } else if (base !== undefined && head !== undefined) {
      const oldText = store.get(base.oid)?.data.toString('utf8') ?? '';
      const newText = store.get(head.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = countLineChanges(oldText, newText);
      changes.push({ filename: path, status: 'modified', additions: Math.max(additions, 1), deletions, changes: Math.max(additions, 1) + deletions });
    }
  }
  return changes;
}

export interface ThreeWayMerge {
  /** path -> blob oid of the merged tree, or null when the merge conflicts. */
  merged: Map<string, { oid: string; mode: string }> | null;
  conflicts: string[];
}

/**
 * A file-level three-way merge: a path changed on both sides to different blobs
 * conflicts; a path changed on one side takes that side; an unchanged path stays.
 */
export function threeWayMerge(
  store: ObjectStore,
  baseTree: string | null,
  headTree: string | null,
  targetTree: string | null,
): ThreeWayMerge {
  const baseFiles = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(store, baseTree);
  const headFiles = headTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(store, headTree);
  const targetFiles = targetTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(store, targetTree);
  const merged = new Map<string, { oid: string; mode: string }>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...targetFiles.keys()]);
  for (const path of paths) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    const target = targetFiles.get(path);
    const headChanged = (head?.oid ?? null) !== (base?.oid ?? null);
    const targetChanged = (target?.oid ?? null) !== (base?.oid ?? null);
    if (headChanged && targetChanged && (head?.oid ?? null) !== (target?.oid ?? null)) {
      conflicts.push(path);
      continue;
    }
    const winner = headChanged ? head : target;
    if (winner !== undefined) merged.set(path, winner);
  }
  return conflicts.length > 0 ? { merged: null, conflicts } : { merged, conflicts: [] };
}
