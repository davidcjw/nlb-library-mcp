import { describe, it, expect, vi, afterEach } from "vitest";
import { NlbClient, NlbApiError, mapTitle, mapAvailability } from "../src/nlb.js";
import { isOnShelf, normaliseStatus, AGE_BANDS } from "../src/codes.js";
import { cosine } from "../src/similarity.js";

function mockFetch(payload: unknown, ok = true, status = 200) {
  return vi.fn(async (url: URL) => ({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    _url: url,
  })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("response mappers (defensive casing)", () => {
  it("maps a camelCase title", () => {
    const t = mapTitle({ brn: 123, title: "The Gruffalo", author: "Julia Donaldson", publishDate: "1999" });
    expect(t.brn).toBe(123);
    expect(t.title).toBe("The Gruffalo");
    expect(t.author).toBe("Julia Donaldson");
    expect(t.publishYear).toBe("1999");
  });

  it("maps a PascalCase title and splits string subjects", () => {
    const t = mapTitle({ BRN: 9, TitleName: "Dino Facts", Subjects: "Dinosaurs; Paleontology" });
    expect(t.brn).toBe(9);
    expect(t.title).toBe("Dino Facts");
    expect(t.subjects).toEqual(["Dinosaurs", "Paleontology"]);
  });

  it("flattens live API object/array fields (format, language, summary)", () => {
    const t = mapTitle({
      brn: 300007556,
      title: "The Gruffalo",
      author: "Donaldson, Julia",
      format: { code: "1", name: "Book" },
      language: ["English"],
      summary: ["Mouse meets a Gruffalo."],
      subjects: ["Mice Juvenile fiction.", "Monsters Juvenile fiction."],
      publishDate: "2024.",
      isbns: ["9781035028399", "1035028395"],
    });
    expect(t.brn).toBe(300007556);
    expect(t.format).toBe("Book");
    expect(t.language).toBe("English");
    expect(t.summary).toBe("Mouse meets a Gruffalo.");
    expect(t.subjects).toEqual(["Mice Juvenile fiction.", "Monsters Juvenile fiction."]);
    expect(t.isbns).toEqual(["9781035028399", "1035028395"]);
  });

  it("never throws on empty/garbage input", () => {
    const t = mapTitle({});
    expect(t.brn).toBe(0);
    expect(t.title).toBe("Untitled");
  });

  it("derives onShelf from status text", () => {
    expect(mapAvailability({ branchName: "Bishan", status: "On Shelf" }).onShelf).toBe(true);
    expect(mapAvailability({ branchName: "Bishan", status: "On Loan" }).onShelf).toBe(false);
  });

  it("maps live availability items (location/status/usageLevel as objects)", () => {
    const b = mapAvailability({
      callNumber: "DON",
      media: { code: "BOOK", name: "Book" },
      usageLevel: { code: "JUNIOR PB", name: "Junior Picture Book" },
      location: { code: "AMKPL", name: "Ang Mo Kio Library" },
      status: { code: "In", name: "On Shelf" },
      transactionStatus: { code: "S", name: "Available" },
    });
    expect(b.branchName).toBe("Ang Mo Kio Library");
    expect(b.shelfLocation).toBe("Junior Picture Book");
    expect(b.callNumber).toBe("DON");
    expect(b.status).toBe("On Shelf");
    expect(b.onShelf).toBe(true);
  });
});

describe("status helpers", () => {
  it("isOnShelf", () => {
    expect(isOnShelf("On Shelf")).toBe(true);
    expect(isOnShelf("Available")).toBe(true);
    expect(isOnShelf("On Loan")).toBe(false);
    expect(isOnShelf(null)).toBe(false);
  });
  it("normaliseStatus", () => {
    expect(normaliseStatus("On Shelf")).toBe("On shelf");
    expect(normaliseStatus("Out")).toBe("On loan");
    expect(normaliseStatus("In-Transit")).toBe("In transit");
  });
});

describe("age bands", () => {
  it("each band maps to juvenile audience + shelf levels", () => {
    for (const band of Object.values(AGE_BANDS)) {
      expect(band.intendedAudiences).toContain("J");
      expect(band.usageLevels.length).toBeGreaterThan(0);
    }
  });
});

describe("NlbClient", () => {
  it("sends auth headers and parses search results", async () => {
    const fetchMock = mockFetch({ totalRecords: 1, titles: [{ brn: 5, title: "Matilda" }] });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NlbClient({ apiKey: "k", appCode: "a" });
    const res = await client.searchTitles({ keywords: "matilda", limit: 10 });

    expect(res.totalRecords).toBe(1);
    expect(res.titles[0].title).toBe("Matilda");
    const call = (fetchMock as any).mock.calls[0];
    const url: URL = call[0];
    expect(url.searchParams.get("Keywords")).toBe("matilda");
    expect(url.searchParams.get("Limit")).toBe("10");
    expect(call[1].headers["X-API-KEY"]).toBe("k");
    expect(call[1].headers["X-App-Code"]).toBe("a");
  });

  it("flattens nested records[] from the live search response", async () => {
    const fetchMock = mockFetch({
      totalRecords: 66,
      titles: [
        {
          title: "The Gruffalo",
          author: "Donaldson, Julia",
          records: [
            { brn: 300007556, format: { code: "1", name: "Book" }, language: ["English"], publishDate: "2024." },
          ],
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NlbClient({ apiKey: "k", appCode: "a", rateLimit: false });
    const res = await client.searchTitles({ keywords: "gruffalo" });

    expect(res.totalRecords).toBe(66);
    expect(res.titles[0].brn).toBe(300007556);
    expect(res.titles[0].title).toBe("The Gruffalo");
    expect(res.titles[0].author).toBe("Donaldson, Julia");
    expect(res.titles[0].format).toBe("Book");
  });

  it("joins array filters into comma lists and omits empties", async () => {
    const fetchMock = mockFetch({ titles: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NlbClient({ apiKey: "k", appCode: "a" });
    await client.searchTitles({ keywords: "x", intendedAudiences: ["J"], languages: [] });
    const url: URL = (fetchMock as any).mock.calls[0][0];
    expect(url.searchParams.get("IntendedAudiences")).toBe("J");
    expect(url.searchParams.has("Languages")).toBe(false);
  });

  it("throws NlbApiError on non-2xx", async () => {
    vi.stubGlobal("fetch", mockFetch({ message: "forbidden" }, false, 403));
    const client = new NlbClient({ apiKey: "k", appCode: "a" });
    await expect(client.searchTitles({ keywords: "x" })).rejects.toBeInstanceOf(NlbApiError);
  });

  it("parses availability items", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ items: [{ branchName: "Toa Payoh", status: "On Shelf", callNumber: "JF DON" }] }),
    );
    const client = new NlbClient({ apiKey: "k", appCode: "a" });
    const branches = await client.getAvailability(5);
    expect(branches[0].branchName).toBe("Toa Payoh");
    expect(branches[0].onShelf).toBe(true);
    expect(branches[0].callNumber).toBe("JF DON");
  });
});

describe("rate limiting", () => {
  function timingFetch(times: number[]) {
    return vi.fn(async () => {
      times.push(Date.now());
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ titles: [] }), text: async () => "{}" };
    }) as unknown as typeof fetch;
  }

  it("spaces request starts 1 second apart by default", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const times: number[] = [];
    vi.stubGlobal("fetch", timingFetch(times));
    const client = new NlbClient({ apiKey: "k", appCode: "a" });

    const done = Promise.all([
      client.searchTitles({ keywords: "a" }),
      client.searchTitles({ keywords: "b" }),
      client.searchTitles({ keywords: "c" }),
    ]);
    await vi.advanceTimersByTimeAsync(3000);
    await done;

    expect(times).toEqual([0, 1000, 2000]);
    vi.useRealTimers();
  });

  it("caps starts per rolling window (oldest must fall out first)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const times: number[] = [];
    vi.stubGlobal("fetch", timingFetch(times));
    // No min interval so spacing is governed purely by the 2-per-1000ms window.
    const client = new NlbClient({
      apiKey: "k",
      appCode: "a",
      rateLimit: { minIntervalMs: 0, maxPerWindow: 2, windowMs: 1000 },
    });

    const done = Promise.all([
      client.searchTitles({ keywords: "a" }),
      client.searchTitles({ keywords: "b" }),
      client.searchTitles({ keywords: "c" }),
    ]);
    await vi.advanceTimersByTimeAsync(1500);
    await done;

    // 3rd request waits until the 1st (t=0) leaves the 1000ms window.
    expect(times).toEqual([0, 0, 1000]);
    vi.useRealTimers();
  });

  it("retries on 429 then succeeds", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: { get: () => "0" }, // Retry-After: 0s
          json: async () => ({}),
          text: async () => "quota exceeded",
        };
      }
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ titles: [] }), text: async () => "{}" };
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const client = new NlbClient({ apiKey: "k", appCode: "a", rateLimit: false });
    await client.searchTitles({ keywords: "x" });
    expect(calls).toBe(2);
  });

  it("gives up after maxRetries 429s and throws NlbApiError(429)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: () => "0" },
      json: async () => ({}),
      text: async () => "quota exceeded",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const client = new NlbClient({ apiKey: "k", appCode: "a", rateLimit: false, maxRetries: 1 });
    await expect(client.searchTitles({ keywords: "x" })).rejects.toMatchObject({ status: 429 });
    expect((fetchMock as any).mock.calls.length).toBe(2); // initial + 1 retry
  });

  it("does not throttle when rateLimit is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const times: number[] = [];
    vi.stubGlobal("fetch", timingFetch(times));
    const client = new NlbClient({ apiKey: "k", appCode: "a", rateLimit: false });

    await Promise.all([
      client.searchTitles({ keywords: "a" }),
      client.searchTitles({ keywords: "b" }),
      client.searchTitles({ keywords: "c" }),
    ]);

    expect(times).toEqual([0, 0, 0]);
    vi.useRealTimers();
  });
});

