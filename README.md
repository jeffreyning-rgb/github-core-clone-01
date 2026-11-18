[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jeffreyning-rgb/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/jeffreyning-rgb/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible forge in one Node process

An entry for [the contest](https://make.fun/bounty/github-core-clone-01): a standalone
GitHub-compatible forge with its own in-memory store, implemented from scratch with
zero runtime dependencies (Node builtins only, no git binary).

## Run it

```sh
node main.ts
```

`main.ts` is the harness lifecycle (bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`,
poll `/done`, exit 0), implementing the starter's lifecycle contract. `app.ts` builds the
HTTP server it serves.

## What's inside

| File | Surface |
|---|---|
| `gitcore.ts` | Git object model: loose-object hashing, trees, commits, tags, pkt-line codec, packfile write (full objects) and read (OFS/REF delta resolution), delta application |
| `store.ts` | One content-addressed object store shared by every repository, plus per-repo refs, issues, pull requests and labels; three-way tree merges, merge-base, line diffs |
| `githttp.ts` | Git smart HTTP: `info/refs` (protocol v0 and v2), `ls-refs`, `git-upload-pack` (shallow/deepen-aware fetch planning, side-band-64k), `git-receive-pack` (report-status, fast-forward enforcement) |
| `rest.ts` | REST v3: repositories, branches, git refs, commits, contents (real git commits underneath), issues, comments, labels, pull requests, files, merges, `/meta`, pagination with `Link` headers |
| `graphql.ts` | GraphQL v4 subset: a small parser/executor covering viewer, repository, issue/pull connections with cursor pagination, the five mutations (createIssue, closeIssue, createPullRequest, mergePullRequest, addComment), Relay `node(id:)` and the `__type` introspection probes |
| `mcp.ts` | MCP over streamable HTTP (legacy era): `initialize`, `tools/list`, `tools/call` with the six github-mcp-server tools, JSON-RPC error semantics, 401 for unauthenticated calls |
| `app.ts` | Routing, bearer-token auth, `X-GitHub-Request-Id` on every response |

Design notes:

- All four surfaces read and write the **same store**, so an issue created over MCP is
  the same object over REST and GraphQL, and a branch pushed over git is immediately
  a REST branch.
- The token owner's login is *learned* from the first owner-addressed request (the
  process is never told it); a repository addressed under a different owner is a 404,
  and token-created repositories are claimed by the first owner that addresses them.
- Fetch planning is breadth-first with an explicit model of what the client holds
  (haves minus everything below its shallow boundaries), so shallow clones, deepens
  and incremental fetches each receive exactly the missing objects.
- Outgoing packs are always self-contained full objects (deflate level 1, cached per
  fetch plan); incoming packs may use deltas and are fully resolved.
