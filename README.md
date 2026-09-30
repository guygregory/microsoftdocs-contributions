# MicrosoftDocs contributions

A dependency-free static website for exploring **all searchable authored pull requests in currently owned public MicrosoftDocs repositories**.

**Website:** https://contributions.guygregory.com/

Enter a public GitHub username, such as `guygregory`. Leading `@` and surrounding whitespace are normalized. Draft, open, merged and closed-unmerged pull requests are included, newest first. Issues, reviews, comments and commits are not. The table contains exactly Date (UTC `YYYY-MM-DD`), PR, Repository and PR title. There is no backend, application build, production dependency, login, token, browser credential storage, analytics or persistent user-data storage. The username is sent directly to GitHub's public API.

Input validation accepts ASCII letters, digits, hyphens and underscores, plus an optional `[bot]` suffix. This supports standard accounts, [Enterprise Managed Users](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/iam-configuration-reference/username-considerations-for-external-authentication) such as `mona-cat_octo`, enterprise setup accounts such as `octo_admin`, and GitHub App accounts such as `github-actions[bot]`. Rather than applying standard signup length/hyphen rules to every login format, the site uses GitHub's account lookup as the authority on account validity. Whitespace and search/path-injection characters remain blocked. A valid managed-user name may still return 404 from the anonymous public API; accepting its format does not grant access to an otherwise inaccessible account or private history.

Authorship follows GitHub's server-side `author:` search. An associated Copilot-created PR can match that search while its response has `user.login: Copilot`; the site does not incorrectly exclude such matches by re-filtering that field.

## What a complete total means

The site checks `/users/{username}` first: a missing public account is distinct from an existing account with no matching PRs. At the start of each retrieval it captures a fixed UTC creation cutoff. The lower bound is the account's creation date rounded down to midnight UTC.

Queries filter the organisation **on GitHub**, not after a globally limited author search:

```text
GET /search/issues?q=author:USERNAME org:MicrosoftDocs is:pr created:START..CUTOFF
    &sort=created&order=desc&per_page=100&page=N
```

GitHub returns at most 1,000 results per search. The retrieval engine recursively partitions inclusive creation intervals into disjoint second-resolution ranges until each query fits. The next range starts at the midpoint plus one second. It reuses page one, retrieves every required page, checks `incomplete_results` on **every** page, deduplicates by stable PR ID, and reconciles unique counts before accepting an interval. Timestamps are sorted descending, with descending ID as the deterministic tie-breaker. Dates never depend on the browser's timezone.

Incomplete searches are retried up to three times, then subdivided. Count/pagination instability is retried up to three times, then reported as unresolved partial coverage. A single-second org search that cannot fit falls back to enumerating public repositories and searching each repository. The organisation's public repository count is checked before searching: above GitHub's 4,000-repository query scope limit, retrieval enumerates repositories and uses repo-scoped queries from the outset. Enumeration is paginated and reconciled with the organisation count. An unsplittable repository/second or the traversal safety bound (20,000 intervals) produces an explicit partial error, never silent truncation.

**This is not an authoritative archive.** Private, deleted, hidden or transferred-out repositories and PR history cannot be reconstructed. Only current public organisation membership and currently searchable data are covered. GitHub's indexing can lag. A fixed creation cutoff is not an atomic snapshot: edits, transfers and indexing drift during a run can affect results. Reconciled counts detect many inconsistencies, but cannot prove the absence of equal-count substitutions or unindexed history.

## Retrieval states, rates and privacy

Initial, loading, empty, complete, paused, partial and error states are explicit. While loading, rows are labelled **loaded**, not as a final total. Partial rows remain visible on errors or cancellation. Retrieval time and creation cutoff are displayed in UTC.

Anonymous GitHub Search has its own **10 requests/minute** allowance; ordinary REST has a separate **60 requests/hour** allowance. Limits are shared by visitors on the same public IP. Searches are sequential and spaced at least 6.1 seconds apart. The queue observes CORS-readable `X-RateLimit-Resource`, remaining and reset headers. When headers are missing or unreadable, it tracks conservative local allowances instead.

Primary/secondary limits and HTTP 429 pause the in-memory queue. **Resume** continues the same queue without repeating successfully fetched pages; an early resume waits for GitHub's reset or `Retry-After` time. Secondary limits without usable hints wait at least one minute, with bounded exponential backoff and at most three retries. **Cancel** aborts network requests and waits; rows already loaded are retained but are not a complete total. A new valid search cancels the old run and prevents stale callbacks from overwriting the new UI; known rate-reset/secondary-cooldown deadlines still apply to the replacement search. Reloading the page discards the queue and results.

