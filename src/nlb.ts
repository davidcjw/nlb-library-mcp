// Thin client for the NLB Catalogue Search API (v2).
// Docs: https://data.gov.sg/datasets/d_6a8d81084dfcb26248545b8a91362ce6/view
// Auth: X-API-KEY + X-App-Code headers (request at https://go.gov.sg/nlblabs-form)

const BASE_URL = process.env.NLB_API_BASE_URL ?? "https://openweb.nlb.gov.sg/api/v2/Catalogue";

export interface NlbConfig {
  apiKey: string;
  appCode: string;
  baseUrl?: string;
  /**
   * Client-side rate limiting. NLB caps usage at 1 request/second and 15
   * requests/minute; we throttle locally so bursts queue instead of getting
   * rejected. Pass `false` to disable (e.g. in tests).
   */
  rateLimit?: RateLimitOptions | false;
  /**
   * How many times to retry a request that the server rejects with HTTP 429
   * (rate/quota exceeded), honouring any `Retry-After` header. Default 2.
   * The local limiter prevents most 429s, but a shared server-side quota can
   * still be hit (other processes, restarts), so we back off and retry.
   */
  maxRetries?: number;
  /**
   * In-memory response caching, keyed by BRN. Bibliographic details are
   * effectively immutable (long TTL); availability changes, so it gets a short
   * TTL. `searchTitles` also warms the details cache from its results, so a
   * follow-up `getTitleDetails` for a searched BRN costs no request. Pass
   * `false` to disable.
   */
  cache?: CacheOptions | false;
}

export interface CacheOptions {
  /** TTL for `getTitleDetails` entries. Default 24h (details rarely change). */
  detailsTtlMs?: number;
  /** TTL for `getAvailability` entries. Default 45000ms. */
  availabilityTtlMs?: number;
  /** Max entries per cache (LRU eviction). Default 500. */
  maxEntries?: number;
}

const DEFAULT_CACHE: Required<CacheOptions> = {
  detailsTtlMs: 24 * 60 * 60 * 1000,
  availabilityTtlMs: 45_000,
  maxEntries: 500,
};

/** Insertion-ordered TTL cache with LRU eviction (re-insert on read/write). */
class TtlCache<K, V> {
  private map = new Map<K, { value: V; expires: number }>();

  constructor(private ttlMs: number, private max: number) {}

  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key); // refresh recency
    this.map.set(key, e);
    return e.value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

export interface RateLimitOptions {
  /** Minimum gap between consecutive request starts. Default 1000ms (1/sec). */
  minIntervalMs?: number;
  /** Max request starts per rolling window. Default 15. */
  maxPerWindow?: number;
  /** Rolling window length. Default 60000ms (1 minute). */
  windowMs?: number;
}

const DEFAULT_RATE_LIMIT: Required<RateLimitOptions> = {
  minIntervalMs: 1000,
  maxPerWindow: 15,
  windowMs: 60_000,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) into ms.
 * Returns undefined if absent/unparseable. Capped at 60s to avoid pathological
 * waits if the server returns something extreme.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  let ms: number;
  if (Number.isFinite(secs)) {
    ms = secs * 1000;
  } else {
    const when = Date.parse(header);
    if (Number.isNaN(when)) return undefined;
    ms = when - Date.now();
  }
  return Math.max(0, Math.min(ms, 60_000));
}

/**
 * Serialises slot acquisition through a promise chain so concurrent callers
 * queue fairly, then spaces request *starts* to satisfy both a minimum interval
 * (1/sec) and a rolling-window cap (15/min).
 */
class RateLimiter {
  private readonly minIntervalMs: number;
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private starts: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(opts: Required<RateLimitOptions>) {
    this.minIntervalMs = opts.minIntervalMs;
    this.maxPerWindow = opts.maxPerWindow;
    this.windowMs = opts.windowMs;
  }

