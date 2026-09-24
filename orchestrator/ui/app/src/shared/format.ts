// Format helpers — exact numbers, units visible (DESIGN.md §8, §4 tabular numerals).

export function usd(value: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = opts.sign && value > 0 ? "+" : "";
  return `${sign}$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function pct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function ratio(numerator: number | null | undefined, denominator: number | null | undefined): string {
  if (numerator === null || numerator === undefined || denominator === null || denominator === undefined || !denominator) return "—";
  return usd(numerator);
}

export function datetime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function shortId(id: string | null | undefined, len = 8): string {
  if (!id) return "—";
  return id.length <= len ? id : id.slice(0, len);
}

export function vehicleTitle(meta: { year?: string | null; make?: string | null; model?: string | null }): string {
  return [meta.year, meta.make, meta.model].filter(Boolean).join(" ") || "Untitled vehicle";
}
