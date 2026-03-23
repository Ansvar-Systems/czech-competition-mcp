/**
 * Ingestion crawler for the UOHS (Urad pro ochranu hospodarske souteze /
 * Czech Office for the Protection of Competition) MCP server.
 *
 * Scrapes competition enforcement decisions and merger control decisions
 * from uohs.gov.cz and populates the SQLite database.
 *
 * Data sources:
 *   - Paginated decision listing (uohs.gov.cz/cs/hospodarska-soutez/sbirky-rozhodnuti/{page}.html)
 *   - Individual decision detail pages (/cs/hospodarska-soutez/sbirky-rozhodnuti/detail-{id}.html)
 *   - PDF decision documents (/download/sbirky_rozhodnuti/dokumenty/{year}_{ref}.pdf)
 *
 * Content is in Czech. The UOHS publishes decisions covering:
 *   - Kartelove dohody (cartel agreements)
 *   - Zneuziti dominantniho postaveni (abuse of dominance)
 *   - Spojovani soutezielu / fuze (merger control)
 *   - Sektorova setreni (sector inquiries)
 *   - Vertikalni dohody (vertical agreements)
 *
 * The decisions collection contains ~2,700+ decisions with the URL pattern
 * /cs/hospodarska-soutez/sbirky-rozhodnuti.html for page 1, then
 * /cs/hospodarska-soutez/sbirky-rozhodnuti/2.html for subsequent pages.
 * Each detail page has a numeric ID in the URL (detail-{id}.html).
 *
 * Usage:
 *   npx tsx scripts/ingest-uohs.ts
 *   npx tsx scripts/ingest-uohs.ts --dry-run
 *   npx tsx scripts/ingest-uohs.ts --resume
 *   npx tsx scripts/ingest-uohs.ts --force
 *   npx tsx scripts/ingest-uohs.ts --max-pages 10
 */

import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["CZ_COMP_DB_PATH"] ?? "data/uohs.db";
const STATE_FILE = join(dirname(DB_PATH), "ingest-state.json");
const BASE_URL = "https://uohs.gov.cz";
const LISTING_BASE = "/cs/hospodarska-soutez/sbirky-rozhodnuti";
const MAX_LISTING_PAGES = 300; // ~275 pages at 10/page for ~2,700 decisions
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const USER_AGENT =
  "AnsvarUOHSCrawler/1.0 (+https://github.com/Ansvar-Systems/czech-competition-mcp)";

// CLI flags
const dryRun = process.argv.includes("--dry-run");
const resume = process.argv.includes("--resume");
const force = process.argv.includes("--force");
const maxPagesArg = process.argv.find((_, i, a) => a[i - 1] === "--max-pages");
const maxPages = maxPagesArg ? parseInt(maxPagesArg, 10) : MAX_LISTING_PAGES;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IngestState {
  processedUrls: string[];
  lastRun: string;
  decisionsIngested: number;
  mergersIngested: number;
  errors: string[];
}

interface ListingEntry {
  title: string;
  url: string;
  date: string | null;
  caseRef: string | null;
  detailId: string | null;
}

interface ParsedDecision {
  case_number: string;
  title: string;
  date: string | null;
  type: string | null;
  sector: string | null;
  parties: string | null;
  summary: string | null;
  full_text: string;
  outcome: string | null;
  fine_amount: number | null;
  competition_articles: string | null;
  status: string;
}

interface ParsedMerger {
  case_number: string;
  title: string;
  date: string | null;
  sector: string | null;
  acquiring_party: string | null;
  target: string | null;
  summary: string | null;
  full_text: string;
  outcome: string | null;
  turnover: number | null;
}

interface SectorAccumulator {
  [id: string]: {
    name: string;
    name_en: string | null;
    description: string | null;
    decisionCount: number;
    mergerCount: number;
  };
}

// ---------------------------------------------------------------------------
// HTTP fetching with rate limiting and retries
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<string | null> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 403 || response.status === 429) {
        console.warn(
          `  [WARN] HTTP ${response.status} for ${url} (attempt ${attempt}/${MAX_RETRIES})`,
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        return null;
      }

      if (!response.ok) {
        console.warn(`  [WARN] HTTP ${response.status} for ${url}`);
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        return null;
      }

      return await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [WARN] Fetch error for ${url} (attempt ${attempt}/${MAX_RETRIES}): ${message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// State management (for --resume)
// ---------------------------------------------------------------------------

function loadState(): IngestState {
  if (resume && existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      return JSON.parse(raw) as IngestState;
    } catch {
      console.warn("[WARN] Could not read state file, starting fresh.");
    }
  }
  return {
    processedUrls: [],
    lastRun: new Date().toISOString(),
    decisionsIngested: 0,
    mergersIngested: 0,
    errors: [],
  };
}

function saveState(state: IngestState): void {
  state.lastRun = new Date().toISOString();
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Listing page parsing -- discover decision URLs
// ---------------------------------------------------------------------------

/**
 * Parse a single listing page and extract decision entries.
 *
 * The UOHS listing at /cs/hospodarska-soutez/sbirky-rozhodnuti renders
 * ~10 decisions per page. Each entry has a link to a detail page
 * (/cs/hospodarska-soutez/sbirky-rozhodnuti/detail-{id}.html), a case
 * number (cislo jednaci / spisova znacka), parties, and a date.
 *
 * Pagination: page 1 is sbirky-rozhodnuti.html, page N is
 * sbirky-rozhodnuti/{N}.html.
 */
function parseListingPage(html: string): ListingEntry[] {
  const $ = cheerio.load(html);
  const entries: ListingEntry[] = [];
  const seen = new Set<string>();

  // Detail page links follow the pattern /cs/hospodarska-soutez/sbirky-rozhodnuti/detail-{id}.html
  // They may also appear under /cs/verejne-zakazky/sbirky-rozhodnuti/detail-{id}.html
  // We only want the hospodarska-soutez (competition) ones.
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href") ?? "";

    // Match competition decision detail links
    const detailMatch = href.match(
      /\/cs\/hospodarska-soutez\/sbirky-rozhodnuti\/detail-(\d+)\.html/,
    );
    if (!detailMatch) return;

    const detailId = detailMatch[1]!;
    const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;

    if (seen.has(fullUrl)) return;
    seen.add(fullUrl);

    // The link text often contains the case matter/title.
    const linkText = $(el).text().trim();

    // Try to find metadata near this link: case number, date, parties.
    // UOHS listing entries display structured text blocks near the link.
    const parent = $(el).closest("div, li, article, tr, p");
    const parentText = parent.length > 0 ? parent.text() : "";
    // Also check the broader surrounding context (sibling elements)
    const grandParent = parent.parent();
    const contextText = grandParent.length > 0 ? grandParent.text() : parentText;

    // Extract case reference (spisova znacka or cislo jednaci)
    const caseRef = extractCaseRef(contextText);
    const date = extractDateFromContext(contextText);

    const title = linkText.length > 3 ? linkText : `UOHS rozhodnuti ${detailId}`;

    entries.push({
      title,
      url: fullUrl,
      date,
      caseRef,
      detailId,
    });
  });

  return entries;
}

