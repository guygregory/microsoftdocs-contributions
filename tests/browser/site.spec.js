import { test, expect } from "@playwright/test";
import { pr, START } from "../helpers.js";

async function mock(page, search, { userStatus = 200, userBody = { created_at: "2024-02-29T00:00:00Z" } } = {}) {
  const requests = [];
  await page.route("https://api.github.com/**", async route => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (url.pathname.startsWith("/users/")) {
      await route.fulfill({ status: userStatus, json: userBody });
    } else if (url.pathname === "/orgs/MicrosoftDocs") {
      await route.fulfill({ json: { public_repos: 1 } });
    } else if (url.pathname === "/search/issues") {
      await search(route, url, requests);
    } else throw new Error(`Unexpected endpoint ${url}`);
  });
  return requests;
}

async function freeze(page) {
  await page.clock.install({ time: new Date("2024-03-04T00:00:00Z") });
  await page.clock.pauseAt(new Date("2024-03-04T00:00:00Z"));
}

async function submit(page, value = "tester") {
  await page.getByLabel("GitHub username").fill(value);
  await page.getByRole("button", { name: "Find contributions" }).click();
}

test("semantic initial state and keyboard submission show four safe columns in UTC", async ({ page }) => {
  const remoteTitle = '<img src=x onerror="window.hacked=true"> Plain & safe';
  const items = [
    pr(2, { title: remoteTitle, created: START + 1000, draft: true, user: { login: "Copilot" } }),
    pr(1, { created: START, state: "closed", pull_request: { merged_at: null } })
  ];
  await mock(page, route => route.fulfill({ json: { total_count: 2, incomplete_results: false, items } }));
  await page.goto("/");
  await expect(page.locator("#results")).toHaveAttribute("data-state", "initial");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.getByLabel("GitHub username").focus();
  await page.keyboard.type(" @ tester ");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Find contributions" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Find contributions" })).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(page.locator("#results")).toHaveAttribute("data-state", "complete");
  await expect(page.getByRole("columnheader")).toHaveCount(4);
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.locator("tbody td").first()).toHaveText("2024-02-29");
  await expect(page.locator("tbody tr").first().locator("td").last()).toHaveText(remoteTitle);
  await expect(page.locator("tbody img")).toHaveCount(0);
  expect(await page.evaluate(() => window.hacked)).toBeUndefined();
  await expect(page.locator("#status-title")).toHaveText("Complete total: 2 authored pull requests.");
  await expect(page.locator("#retrieval-meta")).toContainText("Retrieved at:");
  await expect(page.locator("tbody tr").first().getByRole("link", { name: "#2", exact: true }))
    .toHaveAttribute("href", "https://github.com/MicrosoftDocs/docs/pull/2");
});

test("validation is accessible and does not contact GitHub", async ({ page }) => {
  let requests = 0;
  await page.route("https://api.github.com/**", () => { requests++; });
  await page.goto("/");
  await submit(page, "bad--username");
  await expect(page.getByRole("alert")).toContainText("GitHub username");
  await expect(page.getByLabel("GitHub username")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("GitHub username")).toBeFocused();
  expect(requests).toBe(0);
});

test("existing empty account differs from a missing account", async ({ page }) => {
  await mock(page, route => route.fulfill({ json: { total_count: 0, incomplete_results: false, items: [] } }));
  await page.goto("/");
  await submit(page);
  await expect(page.locator("#results")).toHaveAttribute("data-state", "empty");
  await expect(page.locator("#status-title")).toContainText("Complete total: 0");
  await expect(page.locator("#status-detail")).toContainText("This account exists");
  await page.unrouteAll();
  await mock(page, () => { throw new Error("Search should not happen"); }, {
    userStatus: 404, userBody: { message: "Not Found" }
  });
  await submit(page, "missing-account");
  await expect(page.locator("#results")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#status-detail")).toContainText("@missing-account was not found");
  await expect(page.locator("#table-region")).toBeHidden();
});

test("mobile layout confines table scrolling and assets work under project subpath", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mock(page, route => route.fulfill({ json: { total_count: 1, incomplete_results: false, items: [pr(1)] } }));
  await page.goto("/microsoftdocs-contributions/");
  await submit(page);
  await expect(page.locator("#results")).toHaveAttribute("data-state", "complete");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator("#table-region").evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await page.locator("#table-region").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => page.locator("#table-region").evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  const button = await page.getByRole("button", { name: "Find contributions" }).boundingBox();
  expect(button.height).toBeGreaterThanOrEqual(44);
});

test("rate pause/resume preserves page one, early resume respects reset and succeeds", async ({ page }) => {
  await freeze(page);
  let pageTwoCalls = 0;
  const items = Array.from({ length: 101 }, (_, index) => pr(index + 1)).reverse();
  const requests = await mock(page, (route, url) => {
    if (url.searchParams.get("page") === "1") {
      return route.fulfill({ json: { total_count: 101, incomplete_results: false, items: items.slice(0, 100) } });
    }
    if (++pageTwoCalls === 1) {
      return route.fulfill({ status: 429, headers: { "Retry-After": "60" }, json: { message: "secondary rate limit" } });
    }
    return route.fulfill({ json: { total_count: 101, incomplete_results: false, items: items.slice(100) } });
  });
  await page.goto("/");
  await submit(page);
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await expect(page.locator("#status-title")).toContainText("loaded - retrieving");
  await page.clock.runFor(6100);
  await expect(page.locator("#results")).toHaveAttribute("data-state", "paused");
  await expect(page.locator("#status-detail")).toContainText("earliest retry");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator("#results")).toHaveAttribute("data-state", "loading");
  expect(pageTwoCalls).toBe(1);
  await page.clock.runFor(60_000);
  await expect(page.locator("#results")).toHaveAttribute("data-state", "complete");
  await expect(page.locator("tbody tr")).toHaveCount(101);
  expect(requests.filter(url => url.pathname === "/search/issues" && url.searchParams.get("page") === "1")).toHaveLength(1);
  expect(pageTwoCalls).toBe(2);
});

