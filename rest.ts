// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests.
//
// Status codes are the contract: 201 creates, 200 reads and updates, 204 deletes,
// 400 malformed bodies, 401 missing/wrong token (checked by the router), 404
// unknown repos/routes/owners, 405 conflicted merges, 409 stale shas, 422
// duplicates and unknown labels. Every reply is JSON with a message on errors.

import {
  ZERO_OID,
  commitHistory,
  diffTrees,
  flattenTree,
  isOid,
  mergeBase,
  parseCommit,
  parseTree,
  threeWayMerge,
} from './gitobj.ts';
import {
  VIEWER_LOGIN,
  branchView,
  commentView,
  issueView,
  labelView,
  nowIso,
  pullView,
  repoView,
  userView,
  type Issue,
  type Repo,
  type Store,
} from './store.ts';

export interface RestContext {
  store: Store;
  method: string;
  /** Decoded path segments after /api/v3 (e.g. ['repos','adaiversen','x','issues']). */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, or null when there is none. */
  body: unknown;
  /** True when the request carried a body that did not parse as JSON. */
  bodyError: boolean;
  /** The request's Host header, for absolute pagination URLs. */
  host: string;
}

export interface RestResponse {
  status: number;
  /** JSON-serializable body, or null for 204. A string or Buffer is sent verbatim (cached JSON). */
  body: unknown;
  headers?: Record<string, string>;
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}

function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: unknown, name: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Paginate a list; returns the page and the Link header when another page follows. */
function paginate<T>(items: readonly T[], query: URLSearchParams, path: string, host: string): { page: T[]; link: string | null } {
  const perPage = Math.min(100, intParam(query, 'per_page', 30));
  const page = intParam(query, 'page', 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = `http://${host}${path}?per_page=${perPage}&page=${page + 1}`;
    const lastPage = Math.ceil(items.length / perPage);
    const last = `http://${host}${path}?per_page=${perPage}&page=${lastPage}`;
    link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page: slice, link };
}

function linkHeader(link: string | null): Record<string, string> | undefined {
  return link === null ? undefined : { link };
}

/** The repository a route names, or null when the owner is not the viewer or it is missing. */
function findRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN && owner.toLowerCase() !== VIEWER_LOGIN) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function parseNumber(segment: string): number | null {
  if (segment === '') return null;
  let value = 0;
  for (let i = 0; i < segment.length; i += 1) {
    const digit = segment.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return null;
    value = value * 10 + digit;
    if (!Number.isSafeInteger(value)) return null;
  }
  return value > 0 ? value : null;
}

// ---------------------------------------------------------------- contents helpers

