/**
 * SusTally NSE BRSR/XBRL Report Downloader (Historical Edition)
 *
 * This script fetches the complete corporate filings index from the NSE API
 * from 01-01-2020 up to today, using Puppeteer to handle session cookies,
 * and then downloads:
 *   - raw XML/XBRL filings → data/xbrl/YYYY/SYMBOL/
 *   - PDF attachments (when present) → data/pdf/YYYY/SYMBOL/
 *
 * PDFs are stored only; they are not parsed here.
 *
 * Usage:
 *   node scripts/download_nse_reports.js [limit]
 *
 * Example (download up to 50 reports):
 *   node scripts/download_nse_reports.js 50
 */

import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { resolveXbrlDir, resolvePdfDir } from "../src/paths.js";

dotenv.config();

/** Prefer system Chrome on Mac; fall back to Puppeteer-bundled Chrome */
function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function launchBrowser() {
  const executablePath = resolveChromePath();
  const options = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  };
  if (executablePath) {
    console.log(`Using browser: ${executablePath}`);
    options.executablePath = executablePath;
  } else {
    console.log(
      "Using Puppeteer-managed Chrome (run: npm run install-browser if missing)",
    );
  }

  try {
    return await puppeteer.launch(options);
  } catch (err) {
    throw new Error(
      `${err.message}\n\nFix options:\n` +
        `  1. Install Puppeteer Chrome:  npm run install-browser\n` +
        `  2. Or install Google Chrome and re-run\n` +
        `  3. Or set PUPPETEER_EXECUTABLE_PATH in .env to your Chrome binary`,
    );
  }
}

// Parse download limit from environment or command line args (default to 20)
let DOWNLOAD_LIMIT = parseInt(process.env.NSE_DOWNLOAD_LIMIT, 50) || 2000;
if (process.argv[2] === "all") {
  DOWNLOAD_LIMIT = Infinity;
} else if (process.argv[2] !== undefined) {
  const parsed = parseInt(process.argv[2], 10);
  if (!isNaN(parsed)) {
    DOWNLOAD_LIMIT = parsed;
  }
}

// Format today's date as DD-MM-YYYY for the API query
const getTodayDateStr = () => {
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, "0");
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const yyyy = today.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
};

const FROM_DATE = process.env.NSE_FROM_DATE || "01-01-2020";
const TO_DATE = getTodayDateStr();
const API_URL = `https://www.nseindia.com/api/corporate-bussiness-sustainabilitiy?from_date=${FROM_DATE}&to_date=${TO_DATE}`;
const XBRL_DIR = resolveXbrlDir();
const PDF_DIR = resolvePdfDir();

for (const dir of [XBRL_DIR, PDF_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPdfUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith(".pdf");
  } catch {
    return url.toLowerCase().split("?")[0].endsWith(".pdf");
  }
}

function filenameFromUrl(url) {
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return path.basename(String(url).split("?")[0]);
  }
}

async function fetchFilingsIndex() {
  console.log(`Launching headless browser to fetch NSE filings index...`);
  console.log(`Filtering dates: ${FROM_DATE} to ${TO_DATE}`);
  const browser = await launchBrowser();
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );

  try {
    console.log("Navigating to NSE India home page to set session cookies...");
    await page.goto("https://www.nseindia.com", { waitUntil: "networkidle2" });

    console.log("Fetching Corporate Sustainability API with date filters...");
    await page.goto(API_URL, { waitUntil: "networkidle2" });

    const jsonText = await page.evaluate(() => document.body.innerText);
    const parsed = JSON.parse(jsonText);

    if (parsed && parsed.data) {
      return parsed.data;
    } else {
      throw new Error("API response format invalid or empty");
    }
  } finally {
    await browser.close();
  }
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP Status ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(destPath, buffer);
}

