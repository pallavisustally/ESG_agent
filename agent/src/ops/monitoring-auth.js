/**
 * Auth gate for /api/monitoring and the ops dashboard API.
 *
 * Priority:
 * 1. MONITORING_TOKEN via Bearer / x-monitoring-token / ?token=
 * 2. Firebase session cookie when auth is configured
 * 3. Open in local/dev only (not Vercel / production)
 */

import {
  getUserFromRequest,
  isFirebaseAuthConfigured,
} from '../auth.js';

export function extractMonitoringToken(req) {
  const header = req.headers?.['x-monitoring-token'];
  if (header) return String(header).trim();
  const auth = req.headers?.authorization || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (req.query?.token) return String(req.query.token).trim();
  return '';
}

/**
 * Express middleware — call before returning monitoring payloads.
 */
export async function requireMonitoringAccess(req, res, next) {
  try {
    const configured = process.env.MONITORING_TOKEN?.trim();
    if (configured) {
      const provided = extractMonitoringToken(req);
      if (provided && provided === configured) {
        req.monitoringAuth = { mode: 'token' };
        return next();
      }
      return res.status(401).json({
        success: false,
        error: 'Monitoring authentication required. Pass MONITORING_TOKEN via Bearer or x-monitoring-token.',
      });
    }

    if (isFirebaseAuthConfigured()) {
      const user = await getUserFromRequest(req);
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required for monitoring.',
        });
      }
      req.user = user;
      req.monitoringAuth = { mode: 'session', email: user.email };
      return next();
    }

    const locked = process.env.VERCEL || process.env.NODE_ENV === 'production';
    if (locked) {
      return res.status(401).json({
        success: false,
        error: 'Set MONITORING_TOKEN (or Firebase auth) to access monitoring in production.',
      });
    }

    // Local/dev open access
    res.setHeader('X-Monitoring-Auth', 'open-dev');
    req.monitoringAuth = { mode: 'open-dev' };
    return next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: String(err?.message || err),
    });
  }
}
