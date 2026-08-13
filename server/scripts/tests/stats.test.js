// ============================================================
// MIM - Suite stats : cohérence du dashboard + isolation
// ============================================================

import { api, expectSuccess } from './lib.js';

const S = 'stats';

export async function runStats(r, ctx) {
  const service = ctx.service;
  const month = ctx.seed.month;

  for (const owner of ctx.seed.owners.slice(0, 3)) {
    const expected = await computeExpected(service, owner.id, month);
    const res = await api('/stats/dashboard', { jar: owner.jar });

    if (!expectSuccess(r, res, S, r)) continue;

    const s = res.data.stats;
    const name = `owner${owner.i}`;
    const checks = [
      ['totalProperties', s.totalProperties, expected.totalProperties],
      ['occupiedProperties', s.occupiedProperties, expected.occupiedProperties],
      ['availableProperties', s.availableProperties, expected.availableProperties],
      ['totalTenants', s.totalTenants, expected.totalTenants],
      ['expectedRent', Number(s.expectedRent), expected.expectedRent],
      ['paidRent', Number(s.paidRent), expected.paidRent],
      ['lateRent', Number(s.lateRent), expected.lateRent],
      ['activeIncidents', s.activeIncidents, expected.activeIncidents],
      ['activeInterventions', s.activeInterventions, expected.activeInterventions],
    ];

    for (const [field, got, want] of checks) {
      if (got === want) r.pass(S, `${name} : ${field} = ${got}`);
      else r.fail(S, `${name} : ${field} = ${got} (attendu ${want})`);
    }
  }

  // ----------------------------------------------------------
  await r.section('stats : pas de fuite entre propriétaires', async () => {
    const o1 = ctx.seed.owners[0];
    const o2 = ctx.seed.owners[1];
    const [s1, s2] = await Promise.all([
      api('/stats/dashboard', { jar: o1.jar }),
      api('/stats/dashboard', { jar: o2.jar }),
    ]);

    if (s1.data?.stats?.totalTenants === 10 && s2.data?.stats?.totalTenants === 10) {
      r.pass(S, 'chaque propriétaire voit 10 locataires (pas 20)');
    } else {
      r.fail(S, 'chaque propriétaire voit 10 locataires', `o1=${s1.data?.stats?.totalTenants} o2=${s2.data?.stats?.totalTenants}`);
    }

    if (s1.data?.stats?.expectedRent !== s2.data?.stats?.expectedRent) {
      r.pass(S, 'loyers attendus différents entre propriétaires');
    } else {
      r.fail(S, 'loyers attendus différents entre propriétaires', `o1=${s1.data?.stats?.expectedRent} o2=${s2.data?.stats?.expectedRent}`);
    }
  });
}

async function computeExpected(service, userId, month) {
  const [logements, locataires, paiements, incidents, interventions] = await Promise.all([
    service.from('logements').select('id, statut, loyer_mensuel').eq('user_id', userId),
    service.from('locataires').select('id').eq('user_id', userId),
    service.from('paiements').select('id, montant, statut, mois').eq('user_id', userId),
    service.from('incidents').select('id, statut').eq('user_id', userId),
    service.from('interventions').select('id, statut').eq('user_id', userId),
  ]);

  const lgs = logements.data || [];
  const monthPay = (paiements.data || []).filter((p) => p.mois === month);

  return {
    totalProperties: lgs.length,
    occupiedProperties: lgs.filter((l) => l.statut === 'occupe').length,
    availableProperties: lgs.filter((l) => l.statut === 'libre').length,
    totalTenants: (locataires.data || []).length,
    expectedRent: lgs.filter((l) => l.statut === 'occupe').reduce((s, l) => s + Number(l.loyer_mensuel || 0), 0),
    paidRent: monthPay.filter((p) => p.statut === 'paye').reduce((s, p) => s + Number(p.montant), 0),
    lateRent: monthPay.filter((p) => p.statut === 'retard').reduce((s, p) => s + Number(p.montant), 0),
    activeIncidents: (incidents.data || []).filter((i) => i.statut !== 'resolu').length,
    activeInterventions: (interventions.data || []).filter((i) => i.statut !== 'termine').length,
  };
}
