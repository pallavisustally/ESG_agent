import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import { AGENT_ROOT, resolveFromProject, resolveXbrlDir, resolvePdfDir } from './paths.js';
import {
  isFirebaseAuthConfigured,
  verifyFirebaseIdToken,
  createSessionToken,
  getUserFromRequest,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  getPublicFirebaseConfig,
} from './auth.js';
import {
  findOrCreateUser,
  getUserChatSessions,
  upsertUserChatSession,
  deleteUserChatSession,
  migrateUserChatSessions,
} from './user-chats.js';

// Load environment variables
dotenv.config();

let getAvailableReports, deleteReport, getDb, runAgent, warmOllamaModel;
let startupError = null;

async function loadModules() {
  try {
    // If running on Vercel, copy database.db to /tmp/database.db
    if (process.env.VERCEL) {
      const dbSource = resolveFromProject("data", "database.db");
      const dbTarget = "/tmp/database.db";
      if (fs.existsSync(dbSource)) {
        const targetDir = path.dirname(dbTarget);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        if (!fs.existsSync(dbTarget)) {
          fs.copyFileSync(dbSource, dbTarget);
          console.log("Database copied to /tmp/database.db");
        }
      }
    }

    const dbModule = await import('./db.js');
    getAvailableReports = dbModule.getAvailableReports;
    deleteReport = dbModule.deleteReport;
    getDb = dbModule.getDb;

    const agentModule = await import('./agent.js');
    runAgent = agentModule.runAgent;

    const ollamaModule = await import('./ollama-client.js');
    warmOllamaModel = ollamaModule.warmOllamaModel;

    // Connect to database on startup
    await getDb();
    console.log('Database connected.');
    if (warmOllamaModel) {
      warmOllamaModel().catch(() => {});
    }
  } catch (err) {
    console.error('CRITICAL STARTUP ERROR:', err);
    startupError = String(err?.message || err);
  }
}

// Start loading immediately
const loadPromise = loadModules();

// BRSR/ESG XBRL directory (data/xbrl/2025/SYMBOL/, etc.)
let XBRL_DIR = null;
try {
  XBRL_DIR = resolveXbrlDir();
  if (!fs.existsSync(XBRL_DIR)) {
    fs.mkdirSync(XBRL_DIR, { recursive: true });
  }
} catch (err) {
  console.error('Failed to create XBRL_DIR:', err);
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, XBRL_DIR);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xml' || ext === '.xbrl' || file.mimetype === 'application/xml' || file.mimetype === 'text/xml') {
      cb(null, true);
    } else {
      cb(new Error('Only XML or XBRL files are allowed.'));
    }
  }
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(AGENT_ROOT, 'src', 'public')));

// Serve downloaded BRSR PDFs (data/pdf/YYYY/SYMBOL/) for citation "source" links
const PDF_DIR = resolvePdfDir();
if (!fs.existsSync(PDF_DIR)) {
  fs.mkdirSync(PDF_DIR, { recursive: true });
}
app.use(
  '/local-pdf',
  express.static(PDF_DIR, {
    fallthrough: false,
    setHeaders(res) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
    },
  }),
);

// Diagnostic check middleware
app.use(async (req, res, next) => {
  await loadPromise;
  if (startupError) {
    return res.status(500).json({
      success: false,
      error: "Startup Initialization Failed",
      message: startupError.message,
      stack: startupError.stack,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        VERCEL: process.env.VERCEL,
        VERCEL_ENV: process.env.VERCEL_ENV
      }
    });
  }
  next();
});

// Import XML processor dynamically
let processXmlFile;
import('../scripts/preprocess.js').then(module => {
  processXmlFile = module.processXmlFile;
}).catch(err => {
  console.error('Failed to import processXmlFile:', err);
});

// Liveness — process up (no DB). Use for platform probes.
app.get('/healthz', (_req, res) => {
  import('./ops/health.js').then(({ buildLivenessPayload }) => {
    res.status(200).json(buildLivenessPayload());
  }).catch(() => {
    res.status(200).json({ ok: true, status: 'alive' });
  });
});