/**
 * Extract a UOHS case reference from text.
 *
 * UOHS uses two identifiers:
 *   - Spisova znacka (file mark): S0126/2021/KS, S0629/2024/DP, S0001/2024/KD
 *   - Cislo jednaci: 13117/2021/873/DVa, 07094/2026/872
 *
 * The spisova znacka is more stable and used as the primary identifier.
 * Department suffixes: KS (competition general), KD (cartel),
 * DP (dominance/abuse), VS (public procurement).
 */
function extractCaseRef(text: string): string | null {
  // Spisova znacka pattern: S followed by digits, slashes, and department code
  // e.g. S0126/2021/KS, S0629/2024/DP, S0001/2024/KD
  const szMatch = text.match(/S\d{3,5}\/\d{4}\/[A-Z]{2,4}/);
  if (szMatch) return szMatch[0];

  // Cislo jednaci pattern: digits/year/digits
  // e.g. 13117/2021/873/DVa, 07466/2026/500
  const cjMatch = text.match(/\d{4,5}\/\d{4}\/\d{3}/);
  if (cjMatch) return cjMatch[0];

  // UOHS-prefixed format from older references
  // e.g. UOHS-S0001/2024/KD
  const uohsMatch = text.match(/UOHS-S\d{3,5}\/\d{4}\/[A-Z]{2,4}/);
  if (uohsMatch) return uohsMatch[0];

  return null;
}

// ---------------------------------------------------------------------------
// Date parsing -- handles Czech date formats
// ---------------------------------------------------------------------------

const CZ_MONTH_MAP: Record<string, string> = {
  ledna: "01",
  "únor": "02",
  "února": "02",
  "březen": "03",
  "března": "03",
  "duben": "04",
  dubna: "04",
  "květen": "05",
  "května": "05",
  "červen": "06",
  "června": "06",
  "červenec": "07",
  "července": "07",
  srpen: "08",
  srpna: "08",
  "září": "09",
  "říjen": "10",
  "října": "10",
  listopad: "11",
  listopadu: "11",
  prosinec: "12",
  prosince: "12",
  // Nominative forms
  leden: "01",
};

/**
 * Parse a Czech date string to ISO format (YYYY-MM-DD).
 *
 * Handles:
 *   - "19. 4. 2021"  (dd. m. yyyy — most common on UOHS)
 *   - "19.04.2021"   (dd.mm.yyyy)
 *   - "13. 3. 2026"
 *   - "1. ledna 2024" (dd. month-name yyyy)
 *   - "2024-03-15"   (ISO)
 */
function parseDate(raw: string): string | null {
  if (!raw) return null;

  const trimmed = raw.trim();

  // ISO format already
  const isoMatch = trimmed.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[0];

  // Czech numeric: "19. 4. 2021" or "19.04.2021" or "13. 3. 2026"
  // The UOHS format uses spaces around the dots: "dd. m. yyyy"
  const czNumeric = trimmed.match(
    /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/,
  );
  if (czNumeric) {
    const [, day, month, year] = czNumeric;
    return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  }

  // Czech text: "1. ledna 2024", "15. brezna 2023"
  const czText = trimmed.match(
    /(\d{1,2})\.\s*([a-zA-Z\u00c0-\u017e]+)\s+(\d{4})/,
  );
  if (czText) {
    const [, day, monthName, year] = czText;
    const monthNum = CZ_MONTH_MAP[monthName!.toLowerCase()];
    if (monthNum) {
      return `${year}-${monthNum}-${day!.padStart(2, "0")}`;
    }
  }

  // dd/mm/yyyy
  const slashDate = trimmed.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashDate) {
    const [, day, month, year] = slashDate;
    return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  }

  return null;
}

/** Try to find a date in surrounding context text. */
function extractDateFromContext(text: string): string | null {
  // UOHS listing shows dates like "19. 4. 2021" or "Datum nabytí právní moci: 23. 2. 2026"
  const datePattern = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/;
  const match = text.match(datePattern);
  if (match) return parseDate(match[0]);

  // Czech month name format
  const monthNames = Object.keys(CZ_MONTH_MAP).join("|");
  const textDateRe = new RegExp(
    `(\\d{1,2})\\.\\s*(${monthNames})\\s+(\\d{4})`,
    "i",
  );
  const textMatch = text.match(textDateRe);
  if (textMatch) return parseDate(textMatch[0]);

  return null;
}

// ---------------------------------------------------------------------------
// Detail page parsing -- extract structured data
// ---------------------------------------------------------------------------

/**
 * Extract metadata fields from a UOHS decision detail page.
 *
 * UOHS detail pages present metadata with bold labels (using <strong> tags):
 *   - cislo jednaci: (case number)
 *   - spisova znacka: (file reference)
 *   - Instance: (court level — I. or II.)
 *   - Vec: (matter/subject)
 *   - Ucastnici: (parties — numbered list)
 *   - Typ spravniho rizeni: (proceeding type)
 *   - Vyrok: (ruling/outcome)
 *   - Rok: (year)
 *   - Datum nabyti pravni moci: (date of legal effect)
 *
 * The body text of the decision follows after the metadata, with sections
 * like Oduvodneni (reasoning) and Pouceni (instructions/appeal info).
 */
