/**
 * SusTally NSE BRSR/XBRL Report Downloader (Historical Edition)
 *
 * This script fetches the complete corporate filings index from the NSE API
 * from 01-01-2020 up to today, using Puppeteer to handle session cookies,
 * and then downloads the raw XML/XBRL filings directly to the `data/xbrl/`
 * directory, checking for duplicates.
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
import { resolveXbrlDir } from "../src/paths.js";

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
    console.log("Using Puppeteer-managed Chrome (run: npm run install-browser if missing)");
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
let DOWNLOAD_LIMIT = parseInt(process.env.NSE_DOWNLOAD_LIMIT, 50) || 100;
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
const TARGET_DIR = resolveXbrlDir();

// Ensure directory exists
if (!fs.existsSync(TARGET_DIR)) {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    // 2. Filter filings that have XBRL links and are not already downloaded
    const pendingDownloads = [];
    let existingCount = 0;
    filings.forEach((f) => {
      if (f.xbrlFile && f.xbrlFile.endsWith(".xml")) {
        const filename = path.basename(f.xbrlFile);
        const year = f.fyTo || "Unknown";
        const symbol = (f.symbol || "Custom").toUpperCase();
        const checkPath = path.join(TARGET_DIR, String(year), symbol, filename);

        if (fs.existsSync(checkPath)) {
          existingCount++;
        } else {
          pendingDownloads.push({
            url: f.xbrlFile,
            filename: filename,
            company: f.companyName,
            year: year,
            symbol: symbol,
          });
        }
      }
    });
    console.log(
      `Found ${existingCount} files already present in structured directories.`,
    );

    console.log(
      `Total new filings available to download: ${pendingDownloads.length}`,
    );

    if (pendingDownloads.length === 0) {
      console.log(
        "All available files have already been downloaded! No new reports to fetch.",
      );
      return;
    }

    // 3. Download files with a limit to avoid rate-limiting/overwhelming connections
    const targetDownloadCount = Math.min(
      pendingDownloads.length,
      DOWNLOAD_LIMIT,
    );
    console.log(
      `Starting download of ${targetDownloadCount} new files (Limit: ${DOWNLOAD_LIMIT})...\n`,
    );

    for (let i = 0; i < targetDownloadCount; i++) {
      const item = pendingDownloads[i];
      const destDir = path.join(
        TARGET_DIR,
        String(item.year),
        String(item.symbol).toUpperCase(),
      );
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      const destPath = path.join(destDir, item.filename);

      console.log(
        `[${i + 1}/${targetDownloadCount}] Downloading: ${item.company} (${item.year})`,
      );
      console.log(`  URL:  ${item.url}`);

      try {
        await downloadFile(item.url, destPath);
        console.log(
          `  ✓ Saved to: ${item.filename} (${(fs.statSync(destPath).size / 1024).toFixed(2)} KB)`,
        );
      } catch (err) {
        console.error(`  ✗ Failed to download:`, err.message);
      }

      // Delay between requests to be polite
      if (i < targetDownloadCount - 1) {
        const delay = parseInt(process.env.NSE_DOWNLOAD_DELAY_MS, 10) || 750;
        await sleep(delay);
      }
    }

    console.log("\n========================================================");
    console.log("              DOWNLOAD SESSION COMPLETED                ");
    console.log("========================================================");
    console.log(`New files downloaded:   ${targetDownloadCount}`);
    console.log(
      `Files remaining:        ${pendingDownloads.length - targetDownloadCount}`,
    );
    console.log(`Save directory:         ${TARGET_DIR}`);
    console.log(
      "To download more, run:   node scripts/download_nse_reports.js [limit]",
    );
  } catch (error) {
    console.error("An error occurred during execution:", error.message);
  }
}

main();
