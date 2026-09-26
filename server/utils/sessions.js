import crypto from 'node:crypto';
import { serviceClient } from '../app.js';

export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MFA_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MFA_MAX_ATTEMPTS = 5;

function sessionEncryptionKey() {
  const secret = process.env.SESSION_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error('SESSION_ENCRYPTION_KEY ou JWT_SECRET est requis.');
  return crypto.createHash('sha256').update(String(secret)).digest();
}

export function encryptSessionValue(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSessionValue(value) {
  if (!value) return null;
  const raw = String(value);
  if (!raw.startsWith('v1.')) return raw;
  try {
    const [, ivPart, tagPart, ciphertextPart] = raw.split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionEncryptionKey(), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function sessionExpiry() {
  return new Date(Date.now() + SESSION_ABSOLUTE_TTL_MS);
}

export async function createSession({ userId, session, userAgent = '', ip = '', action = 'login' }) {
  if (!userId) throw new Error('userId requis pour créer une session');

  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  let data = null;
  let error = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await serviceClient()
      .from('sessions')
      .insert({
        user_id: userId,
        action,
        user_agent: ip ? `${String(ip).slice(0, 45)} | ${String(userAgent || '').slice(0, 200)}` : String(userAgent || '').slice(0, 200),
        created_at: now.toISOString(),
        absolute_expires_at: sessionExpiry().toISOString(),
        updated_at: now.toISOString(),
        token_hash: hashSessionToken(token),
        supabase_access_token: encryptSessionValue(session?.access_token),
        supabase_refresh_token: encryptSessionValue(session?.refresh_token),
        supabase_expires_at: session?.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
      })
      .select('*')
      .single();
    data = result.data;
    error = result.error;
    if (!error && data) break;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }

  if (error || !data) {
    throw new Error(error?.message || 'Impossible de créer la session.');
  }

  return { ...data, token };
}

export async function findSessionByToken(token) {
  if (!token) return null;
  const { data, error } = await serviceClient()
    .from('sessions')
    .select('*')
    .eq('token_hash', hashSessionToken(token))
    .maybeSingle();
  if (error) throw error;
  if (!data || data.action === 'mfa_pending' || data.revoked_at || data.logout_at) return null;
  if (data.absolute_expires_at && new Date(data.absolute_expires_at).getTime() <= Date.now()) return null;
  return {
    ...data,
    supabase_access_token: decryptSessionValue(data.supabase_access_token),
    supabase_refresh_token: decryptSessionValue(data.supabase_refresh_token),
  };
}

export async function updateSessionTokens(sessionId, session) {
  if (!sessionId || !session) return;
  const { error } = await serviceClient()
    .from('sessions')
    .update({
      supabase_access_token: encryptSessionValue(session.access_token),
      supabase_refresh_token: encryptSessionValue(session.refresh_token),
      supabase_expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId);
  if (error) throw error;
}

export async function createMfaChallenge({ userId, session, factorId, userAgent = '', ip = '' }) {
  if (!userId || !session?.access_token || !factorId) throw new Error('Challenge MFA incomplet.');
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const { data, error } = await serviceClient()
    .from('sessions')
    .insert({
      user_id: userId,
      action: 'mfa_pending',
      user_agent: ip ? `${String(ip).slice(0, 45)} | ${String(userAgent || '').slice(0, 200)}` : String(userAgent || '').slice(0, 200),
      created_at: now.toISOString(),
      absolute_expires_at: new Date(Date.now() + MFA_CHALLENGE_TTL_MS).toISOString(),
      updated_at: now.toISOString(),
      token_hash: hashSessionToken(token),
      supabase_access_token: encryptSessionValue(session.access_token),
      supabase_refresh_token: encryptSessionValue(session.refresh_token),
      supabase_expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
      mfa_factor_id: String(factorId),
      mfa_status: 'pending',
      mfa_attempts: 0,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message || 'Impossible de créer le challenge MFA.');
  return { id: data.id, token };
}

async function claimMfaQuery(extra) {
  const now = new Date();
  let query = serviceClient()
    .from('sessions')
    .update({ mfa_status: 'processing', mfa_processing_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('action', 'mfa_pending')
    .eq('token_hash', extra.tokenHash)
    .is('revoked_at', null)
    .is('logout_at', null)
    .gt('absolute_expires_at', now.toISOString())
    .lt('mfa_attempts', MFA_MAX_ATTEMPTS);
  if (extra.processing) {
    query = query.eq('mfa_status', 'processing').lt('mfa_processing_at', extra.staleBefore);
  } else {
    query = query.eq('mfa_status', 'pending');
  }
  const { data, error } = await query.select('*').maybeSingle();
  if (error) throw error;
  return data;
}

export async function claimMfaChallenge(token) {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  let data = await claimMfaQuery({ tokenHash, processing: false });
  if (!data) {
    const staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    data = await claimMfaQuery({ tokenHash, processing: true, staleBefore });
  }
  if (!data) return null;
  return {
    ...data,
    supabase_access_token: decryptSessionValue(data.supabase_access_token),
    supabase_refresh_token: decryptSessionValue(data.supabase_refresh_token),
  };
}

export async function finishMfaChallenge(challenge, success) {
  if (!challenge?.id) return false;
  const attempts = Number(challenge.mfa_attempts || 0) + (success ? 0 : 1);
  const patch = success || attempts >= MFA_MAX_ATTEMPTS
    ? {
        mfa_status: 'consumed',
        revoked_at: new Date().toISOString(),
        logout_at: new Date().toISOString(),
        revoked_reason: success ? 'mfa_verified' : 'mfa_attempts_exceeded',
        mfa_processing_at: null,
        updated_at: new Date().toISOString(),
      }
    : {
        mfa_status: 'pending',
        mfa_attempts: attempts,
        mfa_processing_at: null,
        updated_at: new Date().toISOString(),
      };
  const { data, error } = await serviceClient()
    .from('sessions')
    .update(patch)
    .eq('id', challenge.id)
    .eq('mfa_status', 'processing')
    .eq('mfa_attempts', challenge.mfa_attempts || 0)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function revokeSession(sessionId, userId = null, reason = 'logout') {
  if (!sessionId) return false;
  let query = serviceClient().from('sessions').update({
    revoked_at: new Date().toISOString(),
    revoked_reason: String(reason).slice(0, 80),
    logout_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', sessionId);
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query.select('id').maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function revokeAllSessions(userId, exceptSessionId = null, reason = 'security') {
  if (!userId) return 0;
  let query = serviceClient()
    .from('sessions')
    .update({
      revoked_at: new Date().toISOString(),
      revoked_reason: String(reason).slice(0, 80),
      logout_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .is('revoked_at', null);
  if (exceptSessionId) query = query.neq('id', exceptSessionId);
  const { data, error } = await query.select('id');
  if (error) throw error;
  return data?.length || 0;
}

export async function logSession(userId, action, _supabaseToken, userAgent = '', ip = '') {
  if (!userId || !action) return;
  const { error } = await serviceClient().from('sessions').insert({
    user_id: userId,
    action,
    user_agent: ip ? `${String(ip).slice(0, 45)} | ${String(userAgent || '').slice(0, 200)}` : String(userAgent || '').slice(0, 200),
  });
  if (error) console.warn('[session] insert échec :', error.message);
}

export async function closeSession(userId, sessionId = null) {
  if (sessionId) return revokeSession(sessionId, userId, 'logout');
  if (!userId) return false;
  const { data, error } = await serviceClient()
    .from('sessions')
    .select('id')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? revokeSession(data.id, userId, 'logout') : false;
}