  /** Resolves when the caller may start its request. */
  acquire(): Promise<void> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    return prev.then(() => this.waitForSlot()).finally(release);
  }

  private async waitForSlot(): Promise<void> {
    this.prune(Date.now());
    let runAt = Date.now();
    if (this.starts.length) {
      runAt = Math.max(runAt, this.starts[this.starts.length - 1] + this.minIntervalMs);
    }
    if (this.starts.length >= this.maxPerWindow) {
      runAt = Math.max(runAt, this.starts[0] + this.windowMs);
    }
    const delay = runAt - Date.now();
    if (delay > 0) await sleep(delay);
    const now = Date.now();
    this.prune(now);
    this.starts.push(now);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.starts.length && this.starts[0] <= cutoff) this.starts.shift();
  }
}

export interface Title {
  brn: number;
  title: string;
  author?: string;
  publishYear?: string;
  format?: string;
  language?: string;
  subjects?: string[];
  isbns?: string[];
  summary?: string;
}

export interface BranchAvailability {
  branchName: string;
  shelfLocation?: string;
  callNumber?: string;
  status: string;
  onShelf: boolean;
}

export interface SearchParams {
  keywords?: string;
  title?: string;
  author?: string;
  subject?: string;
  isbn?: string;
  materialTypes?: string[];
  intendedAudiences?: string[];
  languages?: string[];
  fiction?: boolean;
  availabilityOnly?: boolean;
  sortFields?: "relevancy" | "newmaterials" | "publicationDate";
  limit?: number;
  offset?: number;
}

export class NlbApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "NlbApiError";
  }
}

export class NlbClient {
  private apiKey: string;
  private appCode: string;
  private baseUrl: string;
  private limiter: RateLimiter | null;
  private maxRetries: number;
  private detailsCache: TtlCache<number, Title> | null;
  private availabilityCache: TtlCache<number, BranchAvailability[]> | null;

  constructor(config: NlbConfig) {
    this.apiKey = config.apiKey;
    this.appCode = config.appCode;
    this.baseUrl = config.baseUrl ?? BASE_URL;
    this.limiter =
      config.rateLimit === false
        ? null
        : new RateLimiter({ ...DEFAULT_RATE_LIMIT, ...config.rateLimit });
    this.maxRetries = config.maxRetries ?? 2;
    const cache = config.cache === false ? null : { ...DEFAULT_CACHE, ...config.cache };
    this.detailsCache = cache ? new TtlCache(cache.detailsTtlMs, cache.maxEntries) : null;
    this.availabilityCache = cache ? new TtlCache(cache.availabilityTtlMs, cache.maxEntries) : null;
  }

