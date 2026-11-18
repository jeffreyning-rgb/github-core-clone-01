// GraphQL v4 surface: a small parser and executor covering exactly the documents
// gh and github-mcp-server send — viewer, repository reads, issue/pull connections
// with cursor pagination, the five mutations, Relay node(id:) and the __type
// introspection probes. State comes from the same Store as REST, so cross-surface
// reads agree.

import { Store, globalId, parseGlobalId, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import type { HttpResult } from './rest.ts';

// ------------------------------------------------------------------ parsing

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selectionSet: FieldNode[] | null;
  typeCondition: string | null; // set for inline fragments (name holds '')
  fragment: boolean;
}

interface Operation {
  type: 'query' | 'mutation';
  selectionSet: FieldNode[];
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(c)) {
      i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        tokens.push(`"${input.slice(i + 3, end === -1 ? input.length : end)}"`);
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          out += input[j + 1];
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j])) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j])) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }
  private expect(t: string): void {
    if (this.next() !== t) throw new Error(`expected ${t}`);
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (t === '{') {
        ops.push({ type: 'query', selectionSet: this.parseSelectionSet() });
      } else if (t === 'query' || t === 'mutation') {
        const kind = this.next() as 'query' | 'mutation';
        if (this.peek() !== '(' && this.peek() !== '{') this.next(); // operation name
        if (this.peek() === '(') this.parseVariableDefinitions();
        // Directives are not used by the suite; skip any that appear.
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.parseArguments();
        }
        ops.push({ type: kind, selectionSet: this.parseSelectionSet() });
      } else if (t === 'fragment') {
        // Named fragments are not used by the suite; parse and discard.
        this.next();
        this.next(); // name
        this.next(); // 'on'
        this.next(); // type
        this.parseSelectionSet();
      } else {
        this.next();
      }
    }
    return ops;
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek() !== ')') {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.parseType();
      if (this.peek() === '=') {
        this.next();
        this.parseValue();
      }
      if (this.peek() === '@') {
        this.next();
        this.next();
      }
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  private parseArguments(): Array<{ name: string; value: Value }> {
    const args: Array<{ name: string; value: Value }> = [];
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return args;
  }

  private parseValue(): Value {
    const t = this.next();
    if (t === '$') return { kind: 'variable', name: this.next() };
    if (t.startsWith('"')) return { kind: 'string', value: t.slice(1, -1) };
    if (t === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t === 'true') return { kind: 'boolean', value: true };
    if (t === 'false') return { kind: 'boolean', value: false };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number(t) };
    if (/^-?\d*\.\d+/.test(t)) return { kind: 'float', value: Number(t) };
    return { kind: 'enum', value: t };
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          fields.push({ alias: null, name: '', args: [], selectionSet: this.parseSelectionSet(), typeCondition, fragment: true });
        } else {
          // Fragment spread: not used by the suite; skip the name.
          this.next();
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = this.peek() === '(' ? this.parseArguments() : [];
      while (this.peek() === '@') {
        this.next();
        this.next();
        if (this.peek() === '(') this.parseArguments();
      }
      const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
      fields.push({ alias, name, args, selectionSet, typeCondition: null, fragment: false });
    }
    this.expect('}');
    return fields;
  }
}

function evalValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'enum':
      return value.value;
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name'],
  RepositoryOwner: ['login', 'id'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'prefix', 'target'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'createdAt',
    'updatedAt', 'closedAt', 'url', 'repository',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'author', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'repository',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  Node: ['id'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

interface GObj {
  __type: string;
  [key: string]: unknown;
}

function obj(type: string, fields: Record<string, unknown>): GObj {
  return { __type: type, ...fields };
}

// ------------------------------------------------------------------ execution

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function repoGlobalId(repo: RepoRec): string {
  return globalId('Repository', [repo.dbId]);
}
function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return globalId('Issue', [repo.dbId, issue.number]);
}
function pullGlobalId(repo: RepoRec, pull: PullRec): string {
  return globalId('PullRequest', [repo.dbId, pull.number]);
}

function repoByDbId(store: Store, dbId: number): RepoRec | null {
  for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function userObj(login: string): GObj {
  return obj('User', { login });
}

function repoObj(repo: RepoRec): GObj {
  return obj('Repository', { repo });
}

function issueObj(repo: RepoRec, issue: IssueRec): GObj {
  return obj('Issue', { repo, issue });
}

function pullObj(repo: RepoRec, pull: PullRec): GObj {
  return obj('PullRequest', { repo, pull });
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function resolveField(ctx: ExecCtx, source: GObj, field: string, args: Record<string, unknown>): unknown {
  const { store } = ctx;
  const type = source.__type;

  if (field === '__typename') return type;

  if (type === 'Query') {
    switch (field) {
      case 'viewer':
        return userObj(store.viewerLogin ?? '');
      case 'repository': {
        const repo = store.repoFor(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoObj(repo) : null;
      }
      case 'node': {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (!parsed || parsed.kind !== 'Repository') return null;
        const repo = repoByDbId(store, Number(parsed.parts[0]));
        return repo ? repoObj(repo) : null;
      }
      case '__type': {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] || ENUM_VALUES[name]) return obj('__Type', { name });
        return null;
      }
      case 'rateLimit':
        return obj('RateLimit', {});
      default:
        return undefined;
    }
  }

  if (type === 'Mutation') return resolveMutation(ctx, field, args);

  if (type === 'User' || type === 'RepositoryOwner') {
    if (field === 'login') return source.login as string;
    if (field === 'id') return globalId('User', [source.login as string]);
    if (field === 'name') return source.login as string;
    return undefined;
  }

  if (type === 'Repository') {
    const repo = source.repo as RepoRec;
    switch (field) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.dbId;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.ownerLogin ?? store.viewerLogin ?? ''}/${repo.name}`;
      case 'owner':
        return userObj(repo.ownerLogin ?? store.viewerLogin ?? '');
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'defaultBranchRef': {
        const tip = store.branchTip(repo, repo.defaultBranch);
        return tip ? obj('Ref', { name: repo.defaultBranch }) : null;
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'createdAt':
      case 'updatedAt':
        return new Date(1_700_000_000_000 + repo.seq * 1000).toISOString();
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueObj(repo, issue) : null;
      }
      case 'issues':
        return issuesConnection(ctx, repo, args);
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullObj(repo, pull) : null;
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 30;
        const all = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
        const nodes = all.slice(0, first);
        return obj('PullRequestConnection', {
          nodes: nodes.map((p) => pullObj(repo, p)),
          total: repo.pulls.size,
          pageInfo: obj('PageInfo', {
            hasNextPage: nodes.length < all.length,
            hasPreviousPage: false,
            startCursor: nodes.length > 0 ? cursorFor(nodes[0].number) : null,
            endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1].number) : null,
          }),
        });
      }
      default:
        return undefined;
    }
  }

  if (type === 'Ref') {
    if (field === 'name') return source.name as string;
    if (field === 'prefix') return 'refs/heads/';
    return undefined;
  }

  if (type === 'Issue') {
    const repo = source.repo as RepoRec;
    const issue = source.issue as IssueRec;
    switch (field) {
      case 'id':
        return issueGlobalId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'author':
        return userObj(store.viewerLogin ?? '');
      case 'repository':
        return repoObj(repo);
      case 'createdAt':
      case 'updatedAt':
        return new Date(1_700_000_000_000 + issue.seq * 1000).toISOString();
      case 'closedAt':
        return issue.state === 'closed' ? new Date(1_700_000_000_000 + issue.seq * 1000).toISOString() : null;
      case 'url':
        return `https://forge.invalid/${repo.ownerLogin ?? ''}/${repo.name}/issues/${issue.number}`;
      case 'comments':
        return obj('IssueCommentConnection', {
          nodes: issue.comments.map((c) => obj('IssueComment', { repo, issue, comment: c })),
        });
      case 'labels':
        return obj('LabelConnection', { nodes: issue.labels.map((name) => obj('Label', { name })) });
      default:
        return undefined;
    }
  }

  if (type === 'PullRequest') {
    const repo = source.repo as RepoRec;
    const pull = source.pull as PullRec;
    switch (field) {
      case 'id':
        return pullGlobalId(repo, pull);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'mergeable': {
        const { conflict } = store.mergeability(repo, pull);
        return pull.merged ? 'UNKNOWN' : conflict ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'author':
        return userObj(store.viewerLogin ?? '');
      case 'repository':
        return repoObj(repo);
      case 'createdAt':
      case 'updatedAt':
        return new Date(1_700_000_000_000 + pull.seq * 1000).toISOString();
      case 'mergedAt':
        return pull.mergedAt;
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 30;
        const files = store.pullFiles(repo, pull).slice(0, first);
        return obj('PullRequestChangedFileConnection', {
          nodes: files.map((f) => obj('PullRequestChangedFile', { path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status === 'removed' ? 'DELETED' : f.status === 'added' ? 'ADDED' : 'MODIFIED' })),
        });
      }
      default:
        return undefined;
    }
  }

  if (type === 'IssueConnection' || type === 'PullRequestConnection') {
    if (field === 'nodes') return source.nodes as unknown[];
    if (field === 'pageInfo') return source.pageInfo as unknown;
    if (field === 'totalCount') return (source.total as number) ?? (source.nodes as unknown[]).length;
    return undefined;
  }
  if (type === 'PullRequestChangedFileConnection' || type === 'IssueCommentConnection' || type === 'LabelConnection') {
    if (field === 'nodes') return source.nodes as unknown[];
    if (field === 'totalCount') return (source.nodes as unknown[]).length;
    return undefined;
  }

  if (type === 'PullRequestChangedFile') {
    if (field === 'path' || field === 'additions' || field === 'deletions' || field === 'changeType') return source[field];
    return undefined;
  }

  if (type === 'IssueComment') {
    const repo = source.repo as RepoRec;
    const issue = source.issue as IssueRec;
    const comment = source.comment as { id: number; body: string; createdAt: string };
    if (field === 'id') return globalId('IssueComment', [repo.dbId, issue.number, comment.id]);
    if (field === 'body') return comment.body;
    if (field === 'author') return userObj(store.viewerLogin ?? '');
    if (field === 'createdAt') return comment.createdAt;
    return undefined;
  }

  if (type === 'Label') {
    if (field === 'name') return source.name as string;
    return undefined;
  }

  if (type === 'PageInfo') {
    if (field === 'hasNextPage' || field === 'hasPreviousPage' || field === 'startCursor' || field === 'endCursor') return source[field];
    return undefined;
  }

  if (type.endsWith('Payload')) {
    if (field === 'clientMutationId') return null;
    if (field === 'issue') return source.issue as unknown;
    if (field === 'pullRequest') return source.pullRequest as unknown;
    if (field === 'commentEdge') return source.commentEdge as unknown;
    return undefined;
  }

  if (type === 'CommentEdge') {
    if (field === 'node') return source.node as unknown;
    if (field === 'cursor') return cursorFor(0);
    return undefined;
  }

  if (type === '__Type') {
    const name = source.name as string;
    if (field === 'name') return name;
    if (field === 'kind') return ENUM_VALUES[name] ? 'ENUM' : 'OBJECT';
    if (field === 'fields') {
      const fields = TYPE_FIELDS[name];
      if (!fields) return null;
      return fields.map((f) => obj('__Field', { name: f }));
    }
    if (field === 'enumValues') {
      const values = ENUM_VALUES[name];
      if (!values) return null;
      return values.map((v) => obj('__EnumValue', { name: v }));
    }
    if (field === 'possibleTypes') return [];
    if (field === 'inputFields') return null;
    if (field === 'description') return null;
    return undefined;
  }

  if (type === '__Field' || type === '__EnumValue') {
    if (field === 'name') return source.name as string;
    if (field === 'description') return null;
    return undefined;
  }

  if (type === 'RateLimit') return null;

  return undefined;
}

