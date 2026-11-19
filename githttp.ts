// githttp.ts — git smart HTTP: info/refs advertisements (v0 and v2), upload-pack
// (v2 ls-refs/fetch and the v0 fallback) and receive-pack (v0 only).
//
// The wire rules the conformance suite enforces, in one place:
//   - info/refs always starts with the `# service=...` preamble + flush, and carries
//     the service's advertisement content type.
//   - v2 advertises fetch=shallow, ls-refs and object-format=sha1 — never
//     ls-refs=unborn (the client would then send `unborn` and break clone-empty).
//   - v0 upload-pack advertises side-band-64k (the client refuses to fetch without
//     it), thin-pack, ofs-delta, shallow and multi_ack, with symref=HEAD:refs/heads/main.
//   - receive-pack advertises report-status (never report-status-v2), side-band-64k
//     and delete-refs; its report-status travels inside sideband band 1.
//   - fetch answers NAK always (no ACK negotiation), a shallow-info section only
//     when there is shallow news, and a packfile section with at least one sideband
//     packet — even an empty pack (32 bytes) for fetch-nothing-new.
//   - a missing repository is a 404 on both services; the server stays up.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  fetchClosure,
  isAncestor,
  isOid,
  parseTag,
  peelToNonTag,
  pktLengthAt,
  pktLine,
  readPack,
  sidebandPackets,
  writePack,
  type FetchClosure,
  type GitObject,
} from './gitobj.ts';
import { DEFAULT_BRANCH, type Repo, type Store } from './store.ts';

export const UPLOAD_AD_CONTENT_TYPE = 'application/x-git-upload-pack-advertisement';
export const RECEIVE_AD_CONTENT_TYPE = 'application/x-git-receive-pack-advertisement';
export const UPLOAD_RESULT_CONTENT_TYPE = 'application/x-git-upload-pack-result';
export const RECEIVE_RESULT_CONTENT_TYPE = 'application/x-git-receive-pack-result';

const V2_CAPS = ['fetch=shallow', 'ls-refs', 'object-format=sha1'];
const V0_UPLOAD_CAPS = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} multi_ack thin-pack side-band-64k ofs-delta shallow`;
const V0_RECEIVE_CAPS = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} report-status side-band-64k delete-refs ofs-delta`;

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function textResponse(status: number, text: string): GitResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: text }), 'utf8') };
}

