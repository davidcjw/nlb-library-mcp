# Next Steps

_Handoff notes. Last updated: 2026-06-27._

## ⛔ Blocker: live smoke test needs real NLB credentials

The server has **never been run against the live NLB API.** Every test in `test/nlb.test.ts`
mocks `fetch` with payloads shaped to **our own assumptions** — so the suite passes, but it
proves nothing about whether the real API response shape matches our mappers. This is the
single biggest unknown and must be resolved before calling the project "working".

**To unblock:** request free credentials via the
[NLB Open Web Service Application Form](https://go.gov.sg/nlblabs-form). You'll get an
**API key** and **app code**. (As of this handoff we do not have them.)

## Smoke test plan (once credentials arrive)

1. Put credentials in the environment:
   ```bash
   export NLB_API_KEY="..."
   export NLB_APP_CODE="..."
   ```
2. Run the server from source and exercise each tool through an MCP client (Claude Desktop,
   or `npx @modelcontextprotocol/inspector npx tsx src/index.ts`):
   - `search_books` with `query: "Matilda"` → expect titles with real BRNs.
   - `check_availability` with a BRN from the search → expect branch list + statuses.
   - `find_kids_books` with `ageBand: "4-6", topic: "dinosaurs"`.
   - `recommend_similar` with a BRN → expect the embedding model to download once (~25 MB)
     then return ranked matches. Confirm graceful fallback if `@xenova/transformers` is absent.
3. **Verify the real response shapes against our mappers** — this is the whole point:
   - `mapTitle` / `mapAvailability` in `src/nlb.ts` guess at field names/casing
     (`brn`/`BRN`, `title`/`titleName`, `subjects` as array vs `;`-delimited string,
     availability under `items`/`Items`, etc.). Capture a raw JSON response from each
     endpoint (`/SearchTitles`, `/GetTitleDetails`, `/GetAvailabilityInfo`) and confirm the
     actual keys are covered. Add any missing aliases to the `pick(...)` calls.
   - Confirm `totalRecords` / `titles` envelope keys are right for `searchTitles`.
   - Confirm `onShelf` detection (`mapAvailability` regex + `normaliseStatus` in
     `src/codes.ts`) matches the real status vocabulary the API returns.
   - Confirm the age-band filter codes in `AGE_BANDS` (`src/codes.ts`) actually filter
     juvenile results as intended (`IntendedAudiences`, usage levels).
4. **Capture real fixtures**: save a couple of sanitised real responses and add a test that
   maps them, so future regressions are caught without a live key.

## Other open items (non-blocking)

- **Demo GIF** — `README.md` references `docs/demo.gif` (placeholder). Record a short clip of
  an assistant calling the tools and drop it at that path.
- **Publish to GitHub** — repo has no git remote yet. After pushing, set the About blurb and
  topics (suggested commands are in the README/opensource-readme handoff):
  ```bash
  gh repo edit --description "MCP server for Singapore's NLB library catalogue — search books, check branch availability, find kids' books, AI similar-book recs"
  gh repo edit --add-topic mcp,model-context-protocol,nlb,singapore,library,books,typescript,nodejs,claude,ai,embeddings
  ```
- **LICENSE copyright holder** — currently "David" (from `git config user.name`). Replace with
  full name/handle if desired.
- **npm publish** (optional) — `package.json` has a `bin` entry; if publishing, double-check
  `files`, `prepare` build, and the package name availability.

## Useful references

- API docs: https://data.gov.sg/datasets/d_6a8d81084dfcb26248545b8a91362ce6/view
- Code references (material/audience/status codes): https://openweb.nlb.gov.sg/api/References/Catalogue.html
- Repo map: see `CODEBASE.md`.
