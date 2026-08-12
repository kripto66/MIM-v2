import { createClient } from '@supabase/supabase-js';

const flows = new Map();
const TTL = 10 * 60 * 1000;

export function newOAuthClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      flowType: 'pkce',
      detectSessionInUrl: false,
    },
  });
}

function purgeExpired() {
  const now = Date.now();
  for (const [id, entry] of flows) {
    if (now - entry.createdAt > TTL) flows.delete(id);
  }
}

export function storeFlow(flowId, client) {
  purgeExpired();
  flows.set(flowId, { client, createdAt: Date.now() });
}

export function getFlow(flowId) {
  const entry = flows.get(flowId);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > TTL) {
    flows.delete(flowId);
    return null;
  }

  return entry.client;
}

export function deleteFlow(flowId) {
  flows.delete(flowId);
}
