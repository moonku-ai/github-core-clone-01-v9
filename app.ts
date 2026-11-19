// app.ts — the HTTP server: a hand-rolled HTTP/1.1 parser on raw sockets,
// routing, auth, and the JSON envelope.
//
// Why raw sockets: Node's http server costs roughly 230us of CPU per request
// here (IncomingMessage/ServerResponse allocation, full header parsing, stream
// machinery) while the handlers themselves cost 20-50us. The suite's clients
// are well-behaved HTTP/1.1 (undici fetch: Content-Length bodies, keep-alive,
// no pipelining), so a minimal parser that reads only the headers the router
// needs cuts the per-request overhead by more than half.
//
// Routes:
//   GET  /healthz                        the boot probe, no auth
//   /api/v3/...                          GitHub REST v3 (Bearer auth)
//   POST /api/graphql                    GraphQL v4 (Bearer auth)
//   POST /mcp                            MCP over streamable HTTP (Bearer auth)
//   /{owner}/{repo}.git/info/refs        git smart-HTTP advertisements (no auth)
//   /{owner}/{repo}.git/git-upload-pack  git fetch (no auth)
//   /{owner}/{repo}.git/git-receive-pack git push (no auth)
// Anything else is a JSON 404. The server never throws from a request: a handler
// failure is a 500 JSON reply, and the process stays up.
//
// The parser handles the request line, headers (case-insensitive names),
// Content-Length and chunked bodies, keep-alive, pipelined requests and
// Connection: close. A malformed request is a 400 and the socket closes.

