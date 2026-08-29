import { Router } from 'express';
import { serviceClient } from '../app.js';
import { auditLog, LEVELS } from '../utils/audit.js';
import { notify } from '../utils/notifications.js';
import { isSaasSuspended, invalidateSaasCache } from '../utils/saasStatus.js';
import { getSimulationStatus, advanceDay, resetSimulation } from '../utils/simulation.js';

const router = Router();

const OWNER_TYPES = ['proprietaire', 'agence', 'entreprise'];

// Helper: Supabase client avec service role
function sb() { return serviceClient(); }

// Helper: réponse d'erreur uniforme
function err(res, status, code, message, details) {
  const body = { success: false, code, message };
  if (details) body.errors = details;
  return res.status(status).json(body);
}

// ─── GESTION DES ADMINISTRATEURS ─────────────────────────────────

// GET /api/ultra-admin/admins — Liste tous les admins
router.get('/admins', async (req, res) => {
  try {
    const { data: profiles, error: pErr } = await sb()
      .from('profiles')
      .select('id, name, email, username, account_type, created_at')
      .in('account_type', ['admin', 'ultra_admin'])
      .order('created_at', { ascending: false });

    if (pErr) throw pErr;

    // Enrichir avec les données auth (ban status, derniere connexion)
    const { data: authUsers } = await sb().auth.admin.listUsers({ page: 1, perPage: 1000 });
    const authMap = new Map((authUsers?.users || []).map(u => [u.id, u]));

    const admins = (profiles || []).map(p => {
      const auth = authMap.get(p.id);
      const banned = auth?.banned_until && new Date(auth.banned_until) > new Date();
      return {
        id: p.id,
        name: p.name,
        email: p.email,
        username: p.username,
        account_type: p.account_type,
        statut: banned ? 'suspendu' : 'actif',
        created_at: p.created_at,
        last_login: auth?.last_sign_in_at || null,
      };
    });

    res.json({ success: true, data: admins });
  } catch (e) {
    console.warn('[ultra-admin] admins error:', e.message);
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la récupération des admins.');
  }
});

// POST /api/ultra-admin/admins — Créer un compte Admin
router.post('/admins', async (req, res) => {
  try {
    const { name, email, username, password } = req.body || {};

    if (!name?.trim()) return err(res, 400, 'VALIDATION', 'Le nom est requis.', { name: 'Nom requis.' });
    if (!email?.trim()) return err(res, 400, 'VALIDATION', "L'email est requis.", { email: 'Email requis.' });
    if (!username?.trim()) return err(res, 400, 'VALIDATION', 'Le username est requis.', { username: 'Username requis.' });

    // Vérifier l'unicité de l'email
    const { data: existing } = await sb()
      .from('profiles')
      .select('id')
      .eq('email', email.trim())
      .maybeSingle();
    if (existing) return err(res, 409, 'CONFLICT', 'Cet email est déjà utilisé.', { email: 'Email déjà utilisé.' });

    // Vérifier l'unicité du username
    if (username) {
      const { data: existingUsername } = await sb()
        .from('profiles')
        .select('id')
        .eq('username', username.trim())
        .maybeSingle();
      if (existingUsername) return err(res, 409, 'CONFLICT', 'Ce username est déjà pris.', { username: 'Username déjà pris.' });
    }

    // Créer le compte via Supabase Auth Admin
    const tempPw = password || generateTempPassword();
    const { data: authUser, error: createErr } = await sb().auth.admin.createUser({
      email: email.trim(),
      password: tempPw,
      email_confirm: true,
      user_metadata: {
        account_type: 'admin',
        name: name.trim(),
        username: username?.trim() || null,
      },
    });

    if (createErr) throw createErr;
    const userId = authUser.user.id;

    // Le trigger handle_new_user() crée le profil automatiquement.
    // On utilise upsert pour mettre à jour si le trigger a déjà créé une entrée.
    const { error: profileErr } = await sb().from('profiles').upsert({
      id: userId,
      account_type: 'admin',
      name: name.trim(),
      email: email.trim(),
      phone: '',
      role: 'admin',
      username: username?.trim() || null,
    }, { onConflict: 'id' });

    if (profileErr) throw profileErr;

    // Audit log
    await auditLog({
      userId: req.user.id,
      action: 'ultra.create_admin',
      target: userId,
      targetType: 'user',
      level: LEVELS.CRITICAL,
      meta: { name: name.trim(), email: email.trim(), username: username?.trim() },
      ip: req.ip,
    });

    res.status(201).json({
      success: true,
      message: 'Compte administrateur créé avec succès.',
      data: {
        id: userId,
        name: name.trim(),
        email: email.trim(),
        username: username?.trim() || null,
        temp_password: password ? undefined : tempPw,
      },
    });
  } catch (e) {
    console.warn('[ultra-admin] create admin error:', e.message);
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la création du compte admin.');
  }
});

