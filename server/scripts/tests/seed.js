// ============================================================
// MIM - Seeder de test : 10 propriétaires x 10 locataires
// ============================================================

import { api, assertSeedAllowed, assertTestDatabaseAllowed, newJar } from './lib.js';

export const TEST_MARKER = 'is_test';
export const OWNER_COUNT = 10;
export const TENANTS_PER_OWNER = 10;
export const OWNER_PASSWORD = 'Test1234!';

const ownerEmail = (i) => `mim-e2e-${TEST_MARKER}-owner${i}@mimtest.com`;
const tenantUsername = (i, j) => `mim_is_test_own${i}loc${j}`;
const tenantEmail = (i, j) => `${TEST_MARKER}.own${i}loc${j}@mimtest.com`;
const seedLabel = (value) => `${TEST_MARKER} ${value}`;

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const CHILD_TABLES = [
  'notifications',
  'sessions',
  'account_recovery_emails',
  'paiements_employes',
  'moyens_paiement',
  'tasks',
  'employes_biens',
  'interventions',
  'incidents',
  'prestataires',
  'paiements',
  'locataires',
  'logements',
  'biens',
  'abonnement_paiements',
  'subscriptions',
  'versements',
  'employes',
];

async function markedRows(service, table, select, fields) {
  const rows = [];
  for (const field of fields) {
    const { data, error } = await service
      .from(table)
      .select(select)
      .ilike(field, `%${TEST_MARKER}%`);
    if (error) throw new Error(`${table}.${field} : ${error.message}`);
    rows.push(...(data || []));
  }
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

export async function wipeTestData(service) {
  assertTestDatabaseAllowed();
  assertSeedAllowed();

  const profiles = await markedRows(service, 'profiles', 'id, account_type, email, name', ['email', 'name']);
  const { data: fixedProfiles = [], error: fixedProfilesError } = await service
    .from('profiles')
    .select('id, account_type, email, name')
    .like('username', 'salaire.%');
  if (fixedProfilesError) throw new Error(`profiles.salaire: ${fixedProfilesError.message}`);
  const { data: fixedSimplifProfiles = [], error: fixedSimplifProfilesError } = await service
    .from('profiles')
    .select('id, account_type, email, name')
    .like('username', 'simplif.%');
  if (fixedSimplifProfilesError) throw new Error(`profiles.simplif: ${fixedSimplifProfilesError.message}`);
  profiles.push(...fixedProfiles, ...fixedSimplifProfiles);
  const tenants = await markedRows(service, 'locataires', 'id, user_id, account_uid, email, nom, username', ['email', 'nom', 'username']);
  const { data: fixedTenantAccounts = [], error: fixedTenantAccountsError } = await service
    .from('locataires')
    .select('id, user_id, account_uid, email, nom, username')
    .like('username', 'simplif.%');
  if (fixedTenantAccountsError) throw new Error(`locataires.simplif: ${fixedTenantAccountsError.message}`);
  tenants.push(...fixedTenantAccounts);
  const employees = await markedRows(service, 'employes', 'id, user_id, account_uid, email, nom, username', ['email', 'nom', 'username']);
  const { data: fixedEmployees = [], error: fixedEmployeesError } = await service
    .from('employes')
    .select('id, user_id, account_uid, email, nom, username')
    .like('username', 'salaire.%');
  if (fixedEmployeesError) throw new Error(`employes.salaire: ${fixedEmployeesError.message}`);
  employees.push(...fixedEmployees);
  const { data: fixedEmployeeAccounts = [], error: fixedEmployeeAccountsError } = await service
    .from('employes')
    .select('id, user_id, account_uid, email, nom, username')
    .like('username', 'simplif.%');
  if (fixedEmployeeAccountsError) throw new Error(`employes.simplif: ${fixedEmployeeAccountsError.message}`);
  employees.push(...fixedEmployeeAccounts);
  const ownerIds = new Set(
    profiles
      .filter((profile) => ['proprietaire', 'agence', 'entreprise'].includes(profile.account_type))
      .map((profile) => profile.id)
  );
  const accountIds = new Set([
    ...tenants.map((tenant) => tenant.account_uid).filter(Boolean),
    ...employees.map((employee) => employee.account_uid).filter(Boolean),
  ]);

  for (const tenant of tenants) {
    if (tenant.user_id) ownerIds.add(tenant.user_id);
  }
  for (const employee of employees) {
    if (employee.user_id) ownerIds.add(employee.user_id);
  }

  const authIds = new Set([
    ...profiles.map((profile) => profile.id),
    ...accountIds,
  ]);

  if (ownerIds.size) {
    const ids = [...ownerIds];
    for (const table of CHILD_TABLES) {
      const { error } = await service.from(table).delete().in('user_id', ids);
      if (error) throw new Error(`${table}: ${error.message}`);
    }
  }

  if (accountIds.size) {
    const ids = [...accountIds];
    const { error: paymentMethodError } = await service.from('moyens_paiement_employes').delete().in('employe_uid', ids);
    if (paymentMethodError) throw new Error(`moyens_paiement_employes: ${paymentMethodError.message}`);
    // Les tables filles d'un compte locataire/employé sont supprimées
    // avec le même soin que celles d'un propriétaire : subscriptions a
    // un FK ON DELETE RESTRICT vers auth.users, un compte de test qui
    // garderait une souscription bloquerait donc deleteUser().
    for (const table of CHILD_TABLES) {
      const { error } = await service.from(table).delete().in('user_id', ids);
      if (error) throw new Error(`${table}: ${error.message}`);
    }
    const { error: tenantError } = await service.from('locataires').delete().in('account_uid', ids);
    if (tenantError) throw new Error(`locataires: ${tenantError.message}`);
  }

  for (const id of authIds) {
    const { error } = await service.auth.admin.deleteUser(id);
    if (error && !/not found|does not exist|user not found/i.test(error.message)) {
      throw new Error(`auth.users ${id}: ${error.message}`);
    }
  }
  return authIds.size;
}

export async function seed(service) {
  assertTestDatabaseAllowed();
  assertSeedAllowed();
  const month = currentMonth();
  const prev = prevMonth(month);
  const state = {
    marker: TEST_MARKER,
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

    const { data: created, error: createError } = await service.auth.admin.createUser({
      email,
      password: OWNER_PASSWORD,
      email_confirm: true,
      user_metadata: { name: seedLabel(`Propriétaire ${i}`), phone: `+22177${String(i).padStart(6, '0')}` },
      app_metadata: { mim_account_type: 'proprietaire' },
    });
    if (createError || !created?.user?.id) {
      throw new Error(`[seed] création owner${i} : ${createError?.message || 'utilisateur absent'}`);
    }

    const login = await api('/auth/login', {
      method: 'POST',
      jar,
      body: { email, password: OWNER_PASSWORD },
    });
    if (login.status !== 200 || !login.data?.success) {
      throw new Error(`[seed] login owner${i} : ${login.status} ${JSON.stringify(login.data).slice(0, 200)}`);
    }

    const owner = {
      i,
      id: created.user.id,
      email,
      password: OWNER_PASSWORD,
      jar,
      bienId: null,
      logements: [],
      locataires: [],
      incidentId: null,
      prestataireId: null,
      isTest: true,
    };

    // --- Bien ---
    const bien = await api('/biens', {
      method: 'POST',
      jar,
      body: { nom: seedLabel(`Bien OWNER${i}`), type: 'immeuble', adresse: seedLabel(`Adresse ${i}`), ville: 'Dakar', pays: 'Sénégal' },
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
          nom: seedLabel(`Log OWNER${i}-${j}`),
          type,
          nombre_chambres: type === 'appartement' ? 2 : null,
          adresse: seedLabel(`Adresse ${i}-${j}`),
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
          nom: seedLabel(`Locataire OWNER${i}-${j}`),
          username: tenantUsername(i, j),
          email: tenantEmail(i, j),
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
      body: { logement_id: owner.logements[0].id, titre: seedLabel(`Fuite OWNER${i}`), description: seedLabel('Fuite d\'eau à signaler'), statut: 'nouveau' },
    });
    if (inc1.status !== 201) throw new Error(`[seed] incident o${i} : ${inc1.status} ${JSON.stringify(inc1.data).slice(0, 200)}`);
    owner.incidentId = inc1.data.data.id;
    const incResolu = await api('/incidents', {
      method: 'POST',
      jar,
      body: { logement_id: owner.logements[1].id, titre: seedLabel(`Résolu OWNER${i}`), statut: 'resolu' },
    });
    if (incResolu.status !== 201) throw new Error(`[seed] incident résolu o${i} : ${incResolu.status} ${JSON.stringify(incResolu.data).slice(0, 200)}`);

    // --- Prestataires ---
    const prest1 = await api('/prestataires', {
      method: 'POST',
      jar,
      body: { nom: seedLabel(`Plombier OWNER${i}`), specialite: 'Plomberie', phone: '+221770000001' },
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
        titre: seedLabel(`Réparation OWNER${i}`),
        statut: 'planifie',
      },
    });
    if (inter.status !== 201) throw new Error(`[seed] intervention o${i} : ${inter.status} ${JSON.stringify(inter.data).slice(0, 200)}`);

    state.owners.push(owner);
  }

  // Vérification des compteurs côté DB.
  const counts = await verifyCounts(service, state.owners.map((owner) => owner.id));
  Object.assign(state, counts);

  return state;
}

export async function verifyCounts(service, ownerIds = []) {
  const ids = [...new Set(ownerIds.filter(Boolean))];
  const count = async (table) => {
    if (!ids.length) return 0;
    const { data, error } = await service.from(table).select('id').in('user_id', ids);
    if (error) throw new Error(`${table} : ${error.message}`);
    return data?.length || 0;
  };
  const { data: profiles, error: profilesError } = ids.length
    ? await service.from('profiles').select('id').in('id', ids).ilike('email', `%${TEST_MARKER}%`)
    : { data: [], error: null };
  if (profilesError) throw new Error(`profiles : ${profilesError.message}`);
  return {
    countBiens: await count('biens'),
    countLogements: await count('logements'),
    countLocataires: await count('locataires'),
    countPaiements: await count('paiements'),
    countOwnerProfiles: profiles?.length || 0,
  };
}
