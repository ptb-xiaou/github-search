# github-search

A [DSH](https://github.com/deepseek-ai/deepseek-harness) skill that searches
GitHub — repositories, code, issues, pull requests, commits and users — through
the REST API, and manages your repositories from the same client, with the
credential kept **outside** this bundle.

- Zero dependencies (Node 18+ global `fetch`, or PowerShell 7 as a wrapper)
- One command per search, table or `--json` output
- Rate-limit aware: prints the live budget, waits out a short reset
- Create, view, edit, list, delete and publish repositories — dry-run first
- Proxy-aware: `--proxy`, env vars, and automatic local-Clash detection when a
  network filters github.com
- Ships a publish gate that refuses to let a token leave with the skill

Published at <https://github.com/ptb-xiaou/github-search>.

## Install

Clone this repository straight into a scanned skill root, or copy (or symlink)
the directory into one:

| Scope | Path |
|---|---|
| User (all projects) | `$DSH_HOME/skills/github-search` — usually `~/.dsh/skills/github-search` |
| Project | `<projectRoot>/.dsh/skills/github-search` |
| Shared agents | `~/.agents/skills/github-search` |

DSH watches these roots, so the skill appears without a restart.

## Configure the credential

You need a GitHub personal access token:
<https://github.com/settings/tokens> (classic) or
<https://github.com/settings/personal-access-tokens> (fine-grained).

- Searching **public** repositories works with a token that has **no scopes at
  all** — the token only raises the limit from 10 to 30 searches/minute.
- Searching **private** repositories needs `repo` (classic) or, for a
  fine-grained token, access to those repositories with `Contents: Read`.
- **Deleting** a repository needs the separate `delete_repo` scope.
  `repo` alone is not enough — the API answers
  `403 Must have admin rights to Repository.` Creating and editing only need
  `repo`.
- The code-search endpoint always requires authentication.

Then pick **one** place to store it. The client checks them in this order:

| # | Source | Where |
|---|---|---|
| 1 | `--token` flag | command line — avoid, it lands in shell history |
| 2 | `--token-file` / `--config` | any path you pass |
| 3 | `GITHUB_SEARCH_CONFIG`, `DSH_GITHUB_SEARCH_CONFIG` | environment variable pointing at a config file |
| 4 | `GITHUB_TOKEN`, `GH_TOKEN` | environment variables |
| 5 | **user credential file (recommended)** | `$DSH_HOME/secrets/github-search.json`, i.e. `~/.dsh/secrets/github-search.json` |
| 6 | bundle-local fallback | `<bundle>/.secrets/github-search.json` (git-ignored) |
| 7 | `gh auth token` | if the GitHub CLI is installed and logged in |

**Recommended — a file that no repository can ever contain:**

```bash
mkdir -p ~/.dsh/secrets
cp config.example.json ~/.dsh/secrets/github-search.json
# then edit it:  {"token": "ghp_…"}
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\secrets" | Out-Null
Copy-Item config.example.json "$env:USERPROFILE\.dsh\secrets\github-search.json"
notepad "$env:USERPROFILE\.dsh\secrets\github-search.json"
```

The file may also be a bare token with no JSON wrapper. Environment variables
(`GITHUB_TOKEN`) also work well when you do not want a file on disk at all.

Verify everything at once:

```bash
node scripts/gh-search.mjs check     # login, scopes, rate limits
node scripts/gh-search.mjs config    # which source is active (token masked)
```

## Use

```bash
node scripts/gh-search.mjs repo "agent framework language:python stars:>2000" --limit 5
node scripts/gh-search.mjs code "repo:torvalds/linux define MAX_ORDER"
node scripts/gh-search.mjs issues "repo:microsoft/vscode is:open label:bug" --limit 5
node scripts/gh-search.mjs commits "repo:nodejs/node path:lib author:ry"
node scripts/gh-search.mjs users "torvalds"
node scripts/gh-search.mjs api repos/nodejs/node --param per_page=5 --json
```

`--help` prints the full flag list; `references/search-syntax.md` documents the
qualifiers.

## Search quality (`repo`)

`repo` search is quality-ranked by default: archived and stale repositories are
removed first, then the survivors are scored by `log10(stars)` + `1.2 × recency`
+ forks, with an ~8-month recency half-life. Stars lead the score, but a year of
silence costs about one order of magnitude of stars, so a live 40k-star project
outranks a dormant 120k-star one. The top rows are therefore popular **and**
alive — GitHub's own best-match order puts archived 8k-star projects and dormant
lists first, and this does not.

```bash
node scripts/gh-search.mjs repo "mcp server" --limit 5
# total_count: 176597  (ranked 43/50 by quality, showing 5)
# [quality] dropped 3 archived, 4 stale (of 50 candidates)

# tighten the bar
node scripts/gh-search.mjs repo "mcp server" --limit 5 --min-stars 5000 --active-within 90

# opt out / override
node scripts/gh-search.mjs repo "mcp server" --limit 5 --no-quality      # GitHub's own order
node scripts/gh-search.mjs repo "mcp server" --limit 5 --sort stars      # explicit sort wins
node scripts/gh-search.mjs repo "mcp server" --limit 5 --quality --sort stars   # force re-rank
```

| Flag | Effect |
|---|---|
| `--no-quality` | Use GitHub's own best-match order |
| `--quality` | Re-rank even when `--sort` is given |
| `--active-within <days>` | Drop repos not pushed in N days (default 730; `0` keeps all) |
| `--min-stars <n>` | Drop repos below n stars (default 0) |
| `--include-archived` | Keep archived/disabled repos (dropped by default) |
| `--no-forks` | Also drop forks (kept by default) |
| `--candidates <n>` | Candidates fetched for ranking (default `min(100, max(limit*5, 50))`) |

When everything is filtered out the tool says so on stderr and suggests
`--active-within 0`, `--include-archived`, or `--min-stars 0`. `--json` returns
the raw GitHub payload, so it bypasses the local ranking by design (with a
`[quality]` note on stderr).

## Manage repositories

```bash
# create — PRIVATE unless you pass --public
node scripts/gh-search.mjs repo-create my-tool --desc "my tool" --topics cli,nodejs
node scripts/gh-search.mjs repo-create demo --public --auto-init --gitignore Node

# inspect
node scripts/gh-search.mjs repo-view ptb-xiaou/github-search
node scripts/gh-search.mjs repo-list --visibility public --limit 5

# edit — --topics REPLACES the whole list
node scripts/gh-search.mjs repo-edit me/my-tool --desc "new description"
node scripts/gh-search.mjs repo-edit me/my-tool --archive

# delete — needs --yes (and the delete_repo scope)
node scripts/gh-search.mjs repo-delete me/my-tool --yes
```

Every write command accepts `--dry-run`, which prints the HTTP method, URL and
body without sending it:

```bash
node scripts/gh-search.mjs repo-create demo --public --dry-run
```

`--public` is never implied, `--yes` is mandatory for deletion, and `repo-edit`
refuses to run with no changes. For anything unusual, `api` can call any REST
path: `api user/repos --method POST --data '{"name":"x"}'`.

## Behind a proxy

Some networks reset `github.com:443` — `git push` dies with
`unable to access … Recv failure: Connection was reset` — while `api.github.com`
still answers, and some block both. A locally running proxy fixes both paths:

```bash
node scripts/gh-search.mjs check --proxy http://127.0.0.1:7890
node scripts/gh-search.mjs check --proxy auto      # probe 7890, 7897, 10809, 1080, 8888, 8080
node scripts/gh-search.mjs publish -m "feat: …"    # gate → commit → push (retries via the proxy)
```

Precedence, first match wins:

| # | Source |
|---|---|
| 1 | `--proxy <url>` |
| 2 | `--proxy auto` |
| 3 | `$GITHUB_SEARCH_PROXY` |
| 4 | `$DSH_GITHUB_SEARCH_PROXY` |
| 5 | `$HTTPS_PROXY` / `$ALL_PROXY` |

With no proxy configured, a network-level failure triggers **one** automatic
retry through the first local port that answers. `publish` applies the same
fallback to `git push`, so a filtered network does not block publishing.
`--no-proxy` turns all of it off. Authenticated proxies
(`http://user:pass@host:port`) send a Basic `Proxy-Authorization` header — put
those in an environment variable rather than a shell history entry.

Requests go through an HTTP `CONNECT` tunnel built on `node:net` + `node:tls`,
so proxying adds no dependency and no TLS downgrade.

## Publishing this skill publicly

This directory **is** the git repository —
`git remote -v` → `https://github.com/ptb-xiaou/github-search`. `.gitignore`
excludes every credential path (`.secrets/`, `config.local.json`,
`config.json`, `*.token`, `.env*`), and the gate below fails if anything slips
through:

```bash
node scripts/check-public-safe.mjs            # working tree + ignore coverage
node scripts/check-public-safe.mjs --history  # also the last 200 commits
```

Before every push:

1. `node scripts/check-public-safe.mjs --history` → must print `SAFE`.
2. `git add -A && git status` → confirm no `.secrets/`, no `config.local.json`.
3. Push (`git push`).

Or let the client run the whole goodbye in the safe order:

```bash
node scripts/gh-search.mjs publish --dry-run -m "feat: …"  # gate + preview, changes nothing
node scripts/gh-search.mjs publish -m "feat: …"            # gate → commit → push
```

`publish` aborts unless the gate says SAFE, then commits and pushes with an
ephemeral `AUTHORIZATION` header, so the token never lands in `.git/config`, the
remote URL or the commit.

The gate scans only what `git add -A` would publish. A credential file that
exists locally but is git-ignored is reported as `local-only` and does **not**
block the push — it is exactly the thing that must stay behind.

If a token ever does reach a commit, treat it as compromised: **revoke it** at
<https://github.com/settings/tokens> and rewrite history (`git filter-repo`)
before pushing — removing the file in a later commit is not enough, since the
token stays in the history and `git log -p` still reveals it.

## Layout

```
github-search/
├── SKILL.md                     # instructions the agent loads
├── README.md                    # this file
├── LICENSE                      # MIT
├── config.example.json          # credential template (placeholder only)
├── .gitignore                   # hides credential paths from publication
├── references/
│   └── search-syntax.md         # search qualifier cheat sheet
└── scripts/
    ├── gh-search.mjs            # the client
    ├── gh-search.ps1            # Windows wrapper
    └── check-public-safe.mjs    # publish-safety gate
```

## License

MIT — see [LICENSE](LICENSE).
