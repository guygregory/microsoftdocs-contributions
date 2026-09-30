import test from "node:test";
import assert from "node:assert/strict";
import {
  ContributionsRun, normalizeUsername, normalizeRow, utcTimestamp, safeGithubUrl, sortRows, searchPath
} from "../site/js/contributions.js";
import { START, pr, fakeApi } from "./helpers.js";

const now = () => START + 86_400_000 * 4;
const retrieve = (api, options) => new ContributionsRun(api, { now }).retrieve("tester", options);

test("username normalization and conventional validation", () => {
  for (const [input, expected] of [["  @guygregory  ", "guygregory"], [" @ tester ", "tester"], ["a-b", "a-b"], ["A".repeat(39), "A".repeat(39)]]) {
    assert.equal(normalizeUsername(input), expected);
  }
  for (const input of ["", "a b", "@@user", "-abc", "abc-", "a--b", "a_b", "x".repeat(40), "user org:evil", "<script>"]) {
    assert.throws(() => normalizeUsername(input), /GitHub username/);
  }
});

for (const count of [0, 100, 101, 1000, 1001, 7103]) {
  test(`retrieves and reconciles ${count} PRs across all dates`, async () => {
    const items = Array.from({ length: count }, (_, index) => pr(index + 1));
    const api = fakeApi(items);
    const result = await retrieve(api);
    assert.equal(result.rows.length, count);
    assert.deepEqual(result.rows.map(row => row.id), items.map(item => item.id).reverse());
    const searches = api.calls.filter(path => path.startsWith("/search/"));
    for (const path of searches) {
      const url = new URL(path, "https://api.github.com");
      const query = url.searchParams.get("q");
      assert.match(query, /^author:tester org:MicrosoftDocs is:pr created:/);
      assert.equal(url.searchParams.get("sort"), "created");
      assert.equal(url.searchParams.get("order"), "desc");
      assert.equal(url.searchParams.get("per_page"), "100");
      assert.ok(Number(url.searchParams.get("page")) <= 10);
    }
    if (count <= 1000) assert.equal(searches.length, Math.max(1, Math.ceil(count / 100)));
    if (count > 1000) assert.ok(result.completed > 1);
    assert.equal(result.cutoff, "2024-03-04T00:00:00.000Z");
  });
}

test("includes draft/open/merged/closed PRs but never issues or another organisation", async () => {
  const items = [
    pr(1, { state: "open", draft: true }), pr(2, { state: "open" }),
    pr(3, { state: "closed", pull_request: { merged_at: "2024-03-01T00:00:00Z" } }),
    pr(4, { state: "closed" }),
    pr(5, { pull_request: undefined }),
    pr(6, { repository_url: "https://api.github.com/repos/Other/docs" })
  ];
  assert.deepEqual((await retrieve(fakeApi(items))).rows.map(row => row.id), [4, 3, 2, 1]);
  assert.equal(normalizeRow(items[4], "tester"), null);
  assert.equal(normalizeRow(items[5], "tester"), null);
});

test("server author search is authoritative for associated Copilot-created PRs", async () => {
  const item = pr(1, { user: { login: "Copilot" } });
  assert.equal(normalizeRow(item).id, 1);
  assert.equal((await retrieve(fakeApi([item]))).rows.length, 1);
});

test("UTC inclusive boundaries, leap day, same-second stable ordering, fixed cutoff", async () => {
  const cutoff = START + 1000;
  const items = [
    pr(1, { created: START - 1000 }), pr(2, { created: START }),
    pr(3, { created: cutoff }), pr(4, { created: cutoff }), pr(5, { created: cutoff + 1000 })
  ];
  const run = new ContributionsRun(fakeApi(items, { createdAt: "2024-02-29T19:00:00Z" }), { now: () => cutoff + 999 });
  const result = await run.retrieve("tester");
  assert.deepEqual(result.rows.map(row => row.id), [4, 3, 2]);
  assert.equal(result.rows[2].date, "2024-02-29");
  const path = searchPath("tester", { start: START / 1000, end: cutoff / 1000 });
  assert.match(path, /%2B00%3A00/);
  assert.match(new URL(path, "https://api.github.com").searchParams.get("q"), /2024-02-29T00:00:00\+00:00/);
});

test("partitions with midpoint + 1 second without losing boundary PRs", async () => {
  const items = Array.from({ length: 1001 }, (_, index) => pr(index + 1, { created: START + (index % 2) * 1000 }));
  const api = fakeApi(items);
  const result = await new ContributionsRun(api, { now: () => START + 1000 }).retrieve("tester");
  assert.equal(result.rows.length, 1001);
  const queries = api.calls.filter(path => path.startsWith("/search/"))
    .map(path => new URL(path, "https://api.github.com").searchParams.get("q"));
  assert.ok(queries.some(query => query.endsWith("2024-02-29T00:00:00+00:00..2024-02-29T00:00:00+00:00")));
  assert.ok(queries.some(query => query.endsWith("2024-02-29T00:00:01+00:00..2024-02-29T00:00:01+00:00")));
});

