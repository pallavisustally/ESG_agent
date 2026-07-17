import { getDb } from './db.js';

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
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      history_json TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      ${createdAt}
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_updated
    ON chat_sessions(user_id, updated_at DESC)
  `);
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

function rowToSession(row) {
  let history = [];
  try {
    history = JSON.parse(row.history_json);
    if (!Array.isArray(history)) history = [];
  } catch {
    history = [];
  }

  return {
    id: row.id,
    title: row.title,
    history,
    timestamp: row.updated_at,
  };
}

export async function getUserChatSessions(userId) {
  const db = await getDb();
  const rows = await db.all(
    `SELECT id, title, history_json, updated_at
     FROM chat_sessions
     WHERE user_id = ?
     ORDER BY updated_at DESC`,
    [userId],
  );

  return rows.map(rowToSession);
}

export async function upsertUserChatSession(userId, session) {
  const db = await getDb();
  const historyJson = JSON.stringify(session.history || []);
  const updatedAt = session.timestamp || Date.now();

  await db.run(
    `INSERT INTO chat_sessions (id, user_id, title, history_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       history_json = excluded.history_json,
       updated_at = excluded.updated_at
     WHERE chat_sessions.user_id = excluded.user_id`,
    [session.id, userId, session.title || 'New Sustainability Analysis', historyJson, updatedAt],
  );
}

export async function deleteUserChatSession(userId, sessionId) {
  const db = await getDb();
  const result = await db.run(
    'DELETE FROM chat_sessions WHERE id = ? AND user_id = ?',
    [sessionId, userId],
  );
  return result.changes > 0;
}

export async function migrateUserChatSessions(userId, sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return getUserChatSessions(userId);
  }

  for (const session of sessions) {
    if (!session?.id || !Array.isArray(session.history) || session.history.length === 0) {
      continue;
    }

    const existingRows = await (await getDb()).get(
      'SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?',
      [session.id, userId],
    );

    if (!existingRows) {
      await upsertUserChatSession(userId, session);
    }
  }

  return getUserChatSessions(userId);
}
