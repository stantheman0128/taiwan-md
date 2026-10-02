import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Lang } from '../types';

export interface ChangelogArticle {
  url: string;
  name: string;
}

export interface Commit {
  hash: string;
  date: string;
  message: string;
  author?: string;
  /** #1143: zh-TW source articles this commit touched, so readers can jump
   *  straight to the changed page instead of a GitHub commit diff. Empty for
   *  non-article commits (memory / routine / infra). */
  articles?: ChangelogArticle[];
}

export interface CommitFeed {
  commits: Commit[];
  source: 'git' | 'cache' | 'github' | 'none';
}

interface CommitCache {
  generatedAt?: string;
  source?: string;
  commits?: Commit[];
}

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CACHE_PATH = fileURLToPath(
  new URL('../data/changelog-feed.json', import.meta.url),
);

function parseCommitMessage(message: string): string {
  return message.trim().split('\n')[0];
}

// #1143: map a commit's changed files → the zh-TW source articles it touched.
//   knowledge/{Capitalized-Category}/{slug}.md  →  /{category-lower}/{slug}
// The [A-Z] anchor naturally excludes lowercase lang dirs (en/ja/ko/es/fr)
// and _*.json, so only zh-TW source-article changes produce a link.
const ARTICLE_RE = /^knowledge\/([A-Z][A-Za-z]*)\/([^/]+)\.md$/;
const MAX_ARTICLES_PER_COMMIT = 4;

// Only link articles that still have a page: history has deleted / renamed
// files and _*.md hubs, which would be dead links on /changelog (same rule as
// scripts/core/generate-changelog-data.js).
const existsCache = new Map<string, boolean>();
function articleExists(cat: string, slug: string): boolean {
  if (slug.startsWith('_')) return false;
  const key = `${cat}/${slug}`;
  let hit = existsCache.get(key);
  if (hit === undefined) {
    hit = existsSync(join(PROJECT_ROOT, 'knowledge', cat, `${slug}.md`));
    existsCache.set(key, hit);
  }
  return hit;
}