/** Commit one file change on a branch, creating the branch from the default when needed. */
function commitFile(
  repo: Repo,
  branch: string | undefined,
  filePath: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null; branch: string; created: boolean } {
  const target = branch ?? repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${target}`) ?? null;
  if (tip === null && target !== repo.defaultBranch) {
    // A new branch starts from the default branch's tip (or unborn).
    tip = repo.defaultTip();
  }
  const files = repo.filesOfCommit(tip);
  const existed = files.has(filePath);
  let blobSha: string | null = null;
  if (content === null) {
    files.delete(filePath);
  } else {
    blobSha = repo.putObject('blob', content);
    files.set(filePath, { oid: blobSha, mode: '100644' });
  }
  const tree = repo.buildTreeFromFiles(files);
  const commitSha = repo.createCommit(message, tree, tip === null ? [] : [tip]);
  repo.refs.set(`refs/heads/${target}`, commitSha);
  repo.bumpVersion();
  repo.updatedAt = nowIso();
  return { commitSha, blobSha, branch: target, created: !existed };
}

/** The tree id at a ref (branch name, sha, or the default branch). */
function treeAtRef(repo: Repo, ref: string | undefined): string | null {
  const commit = repo.refCommit(ref ?? repo.defaultBranch);
  if (commit === null) return null;
  return repo.treeOfCommit(commit);
}

// ---------------------------------------------------------------- the router

export function handleRest(ctx: RestContext): RestResponse {
  const { method, segments } = ctx;
  const seg = segments;

  // GET /api/v3/ — the API root.
  if (seg.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '8.0.0', hooks: [], verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(userView());
  }

  // /api/v3/user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const repos = ctx.store.listRepos();
      const { page, link } = paginate(repos, ctx.query, '/api/v3/user/repos', ctx.host);
      return ok(page.map((repo) => repoView(repo)), 200, linkHeader(link));
    }
    if (method === 'POST') {
      if (ctx.bodyError) return err(400, 'Problems parsing JSON');
      const name = stringField(ctx.body, 'name');
      if (name === undefined || name === '' || name.includes('/')) return err(422, 'Validation Failed: name is required');
      if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        return err(422, `Validation Failed: name already exists on this account`);
      }
      const description = stringField(ctx.body, 'description') ?? '';
      const privateFlag = isRecord(ctx.body) && ctx.body.private === true;
      const repo = ctx.store.createRepo(name, description, privateFlag);
      return ok(repoView(repo), 201);
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1]!;
    const repoName = seg[2]!;
    const repo = findRepo(ctx, owner, repoName);
    if (repo === null) return err(404, 'Not Found');
    const rest = seg.slice(3);
    if (rest.length === 0) return handleRepo(ctx, repo);
    const head = rest[0]!;
    if (head === 'branches') return handleBranches(ctx, repo, rest.slice(1));
    if (head === 'commits') return handleCommits(ctx, repo, rest.slice(1));
    if (head === 'git') return handleGitRefs(ctx, repo, rest.slice(1));
    if (head === 'contents') return handleContents(ctx, repo, rest.slice(1));
    if (head === 'labels') return handleLabels(ctx, repo, rest.slice(1));
    if (head === 'issues') return handleIssues(ctx, repo, rest.slice(1));
    if (head === 'pulls') return handlePulls(ctx, repo, rest.slice(1));
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- repositories

function handleRepo(ctx: RestContext, repo: Repo): RestResponse {
  if (ctx.method === 'GET') return ok(repoView(repo));
  if (ctx.method === 'PATCH') {
    if (ctx.bodyError) return err(400, 'Problems parsing JSON');
    const description = stringField(ctx.body, 'description');
    if (description !== undefined) repo.description = description;
    if (isRecord(ctx.body) && typeof ctx.body.private === 'boolean') repo.privateFlag = ctx.body.private;
    const name = stringField(ctx.body, 'name');
    if (name !== undefined && name !== '' && name !== repo.name) {
      if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, 'Validation Failed: name already exists on this account');
      ctx.store.deleteRepo(repo);
      repo.name = name;
      ctx.store.repos.set(ctx.store.repoKey(VIEWER_LOGIN, name), repo);
    }
    repo.updatedAt = nowIso();
    return ok(repoView(repo));
  }
  if (ctx.method === 'DELETE') {
    ctx.store.deleteRepo(repo);
    return { status: 204, body: null };
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- branches & commits

function handleBranches(ctx: RestContext, repo: Repo, rest: string[]): RestResponse {
  if (ctx.method !== 'GET') return err(404, 'Not Found');
  if (rest.length === 0) {
    const branches: Array<Record<string, unknown>> = [];
    for (const [ref, sha] of [...repo.refs.entries()].sort()) {
      if (ref.startsWith('refs/heads/')) branches.push(branchView(ref.slice('refs/heads/'.length), sha));
    }
    const { page, link } = paginate(branches, ctx.query, `/api/v3/repos/${repo.owner}/${repo.name}/branches`, ctx.host);
    return ok(page, 200, linkHeader(link));
  }
  const branch = rest.join('/');
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) return err(404, 'Not Found');
  const object = repo.objects.get(sha);
  const info = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  return ok({
    name: branch,
    commit: { sha, commit: { message: info?.message ?? '' } },
    protected: false,
  });
}

function handleCommits(ctx: RestContext, repo: Repo, rest: string[]): RestResponse {
  if (ctx.method !== 'GET' || rest.length > 1) return err(404, 'Not Found');
  if (rest.length === 1) {
    // GET /commits/{sha}: one commit.
    const oid = rest[0]!;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return err(404, 'Not Found');
    return ok({
      sha: oid,
      commit: { message: parseCommit(object.data).message, tree: { sha: parseCommit(object.data).tree } },
      parents: parseCommit(object.data).parents.map((sha) => ({ sha })),
    });
  }
  const shaParam = ctx.query.get('sha') ?? undefined;
  const tip = shaParam === undefined ? repo.defaultTip() : repo.refCommit(shaParam);
  if (tip === null) {
    if (shaParam !== undefined && repo.resolveRef(shaParam) === null) return err(404, 'Not Found');
    return ok([]);
  }
  const history = commitHistory({ get: (oid) => repo.objects.get(oid), has: (oid) => repo.objects.has(oid) }, tip);
  const { page, link } = paginate(history, ctx.query, `/api/v3/repos/${repo.owner}/${repo.name}/commits`, ctx.host);
  const views = page.map((oid) => {
    const object = repo.objects.get(oid)!;
    const info = parseCommit(object.data);
    return {
      sha: oid,
      commit: { message: info.message, tree: { sha: info.tree } },
      parents: info.parents.map((sha) => ({ sha })),
    };
  });
  return ok(views, 200, linkHeader(link));
}

// ---------------------------------------------------------------- git refs

function handleGitRefs(ctx: RestContext, repo: Repo, rest: string[]): RestResponse {
  if (rest.length === 0 || rest[0] !== 'refs') return err(404, 'Not Found');
  if (ctx.method === 'POST' && rest.length === 1) {
    if (ctx.bodyError) return err(400, 'Problems parsing JSON');
    const ref = stringField(ctx.body, 'ref');
    const sha = stringField(ctx.body, 'sha');
    if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !isOid(sha)) {
      return err(422, 'Validation Failed: ref and sha are required');
    }
    if (!repo.objects.has(sha)) return err(422, 'Validation Failed: sha does not exist');
    if (repo.refs.has(ref)) return err(422, 'Validation Failed: ref already exists');
    repo.refs.set(ref, sha);
    repo.bumpVersion();
    return ok({ ref, object: { sha, type: repo.objects.get(sha)!.type } }, 201);
  }
  if (ctx.method === 'GET' && rest.length >= 2) {
    const ref = `refs/${rest.slice(1).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return err(404, 'Not Found');
    return ok({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
  }
  if (ctx.method === 'DELETE' && rest.length >= 2) {
    const ref = `refs/${rest.slice(1).join('/')}`;
    if (!repo.refs.has(ref)) return err(404, 'Not Found');
    repo.refs.delete(ref);
    repo.bumpVersion();
    return { status: 204, body: null };
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function handleContents(ctx: RestContext, repo: Repo, rest: string[]): RestResponse {
  const filePath = rest.join('/');
  if (ctx.method === 'GET') return getContent(ctx, repo, filePath);
  if (ctx.method === 'PUT') {
    if (ctx.bodyError) return err(400, 'Problems parsing JSON');
    const message = stringField(ctx.body, 'message');
    const content = stringField(ctx.body, 'content');
    if (message === undefined || content === undefined) return err(422, 'Validation Failed: message and content are required');
    const branch = stringField(ctx.body, 'branch');
    const sha = stringField(ctx.body, 'sha');
    const target = branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${target}`) ?? (target === repo.defaultBranch ? null : repo.defaultTip());
    const files = repo.filesOfCommit(tip);
    const existing = files.get(filePath);
    if (existing !== undefined && sha !== undefined && sha.toLowerCase() !== existing.oid) {
      return err(409, 'Conflict: the file has changed since the sha was read');
    }
    const bytes = Buffer.from(content, 'base64');
    const result = commitFile(repo, branch, filePath, bytes, message);
    const status = result.created ? 201 : 200;
    return ok(
      {
        content: { name: filePath.split('/').pop(), path: filePath, sha: result.blobSha, size: bytes.length, encoding: 'base64', type: 'file' },
        commit: { sha: result.commitSha, message },
      },
      status,
    );
  }
  if (ctx.method === 'DELETE') {
    if (ctx.bodyError) return err(400, 'Problems parsing JSON');
    const message = stringField(ctx.body, 'message');
    const sha = stringField(ctx.body, 'sha');
    if (message === undefined || sha === undefined) return err(422, 'Validation Failed: message and sha are required');
    const branch = stringField(ctx.body, 'branch');
    const target = branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${target}`) ?? null;
    const files = repo.filesOfCommit(tip);
    const existing = files.get(filePath);
    if (existing === undefined) return err(404, 'Not Found');
    if (sha.toLowerCase() !== existing.oid) return err(409, 'Conflict: the file has changed since the sha was read');
    const result = commitFile(repo, branch, filePath, null, message);
    return ok({ content: null, commit: { sha: result.commitSha, message } }, 200);
  }
  return err(404, 'Not Found');
}

function getContent(ctx: RestContext, repo: Repo, filePath: string): RestResponse {
  const ref = ctx.query.get('ref') ?? undefined;
  if (ref !== undefined && repo.resolveRef(ref) === null && !isOid(ref)) return err(404, 'Not Found');
  const treeOid = treeAtRef(repo, ref);
  if (treeOid === null) return err(404, 'Not Found');
  const storeView = { get: (oid: string) => repo.objects.get(oid), has: (oid: string) => repo.objects.has(oid) };
  if (filePath === '') {
    // The repository root.
    return ok(listDirectory(repo, treeOid, ''));
  }
  const segments = filePath.split('/');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return err(404, 'Not Found');
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return err(404, 'Not Found');
    if (i === segments.length - 1) {
      if (entry.mode === '40000') return ok(listDirectory(repo, entry.oid, filePath));
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined || blob.type !== 'blob') return err(404, 'Not Found');
      return ok({
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        sha: entry.oid,
        size: blob.data.length,
        name: entry.name,
        path: filePath,
      });
    }
    if (entry.mode !== '40000') return err(404, 'Not Found');
    current = entry.oid;
  }
  void storeView;
  return err(404, 'Not Found');
}

function listDirectory(repo: Repo, treeOid: string, dirPath: string): Array<Record<string, unknown>> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') return { type: 'dir', name: entry.name, path, sha: entry.oid };
    const blob = repo.objects.get(entry.oid);
    return { type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0 };
  });
}

