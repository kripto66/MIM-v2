// ============================================================
// MIM - Seeder de test : 10 propriétaires x 10 locataires
// ============================================================

import { api, newJar } from './lib.js';

export const OWNER_COUNT = 10;
export const TENANTS_PER_OWNER = 10;
export const OWNER_PASSWORD = 'Test1234!';

const ownerEmail = (i) => `owner${i}@mimtest.com`;
const tenantUsername = (i, j) => `own${i}loc${j}`;

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Supprime toutes les données des comptes de test (owners + locataires),
// y compris les résidus d'anciennes campagnes (final/owner.test/dev).
// Les FK user_id -> auth.users étant ON DELETE CASCADE, supprimer les
// utilisateurs efface aussi profils, biens, logements, locataires, etc.
const WIPE_EMAIL_PATTERNS = ['owner%@mimtest.com', '%@mim.local', 'owner.test%@example.com', 'final%@example.com', 'owner.%@mim.com'];
const WIPE_USERNAME_PATTERNS = ['own%loc%'];
const CHILD_TABLES = ['biens', 'logements', 'locataires', 'paiements', 'incidents', 'prestataires', 'interventions', 'notifications', 'sessions'];

// Comptes « production » jamais supprimés par le wipe (admin + comptes réels).
const PROTECTED_EMAILS = new Set(['admin@mim.local']);

export async function wipeTestData(service) {
  const ids = [];

  for (const pat of WIPE_EMAIL_PATTERNS) {
    const { data } = await service.from('profiles').select('id, email').ilike('email', pat);
    if (data) ids.push(...data.filter((p) => !PROTECTED_EMAILS.has(p.email)).map((p) => p.id));
  }
  for (const pat of WIPE_USERNAME_PATTERNS) {
    const { data } = await service.from('profiles').select('id').ilike('username', pat);
    if (data) ids.push(...data.map((p) => p.id));
  }

  const allIds = [...new Set(ids)];

  // Purge des orphelins (user_id NULL) laissés par d'anciennes suppressions.
  for (const t of CHILD_TABLES) {
    try {
      await service.from(t).delete().is('user_id', null);
    } catch {
      /* table sans colonne user_id */
    }
  }

  // Suppression explicite des lignes enfants (les FK peuvent être en SET NULL).
  if (allIds.length) {
    for (const t of CHILD_TABLES) {
      try {
        await service.from(t).delete().in('user_id', allIds);
      } catch {
        /* ignore */
      }
    }
  }

  for (const id of allIds) {
    await service.auth.admin.deleteUser(id).catch(() => {});
  }
  return allIds.length;
}

