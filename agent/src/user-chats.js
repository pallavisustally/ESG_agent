import { getDb } from './db.js';
import {
  serializeMemoryForStorage,
  memoryFromStorage,
} from './memory/conversation-memory.js';

export async function initUserChatTables(db) {
  const pg = db.dialect === 'postgres';
  const userIdCol = pg ? 'id SERIAL PRIMARY KEY' : 'id INTEGER PRIMARY KEY AUTOINCREMENT';
  const createdAt = pg
    ? 'created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP'
    : 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP';

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      ${userIdCol},
      google_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      name TEXT,
      picture TEXT,
      ${createdAt}
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      history_json TEXT NOT NULL,
      memory_json TEXT,
      updated_at BIGINT NOT NULL,
      ${createdAt}
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated
    ON chat_sessions(user_id, updated_at DESC)
  `);

  await ensureChatSessionSchema(db);
}

async function ensureChatSessionSchema(db) {
  if (db.dialect === 'postgres') {
    try {
      await db.exec('ALTER TABLE chat_sessions ALTER COLUMN user_id DROP NOT NULL');
    } catch {
      // already nullable, or table just created nullable
    }
    try {
      await db.exec('ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS memory_json TEXT');
    } catch {
      // column exists
    }
    return;
  }

  const columns = await db.all('PRAGMA table_info(chat_sessions)');
  const names = new Set(columns.map((c) => c.name));
  if (!names.has('memory_json')) {
    await db.exec('ALTER TABLE chat_sessions ADD COLUMN memory_json TEXT');
  }
  const userCol = columns.find((c) => c.name === 'user_id');
  if (userCol && Number(userCol.notnull) === 1) {
    await rebuildChatSessionsNullable(db);
  }
}

async function rebuildChatSessionsNullable(db) {
  await db.exec('PRAGMA foreign_keys = OFF');
  await db.exec(`
    CREATE TABLE chat_sessions_new (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      history_json TEXT NOT NULL,
      memory_json TEXT,
      updated_at BIGINT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`
    INSERT INTO chat_sessions_new (id, user_id, title, history_json, memory_json, updated_at, created_at)
    SELECT id, user_id, title, history_json, memory_json, updated_at, created_at
    FROM chat_sessions
  `);
  await db.exec('DROP TABLE chat_sessions');
  await db.exec('ALTER TABLE chat_sessions_new RENAME TO chat_sessions');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated
    ON chat_sessions(user_id, updated_at DESC)
  `);
  await db.exec('PRAGMA foreign_keys = ON');
}

function sameOwnerClause(db) {
  return db.dialect === 'postgres'
    ? 'chat_sessions.user_id IS NOT DISTINCT FROM excluded.user_id'
    : 'chat_sessions.user_id IS excluded.user_id';
}

export async function findOrCreateUser({ firebaseUid, email, name, picture }) {
  const db = await getDb();

  const existing = await db.get(
    'SELECT id, google_id, email, name, picture FROM users WHERE google_id = ?',
    [firebaseUid],
  );

  if (existing) {
    await db.run(
      'UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?',
      [email, name, picture, existing.id],
    );
    return {
      id: existing.id,
      firebaseUid,
      email,
      name,
      picture,
    };
  }

  await db.run(
    'INSERT INTO users (google_id, email, name, picture) VALUES (?, ?, ?, ?)',
    [firebaseUid, email, name, picture],
  );

  const created = await db.get(
    'SELECT id FROM users WHERE google_id = ?',
    [firebaseUid],
  );

  return {
    id: created.id,
    firebaseUid,
    email,
    name,
    picture,
  };
}

function parseHistory(historyJson) {
  try {
    const history = JSON.parse(historyJson);
    return Array.isArray(history) ? history : [];
  } catch {
    return [];
  }
}

function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    history: parseHistory(row.history_json),
    memory: row.memory_json ? memoryFromStorage(row.memory_json) : null,
    timestamp: row.updated_at,
    userId: row.user_id == null ? null : row.user_id,
  };
}

function titleFromHistory(history = []) {
  const firstUser = (history || []).find((m) => m.role === 'user');
  const content = String(firstUser?.content || firstUser?.text || '').trim();
  if (!content) return 'New Sustainability Analysis';
  return content.length > 48 ? `${content.slice(0, 48)}…` : content;
}

export async function getChatSessionById(sessionId) {
  if (!sessionId) return null;
  const db = await getDb();
  const row = await db.get(
    'SELECT id, user_id, title, history_json, memory_json, updated_at FROM chat_sessions WHERE id = ?',
    [sessionId],
  );
  return rowToSession(row);
}

export async function getSessionMemory(sessionId) {
  const session = await getChatSessionById(sessionId);
  return session?.memory || null;
}

export async function getUserChatSessions(userId) {
  const db = await getDb();
  const rows = await db.all(
    `SELECT id, user_id, title, history_json, memory_json, updated_at
     FROM chat_sessions
     WHERE user_id = ?
     ORDER BY updated_at DESC`,
    [userId],
  );

  return rows.map(rowToSession);
}

/**
 * Insert or update a session owned by userId, or a guest session when userId is null.
 * Guests cannot overwrite a signed-in user's row. Sign-in can claim a guest row.
 */
export async function upsertChatSession(userId, session) {
  const db = await getDb();
  const historyJson = JSON.stringify(session.history || []);
  const memoryJson = session.memory
    ? JSON.stringify(serializeMemoryForStorage(session.memory))
    : null;
  const updatedAt = session.timestamp || Date.now();
  const title = session.title || titleFromHistory(session.history) || 'New Sustainability Analysis';
  const owner = userId == null ? null : userId;
  const sameOwner = sameOwnerClause(db);

  await db.run(
    `INSERT INTO chat_sessions (id, user_id, title, history_json, memory_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       history_json = excluded.history_json,
       memory_json = COALESCE(excluded.memory_json, chat_sessions.memory_json),
       updated_at = excluded.updated_at,
       user_id = COALESCE(excluded.user_id, chat_sessions.user_id)
     WHERE ${sameOwner}
        OR (chat_sessions.user_id IS NULL AND excluded.user_id IS NOT NULL)`,
    [session.id, owner, title, historyJson, memoryJson, updatedAt],
  );
}

export async function upsertUserChatSession(userId, session) {
  return upsertChatSession(userId, session);
}

export async function persistChatTurn({
  sessionId,
  userId = null,
  history = [],
  memory = null,
  title = null,
} = {}) {
  if (!sessionId) return null;
  const existing = await getChatSessionById(sessionId);
  if (existing?.userId != null && userId != null && Number(existing.userId) !== Number(userId)) {
    return null;
  }
  if (existing?.userId != null && userId == null) {
    return null;
  }
  const owner = userId ?? existing?.userId ?? null;
  await upsertChatSession(owner, {
    id: sessionId,
    title: title || existing?.title || titleFromHistory(history),
    history,
    memory,
    timestamp: Date.now(),
  });
  return getChatSessionById(sessionId);
}

export async function renameChatSession(userId, sessionId, title) {
  const nextTitle = String(title || '').trim();
  if (!sessionId || !nextTitle) return false;
  const db = await getDb();
  const updatedAt = Date.now();
  let result;
  if (userId != null) {
    result = await db.run(
      `UPDATE chat_sessions
       SET title = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [nextTitle.slice(0, 120), updatedAt, sessionId, userId],
    );
  } else {
    result = await db.run(
      `UPDATE chat_sessions
       SET title = ?, updated_at = ?
       WHERE id = ? AND user_id IS NULL`,
      [nextTitle.slice(0, 120), updatedAt, sessionId],
    );
  }
  return result.changes > 0;
}