// Readiness — modules loaded + DB ping.
app.get('/readyz', async (_req, res) => {
  try {
    const { buildReadinessPayload } = await import('./ops/health.js');
    const { checkDbHealth } = await import('./db-health.js');
    const payload = await buildReadinessPayload({
      startupError,
      loadPromise,
      getDb,
      checkDbHealth,
    });
    res.status(payload.ok ? 200 : 503).json(payload);
  } catch (error) {
    res.status(503).json({
      ok: false,
      status: 'not_ready',
      reason: 'exception',
      error: error.message,
    });
  }
});

// API: Get database status & available reports
app.get('/api/status', async (req, res) => {
  try {
    await loadPromise;
    const { getLastDbHealth, checkDbHealth } = await import('./db-health.js');
    const db = await getDb();
    const health = await checkDbHealth(db);
    const reports = await getAvailableReports();
    res.json({
      success: true,
      reportsCount: reports.length,
      reports,
      database: {
        ok: health.ok,
        dialect: health.dialect,
        fallback: health.fallback,
        latencyMs: health.latencyMs,
        companyCount: health.companyCount,
        error: health.error,
        checkedAt: health.checkedAt,
      },
    });
  } catch (error) {
    const { getLastDbHealth } = await import('./db-health.js').catch(() => ({ getLastDbHealth: () => null }));
    res.status(503).json({
      success: false,
      error: error.message,
      database: getLastDbHealth?.() || { ok: false, error: error.message },
    });
  }
});

// Ops dashboard (static). API still auth-gated below.
app.get('/ops', (_req, res) => {
  res.sendFile(path.join(AGENT_ROOT, 'src', 'public', 'ops.html'));
});