test("cancelling partial pagination retains accurately labelled rows", async ({ page }) => {
  await freeze(page);
  const items = Array.from({ length: 101 }, (_, index) => pr(index + 1)).reverse();
  const requests = await mock(page, route => route.fulfill({
    json: { total_count: 101, incomplete_results: false, items: items.slice(0, 100) }
  }));
  await page.goto("/");
  await submit(page);
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#results")).toHaveAttribute("data-state", "partial");
  await expect(page.locator("#status-title")).toHaveText("Cancelled - 100 pull requests loaded, not a complete total.");
  await page.clock.runFor(6100);
  await expect(page.locator("tbody tr")).toHaveCount(100);
  expect(requests.filter(url => url.pathname === "/search/issues")).toHaveLength(1);
});

test("cancel while paused then a new search cannot be overwritten by the old run", async ({ page }) => {
  await freeze(page);
  let limited = true;
  await mock(page, route => limited
    ? route.fulfill({ status: 403, json: { message: "secondary rate limit" } })
    : route.fulfill({ json: { total_count: 1, incomplete_results: false, items: [pr(9, { user: { login: "next" } })] } }));
  await page.goto("/");
  await submit(page);
  await expect(page.locator("#results")).toHaveAttribute("data-state", "paused");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#results")).toHaveAttribute("data-state", "partial");
  limited = false;
  await page.clock.runFor(60_000);
  await submit(page, "next");
  await expect(page.locator("#results")).toHaveAttribute("data-state", "complete");
  await expect(page.locator("#results-heading")).toHaveText("Contributions by @next");
  await page.clock.runFor(120_000);
  await expect(page.locator("#results")).toHaveAttribute("data-state", "complete");
  await expect(page.locator("tbody tr")).toHaveCount(1);
});

test("a racing new search owns the UI even if the old response finishes late", async ({ page }) => {
  let release;
  let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  await page.route("https://api.github.com/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/users/old") {
      entered();
      await new Promise(resolve => { release = resolve; });
      // Browser aborts this request when the replacement search starts.
      try { await route.fulfill({ json: { created_at: "2024-02-29T00:00:00Z" } }); }
      catch (error) { if (!/closed|handled|Invalid Interception/i.test(error.message)) throw error; }
    } else if (url.pathname.startsWith("/users/")) await route.fulfill({ json: { created_at: "2024-02-29T00:00:00Z" } });
    else if (url.pathname.startsWith("/orgs/")) await route.fulfill({ json: { public_repos: 1 } });
    else await route.fulfill({ json: { total_count: 0, incomplete_results: false, items: [] } });
  });
  await page.goto("/");
  await submit(page, "old");
  await pending;
  await submit(page, "next");
  release();
  await expect(page.locator("#results")).toHaveAttribute("data-state", "empty");
  await expect(page.locator("#results-heading")).toHaveText("Contributions by @next");
});

for (const [status, message, expected] of [
  [422, "Validation Failed", "rejected the search query"],
  [403, "Forbidden", "not a reported rate limit"],
  [503, "Service Unavailable", "temporarily unavailable"]
]) {
  test(`HTTP ${status} displays an explicit error instead of a zero total`, async ({ page }) => {
    await mock(page, route => route.fulfill({ status, json: { message } }));
    await page.goto("/");
    await submit(page);
    await expect(page.locator("#results")).toHaveAttribute("data-state", "error");
    await expect(page.locator("#status-detail")).toContainText(expected);
    await expect(page.locator("#status-title")).not.toContainText("Complete total");
  });
}

test("network failure after a successful page displays partial rows", async ({ page }) => {
  await freeze(page);
  const items = Array.from({ length: 101 }, (_, index) => pr(index + 1)).reverse();
  await mock(page, (route, url) => url.searchParams.get("page") === "1"
    ? route.fulfill({ json: { total_count: 101, incomplete_results: false, items: items.slice(0, 100) } })
    : route.abort("failed"));
  await page.goto("/");
  await submit(page);
  await expect(page.locator("tbody tr")).toHaveCount(100);
  await page.clock.runFor(6100);
  await expect(page.locator("#results")).toHaveAttribute("data-state", "partial");
  await expect(page.locator("#status-detail")).toContainText("could not be reached");
  await expect(page.locator("tbody tr")).toHaveCount(100);
});

test("unsafe remote PR URLs produce a visible protocol error, never a clickable link", async ({ page }) => {
  await mock(page, route => route.fulfill({
    json: { total_count: 1, incomplete_results: false, items: [pr(1, { html_url: "javascript:alert(1)" })] }
  }));
  await page.goto("/");
  await submit(page);
  await expect(page.locator("#results")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#status-detail")).toContainText("unsafe link");
  await expect(page.locator("tbody a")).toHaveCount(0);
});
