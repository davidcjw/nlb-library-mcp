// NLB Catalogue API code references.
// Source: https://openweb.nlb.gov.sg/api/References/Catalogue.html

/** Age band -> NLB IntendedAudiences / shelf usage-level codes used to filter children's titles. */
export const AGE_BANDS = {
  "0-3": {
    label: "Babies & toddlers (0-3)",
    // ELL = Early Literacy collection shelves
    usageLevels: ["ELL 0-3", "JUNIOR PB"],
    intendedAudiences: ["J"], // Juvenile
  },
  "4-6": {
    label: "Preschool / early reader (4-6)",
    usageLevels: ["ELL 4-6", "JUNIOR PB", "JUNIOR SF"],
    intendedAudiences: ["J"],
  },
  "7-12": {
    label: "Primary school (7-12)",
    usageLevels: ["JUNIOR", "JUNIOR SF"],
    intendedAudiences: ["J"],
  },
} as const;

export type AgeBand = keyof typeof AGE_BANDS;

/** Common bibliographic formats (C001) surfaced as a friendly material filter. */
export const MATERIAL_TYPES: Record<string, string> = {
  BOOK: "Book",
  BOOKPG: "Book (PG)",
  BT: "Talking Book (audio)",
  DVD: "DVD",
  VCD: "Video CD",
  CD: "Music CD",
  M: "Music Score",
  SER: "Serial / Magazine",
};

/**
 * Item transactional statuses (C003). We map raw status text to a simple
 * "is it on the shelf right now?" boolean for families.
 */
export function isOnShelf(status: string | undefined | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s.includes("on shelf") || s === "available" || s === "in" || s === "shelving";
}

/** Human-friendly status normalisation. */
export function normaliseStatus(status: string | undefined | null): string {
  if (!status) return "Unknown";
  const s = status.toLowerCase();
  if (s.includes("shelf") || s === "available" || s === "in") return "On shelf";
  if (s.includes("loan") || s === "out") return "On loan";
  if (s.includes("transit")) return "In transit";
  if (s.includes("hold") || s.includes("reserved")) return "On hold";
  if (s.includes("process") || s.includes("shelving")) return "Being processed";
  return status;
}
