import test from "node:test";
import assert from "node:assert/strict";
import { GitHubApi, rateDeadline, sleep, API_VERSION } from "../site/js/github-api.js";
import { fakeClock, response } from "./helpers.js";

test("CORS headers, anonymous credentials, separate sequential buckets and search pacing", async () => {
  const clock = fakeClock();
  const calls = [];
  const api = new GitHubApi({ ...clock, fetchImpl: async (url, options) => {
    calls.push({ url, options, time: clock.now() });
    return response({ ok: true });
  } });
  await Promise.all([
    api.request("/users/tester"), api.request("/search/issues?page=1", { bucket: "search" }),
    api.request("/search/issues?page=2", { bucket: "search" }), api.request("/orgs/MicrosoftDocs")
  ]);
  assert.equal(calls.length, 4);
  assert.equal(calls[2].time - calls[1].time, 6100);
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.mode, "cors");
  assert.equal(calls[0].options.headers["X-GitHub-Api-Version"], API_VERSION);
  assert.equal(calls[0].options.headers.Accept, "application/vnd.github+json");
  assert.equal(api.buckets.get("core").remaining, 58);
  assert.equal(api.buckets.get("search").remaining, 8);
});

test("rate hints: Retry-After seconds/date, reset, missing/unreadable hints, exponential fallback", () => {
  const now = Date.parse("2024-02-29T00:00:00Z");
  assert.equal(rateDeadline(new Headers({ "retry-after": "30" }), now), now + 30_000);
  assert.equal(rateDeadline(new Headers({ "retry-after": new Date(now + 120_000).toUTCString() }), now), now + 120_000);
  assert.equal(rateDeadline(new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 90) }), now), now + 91_000);
  assert.equal(rateDeadline(new Headers(), now), now + 60_000);
  assert.equal(rateDeadline(new Headers({ "retry-after": "unreadable", "x-ratelimit-reset": "bad" }), now, 2), now + 240_000);
  assert.equal(rateDeadline(new Headers({ "retry-after": "0" }), now), now + 60_000);
});

test("observed resource header identifies the actual bucket", async () => {
  const clock = fakeClock();
  const api = new GitHubApi({ ...clock, fetchImpl: async () => response({}, 200, {
    "x-ratelimit-resource": "search", "x-ratelimit-remaining": "2",
    "x-ratelimit-reset": String(clock.now() / 1000 + 60)
  }) });
  await api.request("/search/issues", { bucket: "search" });
  assert.equal(api.buckets.get("search").remaining, 2);
  assert.equal(api.buckets.has("core"), false);
});

test("preflight exhaustion pauses and resumes without fetching the successful page again", async () => {
  const clock = fakeClock();
  const paths = [];
  const states = [];
  const controller = new AbortController();
  const api = new GitHubApi({ ...clock, fetchImpl: async url => {
    paths.push(url);
    return response({}, 200, paths.length === 1 ? {
      "x-ratelimit-resource": "search", "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(clock.now() / 1000 + 60)
    } : {});
  } });
  const onStatus = state => {
    states.push(state);
    if (state.state === "paused") queueMicrotask(() => api.resume(controller.signal));
  };
  await api.request("/search/issues?page=1", { bucket: "search", signal: controller.signal, onStatus });
  await api.request("/search/issues?page=2", { bucket: "search", signal: controller.signal, onStatus });
  assert.equal(paths.length, 2);
  assert.ok(paths[1].endsWith("page=2"));
  assert.equal(states.filter(state => state.state === "paused").length, 1);
  assert.ok(clock.waits.includes(61_000));
});

for (const status of [403, 429]) {
  test(`HTTP ${status} limit pauses and retries just the failing request`, async () => {
    const clock = fakeClock();
    const paths = [];
    const controller = new AbortController();
    const api = new GitHubApi({ ...clock, fetchImpl: async url => {
      paths.push(url);
      if (paths.length === 2) return response({ message: "secondary rate limit" }, status, { "retry-after": "90" });
      return response({ ok: true });
    } });
    const onStatus = state => {
      if (state.state === "paused") queueMicrotask(() => api.resume(controller.signal));
    };
    await api.request("/search/issues?page=1", { bucket: "search", signal: controller.signal, onStatus });
    await api.request("/search/issues?page=2", { bucket: "search", signal: controller.signal, onStatus });
    assert.equal(paths.length, 3);
    assert.equal(paths[1], paths[2]);
    assert.notEqual(paths[0], paths[1]);
    assert.ok(clock.waits.includes(90_000));
  });
}

test("secondary limit without hints uses minimum one minute and bounded exponential backoff", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  let calls = 0;
  let pauses = 0;
  const api = new GitHubApi({ ...clock, fetchImpl: async () => {
    calls++;
    return response({ message: "secondary rate limit" }, 403);
  } });
  const onStatus = state => {
    if (state.state === "paused") {
      pauses++;
      queueMicrotask(() => api.resume(controller.signal));
    }
  };
  await assert.rejects(api.request("/search/issues", { bucket: "search", signal: controller.signal, onStatus }),
    error => error.kind === "rate");
  assert.equal(calls, 4);
  assert.equal(pauses, 3);
  assert.deepEqual(clock.waits, [60_000, 120_000, 240_000]);
});