/** The ref list, sorted, with peeled targets for annotated tags. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const names = [...repo.refs.keys()].sort();
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      entry.peeled = peelToNonTag({ get: (id) => repo.objects.get(id), has: (id) => repo.objects.has(id) }, oid);
    }
    out.push(entry);
  }
  return out;
}

/** The v0 advertisement body (after the preamble): HEAD line, then every ref. */
function v0Advertisement(repo: Repo, caps: string): Buffer {
  const tip = repo.defaultTip() ?? ZERO_OID;
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} HEAD\0${caps}\n`));
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\n`));
  } else {
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** The v2 capability advertisement body (after the preamble). */
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of V2_CAPS) parts.push(pktLine(`${cap}\n`));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** GET info/refs?service=<service>. `wantsV2` comes from the Git-Protocol header. */
export function infoRefs(store: Store, owner: string, name: string, service: string, wantsV2: boolean): GitResponse {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return textResponse(404, 'Not Found');
  const isUpload = service === 'git-upload-pack';
  const isReceive = service === 'git-receive-pack';
  if (!isUpload && !isReceive) return textResponse(404, 'Not Found');
  const contentType = isUpload ? UPLOAD_AD_CONTENT_TYPE : RECEIVE_AD_CONTENT_TYPE;
  const cacheKey = `adv:${service}:${isUpload && wantsV2 ? 'v2' : 'v0'}:${repo.version}`;
  const cached = repo.gitCache.get(cacheKey);
  if (cached !== undefined) return { status: 200, contentType, body: cached };
  const preamble = encodePktLines([`# service=${service}\n`, 'flush']);
  let body: Buffer;
  if (isUpload && wantsV2) {
    body = Buffer.concat([preamble, v2Advertisement()]);
  } else {
    body = Buffer.concat([preamble, v0Advertisement(repo, isUpload ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS)]);
  }
  repo.gitCache.set(cacheKey, body);
  return { status: 200, contentType, body };
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

/** Drop one trailing newline (what `replace(/\n$/, '')` did, without the regex). */
function stripNewline(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

/**
 * The fetch cache key, built by hand instead of JSON.stringify: the request's
 * oids are 40 lowercase-hex chars, so ',' and '|' separators cannot collide.
 */
function fetchCacheKey(prefix: string, version: number, request: FetchRequest): string {
  return `${prefix}:${version}:${request.wants.join(',')}|${request.haves.join(',')}|${request.shallow.join(',')}|${request.depth ?? ''}`;
}

function parseFetchArgs(lines: string[], start = 0): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (let i = start; i < lines.length; i += 1) {
    const text = stripNewline(lines[i]!);
    if (text.startsWith('want ')) {
      const oid = text.slice(5, 45);
      if (isOid(oid)) wants.push(oid);
    } else if (text.startsWith('have ')) {
      const oid = text.slice(5, 45);
      if (isOid(oid)) haves.push(oid);
    } else if (text.startsWith('shallow ')) {
      const oid = text.slice(8, 48);
      if (isOid(oid)) shallow.push(oid);
    } else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, done, filter, agent, object-format: ignored.
  }
  return { wants, haves, shallow, depth };
}

/** Build the pack and shallow-info for a fetch request. */
function computeFetch(repo: Repo, request: FetchRequest): { closure: FetchClosure; pack: Buffer } {
  const store = { get: (oid: string) => repo.objects.get(oid), has: (oid: string) => repo.objects.has(oid) };
  const closure = fetchClosure(store, request.wants, {
    depth: request.depth,
    haves: new Set(request.haves),
    shallow: new Set(request.shallow),
  });
  const objects: GitObject[] = [];
  for (const oid of closure.send) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { closure, pack: writePack(objects) };
}

function v2FetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const cacheKey = fetchCacheKey('fetch2', repo.version, request);
  const cached = repo.gitCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const { closure, pack } = computeFetch(repo, request);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), Buffer.from('0001', 'ascii')];
  if (closure.shallow.length > 0 || closure.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of closure.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of closure.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  const body = Buffer.concat(parts);
  if (repo.gitCache.size < 64) repo.gitCache.set(cacheKey, body);
  return body;
}

function v0FetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const cacheKey = fetchCacheKey('fetch0', repo.version, request);
  const cached = repo.gitCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const { closure, pack } = computeFetch(repo, request);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of closure.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of closure.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(Buffer.from('0000', 'ascii'));
  const body = Buffer.concat(parts);
  if (repo.gitCache.size < 64) repo.gitCache.set(cacheKey, body);
  return body;
}