// PATCH /api/ultra-admin/admins/:id — Suspendre ou réactiver un admin
router.patch('/admins/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body || {}; // 'suspend' | 'reactivate'

    if (!['suspend', 'reactivate'].includes(action)) {
      return err(res, 400, 'VALIDATION', 'Action invalide. Utilisez "suspend" ou "reactivate".');
    }

    // Vérifier que la cible est un admin
    const { data: target } = await sb()
      .from('profiles')
      .select('id, name, email, account_type')
      .eq('id', id)
      .maybeSingle();

    if (!target) return err(res, 404, 'NOT_FOUND', 'Compte introuvable.');
    if (!['admin', 'ultra_admin'].includes(target.account_type)) {
      return err(res, 400, 'VALIDATION', 'Ce compte n\'est pas un administrateur.');
    }

    // Empêcher l'auto-suspension
    if (id === req.user.id) {
      return err(res, 400, 'FORBIDDEN', 'Vous ne pouvez pas suspendre votre propre compte.');
    }

    // Interdire de suspendre un ultra_admin
    if (target.account_type === 'ultra_admin' && action === 'suspend') {
      return err(res, 403, 'FORBIDDEN', 'Impossible de suspendre un Super Admin.');
    }

    // Appliquer la suspension/réactivation via GoTrue
    const banUntil = action === 'suspend' ? '8760h' : 'none';
    const { error: banErr } = await sb().auth.admin.updateUserById(id, {
      banned_until: banUntil,
    });

    if (banErr) throw banErr;

    // Audit log
    await auditLog({
      userId: req.user.id,
      action: action === 'suspend' ? 'ultra.suspend_admin' : 'ultra.reactivate_admin',
      target: id,
      targetType: 'user',
      level: LEVELS.CRITICAL,
      meta: { name: target.name, email: target.email },
      ip: req.ip,
    });

    const statut = action === 'suspend' ? 'suspendu' : 'actif';
    res.json({ success: true, message: `Compte de ${target.name} ${statut}.`, statut });
  } catch (e) {
    console.warn('[ultra-admin] patch admin error:', e.message);
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la modification du compte.');
  }
});

// DELETE /api/ultra-admin/admins/:id — Retirer le rôle admin
router.delete('/admins/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (id === req.user.id) {
      return err(res, 400, 'FORBIDDEN', 'Vous ne pouvez pas retirer votre propre rôle.');
    }

    const { data: target } = await sb()
      .from('profiles')
      .select('id, name, email, account_type')
      .eq('id', id)
      .maybeSingle();

    if (!target) return err(res, 404, 'NOT_FOUND', 'Compte introuvable.');
    if (target.account_type === 'ultra_admin') {
      return err(res, 403, 'FORBIDDEN', 'Impossible de retirer le rôle d\'un Super Admin.');
    }
    if (target.account_type !== 'admin') {
      return err(res, 400, 'VALIDATION', 'Ce compte n\'est pas un administrateur.');
    }

    // Downgrader en propriétaire
    const { error } = await sb()
      .from('profiles')
      .update({ account_type: 'proprietaire', role: 'proprietaire' })
      .eq('id', id);

    if (error) throw error;

    await auditLog({
      userId: req.user.id,
      action: 'ultra.remove_admin_role',
      target: id,
      targetType: 'user',
      level: LEVELS.CRITICAL,
      meta: { name: target.name, email: target.email },
      ip: req.ip,
    });

    res.json({ success: true, message: `Le rôle admin a été retiré à ${target.name}.` });
  } catch (e) {
    console.warn('[ultra-admin] delete admin error:', e.message);
    err(res, 500, 'SERVER_ERROR', 'Erreur lors du retrait du rôle admin.');
  }
});