404 account lookup failures, 422 invalid queries, non-limit 403 failures, 503 service failures, malformed responses, network failures and cancellation are distinguished. API requests use `credentials: "omit"`, `Accept: application/vnd.github+json`, and `X-GitHub-Api-Version: 2026-03-10`. Remote titles are rendered with `textContent`; links must be HTTPS `github.com` links and match the repository and PR number.

## Local preview and tests

Use Node.js 24 LTS or newer. Unit tests and the preview server use only Node built-ins:

```powershell
npm test
npm run preview
```

Open http://127.0.0.1:43189/. The preview also mounts the same files at `/microsoftdocs-contributions/` to exercise relative asset/module paths. An optional `PORT` environment variable overrides the preview port; browser tests use 43189 and fail rather than reuse an unrelated server.

For development-only browser tests:

```powershell
npm ci
npx playwright install chromium
npm run test:browser
```

Chromium is already available on some development machines; skip the install when it is. Playwright is a **dev-only** dependency and is not shipped to Pages. The deterministic Node suite covers cap boundaries (0/100/101/1,000/1,001 and larger histories), UTC/leap/boundary dates, all PR states, safe fields, deduplication, incomplete pages, count drift, repository fallback and the 4,000-repository scope limit, separate rates, missing headers, pause/resume, cancellation and errors. Mocked browser tests cover keyboard/focus, mobile scrolling, UTC in a non-UTC timezone, safe DOM rendering, project subpaths, empty/missing users, and partial/rate/cancellation/racing states. **CI never calls live GitHub.**

An optional manual live smoke check uses Chromium plus an independent anonymous REST reference. It checks `guygregory` against an author-and-organisation scoped, paginated reference aligned to the browser's cutoff, compares stable IDs and every table value, and verifies actual CORS preflights and browser-readable rate headers. Neither side uses a token; this also avoids SSO restrictions that can apply to an authenticated CLI token even for public organisation searches:

```powershell
npm run verify:live
npm run verify:live -- https://contributions.guygregory.com/
```

The reference deliberately fails rather than truncates if this example account ever exceeds 1,000 PRs; use a partitioned reference in that case. Set `ARTIFACTS_DIR` to an absolute scratch directory to retain verification JSON and desktop/mobile screenshots.

## Files and deployment

| Path | Purpose |
| --- | --- |
| `site/index.html`, `site/styles.css` | Accessible responsive form, status and semantic four-column table |
| `site/js/app.js` | DOM rendering and isolated per-search UI lifecycle |
| `site/js/github-api.js` | Anonymous sequential request queue, rate budgets, aborts and resume |
| `site/js/contributions.js` | Validation, UTC conversion, intervals, repository fallback and reconciliation |
| `tests/*.test.js` | Dependency-free deterministic Node tests with mocked APIs and fake clocks |
| `tests/browser/site.spec.js` | Deterministic Playwright UI tests with no live GitHub requests |
| `scripts/preview.js`, `scripts/verify-live.js` | Local server and optional live browser/reference check |
| `.github/workflows/pages.yml` | Test main pushes/PRs, then publish only `site/` on main |

The workflow uses official SHA-pinned GitHub Actions, Node 24, `npm test`, no application build or dependency installation, and uploads **only `site/`**. Main pushes and manual dispatch deploy through the `github-pages` environment with `contents: read`, `pages: write` and `id-token: write`. PRs run deterministic tests only. Deployment concurrency does not cancel an in-progress publication. Browser tests are optional local checks, not a dependency of the production artifact.

In repository **Settings > Pages**, select **GitHub Actions** as the build source. The repository's Pages custom-domain setting must be `contributions.guygregory.com`. Custom Actions publishing does **not** consume a `CNAME` file; no such file is included here.

Configure DNS as:

```text
Type: CNAME
Name: contributions
Target: guygregory.github.io
```

The target is a hostname, **not** a URL, and has **no repository path**. Use DNS-only/unproxied mode where the DNS provider offers proxying. After GitHub provisions the certificate, enable **Enforce HTTPS** in Pages settings. The site works both at a project subpath and at the custom-domain root, using relative local asset/module paths. Pages/domain settings are administrative configuration, separate from the publishing workflow.

GitHub's [REST search documentation](https://docs.github.com/en/rest/search/search) describes result/scope caps and incomplete results; its [rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) describes primary and secondary allowances.
