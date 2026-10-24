// Price parsing and rough currency conversion.

// Approximate fixed rates, only used to sort results across currencies.
// Displayed as "≈" in the UI; the original price is always shown too.
const EUR_RATES = { EUR: 1, GBP: 1.17, USD: 0.92, CHF: 1.06, SEK: 0.09, NOK: 0.085, CZK: 0.041 };

const COUNTRY_CURRENCY = { FR: 'EUR', DE: 'EUR', NL: 'EUR', BE: 'EUR', LU: 'EUR', ES: 'EUR', IT: 'EUR', IE: 'EUR', FI: 'EUR', GB: 'GBP', CH: 'CHF', SE: 'SEK', NO: 'NOK', CZ: 'CZK' };

export function defaultCurrency(country) {
  return COUNTRY_CURRENCY[country] ?? 'EUR';
}

export function toEur(amount, currency) {
  const rate = EUR_RATES[currency];
  return rate && Number.isFinite(amount) ? Math.round(amount * rate * 100) / 100 : null;
}

// Detect a currency code in a free-text price such as "1.299,00 €" or "£1,299.00".
export function detectCurrency(text, country) {
  const t = String(text ?? '');
  if (/€|\bEUR\b/i.test(t)) return 'EUR';
  if (/£|\bGBP\b/i.test(t)) return 'GBP';
  if (/\bCHF\b/i.test(t)) return 'CHF';
  if (/Kč|\bCZK\b/i.test(t)) return 'CZK';
  if (/\bSEK\b/i.test(t)) return 'SEK';
  if (/\bNOK\b/i.test(t)) return 'NOK';
  if (/\$|\bUSD\b/i.test(t)) return 'USD';
  if (/\bkr\b/i.test(t)) return country === 'NO' ? 'NOK' : 'SEK';
  return defaultCurrency(country);
}

// Turn "1.299,00", "1,299.00", "1 299,5" or "89" into a number.
export function parseAmount(raw) {
  const m = String(raw ?? '').match(/\d[\d.,  \s]*/);
  if (!m) return null;
  let s = m[0].replace(/[  \s]/g, '').replace(/[.,]+$/, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    // The separator that comes last is the decimal one.
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    s = s.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma !== -1) {
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot !== -1) {
    s = /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s;
  }
  const value = parseFloat(s);
  return Number.isFinite(value) ? value : null;
}

// Free-text price -> { amount, currency } (or null).
export function parsePrice(text, country) {
  const amount = parseAmount(text);
  if (amount == null || amount <= 0) return null;
  return { amount, currency: detectCurrency(text, country) };
}
