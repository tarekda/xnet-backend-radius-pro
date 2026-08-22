/**
 * Extract and normalize a MAC address from a provider field. Some exports place
 * the MAC inside an IP/static-IP column alongside other text.
 */
export function extractMacAddress(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const candidates = [
    raw.match(/(?:^|[^0-9a-f])((?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})(?:$|[^0-9a-f])/i)?.[1],
    raw.match(/(?:^|[^0-9a-f])((?:[0-9a-f]{2}\s){5}[0-9a-f]{2})(?:$|[^0-9a-f])/i)?.[1],
    raw.match(/(?:^|[^0-9a-f])((?:[0-9a-f]{4}\.){2}[0-9a-f]{4})(?:$|[^0-9a-f])/i)?.[1],
    raw.match(/(?:^|[^0-9a-f])([0-9a-f]{12})(?:$|[^0-9a-f])/i)?.[1],
  ];

  const candidate = candidates.find(Boolean);
  if (!candidate) return null;

  const hex = candidate.replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)?.join(":") ?? null;
}
