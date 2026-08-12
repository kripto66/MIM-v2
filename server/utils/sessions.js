import { authedClient } from '../app.js';

export async function logSession(userId, action, supabaseToken) {
  try {
    const sb = authedClient(supabaseToken);

    const { error } = await sb.from('sessions').insert({
      user_id: userId,
      action,
      user_agent: '',
    });

    if (error) {
      console.warn('[session] insert échec :', error.message);
    }
  } catch (err) {
    console.warn('[session] erreur :', err.message);
  }
}

export async function closeSession(userId, supabaseToken) {
  try {
    const sb = authedClient(supabaseToken);

    const { error } = await sb
      .from('sessions')
      .update({ logout_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('logout_at', null);

    if (error) {
      console.warn('[session] close échec :', error.message);
    }
  } catch (err) {
    console.warn('[session] erreur close :', err.message);
  }
}
