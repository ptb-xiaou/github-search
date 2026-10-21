#!/usr/bin/env node
/**
 * github-search skill — GitHub REST API search client.
 *
 * Credential resolution order (first hit wins):
 *   1. --token <value>                       (discouraged: leaks into shell history)
 *   2. --token-file <path>                   (JSON {"token":"..."} or a bare token file)
 *   3. $GITHUB_SEARCH_CONFIG / $DSH_GITHUB_SEARCH_CONFIG  (path to a JSON config)
 *   4. --config <path>                       (explicit JSON config)
 *   5. $GITHUB_TOKEN / $GH_TOKEN
 *   6. $DSH_HOME/secrets/github-search.json  (~/.dsh/secrets/github-search.json)
 *   7. <bundle>/.secrets/github-search.json  (git-ignored, portable)
 *   8. `gh auth token`                       (GitHub CLI, if installed)
 *
 * The token is never printed in full; errors carry a masked prefix only.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(HERE, '..');
const DEFAULT_API = 'https://api.github.com';
const DEFAULT_UA = 'dsh-github-search-skill/1.0';
const API_VERSION = '2022-11-28';

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key;
      let value;
      if (eq !== -1) {
        key = a.slice(2, eq);
        value = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        const next = argv[i + 1];
        value = next !== undefined && !next.startsWith('--') ? argv[++i] : true;
      }
      if (key === 'param') {
        (flags.param ||= []).push(value);
      } else {
        flags[key] = value;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

// ------------------------------------------------------- credentials

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');

function readJsonFile(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) throw new Error('file is empty');
  if (!raw.startsWith('{')) return { token: raw }; // bare token file
  return JSON.parse(raw);
}

function candidateConfigs(flags) {
  const list = [];
  if (typeof flags.config === 'string') {
    list.push({ path: resolve(flags.config), source: 'flag:--config' });
  }
  for (const name of ['GITHUB_SEARCH_CONFIG', 'DSH_GITHUB_SEARCH_CONFIG']) {
    if (process.env[name]) {
      list.push({ path: resolve(process.env[name]), source: `env:${name}` });
    }
  }
  list.push({
    path: join(dshHome(), 'secrets', 'github-search.json'),
    source: `user:${join(dshHome(), 'secrets', 'github-search.json')}`,
  });
  list.push({
    path: join(BUNDLE, '.secrets', 'github-search.json'),
    source: `bundle:${join(BUNDLE, '.secrets', 'github-search.json')}`,
  });
  return list;
}

function mask(token) {
  if (!token) return '(none)';
  const t = String(token).trim();
  if (t.length <= 12) return `${t.slice(0, 3)}***`;
  return `${t.slice(0, 7)}…${t.slice(-4)}`;
}

function resolveCredentials(flags) {
  if (typeof flags.token === 'string') {
    return { token: flags.token.trim(), source: 'flag:--token', warning: 'token passed on the command line' };
  }

  if (typeof flags['token-file'] === 'string') {
    const p = resolve(flags['token-file']);
    const cfg = readJsonFile(p);
    if (!cfg.token) throw new Error(`no "token" key in ${p}`);
    return { token: String(cfg.token).trim(), source: `flag:--token-file ${p}`, config: cfg };
  }

  for (const cand of candidateConfigs(flags)) {
    if (!existsSync(cand.path)) continue;
    try {
      const cfg = readJsonFile(cand.path);
      if (cfg.token) {
        return { token: String(cfg.token).trim(), source: cand.source, config: cfg };
      }
    } catch (err) {
      process.stderr.write(`[warn] ignoring unreadable config ${cand.path}: ${err.message}\n`);
    }
  }

  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    if (process.env[name]) return { token: process.env[name].trim(), source: `env:${name}` };
  }

  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 15000 });
  if (gh.status === 0 && (gh.stdout || '').trim()) {
    return { token: gh.stdout.trim(), source: 'gh auth token' };
  }

  return { token: null, source: null };
}

function requireToken(flags) {
  const cred = resolveCredentials(flags);
  if (!cred.token) {
    process.stderr.write(
      [
        'No GitHub token found.',
        'Configure one of:',
        `  - ${join(dshHome(), 'secrets', 'github-search.json')}   (recommended, outside any git repo)`,
        `      {"token": "ghp_..."}`,
        `  - ${join(BUNDLE, '.secrets', 'github-search.json')}     (git-ignored bundle-local copy)`,
        '  - environment variable GITHUB_TOKEN or GH_TOKEN',
        '  - --token-file <path>',
        'See README.md in the skill bundle.',
      ].join('\n') + '\n',
    );
    process.exit(3);
  }
  return cred;
}

// ----------------------------------------------------------- transport

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ApiError extends Error {
  constructor(status, message, meta = {}) {
    super(message);
    this.status = status;
    Object.assign(this, meta);
  }
}

async function callApi(url, { token, maxWaitMs = 70000, noWait = false } = {}) {
  for (;;) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': DEFAULT_UA,
      },
      signal: AbortSignal.timeout(45000),
    });

    const h = res.headers;
    const rate = {
      limit: Number(h.get('x-ratelimit-limit') || 0),
      remaining: Number(h.get('x-ratelimit-remaining') || 0),
      reset: Number(h.get('x-ratelimit-reset') || 0),
      resource: h.get('x-ratelimit-resource') || '',
      retryAfter: Number(h.get('retry-after') || 0),
      scopes: h.get('x-oauth-scopes') || '',
    };

    if (res.status === 403 || res.status === 429) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        /* ignore */
      }
      const isPrimary = rate.remaining === 0 && rate.reset > 0;
      const waitMs = rate.retryAfter
        ? rate.retryAfter * 1000
        : isPrimary
          ? Math.max(0, rate.reset * 1000 - Date.now()) + 1000
          : 0;

      if (waitMs > 0 && !noWait && waitMs <= maxWaitMs) {
        process.stderr.write(`[rate] ${rate.resource} limit hit; waiting ${Math.ceil(waitMs / 1000)}s\n`);
        await sleep(waitMs);
        continue;
      }

      const hint = isPrimary
        ? `search API allows ${rate.limit || 30} requests/minute; retry in ${Math.ceil(waitMs / 1000)}s`
        : 'secondary rate limit or insufficient token scope';
      throw new ApiError(res.status, `HTTP 403 from GitHub — ${hint}`, { rate, body: body.slice(0, 400) });
    }

    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, `HTTP ${res.status} from GitHub`, { rate, body: body.slice(0, 400) });
    }

    const data = await res.json();
    return { data, rate, status: res.status };
  }
}

