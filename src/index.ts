#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NlbClient, NlbApiError, type Title } from "./nlb.js";
import { AGE_BANDS, type AgeBand, normaliseStatus } from "./codes.js";
import { rankBySimilarity } from "./similarity.js";

function makeClient(): NlbClient {
  const apiKey = process.env.NLB_API_KEY;
  const appCode = process.env.NLB_APP_CODE;
  if (!apiKey || !appCode) {
    throw new Error(
      "Missing NLB credentials. Set NLB_API_KEY and NLB_APP_CODE environment variables " +
        "(request them at https://go.gov.sg/nlblabs-form).",
    );
  }
  return new NlbClient({ apiKey, appCode });
}

function titleLine(t: Title): string {
  const bits = [t.author, t.publishYear, t.format, t.language].filter(Boolean).join(" · ");
  return `• [BRN ${t.brn}] ${t.title}${bits ? ` — ${bits}` : ""}`;
}

function embedText(t: Title): string {
  return [t.title, t.author, (t.subjects ?? []).join(", "), t.summary].filter(Boolean).join(". ");
}

/** Wrap a handler so API/credential errors surface as readable MCP tool errors. */
async function safe(fn: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await fn() }] };
  } catch (e) {
    const msg = e instanceof NlbApiError ? `NLB API error: ${e.message}` : (e as Error).message;
    return { content: [{ type: "text" as const, text: msg }], isError: true };
  }
}

const server = new McpServer({ name: "nlb-library-mcp", version: "0.1.0" });

// 1. search_books -------------------------------------------------------------
server.tool(
  "search_books",
  "Search the Singapore NLB catalogue for physical library items by title, author, keyword, ISBN, or subject. Returns matching titles with their BRN (use it with check_availability). Supports filters for material type, language, fiction/non-fiction and sorting.",
  {
    query: z.string().optional().describe("Free-text keywords (title, author, topic). Provide this OR one of the specific fields below."),
    title: z.string().optional().describe("Match against the title only."),
    author: z.string().optional().describe("Match against the author only."),
    subject: z.string().optional().describe("Match against subject headings only."),
    isbn: z.string().optional().describe("Look up by ISBN."),
    fiction: z.boolean().optional().describe("true = fiction only, false = non-fiction only."),
    language: z.string().optional().describe("Language name, e.g. 'English', 'Chinese'."),
    availableOnly: z.boolean().optional().describe("Only return titles with at least one available copy."),
    sort: z.enum(["relevancy", "newmaterials", "publicationDate"]).optional(),
    limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)."),
  },
  async (args) => {
    return safe(async () => {
      if (!args.query && !args.title && !args.author && !args.subject && !args.isbn) {
        return "Provide at least one of: query, title, author, subject, or isbn.";
      }
      const client = makeClient();
      const { totalRecords, titles } = await client.searchTitles({
        keywords: args.query,
        title: args.title,
        author: args.author,
        subject: args.subject,
        isbn: args.isbn,
        fiction: args.fiction,
        languages: args.language ? [args.language] : undefined,
        availabilityOnly: args.availableOnly,
        sortFields: args.sort,
        limit: args.limit ?? 20,
      });
      if (!titles.length) return "No titles found. Try broader keywords or fewer filters.";
      const header = `Found ${totalRecords} title(s), showing ${titles.length}:`;
      return [header, ...titles.map(titleLine)].join("\n");
    });
  },
);

// 2. check_availability -------------------------------------------------------
server.tool(
  "check_availability",
  "Check which NLB library branches currently have a specific book on the shelf, with shelf location and call number. Use the BRN returned by search_books. This is what to call before heading to the library.",
  {
    brn: z.number().int().describe("The book's BRN (from search_books)."),
    availableOnly: z.boolean().optional().describe("Only show branches where it's on the shelf now (default true)."),
  },
  async (args) => {
    return safe(async () => {
      const client = makeClient();
      const [details, branches] = await Promise.all([
        client.getTitleDetails(args.brn).catch(() => null),
        client.getAvailability(args.brn),
      ]);
      const titleName = details?.title ? `"${details.title}"` : `BRN ${args.brn}`;
      if (!branches.length) return `No availability information found for ${titleName}.`;

      const wantOnly = args.availableOnly ?? true;
      const onShelf = branches.filter((b) => b.onShelf);
      const show = wantOnly ? onShelf : branches;

      const lines = show.map((b) => {
        const where = [b.shelfLocation, b.callNumber].filter(Boolean).join(" · ");
        return `• ${b.branchName} — ${normaliseStatus(b.status)}${where ? ` (${where})` : ""}`;
      });

      const summary = `${titleName}: ${onShelf.length} of ${branches.length} copies on the shelf now.`;
      if (wantOnly && !onShelf.length) {
        return `${summary}\nNone available right now — call again with availableOnly=false to see all ${branches.length} copies and their status.`;
      }
      return [summary, ...lines].join("\n");
    });
  },
);

