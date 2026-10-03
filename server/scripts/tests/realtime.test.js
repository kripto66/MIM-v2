import { createClient } from '@supabase/supabase-js';
import { api } from './lib.js';

export async function runRealtime(r, ctx) {
  const S = 'realtime';

  await r.section('endpoint /api/realtime/session', async () => {
    const unauth = await api('/realtime/session', { raw: true });
    if (unauth.status === 401) r.pass(S, 'session sans cookie → 401');
    else r.fail(S, 'session sans cookie → 401', `HTTP ${unauth.status}`);

    const o1 = ctx.seed.owners[0];
    const res = await api('/realtime/session', { jar: o1.jar });
    const body = res.data || {};
    if (res.status === 200 && body.success === true && body.token && body.userId === o1.id && body.url && body.anonKey) {
      r.pass(S, 'session authentifiée → token + url + anonKey');
    } else {
      r.fail(S, 'session authentifiée → token + url + anonKey', JSON.stringify(res).slice(0, 120));
    }
  });

  await r.section('postgres_changes : notification reçue par le bon compte uniquement', async () => {
    const o1 = ctx.seed.owners[0];
    const o2 = ctx.seed.owners[1];

    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: sess, error } = await anon.auth.signInWithPassword({ email: o1.email, password: 'Test1234!' });
    if (error || !sess?.session) {
      r.blocked(S, 'login supabase direct o1', error?.message);
      return;
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    sb.realtime.setAuth(sess.session.access_token);

    const got = [];
    const ch = sb.channel('rt-test');
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, (p) => got.push(p));
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('subscribe timeout')), 8000);
      ch.subscribe((s) => { if (s === 'SUBSCRIBED') { clearTimeout(to); resolve(); } });
    }).catch((err) => r.blocked(S, 'subscribe channel', err.message));

    try {
      await ctx.service.from('notifications').insert({ user_id: o1.id, type: 'test_rt', message: 'rt-e2e-o1', lu: false });
      await ctx.service.from('notifications').insert({ user_id: o2.id, type: 'test_rt', message: 'rt-e2e-o2', lu: false });
    } catch (err) {
      r.blocked(S, 'insert notifications de test', err.message);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 4000));

    const mine = got.filter((p) => p.new && p.new.user_id === o1.id);
    const others = got.filter((p) => p.new && p.new.user_id === o2.id);

    if (mine.length >= 1) r.pass(S, 'o1 reçoit sa notification en temps réel');
    else r.fail(S, 'o1 reçoit sa notification en temps réel', `${mine.length} événement(s)`);

    if (others.length === 0) r.pass(S, 'o1 ne reçoit JAMAIS les événements de o2 (RLS)');
    else r.fail(S, 'o1 ne reçoit JAMAIS les événements de o2 (RLS)', `${others.length} fuite(s)`);

    try {
      await sb.removeChannel(ch);
      sb.realtime.disconnect();
    } catch {
      /* nettoyage best-effort */
    }
  });
}