  private async get(path: string, query: Record<string, unknown>): Promise<any> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) {
        if (v.length) url.searchParams.set(k, v.join(","));
      } else {
        url.searchParams.set(k, String(v));
      }
    }

    for (let attempt = 0; ; attempt++) {
      if (this.limiter) await this.limiter.acquire();

      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            "X-API-KEY": this.apiKey,
            "X-App-Code": this.appCode,
            Accept: "application/json",
          },
        });
      } catch (e) {
        throw new NlbApiError(`Network error calling NLB API: ${(e as Error).message}`);
      }

      if (res.ok) return res.json();

      // Back off and retry on 429 (rate/quota exceeded) while attempts remain.
      if (res.status === 429 && attempt < this.maxRetries) {
        const wait = parseRetryAfter(res.headers.get("retry-after")) ?? 1000 * 2 ** attempt;
        await sleep(wait);
        continue;
      }

      const body = await res.text().catch(() => "");
      throw new NlbApiError(
        `NLB API ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
        res.status,
      );
    }
  }

  async searchTitles(params: SearchParams): Promise<{ totalRecords: number; titles: Title[] }> {
    const raw = await this.get("/SearchTitles", {
      Keywords: params.keywords,
      Title: params.title,
      Author: params.author,
      Subject: params.subject,
      ISBN: params.isbn,
      MaterialTypes: params.materialTypes,
      IntendedAudiences: params.intendedAudiences,
      Languages: params.languages,
      Fiction: params.fiction,
      Availability: params.availabilityOnly,
      SortFields: params.sortFields,
      Limit: params.limit ?? 20,
      Offset: params.offset ?? 0,
    });
    // Each title groups one or more bibliographic `records` (editions/formats);
    // the BRN and most metadata live on the record, the clean title/author on
    // the group. We surface the first record merged with its group so every
    // result has a usable BRN. (Older/guessed payloads put fields on the group
    // itself and have no `records`; the merge handles that too.)
    const groups = raw.titles ?? raw.Titles ?? [];
    const titles = groups.map((g: any) => {
      const record = (g.records ?? g.Records ?? [])[0] ?? {};
      return mapTitle({ ...g, ...record });
    });
    // Warm the details cache: a follow-up check_availability/recommend_similar
    // on a searched BRN then needs no GetTitleDetails request.
    if (this.detailsCache) {
      for (const t of titles) if (t.brn) this.detailsCache.set(t.brn, t);
    }
    return { totalRecords: raw.totalRecords ?? raw.TotalRecords ?? 0, titles };
  }

  async getTitleDetails(brn: number): Promise<Title | null> {
    const cached = this.detailsCache?.get(brn);
    if (cached) return cached;
    const raw = await this.get("/GetTitleDetails", { BRN: brn });
    if (!raw || (!raw.brn && !raw.BRN && !raw.title && !raw.titleName)) return null;
    const title = mapTitle(raw);
    this.detailsCache?.set(brn, title);
    return title;
  }

  async getAvailability(brn: number): Promise<BranchAvailability[]> {
    const cached = this.availabilityCache?.get(brn);
    if (cached) return cached;
    const raw = await this.get("/GetAvailabilityInfo", { BRN: brn });
    const items: BranchAvailability[] = (raw.items ?? raw.Items ?? []).map(mapAvailability);
    this.availabilityCache?.set(brn, items);
    return items;
  }
}

// --- response mappers (the API is inconsistent about casing, so we are defensive) ---

function pick<T = string>(obj: any, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj?.[k] !== null && obj?.[k] !== "") return obj[k];
  }
  return undefined;
}

/**
 * Coerce a field to a display string. The live API returns the same logical
 * value as a plain string, an array of strings (e.g. `summary`, `language`),
 * or a `{ code, name }` object (e.g. `format`, `status`, `location`) depending
 * on the endpoint — so we flatten all three to text.
 */
function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (Array.isArray(v)) {
    const parts = v.map(text).filter(Boolean) as string[];
    return parts.length ? parts.join("; ") : undefined;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return text(o.name ?? o.Name) ?? text(o.code ?? o.Code);
  }
  return String(v);
}

export function mapTitle(raw: any): Title {
  const subjectsRaw = pick<any>(raw, "subjects", "Subjects", "subject");
  const isbnsRaw = pick<any>(raw, "isbns", "ISBNs", "isbn");
  return {
    brn: Number(pick(raw, "brn", "BRN") ?? 0),
    title: String(text(pick(raw, "title", "titleName", "Title", "TitleName")) ?? "Untitled"),
    author: text(pick(raw, "author", "Author")),
    publishYear: text(pick(raw, "publishDate", "PublishDate", "publishYear", "issuedDate")),
    format: text(pick(raw, "format", "Format", "materialType", "MaterialType")),
    language: text(pick(raw, "language", "Language")),
    summary: text(pick(raw, "summary", "Summary", "notes")),
    subjects: Array.isArray(subjectsRaw)
      ? subjectsRaw.map((s) => (typeof s === "string" ? s : s?.name ?? s?.subjectName)).filter(Boolean)
      : typeof subjectsRaw === "string"
        ? subjectsRaw.split(/[;|]/).map((s: string) => s.trim()).filter(Boolean)
        : undefined,
    isbns: Array.isArray(isbnsRaw) ? isbnsRaw.map(String) : isbnsRaw ? [String(isbnsRaw)] : undefined,
  };
}

export function mapAvailability(raw: any): BranchAvailability {
  const status = text(pick(raw, "status", "Status", "transactionStatus")) ?? "";
  return {
    branchName: text(pick(raw, "branchName", "BranchName", "location", "Location")) ?? "Unknown branch",
    shelfLocation: text(pick(raw, "usageLevel", "UsageLevel", "shelfLocation", "collectionCode")),
    callNumber: text(pick(raw, "callNumber", "CallNumber", "formattedCallNumber")),
    status,
    onShelf: /on shelf|available|^in$|shelving/i.test(status),
  };
}