function extractMetadata(
  $: cheerio.CheerioAPI,
): Record<string, string> {
  const meta: Record<string, string> = {};

  // The UOHS pages use <strong> labels followed by text content.
  // We extract all bold labels and their adjacent text.
  const pageText = $("body").text();

  // Extract key metadata fields using regex on the full page text
  const fieldPatterns: Array<{ key: string; pattern: RegExp }> = [
    {
      key: "cislo_jednaci",
      pattern: /[Čč][Íí]slo\s+jednac[ií]\s*:\s*(.+?)(?=\n|spisov|$)/i,
    },
    {
      key: "spisova_znacka",
      pattern: /[Ss]pisov[áa]\s+zna[čc]ka\s*:\s*(.+?)(?=\n|Instance|$)/i,
    },
    {
      key: "instance",
      pattern: /Instance\s*:\s*(I{1,2}\.?)\s/i,
    },
    {
      key: "vec",
      pattern: /[Vv][ěe]c\s*:\s*(.+?)(?=\n[ÚU][čc]astn|$)/i,
    },
    {
      key: "ucastnici",
      pattern: /[ÚU][čc]astn[ií]c[ií]\s*:\s*([\s\S]+?)(?=Typ\s+spr[áa]vn|$)/i,
    },
    {
      key: "typ_rizeni",
      pattern:
        /Typ\s+spr[áa]vn[ií]ho\s+[řr][ií]zen[ií]\s*:\s*(.+?)(?=\n|V[ýy]rok|$)/i,
    },
    {
      key: "vyrok",
      pattern: /[Vv][ýy]rok\s*:\s*(.+?)(?=\n|Rok|$)/i,
    },
    {
      key: "rok",
      pattern: /Rok\s*:\s*(\d{4})/i,
    },
    {
      key: "datum_pravni_moci",
      pattern:
        /Datum\s+nabyt[ií]\s+pr[áa]vn[ií]\s+moci\s*:\s*(.+?)(?=\n|$)/i,
    },
  ];

  for (const { key, pattern } of fieldPatterns) {
    const match = pageText.match(pattern);
    if (match?.[1]) {
      meta[key] = match[1].trim();
    }
  }

  // Also try extracting from <strong> label patterns in the HTML
  $("strong, b").each((_i, el) => {
    const labelText = $(el).text().trim().replace(/:$/, "").toLowerCase();
    const parent = $(el).parent();
    if (!parent.length) return;

    const fullParentText = parent.text().trim();
    const labelIndex = fullParentText.indexOf($(el).text().trim());
    if (labelIndex === -1) return;

    const afterLabel = fullParentText
      .slice(labelIndex + $(el).text().trim().length)
      .replace(/^[:\s]+/, "")
      .trim()
      .split("\n")[0]
      ?.trim();

    if (!afterLabel || afterLabel.length === 0) return;

    if (labelText.includes("pokut") || labelText.includes("sankc")) {
      meta["pokuta"] = afterLabel;
    }
  });

  return meta;
}

/**
 * Extract the main body text (rozhodnuti + oduvodneni) from a detail page.
 *
 * UOHS pages have the decision text in the main content area after the
 * metadata section. The text includes the ruling (rozhodnuti), reasoning
 * (oduvodneni), and appeal instructions (pouceni).
 */
function extractBodyText($: cheerio.CheerioAPI): string {
  // Remove navigation, header, footer, scripts
  const clone = $.root().clone();
  const $c = cheerio.load(clone.html() ?? "");
  $c("nav, header, footer, script, style, .menu, .breadcrumb, .pager").remove();

  // Try known content selectors for UOHS pages
  const selectors = [
    ".content .field--name-body",
    ".content article",
    ".node__content",
    "#content",
    "main .content",
    ".content-area",
    "main article",
    "main",
  ];

  for (const sel of selectors) {
    const el = $c(sel);
    if (el.length > 0) {
      const text = el.text().trim();
      if (text.length > 100) return cleanText(text);
    }
  }

  // Fallback: collect all paragraph text
  const paragraphs: string[] = [];
  $c("p").each((_i, el) => {
    const text = $c(el).text().trim();
    if (text.length > 30) paragraphs.push(text);
  });
  if (paragraphs.length > 0) return cleanText(paragraphs.join("\n\n"));

  // Last resort
  return cleanText($c("body").text().trim());
}

/** Collapse excessive whitespace while preserving paragraph breaks. */
function cleanText(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract PDF download link from the detail page.
 * UOHS PDFs follow: /download/sbirky_rozhodnuti/dokumenty/{year}_{ref}.pdf
 */
function extractPdfLink($: cheerio.CheerioAPI): string | null {
  let pdfUrl: string | null = null;

  $('a[href*=".pdf"]').each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    if (href.includes("sbirky_rozhodnuti")) {
      pdfUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      return false; // break
    }
  });

  // Broader search if the specific pattern did not match
  if (!pdfUrl) {
    $('a[href$=".pdf"]').each((_i, el) => {
      const href = $(el).attr("href") ?? "";
      if (href) {
        pdfUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
        return false;
      }
    });
  }

  return pdfUrl;
}

/**
 * Extract parties from the Ucastnici field.
 * Format: numbered list "1. Company A, a.s.\n2. Company B, s.r.o."
 */
function extractParties(raw: string | undefined): string | null {
  if (!raw) return null;

  // Remove numbered prefixes and join with semicolons
  const parties = raw
    .split(/\n/)
    .map((line) => line.replace(/^\d+\.\s*/, "").trim())
    .filter((line) => line.length > 1)
    .join("; ");

  return parties.length > 0 ? parties : null;
}

// ---------------------------------------------------------------------------
// Classification -- case type, outcome, sector
// ---------------------------------------------------------------------------

/**
 * Determine whether a case is a merger or enforcement decision.
 * Also classify the decision type and outcome.
 *
 * UOHS proceeding types (Typ spravniho rizeni):
 *   - "Spojovani soutezielu (fuze)" = merger control
 *   - "Zneuziti dominantniho postaveni" = abuse of dominance
 *   - "Dohody" / "Horizontalni dohody" / "Vertikalni dohody" = agreements/cartels
 *   - "Zakazane rozhodnuti sdruzeni" = prohibited cartel decisions
 *
 * UOHS spisova znacka department codes:
 *   - KS = general competition
 *   - KD = cartel department
 *   - DP = dominance/abuse
 */
