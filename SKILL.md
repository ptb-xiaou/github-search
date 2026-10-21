---
name: github-search
description: Search GitHub repositories, code, issues, pull requests, commits and users through the GitHub REST API using a locally configured token, and manage repositories (create, edit, publish) from the same client. Use for finding projects, locating code or symbols anywhere on GitHub, looking up issues/PRs, creating a public repository and pushing a local project, checking a token's scopes or rate limits, or any 中文请求 like "在 GitHub 上搜…/找项目/搜代码/查 issue/建仓库/发布仓库".
whenToUse: The user wants to find something on GitHub (repos, code across repos, issues, PRs, commits, users), needs GitHub API queries or rate-limit/scope diagnostics, wants to create/rename/archive/delete a repository, or wants to publish a local git repository to GitHub.
metadata:
  version: "1.2.0"
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
| `api <path>` | Call any REST path (`api repos/nodejs/node --param per_page=5`; write with `--method POST --data '<json>'`) |

Repository commands (these write to GitHub — see the rules below):

| Command | Purpose |
|---|---|
| `repo-create <name>` | Create a repository; **private unless `--public`** |
| `repo-view <owner/repo>` | Visibility, branch, license, topics, size, timestamps |
| `repo-list` | List repositories you own |
| `repo-edit <owner/repo>` | Description, homepage, name, default branch, visibility, archive, topics |
| `repo-delete <owner/repo> --yes` | Delete a repository (irreversible) |
| `publish [dir]` | Publish gate → commit → push |

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
7. **Confirm before any write.** Repository commands change real GitHub state.
   Say exactly what will change (visibility, name, deleted repo) and get a yes
   before running them, even when the user's intent seems obvious.

## Repository management

These commands write to GitHub. They are not previews:

| Command | Effect |
|---|---|
| `repo-create <name>` | Create a repository, **private unless `--public`** |
| `repo-view <owner/repo>` | Show visibility, branch, license, topics, size, timestamps |
| `repo-list` | List repositories you own (`--visibility public`, `--affiliation owner`) |
| `repo-edit <owner/repo>` | Description, homepage, name, default branch, visibility, archive, topics |
| `repo-delete <owner/repo> --yes` | Delete a repository — irreversible |
| `publish [dir]` | Publish gate → commit → push |

Rules:

- **`--public` is never implied.** `repo-create` defaults to private and prints a
  `[note]` saying so. An accidental public repository exposes code the moment it
  is created, so pass `--public` only when the user asked for a public repo.
- **`repo-delete` needs `--yes`, and needs the `delete_repo` scope.** A classic
  PAT with `repo` alone does **not** get it: the API answers
  `403 Must have admin rights to Repository.` When that happens, tell the user
  which scope is missing and offer the web UI link — do not retry with other
  credentials or claim the repository is gone.
- **`--topics` replaces the whole list** on `repo-edit`. Read the current topics
  with `repo-view` first, then send the full desired list.
- **`--dry-run` on any write command** prints the HTTP method, URL and body
  without sending it. For `publish` it prints the paths that would be committed.
  Use it whenever the user is unsure what a command would do.
- **`publish` never stores the token.** It hands git an `AUTHORIZATION` header
  through an environment-scoped config, so the token stays out of `.git/config`,
  the remote URL and the commit. It refuses to commit or push when
  `check-public-safe.mjs --history` fails.
- A bare token with `repo` scope can create and edit repositories but not delete
  them; creating inside an organisation additionally requires that org to allow
  it for your account. Surface the API error verbatim instead of guessing.

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
- **Network failures are not API failures.** `fetch failed`, `ECONNRESET`,
  `unable to access 'https://github.com/…'` usually mean the network filters
  github.com, not that the token is wrong. See the proxy section below before
  telling the user anything is misconfigured.

## Networks and proxies

On filtered networks `github.com:443` is often reset (so `git push` dies) while
`api.github.com` still answers, and sometimes both are unreachable. A local
proxy — Clash/mihomo on 7890, Clash Verge on 7897, v2rayN on 10809, sing-box on
1080/8080 — fixes both paths:

```bash
node scripts/gh-search.mjs check --proxy http://127.0.0.1:7890
node scripts/gh-search.mjs check --proxy auto            # probe the usual local ports
node scripts/gh-search.mjs repo "stars:>5000" --proxy auto
node scripts/gh-search.mjs publish -m "feat: …"         # push retries through the proxy
```

- With **no proxy flag**, a request that fails at the network layer triggers one
  auto-detect retry through the first local port that answers
  (`7890`, `7897`, `10809`, `1080`, `8888`, `8080`). `publish` does the same for
  `git push`, so a filtered network does not block publishing.
- `$GITHUB_SEARCH_PROXY`, `$DSH_GITHUB_SEARCH_PROXY`, `$HTTPS_PROXY` and
  `$ALL_PROXY` are honored when no flag is given; the flag always wins.
- `--no-proxy` disables auto-detection and the fallback entirely.
- Authenticated proxies work: `--proxy http://user:pass@host:port` sends a Basic
  `Proxy-Authorization` header. Prefer the environment variable over the flag so
  the proxy password does not land in shell history.
- The proxy only carries traffic; credentials are still read from the credential
  file and never written to disk by the client.

## Publishing this skill

If the bundle is published publicly, the credential file must not ship:

```bash
node scripts/check-public-safe.mjs --history   # exits non-zero on any leak
```

That gate scans the working tree for token-shaped strings, verifies `.gitignore`
covers `.secrets/` and `config.local.json`, and checks the last 200 commits.
`.gitignore` in this bundle already excludes every credential path.

Or run the whole goodbye in the safe order:

```bash
node scripts/gh-search.mjs publish -m "feat: …"          # gate → commit → push
node scripts/gh-search.mjs publish --dry-run -m "feat: …"  # preview only
```

`publish` aborts unless the gate says SAFE, then commits and pushes with an
ephemeral token header (nothing is written into the repository).

## Resources

- `scripts/gh-search.mjs` — the client (also the reference for request headers,
  pagination limits, and rate-limit handling)
- `scripts/gh-search.ps1` — Windows wrapper
- `scripts/check-public-safe.mjs` — publish-safety gate
- `config.example.json` — credential file template
- `references/search-syntax.md` — search qualifier cheat sheet
