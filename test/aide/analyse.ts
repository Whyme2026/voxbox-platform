// Scénario partagé par les tests de l'option Analyse : une marque (et une autre pour le cloisonnement), une campagne
// active avec l'option, une grille de thèmes, une cabine appairée ; un faux service Mistral (transcription et classement).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { traiter } from "../../src/index.ts";
import type { Env } from "../../src/types.ts";
import type { Fetch } from "../../src/analyse/mistral.ts";
import { ADMIN, client, creerEnv } from "./env.ts";

const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/parcours-demo.json"), "utf8"));

export const GRILLE = [
  { libelle: "Silence", description: "bruit, calme, acoustique" },
  { libelle: "Écran", description: "écran, interface, menus" },
  { libelle: "Prix" },
];

/**
 * Faux Mistral : la transcription renvoie le texte voulu (mots horodatés) ; le classement renvoie le JSON voulu.
 * Chaque appel est noté.
 */
export function fauxMistral(opts: { texte?: string; classement?: unknown; statutClassement?: number } = {}) {
  const texte = opts.texte ?? "On n'entend rien, même sur le boulevard. Par contre pour la clim il faut trois menus, c'est pénible.";
  const appels: { url: string; corps: any }[] = [];
  const f: Fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/audio/transcriptions")) {
      appels.push({ url, corps: null });
      const mots = texte.split(" ").map((t, i) => ({ text: t, start: 0.5 + i * 0.4, end: 0.8 + i * 0.4 }));
      return Response.json({ text: texte, words: mots });
    }
    const corps = JSON.parse(String(init?.body));
    appels.push({ url, corps });
    if (opts.statutClassement) return new Response("erreur", { status: opts.statutClassement });
    const contenu = opts.classement ?? {
      themes: [
        { id: "silence", tonalite: "positif", extrait: "On n'entend rien, même sur le boulevard." },
        { id: "ecran", tonalite: "negatif", extrait: "pour la clim il faut trois menus" },
      ],
      autre_sujet: null, alerte: false, motif_alerte: null,
    };
    return Response.json({ choices: [{ message: { content: JSON.stringify(contenu) } }] });
  };
  return { f, appels };
}

export async function campagneAnalyse(opts: { grille?: unknown[]; env?: Partial<Env> } = {}) {
  const { env, db, media } = creerEnv({ MISTRAL_API_KEY: "cle-test", ...opts.env });
  const api = client(env);
  const marque = async (nom: string) => {
    const cl = await api("POST", "/api/admin/clients", ADMIN, { nom, raison_sociale: `${nom} SAS`, contact_rgpd: `rgpd@${nom.toLowerCase()}.test` });
    await api("POST", "/api/admin/utilisateurs", ADMIN, { email: `lit@${nom.toLowerCase()}.test`, role: "lecteur_client", client_id: cl.corps.client.id });
    return cl.corps.client.id as string;
  };
  const alpha = await marque("Alpha");
  await marque("Beta");
  const cid = (await api("POST", "/api/admin/campagnes", ADMIN, { client_id: alpha, nom: "Essai" })).corps.campagne.id as string;
  const p = await api("PATCH", `/api/admin/campagnes/${cid}`, ADMIN, { option_analyse: true, grille_themes: opts.grille ?? GRILLE });
  assert.equal(p.status, 200, JSON.stringify(p.corps));
  await api("POST", `/api/admin/campagnes/${cid}/parcours`, ADMIN, { config: demo });
  await api("POST", `/api/admin/campagnes/${cid}/consentement`, ADMIN, {});
  assert.equal((await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "validee" })).status, 200);
  assert.equal((await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "active" })).status, 200);
  const cab = await api("POST", "/api/admin/cabines", ADMIN, { nom: "Cabine 1" });
  await api("PATCH", `/api/admin/cabines/${cab.corps.cabine.id}`, ADMIN, { campagne_id: cid });
  const jeton = (await api("POST", "/api/cabine/appairer", undefined, { code: cab.corps.cabine.code_appairage })).corps.jeton as string;
  const tablette = async (methode: string, chemin: string, corps: unknown, entetes: Record<string, string> = {}) => {
    const json = !(corps instanceof Uint8Array);
    const res = await traiter(new Request(`http://localhost${chemin}`, {
      method: methode,
      headers: { authorization: `Bearer ${jeton}`, ...(json ? { "content-type": "application/json" } : {}), ...entetes },
      body: json ? JSON.stringify(corps) : (corps as unknown as BodyInit),
    }), env);
    return { status: res.status, corps: (await res.json()) as any };
  };
  const conf = (await traiter(new Request("http://localhost/api/cabine/config", { headers: { authorization: `Bearer ${jeton}` } }), env).then((r) => r.json())) as any;
  /** Un visiteur qui répond à une question ; renvoie l'identifiant de session et de réponse. */
  const visiteur = async (prenom = "Camille", etape = "q-coup-de-coeur") => {
    const sid = crypto.randomUUID();
    await tablette("POST", "/api/cabine/sessions", {
      id: sid, prenom, consent_interne: true,
      parcours_version_id: conf.campagne.parcours_version_id, consentement_version_id: conf.consentement.id,
    });
    const put = await tablette("PUT", `/api/cabine/sessions/${sid}/reponses/${etape}`, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2]),
      { "content-type": "video/webm", "x-duree-ms": "9000", "x-son-present": "1" });
    assert.equal(put.status, 201, JSON.stringify(put.corps));
    const rep = await db.prepare("SELECT id FROM reponses WHERE session_id = ? AND etape_id = ?").bind(sid, etape).first<{ id: string }>();
    return { sid, rid: rep!.id };
  };
  return { env, db, media, api, cid, alpha, cabineId: cab.corps.cabine.id as string, tablette, visiteur, conf };
}
