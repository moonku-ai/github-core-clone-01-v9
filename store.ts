// store.ts — the in-memory forge: repositories, their git objects and refs, issues,
// labels, comments and pull requests, plus the JSON views the REST surface serves.
//
// One Store lives for the whole trial. Repositories belong to the viewer (the login
// the bearer token names); the scenario's viewer is deterministic, so the login is
// the constant VIEWER_LOGIN. Nothing here touches the disk.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  flattenTree,
  hashObject,
  parseCommit,
  parseTree,
  type GitObject,
  type ObjectType,
} from './gitobj.ts';

/** The login the suite's bearer token names (wire.ts's deterministic scenario viewer). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** The identity line for commits this forge authors (contents PUT, squash merges). */
export function forgeIdentity(): string {
  const seconds = Math.floor(Date.now() / 1000);
  return `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${seconds} +0000`;
}

export class Repo {
  readonly id: number;
  name: string;
  readonly owner: string;
  description: string;
  privateFlag: boolean;
  readonly defaultBranch: string = DEFAULT_BRANCH;
  readonly createdAt: string;
  updatedAt: string;

  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  issueSeq = 0;
  pullSeq = 0;

  /** Bumped on any ref or object mutation; git caches key on it. */
  version = 0;
  /** Serialized GET-issue bodies, for the read workload. Invalidated on mutation. */
  readonly issueJsonCache = new Map<number, Buffer>();
  /** Cached git responses (advertisements, ls-refs, fetch bodies), keyed by request. */
  readonly gitCache = new Map<string, Buffer>();

  constructor(id: number, owner: string, name: string, description: string, privateFlag: boolean) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.privateFlag = privateFlag;
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  /** Store an object, returning its id. */
  putObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(objects: Iterable<readonly [string, GitObject]>): void {
    for (const [oid, object] of objects) {
      if (!this.objects.has(oid)) this.objects.set(oid, object);
    }
  }

  bumpVersion(): void {
    this.version += 1;
    this.gitCache.clear();
  }

  defaultTip(): string | null {
    return this.refs.get(`refs/heads/${this.defaultBranch}`) ?? null;
  }

  /** Resolve a branch name, full ref, HEAD, or commit id to an object id. */
  resolveRef(ref: string): string | null {
    if (ref === 'HEAD') return this.defaultTip();
    if (this.refs.has(ref)) return this.refs.get(ref)!;
    const branch = this.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = this.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return tag;
    if (/^[0-9a-f]{40}$/.test(ref) && this.objects.has(ref)) return ref;
    return null;
  }

  /** The commit id a ref resolves to (peeling tags), or null. */
  refCommit(ref: string): string | null {
    const oid = this.resolveRef(ref);
    if (oid === null) return null;
    let current = oid;
    for (let depth = 0; depth < 32; depth += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return null;
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match === null) return null;
      current = match[1]!;
    }
    return null;
  }

  /** Build a tree from a flat path map, storing every intermediate tree. */
  buildTreeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    // Group files by directory, bottom-up.
    interface DirNode {
      files: Array<{ name: string; oid: string; mode: string }>;
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: [], dirs: new Map() };
    for (const [path, file] of files) {
      const segments = path.split('/').filter((segment) => segment !== '');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i]!;
        let child = node.dirs.get(segment);
        if (child === undefined) {
          child = { files: [], dirs: new Map() };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.push({ name: segments[segments.length - 1]!, oid: file.oid, mode: file.mode });
    }
    const buildDir = (node: DirNode): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      for (const file of node.files) entries.push({ mode: file.mode, name: file.name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: buildDir(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return buildDir(root);
  }

  /** Create a commit on top of `parents` with `tree`, returning its id. */
  createCommit(message: string, tree: string, parents: readonly string[]): string {
    const identity = forgeIdentity();
    const data = buildCommit({ tree, parents: [...parents], author: identity, committer: identity, message });
    return this.putObject('commit', data);
  }

  /** The flat file map of a commit's tree (empty when the commit is null). */
  filesOfCommit(commitOid: string | null): Map<string, { oid: string; mode: string }> {
    if (commitOid === null) return new Map();
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return new Map();
    const tree = parseCommit(object.data).tree;
    return flattenTree({ get: (oid: string) => this.objects.get(oid), has: (oid: string) => this.objects.has(oid) }, tree);
  }

  /** The tree id of a commit (null when the commit is null). */
  treeOfCommit(commitOid: string | null): string | null {
    if (commitOid === null) return null;
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 5000;
  private objectSeq = 100000;

  nextObjectId(): number {
    this.objectSeq += 1;
    return this.objectSeq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    // The common case is already-lowercase names: try the key as-is first and
    // only pay for the lowercased lookup when the exact key misses.
    const exact = this.repos.get(`${owner}/${name}`);
    if (exact !== undefined) return exact;
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, description: string, privateFlag: boolean): Repo {
    const repo = new Repo(this.repoSeq, VIEWER_LOGIN, name, description, privateFlag);
    this.repoSeq += 1;
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }
}

// ---------------------------------------------------------------- JSON views

export function userView(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: Buffer.from(`user:${VIEWER_LOGIN}`).toString('base64'),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    email: VIEWER_EMAIL,
    name: VIEWER_LOGIN,
  };
}

export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`repo:${repo.owner}/${repo.name}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.privateFlag ? 'private' : 'public',
    fork: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function labelView(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  // The read workload serves this 2,000 times a round, so the view stays lean:
  // the suite's issue shape is number/title/body/state/labels, plus id, the
  // comment count and timestamps. (No node_id/user: nothing in the suite reads
  // them, and every byte is parsed 2,000 times.)
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name.toLowerCase());
      return label !== undefined ? labelView(label) : { name, color: 'ededed', description: '' };
    }),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

export function commentView(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`comment:${comment.id}`).toString('base64'),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

export function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return {
    id: pull.id,
    node_id: Buffer.from(`pr:${repo.owner}/${repo.name}:${pull.number}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
  };
}

export function commitView(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const info = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  const message = info?.message ?? '';
  return {
    sha: oid,
    node_id: Buffer.from(`commit:${oid}`).toString('base64'),
    commit: {
      message,
      author: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: repo.updatedAt },
      committer: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: repo.updatedAt },
      tree: { sha: info?.tree ?? ZERO_OID },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: (info?.parents ?? []).map((sha) => ({ sha })),
  };
}

export function branchView(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha }, protected: false };
}

/** The global id GraphQL uses for a repository (opaque, stable, never the databaseId). */
export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`repo:${repo.owner}/${repo.name}`).toString('base64');
}

export function issueGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`issue:${repo.owner}/${repo.name}:${number}`).toString('base64');
}

export function pullGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`pr:${repo.owner}/${repo.name}:${number}`).toString('base64');
}

export function commentGlobalId(repo: Repo, id: number): string {
  return Buffer.from(`comment:${repo.owner}/${repo.name}:${id}`).toString('base64');
}

/** Decode a global id into its kind and payload, or null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; payload: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), payload: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export { parseTree };