// ------------------------------------------------------------ output

function rateLine(rate) {
  if (!rate || !rate.resource) return '';
  const secs = rate.reset ? Math.max(0, Math.round(rate.reset - Date.now() / 1000)) : 0;
  return `[rate] ${rate.resource} ${rate.remaining}/${rate.limit} reset in ${secs}s`;
}

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function printRepos(data) {
  console.log(`total_count: ${data.total_count}  (showing ${data.items.length})`);
  for (const r of data.items) {
    console.log(
      `- ${r.full_name}  ★${r.stargazers_count}  fork=${r.forks_count}  ${r.language || 'n/a'}  updated ${(r.updated_at || '').slice(0, 10)}\n    ${truncate(r.description, 140)}\n    ${r.html_url}`,
    );
  }
}

function printCode(data) {
  console.log(`total_count: ${data.total_count}  (showing ${data.items.length})`);
  for (const f of data.items) {
    console.log(`- ${f.repository.full_name}  ${f.path}\n    ${f.html_url}`);
  }
}

function printIssues(data) {
  console.log(`total_count: ${data.total_count}  (showing ${data.items.length})`);
  for (const i of data.items) {
    const repo = (i.repository_url || '').replace('https://api.github.com/repos/', '');
    const kind = i.pull_request ? 'PR' : 'issue';
    console.log(`- ${repo}#${i.number} [${i.state}] (${kind}) ${truncate(i.title, 120)}\n    ${i.html_url}`);
  }
}

function printCommits(data) {
  console.log(`total_count: ${data.total_count}  (showing ${data.items.length})`);
  for (const c of data.items) {
    const repo = (c.repository?.full_name) || '?';
    console.log(`- ${repo} ${(c.sha || '').slice(0, 8)} ${truncate(c.commit?.message, 110)}\n    ${c.html_url}`);
  }
}

function printUsers(data) {
  console.log(`total_count: ${data.total_count}  (showing ${data.items.length})`);
  for (const u of data.items) {
    console.log(`- ${u.login}  ${u.type}  ${u.html_url}`);
  }
}

const PER_PAGE_MAX = 100;

