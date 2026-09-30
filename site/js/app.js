import { GitHubApi } from "./github-api.js";
import { ContributionsRun, normalizeUsername } from "./contributions.js";

const api = new GitHubApi();
const form = document.querySelector("#search-form");
const input = document.querySelector("#username");
const formError = document.querySelector("#form-error");
const results = document.querySelector("#results");
const heading = document.querySelector("#results-heading");
const title = document.querySelector("#status-title");
const detail = document.querySelector("#status-detail");
const meta = document.querySelector("#retrieval-meta");
const body = document.querySelector("#contributions-body");
const tableRegion = document.querySelector("#table-region");
const caption = document.querySelector("#table-caption");
const cancel = document.querySelector("#cancel-button");
const resume = document.querySelector("#resume-button");
let active = null;
let generation = 0;

function status(state, label, message) {
  results.dataset.state = state;
  title.textContent = label;
  detail.textContent = message;
  cancel.hidden = !["loading", "paused"].includes(state);
  resume.hidden = state !== "paused";
  tableRegion.setAttribute("aria-busy", String(state === "loading"));
}

function renderRows(rows) {
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement("tr");
    const date = document.createElement("td");
    date.textContent = row.date;
    tr.append(date);
    for (const [text, url] of [[`#${row.number}`, row.url], [row.repository, row.repositoryUrl]]) {
      const td = document.createElement("td");
      const link = document.createElement("a");
      link.textContent = text;
      link.href = url;
      td.append(link);
      tr.append(td);
    }
    const td = document.createElement("td");
    td.textContent = row.title;
    tr.append(td);
    fragment.append(tr);
  }
  body.replaceChildren(fragment);
  tableRegion.hidden = rows.length === 0;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  let username;
  try { username = normalizeUsername(input.value); } catch (error) {
    formError.textContent = error.message;
    formError.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.focus();
    return;
  }
  formError.hidden = true;
  input.removeAttribute("aria-invalid");
  input.value = username;
  active?.controller.abort();
  const run = { id: ++generation, controller: new AbortController(), rows: [], cutoff: null };
  active = run;
  const current = () => active === run && run.id === generation;
  heading.textContent = `Contributions by @${username}`;
  caption.textContent = `Authored MicrosoftDocs pull requests by @${username}, newest first`;
  meta.hidden = true;
  renderRows([]);
  status("loading", "0 pull requests loaded - retrieving.", "Checking the public account and current organisation scope.");
  try {
    const result = await new ContributionsRun(api).retrieve(username, {
      signal: run.controller.signal,
      onProgress: progress => {
        if (!current()) return;
        run.rows = progress.rows;
        run.cutoff = progress.cutoff;
        renderRows(run.rows);
        const state = results.dataset.state;
        if (state === "loading") {
          status("loading", `${run.rows.length} pull requests loaded - retrieving.`,
            "Checking every date interval and search page. Loaded rows are not yet a complete total.");
        }
        meta.textContent = `Creation cutoff: ${progress.cutoff} (UTC). Retrieval is still in progress.`;
        meta.hidden = false;
      },
      onStatus: update => {
        if (!current() || run.controller.signal.aborted) return;
        const until = update.until ? ` Reset / earliest retry: ${new Date(update.until).toISOString()} (UTC).` : "";
        status(update.state, update.state === "paused"
          ? `Paused - ${run.rows.length} pull requests loaded, not a complete total.`
          : `${run.rows.length} pull requests loaded - retrieving.`,
        `${update.message}${until}${update.state === "paused"
          ? " Choose Resume to continue the same queue; an early resume waits for this time." : ""}`);
      }
    });
    if (!current()) return;
    run.rows = result.rows;
    renderRows(result.rows);
    status(result.rows.length ? "complete" : "empty",
      `Complete total: ${result.rows.length} authored pull request${result.rows.length === 1 ? "" : "s"}.`,
      result.rows.length
        ? "Every search interval and page was retrieved and its unique count reconciled. Newest first; all pull-request states included."
        : "This account exists, but no searchable authored pull requests matched the current public MicrosoftDocs scope.");
    meta.textContent = `Retrieved at: ${result.retrievedAt} (UTC). Creation cutoff: ${result.cutoff} (UTC).`;
    meta.hidden = false;
  } catch (error) {
    if (!current()) return;
    if (error.name === "AbortError") {
      status("partial", `Cancelled - ${run.rows.length} pull requests loaded, not a complete total.`,
        "Retrieval stopped. Loaded rows are retained; a new search starts a new retrieval.");
    } else {
      console.error("Contribution retrieval failed:", error);
      status(run.rows.length ? "partial" : "error",
        run.rows.length ? `Partial results: ${run.rows.length} loaded, not a complete total.` : "Retrieval could not be completed.",
        error.message);
    }
    meta.textContent = `Stopped at: ${new Date().toISOString()} (UTC).${run.cutoff ? ` Creation cutoff: ${run.cutoff} (UTC).` : ""}`;
    meta.hidden = false;
  }
});

cancel.addEventListener("click", () => active?.controller.abort());
resume.addEventListener("click", () => {
  if (!active) return;
  api.resume(active.controller.signal);
});
