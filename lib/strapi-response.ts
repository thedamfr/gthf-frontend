/** Admit only the expected Strapi envelope before a public cache refresh. */
export function validStrapiResponse(value: unknown, wrappedByKey?: string, wrappedByList = false): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (wrappedByList) return Array.isArray(record.data)
    && record.data.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
  if (wrappedByKey) {
    const item = record[wrappedByKey];
    return item === null || (typeof item === 'object' && !Array.isArray(item));
  }
  return true;
}