import { createServer, type Server, type Socket } from 'node:net';
import { handleGraphQL } from './graphql.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body accepted (packs stay far below this). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** The largest header block accepted (Node's http default is 16 KiB). */
const MAX_HEADER_BYTES = 16 * 1024;
/** A shared empty query set for requests without a query string (never mutated). */
const EMPTY_QUERY = new URLSearchParams();
const EMPTY_BUFFER = Buffer.alloc(0);

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Content Too Large',
  422: 'Unprocessable Entity',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
};

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16)}`;
}

// ---------------------------------------------------------------- responses

interface RawResponse {
  status: number;
  /** The content-type header, or '' to send none. */
  contentType: string;
  body: Buffer;
  headers: Record<string, string>;
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): RawResponse {
  const buf = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return {
    status,
    contentType: JSON_TYPE,
    body: buf,
    headers: { 'x-github-request-id': nextRequestId(), ...extraHeaders },
  };
}

function bufferResponse(status: number, contentType: string, body: Buffer): RawResponse {
  return { status, contentType, body, headers: {} };
}

function noContentResponse(): RawResponse {
  return { status: 204, contentType: '', body: EMPTY_BUFFER, headers: { 'x-github-request-id': nextRequestId() } };
}

/** A response with no body at all (the MCP notification acknowledgement). */
function emptyResponse(status: number): RawResponse {
  return { status, contentType: '', body: EMPTY_BUFFER, headers: { 'x-github-request-id': nextRequestId() } };
}

function notFoundResponse(): RawResponse {
  return jsonResponse(404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- the router

interface RawRequest {
  method: string;
  /** The request target, exactly as sent (path plus query string). */
  target: string;
  authorization: string | undefined;
  gitProtocol: string | undefined;
  host: string | undefined;
  /** True when the request asked to close the connection after the reply. */
  closeAfter: boolean;
  /** True for an HTTP/1.0 request (its keep-alive needs an explicit header). */
  http10: boolean;
  body: Buffer;
}

/** The bearer token the suite presents, when the trial sets one. Read once: the trial sets it at process start and never changes it. */
let cachedToken: string | null = null;
function expectedToken(): string {
  if (cachedToken === null) cachedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return cachedToken;
}

/** True when the request carries the suite's bearer token (any non-empty one when unset). */
function authorized(header: string | undefined): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = expectedToken();
  return expected === '' || token === expected;
}

function decodeSegment(segment: string): string | null {
  if (segment.indexOf('%') < 0) return segment; // nothing to decode
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Match a git smart-HTTP path `/{owner}/{repo}.git/<service>` by hand: the
 * service is one of the three known suffixes, the head is `/{owner}/{repo}.git`,
 * and neither name may be empty or contain a slash.
 */
function matchGitRoute(path: string): { owner: string; repo: string; service: string } | null {
  let service: string;
  let head: string;
  if (path.endsWith('/info/refs')) {
    service = 'info/refs';
    head = path.slice(0, -10);
  } else if (path.endsWith('/git-upload-pack')) {
    service = 'git-upload-pack';
    head = path.slice(0, -16);
  } else if (path.endsWith('/git-receive-pack')) {
    service = 'git-receive-pack';
    head = path.slice(0, -17);
  } else {
    return null;
  }
  if (!head.endsWith('.git')) return null;
  const slash = head.indexOf('/', 1);
  if (slash < 0) return null;
  const owner = head.slice(1, slash);
  const repo = head.slice(slash + 1, head.length - 4);
  if (owner === '' || repo === '' || repo.includes('/')) return null;
  return { owner, repo, service };
}

/** One query parameter's value from a raw query string, or null when absent. */
function queryParam(queryString: string, name: string): string | null {
  if (queryString === '') return null;
  const parts = queryString.split('&');
  for (const part of parts) {
    if (!part.startsWith(name)) continue;
    if (part.length === name.length) return '';
    if (part[name.length] !== '=') continue;
    const raw = part.slice(name.length + 1).replaceAll('+', ' ');
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** Parse a JSON request body: the parsed value, or bodyError when it did not parse. */
function parseJsonBody(raw: Buffer): { body: unknown; bodyError: boolean } {
  if (raw.length === 0) return { body: null, bodyError: false };
  try {
    return { body: JSON.parse(raw.toString('utf8')), bodyError: false };
  } catch {
    return { body: null, bodyError: true };
  }
}

/** Route one request to its handler. Never throws: a failure is a 500 JSON reply. */
async function handleCore(store: Store, req: RawRequest): Promise<RawResponse> {
  try {
    return await routeRequest(store, req);
  } catch (err) {
    return jsonResponse(500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
  }
}

async function routeRequest(store: Store, req: RawRequest): Promise<RawResponse> {
  const method = req.method;
  // Split the request target by hand: the router only needs the pathname, and
  // the query string only where a parameter is actually read.
  const queryAt = req.target.indexOf('?');
  const path = queryAt < 0 ? req.target : req.target.slice(0, queryAt);
  const queryString = queryAt < 0 ? '' : req.target.slice(queryAt + 1);

  // The boot probe: no auth, no body.
  if (method === 'GET' && path === '/healthz') {
    return jsonResponse(200, { ok: true });
  }

  // Git smart HTTP: /{owner}/{repo}.git/<service>. No auth: the git client
  // presents its token only to the REST repo-create helper.
  const gitMatch = matchGitRoute(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch.owner);
    const repoName = decodeSegment(gitMatch.repo);
    const service = gitMatch.service;
    if (owner === null || repoName === null) return notFoundResponse();
    if (service === 'info/refs') {
      if (method !== 'GET') return notFoundResponse();
      const serviceParam = queryParam(queryString, 'service');
      if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') return notFoundResponse();
      const wantsV2 = (req.gitProtocol ?? '').includes('version=2');
      const answer = infoRefs(store, owner, repoName, serviceParam, wantsV2);
      if (answer.status === 404) return notFoundResponse();
      return bufferResponse(answer.status, answer.contentType, answer.body);
    }
    if (method !== 'POST') return notFoundResponse();
    if (service === 'git-upload-pack') {
      const answer = uploadPack(store, owner, repoName, req.body);
      if (answer.status === 404) return notFoundResponse();
      return bufferResponse(answer.status, answer.contentType, answer.body);
    }
    const answer = await receivePack(store, owner, repoName, req.body);
    if (answer.status === 404) return notFoundResponse();
    return bufferResponse(answer.status, answer.contentType, answer.body);
  }

  // GraphQL.
  if (path === '/api/graphql') {
    if (method !== 'POST') return notFoundResponse();
    if (!authorized(req.authorization)) return jsonResponse(401, { message: 'Bad credentials' });
    const { body, bodyError } = parseJsonBody(req.body);
    const answer = handleGraphQL(store, body, bodyError);
    return jsonResponse(answer.status, answer.body);
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      // A session teardown for a session this server never issued.
      return noContentResponse();
    }
    if (method !== 'POST') return jsonResponse(405, { message: 'Method Not Allowed' });
    if (!authorized(req.authorization)) return jsonResponse(401, { message: 'Bad credentials' });
    const { body, bodyError } = parseJsonBody(req.body);
    const answer = handleMcp(store, body, bodyError);
    if (answer.body === null) return emptyResponse(answer.status);
    return jsonResponse(answer.status, answer.body);
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req.authorization)) return jsonResponse(401, { message: 'Bad credentials' });
    const restPath = path.slice('/api/v3'.length);
    // The leading slash is the only empty piece for a clean path; filter only
    // when the path has a double slash or a trailing slash.
    let rawSegments = restPath === '' ? [] : restPath.slice(1).split('/');
    if (restPath.includes('//') || restPath.endsWith('/')) {
      rawSegments = rawSegments.filter((segment) => segment !== '');
    }
    const segments: string[] = [];
    for (const segment of rawSegments) {
      const decoded = decodeSegment(segment);
      if (decoded === null) return notFoundResponse();
      segments.push(decoded);
    }
    let body: unknown = null;
    let bodyError = false;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const parsed = parseJsonBody(req.body);
      body = parsed.body;
      bodyError = parsed.bodyError;
    }
    const answer = handleRest({
      store,
      method,
      segments,
      query: queryString === '' ? EMPTY_QUERY : new URLSearchParams(queryString),
      body,
      bodyError,
      host: req.host ?? '127.0.0.1',
    });
    if (answer.status === 204) return noContentResponse();
    return jsonResponse(answer.status, answer.body, answer.headers ?? {});
  }

  return notFoundResponse();
}

// ---------------------------------------------------------------- the parser

type ParseOutcome =
  | { kind: 'need-more' }
  | { kind: 'bad'; status: number }
  | { kind: 'request'; request: RawRequest; consumed: number; overCap: boolean };

/**
 * Parse one HTTP/1.1 request from `buf` starting at `offset`. Returns the
 * request and how many bytes it consumed, 'need-more' when the buffer does not
 * hold a complete request yet, or 'bad' with the status to answer (the socket
 * closes after it). An over-cap body is consumed and discarded, then answered
 * 413 like the old body reader did.
 */
function parseRequest(buf: Buffer, offset: number): ParseOutcome {
  const headEnd = buf.indexOf('\r\n\r\n', offset);
  if (headEnd < 0) {
    if (buf.length - offset > MAX_HEADER_BYTES) return { kind: 'bad', status: 431 };
    return { kind: 'need-more' };
  }
  const headLen = headEnd - offset;
  if (headLen > MAX_HEADER_BYTES) return { kind: 'bad', status: 431 };
  const lineEnd = buf.indexOf('\r\n', offset);
  if (lineEnd < 0 || lineEnd > headEnd) return { kind: 'bad', status: 400 };
  const requestLine = buf.subarray(offset, lineEnd).toString('ascii');
  const firstSpace = requestLine.indexOf(' ');
  const secondSpace = firstSpace < 0 ? -1 : requestLine.indexOf(' ', firstSpace + 1);
  if (firstSpace <= 0 || secondSpace <= firstSpace + 1) return { kind: 'bad', status: 400 };
  const method = requestLine.slice(0, firstSpace);
  const target = requestLine.slice(firstSpace + 1, secondSpace);
  const version = requestLine.slice(secondSpace + 1);
  if (target === '' || (version !== 'HTTP/1.1' && version !== 'HTTP/1.0')) return { kind: 'bad', status: 400 };

  // Headers: only the ones the router reads are kept.
  let authorization: string | undefined;
  let gitProtocol: string | undefined;
  let host: string | undefined;
  let connection: string | undefined;
  let contentLength: number | undefined;
  let chunked = false;
  let lineStart = lineEnd + 2;
  while (lineStart < headEnd) {
    const eol = buf.indexOf('\r\n', lineStart);
    const line = buf.subarray(lineStart, eol < 0 ? headEnd : eol).toString('ascii');
    const colon = line.indexOf(':');
    if (colon <= 0) return { kind: 'bad', status: 400 };
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'authorization' && authorization === undefined) authorization = value;
    else if (name === 'git-protocol' && gitProtocol === undefined) gitProtocol = value;
    else if (name === 'host' && host === undefined) host = value;
    else if (name === 'connection' && connection === undefined) connection = value.toLowerCase();
    else if (name === 'content-length') {
      if (!/^\d+$/.test(value)) return { kind: 'bad', status: 400 };
      const n = Number(value);
      if (!Number.isSafeInteger(n)) return { kind: 'bad', status: 400 };
      if (contentLength !== undefined && contentLength !== n) return { kind: 'bad', status: 400 };
      contentLength = n;
    } else if (name === 'transfer-encoding') {
      if (value.toLowerCase().includes('chunked')) chunked = true;
    }
    lineStart = (eol < 0 ? headEnd : eol) + 2;
  }

  const bodyStart = headEnd + 4;
  const http10 = version === 'HTTP/1.0';
  const closeAfter =
    connection === 'close' || (http10 && connection !== 'keep-alive');
  if (chunked) {
    const decoded = decodeChunked(buf, bodyStart);
    if (decoded === null) return { kind: 'need-more' };
    if (decoded === false) return { kind: 'bad', status: 400 };
    const overCap = decoded.body.length > MAX_BODY_BYTES;
    return {
      kind: 'request',
      request: { method, target, authorization, gitProtocol, host, closeAfter, http10, body: overCap ? EMPTY_BUFFER : decoded.body },
      consumed: decoded.consumed - offset,
      overCap,
    };
  }
  const length = contentLength ?? 0;
  if (buf.length - bodyStart < length) return { kind: 'need-more' };
  const overCap = length > MAX_BODY_BYTES;
  return {
    kind: 'request',
    request: {
      method,
      target,
      authorization,
      gitProtocol,
      host,
      closeAfter,
      http10,
      body: overCap ? EMPTY_BUFFER : buf.subarray(bodyStart, bodyStart + length),
    },
    consumed: bodyStart + length - offset,
    overCap,
  };
}

/**
 * Decode a chunked body starting at `start`: the joined body and the bytes
 * consumed (relative to the buffer start), null when more data is needed,
 * false when the framing is malformed.
 */
function decodeChunked(buf: Buffer, start: number): { body: Buffer; consumed: number } | null | false {
  const chunks: Buffer[] = [];
  let pos = start;
  for (;;) {
    const eol = buf.indexOf('\r\n', pos);
    if (eol < 0) return null;
    const sizeLine = buf.subarray(pos, eol).toString('ascii');
    const semi = sizeLine.indexOf(';');
    const sizeText = (semi < 0 ? sizeLine : sizeLine.slice(0, semi)).trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) return false;
    const size = parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size)) return false;
    pos = eol + 2;
    if (size === 0) {
      // Trailers, if any, end at the next empty line.
      const trailerEnd = buf.indexOf('\r\n\r\n', pos);
      const loneEnd = buf.indexOf('\r\n', pos);
      if (loneEnd === pos) return { body: Buffer.concat(chunks), consumed: pos + 2 };
      if (trailerEnd < 0) return null;
      return { body: Buffer.concat(chunks), consumed: trailerEnd + 4 };
    }
    if (buf.length - pos < size + 2) return null;
    chunks.push(buf.subarray(pos, pos + size));
    if (buf[pos + size] !== 13 || buf[pos + size + 1] !== 10) return false;
    pos += size + 2;
  }
}

// ---------------------------------------------------------------- the server

/** Serialize one response (status line + headers + body) into a single buffer. */
function serializeResponse(res: RawResponse, closeAfter: boolean, http10: boolean): Buffer {
  const reason = REASONS[res.status] ?? '';
  const lines = [`HTTP/1.1 ${res.status} ${reason}`];
  if (res.contentType !== '') lines.push(`content-type: ${res.contentType}`);
  // 204 responses must not carry a content-length; everything else does.
  if (res.status !== 204) lines.push(`content-length: ${res.body.length}`);
  for (const [name, value] of Object.entries(res.headers)) lines.push(`${name}: ${value}`);
  if (closeAfter) lines.push('connection: close');
  else if (http10) lines.push('connection: keep-alive');
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'ascii');
  return res.body.length === 0 ? head : Buffer.concat([head, res.body]);
}

export function createApp(): Server {
  const store = new Store();

  return createServer((socket: Socket) => {
    socket.setNoDelay(true);
    let buffer = EMPTY_BUFFER;
    let offset = 0;
    let busy = false;
    let closed = false; // stop processing new data on this socket
    let destroyed = false; // socket.destroy() already called

    const closeSocket = (): void => {
      if (destroyed) return;
      destroyed = true;
      closed = true;
      socket.destroy();
    };

    const pump = (): void => {
      if (busy || closed) return;
      for (;;) {
        if (offset >= buffer.length) {
          buffer = EMPTY_BUFFER;
          offset = 0;
          return;
        }
        const parsed = parseRequest(buffer, offset);
        if (parsed.kind === 'need-more') {
          // Keep only the unconsumed tail, so the buffer does not grow forever.
          if (offset > 0) {
            buffer = buffer.subarray(offset);
            offset = 0;
          }
          return;
        }
        if (parsed.kind === 'bad') {
          const body = Buffer.from('Bad Request', 'utf8');
          const res: RawResponse = {
            status: parsed.status,
            contentType: 'text/plain',
            body,
            headers: {},
          };
          // Stop parsing this socket: the malformed bytes stay in the buffer,
          // and re-parsing them would answer 400 again.
          closed = true;
          socket.write(serializeResponse(res, true, false), () => closeSocket());
          return;
        }
        const { request, consumed, overCap } = parsed;
        offset += consumed;
        busy = true;
        const done = async (): Promise<void> => {
          const res = overCap
            ? jsonResponse(413, { message: 'Request Entity Too Large' })
            : await handleCore(store, request);
          const bytes = serializeResponse(res, request.closeAfter, request.http10);
          if (request.closeAfter) {
            // end() flushes the reply, then half-closes: the client reads it.
            closed = true;
            busy = false;
            socket.end(bytes);
            return;
          }
          // Writes on one socket stay ordered, so the next request can be
          // handled without waiting for this flush; the suite sends one
          // request at a time per connection, so nothing piles up.
          socket.write(bytes, () => {});
          busy = false;
          pump();
        };
        void done().catch(() => closeSocket());
        return; // one request at a time per socket; pump resumes when it finishes
      }
    };

    socket.on('data', (chunk: Buffer) => {
      if (closed) return;
      buffer = offset === 0 && buffer.length === 0 ? chunk : Buffer.concat([buffer.subarray(offset), chunk]);
      offset = 0;
      pump();
    });
    socket.on('error', () => closeSocket());
    socket.on('close', () => {
      closed = true;
    });
  });
}
