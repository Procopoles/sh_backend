export function matchesSearch(query: string, values: Array<string | null | undefined>) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  return values.join(" ").toLowerCase().includes(normalizedQuery);
}
