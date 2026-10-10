// Envoi d'une vidéo stockée dans R2, avec prise en charge des requêtes partielles (« Range ») :
// le lecteur vidéo du navigateur démarre tout de suite et peut avancer dans le film sans tout télécharger.

import type { Env } from "./types.ts";
import { introuvable } from "./http.ts";

interface Plage { offset: number; length?: number }

/** Lit l'en-tête Range (« bytes=debut-fin » ou « bytes=debut- »). Les autres formes sont ignorées. */
export function lirePlage(entete: string | null): Plage | null {
  const m = /^bytes=(\d+)-(\d*)$/.exec(entete?.trim() ?? "");
  if (!m) return null;
  const debut = Number(m[1]);
  const fin = m[2] ? Number(m[2]) : null;
  if (fin !== null && fin < debut) return null;
  return fin === null ? { offset: debut } : { offset: debut, length: fin - debut + 1 };
}

/**
 * Vidéo complète ou partielle. `journaliser` n'est appelé qu'au premier morceau (pas de plage, ou plage qui
 * commence à 0) : un visionnage = une ligne de journal, même si le lecteur demande le film en plusieurs fois.
 */
export async function servirVideo(
  request: Request, env: Env, cle: string,
  o: { type: string; nom: string; journaliser: () => Promise<void> },
): Promise<Response> {
  const url = new URL(request.url);
  const plage = lirePlage(request.headers.get("range"));
  const objet = await env.MEDIA.get(cle, plage ? { range: plage } : undefined);
  if (!objet?.body) throw introuvable("Vidéo introuvable dans le stockage");
  const taille = objet.size;
  if (plage && plage.offset >= taille) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${taille}` } });
  }
  if (!plage || plage.offset === 0) await o.journaliser();
  const disposition = url.searchParams.get("telecharger") === "1" ? "attachment" : "inline";
  const entetes: Record<string, string> = {
    "content-type": o.type,
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-disposition": `${disposition}; filename="${o.nom.replace(/[^\w.-]/g, "-")}"`,
  };
  if (!plage) return new Response(objet.body, { headers: { ...entetes, "content-length": String(taille) } });
  const fin = Math.min(taille - 1, plage.offset + (plage.length ?? taille) - 1);
  return new Response(objet.body, {
    status: 206,
    headers: { ...entetes, "content-range": `bytes ${plage.offset}-${fin}/${taille}`, "content-length": String(fin - plage.offset + 1) },
  });
}

