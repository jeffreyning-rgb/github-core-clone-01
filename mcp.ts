// MCP surface (streamable HTTP, legacy era): the server answers server/discover
// with method-not-found, so clients fall back to initialize + tools/list +
// tools/call. Six tools mirror the REST resources against the same Store.
// Stateless: no session id is issued, and every response echoes its request id.

import { Store, type RepoRec } from './store.ts';
import { repoJson, type HttpResult } from './rest.ts';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The name of the repository'),
        description: str('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        title: str('The issue title'),
        body: str('The issue body'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        state: str('Filter by state: open, closed or all'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        title: str('The pull request title'),
        body: str('The pull request body'),
        head: str('The head branch name'),
        base: str('The base branch name'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        pull_number: { type: 'integer', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function rpcResult(id: unknown, result: unknown): HttpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): HttpResult {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolSuccess(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function findRepo(store: Store, args: Record<string, unknown>): RepoRec | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  if (!name) return null;
  return store.repoFor(owner, name) ?? store.repoByName(name);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { error: { code: -32602, message: `Missing required argument: ${required}` } };
    }
  }

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      const existing = store.repoByName(repoName);
      const repo =
        existing ??
        store.createRepo(repoName, {
          isPrivate: args.private === true,
          description: typeof args.description === 'string' ? args.description : '',
        });
      return { result: toolSuccess(repoJson(repo) as Record<string, unknown>) };
    }
    case 'get_repo': {
      const repo = findRepo(store, args);
      if (!repo) return { result: toolFailure(`repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      return { result: toolSuccess(repoJson(repo) as Record<string, unknown>) };
    }
    case 'create_issue': {
      const repo = findRepo(store, args);
      if (!repo) return { result: toolFailure('repository not found') };
      const issue = store.createIssue(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return {
        result: toolSuccess({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          html_url: `https://forge.invalid/${repo.ownerLogin ?? ''}/${repo.name}/issues/${issue.number}`,
        }),
      };
    }
    case 'list_issues': {
      const repo = findRepo(store, args);
      if (!repo) return { result: toolFailure('repository not found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => a.number - b.number)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }));
      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(issues) }],
          structuredContent: issues,
          isError: false,
        },
      };
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return { result: toolFailure('repository not found') };
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      if (!store.branchTip(repo, head) || !store.branchTip(repo, base)) {
        return { result: toolFailure(`head or base branch does not exist: ${head} -> ${base}`) };
      }
      const pull = store.createPull(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
      });
      return {
        result: toolSuccess({
          id: pull.id,
          number: pull.number,
          title: pull.title,
          state: pull.state,
          head: { ref: pull.headRef },
          base: { ref: pull.baseRef },
        }),
      };
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return { result: toolFailure('repository not found') };
      const number = Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (!pull) return { result: toolFailure(`pull request not found: ${String(args.pull_number)}`) };
      if (!pull.merged) {
        const sha = store.mergePull(repo, pull, 'squash');
        if (!sha) return { result: toolFailure('pull request is not mergeable') };
      }
      return {
        result: toolSuccess({ number: pull.number, merged: true, state: pull.state, sha: pull.mergeCommitSha }),
      };
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

export function handleMcp(store: Store, rawBody: string, authed: boolean): HttpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const request = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as {
    id?: unknown;
    method?: unknown;
    params?: Record<string, unknown>;
  };
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;

  // Notifications carry no id and are answered with an empty success.
  if (id === undefined) return { status: 204 };

  switch (method) {
    case 'server/discover':
      // Pre-discover era: method-not-found is the signal to fall back to legacy.
      return rpcError(id, -32601, 'Method not found: server/discover');
    case 'initialize': {
      const offered = (request.params?.protocolVersion as string) ?? '';
      const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-06-18';
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge-mcp', version: '1.0.0' },
      });
    }
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      if (!authed) return { status: 401, body: { message: 'Unauthorized' } };
      const params = request.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(store, name, args);
      if (outcome.error) return rpcError(id, outcome.error.code, outcome.error.message);
      return rpcResult(id, outcome.result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
