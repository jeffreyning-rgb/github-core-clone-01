// The forge server. main.ts owns the process lifecycle (ephemeral port, /register,
// /done, exit); this file is the HTTP surface it serves. All state lives in one
// in-memory Store shared by the REST, GraphQL, MCP and git-HTTP surfaces, so the
// surfaces always agree with each other.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

import { Store } from './store.ts';
import { handleRest, type HttpResult } from './rest.ts';
import { handleGitHttp } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const store = new Store();
let requestSeq = 0;

function requestId(): string {
  requestSeq += 1;
  return `${requestSeq.toString(16).padStart(4, '0')}:${randomBytes(6).toString('hex').toUpperCase()}`;
}

const NOT_FOUND: HttpResult = { status: 404, body: { message: 'Not Found' } };
const UNAUTHORIZED: HttpResult = { status: 401, body: { message: 'Unauthorized' } };

function send(res: ServerResponse, result: HttpResult): void {
  const headers: Record<string, string> = {
    'X-GitHub-Request-Id': requestId(),
    ...(result.headers ?? {}),
  };
  let body: Buffer;
  if (result.raw !== undefined) {
    body = result.raw;
  } else if (result.body !== undefined) {
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }
    body = Buffer.from(JSON.stringify(result.body), 'utf8');
  } else {
    body = Buffer.alloc(0);
  }
  headers['Content-Length'] = String(body.length);
  res.writeHead(result.status, headers);
  res.end(body);
}

function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function hasValidAuth(req: IncomingMessage): boolean {
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
  const token = expectedToken();
  return token === '' ? auth.length > 'Bearer '.length : auth === `Bearer ${token}`;
}

function hasAnyAuth(req: IncomingMessage): boolean {
  const auth = req.headers['authorization'];
  return typeof auth === 'string' && auth.length > 0;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://forge.invalid');
  } catch {
    send(res, NOT_FOUND);
    return;
  }
  const path = url.pathname;
  const origin = `http://${typeof req.headers.host === 'string' ? req.headers.host : 'forge.invalid'}`;

  // Liveness probe: no auth. The env boot check wants a 200; the suite accepts a
  // body containing "ok".
  if (path === '/healthz' && method === 'GET') {
    send(res, { status: 200, body: { ok: true } });
    return;
  }

  // API root + REST v3.
  if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
    if (!hasValidAuth(req)) {
      send(res, UNAUTHORIZED);
      return;
    }
    const body = (await readBody(req)).toString('utf8');
    let malformedBody = false;
    if (body.trim() !== '') {
      try {
        JSON.parse(body);
      } catch {
        malformedBody = true;
      }
    }
    const segments =
      path === '/api/v3' || path === '/api/v3/'
        ? []
        : path
            .slice('/api/v3/'.length)
            .split('/')
            .filter((s) => s !== '');
    const result = handleRest({ store, method, segments, query: url.searchParams, body, origin, malformedBody });
    send(res, result ?? NOT_FOUND);
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql' && method === 'POST') {
    if (!hasValidAuth(req)) {
      send(res, UNAUTHORIZED);
      return;
    }
    const body = (await readBody(req)).toString('utf8');
    send(res, handleGraphql(store, body));
    return;
  }

  // MCP over streamable HTTP.
  if (path === '/mcp') {
    if (method === 'POST') {
      const body = (await readBody(req)).toString('utf8');
      send(res, handleMcp(store, body, hasAnyAuth(req)));
      return;
    }
    if (method === 'DELETE') {
      send(res, { status: 204 });
      return;
    }
    send(res, NOT_FOUND);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const tail = (gitMatch[3] ?? '').split('/').filter((s) => s !== '');
    const body = await readBody(req);
    const result = handleGitHttp({ store, method, owner, repoName, tail, query: url.searchParams, headers: req.headers, body });
    send(res, result ?? NOT_FOUND);
    return;
  }

  send(res, NOT_FOUND);
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch(() => {
      try {
        send(res, { status: 500, body: { message: 'Internal Server Error' } });
      } catch {
        // The response is already gone; nothing more to do.
      }
    });
  });
}