async function main() {
  try {
    // 1. Fetch filings index
    const filings = await fetchFilingsIndex();
    console.log(
      `Successfully retrieved index with ${filings.length} filings across the historical date range.`,
    );

    // Save metadata locally for reference
    const metaPath = path.join(
      process.cwd(),
      "data",
      "nse_sustainability_metadata.json",
    );
    fs.writeFileSync(metaPath, JSON.stringify(filings, null, 2));
    console.log(`✓ Saved index metadata to: ${metaPath}`);

    // 2. Queue filings that still need XBRL and/or PDF (same year/symbol layout)
    const pendingFilings = [];
    let existingXbrlCount = 0;
    let existingPdfCount = 0;
    let filingsWithPdf = 0;

    filings.forEach((f) => {
      const year = f.fyTo || "Unknown";
      const symbol = (f.symbol || "Custom").toUpperCase();
      const company = f.companyName;
      const jobs = [];

      if (f.xbrlFile && f.xbrlFile.endsWith(".xml")) {
        const filename = filenameFromUrl(f.xbrlFile);
        const checkPath = path.join(XBRL_DIR, String(year), symbol, filename);

        if (fs.existsSync(checkPath)) {
          existingXbrlCount++;
        } else {
          jobs.push({
            kind: "xbrl",
            url: f.xbrlFile,
            filename,
            targetDir: XBRL_DIR,
          });
        }
      }

      if (isPdfUrl(f.attachmentFile)) {
        filingsWithPdf++;
        const filename = filenameFromUrl(f.attachmentFile);
        const checkPath = path.join(PDF_DIR, String(year), symbol, filename);

        if (fs.existsSync(checkPath)) {
          existingPdfCount++;
        } else {
          jobs.push({
            kind: "pdf",
            url: f.attachmentFile,
            filename,
            targetDir: PDF_DIR,
          });
        }
      }

      if (jobs.length > 0) {
        pendingFilings.push({ company, year, symbol, jobs });
      }
    });

    const pendingXbrl = pendingFilings.reduce(
      (n, f) => n + f.jobs.filter((j) => j.kind === "xbrl").length,
      0,
    );
    const pendingPdf = pendingFilings.reduce(
      (n, f) => n + f.jobs.filter((j) => j.kind === "pdf").length,
      0,
    );

    console.log(
      `Found ${existingXbrlCount} XBRL and ${existingPdfCount} PDF files already present.`,
    );
    console.log(`Filings with PDF attachment: ${filingsWithPdf}`);
    console.log(
      `Filings needing download: ${pendingFilings.length} (${pendingXbrl} XBRL, ${pendingPdf} PDF files)`,
    );

    if (pendingFilings.length === 0) {
      console.log(
        "All available XBRL and PDF files have already been downloaded! Nothing new to fetch.",
      );
      return;
    }

    // 3. Download per filing (XBRL + PDF together) with a limit
    const targetFilingCount = Math.min(pendingFilings.length, DOWNLOAD_LIMIT);
    console.log(
      `Starting download for ${targetFilingCount} filings (Limit: ${DOWNLOAD_LIMIT})...\n`,
    );

    let downloadedXbrl = 0;
    let downloadedPdf = 0;
    let failed = 0;
    let fileIndex = 0;
    const totalFiles = pendingFilings
      .slice(0, targetFilingCount)
      .reduce((n, f) => n + f.jobs.length, 0);

    for (let i = 0; i < targetFilingCount; i++) {
      const filing = pendingFilings[i];
      console.log(
        `[Filing ${i + 1}/${targetFilingCount}] ${filing.company} (${filing.year} / ${filing.symbol})`,
      );

      for (const job of filing.jobs) {
        fileIndex++;
        const destDir = path.join(
          job.targetDir,
          String(filing.year),
          String(filing.symbol).toUpperCase(),
        );
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        const destPath = path.join(destDir, job.filename);
        const label = job.kind === "pdf" ? "PDF" : "XBRL";

        console.log(`  [${fileIndex}/${totalFiles}] ${label}: ${job.url}`);

        try {
          await downloadFile(job.url, destPath);
          console.log(
            `    ✓ Saved to: ${path.relative(process.cwd(), destPath)} (${(fs.statSync(destPath).size / 1024).toFixed(2)} KB)`,
          );
          if (job.kind === "pdf") downloadedPdf++;
          else downloadedXbrl++;
        } catch (err) {
          failed++;
          console.error(`    ✗ Failed to download:`, err.message);
        }

        const delay = parseInt(process.env.NSE_DOWNLOAD_DELAY_MS, 10) || 750;
        await sleep(delay);
      }
    }

    console.log("\n========================================================");
    console.log("              DOWNLOAD SESSION COMPLETED                ");
    console.log("========================================================");
    console.log(`Filings processed:      ${targetFilingCount}`);
    console.log(`New XBRL downloaded:    ${downloadedXbrl}`);
    console.log(`New PDF downloaded:     ${downloadedPdf}`);
    console.log(`Failed:                 ${failed}`);
    console.log(
      `Filings remaining:      ${pendingFilings.length - targetFilingCount}`,
    );
    console.log(`XBRL directory:         ${XBRL_DIR}`);
    console.log(`PDF directory:          ${PDF_DIR}`);
    console.log(
      "To download more, run:   node scripts/download_nse_reports.js [limit]",
    );
  } catch (error) {
    console.error("An error occurred during execution:", error.message);
  }
}

main();