// ---------------------------------------------------------------- labels

function handleLabels(ctx: RestContext, repo: Repo, rest: string[]): RestResponse {
  if (rest.length !== 0) return err(404, 'Not Found');
  if (ctx.method === 'GET') {
    return ok([...repo.labels.values()].map((label) => labelView(label)));
  }
  if (ctx.method === 'POST') {
    if (ctx.bodyError) return err(400, 'Problems parsing JSON');
    const name = stringField(ctx.body, 'name');
    const color = stringField(ctx.body, 'color') ?? 'ededed';
    const description = stringField(ctx.body, 'description') ?? '';
    if (name === undefined || name === '') return err(422, 'Validation Failed: name is required');
    if (repo.labels.has(name.toLowerCase())) return err(422, 'Validation Failed: label already exists');
    const label = { name, color, description };
    repo.labels.set(name.toLowerCase(), label);
    return ok(labelView(label), 201);
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- issues

function handleIssues(ctx: RestContext, repo: Repo, rest: string[]): RestResponse {
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { page, link } = paginate(issues, ctx.query, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, ctx.host);
      return ok(page.map((issue) => issueView(repo, issue)), 200, linkHeader(link));
    }
    if (ctx.method === 'POST') {
      if (ctx.bodyError) return err(400, 'Problems parsing JSON');
      const title = stringField(ctx.body, 'title');
      if (title === undefined || title === '') return err(422, 'Validation Failed: title is required');
      const body = stringField(ctx.body, 'body') ?? '';
      const labels: string[] = [];
      if (isRecord(ctx.body) && Array.isArray(ctx.body.labels)) {
        for (const label of ctx.body.labels) {
          if (typeof label !== 'string') continue;
          const found = repo.labels.get(label.toLowerCase());
          if (found === undefined) return err(422, `Validation Failed: label "${label}" does not exist`);
          labels.push(found.name);
        }
      }
      repo.issueSeq += 1;
      const issue: Issue = {
        number: repo.issueSeq,
        id: ctx.store.nextObjectId(),
        title,
        body,
        state: 'open',
        labels,
        comments: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        closedAt: null,
      };
      repo.issues.set(issue.number, issue);
      return ok(issueView(repo, issue), 201);
    }
    return err(404, 'Not Found');
  }
  const number = parseNumber(rest[0]!);
  if (number === null) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return err(404, 'Not Found');
  if (rest.length === 1) {
    if (ctx.method === 'GET') {
      // Hot path (the read workload): serve the cached serialization bytes.
      const cached = repo.issueJsonCache.get(number);
      if (cached !== undefined) return { status: 200, body: cached };
      const buf = Buffer.from(JSON.stringify(issueView(repo, issue)), 'utf8');
      repo.issueJsonCache.set(number, buf);
      return { status: 200, body: buf };
    }
    if (ctx.method === 'PATCH') {
      if (ctx.bodyError) return err(400, 'Problems parsing JSON');
      const title = stringField(ctx.body, 'title');
      const body = stringField(ctx.body, 'body');
      const state = stringField(ctx.body, 'state');
      if (title !== undefined) issue.title = title;
      if (body !== undefined) issue.body = body;
      if (state === 'closed' || state === 'open') {
        issue.state = state;
        issue.closedAt = state === 'closed' ? nowIso() : null;
      }
      issue.updatedAt = nowIso();
      repo.issueJsonCache.delete(number);
      return ok(issueView(repo, issue));
    }
    return err(404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (ctx.method === 'GET') {
      const { page, link } = paginate(issue.comments, ctx.query, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments`, ctx.host);
      return ok(page.map((comment) => commentView(comment)), 200, linkHeader(link));
    }
    if (ctx.method === 'POST') {
      if (ctx.bodyError) return err(400, 'Problems parsing JSON');
      const body = stringField(ctx.body, 'body');
      if (body === undefined) return err(422, 'Validation Failed: body is required');
      const comment = { id: ctx.store.nextObjectId(), body, createdAt: nowIso(), updatedAt: nowIso() };
      issue.comments.push(comment);
      issue.updatedAt = nowIso();
      repo.issueJsonCache.delete(number);
      return ok(commentView(comment), 201);
    }
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- pull requests

function pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const storeView = { get: (oid: string) => repo.objects.get(oid), has: (oid: string) => repo.objects.has(oid) };
  const headCommit = repo.refCommit(pull.headRef);
  const baseCommit = repo.refCommit(pull.baseRef);
  const base = headCommit !== null && baseCommit !== null ? mergeBase(storeView, headCommit, baseCommit) : null;
  const baseTree = repo.treeOfCommit(base ?? baseCommit);
  const headTree = repo.treeOfCommit(headCommit);
  return diffTrees(storeView, baseTree, headTree).map((change) => ({
    filename: change.filename,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.changes,
  }));
}

function handlePulls(ctx: RestContext, repo: Repo, rest: string[]): RestResponse {
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const { page, link } = paginate(pulls, ctx.query, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, ctx.host);
      return ok(page.map((pull) => pullView(repo, pull)), 200, linkHeader(link));
    }
    if (ctx.method === 'POST') {
      if (ctx.bodyError) return err(400, 'Problems parsing JSON');
      const title = stringField(ctx.body, 'title');
      const head = stringField(ctx.body, 'head');
      const base = stringField(ctx.body, 'base');
      if (title === undefined || title === '') return err(422, 'Validation Failed: title is required');
      if (head === undefined || base === undefined) return err(422, 'Validation Failed: head and base are required');
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return err(422, `Validation Failed: head branch "${head}" does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return err(422, `Validation Failed: base branch "${base}" does not exist`);
      const body = stringField(ctx.body, 'body') ?? '';
      repo.pullSeq += 1;
      const pull = {
        number: repo.pullSeq,
        id: ctx.store.nextObjectId(),
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
      return ok(pullView(repo, pull), 201);
    }
    return err(404, 'Not Found');
  }
  const number = parseNumber(rest[0]!);
  if (number === null) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) return err(404, 'Not Found');
  if (rest.length === 1) {
    if (ctx.method === 'GET') return ok(pullView(repo, pull));
    if (ctx.method === 'PATCH') {
      if (ctx.bodyError) return err(400, 'Problems parsing JSON');
      const title = stringField(ctx.body, 'title');
      const body = stringField(ctx.body, 'body');
      const state = stringField(ctx.body, 'state');
      if (title !== undefined) pull.title = title;
      if (body !== undefined) pull.body = body;
      if (state === 'closed' || state === 'open') pull.state = state;
      pull.updatedAt = nowIso();
      return ok(pullView(repo, pull));
    }
    return err(404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'files') {
    if (ctx.method !== 'GET') return err(404, 'Not Found');
    const files = pullFiles(repo, pull);
    const { page, link } = paginate(files, ctx.query, `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${number}/files`, ctx.host);
    return ok(page, 200, linkHeader(link));
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (ctx.method !== 'PUT') return err(404, 'Not Found');
    return mergePull(ctx, repo, pull);
  }
  return err(404, 'Not Found');
}

function mergePull(ctx: RestContext, repo: Repo, pull: import('./store.ts').Pull): RestResponse {
  if (ctx.bodyError) return err(400, 'Problems parsing JSON');
  if (pull.state !== 'open') return err(405, 'Pull request is already closed');
  const storeView = { get: (oid: string) => repo.objects.get(oid), has: (oid: string) => repo.objects.has(oid) };
  const headCommit = repo.refCommit(pull.headRef);
  const baseCommit = repo.refCommit(pull.baseRef);
  if (headCommit === null || baseCommit === null) return err(405, 'Head or base branch has no commits');
  const base = mergeBase(storeView, headCommit, baseCommit);
  const baseTree = repo.treeOfCommit(base);
  const headTree = repo.treeOfCommit(headCommit);
  const targetTree = repo.treeOfCommit(baseCommit);
  const merged = threeWayMerge(storeView, baseTree, headTree, targetTree);
  if (merged.merged === null) {
    return err(405, `Merge conflict: ${merged.conflicts.join(', ')}`);
  }
  const tree = repo.buildTreeFromFiles(merged.merged);
  const message = `${pull.title} (#${pull.number})\n\n${pull.body}`.trimEnd() + '\n';
  const commitSha = repo.createCommit(message, tree, [baseCommit]);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  repo.bumpVersion();
  repo.updatedAt = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = commitSha;
  pull.updatedAt = pull.mergedAt;
  void ctx;
  return ok({ sha: commitSha, merged: true, message: 'Pull Request successfully merged' }, 200);
}

export { ZERO_OID, flattenTree };