test("missing CORS-readable budget headers still enforce conservative local search allowance", async () => {
  const clock = fakeClock();
  let calls = 0;
  let pauses = 0;
  const controller = new AbortController();
  const api = new GitHubApi({ ...clock, fetchImpl: async () => { calls++; return response({}); } });
  const onStatus = update => {
    if (update.state === "paused") {
      pauses++;
      queueMicrotask(() => api.resume(controller.signal));
    }
  };
  for (let index = 0; index < 11; index++) {
    await api.request(`/search/issues?page=${index}`, { bucket: "search", signal: controller.signal, onStatus });
  }
  assert.equal(calls, 11);
  assert.equal(pauses, 1);
  assert.ok(clock.waits.includes(6100));
});

test("missing headers also enforce independent core allowance", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  let pauses = 0;
  const api = new GitHubApi({ ...clock, fetchImpl: async () => response({}) });
  const onStatus = state => {
    if (state.state === "paused") { pauses++; queueMicrotask(() => api.resume(controller.signal)); }
  };
  for (let index = 0; index < 61; index++) {
    await api.request(`/users/user${index}`, { signal: controller.signal, onStatus });
  }
  assert.equal(pauses, 1);
  assert.ok(clock.waits.includes(3_601_000));
  assert.equal(api.buckets.has("search"), false);
});

test("cancel while paused, repeated resume/cancel and subsequent new search recover cleanly", async () => {
  const clock = fakeClock();
  const first = new AbortController();
  let calls = 0;
  const api = new GitHubApi({ ...clock, fetchImpl: async () => {
    calls++;
    return calls === 1 ? response({ message: "rate limit" }, 429) : response({ ok: true });
  } });
  const pending = api.request("/search/issues", {
    bucket: "search", signal: first.signal,
    onStatus: state => {
      if (state.state === "paused") {
        first.abort();
        api.resume(first.signal);
        api.resume(first.signal);
      }
    }
  });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(api.pause, null);
  const next = new AbortController();
  let nextPauses = 0;
  assert.deepEqual(await api.request("/users/next", {
    signal: next.signal,
    onStatus: state => {
      if (state.state === "paused") {
        nextPauses++;
        queueMicrotask(() => api.resume(next.signal));
      }
    }
  }), { ok: true });
  assert.equal(nextPauses, 1);
  assert.deepEqual(clock.waits, [60_000]);
});

test("cancel during a resumed wait aborts instead of issuing a request", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  let calls = 0;
  const api = new GitHubApi({
    ...clock,
    wait: async (ms, signal) => { controller.abort(); if (signal.aborted) throw new DOMException("cancel", "AbortError"); },
    fetchImpl: async () => { calls++; return response({ message: "rate limit" }, 429); }
  });
  await assert.rejects(api.request("/search/issues", {
    bucket: "search", signal: controller.signal,
    onStatus: state => { if (state.state === "paused") queueMicrotask(() => api.resume(controller.signal)); }
  }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("cancel an in-flight fetch and racing queued search; stale response cannot succeed", async () => {
  const clock = fakeClock();
  const first = new AbortController();
  let release;
  const started = new Promise(resolve => { release = resolve; });
  let deliver;
  let calls = 0;
  const api = new GitHubApi({ ...clock, fetchImpl: async () => {
    calls++;
    if (calls === 1) {
      release();
      await new Promise(resolve => { deliver = resolve; });
    }
    return response({ calls });
  } });
  const pending = api.request("/users/old", { signal: first.signal });
  await started;
  const second = api.request("/users/new");
  first.abort();
  deliver();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(await second, { calls: 2 });
});

test("aborting a queued request prevents it from using the network", async () => {
  const controller = new AbortController();
  let calls = 0;
  const api = new GitHubApi({ fetchImpl: async () => { calls++; return response({}); } });
  controller.abort();
  await assert.rejects(api.request("/users/tester", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
});

for (const [status, kind] of [[404, "not-found"], [422, "query"], [403, "forbidden"], [503, "unavailable"], [500, "api"]]) {
  test(`HTTP ${status} is distinguished as ${kind}, not an empty result`, async () => {
    const api = new GitHubApi({ fetchImpl: async () => response({ message: "test failure" }, status) });
    await assert.rejects(api.request("/users/tester"), error => error.status === status && error.kind === kind);
  });
}

test("network and malformed JSON errors surface explicitly; endpoint injection is rejected", async () => {
  const api = new GitHubApi({ fetchImpl: async () => { throw new TypeError("offline"); } });
  await assert.rejects(api.request("/users/tester"), error => error.kind === "network");
  const invalid = new GitHubApi({ fetchImpl: async () => new Response("not JSON") });
  await assert.rejects(invalid.request("/users/tester"), error => error.kind === "protocol");
  await assert.rejects(api.request("//evil.example"), /Invalid GitHub API endpoint/);
});

test("non-JSON 429 honours rate hints and non-JSON 503 remains an availability error", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  let calls = 0;
  const api = new GitHubApi({ ...clock, fetchImpl: async () => ++calls === 1
    ? new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } })
    : response({ ok: true }) });
  await api.request("/search/issues", {
    bucket: "search", signal: controller.signal,
    onStatus: state => { if (state.state === "paused") queueMicrotask(() => api.resume(controller.signal)); }
  });
  assert.deepEqual(clock.waits, [120_000]);
  const unavailable = new GitHubApi({ fetchImpl: async () => new Response("Unavailable", { status: 503 }) });
  await assert.rejects(unavailable.request("/users/tester"), error => error.kind === "unavailable");
});

test("real abortable timer rejects cancellation", async () => {
  const controller = new AbortController();
  const waiting = sleep(60_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});