// Production monitoring snapshot — requires MONITORING_TOKEN or session (Part 2).
app.get('/api/monitoring', async (req, res) => {
  const { requireMonitoringAccess } = await import('./ops/monitoring-auth.js');
  requireMonitoringAccess(req, res, async () => {
    try {
      const {
        getMonitoringSnapshot,
        aggregateObservabilityLog,
        flushMonitoringSnapshot,
      } = await import('./observability/monitoring.js');
      const flush = String(req.query.flush || '') === '1';
      const snapshot = flush ? flushMonitoringSnapshot() : getMonitoringSnapshot();
      const historical = aggregateObservabilityLog({ maxLines: Number(req.query.lines) || 2000 });
      res.json({
        success: true,
        live: snapshot,
        historical: {
          ok: historical.ok,
          events: historical.events,
          byStage: historical.byStage,
          planValidationFailures: historical.planValidationFailures,
          responseValidationFailures: historical.responseValidationFailures,
          responseValidationWarnings: historical.responseValidationWarnings,
          clarifications: historical.clarifications,
          sqlDocumentFallbacks: historical.sqlDocumentFallbacks,
          pdfSources: historical.pdfSources,
          narrativeSources: historical.narrativeSources,
          recommendationRuns: historical.recommendationRuns,
          recommendationFailures: historical.recommendationFailures,
          averageLatencyMs: historical.averageLatencyMs,
          pdfFallbackRate: historical.pdfFallbackRate,
          clarificationRate: historical.clarificationRate,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
});

// API: Get application configuration defaults
app.get('/api/config', (req, res) => {
  const useOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  const useOpenRouter = Boolean(process.env.OPENROUTER_API_KEY?.trim());
  const fixedModel = useOpenAI
    ? (process.env.OPENAI_MODEL || 'gpt-4o-mini')
    : useOpenRouter
      ? (process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini')
      : (process.env.OLLAMA_MODEL || 'qwen2.5:7b');
  res.json({
    defaultModel: fixedModel,
    ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
    provider: useOpenAI ? 'openai' : useOpenRouter ? 'openrouter' : 'ollama',
    // When OpenAI is configured, the model is fixed via OPENAI_MODEL (no client override).
    modelFixed: useOpenAI,
    firebase: getPublicFirebaseConfig(),
    authEnabled: isFirebaseAuthConfigured(),
  });
});

// API: Current authenticated user
app.get('/api/auth/me', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    res.json({
      success: true,
      authenticated: Boolean(user),
      user: user || null,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Firebase Sign-In
app.post('/api/auth/firebase', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ success: false, error: 'Firebase ID token is required.' });
    }

    const profile = await verifyFirebaseIdToken(idToken);
    const user = await findOrCreateUser({
      firebaseUid: profile.firebaseUid,
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    });

    const token = await createSessionToken(user);
    setSessionCookie(res, token);

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
    });
  } catch (error) {
    console.error('Firebase auth error:', error);
    res.status(401).json({ success: false, error: error.message });
  }
});

// API: Sign out
app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

// API: List user chat sessions
app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const sessions = await getUserChatSessions(req.user.id);
    res.json({ success: true, sessions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Create or update a chat session
app.post('/api/sessions', requireAuth, async (req, res) => {
  try {
    const { id, title, history, timestamp } = req.body;
    if (!id || !Array.isArray(history)) {
      return res.status(400).json({ success: false, error: 'Session id and history are required.' });
    }

    await upsertUserChatSession(req.user.id, {
      id,
      title: title || 'New Sustainability Analysis',
      history,
      timestamp: timestamp || Date.now(),
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Migrate local sessions on first sign-in
app.post('/api/sessions/migrate', requireAuth, async (req, res) => {
  try {
    const { sessions = [] } = req.body;
    const merged = await migrateUserChatSessions(req.user.id, sessions);
    res.json({ success: true, sessions: merged });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Delete a chat session
app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    const deleted = await deleteUserChatSession(req.user.id, req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Session not found.' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Upload custom XML/XBRL report
app.post('/api/upload-custom', upload.single('xbrl'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }

    if (!processXmlFile) {
      return res.status(500).json({ success: false, error: 'XML processing engine is starting up. Please try again.' });
    }

    const filePath = path.join(XBRL_DIR, req.file.filename);
    const results = await processXmlFile(filePath, 1);

    res.json({
      success: true,
      message: 'XBRL report uploaded and indexed successfully!',
      filename: req.file.filename,
      records: results
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Delete a report
app.post('/api/delete-report', async (req, res) => {
  const { company, year, filename } = req.body;
  if (!company || !year) {
    return res.status(400).json({ success: false, error: 'Company and year are required.' });
  }

  try {
    await deleteReport(company, parseInt(year));
    
    if (filename) {
      const filePath = path.join(XBRL_DIR, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    res.json({ success: true, message: `Successfully deleted report for ${company} (${year})` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Full / paginated company list export (BRSR reports table)
app.get('/api/companies', async (req, res) => {
  try {
    await loadPromise;
    if (startupError) {
      return res.status(503).json({ success: false, error: 'Service unavailable' });
    }
    const { getCompanyList: listFn } = await import('./db.js');
    const { paginateArray, toCsv, normalizePageParams } = await import('./pagination/pagination.js');
    const sector = typeof req.query.sector === 'string' ? req.query.sector.trim() : '';
    const format = String(req.query.format || 'json').toLowerCase();
    let companies = await listFn();
    if (sector) {
      const db = await getDb();
      const rows = await db.all(
        `SELECT DISTINCT company FROM reports WHERE lower(COALESCE(sector,'')) = lower(?) ORDER BY company`,
        [sector],
      );
      companies = rows.map((r) => r.company);
    }
    const { page, pageSize } = normalizePageParams(req.query.page, req.query.limit || req.query.pageSize);
    const all = String(req.query.all || '') === '1' || format === 'csv';
    const paged = all
      ? {
          items: companies,
          page: 1,
          pageSize: companies.length,
          total: companies.length,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        }
      : paginateArray(companies, { page, pageSize });

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="brsr_companies.csv"');
      return res.send(toCsv(paged.items.map((c) => ({ company: c })), ['company']));
    }

    return res.json({
      success: true,
      total: paged.total,
      page: paged.page,
      pageSize: paged.pageSize,
      totalPages: paged.totalPages,
      hasNext: paged.hasNext,
      hasPrev: paged.hasPrev,
      sector: sector || null,
      companies: paged.items,
      exportCsv: `/api/companies?format=csv${sector ? `&sector=${encodeURIComponent(sector)}` : ''}`,
    });
  } catch (error) {
    console.error('[api/companies]', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// API: Agent Chat with SSE streaming
app.post('/api/chat', async (req, res) => {
  const { message, chatHistory = [], modelName = null, ollamaHost = null, sessionId = null } = req.body;

  if (!message) {
    return res.status(400).json({ success: false, error: 'Message is required.' });
  }

  // Lightweight rate limit (before SSE headers) — CHAT_RATE_LIMIT_RPM=0 disables.
  try {
    const {
      consumeRateLimit,
      rateLimitKeyFromRequest,
    } = await import('./ops/rate-limit.js');
    const limited = consumeRateLimit(rateLimitKeyFromRequest(req));
    if (!limited.ok) {
      res.setHeader('Retry-After', String(limited.retryAfterSec));
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please wait a moment and try again.',
        retryAfterSec: limited.retryAfterSec,
        limit: limited.limit,
      });
    }
  } catch (rateErr) {
    console.warn('[api/chat] rate limit unavailable:', rateErr?.message || rateErr);
  }

  console.log(`[User Question] Received: "${message}"`);

  // OpenAI is the fixed cloud model — ignore client modelName/ollamaHost overrides.
  const useOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  const effectiveModelName = useOpenAI ? null : modelName;
  const effectiveOllamaHost = useOpenAI ? null : ollamaHost;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const abortController = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  };
  req.on('close', onClientClose);

  const sendEvent = (data) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await runAgent({
      userMessage: message,
      chatHistory,
      modelName: effectiveModelName,
      ollamaHost: effectiveOllamaHost,
      sessionId,
      signal: abortController.signal,
      onProgress: (progress) => {
        sendEvent(progress);
      }
    });

    sendEvent({
      status: 'done',
      text: result.text,
      chatHistory: result.chatHistory,
      pipeline: result.pipeline || null,
    });
    
    res.end();

    // Save chat interaction without blocking the next request.
    setImmediate(() => {
      try {
        const chatsFilePath = resolveFromProject('data', 'chats.json');
        const MAX_STORED_CHATS = parseInt(process.env.MAX_STORED_CHATS, 10) || 200;
        let chats = [];
        
        const dataDir = path.dirname(chatsFilePath);
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }

        if (fs.existsSync(chatsFilePath)) {
          const fileContent = fs.readFileSync(chatsFilePath, 'utf8');
          try {
            chats = JSON.parse(fileContent);
            if (!Array.isArray(chats)) {
              chats = [];
            }
          } catch (parseErr) {
            console.error('[Chat Storage] Error parsing chats.json, resetting to empty array:', parseErr);
            chats = [];
          }
        }

        chats.push({
          timestamp: new Date().toISOString(),
          question: message,
          response: result.text,
          chatHistory: chatHistory
        });

        if (chats.length > MAX_STORED_CHATS) {
          chats = chats.slice(-MAX_STORED_CHATS);
        }

        fs.writeFileSync(chatsFilePath, JSON.stringify(chats, null, 2), 'utf8');
        console.log(`[Chat Storage] Chat saved to backend JSON file. Total stored chats: ${chats.length}`);
      } catch (saveErr) {
        console.error('[Chat Storage] Failed to save chat to chats.json:', saveErr);
      }
    });

  } catch (error) {
    const aborted = abortController.signal.aborted
      || error?.name === 'AbortError'
      || error?.aborted === true;

    if (aborted) {
      console.log('[Agent] Generation stopped by client.');
      sendEvent({
        status: 'stopped',
        text: error?.partialText || '',
        message: 'Generation stopped'
      });
      res.end();
      return;
    }

    console.error('Agent chat error:', error);
    sendEvent({
      status: 'error',
      message: error.message
    });
    res.end();
  } finally {
    req.off('close', onClientClose);
  }
});

// Start Server (only if not running in Vercel Serverless environment)
if (!process.env.VERCEL) {
  app.listen(PORT, async () => {
    const provider = process.env.OPENAI_API_KEY?.trim()
      ? 'OpenAI'
      : process.env.OPENROUTER_API_KEY?.trim()
        ? 'OpenRouter'
        : 'Ollama';
    console.log(`Server is running at http://localhost:${PORT} (LLM: ${provider})`);
    try {
      await loadPromise;
      if (getDb) {
        await getDb();
        console.log('Database connected.');
      }
      if (warmOllamaModel) {
        warmOllamaModel().catch(() => {});
      }
    } catch (err) {
      console.error('Database connection failed:', err);
    }
  });
}

// Vercel serverless: allow longer agent runs (female-share rankings + LLM).
// Hobby max is typically 60s with Fluid; Pro can go higher — clamp via plan limits.
export const config = {
  maxDuration: 60,
};

export default app;
