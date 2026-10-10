// Scénario partagé par les tests : deux marques, une campagne active avec deux cabines et trois visiteurs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { traiter } from "../../src/index.ts";
import { ADMIN, client, creerEnv } from "./env.ts";

const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/parcours-demo.json"), "utf8"));

/** Deux marques ; la première a une campagne active, deux cabines et trois visiteurs qui ont répondu. */
export async function campagneAvecReponses() {
  const { env, db, media } = creerEnv();
  const api = client(env);
  const marque = async (nom: string) => {
    const cl = await api("POST", "/api/admin/clients", ADMIN, { nom, raison_sociale: `${nom} SAS`, contact_rgpd: `rgpd@${nom.toLowerCase()}.test`, couleurs: { principale: "#0F6E5A" } });
    await api("POST", "/api/admin/utilisateurs", ADMIN, { email: `lit@${nom.toLowerCase()}.test`, role: "lecteur_client", client_id: cl.corps.client.id });
    await api("POST", "/api/admin/utilisateurs", ADMIN, { email: `valide@${nom.toLowerCase()}.test`, role: "validateur_client", client_id: cl.corps.client.id });
    return cl.corps.client.id as string;
  };
  const alpha = await marque("Alpha");
  await marque("Beta");
  const cid = (await api("POST", "/api/admin/campagnes", ADMIN, { client_id: alpha, nom: "Démo" })).corps.campagne.id as string;
  await api("POST", `/api/admin/campagnes/${cid}/parcours`, ADMIN, { config: demo });
  await api("POST", `/api/admin/campagnes/${cid}/consentement`, ADMIN, {});
  await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "validee" });
  await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "active" });

  const tablettes: Record<string, { jeton: string; id: string }> = {};
  for (const nom of ["A", "B"]) {
    const cab = await api("POST", "/api/admin/cabines", ADMIN, { nom: `Cabine ${nom}` });
    await api("PATCH", `/api/admin/cabines/${cab.corps.cabine.id}`, ADMIN, { campagne_id: cid });
    tablettes[nom] = { jeton: (await api("POST", "/api/cabine/appairer", undefined, { code: cab.corps.cabine.code_appairage })).corps.jeton, id: cab.corps.cabine.id };
  }
  const tablette = async (cab: string, methode: string, chemin: string, corps: unknown, entetes: Record<string, string> = {}) => {
    const json = !(corps instanceof Uint8Array);
    const res = await traiter(new Request(`http://localhost${chemin}`, {
      method: methode,
      headers: { authorization: `Bearer ${tablettes[cab]!.jeton}`, ...(json ? { "content-type": "application/json" } : {}), ...entetes },
      body: json ? JSON.stringify(corps) : (corps as unknown as BodyInit),
    }), env);
    return { status: res.status, corps: (await res.json()) as any };
  };
  const conf = (await traiter(new Request("http://localhost/api/cabine/config", { headers: { authorization: `Bearer ${tablettes.A!.jeton}` } }), env).then((r) => r.json())) as any;
  const visiteur = async (cab: string, prenom: string, diffusion: boolean, email?: string, code_retrait?: string) => {
    const sid = crypto.randomUUID();
    await tablette(cab, "POST", "/api/cabine/sessions", {
      id: sid, prenom, consent_interne: true, consent_diffusion: diffusion, email, recontact: Boolean(email), code_retrait,
      parcours_version_id: conf.campagne.parcours_version_id, consentement_version_id: conf.consentement.id,
    });
    for (const q of ["q-premier-mot", "q-coup-de-coeur"]) {
      await tablette(cab, "PUT", `/api/cabine/sessions/${sid}/reponses/${q}`, new Uint8Array([1, 2, 3]), { "content-type": "video/webm", "x-duree-ms": "9000", "x-son-present": "1" });
    }
    return sid;
  };
  const camille = await visiteur("A", "Camille", true, "camille@exemple.fr");
  const lea = await visiteur("B", "Léa", false);
  const hugo = await visiteur("A", "Hugo", true);
  const donnees = (await api("GET", `/api/espace/campagnes/${cid}/sessions`, ADMIN)).corps;
  const reponse = (sid: string, etape: string) => donnees.sessions.find((s: any) => s.id === sid).reponses.find((r: any) => r.etape_id === etape).id as string;
  return { env, db, media, api, cid, camille, lea, hugo, reponse, tablette, visiteur, cabines: { A: tablettes.A!.id, B: tablettes.B!.id } };
}

