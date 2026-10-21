# GitHub search syntax

Qualifiers are appended to the query string. Values with spaces or `>`/`<`
should be quoted as one shell argument.

## Repositories — `repo`

| Qualifier | Example |
|---|---|
| `in:name`, `in:description`, `in:readme`, `in:topics` | `dsh in:name` |
| `user:`, `org:` | `org:deepseek-ai` |
| `language:` | `language:rust` |
| `stars:`, `forks:`, `size:` (KB) | `stars:>5000 stars:<20000` |
| `created:`, `pushed:`, `updated:` | `pushed:>2025-01-01` |
| `topic:` | `topic:mcp` |
| `license:` | `license:mit` |
| `is:public`, `is.private` (deprecated: `private:true`) | `is:public` |
| `archived:false`, `mirror:false`, `template:false` | `archived:false` |
| `fork:true`, `fork:only` | `fork:only` |
| `good-first-issues:>10`, `help-wanted-issues:>5` | |
| `followers:`, `repos:` (users) | |

Sorting: `--sort stars|forks|updated|help-wanted-issues`, `--order asc|desc`.
Only sortable qualifiers (`stars`, `forks`, `updated`) may be combined with
`--sort`.

## Code — `code`

Code search matches **file contents**, not paths or names.

| Qualifier | Example |
|---|---|
| `repo:`, `org:`, `user:` | `repo:torvalds/linux` |
| `language:` | `language:go` |
| `path:` | `path:src/hooks` |
| `filename:` | `filename:package.json` |
| `extension:` | `extension:ts` |
| `in:file` | `in:file` (search contents) |
| `is:archived`, `fork:` | `fork:true` |

Notes:

- Authentication is mandatory.
- A search returns at most **1000** results (`--limit` is capped at 100 per
  request; a single query cannot page past 1000).
- `repo:` also includes forks if the repository has none of its own? No — add
  `fork:true` to include forks.
- Multiple `repo:` qualifiers are not OR'd reliably; issue one query per repo.

## Issues and pull requests — `issues`

| Qualifier | Example |
|---|---|
| `repo:`, `org:`, `user:` | `repo:microsoft/vscode` |
| `is:issue`, `is:pr`, `is:open`, `is:closed`, `is:merged`, `is:draft` | `is:pr is:open` |
| `state:open|closed` | `state:closed` |
| `label:`, `-label:` | `label:"good first issue"` |
| `author:`, `assignee:`, `mentions:`, `commenter:`, `involves:` | `involves:torvalds` |
| `created:`, `updated:`, `closed:` | `created:>=2025-06-01` |
| `comments:>10`, `reactions:>100` | |
| `no:label`, `no:assignee`, `no:milestone` | |
| `milestone:`, `project:` | |
| `linked:pr`, `review:approved` (PRs) | |

Sorting: `--sort created|updated|comments`, `--order asc|desc`.

## Commits — `commits`

`repo:`, `org:`, `user:`, `author:`, `committer:`, `author-name:`,
`author-email:`, `author-date:`, `committer-date:`, `merge:true|false`,
`hash:`, `parent:`.

## Users — `users`

`type:user|org`, `in:login`, `in:fullname`, `in:email`, `repos:>10`,
`followers:>1000`, `location:`, `language:`, `created:`, `followers:`.

Date qualifiers accept `YYYY-MM-DD`, `>=YYYY-MM-DD`, `<=YYYY-MM-DD` and ranges
`2024-01-01..2024-12-31`.

## Sorting and paging

- `--limit n` → `per_page` (max 100). There is no offset flag; add a narrower
  qualifier instead of paging. The `api` command accepts `--param page=2` when
  you really need it on a non-search endpoint.
- Search results are capped at 1000 items regardless of `total_count`.

## Errors

| Status | Meaning |
|---|---|
| 401 | token missing, expired or revoked |
| 403 | rate limit (30 searches/min) or insufficient scope; secondary limits return `retry-after` |
| 404 | path or repository not visible to this token |
| 422 | invalid query — empty `q`, unknown qualifier value, or unusable combination |

Reference: <https://docs.github.com/en/search-github/advanced-search>
