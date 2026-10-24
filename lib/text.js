// Small text helpers shared by the matcher and the extractor.

// Lowercase, strip accents, collapse whitespace.
export function normalize(str) {
  return String(str ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Keep only letters and digits ("SM-10" -> "sm10").
export function compact(str) {
  return normalize(str).replace(/[^a-z0-9]/g, '');
}