export async function deleteUserChatSession(userId, sessionId) {
  const db = await getDb();
  let result;
  if (userId != null) {
    result = await db.run(
      'DELETE FROM chat_sessions WHERE id = ? AND user_id = ?',
      [sessionId, userId],
    );
  } else {
    result = await db.run(
      'DELETE FROM chat_sessions WHERE id = ? AND user_id IS NULL',
      [sessionId],
    );
  }
  return result.changes > 0;
}

export async function migrateUserChatSessions(userId, sessions) {
  const db = await getDb();

  if (Array.isArray(sessions)) {
    for (const session of sessions) {
      if (!session?.id) continue;
      const history = Array.isArray(session.history) ? session.history : [];
      const existing = await db.get(
        'SELECT id, user_id, history_json FROM chat_sessions WHERE id = ?',
        [session.id],
      );

      if (existing && existing.user_id == null) {
        await db.run(
          `UPDATE chat_sessions
           SET user_id = ?,
               title = COALESCE(NULLIF(?, ''), title),
               history_json = ?,
               memory_json = COALESCE(?, memory_json),
               updated_at = ?
           WHERE id = ? AND user_id IS NULL`,
          [
            userId,
            session.title || '',
            JSON.stringify(history.length ? history : parseHistory(existing.history_json)),
            session.memory ? JSON.stringify(serializeMemoryForStorage(session.memory)) : null,
            session.timestamp || Date.now(),
            session.id,
          ],
        );
        continue;
      }

      if (existing && Number(existing.user_id) === Number(userId)) {
        if (history.length) {
          await upsertChatSession(userId, session);
        }
        continue;
      }

      if (!existing && history.length > 0) {
        await upsertChatSession(userId, session);
      }
    }
  }

  return getUserChatSessions(userId);
}
