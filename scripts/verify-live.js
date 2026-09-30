import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const destination = process.argv[2] || "http://127.0.0.1:43189/";
const username = "guygregory";
let server;
let browser;
try {
  if (!process.argv[2]) {
    server = spawn(process.execPath, ["scripts/preview.js"], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve, reject) => {
      server.stdout.once("data", resolve);
      server.once("error", reject);
      server.once("exit", code => reject(new Error(`Preview exited before readiness: ${code}`)));
    });
  }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "Pacific/Honolulu" });
  const errors = [];
  const preflights = [];
  page.on("pageerror", error => errors.push(error.message));
  const session = await page.context().newCDPSession(page);
  await session.send("Network.enable");
  session.on("Network.requestWillBeSent", event => {
    if (event.request.method === "OPTIONS" && event.request.url.startsWith("https://api.github.com/")) {
      preflights.push({ url: event.request.url, headers: event.request.headers });
    }
  });
  await page.addInitScript(() => {
    const original = globalThis.fetch.bind(globalThis);
    window.githubEvidence = [];
    globalThis.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).startsWith("https://api.github.com/")) {
        const data = await response.clone().json();
        window.githubEvidence.push({
          url: String(args[0]), version: args[1]?.headers?.["X-GitHub-Api-Version"],
          credentials: args[1]?.credentials, status: response.status,
          headers: Object.fromEntries(["x-ratelimit-resource", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]
            .map(name => [name, response.headers.get(name)])),
          ids: Array.isArray(data.items) ? data.items.map(item => item.id) : []
        });
      }
      return response;
    };
  });
  const pageResponse = await page.goto(destination);
  assert.equal(pageResponse.status(), 200);
  await page.getByLabel("GitHub username").fill(username);
  await page.getByRole("button", { name: "Find contributions" }).click();
  await page.waitForFunction(() => ["complete", "empty", "error", "partial", "paused"].includes(
    document.querySelector("#results").dataset.state), { timeout: 90_000 });
  const state = await page.locator("#results").getAttribute("data-state");
  assert.ok(["complete", "empty"].includes(state), await page.locator("#status").innerText());
  const metadata = await page.locator("#retrieval-meta").innerText();
  const cutoff = /Creation cutoff: ([^ ]+)/.exec(metadata)[1];
  const evidence = await page.evaluate(() => window.githubEvidence);
  assert.ok(evidence.length >= 3);
  for (const request of evidence) {
    assert.equal(request.version, "2026-03-10");
    assert.equal(request.credentials, "omit");
    assert.notEqual(request.headers["x-ratelimit-remaining"], null);
    assert.notEqual(request.headers["x-ratelimit-reset"], null);
    assert.notEqual(request.headers["x-ratelimit-resource"], null);
  }
  assert.ok(preflights.length > 0, "An actual cross-origin API-version-header preflight must be observed.");
  const reference = [];
  let total;
  for (let index = 1; ; index++) {
    const params = new URLSearchParams({
      q: `author:${username} org:MicrosoftDocs is:pr created:<=${cutoff.replace(".000Z", "+00:00")}`,
      sort: "created", order: "desc", per_page: "100", page: String(index)
    });
    const response = await fetch(`https://api.github.com/search/issues?${params}`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
      credentials: "omit"
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.incomplete_results, false);
    total ??= data.total_count;
    assert.equal(data.total_count, total);
    assert.ok(total <= 1000, "The live reference requires partitioning for this unusually large account.");
    reference.push(...data.items);
    if (reference.length >= total) break;
    await new Promise(resolve => setTimeout(resolve, 6100));
  }
  const browserIds = [...new Set(evidence.flatMap(request => request.ids))].sort((a, b) => a - b);
  const referenceIds = [...new Set(reference.map(item => item.id))].sort((a, b) => a - b);
  assert.equal(referenceIds.length, total);
  assert.deepEqual(browserIds, referenceIds);
  reference.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const expectedRows = reference.map(item => ({
    cells: [item.created_at.slice(0, 10), `#${item.number}`,
      item.repository_url.replace("https://api.github.com/repos/", ""), item.title],
    links: [item.html_url, item.repository_url.replace("https://api.github.com/repos/", "https://github.com/")]
  }));
  const actualRows = await page.locator("tbody tr").evaluateAll(rows => rows.map(row => ({
    cells: [...row.querySelectorAll("td")].map(cell => cell.textContent),
    links: [...row.querySelectorAll("a")].map(link => link.href)
  })));
  assert.deepEqual(actualRows, expectedRows);
  assert.deepEqual(errors, []);
  if (process.env.ARTIFACTS_DIR) {
    await mkdir(process.env.ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.ARTIFACTS_DIR, "contributions-desktop.png"), fullPage: true });
  }
  await page.setViewportSize({ width: 375, height: 812 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (process.env.ARTIFACTS_DIR) {
    await page.screenshot({ path: join(process.env.ARTIFACTS_DIR, "contributions-mobile.png"), fullPage: true });
  }
  const result = { destination, state, count: total, cutoff, metadata, browserIds, referenceIds, preflights, evidence, rows: actualRows };
  if (process.env.ARTIFACTS_DIR) {
    await writeFile(join(process.env.ARTIFACTS_DIR, "live-verification.json"), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({ destination, state, count: total, cutoff, idsMatch: true, tableValuesMatch: true,
    corsPreflights: preflights.length, readableRateHeaders: true, browserErrors: errors.length, mobileOverflow: false }, null, 2));
} finally {
  await browser?.close();
  server?.kill();
}
