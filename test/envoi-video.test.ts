// Écran « Recevoir ma vidéo » (14/10/2026) : l'e-mail laissé après l'accord, l'accord de diffusion donné au même
// moment, et l'e-mail envoyé une fois les vidéos reçues, avec le lien pour les voir et changer d'avis.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { traiter } from "../src/index.ts";
import { boiteEssai } from "../src/courriel.ts";
import { envoyerVideosAuxVisiteurs, messageVideos } from "../src/routes/acces.ts";
import { ADMIN, client, creerEnv } from "./aide/env.ts";

beforeEach(() => { boiteEssai.length = 0; });

const base = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-whyme-base.json"), "utf8"));
const demo = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/parcours-demo.json"), "utf8"));

async function campagne(parcours: unknown) {
  const { env, db } = creerEnv();
  const api = client(env);
  const cl = await api("POST", "/api/admin/clients", ADMIN, { nom: "WhyMe", raison_sociale: "WhyMe SAS", contact_rgpd: "rgpd@whyme.test" });
  const cid = (await api("POST", "/api/admin/campagnes", ADMIN, { client_id: cl.corps.client.id, nom: "Démo" })).corps.campagne.id as string;
  const p = await api("POST", `/api/admin/campagnes/${cid}/parcours`, ADMIN, { config: parcours });
  assert.equal(p.status, 201, JSON.stringify(p.corps));
  await api("POST", `/api/admin/campagnes/${cid}/consentement`, ADMIN, {});
  await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "validee" });
  await api("POST", `/api/admin/campagnes/${cid}/statut`, ADMIN, { statut: "active" });
  const cab = await api("POST", "/api/admin/cabines", ADMIN, { nom: "Cabine A" });
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
  const passage = async (prenom: string, champs: Record<string, unknown>, videos = 1) => {
    const id = crypto.randomUUID();
    const s = await tablette("POST", "/api/cabine/sessions", {
      id, prenom, consent_interne: true, parcours_version_id: conf.campagne.parcours_version_id, consentement_version_id: conf.consentement.id, ...champs,
    });
    const q = (parcours as any).etapes.find((e: any) => e.type === "question").id;
    for (let i = 0; i < videos; i++) await tablette("PUT", `/api/cabine/sessions/${id}/reponses/${q}`, new Uint8Array([1, 2, 3]), { "content-type": "video/webm", "x-duree-ms": "8000", "x-son-present": "1" });
    return { id, status: s.status, corps: s.corps };
  };
  /** Vieillit un passage (l'e-mail part 10 minutes après). */
  const vieillir = (id: string, minutes: number) => db.prepare("UPDATE sessions SET cree_le = ? WHERE id = ?").bind(new Date(Date.now() - minutes * 60_000).toISOString(), id).run();
  return { env, db, api, cid, conf, passage, vieillir };
}

test("recevoir : la cabine annonce l'accord de diffusion de l'écran « recevoir », le serveur garde l'e-mail et la demande", async () => {
  const { db, conf, passage } = await campagne(base);
  assert.ok(conf.consentement.texte_diffusion?.includes("réseaux sociaux"), "texte de diffusion envoyé à la cabine");
  const ines = await passage("Inès", { email: "Ines@Exemple.fr", envoi_video: true, consent_diffusion: true });
  assert.equal(ines.status, 201, JSON.stringify(ines.corps));
  const s = await db.prepare("SELECT email, envoi_video, envoi_video_origine, consent_diffusion, recontact FROM sessions WHERE id = ?").bind(ines.id).first<any>();
  assert.deepEqual(s, { email: "ines@exemple.fr", envoi_video: 1, envoi_video_origine: "http://localhost", consent_diffusion: 1, recontact: 0 });
  // Sans e-mail, la demande ne vaut rien.
  const sans = await passage("Léo", { envoi_video: true });
  assert.equal((await db.prepare("SELECT envoi_video FROM sessions WHERE id = ?").bind(sans.id).first<any>()).envoi_video, 0);
});

test("recevoir : une campagne sans cet écran n'enregistre pas de demande d'envoi", async () => {
  const { db, passage } = await campagne(demo);
  const p = await passage("Camille", { email: "camille@exemple.fr", envoi_video: true });
  assert.equal((await db.prepare("SELECT envoi_video FROM sessions WHERE id = ?").bind(p.id).first<any>()).envoi_video, 0);
});