function filesToArticles(files: string[]): ChangelogArticle[] {
  const seen = new Set<string>();
  const out: ChangelogArticle[] = [];
  for (const file of files) {
    const m = ARTICLE_RE.exec(file);
    if (!m || !articleExists(m[1], m[2])) continue;
    const url = `/${m[1].toLowerCase()}/${m[2]}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, name: m[2] });
    if (out.length >= MAX_ARTICLES_PER_COMMIT) break;
  }
  return out;
}

function dedupeAndTrim(commits: Commit[], limit: number): Commit[] {
  const seen = new Set<string>();

  return commits
    .map((commit) => ({
      ...commit,
      message: parseCommitMessage(commit.message),
    }))
    .filter((commit) => {
      if (!commit.hash || !commit.date || !commit.message) return false;
      if (seen.has(commit.hash)) return false;
      seen.add(commit.hash);
      return true;
    })
    .slice(0, limit);
}

function getCommitsFromGit(limit = 100): Commit[] {
  try {
    // %x1e (RS) starts each commit record; %x1f (US) separates meta fields;
    // --name-only appends changed files (one per line) after the meta line.
    // core.quotepath=false: git's default quotes and octal-escapes Chinese
    // paths, so ARTICLE_RE would miss most articles (same fix as
    // scripts/core/generate-changelog-data.js). No shell, so cmd.exe can't
    // reinterpret the %-format either.
    const raw = execFileSync(
      'git',
      [
        '-c',
        'core.quotepath=false',
        'log',
        '-n',
        String(Math.max(limit, 1)),
        '--date=iso-strict',
        '--name-only',
        '--pretty=format:%x1e%H%x1f%aI%x1f%an%x1f%s',
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();

    if (!raw) return [];

    return raw
      .split('\x1e')
      .map((block) => {
        const lines = block.split('\n');
        const [hash, date, author, message] = (lines[0] || '').split('\x1f');
        if (!hash || !date || !message) return null;
        const files = lines.slice(1).filter(Boolean);
        return {
          hash,
          date,
          author,
          message,
          articles: filesToArticles(files),
        };
      })
      .filter(Boolean) as Commit[];
  } catch {
    return [];
  }
}

function getCommitsFromCache(limit = 100): Commit[] {
  try {
    const raw = readFileSync(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as CommitCache;

    if (!Array.isArray(parsed.commits)) return [];
    return parsed.commits
      .map((commit) => {
        if (!commit?.hash || !commit?.date || !commit?.message) return null;
        return {
          hash: commit.hash,
          date: commit.date,
          author: commit.author,
          message: commit.message,
          articles: commit.articles,
        };
      })
      .filter(Boolean)
      .slice(0, limit) as Commit[];
  } catch {
    return [];
  }
}

async function getCommitsFromGitHub(limit = 100): Promise<Commit[]> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/frank890417/taiwan-md/commits?per_page=${Math.max(limit, 1)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'taiwan-md-commits',
        },
      },
    );

    if (!res.ok) return [];

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data
      .map((commit: any): Commit | null => {
        const hash = commit?.sha;
        const date = commit?.commit?.author?.date;
        const author = commit?.commit?.author?.name;
        const message = commit?.commit?.message;
        if (!hash || !date || !message) return null;
        return { hash, date, author, message };
      })
      .filter((commit): commit is Commit => commit !== null);
  } catch {
    return [];
  }
}

export async function fetchCommitFeed(limit = 100): Promise<CommitFeed> {
  const gitCommits = dedupeAndTrim(getCommitsFromGit(limit), limit);
  if (gitCommits.length) {
    return { commits: gitCommits, source: 'git' };
  }

  const cachedCommits = dedupeAndTrim(getCommitsFromCache(limit), limit);
  if (cachedCommits.length) {
    return { commits: cachedCommits, source: 'cache' };
  }

  const githubCommits = dedupeAndTrim(await getCommitsFromGitHub(limit), limit);
  if (githubCommits.length) {
    return { commits: githubCommits, source: 'github' };
  }

  return { commits: [], source: 'none' };
}

export async function fetchRecentCommits(perPage = 5): Promise<Commit[]> {
  return (await fetchCommitFeed(perPage)).commits;
}

export function commitIcon(message: string): string {
  const normalized = message
    .toLowerCase()
    .replace(/^🧬\s*\[semiont\]\s*/i, '')
    .trim();

  if (normalized.startsWith('rewrite')) return '✍️';
  if (normalized.startsWith('evolve')) return '🧬';
  if (
    normalized.startsWith('translate(') ||
    normalized.startsWith('add japanese translation') ||
    normalized.startsWith('add korean translation') ||
    normalized.startsWith('add english translation') ||
    normalized.startsWith('add spanish translation')
  ) {
    return '🌐';
  }
  if (normalized.startsWith('feat')) return '✨';
  if (normalized.startsWith('fix')) return '🐛';
  if (normalized.startsWith('content')) return '📝';
  if (normalized.startsWith('docs')) return '📖';
  if (normalized.startsWith('style')) return '🎨';
  if (normalized.startsWith('refactor')) return '♻️';
  if (normalized.startsWith('chore')) return '🔧';
  if (normalized.startsWith('merge')) return '🔀';
  return '📌';
}

export type CommitType =
  | 'rewrite'
  | 'evolve'
  | 'translate'
  | 'feat'
  | 'fix'
  | 'content'
  | 'merge'
  | 'maintenance'
  | 'other';

export function commitType(message: string): CommitType {
  const normalized = message
    .toLowerCase()
    .replace(/^🧬\s*\[semiont\]\s*/i, '')
    .trim();

  if (normalized.startsWith('rewrite')) return 'rewrite';
  if (normalized.startsWith('evolve')) return 'evolve';
  if (
    normalized.startsWith('translate(') ||
    normalized.startsWith('add japanese translation') ||
    normalized.startsWith('add korean translation') ||
    normalized.startsWith('add english translation') ||
    normalized.startsWith('add spanish translation')
  )
    return 'translate';
  if (normalized.startsWith('feat')) return 'feat';
  if (normalized.startsWith('fix')) return 'fix';
  if (normalized.startsWith('content')) return 'content';
  if (normalized.startsWith('merge')) return 'merge';
  if (
    normalized.startsWith('chore') ||
    normalized.startsWith('heal') ||
    normalized.startsWith('immune') ||
    normalized.startsWith('memory') ||
    normalized.startsWith('diagnose') ||
    normalized.startsWith('docs') ||
    normalized.startsWith('style') ||
    normalized.startsWith('refactor') ||
    normalized.startsWith('ingest')
  )
    return 'maintenance';
  return 'other';
}

export function timeAgo(dateStr: string, lang: Lang): string {
  const now = new Date();
  const then = new Date(dateStr);
  const diff = Math.floor((now.getTime() - then.getTime()) / 1000);

  if (lang === 'zh-TW') {
    if (diff < 60) return '剛剛';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小時前`;
    if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`;
    return then.toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' });
  }

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
