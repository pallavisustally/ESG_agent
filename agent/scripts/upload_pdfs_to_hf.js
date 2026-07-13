/**
 * Upload local BRSR PDFs (data/pdf/YYYY/SYMBOL/*.pdf) to a public Hugging Face dataset.
 *
 * Batches many files into each Hub commit to stay under the free-tier limit
 * (~128 repository commits per hour).
 *
 * Env (.env):
 *   HF_TOKEN=hf_...
 *   HF_DATASET_REPO=your-username/sustally-brsr-pdfs
 *   HF_UPLOAD_BATCH_SIZE=40          # files per commit (default 40)
 *   HF_UPLOAD_BATCH_MAX_MB=250       # max bytes per commit (default 250)
 *
 * Usage:
 *   npm run upload:hf -- --dry-run --limit 5
 *   npm run upload:hf -- --limit 200
 *   npm run upload:hf
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import dotenv from 'dotenv';
import { createRepo, uploadFiles, listFiles } from '@huggingface/hub';
import { resolvePdfDir, resolvePdfHfMapPath } from '../src/paths.js';
import {
  normalizeMapKey,
  publicHfUrlForKey,
  hfRepoPath,
  reloadPdfHfUrlMap,
} from '../src/hf-pdfs.js';

dotenv.config();

const PDF_DIR = resolvePdfDir();
const MAP_PATH = resolvePdfHfMapPath();
const BATCH_SIZE = Math.max(1, parseInt(process.env.HF_UPLOAD_BATCH_SIZE || '40', 10));
const BATCH_MAX_BYTES =
  Math.max(1, parseInt(process.env.HF_UPLOAD_BATCH_MAX_MB || '250', 10)) * 1024 * 1024;
const RATE_LIMIT_WAIT_MS = Math.max(
  60_000,
  parseInt(process.env.HF_RATE_LIMIT_WAIT_MS || String(65 * 60 * 1000), 10),
);

function parseArgs(argv) {
  const opts = { limit: Infinity, dryRun: false, year: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--limit' && argv[i + 1]) {
      opts.limit = parseInt(argv[++i], 10) || Infinity;
    } else if (arg === '--year' && argv[i + 1]) {
      opts.year = String(argv[++i]);
    } else if (/^\d+$/.test(arg)) {
      opts.limit = parseInt(arg, 10);
    }
  }
  return opts;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Add it to .env (see .env.example).`);
  }
  return value;
}

function loadMap() {
  if (!fs.existsSync(MAP_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(MAP_PATH, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function saveMap(map) {
  const dir = path.dirname(MAP_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MAP_PATH, `${JSON.stringify(map, null, 2)}\n`);
  reloadPdfHfUrlMap();
}

function walkPdfs(rootDir, yearFilter = null) {
  const files = [];
  if (!fs.existsSync(rootDir)) return files;

  for (const year of fs.readdirSync(rootDir)) {
    if (yearFilter && year !== yearFilter) continue;
    const yearDir = path.join(rootDir, year);
    if (!fs.statSync(yearDir).isDirectory()) continue;

    for (const symbol of fs.readdirSync(yearDir)) {
      const symbolDir = path.join(yearDir, symbol);
      if (!fs.statSync(symbolDir).isDirectory()) continue;

      for (const filename of fs.readdirSync(symbolDir)) {
        if (!filename.toLowerCase().endsWith('.pdf')) continue;
        const abs = path.join(symbolDir, filename);
        if (!fs.statSync(abs).isFile()) continue;
        files.push({
          abs,
          mapKey: normalizeMapKey(year, symbol, filename),
          size: fs.statSync(abs).size,
        });
      }
    }
  }
  return files;
}

function chunkFiles(files) {
  const batches = [];
  let current = [];
  let currentBytes = 0;

  for (const file of files) {
    const wouldExceedCount = current.length >= BATCH_SIZE;
    const wouldExceedBytes =
      current.length > 0 && currentBytes + file.size > BATCH_MAX_BYTES;

    if (wouldExceedCount || wouldExceedBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(file);
    currentBytes += file.size;
  }

  if (current.length) batches.push(current);
  return batches;
}

function repoDesignation(repoName) {
  return { type: 'dataset', name: String(repoName).replace(/^datasets\//, '') };
}

function isRateLimitError(err) {
  const msg = String(err?.message || err);
  return /rate limit|128 per hour|too many requests|429/i.test(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureRepo(accessToken, repoName) {
  const repo = repoDesignation(repoName);
  try {
    await createRepo({
      repo,
      accessToken,
      private: false,
    });
    console.log(`Created public dataset repo: ${repo.name}`);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/already been taken|already exists/i.test(msg) || err?.statusCode === 409 || err?.status === 409) {
      console.log(`Using existing dataset repo: ${repo.name}`);
      return;
    }
    try {
      const iter = listFiles({ repo, accessToken, recursive: false });
      await iter.next();
      console.log(`Using existing dataset repo: ${repo.name}`);
      return;
    } catch {
      throw err;
    }
  }
}

async function uploadBatchWithRetry(repo, accessToken, batch, repoName) {
  const files = batch.map((f) => ({
    path: hfRepoPath(f.mapKey),
    // Lazy-load from disk so we don't hold all PDFs in RAM
    content: pathToFileURL(f.abs),
  }));

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await uploadFiles({
        repo,
        accessToken,
        files,
        commitTitle: `Add ${batch.length} BRSR PDFs`,
      });
      return;
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
      const waitMin = Math.round(RATE_LIMIT_WAIT_MS / 60000);
      console.warn(
        `\n⚠ Hugging Face commit rate limit hit (attempt ${attempt}). ` +
          `Waiting ${waitMin} minutes, then retrying this batch…\n`,
      );
      await sleep(RATE_LIMIT_WAIT_MS);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`Local PDF dir:  ${PDF_DIR}`);
  console.log(`URL map file:   ${MAP_PATH}`);
  console.log(`Batch size:     ${BATCH_SIZE} files / ${BATCH_MAX_BYTES / (1024 * 1024)} MB max`);
  if (opts.year) console.log(`Year filter:    ${opts.year}`);
  if (opts.dryRun) console.log('Mode:           dry-run (no uploads)');
  console.log('');

  const allFiles = walkPdfs(PDF_DIR, opts.year);
  if (allFiles.length === 0) {
    console.log('No local PDFs found. Run: npm run download-reports -- all');
    return;
  }

  const map = loadMap();
  const pending = allFiles.filter((f) => opts.force || !map[f.mapKey]);
  const toProcess = pending.slice(0, opts.limit);
  const totalBytes = toProcess.reduce((n, f) => n + f.size, 0);
  const batches = chunkFiles(toProcess);

  console.log(`Local PDFs:     ${allFiles.length}`);
  console.log(`Already mapped: ${allFiles.length - pending.length}`);
  console.log(`Queued now:     ${toProcess.length} (${(totalBytes / (1024 ** 3)).toFixed(2)} GB)`);
  console.log(`Commits needed: ${batches.length} (HF free limit ≈ 128 commits/hour)`);
  console.log('');

  if (toProcess.length === 0) {
    console.log('Nothing to upload. Map is up to date.');
    return;
  }

  if (opts.dryRun) {
    batches.slice(0, 5).forEach((batch, i) => {
      const mb = (batch.reduce((n, f) => n + f.size, 0) / (1024 * 1024)).toFixed(1);
      console.log(`[dry-run batch ${i + 1}] ${batch.length} files (${mb} MB)`);
      batch.slice(0, 3).forEach((f) => console.log(`  - ${f.mapKey}`));
      if (batch.length > 3) console.log(`  … +${batch.length - 3} more`);
    });
    if (batches.length > 5) console.log(`… and ${batches.length - 5} more batches`);
    return;
  }

  const accessToken = requireEnv('HF_TOKEN');
  const repoName = requireEnv('HF_DATASET_REPO').replace(/^datasets\//, '');
  const repo = repoDesignation(repoName);

  console.log(`HF dataset:     ${repoName}`);
  console.log('');

  await ensureRepo(accessToken, repoName);

  let uploaded = 0;
  let failedBatches = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const mb = (batch.reduce((n, f) => n + f.size, 0) / (1024 * 1024)).toFixed(1);
    const label = `[batch ${i + 1}/${batches.length}] ${batch.length} files (${mb} MB)`;

    try {
      console.log(`${label} uploading…`);
      await uploadBatchWithRetry(repo, accessToken, batch, repoName);

      for (const file of batch) {
        const url = publicHfUrlForKey(file.mapKey, { repo: repoName });
        if (!url) throw new Error(`Could not build public HF URL for ${file.mapKey}`);
        map[file.mapKey] = url;
        uploaded++;
      }
      saveMap(map);
      console.log(`${label} ✓ uploaded`);
    } catch (err) {
      failedBatches++;
      console.error(`${label} ✗ ${err.message || err}`);
      // Keep going with remaining batches unless it's clearly fatal.
      if (!isRateLimitError(err) && /unauthorized|forbidden|401|403/i.test(String(err?.message || err))) {
        throw err;
      }
    }
  }

  saveMap(map);

  console.log('\n========================================================');
  console.log('              HUGGING FACE UPLOAD COMPLETED             ');
  console.log('========================================================');
  console.log(`Files uploaded:  ${uploaded}`);
  console.log(`Failed batches:  ${failedBatches}`);
  console.log(`Map entries:     ${Object.keys(map).length}`);
  console.log(`Map file:        ${MAP_PATH}`);
  console.log(`Dataset:         https://huggingface.co/datasets/${repoName}`);
  console.log('\nNext: commit data/pdf_hf_urls.json and redeploy so production uses HF links.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