test("recevoir : l'e-mail part une fois les vidéos reçues, une seule fois, avec un lien qui ouvre ses vidéos et permet de changer d'avis", async () => {
  const { env, db, api, cid, passage, vieillir } = await campagne(base);
  const ines = await passage("Inès", { email: "ines@exemple.fr", envoi_video: true, consent_diffusion: true });
  // Trop tôt : le visiteur est peut-être encore en cabine.
  assert.deepEqual(await envoyerVideosAuxVisiteurs(env), { envoyes: 0, abandonnes: 0, erreurs: 0 });
  await vieillir(ines.id, 12);
  assert.equal((await envoyerVideosAuxVisiteurs(env)).envoyes, 1);
  assert.equal((await envoyerVideosAuxVisiteurs(env)).envoyes, 0, "une seule fois");
  assert.equal(boiteEssai.length, 1);
  const m = boiteEssai[0]!;
  assert.equal(m.a, "ines@exemple.fr");
  assert.match(m.sujet, /Inès, tes vidéos Parlobox sont prêtes/, "tutoiement du parcours");
  assert.match(m.texte, /retirer ton accord pour les réseaux sociaux/);
  assert.match(m.texte, /contact@parlobox\.com/);
  const jeton = /#acces=([\w-]+)/.exec(m.texte)?.[1] ?? "";
  assert.ok(m.texte.includes("http://localhost/retrait/#acces="), "lien vers la page du visiteur, sur l'adresse de la plateforme");
  // Le lien ouvre ses vidéos (30 jours) et permet de retirer la diffusion.
  const appel = (methode: string, chemin: string, corps?: unknown) => traiter(new Request(`http://localhost${chemin}`, {
    method: methode, headers: { "x-acces": jeton, ...(corps ? { "content-type": "application/json" } : {}) }, body: corps ? JSON.stringify(corps) : undefined,
  }), env);
  const moi = await (await appel("GET", "/api/acces/moi")).json() as any;
  assert.equal(moi.passages.length, 1);
  assert.equal(moi.passages[0].reponses.length, 1);
  const acces = await db.prepare("SELECT motif, expire_le FROM acces_visiteur").first<any>();
  assert.equal(acces.motif, "video");
  assert.ok(Date.parse(acces.expire_le) > Date.now() + 29 * 24 * 3600_000, "lien valable 30 jours");
  assert.equal((await appel("POST", `/api/acces/sessions/${ines.id}`, { portee: "diffusion" })).status, 200);
  assert.equal((await db.prepare("SELECT consent_diffusion FROM sessions WHERE id = ?").bind(ines.id).first<any>()).consent_diffusion, 0);
  // Ce lien ne compte pas dans la limite des demandes faites depuis le QR code extérieur.
  assert.equal((await api("POST", "/api/acces/demande", undefined, { email: "ines@exemple.fr" })).status, 200);
  assert.equal(boiteEssai.length, 2);
  // Tracé, et visible dans Parlorama.
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM journal WHERE action = 'session.envoi_videos'").first<any>()).n, 1);
  const s = (await api("GET", `/api/espace/campagnes/${cid}/sessions`, ADMIN)).corps.sessions.find((x: any) => x.id === ines.id);
  assert.equal(s.envoi_video, true);
  assert.ok(s.envoi_video_le);
});

test("recevoir : pas d'e-mail sans vidéo ; abandon au bout d'un jour ; rien après un retrait d'accord", async () => {
  const { env, db, passage, vieillir } = await campagne(base);
  const sansVideo = await passage("Zoé", { email: "zoe@exemple.fr", envoi_video: true }, 0);
  await vieillir(sansVideo.id, 30);
  assert.equal((await envoyerVideosAuxVisiteurs(env)).envoyes, 0);
  assert.equal((await db.prepare("SELECT envoi_video_le FROM sessions WHERE id = ?").bind(sansVideo.id).first<any>()).envoi_video_le, null, "on attend encore");
  await vieillir(sansVideo.id, 25 * 60);
  assert.equal((await envoyerVideosAuxVisiteurs(env)).abandonnes, 1);
  const retire = await passage("Max", { email: "max@exemple.fr", envoi_video: true });
  await db.prepare("UPDATE sessions SET retiree_le = ?, email = NULL WHERE id = ?").bind(new Date().toISOString(), retire.id).run();
  await vieillir(retire.id, 15);
  assert.equal((await envoyerVideosAuxVisiteurs(env)).envoyes, 0);
  assert.equal(boiteEssai.length, 0);
});

test("recevoir : sans service d'e-mail configuré hors développement, rien ne part et rien n'est marqué", async () => {
  const { env, db, passage, vieillir } = await campagne(base);
  const p = await passage("Inès", { email: "ines@exemple.fr", envoi_video: true });
  await vieillir(p.id, 15);
  const bilan = await envoyerVideosAuxVisiteurs({ ...env, AUTH_MODE: "access", BREVO_CLE: undefined });
  assert.deepEqual(bilan, { envoyes: 0, abandonnes: 0, erreurs: 0 });
  assert.equal((await db.prepare("SELECT envoi_video_le FROM sessions WHERE id = ?").bind(p.id).first<any>()).envoi_video_le, null);
});

test("recevoir : l'e-mail au vouvoiement, sans phrase sur la diffusion si elle n'a pas été acceptée, texte échappé", () => {
  const m = messageVideos({ prenom: "<b>Anne</b>", marque: "Alpha", lien: "https://x.test/retrait/#acces=abc", tutoiement: false, diffusion: false, contact: "rgpd@alpha.test" });
  assert.match(m.texte, /Vous changez d'avis \? Depuis ce même lien, vous pouvez supprimer vos vidéos/);
  assert.doesNotMatch(m.texte, /réseaux sociaux/);
  assert.match(m.texte, /rgpd@alpha\.test/);
  assert.ok(!m.html.includes("<b>Anne</b>"), "prénom échappé dans le HTML");
});
