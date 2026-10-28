import crypto from 'node:crypto';

export const ACCESS_TOKEN_BYTES = 32;
export const ACCESS_TOKEN_PREFIX = 'spk_';
export const ACCESS_TOKEN_PATTERN = /^spk_[A-Za-z0-9_-]{43}$/;

export function normalizeAccessToken(token) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!ACCESS_TOKEN_PATTERN.test(value)) {
    throw new Error('Access_token must contain one valid SPARK-generated spk_ token');
  }
  return value;
}

export function digestAccessToken(token) {
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('token must be a non-empty string');
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateAccessToken({ randomBytes = crypto.randomBytes } = {}) {
  const bytes = randomBytes(ACCESS_TOKEN_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length !== ACCESS_TOKEN_BYTES) {
    throw new Error(`random source must return exactly ${ACCESS_TOKEN_BYTES} bytes`);
  }
  const token = `${ACCESS_TOKEN_PREFIX}${bytes.toString('base64url')}`;
  return {
    token,
    sha256: digestAccessToken(token),
    entropyBits: ACCESS_TOKEN_BYTES * 8,
  };
}