function buildUrl(base, path, params) {
  const url = new URL(path.startsWith('http') ? path : `${base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

// -------------------------------------------------------------- main

const HELP = `github-search — GitHub REST search client

Usage:
  node scripts/gh-search.mjs <command> [query] [flags]

Commands:
  check                            validate the token, print scopes and rate limits
  config                           show which credential source is in use (masked)
  limit                            print current rate-limit buckets
  repo   <query>                   search repositories
  code   <query>                   search code (exact file contents, qualifiers supported)
  issues <query>                   search issues and pull requests
  commits <query>                  search commits
  users  <query>                   search users and organizations
  api    <path>                    call any REST path, e.g. "repos/nodejs/node"

Flags:
  --limit <n>        results to return (default 10, max 100)
  --sort <field>     repo: stars|forks|updated|help-wanted-issues ; issues: created|updated|comments
  --order <dir>      asc|desc (default desc)
  --state <s>        issues: open|closed
  --param k=v        extra query parameter for "api" (repeatable)
  --json             print the raw JSON payload
  --token-file <p>   credential file to use
  --config <p>       JSON config to use
  --no-wait          fail instead of waiting out a rate limit
  --max-wait <sec>   cap on automatic waiting (default 70)

Query qualifiers: see references/search-syntax.md
Examples:
  node scripts/gh-search.mjs repo "agent framework language:python stars:>1000" --limit 5
  node scripts/gh-search.mjs code "repo:torvalds/linux define MAX_ORDER"
  node scripts/gh-search.mjs issues "repo:microsoft/vscode is:open label:bug" --limit 5
  node scripts/gh-search.mjs api repos/ptb-xiaou --param per_page=5
`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const query = positional[1];
  const limit = Math.min(num(flags.limit, 10), PER_PAGE_MAX);
  const noWait = flags['no-wait'] === true;
  const maxWaitMs = num(flags['max-wait'], 70) * 1000;
  const asJson = flags.json === true;

  if (!cmd || cmd === 'help' || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  if (cmd === 'config' || cmd === 'where') {
    const active = resolveCredentials(flags);
    console.log(`active source : ${active.source || '(none)'}`);
    console.log(`active token  : ${mask(active.token)}`);
    console.log('candidates    :');
    for (const c of candidateConfigs(flags)) {
      console.log(`  ${existsSync(c.path) ? 'present' : 'missing'}  ${c.path}  [${c.source}]`);
    }
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_SEARCH_CONFIG', 'DSH_GITHUB_SEARCH_CONFIG']) {
      console.log(`  env ${name}: ${process.env[name] ? 'set' : 'unset'}`);
    }
    return;
  }

  const cred = requireToken(flags);
  const base = cred.config?.apiBase || process.env.GITHUB_API_BASE || DEFAULT_API;

  if (cmd === 'check') {
    const [me, limits] = await Promise.all([
      callApi(`${base}/user`, { token: cred.token }),
      callApi(`${base}/rate_limit`, { token: cred.token }),
    ]);
    console.log(`token source : ${cred.source}`);
    console.log(`token        : ${mask(cred.token)}`);
    if (cred.warning) console.log(`warning      : ${cred.warning}`);
    console.log(`login        : ${me.data.login} (${me.data.type})`);
    console.log(`scopes       : ${me.rate.scopes || '(none)'}`);
    if ((me.rate.scopes || '').split(',').map((s) => s.trim()).includes('repo')) {
      console.log('note         : "repo" scope grants read/write access to all your private repositories.');
    }
    console.log(`core         : ${limits.data.resources.core.remaining}/${limits.data.resources.core.limit}`);
    console.log(`search       : ${limits.data.resources.search.remaining}/${limits.data.resources.search.limit} per minute`);
    return;
  }

  if (cmd === 'limit') {
    const { data } = await callApi(`${base}/rate_limit`, { token: cred.token });
    if (asJson) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    for (const [name, r] of Object.entries(data.resources)) {
      console.log(`${name.padEnd(16)} ${r.remaining}/${r.limit}  resets in ${Math.max(0, r.reset - Math.round(Date.now() / 1000))}s`);
    }
    return;
  }

  let path;
  let params = {};
  let render = null;

  switch (cmd) {
    case 'repo':
    case 'repos': {
      if (!query) throw new Error('repo requires a query');
      path = '/search/repositories';
      params = {
        q: query,
        per_page: limit,
        sort: flags.sort || undefined,
        order: flags.order || (flags.sort ? 'desc' : undefined),
      };
      render = printRepos;
      break;
    }
    case 'code': {
      if (!query) throw new Error('code requires a query');
      path = '/search/code';
      params = { q: query, per_page: limit, sort: flags.sort || undefined, order: flags.order || undefined };
      render = printCode;
      break;
    }
    case 'issues': {
      if (!query) throw new Error('issues requires a query');
      path = '/search/issues';
      params = {
        q: query,
        per_page: limit,
        sort: flags.sort || undefined,
        order: flags.order || (flags.sort ? 'desc' : undefined),
      };
      render = printIssues;
      break;
    }
    case 'commits': {
      if (!query) throw new Error('commits requires a query');
      path = '/search/commits';
      params = { q: query, per_page: limit, sort: flags.sort || undefined, order: flags.order || undefined };
      render = printCommits;
      break;
    }
    case 'users': {
      if (!query) throw new Error('users requires a query');
      path = '/search/users';
      params = { q: query, per_page: limit, sort: flags.sort || undefined, order: flags.order || undefined };
      render = printUsers;
      break;
    }
    case 'api': {
      if (!query) throw new Error('api requires a path, e.g. "repos/nodejs/node"');
      path = query.startsWith('/') ? query : `/${query}`;
      for (const kv of flags.param || []) {
        const idx = String(kv).indexOf('=');
        if (idx === -1) throw new Error(`--param expects k=v, got ${kv}`);
        params[String(kv).slice(0, idx)] = String(kv).slice(idx + 1);
      }
      break;
    }
    default:
      throw new Error(`unknown command "${cmd}" — run with --help`);
  }

  const { data, rate } = await callApi(buildUrl(base, path, params), {
    token: cred.token,
    noWait,
    maxWaitMs,
  });

  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
  } else if (render) {
    render(data);
  } else {
    console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }

  const rl = rateLine(rate);
  if (rl) process.stderr.write(`${rl}\n`);
}

main().catch((err) => {
  if (err instanceof ApiError) {
    process.stderr.write(`error: ${err.message}\n`);
    if (err.body) process.stderr.write(`detail: ${err.body}\n`);
    const rl = rateLine(err.rate);
    if (rl) process.stderr.write(`${rl}\n`);
    process.exit(1);
  }
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