function lsRefsResponse(repo: Repo, peel: boolean, symrefs: boolean, prefixes: string[]): Buffer {
  const cacheKey = `lsrefs:${repo.version}:${peel ? 1 : 0}${symrefs ? 1 : 0}:${prefixes.join(',')}`;
  const cached = repo.gitCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const tip = repo.defaultTip() ?? ZERO_OID;
  if (keep('HEAD')) {
    const target = `refs/heads/${repo.defaultBranch}`;
    parts.push(pktLine(symrefs ? `${tip} HEAD symref-target:${target}\n` : `${tip} HEAD\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  const body = Buffer.concat(parts);
  if (repo.gitCache.size < 64) repo.gitCache.set(cacheKey, body);
  return body;
}

/** POST git-upload-pack: v2 ls-refs/fetch, or the v0 fetch. Never throws. */
export function uploadPack(store: Store, owner: string, name: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return textResponse(404, 'Not Found');
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed pkt-line stream', 'utf8') };
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (lines.length === 0) return { status: 400, contentType: 'text/plain', body: Buffer.from('empty upload-pack request', 'utf8') };
  const first = stripNewline(lines[0]!);
  try {
    if (first.startsWith('command=ls-refs')) {
      let peel = false;
      let symrefs = false;
      const prefixes: string[] = [];
      for (let i = 1; i < lines.length; i += 1) {
        const text = stripNewline(lines[i]!);
        if (text === 'peel') peel = true;
        else if (text === 'symrefs') symrefs = true;
        else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
      }
      return { status: 200, contentType: UPLOAD_RESULT_CONTENT_TYPE, body: lsRefsResponse(repo, peel, symrefs, prefixes) };
    }
    if (first.startsWith('command=fetch')) {
      const request = parseFetchArgs(lines, 1);
      return { status: 200, contentType: UPLOAD_RESULT_CONTENT_TYPE, body: v2FetchResponse(repo, request) };
    }
    if (first.startsWith('command=')) {
      return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown upload-pack command ${first}`, 'utf8') };
    }
    // v0: want/have/shallow/deepen lines.
    const request = parseFetchArgs(lines);
    return { status: 200, contentType: UPLOAD_RESULT_CONTENT_TYPE, body: v0FetchResponse(repo, request) };
  } catch (err) {
    return { status: 500, contentType: 'text/plain', body: Buffer.from(err instanceof Error ? err.message : 'upload-pack failed', 'utf8') };
  }
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack: unpack the pack, apply the commands, report per ref. */
export async function receivePack(store: Store, owner: string, name: string, body: Buffer): Promise<GitResponse> {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return textResponse(404, 'Not Found');
  // Split the command pkt-lines (up to the first flush) from the raw pack.
  let offset = 0;
  const commandLines: string[] = [];
  let packStart = -1;
  try {
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated pkt-line');
      const len = pktLengthAt(body, offset);
      if (len < 0) throw new Error('bad pkt-line length');
      if (len === 0) {
        packStart = offset + 4;
        break;
      }
      if (len < 4 || offset + len > body.length) throw new Error('pkt-line length out of range');
      commandLines.push(body.subarray(offset + 4, offset + len).toString('utf8'));
      offset += len;
    }
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed receive-pack request', 'utf8') };
  }
  if (packStart < 0) return { status: 400, contentType: 'text/plain', body: Buffer.from('receive-pack request has no command flush', 'utf8') };
  const commands: PushCommand[] = [];
  for (const raw of commandLines) {
    const line = stripNewline(raw);
    const nul = line.indexOf('\0');
    const text = nul >= 0 ? line.slice(0, nul) : line;
    const parts = text.split(' ');
    if (parts.length !== 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) continue;
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('receive-pack request has no commands', 'utf8') };
  }
  const packBytes = body.subarray(packStart);
  const report: string[] = [];
  // 1. Unpack (objects land in the store even when a ref update is refused).
  if (packBytes.length > 0) {
    try {
      const read = await readPack(packBytes, (oid) => repo.objects.get(oid));
      repo.putObjects(read.objects);
    } catch (err) {
      report.push(`unpack ${err instanceof Error ? err.message : 'unpack failed'}\n`);
      for (const command of commands) report.push(`ng ${command.ref} unpacker error\n`);
      return sidebandReport(report);
    }
  }
  report.push('unpack ok\n');
  // 2. Apply each command; a refusal leaves that ref untouched.
  const storeView = { get: (oid: string) => repo.objects.get(oid), has: (oid: string) => repo.objects.has(oid) };
  let changed = false;
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      report.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current !== ZERO_OID) {
        repo.refs.delete(command.ref);
        changed = true;
      }
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID && current !== ZERO_OID) {
      report.push(`ng ${command.ref} already exists\n`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && current !== ZERO_OID) {
      const newCommit = peelToNonTag(storeView, command.newOid);
      const oldCommit = peelToNonTag(storeView, current);
      const newObject = repo.objects.get(newCommit);
      const oldObject = repo.objects.get(oldCommit);
      if (newObject?.type !== 'commit' || oldObject?.type !== 'commit' || !isAncestor(storeView, newCommit, oldCommit)) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    changed = true;
    report.push(`ok ${command.ref}\n`);
  }
  if (changed) repo.bumpVersion();
  return sidebandReport(report);
}

/** The report-status stream as pkt-lines inside sideband band 1, then flush. */
function sidebandReport(lines: readonly string[]): GitResponse {
  const report = encodePktLines(lines);
  const parts: Buffer[] = [...sidebandPackets(1, report), Buffer.from('0000', 'ascii')];
  return { status: 200, contentType: RECEIVE_RESULT_CONTENT_TYPE, body: Buffer.concat(parts) };
}

export { parseTag };
