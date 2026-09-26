const MAX_MONEY_CENTS = 999999999999n;

export function parseMoney(value, { allowZero = false } = {}) {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !value.trim())) return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > MAX_MONEY_CENTS) return null;
  if (cents === 0n && !allowZero) return null;
  return Number(cents) / 100;
}

export function isValidMonth(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(value || ''));
  return Boolean(match && Number(match[1]) >= 1);
}

export function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  if (year < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