function issuesConnection(ctx: ExecCtx, repo: RepoRec, args: Record<string, unknown>): GObj {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s).toLowerCase()) : null;
  if (states) issues = issues.filter((i) => states.includes(i.state));
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const desc = orderBy?.direction === 'DESC';
  issues.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  const total = issues.length;

  let startIndex = 0;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after) {
    try {
      const decoded = Buffer.from(after, 'base64url').toString('utf8');
      const m = /^cursor:(\d+)$/.exec(decoded);
      if (m) {
        const idx = issues.findIndex((i) => i.number === Number(m[1]));
        if (idx >= 0) startIndex = idx + 1;
      }
    } catch {
      // An undecodable cursor behaves like no cursor.
    }
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = issues.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + page.length < total;
  return obj('IssueConnection', {
    nodes: page.map((i) => issueObj(repo, i)),
    total,
    pageInfo: obj('PageInfo', {
      hasNextPage,
      hasPreviousPage: startIndex > 0,
      startCursor: page.length > 0 ? cursorFor(page[0].number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1].number) : null,
    }),
  });
}

function resolveMutation(ctx: ExecCtx, field: string, args: Record<string, unknown>): unknown {
  const { store } = ctx;
  const input = (args.input ?? {}) as Record<string, unknown>;

  switch (field) {
    case 'createIssue': {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed && parsed.kind === 'Repository' ? repoByDbId(store, Number(parsed.parts[0])) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve the repository for createIssue' });
        return null;
      }
      const issue = store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return obj('CreateIssuePayload', { issue: issueObj(repo, issue) });
    }
    case 'closeIssue': {
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      const repo = parsed && parsed.kind === 'Issue' ? repoByDbId(store, Number(parsed.parts[0])) : null;
      const issue = repo?.issues.get(Number(parsed?.parts[1]));
      if (!repo || !issue) {
        ctx.errors.push({ message: 'Could not resolve the issue for closeIssue' });
        return null;
      }
      issue.state = 'closed';
      return obj('CloseIssuePayload', { issue: issueObj(repo, issue) });
    }
    case 'createPullRequest': {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed && parsed.kind === 'Repository' ? repoByDbId(store, Number(parsed.parts[0])) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Could not resolve the repository for createPullRequest' });
        return null;
      }
      const pull = store.createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        headRef: String(input.headRefName ?? ''),
        baseRef: String(input.baseRefName ?? ''),
      });
      return obj('CreatePullRequestPayload', { pullRequest: pullObj(repo, pull) });
    }
    case 'mergePullRequest': {
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      const repo = parsed && parsed.kind === 'PullRequest' ? repoByDbId(store, Number(parsed.parts[0])) : null;
      const pull = repo?.pulls.get(Number(parsed?.parts[1]));
      if (!repo || !pull) {
        ctx.errors.push({ message: 'Could not resolve the pull request for mergePullRequest' });
        return null;
      }
      if (!pull.merged) {
        const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
        store.mergePull(repo, pull, method === 'merge' ? 'merge' : 'squash');
      }
      return obj('MergePullRequestPayload', { pullRequest: pullObj(repo, pull) });
    }
    case 'addComment': {
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      const repo = parsed && parsed.kind === 'Issue' ? repoByDbId(store, Number(parsed.parts[0])) : null;
      const issue = repo?.issues.get(Number(parsed?.parts[1]));
      if (!repo || !issue) {
        ctx.errors.push({ message: 'Could not resolve the subject for addComment' });
        return null;
      }
      const comment = store.addComment(issue, String(input.body ?? ''));
      return obj('AddCommentPayload', {
        commentEdge: obj('CommentEdge', { node: obj('IssueComment', { repo, issue, comment }) }),
      });
    }
    default:
      return undefined;
  }
}

