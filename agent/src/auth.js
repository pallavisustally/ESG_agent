import { cert, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import jwt from 'jsonwebtoken';

const COOKIE_NAME = 'sustally_session';
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    throw new Error('SESSION_SECRET is required in production');
  }
  return 'dev-only-session-secret-change-me';
}

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT must be valid JSON.');
  }
}

function initFirebaseAdmin() {
  if (getApps().length > 0) {
    return getApp();
  }

  const serviceAccount = parseServiceAccount();
  if (serviceAccount) {
    return initializeApp({
      credential: cert(serviceAccount),
    });
  }

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (projectId) {
    return initializeApp({ projectId });
  }

  return null;
}

export function getPublicFirebaseConfig() {
  const apiKey = process.env.FIREBASE_API_KEY?.trim();
  const authDomain = process.env.FIREBASE_AUTH_DOMAIN?.trim();
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET?.trim();
  const messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID?.trim();
  const appId = process.env.FIREBASE_APP_ID?.trim();
  const measurementId = process.env.FIREBASE_MEASUREMENT_ID?.trim();

  if (!apiKey || !authDomain || !projectId || !appId) {
    return null;
  }

  const config = {
    apiKey,
    authDomain,
    projectId,
    storageBucket: storageBucket || `${projectId}.appspot.com`,
    messagingSenderId: messagingSenderId || '',
    appId,
  };

  if (measurementId) {
    config.measurementId = measurementId;
  }

  return config;
}

export function isFirebaseAuthConfigured() {
  const hasClientConfig = Boolean(getPublicFirebaseConfig());
  const hasServerConfig = Boolean(
    parseServiceAccount() || process.env.FIREBASE_PROJECT_ID?.trim(),
  );
  return hasClientConfig && hasServerConfig;
}

export async function verifyFirebaseIdToken(idToken) {
  const app = initFirebaseAdmin();
  if (!app) {
    throw new Error('Firebase Authentication is not configured on this server.');
  }

  const decoded = await getAuth(app).verifyIdToken(idToken);
  if (!decoded?.uid || !decoded.email) {
    throw new Error('Invalid Firebase account payload.');
  }

  return {
    firebaseUid: decoded.uid,
    email: decoded.email,
    name: decoded.name || decoded.email.split('@')[0],
    picture: decoded.picture || null,
  };
}

export function createSessionToken(user) {
  return jwt.sign(
    {
      email: user.email,
      name: user.name,
      picture: user.picture,
    },
    getSessionSecret(),
    {
      subject: String(user.id),
      expiresIn: SESSION_MAX_AGE_SEC,
    },
  );
}

export function verifySessionToken(token) {
  if (!token) return null;

  try {
    const payload = jwt.verify(token, getSessionSecret());
    const userId = Number(payload.sub);
    if (!userId || !payload.email) return null;

    return {
      id: userId,
      email: String(payload.email),
      name: payload.name ? String(payload.name) : String(payload.email).split('@')[0],
      picture: payload.picture ? String(payload.picture) : null,
    };
  } catch {
    return null;
  }
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: Boolean(process.env.VERCEL || process.env.NODE_ENV === 'production'),
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_SEC * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: Boolean(process.env.VERCEL || process.env.NODE_ENV === 'production'),
    sameSite: 'lax',
    path: '/',
  });
}

export function getSessionTokenFromRequest(req) {
  return req.cookies?.[COOKIE_NAME] || null;
}

export async function getUserFromRequest(req) {
  const token = getSessionTokenFromRequest(req);
  return verifySessionToken(token);
}

export function requireAuth(req, res, next) {
  getUserFromRequest(req)
    .then((user) => {
      if (!user) {
        return res.status(401).json({ success: false, error: 'Authentication required.' });
      }
      req.user = user;
      next();
    })
    .catch(() => {
      res.status(401).json({ success: false, error: 'Authentication required.' });
    });
}
