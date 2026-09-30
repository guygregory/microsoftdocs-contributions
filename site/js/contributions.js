import { ApiError, checkAbort } from "./github-api.js";

export const ORGANISATION = "MicrosoftDocs";
const MAX_SEARCH = 1000;
const PAGE_SIZE = 100;
const MAX_ATTEMPTS = 3;

export function normalizeUsername(value) {
  const username = value.trim().replace(/^@/, "").trim();
  if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(username)) {
    throw new ApiError("Enter a GitHub username: 1-39 letters, numbers or single hyphens, with no hyphen at either end.",
      { kind: "validation" });
  }
  return username;
}

export function utcTimestamp(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|\+00:00)$/.test(value)) {
    throw new ApiError("GitHub returned an invalid UTC date.", { kind: "protocol" });
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new ApiError("GitHub returned an invalid UTC date.", { kind: "protocol" });
  }
  return timestamp;
}

export function safeGithubUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new ApiError("GitHub returned an invalid link.", { kind: "protocol" });
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" ||
      url.username || url.password || url.port || url.search || url.hash) {
    throw new ApiError("GitHub returned an unsafe link.", { kind: "protocol" });
  }
  return url.href;
}

export function normalizeRow(item) {
  if (!item || typeof item !== "object") {
    throw new ApiError("GitHub returned an invalid search item.", { kind: "protocol" });
  }
  if (!item.pull_request) return null;
  const match = typeof item.repository_url === "string" &&
    /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([a-z\d_.-]+)$/i.exec(item.repository_url);
  if (!match) throw new ApiError("GitHub returned an invalid repository.", { kind: "protocol" });
  if (match[1].toLowerCase() !== ORGANISATION.toLowerCase()) return null;
  if (!Number.isSafeInteger(item.id) || item.id <= 0 ||
      !Number.isSafeInteger(item.number) || item.number <= 0 || typeof item.title !== "string") {
    throw new ApiError("GitHub returned invalid pull-request fields.", { kind: "protocol" });
  }
  const repository = `${ORGANISATION}/${match[2]}`;
  const url = safeGithubUrl(item.html_url);
  if (new URL(url).pathname.toLowerCase() !== `/${repository}/pull/${item.number}`.toLowerCase()) {
    throw new ApiError("GitHub returned a mismatched pull-request link.", { kind: "protocol" });
  }
  const created = utcTimestamp(item.created_at);
  return {
    id: item.id, number: item.number, title: item.title, repository,
    repositoryUrl: safeGithubUrl(`https://github.com/${repository}`),
    url, created, date: new Date(created).toISOString().slice(0, 10)
  };
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => b.created - a.created || b.id - a.id);
}

function searchDate(seconds) {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "+00:00");
}

export function searchPath(username, { start, end, repo }, page = 1) {
  const scope = repo ? `repo:${repo}` : `org:${ORGANISATION}`;
  const query = `author:${username} ${scope} is:pr created:${searchDate(start)}..${searchDate(end)}`;
  const params = new URLSearchParams({
    q: query, sort: "created", order: "desc", per_page: String(PAGE_SIZE), page: String(page)
  });
  return `/search/issues?${params}`;
}

export class ContributionsRun {
  constructor(api, { now = Date.now, maxJobs = 20_000 } = {}) {
    this.api = api;
    this.now = now;
    this.maxJobs = maxJobs;
  }

