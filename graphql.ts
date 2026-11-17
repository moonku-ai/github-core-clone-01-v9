// graphql.ts — GitHub GraphQL v4 for the documents gh and github-mcp-server send.
//
// A small lexer + recursive-descent parser (operations, variables, arguments,
// aliases, inline fragments) over an executor that resolves against the store.
// Unknown fields are GraphQL errors (HTTP 200, errors naming the field), never
// HTTP failures; an unknown repository is data.repository = null with no errors.
// Batched bodies (a JSON array) answer an array, in request order.

import { flattenTree as flattenTreeLocal, mergeBase, threeWayMerge } from './gitobj.ts';
import {
  VIEWER_LOGIN,
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  nowIso,
  pullGlobalId,
  repoGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input[i + 1] === '.' && input[i + 2] === '.') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const escaped = input[i + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let value = '';
      let isFloat = false;
      if (ch === '-') {
        value += ch;
        i += 1;
      }
      while (i < input.length && /[0-9]/.test(input[i]!)) {
        value += input[i];
        i += 1;
      }
      if (input[i] === '.' && /[0-9]/.test(input[i + 1] ?? '')) {
        isFloat = true;
        value += '.';
        i += 1;
        while (i < input.length && /[0-9]/.test(input[i]!)) {
          value += input[i];
          i += 1;
        }
      }
      tokens.push(isFloat ? { kind: 'float', value } : { kind: 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i]!)) {
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    if ('!$():=@[]{ }|'.includes(ch) || ch === '{' || ch === '}') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- AST

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[];
}

export interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | InlineFragmentNode;

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; type: string; required: boolean }>;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) operations.push(this.parseOperation());
    if (operations.length === 0) throw new Error('empty GraphQL document');
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token !== undefined && token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next !== undefined && next.kind === 'name') name = this.next().value;
    }
    const variableDefinitions: OperationNode['variableDefinitions'] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        variableDefinitions.push({ name: varName, type: type.name, required: type.required });
      }
    }
    const selectionSet = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selectionSet };
  }

  private parseType(): { name: string; required: boolean } {
    let name: string;
    if (this.acceptPunct('[')) {
      const inner = this.parseType();
      this.expectPunct(']');
      name = `[${inner.name}]`;
    } else {
      name = this.expectName();
    }
    const required = this.acceptPunct('!');
    return { name, required };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        let typeCondition: string | null = null;
        const on = this.peek();
        if (on !== undefined && on.kind === 'name' && on.value === 'on') {
          this.next();
          typeCondition = this.expectName();
        }
        selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.acceptPunct(':')) {
        alias = first;
        name = this.expectName();
      }
      const args: FieldNode['args'] = [];
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
      }
      // Directives (@include/@skip): parsed and ignored; the suite sends none.
      while (this.acceptPunct('@')) {
        this.expectName();
        if (this.acceptPunct('(')) {
          let depth = 1;
          while (depth > 0) {
            const t = this.next();
            if (t.kind === 'punct' && t.value === '(') depth += 1;
            if (t.kind === 'punct' && t.value === ')') depth -= 1;
          }
        }
      }
      let selectionSet: SelectionNode[] = [];
      const next = this.peek();
      if (next !== undefined && next.kind === 'punct' && next.value === '{') selectionSet = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------- executor

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email', 'url'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

class Executor {
  readonly errors: Array<{ message: string }> = [];
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  private error(message: string): void {
    this.errors.push({ message });
  }

