// app.ts — the HTTP server: routing, auth, body reading, and the JSON envelope.
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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body accepted (packs stay far below this). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16)}-${Date.now().toString(16)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

/** The bearer token the suite presents, when the trial sets one. */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** True when the request carries the suite's bearer token (any non-empty one when unset). */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = expectedToken();
  return expected === '' || token === expected;
}

/** Read the whole request body (binary), or null when it is over the cap. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(store, req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          res.destroy();
        }
      } else {
        res.destroy();
      }
    });
  });
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    notFound(res);
    return;
  }
  const path = url.pathname;

  // The boot probe: no auth, no body.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/<service>. No auth: the git client
  // presents its token only to the REST repo-create helper.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]!);
    const repoName = decodeSegment(gitMatch[2]!);
    const service = gitMatch[3]!;
    if (owner === null || repoName === null) {
      notFound(res);
      return;
    }
    if (service === 'info/refs') {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      const serviceParam = url.searchParams.get('service');
      if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') {
        notFound(res);
        return;
      }
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const answer = infoRefs(store, owner, repoName, serviceParam, wantsV2);
      if (answer.status === 404) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendBuffer(res, answer.status, answer.contentType, answer.body);
      return;
    }
    if (method !== 'POST') {
      notFound(res);
      return;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { message: 'Request Entity Too Large' });
      return;
    }
    if (service === 'git-upload-pack') {
      const answer = uploadPack(store, owner, repoName, raw);
      if (answer.status === 404) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (answer.status === 400 || answer.status === 500) {
        sendBuffer(res, answer.status, answer.contentType, answer.body);
        return;
      }
      sendBuffer(res, answer.status, answer.contentType, answer.body);
      return;
    }
    const answer = await receivePack(store, owner, repoName, raw);
    if (answer.status === 404) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendBuffer(res, answer.status, answer.contentType, answer.body);
    return;
  }

  // GraphQL.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { message: 'Request Entity Too Large' });
      return;
    }
    let body: unknown = null;
    let bodyError = false;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        bodyError = true;
      }
    }
    const answer = handleGraphQL(store, body, bodyError);
    sendJson(res, answer.status, answer.body);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      // A session teardown for a session this server never issued.
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, { message: 'Request Entity Too Large' });
      return;
    }
    let body: unknown = null;
    let bodyError = false;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        bodyError = true;
      }
    }
    const answer = handleMcp(store, body, bodyError);
    if (answer.body === null) {
      res.writeHead(answer.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.body);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const restPath = path.slice('/api/v3'.length);
    const rawSegments = restPath.split('/').filter((segment) => segment !== '');
    const segments: string[] = [];
    for (const segment of rawSegments) {
      const decoded = decodeSegment(segment);
      if (decoded === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      segments.push(decoded);
    }
    let body: unknown = null;
    let bodyError = false;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { message: 'Request Entity Too Large' });
        return;
      }
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          bodyError = true;
        }
      }
    }
    const answer = handleRest({
      store,
      method,
      segments,
      query: url.searchParams,
      body,
      bodyError,
      host: req.headers.host ?? '127.0.0.1',
    });
    if (answer.status === 204) {
      sendNoContent(res);
      return;
    }
    sendJson(res, answer.status, answer.body, answer.headers ?? {});
    return;
  }

  notFound(res);
}