function classifyCase(
  caseRef: string | null,
  meta: Record<string, string>,
  title: string,
  bodyText: string,
): {
  isMerger: boolean;
  isDecision: boolean;
  type: string | null;
  outcome: string | null;
} {
  const typRizeni = (meta["typ_rizeni"] ?? "").toLowerCase();
  const vyrok = (meta["vyrok"] ?? "").toLowerCase();
  const vec = (meta["vec"] ?? "").toLowerCase();
  const caseUpper = (caseRef ?? "").toUpperCase();
  const allText =
    `${typRizeni} ${vyrok} ${vec} ${title.toLowerCase()} ${bodyText.toLowerCase().slice(0, 5000)}`;

  // --- Merger detection ---
  const isMerger =
    typRizeni.includes("spojov") ||
    typRizeni.includes("fuz") ||
    typRizeni.includes("fuze") ||
    vec.includes("spojeni") ||
    allText.includes("spojeni soutezielu") ||
    allText.includes("spojeni soutěžitelů") ||
    allText.includes("kontrola koncentraci") ||
    allText.includes("kontrola koncentrací");

  // --- Decision type ---
  let type: string | null = null;

  if (isMerger) {
    type = "merger_control";
  } else if (
    typRizeni.includes("horizontalni") ||
    typRizeni.includes("horizontální") ||
    typRizeni.includes("kartel") ||
    allText.includes("kartel") ||
    allText.includes("zakaz") && allText.includes("dohod") ||
    allText.includes("zakázaná dohoda") ||
    allText.includes("bid rigging") ||
    caseUpper.includes("/KD")
  ) {
    type = "cartel";
  } else if (
    typRizeni.includes("zneuziti") ||
    typRizeni.includes("zneužití") ||
    typRizeni.includes("dominantn") ||
    allText.includes("zneuziti dominantniho") ||
    allText.includes("zneužití dominantního") ||
    caseUpper.includes("/DP")
  ) {
    type = "abuse_of_dominance";
  } else if (
    typRizeni.includes("vertikalni") ||
    typRizeni.includes("vertikální") ||
    allText.includes("vertikalni dohod") ||
    allText.includes("vertikální dohod")
  ) {
    type = "vertical_agreement";
  } else if (
    allText.includes("sektorove setreni") ||
    allText.includes("sektorové šetření") ||
    allText.includes("sektorizacni") ||
    allText.includes("pruzkum trhu") ||
    allText.includes("průzkum trhu")
  ) {
    type = "sector_inquiry";
  } else if (
    typRizeni.includes("dohod") ||
    allText.includes("zakaz. dohod") ||
    allText.includes("zakazana dohoda")
  ) {
    type = "agreement";
  } else if (
    typRizeni.includes("sdruzeni") ||
    typRizeni.includes("sdružení")
  ) {
    type = "association_decision";
  }

  // --- Outcome ---
  let outcome: string | null = null;

  if (
    vyrok.includes("pokut") ||
    vyrok.includes("sankc") ||
    allText.includes("ulozil pokutu") ||
    allText.includes("uložil pokutu") ||
    allText.includes("sankce:")
  ) {
    outcome = "fine";
  } else if (
    vyrok.includes("povoleno") ||
    vyrok.includes("schvaleno") ||
    vyrok.includes("schváleno") ||
    allText.includes("spojeni povoleno") ||
    allText.includes("spojení povoleno")
  ) {
    if (isMerger) {
      // Check for Phase 2 (hloubkove posouzeni)
      outcome =
        allText.includes("faze ii") ||
        allText.includes("fáze ii") ||
        allText.includes("hloubkove posouzeni") ||
        allText.includes("hloubkové posouzení")
          ? "approved_phase2"
          : "approved";
    } else {
      outcome = "cleared";
    }
  } else if (
    vyrok.includes("zavazk") ||
    vyrok.includes("závazk") ||
    allText.includes("prijate zavazky") ||
    allText.includes("přijaté závazky") ||
    allText.includes("splneni zavazku") ||
    allText.includes("splnění závazků")
  ) {
    outcome = isMerger ? "approved_with_conditions" : "remedies";
  } else if (
    vyrok.includes("zastaveno") ||
    vyrok.includes("zastavení") ||
    allText.includes("rizeni zastaveno") ||
    allText.includes("řízení zastaveno")
  ) {
    outcome = "closed";
  } else if (
    vyrok.includes("zamitnut") ||
    vyrok.includes("zamítnuto") ||
    vyrok.includes("zakazano") ||
    vyrok.includes("zakázáno") ||
    allText.includes("spojeni zakazano") ||
    allText.includes("spojení zakázáno")
  ) {
    outcome = isMerger ? "blocked" : "prohibited";
  } else if (
    vyrok.includes("probih") ||
    allText.includes("probiha") ||
    allText.includes("probíhá") ||
    allText.includes("zahajeno setreni") ||
    allText.includes("zahájeno šetření")
  ) {
    outcome = "ongoing";
  } else if (isMerger) {
    // Most UOHS merger decisions default to approved
    outcome = "approved";
  }

  const isDecision = !isMerger && type !== null;

  return { isMerger, isDecision, type, outcome };
}

/**
 * Map metadata and text content to a sector identifier.
 * Uses Czech terms since all UOHS content is in Czech.
 */
