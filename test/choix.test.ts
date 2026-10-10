// Choix du visiteur (qualification, aiguillage, modèle) et habillage de campagne : parcours Geely de référence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { traiter } from "../src/index.ts";
import { ADMIN, client, creerEnv } from "./aide/env.ts";

const geely = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-geely.json"), "utf8"));

async function campagneGeely() {
  const { env, db } = creerEnv();
  const api = client(env);
  const cl = await api("POST", "/api/admin/clients", ADMIN, { nom: "Geely", raison_sociale: "Geely Auto France", contact_rgpd: "rgpd@geely.test" });
  await api("POST", "/api/admin/utilisateurs", ADMIN, { email: "lit@geely.test", role: "lecteur_client", client_id: cl.corps.client.id });
  const autre = await api("POST", "/api/admin/clients", ADMIN, { nom: "Autre", raison_sociale: "Autre SAS", contact_rgpd: "rgpd@autre.test" });
  await api("POST", "/api/admin/utilisateurs", ADMIN, { email: "lit@autre.test", role: "lecteur_client", client_id: autre.corps.client.id });
  const cid = (await api("POST", "/api/admin/campagnes", ADMIN, { client_id: cl.corps.client.id, nom: "Concession" })).corps.campagne.id as string;
  assert.equal((await api("POST", `/api/admin/campagnes/${cid}/parcours`, ADMIN, { config: geely })).status, 201);
  await api("POST", `/api/admin/campagnes/${cid}/consentement`, ADMIN, {});
  await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "validee" });
  await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "active" });
  const cab = await api("POST", "/api/admin/cabines", ADMIN, { nom: "Concession Lyon" });
  await api("PATCH", `/api/admin/cabines/${cab.corps.cabine.id}`, ADMIN, { campagne_id: cid });
  const jeton = (await api("POST", "/api/cabine/appairer", undefined, { code: cab.corps.cabine.code_appairage })).corps.jeton as string;
  const tablette = async (methode: string, chemin: string, corps?: unknown) => {
    const res = await traiter(new Request(`http://localhost${chemin}`, {
      method: methode, headers: { authorization: `Bearer ${jeton}`, "content-type": "application/json" }, body: corps === undefined ? undefined : JSON.stringify(corps),
    }), env);
    return { status: res.status, corps: (await res.json()) as any };
  };
  const conf = (await tablette("GET", "/api/cabine/config")).corps;
  const visiteur = async (prenom: string) => {
    const id = crypto.randomUUID();
    const r = await tablette("POST", "/api/cabine/sessions", {
      id, prenom, consent_interne: true, parcours_version_id: conf.campagne.parcours_version_id, consentement_version_id: conf.consentement.id,
    });
    assert.equal(r.status, 201, JSON.stringify(r.corps));
    return id;
  };
  return { env, db, api, cid, tablette, conf, visiteur };
}

test("configuration de la cabine : l'habillage de la campagne arrive avec le parcours", async () => {
  const { conf } = await campagneGeely();
  assert.equal(conf.parcours.habillage.polices.titres, "michroma");
  assert.equal(conf.parcours.habillage.visuels.length, 4);
});

test("choix : enregistré par étape, renvoi idempotent (le dernier envoi l'emporte)", async () => {
  const { db, tablette, visiteur } = await campagneGeely();
  const sid = await visiteur("Camille");
  assert.equal((await tablette("PUT", `/api/cabine/sessions/${sid}/choix/aiguillage`, { option_id: "coup-oeil" })).status, 201);
  assert.equal((await tablette("PUT", `/api/cabine/sessions/${sid}/choix/modele-a`, { option_id: "e2" })).status, 201);
  assert.equal((await tablette("PUT", `/api/cabine/sessions/${sid}/choix/modele-a`, { option_id: "starray" })).status, 201);
  const lignes = await db.prepare("SELECT etape_id, option_id FROM choix WHERE session_id = ? ORDER BY etape_id").bind(sid).all<{ etape_id: string; option_id: string }>();
  assert.deepEqual(lignes.results, [{ etape_id: "aiguillage", option_id: "coup-oeil" }, { etape_id: "modele-a", option_id: "starray" }]);
});

test("choix : étape qui n'est pas un choix, option inconnue ou session inconnue refusées", async () => {
  const { tablette, visiteur } = await campagneGeely();
  const sid = await visiteur("Léa");
  assert.equal((await tablette("PUT", `/api/cabine/sessions/${sid}/choix/a-regard`, { option_id: "x" })).status, 400);
  assert.equal((await tablette("PUT", `/api/cabine/sessions/${sid}/choix/aiguillage`, { option_id: "fusee" })).status, 400);
  assert.equal((await tablette("PUT", `/api/cabine/sessions/${crypto.randomUUID()}/choix/aiguillage`, { option_id: "essai" })).status, 404);
});

test("Parlorama : choix par visiteur, libellés des choix et habillage ; export avec une colonne par choix", async () => {
  const { env, api, cid, tablette, visiteur } = await campagneGeely();
  const sid = await visiteur("Camille");
  await tablette("PUT", `/api/cabine/sessions/${sid}/choix/aiguillage`, { option_id: "client" });
  await tablette("PUT", `/api/cabine/sessions/${sid}/choix/depuis-c`, { option_id: "1-3-mois" });
  const d = (await api("GET", `/api/espace/campagnes/${cid}/sessions`, "lit@geely.test")).corps;
  assert.deepEqual(d.sessions[0].choix, { aiguillage: "client", "depuis-c": "1-3-mois" });
  const aiguillage = d.choix.find((x: any) => x.id === "aiguillage");
  assert.equal(aiguillage.titre, "Alors, vous en êtes où avec Geely ?");
  assert.equal(d.choix.find((x: any) => x.id === "essai-a").titre, "Et si la suite se passait au volant ?");
  assert.deepEqual(aiguillage.options.map((o: any) => o.libelle), ["J'ai jeté un œil", "Je sors de l'essai", "J'ai déjà ma Geely"]);
  assert.equal(d.questions.length, 9);
  assert.equal(d.questions.find((q: any) => q.id === "c-signature").fond, "ardoise");
  assert.equal(d.habillage.couleurs.visiteur, "#FF5841");
  const res = await traiter(new Request(`http://localhost/api/espace/campagnes/${cid}/export.csv`, { headers: { "x-dev-email": "lit@geely.test" } }), env);
  assert.equal(res.status, 200);
  const texte = await res.text();
  assert.match(texte, /Alors, vous en êtes où avec Geely \?/);
  assert.match(texte, /J'ai déjà ma Geely/);
  assert.match(texte, /1 à 3 mois/);
});

test("choix : invisibles pour une autre marque, supprimés avec un retrait d'accord", async () => {
  const { api, db, cid, tablette, visiteur } = await campagneGeely();
  const sid = await visiteur("Hugo");
  await tablette("PUT", `/api/cabine/sessions/${sid}/choix/aiguillage`, { option_id: "essai" });
  assert.equal((await api("GET", `/api/espace/campagnes/${cid}/sessions`, "lit@autre.test")).status, 404);
  assert.equal((await api("POST", `/api/espace/sessions/${sid}/retrait`, ADMIN, {})).status, 200);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM choix WHERE session_id = ?").bind(sid).first<{ n: number }>();
  assert.equal(n?.n, 0);
  assert.equal((await tablette("PUT", `/api/cabine/sessions/${sid}/choix/aiguillage`, { option_id: "essai" })).status, 410);
});