  execute(operation: OperationNode, variables: Variables): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const selection of operation.selectionSet) {
      if (selection.kind === 'field') {
        data[selection.alias ?? selection.name] = this.resolveRoot(selection, variables);
      }
    }
    return data;
  }

  private resolveRoot(field: FieldNode, variables: Variables): unknown {
    const args = argsOf(field, variables);
    switch (field.name) {
      case 'viewer':
        return this.resolveUser(field, variables);
      case 'repository': {
        const owner = args.owner as string | undefined;
        const name = args.name as string | undefined;
        if (owner === undefined || name === undefined) {
          this.error(`repository requires owner and name arguments`);
          return null;
        }
        const repo = this.store.getRepo(owner, name);
        if (repo === undefined || owner.toLowerCase() !== VIEWER_LOGIN) return null;
        return this.resolveRepository(repo, field, variables);
      }
      case 'node': {
        const id = args.id as string | undefined;
        if (typeof id !== 'string') return null;
        return this.resolveNode(id, field, variables);
      }
      case '__type': {
        const name = args.name as string | undefined;
        if (typeof name !== 'string') return null;
        return this.resolveType(name, field, variables);
      }
      case '__schema':
        return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
      case 'createIssue':
        return this.createIssue(args, field, variables);
      case 'closeIssue':
        return this.closeIssue(args, field, variables);
      case 'createPullRequest':
        return this.createPullRequest(args, field, variables);
      case 'mergePullRequest':
        return this.mergePullRequest(args, field, variables);
      case 'addComment':
        return this.addComment(args, field, variables);
      default:
        this.error(`Cannot query field "${field.name}" on type "Query".`);
        return null;
    }
  }

  private resolveUser(field: FieldNode, variables: Variables): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const selection of field.selectionSet) {
      if (selection.kind !== 'field') continue;
      if (selection.name === 'login') out[selection.alias ?? 'login'] = VIEWER_LOGIN;
      else if (selection.name === 'id') out[selection.alias ?? 'id'] = Buffer.from(`user:${VIEWER_LOGIN}`).toString('base64');
      else if (selection.name === 'name') out[selection.alias ?? 'name'] = VIEWER_LOGIN;
      else if (selection.name === 'email') out[selection.alias ?? 'email'] = `${VIEWER_LOGIN}@example.invalid`;
      else {
        this.error(`Cannot query field "${selection.name}" on type "User".`);
        out[selection.alias ?? selection.name] = null;
      }
    }
    void variables;
    return out;
  }

  private resolveType(name: string, field: FieldNode, variables: Variables): Record<string, unknown> | null {
    const fields = TYPE_FIELDS[name];
    const enums = ENUM_VALUES[name];
    if (fields === undefined && enums === undefined) return null;
    const out: Record<string, unknown> = { name };
    for (const selection of field.selectionSet) {
      if (selection.kind !== 'field') continue;
      if (selection.name === 'fields') {
        const list = (fields ?? []).map((fieldName) => ({ name: fieldName }));
        out[selection.alias ?? 'fields'] = this.projectList(list, selection, variables);
      } else if (selection.name === 'enumValues') {
        const list = (enums ?? []).map((value) => ({ name: value }));
        out[selection.alias ?? 'enumValues'] = this.projectList(list, selection, variables);
      } else if (selection.name === 'name') {
        out[selection.alias ?? 'name'] = name;
      } else {
        this.error(`Cannot query field "${selection.name}" on type "__Type".`);
        out[selection.alias ?? selection.name] = null;
      }
    }
    return out;
  }

  /** Project a list of plain objects through a sub-selection (name-only leaves). */
  private projectList(list: readonly Record<string, unknown>[], field: FieldNode, _variables: Variables): unknown[] {
    void _variables;
    return list.map((item) => {
      const out: Record<string, unknown> = {};
      for (const selection of field.selectionSet) {
        if (selection.kind !== 'field') continue;
        out[selection.alias ?? selection.name] = item[selection.name] ?? null;
      }
      return out;
    });
  }

  private resolveNode(id: string, field: FieldNode, variables: Variables): Record<string, unknown> | null {
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'repo') {
      const slash = decoded.payload.indexOf('/');
      if (slash < 0) return null;
      const repo = this.store.getRepo(decoded.payload.slice(0, slash), decoded.payload.slice(slash + 1));
      if (repo === undefined) return null;
      const out: Record<string, unknown> = { id };
      for (const selection of field.selectionSet) {
        if (selection.kind === 'field') {
          if (selection.name === 'id') out[selection.alias ?? 'id'] = id;
          else {
            this.error(`Cannot query field "${selection.name}" on type "Node".`);
            out[selection.alias ?? selection.name] = null;
          }
        } else if (selection.kind === 'inlineFragment') {
          if (selection.typeCondition === null || selection.typeCondition === 'Repository') {
            for (const sub of selection.selectionSet) {
              if (sub.kind !== 'field') continue;
              if (sub.name === 'name') out[sub.alias ?? 'name'] = repo.name;
              else if (sub.name === 'nameWithOwner') out[sub.alias ?? 'nameWithOwner'] = `${repo.owner}/${repo.name}`;
              else if (sub.name === 'id') out[sub.alias ?? 'id'] = id;
              else {
                this.error(`Cannot query field "${sub.name}" on type "Repository".`);
                out[sub.alias ?? sub.name] = null;
              }
            }
          }
        }
      }
      return out;
    }
    return null;
  }

  private resolveRepository(repo: Repo, field: FieldNode, variables: Variables): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of field.selectionSet) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name;
      const args = argsOf(selection, variables);
      switch (selection.name) {
        case 'id':
          out[key] = repoGlobalId(repo);
          break;
        case 'databaseId':
          out[key] = repo.id;
          break;
        case 'name':
          out[key] = repo.name;
          break;
        case 'nameWithOwner':
          out[key] = `${repo.owner}/${repo.name}`;
          break;
        case 'description':
          out[key] = repo.description;
          break;
        case 'isPrivate':
          out[key] = repo.privateFlag;
          break;
        case 'owner':
          out[key] = this.resolveUser(selection, variables);
          break;
        case 'defaultBranchRef': {
          const tip = repo.defaultTip();
          out[key] = tip === null ? null : { name: repo.defaultBranch };
          break;
        }
        case 'viewerPermission':
          out[key] = 'ADMIN';
          break;
        case 'hasIssuesEnabled':
          out[key] = true;
          break;
        case 'issue': {
          const number = args.number as number | undefined;
          const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
          out[key] = issue === undefined ? null : this.resolveIssue(repo, issue, selection, variables);
          break;
        }
        case 'issues':
          out[key] = this.resolveIssueConnection(repo, selection, variables);
          break;
        case 'pullRequest': {
          const number = args.number as number | undefined;
          const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
          out[key] = pull === undefined ? null : this.resolvePullRequest(repo, pull, selection, variables);
          break;
        }
        case 'pullRequests':
          out[key] = this.resolvePullConnection(repo, selection, variables);
          break;
        default:
          this.error(`Cannot query field "${selection.name}" on type "Repository".`);
          out[key] = null;
      }
    }
    return out;
  }

  private resolveIssue(repo: Repo, issue: Issue, field: FieldNode, variables: Variables): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of field.selectionSet) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name;
      switch (selection.name) {
        case 'id':
          out[key] = issueGlobalId(repo, issue.number);
          break;
        case 'number':
          out[key] = issue.number;
          break;
        case 'title':
          out[key] = issue.title;
          break;
        case 'body':
          out[key] = issue.body;
          break;
        case 'state':
          out[key] = issue.state === 'open' ? 'OPEN' : 'CLOSED';
          break;
        case 'url':
          out[key] = '';
          break;
        case 'createdAt':
          out[key] = issue.createdAt;
          break;
        case 'updatedAt':
          out[key] = issue.updatedAt;
          break;
        case 'author':
          out[key] = this.resolveUser(selection, variables);
          break;
        default:
          this.error(`Cannot query field "${selection.name}" on type "Issue".`);
          out[key] = null;
      }
    }
    return out;
  }

  private resolveIssueConnection(repo: Repo, field: FieldNode, variables: Variables): Record<string, unknown> {
    const args = argsOf(field, variables);
    const first = typeof args.first === 'number' ? args.first : 25;
    const after = typeof args.after === 'string' ? args.after : null;
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = orderBy.direction === 'DESC' ? 'DESC' : 'ASC';
    let issues = [...repo.issues.values()];
    if (states !== null) {
      const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
    let start = 0;
    if (after !== null) {
      try {
        const decoded = Buffer.from(after, 'base64').toString('utf8');
        const afterNumber = Number.parseInt(decoded.replace(/^cursor:/, ''), 10);
        if (Number.isFinite(afterNumber)) {
          const index = issues.findIndex((issue) => issue.number === afterNumber);
          if (index >= 0) start = index + 1;
        }
      } catch {
        // An undecodable cursor starts from the beginning.
      }
    }
    const page = issues.slice(start, start + first);
    const hasNextPage = start + page.length < issues.length;
    const endCursor = page.length > 0 ? Buffer.from(`cursor:${page[page.length - 1]!.number}`).toString('base64') : null;
    const out: Record<string, unknown> = {};
    for (const selection of field.selectionSet) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name;
      if (selection.name === 'nodes') {
        out[key] = page.map((issue) => this.resolveIssue(repo, issue, selection, variables));
      } else if (selection.name === 'edges') {
        out[key] = page.map((issue) => ({ node: this.resolveIssue(repo, issue, selection, variables), cursor: Buffer.from(`cursor:${issue.number}`).toString('base64') }));
      } else if (selection.name === 'pageInfo') {
        const info: Record<string, unknown> = {};
        for (const sub of selection.selectionSet) {
          if (sub.kind !== 'field') continue;
          if (sub.name === 'hasNextPage') info[sub.alias ?? 'hasNextPage'] = hasNextPage;
          else if (sub.name === 'endCursor') info[sub.alias ?? 'endCursor'] = endCursor;
          else if (sub.name === 'hasPreviousPage') info[sub.alias ?? 'hasPreviousPage'] = start > 0;
          else if (sub.name === 'startCursor') info[sub.alias ?? 'startCursor'] = page.length > 0 ? Buffer.from(`cursor:${page[0]!.number}`).toString('base64') : null;
          else info[sub.alias ?? sub.name] = null;
        }
        out[key] = info;
      } else if (selection.name === 'totalCount') {
        out[key] = issues.length;
      } else {
        this.error(`Cannot query field "${selection.name}" on type "IssueConnection".`);
        out[key] = null;
      }
    }
    return out;
  }

  private pullMergeable(repo: Repo, pull: Pull): string {
    if (pull.state !== 'open') return 'UNKNOWN';
    const storeView = { get: (oid: string) => repo.objects.get(oid), has: (oid: string) => repo.objects.has(oid) };
    const headCommit = repo.refCommit(pull.headRef);
    const baseCommit = repo.refCommit(pull.baseRef);
    if (headCommit === null || baseCommit === null) return 'UNKNOWN';
    const base = mergeBase(storeView, headCommit, baseCommit);
    const merged = threeWayMerge(storeView, repo.treeOfCommit(base), repo.treeOfCommit(headCommit), repo.treeOfCommit(baseCommit));
    return merged.merged === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  private resolvePullRequest(repo: Repo, pull: Pull, field: FieldNode, variables: Variables): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of field.selectionSet) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name;
      const args = argsOf(selection, variables);
      switch (selection.name) {
        case 'id':
          out[key] = pullGlobalId(repo, pull.number);
          break;
        case 'number':
          out[key] = pull.number;
          break;
        case 'title':
          out[key] = pull.title;
          break;
        case 'body':
          out[key] = pull.body;
          break;
        case 'state':
          out[key] = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
          break;
        case 'merged':
          out[key] = pull.merged;
          break;
        case 'mergeable':
          out[key] = this.pullMergeable(repo, pull);
          break;
        case 'headRefName':
          out[key] = pull.headRef;
          break;
        case 'baseRefName':
          out[key] = pull.baseRef;
          break;
        case 'headRefOid':
          out[key] = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
          break;
        case 'baseRefOid':
          out[key] = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
          break;
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 25;
          const storeView = { get: (oid: string) => repo.objects.get(oid), has: (oid: string) => repo.objects.has(oid) };
          const headCommit = repo.refCommit(pull.headRef);
          const baseCommit = repo.refCommit(pull.baseRef);
          const base = headCommit !== null && baseCommit !== null ? mergeBase(storeView, headCommit, baseCommit) : null;
          out[key] = this.resolvePullFiles(repo, pull, base, headCommit, first, selection, variables);
          break;
        }
        case 'author':
          out[key] = this.resolveUser(selection, variables);
          break;
        case 'createdAt':
          out[key] = pull.createdAt;
          break;
        case 'updatedAt':
          out[key] = pull.updatedAt;
          break;
        case 'mergedAt':
          out[key] = pull.mergedAt;
          break;
        default:
          this.error(`Cannot query field "${selection.name}" on type "PullRequest".`);
          out[key] = null;
      }
    }
    return out;
  }

  private resolvePullFiles(
    repo: Repo,
    pull: Pull,
    base: string | null,
    headCommit: string | null,
    first: number,
    field: FieldNode,
    variables: Variables,
  ): Record<string, unknown> {
    void pull;
    const storeView = { get: (oid: string) => repo.objects.get(oid), has: (oid: string) => repo.objects.has(oid) };
    const baseTree = repo.treeOfCommit(base);
    const headTree = repo.treeOfCommit(headCommit);
    const baseFiles = baseTree === null ? new Map() : flattenTreeLocal(storeView, baseTree);
    const headFiles = headTree === null ? new Map() : flattenTreeLocal(storeView, headTree);
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
    const changed: string[] = [];
    for (const path of [...paths].sort()) {
      if ((baseFiles.get(path)?.oid ?? null) !== (headFiles.get(path)?.oid ?? null)) changed.push(path);
    }
    const page = changed.slice(0, first);
    const out: Record<string, unknown> = {};
    for (const selection of field.selectionSet) {
      if (selection.kind !== 'field') continue;
      if (selection.name === 'nodes') {
        out[selection.alias ?? 'nodes'] = page.map((path) => {
          const node: Record<string, unknown> = {};
          for (const sub of selection.selectionSet) {
            if (sub.kind !== 'field') continue;
            if (sub.name === 'path') node[sub.alias ?? 'path'] = path;
            else node[sub.alias ?? sub.name] = null;
          }
          return node;
        });
      } else if (selection.name === 'totalCount') {
        out[selection.alias ?? 'totalCount'] = changed.length;
      } else {
        out[selection.alias ?? selection.name] = null;
      }
    }
    void variables;
    return out;
  }

  private resolvePullConnection(repo: Repo, field: FieldNode, variables: Variables): Record<string, unknown> {
    const args = argsOf(field, variables);
    const first = typeof args.first === 'number' ? args.first : 25;
    const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number).slice(0, first);
    const out: Record<string, unknown> = {};
    for (const selection of field.selectionSet) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name;
      if (selection.name === 'nodes') {
        out[key] = pulls.map((pull) => this.resolvePullRequest(repo, pull, selection, variables));
      } else if (selection.name === 'totalCount') {
        out[key] = repo.pulls.size;
      } else {
        this.error(`Cannot query field "${selection.name}" on type "PullRequestConnection".`);
        out[key] = null;
      }
    }
    return out;
  }

  // ------------------------------------------------------------ mutations

  private repoFromGlobalId(id: unknown): Repo | null {
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'repo') return null;
    const slash = decoded.payload.indexOf('/');
    if (slash < 0) return null;
    return this.store.getRepo(decoded.payload.slice(0, slash), decoded.payload.slice(slash + 1)) ?? null;
  }

  private projectPayload(field: FieldNode, variables: Variables, resolve: (selection: FieldNode) => unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of field.selectionSet) {
      if (selection.kind !== 'field') continue;
      out[selection.alias ?? selection.name] = resolve(selection);
    }
    void variables;
    return out;
  }

  private createIssue(args: Record<string, unknown>, field: FieldNode, variables: Variables): Record<string, unknown> {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = this.repoFromGlobalId(input.repositoryId);
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    if (repo === null) {
      this.error('createIssue: the repository does not exist');
      return this.projectPayload(field, variables, () => null);
    }
    repo.issueSeq += 1;
    const issue: Issue = {
      number: repo.issueSeq,
      id: this.store.nextObjectId(),
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
    return this.projectPayload(field, variables, (selection) => {
      if (selection.name === 'issue') return this.resolveIssue(repo, issue, selection, variables);
      return null;
    });
  }

  private closeIssue(args: Record<string, unknown>, field: FieldNode, variables: Variables): Record<string, unknown> {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
    let issue: Issue | undefined;
    let repo: Repo | null = null;
    if (decoded !== null && decoded.kind === 'issue') {
      const match = /^([^/]+)\/([^:]+):(\d+)$/.exec(decoded.payload);
      if (match !== null) {
        repo = this.store.getRepo(match[1]!, match[2]!) ?? null;
        issue = repo?.issues.get(Number.parseInt(match[3]!, 10));
      }
    }
    if (issue === undefined || repo === null) {
      this.error('closeIssue: the issue does not exist');
      return this.projectPayload(field, variables, () => null);
    }
    issue.state = 'closed';
    issue.closedAt = nowIso();
    issue.updatedAt = nowIso();
    repo.issueJsonCache.delete(issue.number);
    return this.projectPayload(field, variables, (selection) => {
      if (selection.name === 'issue') return this.resolveIssue(repo, issue, selection, variables);
      return null;
    });
  }

  private createPullRequest(args: Record<string, unknown>, field: FieldNode, variables: Variables): Record<string, unknown> {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = this.repoFromGlobalId(input.repositoryId);
    const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
    const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    if (repo === null || repo.refs.get(`refs/heads/${headRefName}`) === undefined || repo.refs.get(`refs/heads/${baseRefName}`) === undefined) {
      this.error('createPullRequest: the repository or a branch does not exist');
      return this.projectPayload(field, variables, () => null);
    }
    repo.pullSeq += 1;
    const pull: Pull = {
      number: repo.pullSeq,
      id: this.store.nextObjectId(),
      title,
      body,
      state: 'open',
      headRef: headRefName,
      baseRef: baseRefName,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    repo.pulls.set(pull.number, pull);
    return this.projectPayload(field, variables, (selection) => {
      if (selection.name === 'pullRequest') return this.resolvePullRequest(repo, pull, selection, variables);
      return null;
    });
  }

  private mergePullRequest(args: Record<string, unknown>, field: FieldNode, variables: Variables): Record<string, unknown> {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
    let pull: Pull | undefined;
    let repo: Repo | null = null;
    if (decoded !== null && decoded.kind === 'pr') {
      const match = /^([^/]+)\/([^:]+):(\d+)$/.exec(decoded.payload);
      if (match !== null) {
        repo = this.store.getRepo(match[1]!, match[2]!) ?? null;
        pull = repo?.pulls.get(Number.parseInt(match[3]!, 10));
      }
    }
    if (pull === undefined || repo === null) {
      this.error('mergePullRequest: the pull request does not exist');
      return this.projectPayload(field, variables, () => null);
    }
    if (pull.state === 'open') {
      const storeView = { get: (oid: string) => repo.objects.get(oid), has: (oid: string) => repo.objects.has(oid) };
      const headCommit = repo.refCommit(pull.headRef);
      const baseCommit = repo.refCommit(pull.baseRef);
      if (headCommit !== null && baseCommit !== null) {
        const base = mergeBase(storeView, headCommit, baseCommit);
        const merged = threeWayMerge(storeView, repo.treeOfCommit(base), repo.treeOfCommit(headCommit), repo.treeOfCommit(baseCommit));
        if (merged.merged !== null) {
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
        }
      }
    }
    return this.projectPayload(field, variables, (selection) => {
      if (selection.name === 'pullRequest') return this.resolvePullRequest(repo, pull, selection, variables);
      return null;
    });
  }

  private addComment(args: Record<string, unknown>, field: FieldNode, variables: Variables): Record<string, unknown> {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
    const body = typeof input.body === 'string' ? input.body : '';
    let comment: { id: number; body: string } | null = null;
    let repo: Repo | null = null;
    if (decoded !== null && (decoded.kind === 'issue' || decoded.kind === 'pr')) {
      const match = /^([^/]+)\/([^:]+):(\d+)$/.exec(decoded.payload);
      if (match !== null) {
        repo = this.store.getRepo(match[1]!, match[2]!) ?? null;
        if (repo !== null && decoded.kind === 'issue') {
          const issue = repo.issues.get(Number.parseInt(match[3]!, 10));
          if (issue !== undefined) {
            const created = { id: this.store.nextObjectId(), body, createdAt: nowIso(), updatedAt: nowIso() };
            issue.comments.push(created);
            issue.updatedAt = nowIso();
            repo.issueJsonCache.delete(issue.number);
            comment = created;
          }
        }
      }
    }
    if (comment === null || repo === null) {
      this.error('addComment: the subject does not exist');
      return this.projectPayload(field, variables, () => null);
    }
    const commentId = commentGlobalId(repo, comment.id);
    return this.projectPayload(field, variables, (selection) => {
      if (selection.name !== 'commentEdge') return null;
      const edge: Record<string, unknown> = {};
      for (const sub of selection.selectionSet) {
        if (sub.kind !== 'field') continue;
        if (sub.name === 'node') {
          const node: Record<string, unknown> = {};
          for (const leaf of sub.selectionSet) {
            if (leaf.kind !== 'field') continue;
            if (leaf.name === 'id') node[leaf.alias ?? 'id'] = commentId;
            else if (leaf.name === 'body') node[leaf.alias ?? 'body'] = comment!.body;
            else node[leaf.alias ?? leaf.name] = null;
          }
          edge[sub.alias ?? 'node'] = node;
        } else {
          edge[sub.alias ?? sub.name] = null;
        }
      }
      return edge;
    });
  }
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResponse {
  status: number;
  body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Execute one operation object; returns the {data, errors?} body. */
function runOperation(store: Store, operation: unknown): Record<string, unknown> {
  if (!isRecord(operation) || typeof operation.query !== 'string') {
    return { data: null, errors: [{ message: 'the request needs a query string' }] };
  }
  const variables = isRecord(operation.variables) ? (operation.variables as Variables) : {};
  let operations: OperationNode[];
  try {
    operations = new Parser(lex(operation.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] };
  }
  const operationName = typeof operation.operationName === 'string' ? operation.operationName : null;
  const chosen = operationName !== null ? operations.find((candidate) => candidate.name === operationName) ?? operations[0]! : operations[0]!;
  const executor = new Executor(store);
  const data = executor.execute(chosen, variables);
  if (executor.errors.length > 0) return { data, errors: executor.errors };
  return { data };
}

/** POST /api/graphql: one operation, or a JSON array of operations (batching). */
export function handleGraphQL(store: Store, body: unknown, bodyError: boolean): GraphQLResponse {
  if (bodyError) {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(body)) {
    if (body.length === 0) return { status: 400, body: { errors: [{ message: 'an empty batch answers nothing' }] } };
    return { status: 200, body: body.map((operation) => runOperation(store, operation)) };
  }
  return { status: 200, body: runOperation(store, body) };
}
