import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const BCRYPT_ROUNDS = 12;

/**
 * Hash a plaintext password.
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Compare a plaintext password against a hash.
 */
export async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Generate a JWT token for a user.
 */
export function generateToken(userId, email) {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Verify and decode a JWT token.
 * @returns {{ userId, email }} or null if invalid
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Generate a random token for email verification / password reset.
 */
export function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Express middleware: authenticate requests via JWT (cookie or Authorization header).
 * Sets req.userId and req.userEmail on success.
 */
export function authMiddleware(req, res, next) {
  // Skip auth routes and webhooks
  if (req.path.startsWith('/auth/') || req.path.startsWith('/webhook')) {
    return next();
  }

  // Support legacy API_TOKEN for backward compatibility (admin/service access)
  const API_TOKEN = process.env.API_TOKEN || '';
  if (API_TOKEN) {
    const header = req.headers.authorization || '';
    const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (bearerToken) {
      const ab = Buffer.from(String(bearerToken));
      const bb = Buffer.from(String(API_TOKEN));
      if (ab.length === bb.length && crypto.timingSafeEqual(ab, bb)) {
        // Admin token — set a special userId marker
        req.userId = '__admin__';
        req.userEmail = 'admin';
        return next();
      }
    }
  }

  // Try JWT from cookie first, then Authorization header
  let token = req.cookies?.token;
  if (!token) {
    const header = req.headers.authorization || '';
    token = header.startsWith('Bearer ') ? header.slice(7) : '';
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.userId = decoded.userId;
  req.userEmail = decoded.email;
  next();
}