  async retrieve(input, { signal, onProgress = () => {}, onStatus = () => {} } = {}) {
    const username = normalizeUsername(input);
    const cutoff = Math.floor(this.now() / 1000);
    const request = (path, bucket = "core") => this.api.request(path, { bucket, signal, onStatus });
    let user;
    try { user = await request(`/users/${encodeURIComponent(username)}`); } catch (error) {
      if (error.kind === "not-found") {
        throw new ApiError(`The public GitHub account @${username} was not found.`, { kind: "account", status: 404 });
      }
      throw error;
    }
    const start = Math.floor(utcTimestamp(user?.created_at) / 86_400_000) * 86_400;
    if (start > cutoff) throw new ApiError("The account creation date is after the retrieval cutoff.", { kind: "protocol" });
    const org = await request(`/orgs/${ORGANISATION}`);
    if (!Number.isSafeInteger(org?.public_repos) || org.public_repos < 0) {
      throw new ApiError("GitHub did not provide the organisation's public repository count.", { kind: "protocol" });
    }
    const committed = new Map();
    const provisional = new Map();
    let completed = 0;
    let expected = 0;
    let repositories = null;
    let jobs = 0;
    const rows = () => sortRows(new Map([...provisional, ...committed]).values());
    const publish = () => {
      checkAbort(signal);
      onProgress({ rows: rows(), completed, cutoff: new Date(cutoff * 1000).toISOString(), username });
    };
    const inJob = (row, job) => row.created >= job.start * 1000 &&
      row.created < (job.end + 1) * 1000 &&
      (!job.repo || row.repository.toLowerCase() === job.repo.toLowerCase());
    const remember = (items, job, target) => {
      for (const item of items) {
        const row = normalizeRow(item);
        if (row && inJob(row, job)) {
          target.set(row.id, row);
          provisional.set(row.id, row);
        }
      }
      publish();
    };
    const listRepositories = async () => {
      if (repositories) return repositories;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const names = new Set();
        for (let page = 1; ; page++) {
          const items = await request(`/orgs/${ORGANISATION}/repos?type=public&per_page=100&page=${page}`);
          if (!Array.isArray(items)) throw new ApiError("GitHub returned an invalid repository list.", { kind: "protocol" });
          for (const repo of items) {
            if (!repo || repo.private !== false || typeof repo.owner?.login !== "string" ||
                repo.owner.login.toLowerCase() !== ORGANISATION.toLowerCase() ||
                typeof repo.name !== "string" || !/^[a-z\d_.-]+$/i.test(repo.name)) {
              throw new ApiError("GitHub returned an unexpected public repository.", { kind: "protocol" });
            }
            names.add(`${ORGANISATION}/${repo.name}`);
          }
          if (items.length < PAGE_SIZE) break;
          if (page > Math.ceil(org.public_repos / PAGE_SIZE) + 1) {
            throw new ApiError("The public repository list changed during retrieval.", { kind: "partial" });
          }
        }
        const latest = await request(`/orgs/${ORGANISATION}`);
        if (names.size === latest?.public_repos) {
          repositories = [...names].sort();
          return repositories;
        }
      }
      throw new ApiError("The public repository list could not be reconciled. Coverage is unresolved.", { kind: "partial" });
    };
    const base = { start, end: cutoff };
    const stack = [];
    const addRepositories = async job => {
      const names = await listRepositories();
      for (const repo of [...names].reverse()) stack.push({ ...job, repo });
    };
    if (org.public_repos > 4000) {
      onStatus({ state: "loading", message: "Enumerating public repositories to avoid GitHub's 4,000-repository search scope limit." });
      await addRepositories(base);
    } else {
      stack.push(base);
    }
    while (stack.length) {
      checkAbort(signal);
      if (++jobs > this.maxJobs) {
        throw new ApiError("Retrieval exceeded its safety bound. Some intervals remain unresolved.", { kind: "partial" });
      }
      const job = stack.pop();
      let accepted = null;
      let split = false;
      let failure = "Search results changed during pagination.";
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const found = new Map();
        const first = await request(searchPath(username, job), "search");
        const validate = data => {
          if (!data || !Number.isSafeInteger(data.total_count) || data.total_count < 0 ||
              typeof data.incomplete_results !== "boolean" || !Array.isArray(data.items)) {
            throw new ApiError("GitHub returned an invalid search response.", { kind: "protocol" });
          }
        };
        validate(first);
        remember(first.items, job, found);
        if (first.total_count > MAX_SEARCH) {
          split = true;
          break;
        }
        let incomplete = first.incomplete_results;
        let unstable = first.items.length !== Math.min(PAGE_SIZE, first.total_count);
        if (!incomplete && !unstable) {
          for (let page = 2; page <= Math.ceil(first.total_count / PAGE_SIZE); page++) {
            const data = await request(searchPath(username, job, page), "search");
            validate(data);
            remember(data.items, job, found);
            incomplete = data.incomplete_results;
            unstable = data.total_count !== first.total_count ||
              data.items.length !== Math.min(PAGE_SIZE, first.total_count - (page - 1) * PAGE_SIZE);
            if (incomplete || unstable) break;
          }
        }
        if (!incomplete && !unstable && found.size === first.total_count) {
          accepted = found;
          break;
        }
        failure = incomplete ? "GitHub repeatedly returned incomplete search results."
          : "Search counts or unique rows changed during pagination.";
        if (incomplete && attempt === MAX_ATTEMPTS - 1) split = true;
      }
      if (accepted) {
        for (const [id, row] of provisional) if (inJob(row, job)) provisional.delete(id);
        for (const [id, row] of accepted) committed.set(id, row);
        expected += accepted.size;
        completed++;
        publish();
      } else if (split) {
        if (job.start < job.end) {
          const midpoint = job.start + Math.floor((job.end - job.start) / 2);
          stack.push({ ...job, end: midpoint }, { ...job, start: midpoint + 1 });
        } else if (!job.repo) {
          await addRepositories(job);
        } else {
          throw new ApiError("A single repository/second still exceeds 1,000 results or is incomplete. Coverage is unresolved.",
            { kind: "partial" });
        }
      } else {
        throw new ApiError(`${failure} Coverage is unresolved after ${MAX_ATTEMPTS} attempts.`, { kind: "partial" });
      }
    }
    if (committed.size !== expected || provisional.size !== 0) {
      throw new ApiError("Unique totals could not be reconciled across search intervals. Coverage is unresolved.", { kind: "partial" });
    }
    checkAbort(signal);
    return {
      rows: sortRows(committed.values()), username, completed,
      cutoff: new Date(cutoff * 1000).toISOString(),
      retrievedAt: new Date(this.now()).toISOString()
    };
  }
}