// 3. find_kids_books ----------------------------------------------------------
server.tool(
  "find_kids_books",
  "Find children's books for a given age band, optionally on a topic. A shortcut for parents that applies NLB's juvenile/early-literacy shelf filters automatically. Age bands: '0-3' (babies & toddlers), '4-6' (preschool), '7-12' (primary school).",
  {
    ageBand: z.enum(["0-3", "4-6", "7-12"]).describe("Child's age band."),
    topic: z.string().optional().describe("Optional topic/interest, e.g. 'dinosaurs', 'friendship', 'space'."),
    availableOnly: z.boolean().optional().describe("Only titles with an available copy."),
    limit: z.number().int().min(1).max(50).optional(),
  },
  async (args) => {
    return safe(async () => {
      const band = AGE_BANDS[args.ageBand as AgeBand];
      const client = makeClient();
      const { totalRecords, titles } = await client.searchTitles({
        keywords: args.topic,
        subject: args.topic ? undefined : "children",
        intendedAudiences: [...band.intendedAudiences],
        availabilityOnly: args.availableOnly,
        sortFields: "relevancy",
        limit: args.limit ?? 20,
      });
      if (!titles.length) {
        return `No ${band.label} titles found${args.topic ? ` on "${args.topic}"` : ""}. Try a different topic.`;
      }
      const header = `${band.label}${args.topic ? ` · "${args.topic}"` : ""} — ${totalRecords} title(s), showing ${titles.length}:`;
      return [header, ...titles.map(titleLine)].join("\n");
    });
  },
);

// 4. recommend_similar --------------------------------------------------------
server.tool(
  "recommend_similar",
  "Given a book a reader enjoyed (by BRN or title), recommend semantically similar titles from the NLB catalogue. Pulls the seed book's subjects, gathers candidates, and re-ranks them using local AI sentence-embeddings (cosine similarity). Great for 'my child loved X, what's next?'.",
  {
    brn: z.number().int().optional().describe("BRN of the seed book (preferred). Provide this OR title."),
    title: z.string().optional().describe("Title of the seed book if you don't have its BRN."),
    limit: z.number().int().min(1).max(20).optional().describe("Number of recommendations (default 8)."),
  },
  async (args) => {
    return safe(async () => {
      const client = makeClient();

      // Resolve the seed book.
      let seed: Title | null = null;
      if (args.brn) {
        seed = await client.getTitleDetails(args.brn);
      } else if (args.title) {
        const r = await client.searchTitles({ title: args.title, limit: 1 });
        seed = r.titles[0] ?? null;
      } else {
        return "Provide either brn or title of the book to find similar reads for.";
      }
      if (!seed) return "Could not find that seed book in the catalogue.";

      // Gather candidates from the seed's subjects (fall back to its title keywords).
      const subjectQuery = (seed.subjects ?? []).slice(0, 3).join(" ") || seed.title;
      const { titles } = await client.searchTitles({
        keywords: subjectQuery,
        sortFields: "relevancy",
        limit: 40,
      });
      const candidates = titles.filter((t) => t.brn !== seed!.brn);
      if (!candidates.length) return `Found no related titles for "${seed.title}".`;

      const n = args.limit ?? 8;
      const ranked = await rankBySimilarity(embedText(seed), candidates, embedText);

      const seedLine = `Because you liked "${seed.title}"${seed.author ? ` by ${seed.author}` : ""}:`;
      if (!ranked) {
        // Embedding model unavailable — return catalogue-relevance order with a note.
        const list = candidates.slice(0, n).map(titleLine);
        return [seedLine + " (AI ranking unavailable — showing catalogue relevance order)", ...list].join("\n");
      }
      const list = ranked
        .slice(0, n)
        .map(({ item, score }) => `${titleLine(item)}  [match ${(score * 100).toFixed(0)}%]`);
      return [seedLine, ...list].join("\n");
    });
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("nlb-library-mcp running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