// ─── GESTION GLOBALE DES UTILISATEURS ─────────────────────────────

// GET /api/ultra-admin/users — Liste tous les utilisateurs
router.get('/users', async (req, res) => {
  try {
    const { search, type, status } = req.query;

    let query = sb()
      .from('profiles')
      .select('id, name, email, username, account_type, created_at');

    if (type && type !== 'all') {
      query = query.eq('account_type', type);
    }

    if (search?.trim()) {
      const s = search.trim();
      query = query.or(`name.ilike.%${s}%,email.ilike.%${s}%,username.ilike.%${s}%`);
    }

    const { data: profiles, error } = await query.order('created_at', { ascending: false }).limit(500);
    if (error) throw error;

    // Enrichir avec ban status
    const { data: authUsers } = await sb().auth.admin.listUsers({ page: 1, perPage: 1000 });
    const authMap = new Map((authUsers?.users || []).map(u => [u.id, u]));

    const users = (profiles || []).map(p => {
      const auth = authMap.get(p.id);
      const banned = auth?.banned_until && new Date(auth.banned_until) > new Date();
      let statut = 'actif';
      if (banned) statut = 'suspendu';
      if (!auth) statut = 'supprimé';

      if (status && status !== 'all' && statut !== status) return null;
      return { ...p, statut };
    }).filter(Boolean);

    res.json({ success: true, data: users });
  } catch (e) {
    console.warn('[ultra-admin] users error:', e.message);
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la récupération des utilisateurs.');
  }
});

// PATCH /api/ultra-admin/users/:id — Suspendre/réactiver un propriétaire
router.patch('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body || {};

    if (!['suspend', 'reactivate'].includes(action)) {
      return err(res, 400, 'VALIDATION', 'Action invalide.');
    }

    const { data: target } = await sb()
      .from('profiles')
      .select('id, name, email, account_type')
      .eq('id', id)
      .maybeSingle();

    if (!target) return err(res, 404, 'NOT_FOUND', 'Compte introuvable.');
    if (!OWNER_TYPES.includes(target.account_type)) {
      return err(res, 400, 'VALIDATION', 'Seuls les propriétaires peuvent être suspendus/réactivés.');
    }

    const banUntil = action === 'suspend' ? '8760h' : 'none';
    const { error: banErr } = await sb().auth.admin.updateUserById(id, { banned_until: banUntil });
    if (banErr) throw banErr;

    await auditLog({
      userId: req.user.id,
      action: action === 'suspend' ? 'ultra.suspend_owner' : 'ultra.reactivate_owner',
      target: id,
      targetType: 'user',
      level: LEVELS.CRITICAL,
      meta: { name: target.name, email: target.email },
      ip: req.ip,
    });

    const statut = action === 'suspend' ? 'suspendu' : 'actif';
    res.json({ success: true, message: `Compte de ${target.name} ${statut}.`, statut });
  } catch (e) {
    console.warn('[ultra-admin] patch user error:', e.message);
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la modification du compte.');
  }
});

// ─── GESTION DU SaaS ─────────────────────────────────────────────

// GET /api/ultra-admin/saas/status — Statut du SaaS
router.get('/saas/status', async (req, res) => {
  const suspended = await isSaasSuspended();
  res.json({ success: true, suspended });
});