test("deduplicates repeated IDs and retries rather than returning a false complete count", async () => {
  const items = Array.from({ length: 101 }, (_, index) => pr(index + 1));
  let repeated = false;
  const api = fakeApi(items, { transform(data, url) {
    if (url.pathname === "/search/issues" && url.searchParams.get("page") === "2" && !repeated) {
      repeated = true;
      return { ...data, items: [items[100]] };
    }
    return data;
  } });
  const result = await retrieve(api);
  assert.equal(result.rows.length, 101);
  assert.equal(api.calls.filter(path => path.endsWith("&page=1")).length, 2);
});

for (const page of [1, 2]) {
  test(`retries incomplete results on page ${page}, keeping loaded rows`, async () => {
    const items = Array.from({ length: 101 }, (_, index) => pr(index + 1));
    let incomplete = true;
    const snapshots = [];
    const api = fakeApi(items, { transform(data, url) {
      if (url.pathname === "/search/issues" && url.searchParams.get("page") === String(page) && incomplete) {
        incomplete = false;
        return { ...data, incomplete_results: true };
      }
      return data;
    } });
    const result = await retrieve(api, { onProgress: progress => snapshots.push(progress.rows.length) });
    assert.equal(result.rows.length, 101);
    assert.ok(snapshots.includes(100));
    assert.equal(api.calls.filter(path => path.endsWith("&page=1")).length, 2);
  });
}

test("persistent incomplete first page subdivides, including when count is zero", async () => {
  let firstAttempts = 0;
  const api = fakeApi([pr(1)], { transform(data, url) {
    if (url.pathname === "/search/issues" && url.searchParams.get("q").endsWith("2024-03-04T00:00:00+00:00") &&
        url.searchParams.get("q").includes("created:2024-02-29T00:00:00+00:00..") && firstAttempts++ < 3) {
      return { total_count: 0, incomplete_results: true, items: [] };
    }
    return data;
  } });
  const result = await retrieve(api);
  assert.equal(result.rows.length, 1);
  assert.ok(result.completed >= 2);
});

test("persistent incomplete later page subdivides rather than ignoring the flag", async () => {
  const items = Array.from({ length: 101 }, (_, index) => pr(index + 1, { created: START + (index % 2) * 1000 }));
  const api = fakeApi(items, { transform(data, url) {
    if (url.pathname === "/search/issues" && url.searchParams.get("page") === "2") return { ...data, incomplete_results: true };
    return data;
  } });
  const result = await new ContributionsRun(api, { now: () => START + 1000 }).retrieve("tester");
  assert.equal(result.rows.length, 101);
  assert.equal(result.completed, 2);
});

test("changing counts recover on bounded retry", async () => {
  const items = Array.from({ length: 101 }, (_, index) => pr(index + 1));
  let drift = true;
  const api = fakeApi(items, { transform(data, url) {
    if (url.pathname === "/search/issues" && url.searchParams.get("page") === "2" && drift) {
      drift = false;
      return { ...data, total_count: 102 };
    }
    return data;
  } });
  assert.equal((await retrieve(api)).rows.length, 101);
});

test("persistent pagination/count instability fails explicitly with deduplicated partial rows", async () => {
  const items = Array.from({ length: 101 }, (_, index) => pr(index + 1));
  const api = fakeApi(items, { transform(data, url) {
    return url.pathname === "/search/issues" && url.searchParams.get("page") === "2"
      ? { ...data, total_count: 102 } : data;
  } });
  let loaded;
  await assert.rejects(retrieve(api, { onProgress: progress => { loaded = progress.rows; } }), /unresolved after 3 attempts/);
  assert.equal(loaded.length, 101);
  assert.equal(api.calls.filter(path => path.endsWith("&page=1")).length, 3);
});

test("single-second overflow enumerates repositories and retrieves repo-scoped searches", async () => {
  const items = Array.from({ length: 1001 }, (_, index) => pr(index + 1, {
    created: START, repo: index % 2 ? "a" : "b"
  }));
  const api = fakeApi(items, { publicRepos: 2, repos: ["a", "b"] });
  const result = await new ContributionsRun(api, { now: () => START }).retrieve("tester");
  assert.equal(result.rows.length, 1001);
  assert.ok(api.calls.some(path => decodeURIComponent(path).includes("repo:MicrosoftDocs/a")));
  assert.equal(api.calls.filter(path => path.startsWith("/orgs/MicrosoftDocs/repos")).length, 1);
});

