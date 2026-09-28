export interface HeaderRow { name: string; value: string }

export function parseHeaderRows(rows: HeaderRow[]): Record<string, string> {
  const seen = new Set<string>();
  const entries: Array<[string, string]> = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!name && !row.value) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(row.value) || seen.has(name.toLowerCase())) {
      throw new Error("Invalid or duplicate HTTP header");
    }
    seen.add(name.toLowerCase());
    entries.push([name, row.value]);
  }
  return Object.fromEntries(entries);
}
