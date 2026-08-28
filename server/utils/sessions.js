import { authedClient } from '../app.js';

export async function logSession(userId, action, supabaseToken, userAgent = '', ip = '') {
  try {
    const sb = authedClient(supabaseToken);
    const ua = String(userAgent || '').slice(0, 200);
    const ipStr = String(ip || '').slice(0, 45);

    const { error } = await sb.from('sessions').insert({
      user_id: userId,
      action,
      user_agent: ipStr ? `${ipStr} | ${ua}` : ua,
    });

    if (error) {
      console.warn('[session] insert échec :', error.message);
    }
  } catch (err) {
    console.warn('[session] erreur :', err.message);
  }
}

export async function closeSession(userId, supabaseToken, userAgent = '') {
  if (!supabaseToken) {
    console.warn('[session] close ignoré : supabaseToken manquant');
    return;
  }
  try {
    const sb = authedClient(supabaseToken);
    const ua = String(userAgent || '').slice(0, 200);

    // Ferme uniquement la session la plus récente correspondant à cet
    // user_agent, pour ne pas affecter les autres appareils connectés.
    const { data: sessions } = await sb
      .from('sessions')
      .select('id')
      .eq('user_id', userId)
      .is('logout_at', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!sessions?.length) return;

    const { error } = await sb
      .from('sessions')
      .update({ logout_at: new Date().toISOString() })
      .eq('id', sessions[0].id);

    if (error) {
      console.warn('[session] close échec :', error.message);
    }
  } catch (err) {
    console.warn('[session] erreur close :', err.message);
  }
}
