// Signature des échanges entre la plateforme et le service de montage.
// Le secret partagé (MONTAGE_CLE) ne circule jamais : chaque requête porte l'en-tête
//   x-montage-signature: <horodatage ms>.<HMAC-SHA256(secret, "horodatage\nMÉTHODE\nchemin")>
// valable 5 minutes. Les journaux Cloudflare enregistrent les en-têtes des requêtes : une signature qui s'y
// retrouve ne permet ni de retrouver le secret ni de signer une autre requête.
// Sans dépendance : Web Crypto, disponible dans les Workers comme dans Node.

export const ENTETE_SIGNATURE = "x-montage-signature";
const VALIDITE_MS = 5 * 60_000;

async function hmac(cle: string, message: string): Promise<string> {
  // Espaces et retours à la ligne autour du secret ignorés : un copier-coller dans le tableau de bord en ajoute souvent.
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(cle.trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Valeur de l'en-tête de signature pour une requête (chemin sans la chaîne de requête). */
export async function signer(cle: string, methode: string, chemin: string, quand = Date.now()): Promise<string> {
  return `${quand}.${await hmac(cle, `${quand}\n${methode.toUpperCase()}\n${chemin}`)}`;
}

/** Vrai si la signature est valide, récente et faite avec ce secret pour cette méthode et ce chemin. */
export async function verifierSignature(cle: string, methode: string, chemin: string, signature: string | null | undefined): Promise<boolean> {
  if (!cle || !signature) return false;
  const [ts, mac] = signature.split(".");
  const quand = Number(ts);
  if (!mac || !Number.isSafeInteger(quand) || Math.abs(Date.now() - quand) > VALIDITE_MS) return false;
  const attendu = await hmac(cle, `${quand}\n${methode.toUpperCase()}\n${chemin}`);
  if (attendu.length !== mac.length) return false;
  let d = 0;
  for (let i = 0; i < attendu.length; i++) d |= attendu.charCodeAt(i) ^ mac.charCodeAt(i);
  return d === 0;
}

/** Empreinte courte du secret (12 caractères), pour vérifier que les deux côtés ont le même sans le montrer. */
export async function empreinteCourte(cle: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`whyme-montage-empreinte\n${cle.trim()}`));
  return [...new Uint8Array(h)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}