// POST /api/ultra-admin/saas/suspend — Suspendre le SaaS
router.post('/saas/suspend', async (req, res) => {
  try {
    const { error } = await sb().from('system_config').upsert(
      { key: 'saas_suspended', value: 'true', updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    if (error) throw error;
    invalidateSaasCache();

    await auditLog({
      userId: req.user.id,
      action: 'ultra.suspend_saas',
      level: LEVELS.CRITICAL,
      ip: req.ip,
    });

    res.json({ success: true, message: 'Le SaaS a été suspendu.' });
  } catch (e) {
    console.warn('[ultra-admin] suspend saas error:', e.message);
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la suspension du SaaS.');
  }
});

// POST /api/ultra-admin/saas/reactivate — Réactiver le SaaS
router.post('/saas/reactivate', async (req, res) => {
  try {
    const { error } = await sb().from('system_config').upsert(
      { key: 'saas_suspended', value: 'false', updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    if (error) throw error;
    invalidateSaasCache();

    await auditLog({
      userId: req.user.id,
      action: 'ultra.reactivate_saas',
      level: LEVELS.CRITICAL,
      ip: req.ip,
    });

    res.json({ success: true, message: 'Le SaaS a été réactivé.' });
  } catch (e) {
    console.warn('[ultra-admin] reactivate saas error:', e.message);
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la réactivation du SaaS.');
  }
});

// ─── ANNONCES ─────────────────────────────────────────────────────

// GET /api/ultra-admin/announcements
router.get('/announcements', async (req, res) => {
  try {
    const { data, error } = await sb()
      .from('announcements')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la récupération des annonces.');
  }
});

// POST /api/ultra-admin/announcements
router.post('/announcements', async (req, res) => {
  try {
    const { title, content, audience, status } = req.body || {};
    if (!title?.trim()) return err(res, 400, 'VALIDATION', 'Le titre est requis.');
    if (!content?.trim()) return err(res, 400, 'VALIDATION', 'Le contenu est requis.');

    const announcement = {
      title: title.trim(),
      content: content.trim(),
      audience: audience || 'all',
      status: status || 'draft',
      published_at: status === 'published' ? new Date().toISOString() : null,
      created_by: req.user.id,
    };

    const { data, error } = await sb().from('announcements').insert(announcement).select().single();
    if (error) throw error;

    await auditLog({
      userId: req.user.id,
      action: 'ultra.create_announcement',
      target: String(data.id),
      targetType: 'announcement',
      level: LEVELS.INFO,
      meta: { title: title.trim(), audience: audience || 'all' },
      ip: req.ip,
    });

    res.status(201).json({ success: true, message: 'Annonce créée.', data });
  } catch (e) {
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la création de l\'annonce.');
  }
});

// PATCH /api/ultra-admin/announcements/:id
router.patch('/announcements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, audience, status } = req.body || {};

    const updates = {};
    if (title !== undefined) updates.title = title.trim();
    if (content !== undefined) updates.content = content.trim();
    if (audience !== undefined) updates.audience = audience;
    if (status !== undefined) {
      updates.status = status;
      if (status === 'published') updates.published_at = new Date().toISOString();
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await sb().from('announcements').update(updates).eq('id', id).select().single();
    if (error) throw error;

    await auditLog({
      userId: req.user.id,
      action: 'ultra.update_announcement',
      target: String(id),
      targetType: 'announcement',
      level: LEVELS.INFO,
      ip: req.ip,
    });

    res.json({ success: true, message: 'Annonce mise à jour.', data });
  } catch (e) {
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la mise à jour.');
  }
});

// DELETE /api/ultra-admin/announcements/:id
router.delete('/announcements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await sb().from('announcements').delete().eq('id', id);
    if (error) throw error;

    await auditLog({
      userId: req.user.id,
      action: 'ultra.delete_announcement',
      target: String(id),
      targetType: 'announcement',
      level: LEVELS.WARN,
      ip: req.ip,
    });

    res.json({ success: true, message: 'Annonce supprimée.' });
  } catch (e) {
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la suppression.');
  }
});

// ─── ÉVÉNEMENTS ───────────────────────────────────────────────────