function classifySector(
  meta: Record<string, string>,
  title: string,
  bodyText: string,
): string | null {
  const text =
    `${title} ${meta["vec"] ?? ""} ${bodyText.slice(0, 3000)}`.toLowerCase();

  const mapping: Array<{ id: string; patterns: string[] }> = [
    {
      id: "energy",
      patterns: [
        "energi",
        "elektrin",
        "elektřin",
        "plyn",
        "plynar",
        "plynáren",
        "teplar",
        "teplár",
        "cez",
        "čez",
        "eon",
        "innogy",
        "rwe",
      ],
    },
    {
      id: "telecommunications",
      patterns: [
        "telekomunikac",
        "telecom",
        "mobilni operat",
        "mobilní operát",
        "internet",
        "sirov",
        "sířov",
        "o2 czech",
        "t-mobile",
        "vodafone",
        "mvno",
        "roaming",
      ],
    },
    {
      id: "retail",
      patterns: [
        "maloobchod",
        "supermarket",
        "obchodni retez",
        "obchodní řetěz",
        "potravin",
        "potraviny",
        "hypermarket",
        "albert",
        "kaufland",
        "lidl",
        "penny",
        "billa",
        "tesco",
        "globus",
      ],
    },
    {
      id: "pharmaceuticals",
      patterns: [
        "farmaceut",
        "leciv",
        "léčiv",
        "lekar",
        "lékár",
        "distribuc",
        "otc",
        "zdravotn",
        "nemocnic",
      ],
    },
    {
      id: "banking",
      patterns: [
        "bank",
        "financ",
        "pojist",
        "pojišt",
        "hypote",
        "uvero",
        "úvěro",
        "csob",
        "česká spořitelna",
        "komercni banka",
        "komerční banka",
        "moneta",
      ],
    },
    {
      id: "construction",
      patterns: [
        "stavebn",
        "staveb",
        "stavba",
        "stavby",
        "beton",
        "cement",
        "asphalt",
        "asfalt",
        "silnic",
        "silnič",
        "infrastrukt",
      ],
    },
    {
      id: "transport",
      patterns: [
        "doprav",
        "preprav",
        "přeprav",
        "leteck",
        "zeleznic",
        "železnič",
        "autobus",
        "logistik",
        "spedic",
        "spediční",
        "nakladni",
        "nákladní",
        "ceske drahy",
        "české dráhy",
        "regiojet",
      ],
    },
    {
      id: "automotive",
      patterns: [
        "automob",
        "vozidl",
        "autoserv",
        "autorizovan",
        "autorizovan",
        "prodej vozidel",
        "skoda auto",
        "škoda auto",
      ],
    },
    {
      id: "agriculture",
      patterns: [
        "zemedelst",
        "zemědělst",
        "agrar",
        "agrarn",
        "agrární",
        "mleko",
        "mléko",
        "mlekar",
        "mlékár",
        "potravin",
        "obilnin",
      ],
    },
    {
      id: "media",
      patterns: [
        "media",
        "médii",
        "vysilan",
        "vysílán",
        "televiz",
        "tisk",
        "nakladatelst",
        "reklam",
        "inzerc",
      ],
    },
    {
      id: "digital",
      patterns: [
        "online",
        "e-commerce",
        "digitalni",
        "digitální",
        "platforma",
        "trziste",
        "tržiště",
        "softwar",
        "it sluzb",
        "it služb",
      ],
    },
    {
      id: "chemicals",
      patterns: [
        "chemick",
        "chemi",
        "plastov",
        "plasty",
        "hnojiv",
        "petrochemi",
      ],
    },
    {
      id: "waste_management",
      patterns: [
        "odpad",
        "recyklac",
        "skartn",
        "skládkov",
        "sber",
        "sběr",
      ],
    },
    {
      id: "real_estate",
      patterns: [
        "nemovitost",
        "reality",
        "realitni",
        "realitní",
        "bytov",
        "developersk",
      ],
    },
  ];

  for (const { id, patterns } of mapping) {
    for (const p of patterns) {
      if (text.includes(p)) return id;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Fine and article extraction
// ---------------------------------------------------------------------------

/**
 * Extract a fine amount from Czech text.
 *
 * Czech fines are denominated in CZK (Kc). Common patterns:
 *   - "45 000 000 Kc"
 *   - "pokuta ve vysi 22.000.000,- Kc"
 *   - "sankce: 78 000 000 Kc"
 *   - "22 mil. Kc"
 *   - "1,5 milionu Kc"
 */
function extractFineAmount(text: string): number | null {
  const patterns: Array<{ re: RegExp; multiplier?: number }> = [
    // "45 000 000 Kc" or "45.000.000 Kc" or "45000000 Kc"
    {
      re: /(?:pokut[auy]|sankce|ve\s+v[ýy][šs]i)\s+(?:celkem\s+)?(\d[\d\s.]*\d)\s*(?:,-)?\s*K[čc]/gi,
    },
    // Inline amount with Kc
    { re: /(\d[\d\s.]*\d)\s*(?:,-)?\s*K[čc]/g },
    // "N mil. Kc" or "N milionu Kc"
    {
      re: /(\d+(?:[,.]?\d+)?)\s*(?:mil\.|milion[uů]?)\s*K[čc]/gi,
      multiplier: 1_000_000,
    },
    // "N mld. Kc" or "N miliard Kc"
    {
      re: /(\d+(?:[,.]?\d+)?)\s*(?:mld\.|miliard[y]?)\s*K[čc]/gi,
      multiplier: 1_000_000_000,
    },
  ];

  for (const { re, multiplier } of patterns) {
    const match = re.exec(text);
    if (match?.[1]) {
      let numStr = match[1]
        .replace(/\s/g, "")
        .replace(/\./g, "");

      if (multiplier) {
        // Handle decimal comma: "1,5" -> 1.5
        numStr = numStr.replace(",", ".");
        const val = parseFloat(numStr);
        if (!isNaN(val) && val > 0) return val * multiplier;
      } else {
        // Remove trailing comma-dash formatting
        numStr = numStr.replace(/,$/, "");
        const val = parseInt(numStr, 10);
        if (!isNaN(val) && val > 0) return val;
      }
    }
  }

  return null;
}

/**
 * Extract cited legal provisions from text.
 *
 * Common Czech competition law references:
 *   - ZOHS (Zakon o ochrane hospodarske souteze) - Act No. 143/2001 Coll.
 *     e.g. "§ 3 ZOHS" (prohibited agreements), "§ 11 ZOHS" (abuse of dominance)
 *     "§ 12-18 ZOHS" (merger control), "§ 21b ZOHS" (sector inquiry)
 *   - SFEU / TFEU (Treaty on the Functioning of the EU)
 *     e.g. "cl. 101 SFEU", "cl. 102 SFEU"
 */
function extractLegalArticles(text: string): string[] {
  const articles: Set<string> = new Set();

  // "§ 3 ZOHS" / "§ 11 ZOHS" / "§ 12 az 18 ZOHS"
  const zohsPattern = /§\s*(\d+(?:\s*(?:az|a|až)\s*\d+)?)\s*(?:z[áa]kona|ZOHS)/gi;
  let m: RegExpExecArray | null;
  while ((m = zohsPattern.exec(text)) !== null) {
    articles.add(`ZOHS § ${m[1]!.replace(/\s+/g, " ")}`);
  }

  // Standalone "§ N" followed by reference to competition law
  const standaloneZohs =
    /§\s*(\d+)\s+z[áa]kona\s+[čc]\.\s*143\/2001/gi;
  while ((m = standaloneZohs.exec(text)) !== null) {
    articles.add(`ZOHS § ${m[1]}`);
  }

  // "cl. 101 SFEU" / "clanku 102 SFEU" / "cl. 101 TFEU"
  const euPattern =
    /[čc]l(?:[áa]nk[ůu]|\.)\s*(101|102)\s*(?:SFEU|TFEU|Smlouvy)/gi;
  while ((m = euPattern.exec(text)) !== null) {
    articles.add(`SFEU čl. ${m[1]}`);
  }

  // "Art. 101 TFEU" (English references)
  const artPattern = /Art(?:icle)?\.?\s*(101|102)\s*(?:TFEU|SFEU)/gi;
  while ((m = artPattern.exec(text)) !== null) {
    articles.add(`SFEU čl. ${m[1]}`);
  }

  return [...articles];
}

/** Extract acquiring and target parties from a merger title/body. */
function extractMergerParties(
  title: string,
  bodyText: string,
  meta: Record<string, string>,
): { acquiring: string | null; target: string | null } {
  const vec = meta["vec"] ?? title;

  // UOHS merger titles: "Spojeni soutezielu Company A / Company B"
  // or "Prevzeti Company B spolecnosti Company A"
  const slashMatch = vec.match(
    /(?:spojeni|spojení|převzetí|prevzeti)\s+(?:soutezielu|soutěžitelů)?\s*(.+?)\s*[/–—]\s*(.+)/i,
  );
  if (slashMatch) {
    return {
      acquiring: slashMatch[1]!.trim() || null,
      target: slashMatch[2]!.trim() || null,
    };
  }

  // Title with slash separator: "Company A / Company B"
  const simpleSplit = vec.match(/^(.+?)\s*[/–—]\s*(.+)$/);
  if (simpleSplit) {
    let acq = simpleSplit[1]!.trim();
    const tgt = simpleSplit[2]!.trim();
    // Strip leading "Spojeni soutezielu" prefix
    acq = acq
      .replace(/^(?:spojeni|spojení)\s+(?:soutezielu|soutěžitelů)\s*/i, "")
      .trim();
    return {
      acquiring: acq || null,
      target: tgt || null,
    };
  }

  // Look in the body for explicit party references
  const bodyAcquirer = bodyText.match(
    /(?:nabyvatel|nabyvající|nabývatel|nabývající)\s*:?\s*([^.\n]+)/i,
  );
  const bodyTarget = bodyText.match(
    /(?:nabyvany|nabývaný|cil|cíl|cilova|cílová)\s+(?:spolecnost|společnost)\s*:?\s*([^.\n]+)/i,
  );

  return {
    acquiring: bodyAcquirer?.[1]?.trim() ?? null,
    target: bodyTarget?.[1]?.trim() ?? null,
  };
}

/**
 * Build a case number for the database.
 *
 * Prefers the spisova znacka from metadata (e.g. S0126/2021/KS),
 * prefixed with "UOHS-". Falls back to cislo jednaci or a
 * URL-derived identifier.
 */
function buildCaseNumber(
  caseRef: string | null,
  meta: Record<string, string>,
  detailId: string | null,
): string {
  // Spisova znacka from metadata
  const sz = meta["spisova_znacka"];
  if (sz) {
    const szClean = sz.trim().replace(/\s+/g, "");
    return szClean.startsWith("UOHS-") ? szClean : `UOHS-${szClean}`;
  }

  // Case reference from listing (also a spisova znacka)
  if (caseRef) {
    const refClean = caseRef.replace(/\s+/g, "");
    if (refClean.match(/^S\d{3,5}\//)) {
      return `UOHS-${refClean}`;
    }
    return `UOHS-${refClean}`;
  }

  // Cislo jednaci
  const cj = meta["cislo_jednaci"];
  if (cj) {
    return `UOHS-CJ-${cj.trim().replace(/\s+/g, "")}`;
  }

  // Last resort: detail page ID
  if (detailId) {
    return `UOHS-WEB-${detailId}`;
  }

  return `UOHS-UNKNOWN-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Page parsing -- combine everything into a decision or merger record
// ---------------------------------------------------------------------------

function parseDetailPage(
  html: string,
  url: string,
  listingEntry: ListingEntry,
): { decision: ParsedDecision | null; merger: ParsedMerger | null } {
  const $ = cheerio.load(html);

  // Title: prefer h1, fall back to meta, then listing entry
  const title =
    $("h1").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title")
      .text()
      .trim()
      .replace(
        / \| [ÚU][řr]ad pro ochranu hospod[áa][řr]sk[ée] sout[ěe][žz]e$/,
        "",
      ) ||
    listingEntry.title;

  if (!title || title.length < 3) {
    return { decision: null, merger: null };
  }

  const meta = extractMetadata($);
  const bodyText = extractBodyText($);
  const pdfLink = extractPdfLink($);

  // Build full_text: combine all available text
  const fullTextParts: string[] = [];
  fullTextParts.push(title);

  // Add metadata as structured text
  const metaEntries = Object.entries(meta)
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => `${k}: ${v}`);
  if (metaEntries.length > 0) {
    fullTextParts.push(metaEntries.join("\n"));
  }

  if (bodyText && bodyText.length > 50) {
    fullTextParts.push(bodyText);
  }

  if (pdfLink) {
    fullTextParts.push(`Dokument PDF: ${pdfLink}`);
  }

  const fullText = fullTextParts.join("\n\n");

  // Minimum content threshold
  if (fullText.length < 30) {
    return { decision: null, merger: null };
  }

  // Date
  const rawDate = meta["datum_pravni_moci"] ?? meta["rok"] ?? "";
  let date = parseDate(rawDate);
  if (!date && meta["rok"]) {
    // Year-only fallback
    date = `${meta["rok"]}-01-01`;
  }
  if (!date) {
    date = listingEntry.date;
  }

  // Case number
  const caseNumber = buildCaseNumber(
    listingEntry.caseRef,
    meta,
    listingEntry.detailId,
  );

  // Classification
  const { isMerger, isDecision, type, outcome } = classifyCase(
    listingEntry.caseRef,
    meta,
    title,
    fullText,
  );
  const sector = classifySector(meta, title, fullText);

  // Summary: first 500 chars of body text
  const summary =
    bodyText.length > 50
      ? bodyText.slice(0, 500).replace(/\s+/g, " ").trim()
      : null;

  if (isMerger) {
    const { acquiring, target } = extractMergerParties(
      title,
      bodyText,
      meta,
    );

    return {
      decision: null,
      merger: {
        case_number: caseNumber,
        title,
        date,
        sector,
        acquiring_party: acquiring,
        target,
        summary,
        full_text: fullText,
        outcome: outcome ?? "approved",
        turnover: null, // Not reliably extractable from HTML
      },
    };
  }

  if (isDecision || type !== null) {
    const parties = extractParties(meta["ucastnici"]);
    const fineAmount = extractFineAmount(fullText);
    const articles = extractLegalArticles(fullText);

    return {
      decision: {
        case_number: caseNumber,
        title,
        date,
        type,
        sector,
        parties,
        summary,
        full_text: fullText,
        outcome: outcome ?? (fineAmount ? "fine" : "pending"),
        fine_amount: fineAmount,
        competition_articles:
          articles.length > 0 ? articles.join(", ") : null,
        status: "final",
      },
      merger: null,
    };
  }

  // Cannot clearly classify -- treat as a generic decision
  const parties = extractParties(meta["ucastnici"]);
  const fineAmount = extractFineAmount(fullText);
  const articles = extractLegalArticles(fullText);

  return {
    decision: {
      case_number: caseNumber,
      title,
      date,
      type: type ?? "decision",
      sector,
      parties,
      summary,
      full_text: fullText,
      outcome: outcome ?? (fineAmount ? "fine" : "pending"),
      fine_amount: fineAmount,
      competition_articles:
        articles.length > 0 ? articles.join(", ") : null,
      status: "final",
    },
    merger: null,
  };
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`Created data directory: ${dir}`);
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database (--force)`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function prepareStatements(db: Database.Database) {
  const insertDecision = db.prepare(`
    INSERT OR IGNORE INTO decisions
      (case_number, title, date, type, sector, parties, summary, full_text,
       outcome, fine_amount, competition_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertDecision = db.prepare(`
    INSERT INTO decisions
      (case_number, title, date, type, sector, parties, summary, full_text,
       outcome, fine_amount, competition_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_number) DO UPDATE SET
      title = excluded.title,
      date = excluded.date,
      type = excluded.type,
      sector = excluded.sector,
      parties = excluded.parties,
      summary = excluded.summary,
      full_text = excluded.full_text,
      outcome = excluded.outcome,
      fine_amount = excluded.fine_amount,
      competition_articles = excluded.competition_articles,
      status = excluded.status
  `);

  const insertMerger = db.prepare(`
    INSERT OR IGNORE INTO mergers
      (case_number, title, date, sector, acquiring_party, target, summary,
       full_text, outcome, turnover)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertMerger = db.prepare(`
    INSERT INTO mergers
      (case_number, title, date, sector, acquiring_party, target, summary,
       full_text, outcome, turnover)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_number) DO UPDATE SET
      title = excluded.title,
      date = excluded.date,
      sector = excluded.sector,
      acquiring_party = excluded.acquiring_party,
      target = excluded.target,
      summary = excluded.summary,
      full_text = excluded.full_text,
      outcome = excluded.outcome,
      turnover = excluded.turnover
  `);

  const upsertSector = db.prepare(`
    INSERT INTO sectors (id, name, name_en, description, decision_count, merger_count)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      decision_count = excluded.decision_count,
      merger_count = excluded.merger_count
  `);

  return {
    insertDecision,
    upsertDecision,
    insertMerger,
    upsertMerger,
    upsertSector,
  };
}

// ---------------------------------------------------------------------------
// Main ingestion pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== UOHS Competition Decisions Crawler ===");
  console.log(`  Database:   ${DB_PATH}`);
  console.log(`  Dry run:    ${dryRun}`);
  console.log(`  Resume:     ${resume}`);
  console.log(`  Force:      ${force}`);
  console.log(`  Max pages:  ${maxPages}`);
  console.log("");

  // Load resume state
  const state = loadState();
  const processedSet = new Set(state.processedUrls);

  // ---- Step 1: Discover decision URLs from paginated listing ----
  console.log("Step 1: Discovering decision URLs from listing pages...\n");
  const allEntries: ListingEntry[] = [];
  let emptyPageStreak = 0;

  for (let page = 1; page <= maxPages; page++) {
    // Page 1 = sbirky-rozhodnuti.html, page N = sbirky-rozhodnuti/{N}.html
    const listingUrl =
      page === 1
        ? `${BASE_URL}${LISTING_BASE}.html`
        : `${BASE_URL}${LISTING_BASE}/${page}.html`;

    console.log(`  Fetching listing page ${page}/${maxPages}...`);

    const html = await rateLimitedFetch(listingUrl);
    if (!html) {
      console.warn(`  [WARN] Could not fetch listing page ${page}`);
      emptyPageStreak++;
      if (emptyPageStreak >= 3) {
        console.log("  Three consecutive empty pages -- stopping discovery.");
        break;
      }
      continue;
    }

    const entries = parseListingPage(html);
    if (entries.length === 0) {
      emptyPageStreak++;
      console.log(`  No entries found on page ${page}`);
      if (emptyPageStreak >= 3) {
        console.log("  Three consecutive empty pages -- stopping discovery.");
        break;
      }
      continue;
    }

    emptyPageStreak = 0;
    allEntries.push(...entries);
    console.log(
      `    Found ${entries.length} entries (total: ${allEntries.length})`,
    );
  }

  // Deduplicate by URL
  const seenUrls = new Set<string>();
  const uniqueEntries = allEntries.filter((e) => {
    if (seenUrls.has(e.url)) return false;
    seenUrls.add(e.url);
    return true;
  });

  console.log(
    `\nDiscovered ${uniqueEntries.length} unique decision URLs (from ${allEntries.length} total)`,
  );

  // Filter already-processed URLs (for --resume)
  const entriesToProcess = resume
    ? uniqueEntries.filter((e) => !processedSet.has(e.url))
    : uniqueEntries;

  console.log(`URLs to process: ${entriesToProcess.length}`);
  if (resume && uniqueEntries.length !== entriesToProcess.length) {
    console.log(
      `  Skipping ${uniqueEntries.length - entriesToProcess.length} already-processed URLs`,
    );
  }

  if (entriesToProcess.length === 0) {
    console.log("Nothing to process. Exiting.");
    return;
  }

  // ---- Step 2: Initialise database (unless dry run) ----
  let db: Database.Database | null = null;
  let stmts: ReturnType<typeof prepareStatements> | null = null;

  if (!dryRun) {
    db = initDb();
    stmts = prepareStatements(db);
  }

  // ---- Step 3: Fetch and parse each decision detail page ----
  console.log("\nStep 2: Processing individual decision pages...\n");

  let decisionsIngested = state.decisionsIngested;
  let mergersIngested = state.mergersIngested;
  let errors = 0;
  let skipped = 0;
  const sectorCounts: SectorAccumulator = {};

  for (let i = 0; i < entriesToProcess.length; i++) {
    const entry = entriesToProcess[i]!;
    const progress = `[${i + 1}/${entriesToProcess.length}]`;

    console.log(`${progress} Fetching: ${entry.url}`);

    const html = await rateLimitedFetch(entry.url);
    if (!html) {
      console.log(`  SKIP -- could not fetch`);
      state.errors.push(`fetch_failed: ${entry.url}`);
      errors++;
      continue;
    }

    try {
      const { decision, merger } = parseDetailPage(html, entry.url, entry);

      if (decision) {
        if (dryRun) {
          console.log(
            `  DECISION: ${decision.case_number} -- ${decision.title.slice(0, 80)}`,
          );
          console.log(
            `    type=${decision.type}, sector=${decision.sector}, outcome=${decision.outcome}, fine=${decision.fine_amount}`,
          );
        } else {
          const stmt = force
            ? stmts!.upsertDecision
            : stmts!.insertDecision;
          stmt.run(
            decision.case_number,
            decision.title,
            decision.date,
            decision.type,
            decision.sector,
            decision.parties,
            decision.summary,
            decision.full_text,
            decision.outcome,
            decision.fine_amount,
            decision.competition_articles,
            decision.status,
          );
          console.log(`  INSERTED decision: ${decision.case_number}`);
        }

        decisionsIngested++;

        if (decision.sector) {
          if (!sectorCounts[decision.sector]) {
            sectorCounts[decision.sector] = {
              name: decision.sector,
              name_en: null,
              description: null,
              decisionCount: 0,
              mergerCount: 0,
            };
          }
          sectorCounts[decision.sector]!.decisionCount++;
        }
      } else if (merger) {
        if (dryRun) {
          console.log(
            `  MERGER: ${merger.case_number} -- ${merger.title.slice(0, 80)}`,
          );
          console.log(
            `    sector=${merger.sector}, outcome=${merger.outcome}, acquiring=${merger.acquiring_party?.slice(0, 40)}`,
          );
        } else {
          const stmt = force
            ? stmts!.upsertMerger
            : stmts!.insertMerger;
          stmt.run(
            merger.case_number,
            merger.title,
            merger.date,
            merger.sector,
            merger.acquiring_party,
            merger.target,
            merger.summary,
            merger.full_text,
            merger.outcome,
            merger.turnover,
          );
          console.log(`  INSERTED merger: ${merger.case_number}`);
        }

        mergersIngested++;

        if (merger.sector) {
          if (!sectorCounts[merger.sector]) {
            sectorCounts[merger.sector] = {
              name: merger.sector,
              name_en: null,
              description: null,
              decisionCount: 0,
              mergerCount: 0,
            };
          }
          sectorCounts[merger.sector]!.mergerCount++;
        }
      } else {
        console.log(`  SKIP -- could not extract structured data`);
        skipped++;
      }

      // Mark URL as processed
      processedSet.add(entry.url);
      state.processedUrls.push(entry.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${message}`);
      state.errors.push(`parse_error: ${entry.url}: ${message}`);
      errors++;
    }

    // Save state periodically (every 25 URLs)
    if ((i + 1) % 25 === 0) {
      state.decisionsIngested = decisionsIngested;
      state.mergersIngested = mergersIngested;
      saveState(state);
      console.log(`  [checkpoint] State saved after ${i + 1} URLs`);
    }
  }

  // ---- Step 4: Update sector counts ----
  if (!dryRun && db && stmts) {
    const sectorMeta: Record<string, { name: string; name_en: string }> = {
      energy: {
        name: "Energetika",
        name_en: "Energy",
      },
      telecommunications: {
        name: "Telekomunikace",
        name_en: "Telecommunications",
      },
      retail: {
        name: "Maloobchod",
        name_en: "Retail",
      },
      pharmaceuticals: {
        name: "Farmacie a zdravotnictvi",
        name_en: "Pharmaceuticals and Healthcare",
      },
      banking: {
        name: "Bankovnictvi a financni sluzby",
        name_en: "Banking and Financial Services",
      },
      construction: {
        name: "Stavebnictvi",
        name_en: "Construction",
      },
      transport: {
        name: "Doprava a logistika",
        name_en: "Transport and Logistics",
      },
      automotive: {
        name: "Automobilovy prumysl",
        name_en: "Automotive",
      },
      agriculture: {
        name: "Zemedelstvi a potravinarstvi",
        name_en: "Agriculture and Food",
      },
      media: {
        name: "Media a reklama",
        name_en: "Media and Advertising",
      },
      digital: {
        name: "Digitalni ekonomika",
        name_en: "Digital Economy",
      },
      chemicals: {
        name: "Chemicky prumysl",
        name_en: "Chemicals",
      },
      waste_management: {
        name: "Odpadove hospodarstvi",
        name_en: "Waste Management",
      },
      real_estate: {
        name: "Nemovitosti",
        name_en: "Real Estate",
      },
    };

    // Count decisions and mergers per sector from the database
    const decisionSectorCounts = db
      .prepare(
        "SELECT sector, COUNT(*) as cnt FROM decisions WHERE sector IS NOT NULL GROUP BY sector",
      )
      .all() as Array<{ sector: string; cnt: number }>;
    const mergerSectorCounts = db
      .prepare(
        "SELECT sector, COUNT(*) as cnt FROM mergers WHERE sector IS NOT NULL GROUP BY sector",
      )
      .all() as Array<{ sector: string; cnt: number }>;

    const finalSectorCounts: Record<
      string,
      { decisions: number; mergers: number }
    > = {};
    for (const row of decisionSectorCounts) {
      if (!finalSectorCounts[row.sector])
        finalSectorCounts[row.sector] = { decisions: 0, mergers: 0 };
      finalSectorCounts[row.sector]!.decisions = row.cnt;
    }
    for (const row of mergerSectorCounts) {
      if (!finalSectorCounts[row.sector])
        finalSectorCounts[row.sector] = { decisions: 0, mergers: 0 };
      finalSectorCounts[row.sector]!.mergers = row.cnt;
    }

    const updateSectors = db.transaction(() => {
      for (const [id, counts] of Object.entries(finalSectorCounts)) {
        const info = sectorMeta[id];
        stmts!.upsertSector.run(
          id,
          info?.name ?? id,
          info?.name_en ?? null,
          null,
          counts.decisions,
          counts.mergers,
        );
      }
    });
    updateSectors();

    console.log(
      `\nUpdated ${Object.keys(finalSectorCounts).length} sector records`,
    );
  }

  // ---- Step 5: Final state save ----
  state.decisionsIngested = decisionsIngested;
  state.mergersIngested = mergersIngested;
  saveState(state);

  // ---- Step 6: Summary ----
  if (!dryRun && db) {
    const decisionCount = (
      db.prepare("SELECT count(*) as cnt FROM decisions").get() as {
        cnt: number;
      }
    ).cnt;
    const mergerCount = (
      db.prepare("SELECT count(*) as cnt FROM mergers").get() as {
        cnt: number;
      }
    ).cnt;
    const sectorCount = (
      db.prepare("SELECT count(*) as cnt FROM sectors").get() as {
        cnt: number;
      }
    ).cnt;

    console.log("\n=== Ingestion Complete ===");
    console.log(`  Decisions in DB:  ${decisionCount}`);
    console.log(`  Mergers in DB:    ${mergerCount}`);
    console.log(`  Sectors in DB:    ${sectorCount}`);
    console.log(`  New decisions:    ${decisionsIngested}`);
    console.log(`  New mergers:      ${mergersIngested}`);
    console.log(`  Errors:           ${errors}`);
    console.log(`  Skipped:          ${skipped}`);
    console.log(`  State saved to:   ${STATE_FILE}`);

    db.close();
  } else {
    console.log("\n=== Dry Run Complete ===");
    console.log(`  Decisions found:  ${decisionsIngested}`);
    console.log(`  Mergers found:    ${mergersIngested}`);
    console.log(`  Errors:           ${errors}`);
    console.log(`  Skipped:          ${skipped}`);
  }

  console.log("\nHotovo.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
