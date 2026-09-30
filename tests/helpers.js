import { checkAbort } from "../site/js/github-api.js";

export const START = Date.parse("2024-02-29T00:00:00Z");
export function pr(id, { created = START + id * 1000, repo = "docs", ...extra } = {}) {
  return {
    id, number: id, title: `Contribution ${id}`,
    created_at: new Date(created).toISOString(),
    html_url: `https://github.com/MicrosoftDocs/${repo}/pull/${id}`,
    repository_url: `https://api.github.com/repos/MicrosoftDocs/${repo}`,
    user: { login: "tester" }, pull_request: { url: "https://api.github.com/repos/MicrosoftDocs/docs/pulls/1" },
    ...extra
  };
}

export function fakeApi(items = [], {
  publicRepos = 1, repos = ["docs"], createdAt = "2024-02-29T00:00:00Z", transform
} = {}) {
  const calls = [];
  const api = {
    calls,
    async request(path, options) {
      checkAbort(options?.signal);
      calls.push(path);
      const url = new URL(path, "https://api.github.com");
      let data;
      if (url.pathname.startsWith("/users/")) data = { created_at: createdAt };
      else if (url.pathname === "/orgs/MicrosoftDocs") data = { public_repos: publicRepos };
      else if (url.pathname === "/orgs/MicrosoftDocs/repos") {
        const page = Number(url.searchParams.get("page"));
        data = repos.slice((page - 1) * 100, page * 100).map(name => ({
          name, private: false, owner: { login: "MicrosoftDocs" }
        }));
      } else if (url.pathname === "/search/issues") {
        const query = url.searchParams.get("q");
        const range = /created:(.+)\.\.(.+)$/.exec(query);
        const low = Date.parse(range[1]);
        const high = Date.parse(range[2]);
        const repo = /repo:(\S+)/.exec(query)?.[1];
        const matching = items.filter(item => item.pull_request &&
          item.repository_url.startsWith("https://api.github.com/repos/MicrosoftDocs/") &&
          (!repo || item.repository_url.endsWith(`/repos/${repo}`)) &&
          Date.parse(item.created_at) >= low && Date.parse(item.created_at) <= high)
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
        const page = Number(url.searchParams.get("page"));
        data = {
          total_count: matching.length, incomplete_results: false,
          items: matching.slice((page - 1) * 100, Math.min(page * 100, 1000))
        };
      } else throw new Error(`Unexpected API path: ${path}`);
      return transform ? transform(data, url, calls, options) : data;
    }
  };
  return api;
}

export function fakeClock(initial = START) {
  let time = initial;
  const waits = [];
  return {
    now: () => time, waits,
    advance: ms => { time += ms; },
    wait: async (ms, signal) => {
      checkAbort(signal);
      waits.push(ms);
      time += ms;
    }
  };
}

export function response(body = {}, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}