for (const mode of ["overflow", "incomplete"]) {
  test(`unsplittable repository/second ${mode} fails with unresolved partial coverage`, async () => {
    const items = Array.from({ length: mode === "overflow" ? 1001 : 1 }, (_, index) => pr(index + 1, { created: START }));
    const api = fakeApi(items, { transform(data, url) {
      return mode === "incomplete" && url.pathname === "/search/issues" ? { ...data, incomplete_results: true } : data;
    } });
    await assert.rejects(new ContributionsRun(api, { now: () => START }).retrieve("tester"), /single repository\/second/);
  });
}

test("organisation with over 4,000 public repositories is never searched org-wide", async () => {
  const repos = Array.from({ length: 4001 }, (_, index) => `repo-${index}`);
  const api = fakeApi([pr(1, { repo: "repo-4000" })], { publicRepos: repos.length, repos });
  const result = await retrieve(api);
  assert.equal(result.rows.length, 1);
  assert.equal(result.completed, 4001);
  assert.equal(api.calls.filter(path => path.startsWith("/orgs/MicrosoftDocs/repos")).length, 41);
  assert.ok(api.calls.filter(path => path.startsWith("/search/"))
    .every(path => new URL(path, "https://api.github.com").searchParams.get("q").includes("repo:MicrosoftDocs/")));
});

test("repository enumeration drift retries then fails instead of claiming org coverage", async () => {
  const api = fakeApi([], { publicRepos: 4001, repos: ["docs"] });
  await assert.rejects(retrieve(api), /repository list could not be reconciled/);
  assert.equal(api.calls.filter(path => path.startsWith("/orgs/MicrosoftDocs/repos")).length, 3);
});

test("missing account is distinct from an empty existing account", async () => {
  const api = fakeApi([], { transform(data, url) {
    if (url.pathname.startsWith("/users/")) throw Object.assign(new Error("not found"), { kind: "not-found" });
    return data;
  } });
  await assert.rejects(retrieve(api), error => error.kind === "account" && /@tester was not found/.test(error.message));
  assert.equal(api.calls.length, 1);
});

test("aborting between pages retains loaded rows and does not continue", async () => {
  const controller = new AbortController();
  const api = fakeApi(Array.from({ length: 101 }, (_, index) => pr(index + 1)));
  let loaded;
  await assert.rejects(retrieve(api, { signal: controller.signal, onProgress: progress => {
    loaded = progress.rows;
    controller.abort();
  } }), { name: "AbortError" });
  assert.equal(loaded.length, 100);
  assert.equal(api.calls.filter(path => path.startsWith("/search/")).length, 1);
});

test("malformed API data and invalid account dates fail explicitly", async () => {
  for (const data of [{ total_count: 0, items: [] }, { total_count: -1, incomplete_results: false, items: [] }]) {
    const api = fakeApi([], { transform(value, url) { return url.pathname === "/search/issues" ? data : value; } });
    await assert.rejects(retrieve(api), /invalid search response/);
  }
  await assert.rejects(retrieve(fakeApi([], { createdAt: "2023-02-29T00:00:00Z" })), /invalid UTC date/);
});

test("invalid/unsafe URLs are rejected; titles remain plain strings; UTC never uses locale", () => {
  const title = "<img src=x onerror=alert(1)> & \u2028";
  const row = normalizeRow(pr(1, { title }), "tester");
  assert.equal(row.title, title);
  assert.equal(row.date, "2024-02-29");
  for (const url of ["javascript:alert(1)", "http://github.com/x", "https://evil.example/x",
    "https://github.com.evil.example/x", "https://user@github.com/x", "https://github.com:444/x", "https://github.com/x?evil=1"]) {
    assert.throws(() => safeGithubUrl(url), /unsafe link|invalid link/);
  }
  assert.throws(() => normalizeRow(pr(1, { html_url: "https://github.com/MicrosoftDocs/other/pull/1" }), "tester"), /mismatched/);
  assert.throws(() => normalizeRow(pr(1, { id: 1.5 }), "tester"), /invalid pull-request/);
  assert.throws(() => utcTimestamp("2024-02-29T00:00:00-05:00"), /invalid UTC/);
  assert.deepEqual(sortRows([{ id: 2, created: 1 }, { id: 3, created: 1 }]).map(row => row.id), [3, 2]);
});

test("a traversal safety bound produces explicit partial failure", async () => {
  const api = fakeApi(Array.from({ length: 1001 }, (_, index) => pr(index + 1)));
  await assert.rejects(new ContributionsRun(api, { now, maxJobs: 1 }).retrieve("tester"), /safety bound/);
});
