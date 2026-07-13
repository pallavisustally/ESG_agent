/**
 * Upload local BRSR PDFs (data/pdf/YYYY/SYMBOL/*.pdf) to Cloudflare R2.
 *
 * Prerequisites (Cloudflare dashboard):
 *   1. Create an R2 bucket (e.g. sustally-brsr-pdfs)
 *   2. Enable public access (R2.dev subdomain or custom domain)
 *   3. Create an API token with Object Read & Write for that bucket
 *
 * Env (.env):
 *   R2_ACCOUNT_ID=
 *   R2_ACCESS_KEY_ID=
 *   R2_SECRET_ACCESS_KEY=
 *   R2_BUCKET_NAME=sustally-brsr-pdfs
 *   R2_PUBLIC_BASE_URL=https://pub-xxxxx.r2.dev
 *
 * Usage:
 *   npm run upload:r2              # upload all missing
 *   npm run upload:r2 -- --limit 50
 *   npm run upload:r2 -- --dry-run
 *   npm run upload:r2 -- --year 2025
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { resolvePdfDir, resolvePdfR2MapPath } from '../src/paths.js';
import {
  normalizeMapKey,
  publicUrlForKey,
  r2ObjectKey,
  reloadPdfR2UrlMap,
} from '../src/r2-pdfs.js';

dotenv.config();

const PDF_DIR = resolvePdfDir();
const MAP_PATH = resolvePdfR2MapPath();
const CONCURRENCY = Math.max(1, parseInt(process.env.R2_UPLOAD_CONCURRENCY || '4', 10));
const SAVE_EVERY = 25;

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
  reloadPdfR2UrlMap();
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
        const mapKey = normalizeMapKey(year, symbol, filename);
        files.push({
          abs,
          mapKey,
          year,
          symbol: symbol.toUpperCase(),
          filename,
          size: fs.statSync(abs).size,
        });
      }
    }
  }
  return files;
}

function createClient() {
  const accountId = requireEnv('R2_ACCOUNT_ID');
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    },
  });
}

async function objectExists(client, bucket, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') {
      return false;
    }
    // Some R2 responses use 403/404 variants — treat missing as false only for 404.
    if (String(err?.message || '').includes('Not Found')) return false;
    throw err;
  }
}

async function uploadOne(client, bucket, publicBase, file, force) {
  const key = r2ObjectKey(file.mapKey);
  if (!force) {
    const exists = await objectExists(client, bucket, key);
    if (exists) {
      return {
        status: 'exists',
        url: publicUrlForKey(file.mapKey, publicBase),
      };
    }
  }

  const body = fs.readFileSync(file.abs);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/pdf',
      ContentDisposition: 'inline',
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );

  return {
    status: 'uploaded',
    url: publicUrlForKey(file.mapKey, publicBase),
  };
}

async function runPool(items, concurrency, worker) {
  let index = 0;
  const results = new Array(items.length);

  async function next() {
    const i = index++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    await next();
  }

  const starters = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(starters);
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`Local PDF dir:  ${PDF_DIR}`);
  console.log(`URL map file:   ${MAP_PATH}`);
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
  console.log(`Local PDFs:     ${allFiles.length}`);
  console.log(`Already mapped: ${allFiles.length - pending.length}`);
  console.log(`Queued now:     ${toProcess.length} (${(totalBytes / (1024 ** 3)).toFixed(2)} GB)`);
  console.log('');

  if (toProcess.length === 0) {
    console.log('Nothing to upload. Map is up to date.');
    return;
  }

  if (opts.dryRun) {
    toProcess.slice(0, 20).forEach((f, i) => {
      console.log(`[dry-run ${i + 1}] ${f.mapKey} (${(f.size / 1024).toFixed(0)} KB)`);
    });
    if (toProcess.length > 20) console.log(`... and ${toProcess.length - 20} more`);
    console.log('\nSet R2_* env vars in .env, then run without --dry-run to upload.');
    return;
  }

  const publicBase = requireEnv('R2_PUBLIC_BASE_URL').replace(/\/+$/, '');
  const bucket = requireEnv('R2_BUCKET_NAME');
  console.log(`R2 bucket:      ${bucket}`);
  console.log(`Public base:    ${publicBase}`);
  console.log(`Concurrency:    ${CONCURRENCY}`);
  console.log('');

  const client = createClient();
  let uploaded = 0;
  let existed = 0;
  let failed = 0;
  let sinceSave = 0;

  await runPool(toProcess, CONCURRENCY, async (file, i) => {
    const label = `[${i + 1}/${toProcess.length}] ${file.mapKey}`;
    try {
      const result = await uploadOne(client, bucket, publicBase, file, opts.force);
      if (!result.url) {
        throw new Error('Upload succeeded but R2_PUBLIC_BASE_URL produced an empty URL');
      }
      map[file.mapKey] = result.url;
      if (result.status === 'uploaded') {
        uploaded++;
        console.log(`${label} ✓ uploaded`);
      } else {
        existed++;
        console.log(`${label} · already on R2 (mapped)`);
      }
      sinceSave++;
      if (sinceSave >= SAVE_EVERY) {
        saveMap(map);
        sinceSave = 0;
      }
    } catch (err) {
      failed++;
      console.error(`${label} ✗ ${err.message}`);
    }
  });

  saveMap(map);

  console.log('\n========================================================');
  console.log('                 R2 UPLOAD COMPLETED                    ');
  console.log('========================================================');
  console.log(`Uploaded:   ${uploaded}`);
  console.log(`Existed:    ${existed}`);
  console.log(`Failed:     ${failed}`);
  console.log(`Map entries:${Object.keys(map).length}`);
  console.log(`Map file:   ${MAP_PATH}`);
  console.log('\nNext: commit data/pdf_r2_urls.json and redeploy so production can use R2 links.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
