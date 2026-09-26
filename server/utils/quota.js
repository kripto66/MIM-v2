import crypto from 'node:crypto';

export async function reserveQuota(sb, userId, resource, limit, idempotencyKey = null) {
  if (limit === null || limit === undefined) return { allowed: true, id: null, max: null };
  const { data, error } = await sb.rpc('reserve_quota', {
    p_user_id: userId,
    p_resource: resource,
    p_quantity: 1,
    p_idempotency_key: idempotencyKey,
    p_ttl: '15 minutes',
    p_metadata: {},
  });
  if (error) {
    if (/quota|plan.*inactif|plan.*expire/i.test(error.message)) {
      return { allowed: false, code: 'QUOTA_LIMIT_REACHED', message: 'La limite de votre abonnement est atteinte.' };
    }
    throw new Error(error.message);
  }
  return { allowed: true, id: data, max: limit, token: crypto.randomUUID() };
}

export async function consumeQuota(sb, reservationId, userId) {
  if (!reservationId) return;
  const { error } = await sb.rpc('consume_quota', { p_reservation_id: reservationId, p_user_id: userId });
  if (error) throw new Error(error.message);
}

export async function releaseQuota(sb, reservationId, userId) {
  if (!reservationId) return;
  const { error } = await sb.rpc('release_quota', { p_reservation_id: reservationId, p_user_id: userId });
  if (error && !/introuvable|terminale|consommee/i.test(error.message)) throw new Error(error.message);
}

export async function withQuota(sb, userId, resource, limit, operation, idempotencyKey = null) {
  const reservation = await reserveQuota(sb, userId, resource, limit, idempotencyKey);
  if (!reservation.allowed) return reservation;
  try {
    const result = await operation();
    await consumeQuota(sb, reservation.id, userId);
    return { ...result, quotaReservationId: reservation.id };
  } catch (err) {
    await releaseQuota(sb, reservation.id, userId).catch(() => {});
    throw err;
  }
}
