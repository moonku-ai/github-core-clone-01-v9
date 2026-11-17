// mcp.ts — Model Context Protocol over streamable HTTP (JSON-RPC 2.0).
//
// The modern era first: server/discover answers the server's identity,
// capabilities and supported revisions; the legacy initialize handshake stays
// for pre-discover clients. tools/list is byte-deterministic (one frozen object,
// stringified the same way every time); tools/call answers the tool result as
// text JSON plus structuredContent, on the same store REST serves.

import { mergeBase, threeWayMerge } from './gitobj.ts';
import {
  VIEWER_LOGIN,
  issueView,
  nowIso,
  pullView,
  repoView,
  type Issue,
  type Repo,
  type Store,
} from './store.ts';

export const MCP_REVISION = '2026-07-28';
const SERVER_NAME = 'moonku-forge';
const SERVER_VERSION = '8.0.0';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): McpTool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required },
  };
}

/** The six canonical tools, in a fixed order; the object is built once and reused. */
export const MCP_TOOLS: readonly McpTool[] = Object.freeze([
  tool('create_repo', 'Create a repository for the authenticated user.', {
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'The repository owner.' },
    repo: { type: 'string', description: 'The repository name.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'The repository owner.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository.', {
    owner: { type: 'string', description: 'The repository owner.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch onto a base branch.', {
    owner: { type: 'string', description: 'The repository owner.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The pull request title.' },
    body: { type: 'string', description: 'The pull request body.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request with the squash method.', {
    owner: { type: 'string', description: 'The repository owner.' },
    repo: { type: 'string', description: 'The repository name.' },
    pull_number: { type: 'integer', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
]);

export interface McpResponse {
  status: number;
  /** JSON body, or null for a 202 notification answer with no body. */
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A tool result: text JSON plus the same object as structuredContent. */
function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = stringArg(args, 'owner');
  let repoName = stringArg(args, 'repo');
  if (repoName === undefined && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) repoName = parts[1];
  }
  if (owner === undefined || repoName === undefined) return null;
  if (owner.toLowerCase() !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (repoName === undefined) return toolError('create_repo requires a name');
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError(`repository "${repoName}" already exists`);
      const description = typeof args.description === 'string' ? args.description : '';
      const privateFlag = args.private === true;
      const repo = store.createRepo(repoName, description, privateFlag);
      return toolResult(repoView(repo));
    }
    case 'get_repo': {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('repository not found');
      return toolResult(repoView(repo));
    }
    case 'create_issue': {
      const repo = findRepo(store, args);
      const title = stringArg(args, 'title');
      if (repo === null || title === undefined) return toolError('create_issue requires owner, repo and title');
      const body = typeof args.body === 'string' ? args.body : '';
      repo.issueSeq += 1;
      const issue: Issue = {
        number: repo.issueSeq,
        id: store.nextObjectId(),
        title,
        body,
        state: 'open',
        labels: [],
        comments: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        closedAt: null,
      };
      repo.issues.set(issue.number, issue);
      return toolResult(issueView(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return toolResult(issues.map((issue) => issueView(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args);
      const title = stringArg(args, 'title');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (repo === null || title === undefined || head === undefined || base === undefined) {
        return toolError('create_pull_request requires owner, repo, title, head and base');
      }
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return toolError(`head branch "${head}" does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return toolError(`base branch "${base}" does not exist`);
      const body = typeof args.body === 'string' ? args.body : '';
      repo.pullSeq += 1;
      const pull = {
        number: repo.pullSeq,
        id: store.nextObjectId(),
        title,
        body,
        state: 'open' as const,
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null as string | null,
        mergeCommitSha: null as string | null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      repo.pulls.set(pull.number, pull);
      return toolResult(pullView(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args);
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      if (repo === null || !Number.isInteger(pullNumber)) return toolError('merge_pull_request requires owner, repo and pull_number');
      const pull = repo.pulls.get(pullNumber);
      if (pull === undefined) return toolError(`pull request #${pullNumber} does not exist`);
      if (pull.state !== 'open') return toolError(`pull request #${pullNumber} is already closed`);
      const storeView = { get: (oid: string) => repo.objects.get(oid), has: (oid: string) => repo.objects.has(oid) };
      const headCommit = repo.refCommit(pull.headRef);
      const baseCommit = repo.refCommit(pull.baseRef);
      if (headCommit === null || baseCommit === null) return toolError('head or base branch has no commits');
      const base = mergeBase(storeView, headCommit, baseCommit);
      const merged = threeWayMerge(storeView, repo.treeOfCommit(base), repo.treeOfCommit(headCommit), repo.treeOfCommit(baseCommit));
      if (merged.merged === null) return toolError(`merge conflict: ${merged.conflicts.join(', ')}`);
      const tree = repo.buildTreeFromFiles(merged.merged);
      const message = `${pull.title} (#${pull.number})\n`;
      const commitSha = repo.createCommit(message, tree, [baseCommit]);
      repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
      repo.bumpVersion();
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = commitSha;
      pull.updatedAt = pull.mergedAt;
      return toolResult({ sha: commitSha, merged: true, message: 'Pull Request successfully merged', pull_request: pullView(repo, pull) });
    }
    default:
      return toolError(`unknown tool "${name}"`);
  }
}

const KNOWN_TOOLS = new Set(MCP_TOOLS.map((entry) => entry.name));

/** POST /mcp: one JSON-RPC request. `bodyError` means the body did not parse. */
export function handleMcp(store: Store, body: unknown, bodyError: boolean): McpResponse {
  if (bodyError) {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return rpcError(isRecord(body) ? body.id ?? null : null, -32600, 'Invalid Request', 400);
  }
  const id = body.id ?? null;
  const isNotification = body.id === undefined;
  const method = body.method;
  const params = isRecord(body.params) ? body.params : {};

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      return rpcResult(id, {
        serverInfo,
        capabilities: { tools: {} },
        supportedVersions: [MCP_REVISION],
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
      return rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return { status: 202, body: null };
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (!KNOWN_TOOLS.has(name)) return rpcError(id, -32601, `Method not found: no tool named "${name}"`);
      return rpcResult(id, callTool(store, name, args));
    }
    default:
      if (isNotification) return { status: 202, body: null };
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