// GET /api/ultra-admin/events
router.get('/events', async (req, res) => {
  try {
    const { data, error } = await sb()
      .from('platform_events')
      .select('*')
      .order('event_date', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la récupération des événements.');
  }
});

// POST /api/ultra-admin/events
router.post('/events', async (req, res) => {
  try {
    const { title, description, event_date, audience, status } = req.body || {};
    if (!title?.trim()) return err(res, 400, 'VALIDATION', 'Le titre est requis.');
    if (!event_date) return err(res, 400, 'VALIDATION', 'La date est requise.');

    const event = {
      title: title.trim(),
      description: description?.trim() || null,
      event_date: new Date(event_date).toISOString(),
      audience: audience || 'all',
      status: status || 'draft',
      created_by: req.user.id,
    };

    const { data, error } = await sb().from('platform_events').insert(event).select().single();
    if (error) throw error;

    await auditLog({
      userId: req.user.id,
      action: 'ultra.create_event',
      target: String(data.id),
      targetType: 'event',
      level: LEVELS.INFO,
      meta: { title: title.trim() },
      ip: req.ip,
    });

    res.status(201).json({ success: true, message: 'Événement créé.', data });
  } catch (e) {
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la création de l\'événement.');
  }
});

// PATCH /api/ultra-admin/events/:id
router.patch('/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, event_date, audience, status } = req.body || {};

    const updates = {};
    if (title !== undefined) updates.title = title.trim();
    if (description !== undefined) updates.description = description?.trim() || null;
    if (event_date !== undefined) updates.event_date = new Date(event_date).toISOString();
    if (audience !== undefined) updates.audience = audience;
    if (status !== undefined) updates.status = status;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await sb().from('platform_events').update(updates).eq('id', id).select().single();
    if (error) throw error;

    await auditLog({
      userId: req.user.id,
      action: 'ultra.update_event',
      target: String(id),
      targetType: 'event',
      level: LEVELS.INFO,
      ip: req.ip,
    });

    res.json({ success: true, message: 'Événement mis à jour.', data });
  } catch (e) {
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la mise à jour.');
  }
});

// DELETE /api/ultra-admin/events/:id
router.delete('/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await sb().from('platform_events').delete().eq('id', id);
    if (error) throw error;

    await auditLog({
      userId: req.user.id,
      action: 'ultra.delete_event',
      target: String(id),
      targetType: 'event',
      level: LEVELS.WARN,
      ip: req.ip,
    });

    res.json({ success: true, message: 'Événement supprimé.' });
  } catch (e) {
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la suppression.');
  }
});

// ─── MISE EN AVANT ────────────────────────────────────────────────

// GET /api/ultra-admin/featured
router.get('/featured', async (req, res) => {
  try {
    const { data, error } = await sb()
      .from('featured_items')
      .select('*')
      .order('priority', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la récupération des mises en avant.');
  }
});

// POST /api/ultra-admin/featured
router.post('/featured', async (req, res) => {
  try {
    const { target_type, target_id, badge, priority, featured_until } = req.body || {};
    if (!target_type || !target_id) return err(res, 400, 'VALIDATION', 'target_type et target_id sont requis.');

    const item = {
      target_type,
      target_id: String(target_id),
      badge: badge?.trim() || null,
      priority: priority || 0,
      featured_until: featured_until ? new Date(featured_until).toISOString() : null,
      created_by: req.user.id,
    };

    const { data, error } = await sb().from('featured_items').insert(item).select().single();
    if (error) throw error;

    await auditLog({
      userId: req.user.id,
      action: 'ultra.create_featured',
      target: String(data.id),
      targetType: 'featured',
      level: LEVELS.INFO,
      meta: { target_type, target_id, badge },
      ip: req.ip,
    });

    res.status(201).json({ success: true, message: 'Élément mis en avant.', data });
  } catch (e) {
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la création.');
  }
});

// DELETE /api/ultra-admin/featured/:id
router.delete('/featured/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await sb().from('featured_items').delete().eq('id', id);
    if (error) throw error;

    await auditLog({
      userId: req.user.id,
      action: 'ultra.delete_featured',
      target: String(id),
      targetType: 'featured',
      level: LEVELS.WARN,
      ip: req.ip,
    });

    res.json({ success: true, message: 'Mise en avant supprimée.' });
  } catch (e) {
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la suppression.');
  }
});

// ─── JOURNAL D'AUDIT ──────────────────────────────────────────────

