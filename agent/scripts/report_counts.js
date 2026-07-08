import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { resolveFromProject, resolveXbrlDir } from '../src/paths.js';

dotenv.config();

const METADATA_PATH = process.env.METADATA_PATH
  ? path.resolve(process.env.METADATA_PATH)
  : resolveFromProject('data', 'nse_sustainability_metadata.json');
const XBRL_DIR = resolveXbrlDir();

// Helper to draw progress bars
function getProgressBar(percentage, width = 10) {
  const filledLength = Math.round(width * (Math.min(100, Math.max(0, percentage)) / 100));
  const emptyLength = width - filledLength;
  return '█'.repeat(filledLength) + '░'.repeat(emptyLength);
}

function main() {
  let metadata = [];
  if (fs.existsSync(METADATA_PATH)) {
    try {
      metadata = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
    } catch (err) {
      console.error(`Error reading metadata file: ${err.message}`);
    }
  } else {
    console.warn(`Warning: Metadata file not found at ${METADATA_PATH}. Run the downloader to fetch it.`);
  }

  let localFiles = [];
  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        scanDir(fullPath);
      } else {
        const ext = path.extname(item).toLowerCase();
        if (ext === '.xml' || ext === '.xbrl') {
          localFiles.push(item);
        }
      }
    }
  }
  if (fs.existsSync(XBRL_DIR)) {
    scanDir(XBRL_DIR);
  } else {
    console.warn(`Warning: XBRL directory not found at ${XBRL_DIR}.`);
  }

  // Create lookup for indexed files
  const filenameMap = new Map();
  const indexedByYear = {};
  
  metadata.forEach(item => {
    if (item.xbrlFile && item.xbrlFile.endsWith('.xml')) {
      const filename = path.basename(item.xbrlFile);
      filenameMap.set(filename, item);
      
      const year = item.fyTo || 'Unknown';
      indexedByYear[year] = (indexedByYear[year] || 0) + 1;
    }
  });

  // Count local files by year
  const downloadedByYear = {};
  let otherCustomCount = 0;

  localFiles.forEach(filename => {
    const item = filenameMap.get(filename);
    if (item) {
      const year = item.fyTo || 'Unknown';
      downloadedByYear[year] = (downloadedByYear[year] || 0) + 1;
    } else {
      otherCustomCount++;
    }
  });

  // Collect all unique years in sorted order
  const allYears = Array.from(new Set([
    ...Object.keys(indexedByYear),
    ...Object.keys(downloadedByYear)
  ])).sort();

  console.log('\n========================================================================');
  console.log('               SUSTAINABILITY REPORT COVERAGE SUMMARY                   ');
  console.log('========================================================================');
  console.log(
    ' ' +
    'Financial Year'.padEnd(15) + ' | ' +
    'Indexed (NSE)'.padStart(13) + ' | ' +
    'Downloaded'.padStart(10) + ' | ' +
    'Progress / Bar'.padEnd(25)
  );
  console.log('-'.repeat(72));

  let totalIndexed = 0;
  let totalDownloadedIndexed = 0;

  allYears.forEach(year => {
    if (year === 'Unknown') return;

    const indexed = indexedByYear[year] || 0;
    const downloaded = downloadedByYear[year] || 0;
    
    totalIndexed += indexed;
    totalDownloadedIndexed += downloaded;

    const percentage = indexed > 0 ? (downloaded / indexed) * 100 : 0;
    const pctStr = percentage.toFixed(1) + '%';
    const bar = getProgressBar(percentage);

    console.log(
      ' ' +
      year.padEnd(15) + ' | ' +
      indexed.toString().padStart(13) + ' | ' +
      downloaded.toString().padStart(10) + ' | ' +
      `${pctStr.padStart(6)} [${bar}]`
    );
  });

  if (indexedByYear['Unknown'] || downloadedByYear['Unknown']) {
    const indexed = indexedByYear['Unknown'] || 0;
    const downloaded = downloadedByYear['Unknown'] || 0;
    totalIndexed += indexed;
    totalDownloadedIndexed += downloaded;
    const percentage = indexed > 0 ? (downloaded / indexed) * 100 : 0;
    const pctStr = percentage.toFixed(1) + '%';
    const bar = getProgressBar(percentage);

    console.log(
      ' ' +
      'Unknown Year'.padEnd(15) + ' | ' +
      indexed.toString().padStart(13) + ' | ' +
      downloaded.toString().padStart(10) + ' | ' +
      `${pctStr.padStart(6)} [${bar}]`
    );
  }

  if (otherCustomCount > 0) {
    console.log(
      ' ' +
      'Other/Custom'.padEnd(15) + ' | ' +
      '-'.padStart(13) + ' | ' +
      otherCustomCount.toString().padStart(10) + ' | ' +
      '     - [Custom/unmatched files]'
    );
  }

  console.log('-'.repeat(72));
  
  const totalPercentage = totalIndexed > 0 ? (totalDownloadedIndexed / totalIndexed) * 100 : 0;
  const totalPctStr = totalPercentage.toFixed(1) + '%';
  const totalBar = getProgressBar(totalPercentage);
  const grandTotalDownloaded = totalDownloadedIndexed + otherCustomCount;

  console.log(
    ' ' +
    'TOTAL'.padEnd(15) + ' | ' +
    totalIndexed.toString().padStart(13) + ' | ' +
    grandTotalDownloaded.toString().padStart(10) + ' | ' +
    `${totalPctStr.padStart(6)} [${totalBar}]`
  );
  console.log('========================================================================');
  console.log(`Metadata Index source:  ${METADATA_PATH}`);
  console.log(`Local XML Directory:    ${XBRL_DIR}`);
  console.log(`Total Unique Local:     ${localFiles.length} files`);
  console.log('========================================================================\n');
}

main();