export async function seed(service) {
  const month = currentMonth();
  const prev = prevMonth(month);
  const state = {
    month,
    prev,
    owners: [],
    tenantCount: 0,
    totalBiens: 0,
    totalLogements: 0,
    totalPaiements: 0,
  };

  for (let i = 1; i <= OWNER_COUNT; i++) {
    const email = ownerEmail(i);
    const jar = newJar();

    const reg = await api('/auth/register', {
      method: 'POST',
      jar,
      body: {
        account_type: 'proprietaire',
        name: `Propriétaire ${i}`,
        email,
        phone: `+22177${String(i).padStart(6, '0')}`,
        password: OWNER_PASSWORD,
        password_confirm: OWNER_PASSWORD,
      },
    });

    if (reg.status !== 201 || !reg.data?.success) {
      throw new Error(`[seed] échec register owner${i} : ${reg.status} ${JSON.stringify(reg.data).slice(0, 200)}`);
    }

    const me = await api('/auth/me', { jar });
    if (me.status !== 200 || !me.data?.user?.id) {
      throw new Error(`[seed] échec /auth/me owner${i} : ${JSON.stringify(me.data).slice(0, 200)}`);
    }

    const owner = {
      i,
      id: me.data.user.id,
      email,
      password: OWNER_PASSWORD,
      jar,
      bienId: null,
      logements: [],
      locataires: [],
      incidentId: null,
      prestataireId: null,
    };

    // --- Bien ---
    const bien = await api('/biens', {
      method: 'POST',
      jar,
      body: { nom: `Bien OWNER${i}`, type: 'immeuble', adresse: `Adresse ${i}`, ville: 'Dakar', pays: 'Sénégal' },
    });
    if (bien.status !== 201) throw new Error(`[seed] bien owner${i} : ${bien.status} ${JSON.stringify(bien.data).slice(0, 200)}`);
    owner.bienId = bien.data.data.id;
    state.totalBiens++;

    // --- 10 logements ---
    for (let j = 1; j <= TENANTS_PER_OWNER; j++) {
      const type = j % 2 === 0 ? 'appartement' : 'chambre';
      const log = await api('/logements', {
        method: 'POST',
        jar,
        body: {
          bien_id: owner.bienId,
          nom: `Log OWNER${i}-${j}`,
          type,
          nombre_chambres: type === 'appartement' ? 2 : null,
          adresse: `Adresse ${i}-${j}`,
          loyer_mensuel: 100000 + i * 10000 + j * 5000,
          statut: 'libre',
        },
      });
      if (log.status !== 201) throw new Error(`[seed] logement o${i}-${j} : ${log.status} ${JSON.stringify(log.data).slice(0, 200)}`);
      owner.logements.push(log.data.data);
      state.totalLogements++;
    }

    // --- 10 locataires (avec compte) ---
    for (let j = 1; j <= TENANTS_PER_OWNER; j++) {
      const logementId = owner.logements[j - 1].id;
      const loc = await api('/locataires', {
        method: 'POST',
        jar,
        body: {
          logement_id: logementId,
          nom: `Locataire OWNER${i}-${j}`,
          username: tenantUsername(i, j),
          password: OWNER_PASSWORD,
          phone: `+22170${String(i).padStart(2, '0')}${String(j).padStart(4, '0')}`,
          date_entree: '2026-01-01',
          jour_echeance: (j % 28) + 1,
          statut: 'actif',
        },
      });
      if (loc.status !== 201) throw new Error(`[seed] locataire o${i}-${j} : ${loc.status} ${JSON.stringify(loc.data).slice(0, 200)}`);
      owner.locataires.push(loc.data.data);
      state.tenantCount++;
    }

    // --- Paiements (mois courant + mois précédent pour certains) ---
    for (let j = 1; j <= TENANTS_PER_OWNER; j++) {
      const locId = owner.locataires[j - 1].id;
      const logId = owner.logements[j - 1].id;
      const loyer = owner.logements[j - 1].loyer_mensuel;

      const paye = j % 2 === 0;
      const p = await api('/paiements', {
        method: 'POST',
        jar,
        body: {
          locataire_id: locId,
          logement_id: logId,
          montant: loyer,
          mois: month,
          statut: paye ? 'paye' : 'attente',
          ...(paye ? { date_paiement: '2026-08-02' } : {}),
        },
      });
      if (p.status !== 201) throw new Error(`[seed] paiement o${i}-${j} : ${p.status} ${JSON.stringify(p.data).slice(0, 200)}`);
      state.totalPaiements++;

      if (j === 1) {
        const pr = await api('/paiements', {
          method: 'POST',
          jar,
          body: {
            locataire_id: locId,
            logement_id: logId,
            montant: loyer,
            mois: prev,
            statut: 'retard',
          },
        });
        if (pr.status !== 201) throw new Error(`[seed] paiement retard o${i}-1 : ${pr.status} ${JSON.stringify(pr.data).slice(0, 200)}`);
        state.totalPaiements++;
      }
    }

    // --- Incidents ---
    const inc1 = await api('/incidents', {
      method: 'POST',
      jar,
      body: { logement_id: owner.logements[0].id, titre: `Fuite OWNER${i}`, description: 'Fuite d\'eau à signaler', statut: 'nouveau' },
    });
    if (inc1.status !== 201) throw new Error(`[seed] incident o${i} : ${inc1.status} ${JSON.stringify(inc1.data).slice(0, 200)}`);
    owner.incidentId = inc1.data.data.id;
    const incResolu = await api('/incidents', {
      method: 'POST',
      jar,
      body: { logement_id: owner.logements[1].id, titre: `Résolu OWNER${i}`, statut: 'resolu' },
    });
    if (incResolu.status !== 201) throw new Error(`[seed] incident résolu o${i} : ${incResolu.status} ${JSON.stringify(incResolu.data).slice(0, 200)}`);

    // --- Prestataires ---
    const prest1 = await api('/prestataires', {
      method: 'POST',
      jar,
      body: { nom: `Plombier OWNER${i}`, specialite: 'Plomberie', phone: '+221770000001' },
    });
    if (prest1.status !== 201) throw new Error(`[seed] prestataire o${i} : ${prest1.status} ${JSON.stringify(prest1.data).slice(0, 200)}`);
    owner.prestataireId = prest1.data.data.id;

    // --- Intervention ---
    const inter = await api('/interventions', {
      method: 'POST',
      jar,
      body: {
        incident_id: inc1.data.data.id,
        prestataire_id: prest1.data.data.id,
        logement_id: owner.logements[0].id,
        titre: `Réparation OWNER${i}`,
        statut: 'planifie',
      },
    });
    if (inter.status !== 201) throw new Error(`[seed] intervention o${i} : ${inter.status} ${JSON.stringify(inter.data).slice(0, 200)}`);

    state.owners.push(owner);
  }

  // Vérification des compteurs côté DB.
  const counts = await verifyCounts(service);
  Object.assign(state, counts);

  return state;
}

export async function verifyCounts(service) {
  const count = async (table) => {
    const { data } = await service.from(table).select('id');
    return data?.length || 0;
  };
  const { data: profiles } = await service
    .from('profiles')
    .select('id')
    .ilike('email', 'owner%@mimtest.com');
  return {
    countBiens: await count('biens'),
    countLogements: await count('logements'),
    countLocataires: await count('locataires'),
    countPaiements: await count('paiements'),
    countOwnerProfiles: profiles?.length || 0,
  };
}
