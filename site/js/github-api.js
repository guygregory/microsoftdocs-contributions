export const API_ROOT = "https://api.github.com";
export const API_VERSION = "2026-03-10";

export class ApiError extends Error {
  constructor(message, { kind = "api", status = 0 } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

export function abortError() {
  return new DOMException("Retrieval cancelled.", "AbortError");
}

export function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

export function sleep(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function numericHeader(headers, name) {
  const value = headers.get(name);
  if (value === null || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function rateDeadline(headers, now, attempt = 0) {
  const retry = headers.get("retry-after");
  let retryAt = null;
  if (retry !== null && retry.trim() !== "") {
    const seconds = Number(retry);
    retryAt = Number.isFinite(seconds) && seconds >= 0
      ? now + seconds * 1000 : Date.parse(retry);
  }
  const reset = numericHeader(headers, "x-ratelimit-reset");
  const remaining = numericHeader(headers, "x-ratelimit-remaining");
  const hints = [retryAt, remaining === 0 && reset !== null ? reset * 1000 + 1000 : null]
    .filter(value => Number.isFinite(value) && value > now);
  return hints.length ? Math.max(...hints) : now + 60_000 * 2 ** attempt;
}

export class GitHubApi {
  constructor({ fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now, wait = sleep, maxRetries = 3 } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.wait = wait;
    this.maxRetries = maxRetries;
    this.tail = Promise.resolve();
    this.buckets = new Map();
    this.lastSearch = null;
    this.pause = null;
    this.cooldown = 0;
  }

  request(path, options = {}) {
    const task = this.tail.then(() => this.perform(path, options));
    // A rejected request must not poison the next independent search's queue.
    this.tail = task.catch(() => {});
    return task;
  }

  resume(signal) {
    if (this.pause && this.pause.signal === signal) this.pause.resolve();
  }

  async pauseUntil(until, reason, signal, onStatus) {
    checkAbort(signal);
    await new Promise((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        this.pause = null;
        resolve();
      };
      const abort = () => {
        this.pause = null;
        reject(abortError());
      };
      this.pause = { signal, resolve: finish };
      signal?.addEventListener("abort", abort, { once: true });
      onStatus?.({ state: "paused", until, message: reason });
    });
    checkAbort(signal);
    const delay = Math.max(0, until - this.now());
    onStatus?.({ state: "loading", until, message: delay
      ? "Resuming after GitHub's rate-limit reset." : "Resuming retrieval." });
    if (delay) await this.wait(delay, signal);
    checkAbort(signal);
  }

  async perform(path, { bucket = "core", signal, onStatus } = {}) {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new ApiError("Invalid GitHub API endpoint.", { kind: "protocol" });
    }
    for (let attempt = 0; ; attempt++) {
      checkAbort(signal);
      if (this.cooldown > this.now()) {
        await this.pauseUntil(this.cooldown,
          "GitHub's secondary-limit cooldown still applies, including to new searches.", signal, onStatus);
      }
      const limit = bucket === "search" ? 10 : 60;
      const period = bucket === "search" ? 60_000 : 3_600_000;
      let budget = this.buckets.get(bucket);
      if (!budget || budget.reset <= this.now()) {
        budget = { remaining: limit, reset: this.now() + period };
        this.buckets.set(bucket, budget);
      }
      if (budget.remaining <= 0) {
        await this.pauseUntil(budget.reset + 1000,
          `GitHub's ${bucket} request allowance is exhausted.`, signal, onStatus);
        if (budget.reset <= this.now()) {
          budget = { remaining: limit, reset: this.now() + period };
          this.buckets.set(bucket, budget);
        }
      }
      if (bucket === "search" && this.lastSearch !== null) {
        const delay = Math.max(0, this.lastSearch + 6100 - this.now());
        if (delay) await this.wait(delay, signal);
      }
      checkAbort(signal);
      budget.remaining--;
      if (bucket === "search") this.lastSearch = this.now();
      let response;
      try {
        response = await this.fetchImpl(`${API_ROOT}${path}`, {
          headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION },
          credentials: "omit", mode: "cors", cache: "no-store", signal
        });
      } catch (error) {
        checkAbort(signal);
        if (error.name === "AbortError") throw error;
        throw new ApiError(`GitHub could not be reached: ${error.message}`, { kind: "network" });
      }
      checkAbort(signal);
      const resource = response.headers.get("x-ratelimit-resource") || bucket;
      const remaining = numericHeader(response.headers, "x-ratelimit-remaining");
      const reset = numericHeader(response.headers, "x-ratelimit-reset");
      if (remaining !== null && reset !== null && reset * 1000 > this.now()) {
        this.buckets.set(resource, { remaining, reset: reset * 1000 });
      }
      let body;
      try {
        body = await response.json();
      } catch (error) {
        checkAbort(signal);
        if (response.ok) {
          throw new ApiError(`GitHub returned an unreadable response (HTTP ${response.status}).`,
            { kind: "protocol", status: response.status });
        }
        body = { message: "GitHub returned a non-JSON error response." };
      }
      checkAbort(signal);
      if (response.ok) return body;
      const message = typeof body.message === "string" ? body.message : "No error details.";
      const limited = response.status === 429 || (response.status === 403 &&
        (remaining === 0 || response.headers.get("retry-after") !== null ||
          /rate limit|secondary limit|abuse/i.test(message)));
      if (limited) {
        const until = rateDeadline(response.headers, this.now(), attempt);
        if (remaining === 0) {
          this.buckets.set(resource, { remaining: 0, reset: until - 1000 });
        } else {
          this.cooldown = Math.max(this.cooldown, until);
        }
        if (attempt >= this.maxRetries) {
          throw new ApiError("GitHub repeatedly rate-limited retrieval. Loaded rows are not a complete total.",
            { kind: "rate", status: response.status });
        }
        await this.pauseUntil(until,
          `GitHub paused requests: ${message}`, signal, onStatus);
        continue;
      }
      const errors = {
        404: ["not-found", "GitHub could not find this public account or resource."],
        422: ["query", "GitHub rejected the search query."],
        403: ["forbidden", "GitHub refused this request (not a reported rate limit)."],
        503: ["unavailable", "GitHub search is temporarily unavailable."]
      };
      const [kind, label] = errors[response.status] || ["api", `GitHub returned HTTP ${response.status}.`];
      throw new ApiError(`${label} ${message}`, { kind, status: response.status });
    }
  }
}