const CHILD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Repository: {
    owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection',
    pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection',
  },
  Issue: { author: 'User', repository: 'Repository', comments: 'IssueCommentConnection', labels: 'LabelConnection' },
  PullRequest: { author: 'User', repository: 'Repository', files: 'PullRequestChangedFileConnection' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile' },
  IssueCommentConnection: { nodes: 'IssueComment' },
  LabelConnection: { nodes: 'Label' },
  IssueComment: { author: 'User' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge' },
  CommentEdge: { node: 'IssueComment' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

function execSelectionSet(ctx: ExecCtx, source: GObj, selections: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const type = source.__type;
  for (const sel of selections) {
    if (sel.fragment) {
      // Inline fragment: applies when the condition names this type, the Node
      // interface (for Repository), or is absent.
      if (sel.typeCondition === null || sel.typeCondition === type || (sel.typeCondition === 'Node' && type === 'Repository')) {
        Object.assign(out, execSelectionSet(ctx, source, sel.selectionSet ?? []));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = type;
      continue;
    }
    const knownFields = TYPE_FIELDS[type];
    const isMetaField = sel.name === '__type' && type === 'Query';
    if (!isMetaField && knownFields && !knownFields.includes(sel.name)) {
      ctx.errors.push({ message: `Field '${sel.name}' doesn't exist on type '${type}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const a of sel.args) args[a.name] = evalValue(a.value, ctx.variables);
    const value = resolveField(ctx, source, sel.name, args);
    if (value === undefined) {
      ctx.errors.push({ message: `Field '${sel.name}' doesn't exist on type '${type}'` });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, sel, CHILD_TYPE[type]?.[sel.name]);
  }
  return out;
}

function completeValue(ctx: ExecCtx, value: unknown, sel: FieldNode, childType: string | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, sel, childType));
  if (typeof value === 'object') {
    const gobj = value as GObj;
    const type = gobj.__type ?? childType;
    if (sel.selectionSet && type) {
      return execSelectionSet(ctx, { ...gobj, __type: type }, sel.selectionSet);
    }
    return value;
  }
  return value;
}

function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecCtx = { store, variables, errors: [] };
  const rootForExec: GObj = op.type === 'mutation' ? obj('Mutation', {}) : obj('Query', {});
  const data = execSelectionSet(ctx, rootForExec, op.selectionSet);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

export function handleGraphql(store: Store, rawBody: string): HttpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    const e = (entry ?? {}) as { query?: unknown; variables?: unknown };
    const queryText = typeof e.query === 'string' ? e.query : '';
    const variables = (e.variables !== null && typeof e.variables === 'object' ? e.variables : {}) as Record<string, unknown>;
    try {
      const ops = new Parser(tokenize(queryText)).parseDocument();
      const op = ops[0];
      if (!op) return { errors: [{ message: 'No operation found' }] };
      return executeOperation(store, op, variables);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
    }
  };
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map(runOne) };
  }
  return { status: 200, body: runOne(parsed) };
}