// GET /api/ultra-admin/audit — Lecture des logs d'audit
router.get('/audit', async (req, res) => {
  try {
    const { level, action, limit: limitStr } = req.query;
    const limit = Math.min(parseInt(limitStr) || 100, 500);

    let query = sb()
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (level && level !== 'all') query = query.eq('level', level);
    if (action?.trim()) query = query.ilike('action', `%${action.trim()}%`);

    const { data, error } = await query;
    if (error) throw error;

    // Enrichir avec les noms des utilisateurs
    const userIds = [...new Set((data || []).map(l => l.user_id).filter(Boolean))];
    let userMap = {};
    if (userIds.length) {
      const { data: profiles } = await sb()
        .from('profiles')
        .select('id, name')
        .in('id', userIds);
      userMap = Object.fromEntries((profiles || []).map(p => [p.id, p.name]));
    }

    const logs = (data || []).map(l => ({
      ...l,
      user_name: userMap[l.user_id] || 'Système',
    }));

    res.json({ success: true, data: logs });
  } catch (e) {
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la récupération des logs.');
  }
});

// ─── STATISTIQUES GLOBALES ────────────────────────────────────────

// GET /api/ultra-admin/stats — Stats globales pour le dashboard ultra
router.get('/stats', async (req, res) => {
  try {
    const counts = {};

    // Compter les profils par type
    for (const type of ['proprietaire', 'agence', 'entreprise', 'locataire', 'employe', 'admin', 'ultra_admin']) {
      const { count } = await sb()
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('account_type', type);
      counts[type] = count || 0;
    }

    // Total biens, logements, paiements
    for (const table of ['biens', 'logements', 'paiements', 'incidents', 'subscriptions']) {
      const { count } = await sb().from(table).select('*', { count: 'exact', head: true });
      counts[table] = count || 0;
    }

    // Logs audit critiques (7 derniers jours)
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const { count: criticalCount } = await sb()
      .from('audit_logs')
      .select('*', { count: 'exact', head: true })
      .eq('level', 'critical')
      .gte('created_at', weekAgo);
    counts.criticalAuditWeek = criticalCount || 0;

    // SaaS status
    const saasSuspended = await isSaasSuspended();

    res.json({ success: true, stats: { ...counts, saasSuspended } });
  } catch (e) {
    console.warn('[ultra-admin] stats error:', e.message);
    err(res, 500, 'SERVER_ERROR', 'Erreur lors des statistiques.');
  }
});

// ─── SIMULATION TEMPORELLE ──────────────────────────────────────────

// GET /api/ultra-admin/simulation — État actuel de la simulation
router.get('/simulation', async (req, res) => {
  try {
    const status = await getSimulationStatus();
    res.json({ success: true, data: status });
  } catch (e) {
    console.warn('[ultra-admin] simulation status error:', e.message);
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la lecture de la simulation.');
  }
});

// POST /api/ultra-admin/simulation/advance-day — Avancer d'1 jour
router.post('/simulation/advance-day', async (req, res) => {
  try {
    const result = await advanceDay();
    if (!result.success) return err(res, 500, 'SERVER_ERROR', result.error);

    await auditLog({
      userId: req.user.id,
      action: 'ultra.advance_day',
      level: LEVELS.WARN,
      meta: { offset: result.offset, simulatedDate: result.simulatedDate },
      ip: req.ip,
    });

    res.json(result);
  } catch (e) {
    console.warn('[ultra-admin] advance day error:', e.message);
    err(res, 500, 'SERVER_ERROR', "Erreur lors de l'avancement du jour.");
  }
});

// POST /api/ultra-admin/simulation/reset — Réinitialiser la simulation
router.post('/simulation/reset', async (req, res) => {
  try {
    const result = await resetSimulation();
    if (!result.success) return err(res, 500, 'SERVER_ERROR', result.error);

    await auditLog({
      userId: req.user.id,
      action: 'ultra.reset_simulation',
      level: LEVELS.WARN,
      meta: { message: 'Simulation réinitialisée' },
      ip: req.ip,
    });

    res.json(result);
  } catch (e) {
    console.warn('[ultra-admin] reset simulation error:', e.message);
    err(res, 500, 'SERVER_ERROR', 'Erreur lors de la réinitialisation.');
  }
});

// ─── UTILITAIRES ──────────────────────────────────────────────────

function generateTempPassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
  let pw = 'Mim@';
  for (let i = 0; i < 10; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
  pw += '!';
  return pw;
}

export default router;