describe("caching", () => {
  it("warms the details cache from search results (no GetTitleDetails request)", async () => {
    const fetchMock = mockFetch({
      totalRecords: 1,
      titles: [{ title: "Matilda", author: "Dahl", records: [{ brn: 5, format: { code: "1", name: "Book" } }] }],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NlbClient({ apiKey: "k", appCode: "a", rateLimit: false });

    await client.searchTitles({ keywords: "matilda" });
    const details = await client.getTitleDetails(5);

    expect(details?.title).toBe("Matilda");
    expect((fetchMock as any).mock.calls.length).toBe(1); // only the search call hit the network
  });

  it("serves repeated getTitleDetails from cache", async () => {
    const fetchMock = mockFetch({ brn: 9, title: "Holes" });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NlbClient({ apiKey: "k", appCode: "a", rateLimit: false });

    await client.getTitleDetails(9);
    await client.getTitleDetails(9);
    expect((fetchMock as any).mock.calls.length).toBe(1);
  });

  it("caches availability within TTL and refetches after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = mockFetch({ items: [{ location: { name: "Bishan" }, status: { name: "On Shelf" } }] });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NlbClient({
      apiKey: "k",
      appCode: "a",
      rateLimit: false,
      cache: { availabilityTtlMs: 1000 },
    });

    await client.getAvailability(5);
    await client.getAvailability(5); // within TTL → cached
    expect((fetchMock as any).mock.calls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(1100);
    await client.getAvailability(5); // expired → refetch
    expect((fetchMock as any).mock.calls.length).toBe(2);
    vi.useRealTimers();
  });

  it("does not cache when cache is disabled", async () => {
    const fetchMock = mockFetch({ items: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = new NlbClient({ apiKey: "k", appCode: "a", rateLimit: false, cache: false });

    await client.getAvailability(5);
    await client.getAvailability(5);
    expect((fetchMock as any).mock.calls.length).toBe(2);
  });
});

describe("cosine similarity", () => {
  it("is 1 for identical normalised vectors and 0 for orthogonal", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
});
