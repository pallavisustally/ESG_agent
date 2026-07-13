import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** agent/ directory */
export const AGENT_ROOT = path.resolve(__dirname, "..");

/** stage3 project root */
export const PROJECT_ROOT = path.resolve(AGENT_ROOT, "..");

export function resolveFromProject(...segments) {
  return path.join(PROJECT_ROOT, ...segments);
}

export function resolveFromAgent(...segments) {
  return path.join(AGENT_ROOT, ...segments);
}

/** BRSR/ESG XBRL reports: data/xbrl/2025/SYMBOL/, data/xbrl/2026/SYMBOL/ */
export function resolveXbrlDir() {
  if (process.env.VERCEL) {
    return "/tmp/xbrl";
  }
  return process.env.XBRL_DIR
    ? path.resolve(process.env.XBRL_DIR)
    : resolveFromProject("data", "xbrl");
}

/** BRSR PDF attachments: data/pdf/2025/SYMBOL/, data/pdf/2026/SYMBOL/ (download only, not parsed) */
export function resolvePdfDir() {
  if (process.env.VERCEL) {
    return "/tmp/pdf";
  }
  return process.env.PDF_DIR
    ? path.resolve(process.env.PDF_DIR)
    : resolveFromProject("data", "pdf");
}

/** Maps local pdf relative keys → Cloudflare R2 public URLs (committed; small JSON). */
export function resolvePdfR2MapPath() {
  return process.env.PDF_R2_MAP_PATH
    ? path.resolve(process.env.PDF_R2_MAP_PATH)
    : resolveFromProject("data", "pdf_r2_urls.json");
}

/** Maps local pdf relative keys → Hugging Face Hub resolve URLs (committed; small JSON). */
export function resolvePdfHfMapPath() {
  return process.env.PDF_HF_MAP_PATH
    ? path.resolve(process.env.PDF_HF_MAP_PATH)
    : resolveFromProject("data", "pdf_hf_urls.json");
}

export function resolveDbPath() {
  if (process.env.VERCEL) {
    return "/tmp/database.db";
  }
  return process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : resolveFromProject("data", "database.db");
}
