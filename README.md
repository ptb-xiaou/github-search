# github-search

A [DSH](https://github.com/deepseek-ai/deepseek-harness) skill that searches
GitHub — repositories, code, issues, pull requests, commits and users — through
the REST API, with the credential kept **outside** this bundle.

- Zero dependencies (Node 18+ global `fetch`, or PowerShell 7 as a wrapper)
- One command per search, table or `--json` output
- Rate-limit aware: prints the live budget, waits out a short reset
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
