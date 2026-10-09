// Vérification du jeton Cloudflare Access (en-tête Cf-Access-Jwt-Assertion), sans dépendance.
// Algorithme RS256, clés publiques publiées sur <équipe>/cdn-cgi/access/certs.

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
interface JwksCache { cles: Map<string, CryptoKey>; expire: number }

let cache: JwksCache | null = null;
const DUREE_CACHE_MS = 60 * 60 * 1000;

export type ChargeurJwks = (url: string) => Promise<{ keys: Jwk[] }>;

const chargeurParDefaut: ChargeurJwks = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Clés Access indisponibles (${r.status})`);
  return (await r.json()) as { keys: Jwk[] };
};

function b64urlVersOctets(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlVersJson(s: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlVersOctets(s))) as Record<string, unknown>;
}

async function cles(teamDomain: string, chargeur: ChargeurJwks, forcer = false): Promise<Map<string, CryptoKey>> {
  if (!forcer && cache && cache.expire > Date.now()) return cache.cles;
  const { keys } = await chargeur(`${teamDomain.replace(/\/$/, "")}/cdn-cgi/access/certs`);
  const map = new Map<string, CryptoKey>();
  for (const k of keys) {
    if (k.kty !== "RSA") continue;
    const cle = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    map.set(k.kid, cle);
  }
  cache = { cles: map, expire: Date.now() + DUREE_CACHE_MS };
  return map;
}

export function viderCacheJwks(): void {
  cache = null;
}

/**
 * Vérifie le jeton et renvoie l'e-mail authentifié, ou null si le jeton est absent, mal formé,
 * mal signé, expiré, ou émis pour une autre application.
 */
export async function verifierJetonAccess(
  jeton: string,
  opts: { teamDomain: string; aud: string; chargeur?: ChargeurJwks; maintenantSec?: number },
): Promise<string | null> {
  const parties = jeton.split(".");
  if (parties.length !== 3) return null;
  const [h, p, s] = parties as [string, string, string];
  let entete: Record<string, unknown>;
  let charge: Record<string, unknown>;
  try {
    entete = b64urlVersJson(h);
    charge = b64urlVersJson(p);
  } catch {
    return null;
  }
  if (entete.alg !== "RS256" || typeof entete.kid !== "string") return null;

  const chargeur = opts.chargeur ?? chargeurParDefaut;
  let cle = (await cles(opts.teamDomain, chargeur)).get(entete.kid);
  if (!cle) cle = (await cles(opts.teamDomain, chargeur, true)).get(entete.kid); // rotation des clés
  if (!cle) return null;

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cle,
    b64urlVersOctets(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;

  const now = opts.maintenantSec ?? Math.floor(Date.now() / 1000);
  const tolerance = 60;
  if (typeof charge.exp !== "number" || charge.exp + tolerance < now) return null;
  if (typeof charge.nbf === "number" && charge.nbf - tolerance > now) return null;
  const issAttendu = opts.teamDomain.replace(/\/$/, "");
  if (charge.iss !== issAttendu) return null;
  const aud = Array.isArray(charge.aud) ? charge.aud : [charge.aud];
  if (!aud.includes(opts.aud)) return null;
  if (typeof charge.email !== "string" || !charge.email.includes("@")) return null;
  return charge.email.toLowerCase();
}
