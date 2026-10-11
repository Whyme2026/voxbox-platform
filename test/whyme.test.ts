// Why me : parcours du candidat, montage, transmission, page publique, espace recruteur, droits du candidat, tâches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { traiter } from "../src/index.ts";
import { ADMIN, client, creerEnv } from "./aide/env.ts";
import { ajouterMois, validerConfig } from "../src/whyme/config.ts";
import { tachesWhyme } from "../src/whyme/taches.ts";
import { couperLignes, bornesParole, texteBulle, bulle, expressionSon, DUREE_QUESTION } from "../montage/monter.ts";
import { ENTETE_SIGNATURE, signer } from "../montage/signature.ts";

const modele = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/whyme-campagne-demo.json"), "utf8"));
const CLE = "secret-de-montage-pour-les-tests-0123456789";

/** Campagne ouverte avec deux entreprises (Verkor, Valeo) et un recruteur chez chacune. */
async function preparer(surcharges: Record<string, unknown> = {}) {
  const { env, db, media } = creerEnv({ MONTAGE_CLE: CLE, RH_ADMIN_EMAILS: ADMIN, ...surcharges });
  const api = client(env);
  const pfa = (await api("POST", "/api/rh/clients", ADMIN, { nom: "PFA" })).corps.client.id as string;
  const verkor = (await api("POST", "/api/rh/entreprises", ADMIN, { nom: "Verkor" })).corps.entreprise.id as string;
  const valeo = (await api("POST", "/api/rh/entreprises", ADMIN, { nom: "Valeo" })).corps.entreprise.id as string;
  await api("POST", "/api/rh/recruteurs", ADMIN, { email: "rh@verkor.test", entreprise_id: verkor });
  await api("POST", "/api/rh/recruteurs", ADMIN, { email: "rh@valeo.test", entreprise_id: valeo });
  const cp = await api("POST", "/api/rh/campagnes", ADMIN, { nom: "Mondial 2026", code: "mondial-2026", client_id: pfa, config: modele, entreprises: [verkor, valeo] });
  assert.equal(cp.status, 201, JSON.stringify(cp.corps));
  const campagneId = cp.corps.campagne.id as string;
  assert.equal((await api("POST", `/api/rh/campagnes/${campagneId}/statut`, ADMIN, { statut: "active" })).status, 200);
  const publique = (await api("GET", "/api/whyme/campagnes/mondial-2026")).corps;

  const telephone = async (methode: string, chemin: string, jeton: string, corps?: unknown, entetes: Record<string, string> = {}) => {
    const binaire = corps instanceof Uint8Array;
    const res = await traiter(new Request(`http://localhost${chemin}`, {
      method: methode,
      headers: { "x-jeton": jeton, ...(corps !== undefined && !binaire ? { "content-type": "application/json" } : {}), ...entetes },
      body: corps === undefined ? undefined : binaire ? (corps as unknown as BodyInit) : JSON.stringify(corps),
    }), env);
    return { status: res.status, corps: (await res.json().catch(() => ({}))) as any };
  };
  const service = async (methode: string, chemin: string, corps?: Uint8Array | object, type?: string, entetes: Record<string, string> = {}) => {
    const res = await traiter(new Request(`http://localhost${chemin}`, {
      method: methode,
      headers: { [ENTETE_SIGNATURE]: await signer(CLE, methode, chemin.split("?")[0]!), ...(type ? { "content-type": type } : {}), ...entetes },
      body: corps === undefined ? undefined : corps instanceof Uint8Array ? (corps as unknown as BodyInit) : JSON.stringify(corps),
    }), env);
    return res;
  };

  /** Un candidat qui s'inscrit et répond à toutes les questions. */
  const candidat = async (o: { prenom?: string; entreprises?: string[]; public?: boolean; age?: number; cv?: boolean } = {}) => {
    const id = crypto.randomUUID();
    const jeton = "j".repeat(10) + crypto.randomUUID().replace(/-/g, "");
    const r = await telephone("POST", "/api/whyme/campagnes/mondial-2026/candidats", jeton, {
      id, jeton, prenom: o.prenom ?? "Camille", nom: "Martin", email: "camille@exemple.fr", age: o.age ?? 22, famille: "gerer",
      entreprises: o.entreprises ?? [verkor], consent_candidature: true, consent_public: o.public ?? true, empreinte: publique.empreinte,
    });
    assert.equal(r.status, 201, JSON.stringify(r.corps));
    if (o.cv) assert.equal((await telephone("PUT", `/api/whyme/candidats/${id}/cv`, jeton, new TextEncoder().encode("%PDF-1.4 cv"), { "content-type": "application/pdf", "x-nom-fichier": "CV%20Camille.pdf" })).status, 200);
    for (const q of modele.questions) {
      const p = await telephone("PUT", `/api/whyme/candidats/${id}/prises/${q.id}`, jeton, new Uint8Array([1, 2, 3, 4]), { "content-type": "video/webm;codecs=vp9,opus", "x-duree-ms": "9500", "x-son-present": "1" });
      assert.equal(p.status, 200, JSON.stringify(p.corps));
    }
    return { id, jeton };
  };

  /** Le service de montage fait son travail : miniature puis film. */
  const monter = async (id: string) => {
    const plan = await (await service("GET", `/api/montage/travaux/${id}`)).json() as any;
    assert.equal(plan.questions.length, 4);
    assert.equal((await service("PUT", `/api/montage/miniature/${id}`, new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg")).status, 200);
    assert.equal((await service("PUT", `/api/montage/resultat/${id}`, new Uint8Array(1000).fill(7), "video/mp4", { "x-duree-ms": "52000" })).status, 200);
    return plan;
  };

  const recruteur = async (email: string) => {
    await api("POST", "/api/recruteur/lien", undefined, { email });
    const courriel = db.sqlite.prepare("SELECT texte FROM wm_courriels WHERE a = ? AND sorte = 'connexion_recruteur' ORDER BY cree_le DESC LIMIT 1").get(email) as { texte: string } | undefined;
    const lien = /#lien=([\w-]+)/.exec(courriel?.texte ?? "")?.[1];
    assert.ok(lien, "lien de connexion reçu");
    const s = await api("POST", "/api/recruteur/session", undefined, { lien });
    assert.equal(s.status, 200, JSON.stringify(s.corps));
    const jeton = s.corps.jeton as string;
    return async (methode: string, chemin: string) => {
      const res = await traiter(new Request(`http://localhost${chemin}`, { method: methode, headers: { authorization: `Bearer ${jeton}` } }), env);
      return res;
    };
  };

  return { env, db, media, api, pfa, verkor, valeo, campagneId, publique, telephone, service, candidat, monter, recruteur };
}

test("Why me : configuration validée (3 à 5 questions, durées, identifiants)", () => {
  const c = validerConfig(modele);
  assert.equal(c.questions.length, 4);
  assert.equal(c.questions[0]!.dureeSec, 10);
  assert.equal(c.ageAffiche, true);
  assert.equal(c.ageMinimum, 15);
  assert.throws(() => validerConfig({ ...modele, questions: modele.questions.slice(0, 2) }), /3 à 5/);
  assert.throws(() => validerConfig({ ...modele, questions: [...modele.questions.slice(0, 3), { id: "q-toi", texte: "x" }] }), /double/);
  assert.throws(() => validerConfig({ ...modele, questions: modele.questions.map((q: any) => ({ ...q, dureeSec: 120 })) }), /durée/);
  assert.equal(validerConfig({ ...modele, ageAffiche: false }).ageAffiche, false);
  assert.equal(ajouterMois("2026-01-31T10:00:00.000Z", 1), "2026-02-28T10:00:00.000Z");
});

test("Why me : le téléphone voit la campagne ouverte, ses entreprises et ses textes", async () => {
  const { publique, api, campagneId } = await preparer();
  assert.equal(publique.campagne.evenement, "Mondial de l'Auto");
  assert.deepEqual(publique.entreprises.map((e: any) => e.nom), ["Verkor", "Valeo"]);
  assert.match(publique.textes.candidature, /12 mois/);
  assert.match(publique.textes.informationAge, /âge/);
  assert.equal(publique.empreinte.length, 64);
  // Campagne close : fermée au public.
  await api("POST", `/api/rh/campagnes/${campagneId}/statut`, ADMIN, { statut: "close" });
  assert.equal((await api("GET", "/api/whyme/campagnes/mondial-2026")).status, 404);
});

test("Why me : inscription contrôlée (âge minimum, accords, entreprises, textes à jour, idempotence)", async () => {
  const { telephone, publique, verkor } = await preparer();
  const id = crypto.randomUUID();
  const jeton = "a".repeat(40);
  const base = { id, jeton, prenom: "Léo", nom: "Durand", email: "leo@exemple.fr", age: 20, famille: "gerer", entreprises: [verkor], consent_candidature: true, consent_public: false, empreinte: publique.empreinte };
  const envoyer = (corps: object) => telephone("POST", "/api/whyme/campagnes/mondial-2026/candidats", jeton, corps);
  assert.equal((await envoyer({ ...base, age: 14 })).corps.erreur, "age_minimum");
  assert.equal((await envoyer({ ...base, consent_candidature: false })).status, 400);
  assert.equal((await envoyer({ ...base, entreprises: [] })).status, 400);
  assert.equal((await envoyer({ ...base, entreprises: ["inconnue"] })).status, 400);
  assert.equal((await envoyer({ ...base, famille: "inconnue" })).status, 400);
  assert.equal((await envoyer({ ...base, empreinte: "0".repeat(64) })).corps.erreur, "textes_changes");
  assert.equal((await envoyer(base)).status, 201);
  // Renvoi après une coupure : même interview, pas de doublon.
  assert.equal((await envoyer(base)).corps.deja, true);
  // Autre jeton sur le même identifiant : refusé.
  assert.equal((await telephone("POST", "/api/whyme/campagnes/mondial-2026/candidats", "b".repeat(40), { ...base, jeton: "b".repeat(40) })).status, 409);
});

test("Why me : prises, une seule reprise par question, fin seulement quand tout est arrivé", async () => {
  const { telephone, publique, verkor, media, db } = await preparer();
  const id = crypto.randomUUID();
  const jeton = "c".repeat(40);
  await telephone("POST", "/api/whyme/campagnes/mondial-2026/candidats", jeton, { id, jeton, prenom: "Inès", nom: "B", email: "ines@exemple.fr", age: 19, famille: "gerer", entreprises: [verkor], consent_candidature: true, empreinte: publique.empreinte });
  const prise = (q: string, entetes: Record<string, string> = {}) => telephone("PUT", `/api/whyme/candidats/${id}/prises/${q}`, jeton, new Uint8Array([9, 9]), { "content-type": "video/mp4", "x-duree-ms": "8000", "x-son-present": "1", ...entetes });
  assert.equal((await prise("q-toi", { "x-prise-id": "p1" })).status, 200);
  assert.equal((await prise("q-toi", { "x-prise-id": "p2", "x-reprise": "1" })).status, 200);
  // Même reprise renvoyée après une coupure : acceptée ; troisième prise : refusée.
  assert.equal((await prise("q-toi", { "x-prise-id": "p2", "x-reprise": "1" })).status, 200);
  assert.equal((await prise("q-toi", { "x-prise-id": "p3", "x-reprise": "1" })).status, 409);
  // La reprise a remplacé la première prise dans le stockage.
  assert.equal([...media.objets.keys()].filter((k) => k.includes(`${id}/q-toi`)).length, 1);
  assert.equal((await prise("inconnue")).status, 400);
  assert.equal((await telephone("PUT", `/api/whyme/candidats/${id}/prises/q-mot`, jeton, new Uint8Array([1]), { "content-type": "image/png" })).status, 415);
  assert.equal((await telephone("PUT", `/api/whyme/candidats/${id}/prises/q-mot`, "d".repeat(40), new Uint8Array([1]), { "content-type": "video/mp4" })).status, 401);
  const fin = await telephone("POST", `/api/whyme/candidats/${id}/terminer`, jeton);
  assert.equal(fin.corps.erreur, "reponses_manquantes");
  for (const q of ["q-autres", "q-decouverte", "q-mot"]) await prise(q);
  assert.equal((await telephone("POST", `/api/whyme/candidats/${id}/terminer`, jeton)).corps.statut, "termine");
  // Sans service de montage configuré : l'interview attend, rien n'est transmis.
  const c = db.sqlite.prepare("SELECT statut FROM wm_candidats WHERE id = ?").get(id) as { statut: string };
  assert.equal(c.statut, "termine");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM wm_candidatures WHERE candidat_id = ? AND transmise_le IS NOT NULL").get(id) as { n: number }).n, 0);
  // Interview terminée : plus de prise ni de CV.
  assert.equal((await prise("q-mot")).status, 409);
});

test("Why me : montage livré → rushes effacés, candidature transmise, e-mail avec page publique et sticker", async () => {
  const { candidat, monter, telephone, service, db, media, env } = await preparer();
  const { id, jeton } = await candidat({ cv: true });
  assert.equal((await telephone("POST", `/api/whyme/candidats/${id}/terminer`, jeton)).status, 200);
  // Le service est authentifié par son secret.
  assert.equal((await traiter(new Request(`http://localhost/api/montage/travaux/${id}`, { headers: { [ENTETE_SIGNATURE]: await signer("un-autre-secret-de-plus-de-32-caracteres", "GET", `/api/montage/travaux/${id}`) } }), env)).status, 401);
  // Signature valable pour un autre chemin, ou trop ancienne : refusée.
  assert.equal((await traiter(new Request(`http://localhost/api/montage/travaux/${id}`, { headers: { [ENTETE_SIGNATURE]: await signer(CLE, "GET", "/api/montage/prises/x/y") } }), env)).status, 401);
  assert.equal((await traiter(new Request(`http://localhost/api/montage/travaux/${id}`, { headers: { [ENTETE_SIGNATURE]: await signer(CLE, "GET", `/api/montage/travaux/${id}`, Date.now() - 6 * 60_000) } }), env)).status, 401);
  const plan = await monter(id);
  assert.equal(plan.prenom, "Camille");
  assert.equal(plan.age, 22);
  assert.equal(plan.questions[0].carton, "Toi, en deux mots");
  assert.deepEqual(plan.format, { largeur: 720, hauteur: 1280 });

  const c = db.sqlite.prepare("SELECT statut, code_public, acces_recruteurs_jusqu, public_jusqu, courriel_envoye_le FROM wm_candidats WHERE id = ?").get(id) as any;
  assert.equal(c.statut, "pret");
  assert.match(c.code_public, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.ok(c.acces_recruteurs_jusqu > new Date(Date.now() + 360 * 864e5).toISOString());
  assert.ok(c.public_jusqu > new Date(Date.now() + 720 * 864e5).toISOString());
  // Rushes effacés (décision du 11/10/2026) ; le montage, la miniature et le CV restent.
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM wm_prises WHERE candidat_id = ?").get(id) as { n: number }).n, 0);
  const cles = [...media.objets.keys()].filter((k) => k.includes(id));
  assert.deepEqual(cles.map((k) => k.split("/").pop()).sort(), ["cv.pdf", "miniature.jpg", "montage.mp4"]);
  // E-mail : entreprises nommées, bouton vers la page publique, sticker, lien de gestion, mention du CV.
  const mail = db.sqlite.prepare("SELECT a, sujet, texte, html FROM wm_courriels WHERE sorte = 'video_prete'").get() as any;
  assert.equal(mail.a, "camille@exemple.fr");
  assert.equal(mail.sujet, "Ta vidéo WhyMe est prête !");
  assert.match(mail.texte, /partie chez Verkor/);
  assert.match(mail.texte, /Ton CV et ton interview vidéo leur sont accessibles/);
  assert.match(mail.texte, new RegExp(`/v/${c.code_public}`));
  assert.match(mail.html, /sticker\.png/);
  assert.match(mail.texte, /whyme\/gerer\/#g=/);
  // Le montage renvoyé une seconde fois ne retransmet ni ne renvoie rien.
  await service("PUT", `/api/montage/resultat/${id}`, new Uint8Array(10), "video/mp4");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM wm_courriels WHERE sorte = 'video_prete'").get() as { n: number }).n, 1);
});

test("Why me : sans accord de page publique, pas de lien public ni de sticker", async () => {
  const { candidat, monter, telephone, db } = await preparer();
  const { id, jeton } = await candidat({ public: false });
  await telephone("POST", `/api/whyme/candidats/${id}/terminer`, jeton);
  await monter(id);
  const c = db.sqlite.prepare("SELECT code_public, public_jusqu FROM wm_candidats WHERE id = ?").get(id) as any;
  assert.equal(c.code_public, null);
  assert.equal(c.public_jusqu, null);
  const mail = db.sqlite.prepare("SELECT texte, html FROM wm_courriels WHERE sorte = 'video_prete'").get() as any;
  assert.doesNotMatch(mail.html, /sticker/);
  assert.doesNotMatch(mail.texte, /\/v\//);
  assert.match(mail.texte, /Ton interview vidéo leur est accessible pendant/);
});

test("Why me : page vidéo publique, sticker PNG, et suppression de la vidéo par le candidat (partout)", async () => {
  const { candidat, monter, telephone, db, api, recruteur, env } = await preparer();
  const { id, jeton } = await candidat();
  await telephone("POST", `/api/whyme/candidats/${id}/terminer`, jeton);
  await monter(id);
  const code = (db.sqlite.prepare("SELECT code_public FROM wm_candidats WHERE id = ?").get(id) as any).code_public as string;
  const v = await api("GET", `/api/whyme/videos/${code}`);
  assert.equal(v.status, 200);
  assert.equal(v.corps.prenom, "Camille");
  assert.equal(v.corps.nom, undefined, "pas de nom de famille sur la page publique");
  const flux = await traiter(new Request(`http://localhost/api/whyme/videos/${code}/flux?telecharger=1`), env);
  assert.equal(flux.status, 200);
  assert.match(flux.headers.get("content-disposition") ?? "", /^inline/, "jamais proposé en téléchargement au candidat");
  const sticker = await traiter(new Request(`http://localhost/api/whyme/videos/${code}/sticker.png`), env);
  const png = new Uint8Array(await sticker.arrayBuffer());
  assert.equal(sticker.headers.get("content-type"), "image/png");
  assert.deepEqual([...png.slice(1, 4)].map((o) => String.fromCharCode(o)).join(""), "PNG");
  assert.equal((await api("GET", "/api/whyme/videos/AAAAAAAAAA")).status, 404);

  // Lien « Tu gardes la main » de l'e-mail.
  const texte = (db.sqlite.prepare("SELECT texte FROM wm_courriels WHERE sorte = 'video_prete'").get() as any).texte as string;
  const gestion = /#g=([\w-]+)/.exec(texte)![1]!;
  const gerer = async (action: string) => {
    const r = await traiter(new Request("http://localhost/api/whyme/gestion", { method: "POST", headers: { "content-type": "application/json", "x-gestion": gestion }, body: JSON.stringify({ action }) }), env);
    return { status: r.status, corps: (await r.json()) as any };
  };
  const etat = await gerer("etat");
  assert.deepEqual(etat.corps.entreprises, ["Verkor"]);
  assert.equal(etat.corps.video, true);
  // Le recruteur voit la vidéo…
  const rh = await recruteur("rh@verkor.test");
  assert.equal((await rh("GET", `/api/recruteur/candidats/${id}/video`)).status, 200);
  // … jusqu'à ce que le candidat la supprime : elle disparaît partout (décision du 11/10/2026).
  assert.equal((await gerer("supprimer_video")).status, 200);
  assert.equal((await api("GET", `/api/whyme/videos/${code}`)).status, 404);
  assert.equal((await rh("GET", `/api/recruteur/candidats/${id}/video`)).status, 404);
  const liste = await (await rh("GET", "/api/recruteur/candidats")).json() as any;
  assert.equal(liste.candidats[0].aVideo, false, "la candidature reste, sans vidéo");
  // Toutes les données : la candidature disparaît aussi, le lien ne sert plus.
  assert.equal((await gerer("supprimer_tout")).status, 200);
  assert.equal(((await (await rh("GET", "/api/recruteur/candidats")).json()) as any).candidats.length, 0);
  assert.equal((await gerer("etat")).status, 401);
  const c = db.sqlite.prepare("SELECT prenom, email, supprime_le FROM wm_candidats WHERE id = ?").get(id) as any;
  assert.equal(c.email, "");
  assert.ok(c.supprime_le);
});

test("Why me : espace recruteur cloisonné par entreprise, CV et vidéo journalisés, lien à usage unique", async () => {
  const { candidat, monter, telephone, recruteur, db, verkor, valeo, api } = await preparer();
  const a = await candidat({ prenom: "Alice", entreprises: [verkor], cv: true });
  const b = await candidat({ prenom: "Bruno", entreprises: [verkor, valeo] });
  const c = await candidat({ prenom: "Chloé", entreprises: [valeo] });
  for (const x of [a, b, c]) { await telephone("POST", `/api/whyme/candidats/${x.id}/terminer`, x.jeton); await monter(x.id); }
  // Une interview non montée n'est pas encore transmise.
  await candidat({ prenom: "David", entreprises: [verkor] });

  const verkorRh = await recruteur("rh@verkor.test");
  const listeVerkor = await (await verkorRh("GET", "/api/recruteur/candidats")).json() as any;
  assert.equal(listeVerkor.entreprise, "Verkor");
  assert.deepEqual(listeVerkor.candidats.map((x: any) => x.prenom).sort(), ["Alice", "Bruno"]);
  assert.equal(listeVerkor.candidats.find((x: any) => x.prenom === "Alice").famille, "Gérer & Administrer");
  // Chloé n'a postulé que chez Valeo : invisible pour Verkor.
  assert.equal((await verkorRh("GET", `/api/recruteur/candidats/${c.id}/video`)).status, 404);
  const cv = await verkorRh("GET", `/api/recruteur/candidats/${a.id}/cv?telecharger=1`);
  assert.equal(cv.status, 200);
  assert.match(cv.headers.get("content-disposition") ?? "", /^attachment/);
  const dl = await verkorRh("GET", `/api/recruteur/candidats/${a.id}/video?telecharger=1`);
  assert.match(dl.headers.get("content-disposition") ?? "", /^attachment/, "le recruteur peut télécharger");
  const actions = (db.sqlite.prepare("SELECT action FROM journal WHERE utilisateur_email = 'rh@verkor.test'").all() as any[]).map((l) => l.action);
  assert.deepEqual(actions.sort(), ["recruteur.connexion", "recruteur.cv.telechargement", "recruteur.video.telechargement"]);
  // Sans session : rien.
  assert.equal((await api("GET", "/api/recruteur/candidats")).status, 401);
  // Le lien de connexion ne sert qu'une fois ; une adresse inconnue reçoit la même réponse, sans e-mail.
  const lien = /#lien=([\w-]+)/.exec((db.sqlite.prepare("SELECT texte FROM wm_courriels WHERE a = 'rh@verkor.test'").get() as any).texte)![1];
  assert.equal((await api("POST", "/api/recruteur/session", undefined, { lien })).status, 401);
  const inconnu = await api("POST", "/api/recruteur/lien", undefined, { email: "personne@exemple.fr" });
  assert.equal(inconnu.status, 200);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM wm_courriels WHERE a = 'personne@exemple.fr'").get() as any).n, 0);
});

test("Why me : paramétrage réservé à WhyMe ; campagne figée une fois ouverte", async () => {
  const { api, campagneId, verkor, pfa } = await preparer();
  const cl = await api("POST", "/api/admin/clients", ADMIN, { nom: "Marque", raison_sociale: "Marque SAS", contact_rgpd: "rgpd@marque.test" });
  await api("POST", "/api/admin/utilisateurs", ADMIN, { email: "lit@marque.test", role: "lecteur_client", client_id: cl.corps.client.id });
  assert.equal((await api("GET", "/api/rh/campagnes", "lit@marque.test")).status, 403);
  assert.equal((await api("PATCH", `/api/rh/campagnes/${campagneId}`, ADMIN, { config: modele })).status, 409);
  assert.equal((await api("PATCH", `/api/rh/campagnes/${campagneId}`, ADMIN, { nom: "Renommée" })).status, 200);
  assert.equal((await api("POST", "/api/rh/campagnes", ADMIN, { nom: "X", client_id: pfa, config: { ...modele, questions: [] }, entreprises: [verkor] })).status, 400);
  assert.equal((await api("POST", "/api/rh/campagnes", ADMIN, { nom: "X", code: "mondial-2026", client_id: pfa, config: modele, entreprises: [verkor] })).status, 409);
});

test("Why me : tâches planifiées (relance du montage, e-mail de reprise, purges)", async () => {
  const appels: string[] = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    appels.push(`${init?.method ?? "GET"} ${String(url)} ${String(init?.body ?? "")}`);
    return new Response("{}", { status: 202 });
  }) as typeof fetch;
  try {
    const { candidat, telephone, db, env, publique, verkor } = await preparer({ MONTAGE_URL: "https://montage.test" });
    // Une interview terminée : le montage est demandé tout de suite au service.
    const t = await candidat();
    await telephone("POST", `/api/whyme/candidats/${t.id}/terminer`, t.jeton);
    assert.equal(appels.length, 1);
    assert.match(appels[0]!, /POST https:\/\/montage\.test\/monter .*"api":"http:\/\/localhost"/);
    // Bloqué depuis 20 minutes : relancé par la tâche.
    db.sqlite.prepare("UPDATE wm_candidats SET montage_demande_le = ? WHERE id = ?").run(new Date(Date.now() - 20 * 60_000).toISOString(), t.id);
    assert.equal((await tachesWhyme(env)).montages, 1);

    // Interview interrompue depuis 20 minutes : e-mail de reprise, une seule fois, avec un nouveau jeton.
    const id = crypto.randomUUID();
    const jeton = "e".repeat(40);
    await telephone("POST", "/api/whyme/campagnes/mondial-2026/candidats", jeton, { id, jeton, prenom: "Zoé", nom: "R", email: "zoe@exemple.fr", age: 30, famille: "gerer", entreprises: [verkor], consent_candidature: true, empreinte: publique.empreinte });
    db.sqlite.prepare("UPDATE wm_candidats SET derniere_action_le = ? WHERE id = ?").run(new Date(Date.now() - 20 * 60_000).toISOString(), id);
    assert.equal((await tachesWhyme(env)).reprises, 1);
    assert.equal((await tachesWhyme(env)).reprises, 0);
    const mail = db.sqlite.prepare("SELECT texte FROM wm_courriels WHERE sorte = 'reprise'").get() as any;
    const lien = new RegExp(`/i/mondial-2026#reprise=${id}\\.([\\w-]+)`).exec(mail.texte);
    assert.ok(lien);
    // L'ancien jeton du téléphone ne sert plus ; celui du lien, si.
    assert.equal((await telephone("GET", `/api/whyme/candidats/${id}`, jeton)).status, 401);
    assert.equal((await telephone("GET", `/api/whyme/candidats/${id}`, lien[1]!)).corps.prenom, "Zoé");

    // Purges : interview jamais terminée après 30 jours ; candidature dont tous les accès sont échus.
    db.sqlite.prepare("UPDATE wm_candidats SET cree_le = ? WHERE id = ?").run(new Date(Date.now() - 31 * 864e5).toISOString(), id);
    db.sqlite.prepare("UPDATE wm_candidats SET statut = 'pret', acces_recruteurs_jusqu = ?, public_jusqu = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 1000).toISOString(), t.id);
    const bilan = await tachesWhyme(env);
    assert.equal(bilan.purges, 2);
    const restes = db.sqlite.prepare("SELECT COUNT(*) AS n FROM wm_candidats WHERE supprime_le IS NULL").get() as any;
    assert.equal(restes.n, 0);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test("Why me : montage, typographie des cartons et repérage de la parole", () => {
  assert.deepEqual(couperLignes("Toi… en deux mots ?", 18), ["Toi… en deux", "mots ?"]);
  assert.ok(couperLignes("Quelle est ta dernière découverte ? (appli, livre, sport, film…)", 18).every((l) => l.length <= 18 || !l.includes(" ")));
  const sortie = "[silencedetect] silence_start: 0\n[silencedetect] silence_end: 1.6 | silence_duration: 1.6\n[silencedetect] silence_start: 8.2\n";
  assert.deepEqual(bornesParole(sortie, 10), { debut: 1.35, fin: 8.6 });
  assert.deepEqual(bornesParole("", 10), { debut: 0, fin: 10 });
  // Trop peu de parole : on garde tout plutôt que de couper à l'aveugle.
  assert.deepEqual(bornesParole("silence_start: 0\nsilence_end: 9.5\n", 10), { debut: 0, fin: 10 });
});

test("Why me : renvoi d'un e-mail gardé (expéditeur corrigé chez Brevo)", async () => {
  const sans = await preparer();
  const t0 = await sans.candidat();
  await sans.monter(t0.id);
  const mail0 = sans.db.sqlite.prepare("SELECT id FROM wm_courriels WHERE sorte = 'video_prete'").get() as { id: string };
  assert.equal((await sans.api("POST", `/api/rh/courriels/${mail0.id}/renvoyer`, ADMIN)).status, 409); // sans Brevo

  const envois: string[] = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    envois.push(`${String(url)} ${String(init?.body ?? "")}`);
    return new Response("{}", { status: 201 });
  }) as typeof fetch;
  try {
    const { candidat, monter, db, api } = await preparer({ BREVO_CLE: "cle-brevo-test", COURRIEL_EXPEDITEUR_WHYME: "laurent@whyme.test" });
    const t = await candidat();
    await monter(t.id);
    const mail = db.sqlite.prepare("SELECT id, a FROM wm_courriels WHERE sorte = 'video_prete'").get() as { id: string; a: string };
    const avant = envois.length;
    assert.equal((await api("POST", `/api/rh/courriels/${mail.id}/renvoyer`, "lit@marque.test")).status, 403);
    const r = await api("POST", `/api/rh/courriels/${mail.id}/renvoyer`, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.corps));
    assert.equal(envois.length, avant + 1);
    assert.match(envois.at(-1)!, /laurent@whyme\.test/);
    assert.ok(envois.at(-1)!.includes(mail.a));
    assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM journal WHERE action = 'whyme.courriel.renvoi'").get() as { n: number }).n, 1);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test("Why me : plan « question » du montage (bulle, texte, signature sonore)", () => {
  assert.equal(DUREE_QUESTION, 3);
  // La question telle que posée si elle se lit en 3 secondes, sinon son titre court.
  assert.equal(texteBulle({ carton: "Pourquoi toi ?", texte: "Un dernier mot : ton talent ?" }), "Un dernier mot : ton talent ?");
  assert.equal(texteBulle({ carton: "Pourquoi toi ?", texte: "x".repeat(81) }), "Pourquoi toi ?");
  assert.equal(texteBulle({ carton: "Toi" }), "Toi");
  // Bulle : un PNG valide, de la hauteur de la bulle plus sa queue.
  const p = bulle(200, 100, [198, 1, 124], { rayon: 30, queue: 20 });
  assert.deepEqual([...p.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const v = new DataView(p.buffer, p.byteOffset);
  assert.equal(v.getUint32(16), 200);
  assert.equal(v.getUint32(20), 120);
  // Son : deux notes montantes (880 puis 1318,5 Hz), la seconde un peu après la première.
  const e = expressionSon(0.75);
  assert.match(e, /880\*\(t-0\.75\)/);
  assert.match(e, /1318\.5\*\(t-0\.86\)/);
});

test("Why me : espace RH séparé de Parlopop (comptes et rôles distincts)", async () => {
  // L'administrateur Parlopop (ADMIN_EMAILS) n'ouvre pas l'espace RH sans être de l'équipe RH, et inversement.
  const { env } = creerEnv({ RH_ADMIN_EMAILS: "rh@whyme.test" });
  const api = client(env);
  assert.equal((await api("GET", "/api/rh/campagnes", ADMIN)).status, 403);
  assert.equal((await api("GET", "/api/rh/campagnes", "rh@whyme.test")).status, 200);
  assert.equal((await api("GET", "/api/admin/utilisateurs", "rh@whyme.test")).status, 403);
  // L'équipe RH : un opérateur gère les campagnes mais pas l'équipe.
  assert.equal((await api("POST", "/api/rh/equipe", "rh@whyme.test", { email: "op@whyme.test", role: "operateur_rh" })).status, 201);
  assert.equal((await api("GET", "/api/rh/clients", "op@whyme.test")).status, 200);
  assert.equal((await api("GET", "/api/rh/equipe", "op@whyme.test")).status, 403);
  assert.equal((await api("GET", "/api/admin/campagnes", "op@whyme.test")).status, 403);
  assert.equal((await api("POST", "/api/rh/equipe/retirer", "rh@whyme.test", { email: "op@whyme.test" })).status, 200);
  assert.equal((await api("GET", "/api/rh/clients", "op@whyme.test")).status, 403);
});

test("Why me : client et sous-clients (statistiques agrégées pour le client, rien de personnel)", async () => {
  const { api, pfa, verkor, valeo, candidat, monter, db, env, campagneId } = await preparer();
  // Une campagne ne s'ouvre pas sans client ; le client se change à tout moment.
  const sans = await api("POST", "/api/rh/campagnes", ADMIN, { nom: "Sans client", client_id: "x", config: modele, entreprises: [verkor] });
  assert.equal(sans.status, 400);
  // Deux candidats : l'un postule chez Verkor et Valeo, l'autre chez Verkor seulement.
  const a = await candidat({ entreprises: [verkor, valeo] });
  await monter(a.id);
  const b = await candidat({ entreprises: [verkor] });
  await monter(b.id);
  await candidat({ entreprises: [valeo] }); // commencée, jamais terminée

  // Le contact client se connecte sur le même espace que les recruteurs, par lien reçu par e-mail.
  assert.equal((await api("POST", `/api/rh/clients/${pfa}/contacts`, ADMIN, { email: "contact@pfa.test" })).status, 201);
  assert.equal((await api("POST", `/api/rh/clients/${pfa}/contacts`, ADMIN, { email: "rh@verkor.test" })).status, 409); // déjà recruteur
  await api("POST", "/api/recruteur/lien", undefined, { email: "contact@pfa.test" });
  const mail = db.sqlite.prepare("SELECT texte FROM wm_courriels WHERE a = 'contact@pfa.test' AND sorte = 'connexion_client'").get() as { texte: string };
  const lien = /#lien=([\w-]+)/.exec(mail.texte)![1];
  const s = await api("POST", "/api/recruteur/session", undefined, { lien });
  assert.equal(s.status, 200);
  assert.equal(s.corps.profil, "client");
  const appel = (chemin: string) => traiter(new Request(`http://localhost${chemin}`, { headers: { authorization: `Bearer ${s.corps.jeton}` } }), env);

  const st = await (await appel("/api/recruteur/statistiques")).json() as any;
  assert.equal(st.client, "PFA");
  assert.equal(st.campagnes.length, 1);
  const c = st.campagnes[0];
  assert.equal(c.id, campagneId);
  assert.equal(c.commencees, 3);
  assert.equal(c.terminees, 2);
  assert.equal(c.transmises, 2);
  assert.equal(c.candidatures, 3);
  assert.deepEqual(c.parEntreprise.map((e: any) => [e.nom, e.candidatures]), [["Verkor", 2], ["Valeo", 1]]);
  // Aucune donnée personnelle dans les statistiques.
  const brut = JSON.stringify(st);
  for (const interdit of [a.id, "@exemple", "prenom", "email\":\"r"]) assert.ok(!brut.includes(interdit), interdit);
  // Le contact client n'a aucun accès aux candidatures.
  assert.equal((await appel("/api/recruteur/candidats")).status, 401);
  assert.equal((await appel(`/api/recruteur/candidats/${a.id}/video`)).status, 401);
  // Et la même statistique côté équipe RH.
  assert.equal((await api("GET", `/api/rh/campagnes/${campagneId}/statistiques`, ADMIN)).corps.transmises, 2);
});

test("Why me : éditeur de campagne (vérification, aperçu sans enregistrement, code réservé)", async () => {
  const { api, pfa, verkor, db } = await preparer();
  // Vérification : mêmes règles qu'à l'enregistrement, rien n'est écrit.
  const ok = await api("POST", "/api/rh/campagnes/verifier", ADMIN, { config: modele });
  assert.deepEqual(ok.corps, { problemes: [] });
  const ko = await api("POST", "/api/rh/campagnes/verifier", ADMIN, { config: { ...modele, questions: modele.questions.slice(0, 2) } });
  assert.equal(ko.status, 200);
  assert.match(ko.corps.problemes[0], /3 à 5 questions/);
  assert.equal((await api("POST", "/api/rh/campagnes/verifier", "lit@marque.test", { config: modele })).status, 403);
  // Aperçu : ce que verrait le téléphone, avec les entreprises cochées, sans campagne créée.
  const avant = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM wm_campagnes").get() as { n: number }).n;
  const a = await api("POST", "/api/rh/campagnes/apercu", ADMIN, { config: { ...modele, evenement: "Salon d'essai" }, entreprises: [verkor, "inconnue"] });
  assert.equal(a.status, 200, JSON.stringify(a.corps));
  assert.equal(a.corps.campagne.code, "apercu");
  assert.equal(a.corps.campagne.evenement, "Salon d'essai");
  assert.deepEqual(a.corps.entreprises.map((e: any) => e.nom), ["Verkor"]);
  assert.equal(a.corps.campagne.questions[0].carton, undefined); // le téléphone ne reçoit pas les titres du film
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM wm_campagnes").get() as { n: number }).n, avant);
  // Le code « apercu » ne peut pas servir de vraie campagne.
  assert.equal((await api("POST", "/api/rh/campagnes", ADMIN, { nom: "X", code: "apercu", client_id: pfa, config: modele, entreprises: [verkor] })).status, 409);
  // Brouillon : questionnaire et entreprises modifiables depuis l'éditeur.
  const cp = await api("POST", "/api/rh/campagnes", ADMIN, { nom: "Brouillon", client_id: pfa, config: modele, entreprises: [verkor] });
  const nouvelle = { ...modele, questions: [...modele.questions, { id: "q-5", texte: "Et demain ?", dureeSec: 12, lectureSec: 8 }] };
  assert.equal((await api("PATCH", `/api/rh/campagnes/${cp.corps.campagne.id}`, ADMIN, { config: nouvelle, entreprises: [verkor] })).status, 200);
  const relue = (await api("GET", "/api/rh/campagnes", ADMIN)).corps.campagnes.find((c: any) => c.id === cp.corps.campagne.id);
  assert.equal(relue.config.questions.length, 5);
});

test("Why me : vidéos montées dans l'espace RH (liste, miniature, lecture et CV journalisés)", async () => {
  const { api, candidat, telephone, monter, campagneId, env, db } = await preparer();
  const t = await candidat({ cv: true });
  await telephone("POST", `/api/whyme/candidats/${t.id}/terminer`, t.jeton);
  assert.equal((await api("GET", "/api/rh/videos", ADMIN)).corps.videos.length, 0);
  await monter(t.id);
  const { videos } = (await api("GET", `/api/rh/videos?campagne=${campagneId}`, ADMIN)).corps;
  assert.equal(videos.length, 1);
  assert.equal(videos[0].id, t.id);
  assert.equal(videos[0].a_miniature, true);
  assert.equal(videos[0].evenement, modele.evenement);
  assert.equal((await api("GET", "/api/rh/videos?campagne=autre", ADMIN)).corps.videos.length, 0);
  assert.equal((await api("GET", "/api/rh/videos", "lit@marque.test")).status, 403);
  const appel = (chemin: string) => traiter(new Request(`http://localhost${chemin}`, { headers: { "x-dev-email": ADMIN } }), env);
  const mini = await appel(`/api/rh/candidats/${t.id}/miniature`);
  assert.equal(mini.status, 200);
  assert.equal(mini.headers.get("content-type"), "image/jpeg");
  const video = await appel(`/api/rh/candidats/${t.id}/video`);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get("content-type"), "video/mp4");
  const cv = await appel(`/api/rh/candidats/${t.id}/cv`);
  assert.equal(cv.status, 200);
  const actions = (db.sqlite.prepare("SELECT action FROM journal WHERE cible_id = ? ORDER BY quand").all(t.id) as { action: string }[]).map((x) => x.action);
  assert.ok(actions.includes("whyme.video.lecture"));
  assert.ok(actions.includes("whyme.cv.lecture"));
});

test("Why me : espace RH, création simple et fiches créées par erreur", async () => {
  const { api, pfa, verkor, campagneId } = await preparer();
  // Une adresse e-mail n'est pas un nom d'organisation (confusion avec les contacts et les recruteurs).
  const mail = await api("POST", "/api/rh/clients", ADMIN, { nom: "laurent@exemple.fr" });
  assert.equal(mail.status, 400);
  assert.match(mail.corps.message, /adresse e-mail/);
  assert.equal((await api("POST", "/api/rh/entreprises", ADMIN, { nom: "rh@exemple.fr" })).status, 400);
  // Création sans entreprise : permise ; l'ouverture, elle, en exige une.
  const cp = await api("POST", "/api/rh/campagnes", ADMIN, { nom: "Forum", client_id: pfa, config: modele, entreprises: [] });
  assert.equal(cp.status, 201, JSON.stringify(cp.corps));
  const ouvrir = await api("POST", `/api/rh/campagnes/${cp.corps.campagne.id}/statut`, ADMIN, { statut: "active" });
  assert.equal(ouvrir.status, 409);
  assert.match(ouvrir.corps.message, /entreprise/);
  // Suppressions : seulement ce qui n'a servi à rien.
  assert.equal((await api("DELETE", `/api/rh/campagnes/${campagneId}`, ADMIN)).status, 409); // ouverte
  assert.equal((await api("DELETE", `/api/rh/campagnes/${cp.corps.campagne.id}`, ADMIN)).status, 200);
  assert.equal((await api("DELETE", `/api/rh/clients/${pfa}`, ADMIN)).status, 409); // a des campagnes
  assert.equal((await api("DELETE", `/api/rh/entreprises/${verkor}`, ADMIN)).status, 409); // proposée dans une campagne
  const vide = (await api("POST", "/api/rh/clients", ADMIN, { nom: "Raoul Ducros" })).corps.client.id;
  await api("POST", `/api/rh/clients/${vide}/contacts`, ADMIN, { email: "raoul@exemple.fr" });
  assert.equal((await api("DELETE", `/api/rh/clients/${vide}`, ADMIN)).status, 200);
  const seule = (await api("POST", "/api/rh/entreprises", ADMIN, { nom: "Essai" })).corps.entreprise.id;
  await api("POST", "/api/rh/recruteurs", ADMIN, { email: "rh@essai.fr", entreprise_id: seule });
  assert.equal((await api("DELETE", `/api/rh/entreprises/${seule}`, ADMIN)).status, 200);
  // L'adresse du contact supprimé redevient libre.
  assert.equal((await api("POST", "/api/rh/recruteurs", ADMIN, { email: "raoul@exemple.fr", entreprise_id: verkor })).status, 201);
  const ents = (await api("GET", "/api/rh/entreprises", ADMIN)).corps.entreprises;
  assert.equal(ents.find((e: any) => e.id === verkor).campagnes, 1);
});
