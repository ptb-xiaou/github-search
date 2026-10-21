---
name: github-search
description: Search GitHub repositories, code, issues, pull requests, commits and users through the GitHub REST API using a locally configured token. Use for finding projects, locating code or symbols anywhere on GitHub, looking up issues/PRs, checking a token's scopes or rate limits, or any 中文请求 like "在 GitHub 上搜…/找项目/搜代码/查 issue".
whenToUse: The user wants to find something on GitHub (repos, code across repos, issues, PRs, commits, users), or needs GitHub API queries, rate-limit/scope diagnostics, or help wiring up a GitHub token for searching.
metadata:
  version: "1.0.0"
  runtime: node>=18
  credential_file: "$DSH_HOME/secrets/github-search.json"
  repository: https://github.com/ptb-xiaou/github-search
---

# GitHub Search

Search GitHub through the REST API with the bundle's own client. One script,
no dependencies, no MCP server, token kept outside the bundle.

## Run it

All commands go through the same entry point:

```bash
node scripts/gh-search.mjs <command> [query] [flags]
```

Windows users may call `scripts/gh-search.ps1 <command> …` instead — it is a
thin wrapper that forwards to Node.

| Command | Purpose |
|---|---|
| `check` | Validate the token; print login, scopes, rate limits |
| `config` | Show which credential source is active (token masked) |
| `limit` | Print every rate-limit bucket |
| `repo <q>` | Search repositories |
| `code <q>` | Search code — file contents, supports qualifiers |
| `issues <q>` | Search issues **and** pull requests |
| `commits <q>` | Search commit messages |
| `users <q>` | Search users and organizations |
| `api <path>` | Call any REST path (`api repos/nodejs/node --param per_page=5`) |

Common flags: `--limit <n>` (default 10, max 100), `--sort`, `--order`,
`--json` (raw payload), `--param k=v`, `--token-file <p>`, `--no-wait`.

## Workflow

1. **Run `check` once per session** when anything about credentials or limits is
   in doubt. It prints the credential source and the live budget.
2. **Pick the right endpoint.** Repo names/descriptions → `repo`. Anything that
   only appears *inside* files → `code`. Bug reports, feature requests, PRs →
   `issues`. Commit messages → `commits`.
3. **Write a qualifier-rich query.** Scoped queries are dramatically cheaper and
   more accurate than broad ones. Always prefer at least one of
   `repo:owner/name`, `org:name`, `user:name`, `language:`, `filename:`,
   `path:`, or a `stars:`/`pushed:` bound. See
   [references/search-syntax.md](references/search-syntax.md).
4. **Read the results, then narrow.** If `total_count` is huge, tighten the
   query instead of raising `--limit`. `--limit` above 100 is not supported by
   GitHub, and a single search cannot page beyond 1000 results.
5. **Report what came back.** Give the user `owner/repo`, the file path or
   `#number`, and the `html_url`. Never invent a result that the command did not
   return; if the search returns nothing, say so and show the query used.
6. **Use `--json`** when you need fields the table view omits (topics, license,
   `pushed_at`, patch URLs) or when you are going to post-process the payload.

## Credentials

The client resolves a token from the first source that exists:

1. `--token <value>` (avoid — lands in shell history)
2. `--token-file <path>` / `--config <path>`
3. `$GITHUB_SEARCH_CONFIG` / `$DSH_GITHUB_SEARCH_CONFIG`
4. `$GITHUB_TOKEN` / `$GH_TOKEN`
5. **`$DSH_HOME/secrets/github-search.json`** — the recommended place
   (`~/.dsh/secrets/github-search.json`); it lives outside this bundle and
   outside any git repository, so it can never be published by accident
6. `<bundle>/.secrets/github-search.json` — portable fallback, git-ignored
7. `gh auth token` (GitHub CLI), if installed

The file format is `{"token": "ghp_…"}`; `config.example.json` in this bundle is
the template, and a bare token file (no JSON) is also accepted.

Rules when handling credentials:

- Never print, echo, log, or repeat a token in full. `config` shows it masked;
  do the same in your own replies.
- Never copy a token into a command-line argument, a script, a commit, or a
  chat message. Move it into the credential file instead.
- If a token appears to be exposed, tell the user to revoke it at
  <https://github.com/settings/tokens> and create a new one.
- `repo` scope means full read/write on the user's private repositories. If the
  task only needs public search, suggest a fine-grained token with
  `Contents: Read` instead.

## Limits and failure handling

- Search is **30 requests/minute** authenticated (10 unauthenticated); core is
  5000/hour. Rate-limit state is printed to stderr as `[rate] …`.
- On a primary limit the client waits automatically when the reset is ≤ 70s
  (`--max-wait <sec>` to change, `--no-wait` to fail fast). Do not loop on a 403:
  reading the printed reset time is cheaper than retrying.
- `401` → token missing, expired, or revoked. `403` → rate limit or missing
  scope. `422` → the query is invalid (GitHub rejects empty `q` and some
  qualifier combinations). Report the status and body instead of guessing.
- Failure to find a token exits with code 3 and prints the credential file paths
  — relay those paths to the user rather than asking them to paste a token into
  the conversation.

## Publishing this skill

If the bundle is published publicly, the credential file must not ship:

```bash
node scripts/check-public-safe.mjs --history   # exits non-zero on any leak
```

That gate scans the working tree for token-shaped strings, verifies `.gitignore`
covers `.secrets/` and `config.local.json`, and checks the last 200 commits.
`.gitignore` in this bundle already excludes every credential path.

## Resources

- `scripts/gh-search.mjs` — the client (also the reference for request headers,
  pagination limits, and rate-limit handling)
- `scripts/gh-search.ps1` — Windows wrapper
- `scripts/check-public-safe.mjs` — publish-safety gate
- `config.example.json` — credential file template
- `references/search-syntax.md` — search qualifier cheat sheet
