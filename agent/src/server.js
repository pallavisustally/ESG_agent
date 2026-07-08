import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { getAvailableReports, deleteReport } from './db.js';
import { runAgent } from './agent.js';
import { getDb } from './db.js';
import { AGENT_ROOT, resolveFromProject, resolveXbrlDir } from './paths.js';
import { warmOllamaModel } from './ollama-client.js';

// Load environment variables
dotenv.config();

// BRSR/ESG XBRL directory (data/xbrl/2025/SYMBOL/, etc.)
const XBRL_DIR = resolveXbrlDir();
if (!fs.existsSync(XBRL_DIR)) {
  fs.mkdirSync(XBRL_DIR, { recursive: true });
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
app.use(express.static(path.join(AGENT_ROOT, 'src', 'public')));

// Import XML processor dynamically
let processXmlFile;
import('../scripts/preprocess.js').then(module => {
  processXmlFile = module.processXmlFile;
}).catch(err => {
  console.error('Failed to import processXmlFile:', err);
});

// API: Get database status & available reports
app.get('/api/status', async (req, res) => {
  try {
    const reports = await getAvailableReports();
    res.json({
      success: true,
      reportsCount: reports.length,
      reports
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get application configuration defaults
app.get('/api/config', (req, res) => {
  const useOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  const useOpenRouter = Boolean(process.env.OPENROUTER_API_KEY?.trim());
  res.json({
    defaultModel: useOpenAI
      ? (process.env.OPENAI_MODEL || 'gpt-4o-mini')
      : useOpenRouter
        ? (process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini')
        : (process.env.OLLAMA_MODEL || 'qwen2.5:7b'),
    ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
    provider: useOpenAI ? 'openai' : useOpenRouter ? 'openrouter' : 'ollama',
  });
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

// API: Agent Chat with SSE streaming
app.post('/api/chat', async (req, res) => {
  const { message, chatHistory = [], modelName = null, ollamaHost = null } = req.body;

  if (!message) {
    return res.status(400).json({ success: false, error: 'Message is required.' });
  }

  console.log(`[User Question] Received: "${message}"`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await runAgent({
      userMessage: message,
      chatHistory,
      modelName,
      ollamaHost,
      onProgress: (progress) => {
        sendEvent(progress);
      }
    });

    sendEvent({
      status: 'done',
      text: result.text,
      chatHistory: result.chatHistory
    });
    
    res.end();

    // Save chat interaction to backend JSON file
    try {
      const chatsFilePath = resolveFromProject('data', 'chats.json');
      let chats = [];
      
      // Ensure data directory exists (just in case)
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

      fs.writeFileSync(chatsFilePath, JSON.stringify(chats, null, 2), 'utf8');
      console.log(`[Chat Storage] Chat saved to backend JSON file. Total stored chats: ${chats.length}`);
    } catch (saveErr) {
      console.error('[Chat Storage] Failed to save chat to chats.json:', saveErr);
    }

  } catch (error) {
    console.error('Agent chat error:', error);
    sendEvent({
      status: 'error',
      message: error.message
    });
    res.end();
  }
});

// Start Server
app.listen(PORT, async () => {
  const provider = process.env.OPENAI_API_KEY?.trim()
    ? 'OpenAI'
    : process.env.OPENROUTER_API_KEY?.trim()
      ? 'OpenRouter'
      : 'Ollama';
  console.log(`Server is running at http://localhost:${PORT} (LLM: ${provider})`);
  try {
    await getDb();
    console.log('Database connected.');
    warmOllamaModel().catch(() => {});
  } catch (err) {
    console.error('Database connection failed:', err);
  }
});
