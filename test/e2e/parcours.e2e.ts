// Essais de bout en bout de la cabine, dans un vrai Chrome sans écran avec caméra et micro simulés.
// Quatre scénarios :
//  - demo : parcours neutre Parlobox (accueil, consignes et accord, 5 questions, fin), flou activé ;
//  - auto : parcours automobile (prénom, consentement, cadrage, choix, pause avant/après, reprise) ;
//  - fabrice : ambiance « pop » et tutoiement (choix, 6 questions), en paysage puis en portrait ;
//  - alexandre : ambiance « marine », tutoiement et un visuel par écran (4 questions), en paysage puis en portrait ;
//  - pfa : Fabrique de l'Innovation (Mondial de l'Auto 2026) : habillage Barlow, dégradé et rayons, tutoiement, prénom seul,
//    sans diffusion publique (public jeune), 4 questions, en paysage puis en portrait ;
//  - geely : campagne habillée (polices, fonds, visuels) à trois branches ; le visiteur « jette un œil »,
//    répond, part essayer la voiture, revient et répond aux questions d'après l'essai (choix enregistrés).
// Chaque scénario vérifie ensuite que toutes les vidéos reçues contiennent une piste son et de la voix.
//
// node test/e2e/parcours.e2e.ts <fichier-audio.wav> <dossier-captures> [demo|auto|fabrice|alexandre|pfa|geely]
// Nécessite Playwright et Chromium (variables PLAYWRIGHT_MODULE et PLAYWRIGHT_BROWSERS_PATH).

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import assert from "node:assert/strict";
import { demarrerServeur, preparer, objets, db } from "./serveur.ts";
import { boiteEssai } from "../../src/courriel.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "/opt/npm-tools/node_modules/playwright");

const [audio, captures = "captures", scenario = "demo"] = process.argv.slice(2);
if (!audio) throw new Error("Fichier audio de test manquant");
mkdirSync(captures, { recursive: true });

const fixture = scenario === "auto" ? "parcours-automobile.json" : scenario === "fabrice" ? "parcours-fabrice.json"
  : scenario === "alexandre" ? "parcours-alexandre.json" : scenario === "pfa" ? "parcours-pfa.json" : scenario === "geely" ? "parcours-geely.json" : "parcours-demo.json";
const parcours = JSON.parse(readFileSync(join(import.meta.dirname, `../../fixtures/${fixture}`), "utf8"));
// Parcours accéléré pour l'essai. E2E_RYTHME=demo garde un rythme proche du réel (pour filmer une démonstration).
const rythmeDemo = process.env.E2E_RYTHME === "demo";
for (const e of parcours.etapes) {
  if (e.type === "question") Object.assign(e, rythmeDemo ? { compteARebours: 3, dureeMaxSec: 9, silenceArretSec: 3 } : { compteARebours: 2, dureeMaxSec: 8, silenceArretSec: 2 });
}
// Geely : un visiteur ne voit qu'une branche ; ici « coup d'œil » puis, après l'essai, la branche « essai » (3 + 3).
const nbQuestions = scenario === "geely" ? 6 : parcours.etapes.filter((e: any) => e.type === "question").length;

const port = 8790 + Math.floor(Math.random() * 100);
const serveur = await demarrerServeur(port);
const { code } = await preparer(parcours,
  scenario === "auto" ? { nom: "Démo Auto", couleurs: { principale: "#0F6E5A", fond: "#F4F6F5", texte: "#10231D" } } : scenario === "geely" ? { nom: "Geely" } : scenario === "pfa" ? { nom: "PFA" } : { nom: "Parlobox" },
  scenario === "auto" ? "Essai routier" : scenario === "fabrice" ? "Spécial Fabrice" : scenario === "alexandre" ? "Spécial Alexandre" : scenario === "pfa" ? "Fabrique de l'Innovation — Mondial 2026" : scenario === "geely" ? "Geely — concession" : "Démo Parlobox (neutre)");

const navigateur = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audio}`, "--autoplay-policy=no-user-gesture-required"],
});
// Format de référence : 16:9 paysage (écran de cabine). Le portrait est vérifié en fin de scénario.
const paysage = { width: 1280, height: 720 };
const contexte = await navigateur.newContext({
  viewport: paysage,
  ...(process.env.E2E_VIDEO ? { recordVideo: { dir: process.env.E2E_VIDEO, size: paysage } } : {}),
});
const page = await contexte.newPage();
const erreurs: string[] = [];
page.on("pageerror", (e: Error) => erreurs.push(e.message));
page.on("console", (m: any) => { if (m.type() === "error") erreurs.push(m.text()); });

const capture = (nom: string) => page.screenshot({ path: join(captures, `${scenario}-${nom}.png`) });
const touche = (t: string) => page.locator(".touche", { hasText: new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).first().click();
const bouton = (t: string) => page.getByRole("button", { name: t, exact: true }).click();
const cocher = (debut: string) => page.getByRole("checkbox", { name: new RegExp(`^${debut}`) }).click();

async function appairer() {
  await page.goto(`http://localhost:${port}/cabine/`);
  await page.getByText("Appairer cette cabine").waitFor();
  for (const c of code) await touche(c);
  await bouton("Appairer la cabine");
}

async function scenarioDemo() {
  await page.getByText("Une minute pour dire").waitFor();
  await page.waitForTimeout(1800); // les bulles arrivent une à une
  await capture("01-accueil");
  await bouton("Je me lance");
  await page.getByText("comment vous appelez-vous ?").waitFor();
  await touche("C");
  for (const c of "amille") await touche(c);
  await page.waitForTimeout(500);
  await page.getByText("E-mail, facultatif : pour retrouver vos vidéos et changer d'avis").waitFor();
  await capture("02-identification");
  await bouton("Continuer");
  await page.getByText("Comment ça marche").waitFor();
  await page.getByText("Merci Camille ! Avant de commencer").waitFor();
  // Le bouton reste grisé tant que l'accord obligatoire n'est pas donné.
  assert.equal(await page.getByRole("button", { name: "C'est parti" }).isDisabled(), true);
  await cocher("J'accepte que Parlobox");
  await cocher("J'accepte aussi");
  await page.waitForTimeout(800);
  await capture("03-consignes");
  await cocher("Flouter mon visage");
  await bouton("C'est parti");
  // Chaque question : le temps de lire (compte à rebours), puis l'enregistrement.
  const titres = parcours.etapes.filter((e: any) => e.type === "question").map((e: any) => e.titreCourt);
  for (const [i, titre] of titres.entries()) {
    const n = String(i + 1);
    await page.locator(".titre-court", { hasText: titre }).waitFor({ timeout: 30_000 });
    await page.locator("#compte:not([hidden])").waitFor();
    await page.waitForTimeout(300);
    await capture(`04-q${n}-a-lire`);
    await page.locator("#rec:not([hidden])").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    await capture(`05-q${n}-on-tourne`);
  }
  await page.getByText("Merci Camille, c'est dans la boîte !").waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1600);
  await capture("06-fin");
  // Plus de QR code propre à la session : un rappel renvoie au QR code affiché à l'extérieur de la cabine.
  await page.getByText("Scannez le QR code à l'extérieur de la cabine").waitFor();
  assert.equal(await page.locator(".ecran svg.qr").count(), 0, "pas de QR code sur l'écran de fin");
  if (process.env.E2E_VIDEO) return { sessions: 1, consentDiffusion: 1, prenom: "Camille" }; // film en 16:9 seulement
  // Portrait (écran tourné, futur format 9:16) : mise en page de l'accueil et d'une question.
  await page.setViewportSize({ width: 720, height: 1280 });
  await page.getByText("Une minute pour dire").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1800);
  await capture("07-accueil-portrait");
  await bouton("Je me lance");
  await touche("L"); await touche("é"); await touche("a");
  await bouton("Continuer");
  await cocher("J'accepte que Parlobox");
  await bouton("C'est parti");
  await page.locator("#rec:not([hidden])").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await capture("08-question-portrait");
  return { sessions: 2, consentDiffusion: 1, prenom: "Camille" };
}


/** Parlorama : clore la campagne de démo, la renommer, puis la supprimer avec toutes ses données. */
async function visiteSuppressionCampagne() {
  const admin = await contexte.newPage();
  admin.on("pageerror", (e: Error) => erreurs.push(`admin : ${e.message}`));
  await admin.setViewportSize({ width: 1440, height: 900 });
  const c = await db.prepare("SELECT id, nom FROM campagnes WHERE nom LIKE 'Démo Parlobox%'").first<any>();
  await admin.goto(`http://localhost:${port}/admin/#/campagnes/${c.id}`);
  await admin.getByRole("button", { name: "Clore la campagne" }).click();
  await admin.getByRole("button", { name: "Confirmer la clôture" }).click();
  await admin.getByRole("button", { name: "Renommer" }).click();
  await admin.getByLabel("Nom de la campagne").fill("Démo Parlobox (essai)");
  await admin.getByRole("button", { name: "Enregistrer" }).click();
  await admin.getByRole("heading", { name: "Démo Parlobox (essai)" }).waitFor();
  await admin.screenshot({ path: join(captures, "admin-20-campagne-close.png") });
  await admin.getByRole("button", { name: "Supprimer la campagne" }).click();
  await admin.getByRole("button", { name: "Confirmer : tout supprimer, vidéos comprises" }).click();
  await admin.getByRole("heading", { name: "Campagnes" }).waitFor();
  await admin.close();
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM campagnes WHERE id = ?").bind(c.id).first<any>()).n, 0, "campagne supprimée");
  assert.ok(![...objets.keys()].some((k) => k.startsWith(`campagnes/${c.id}/`)), "plus aucun fichier de la campagne");
}

/**
 * Page du QR code extérieur, sur téléphone : le visiteur saisit son e-mail, reçoit un lien, regarde une vidéo,
 * puis supprime ses réponses.
 */
async function visiteRetrait() {
  const s = await db.prepare("SELECT id FROM sessions ORDER BY cree_le LIMIT 1").first<any>();
  await db.prepare("UPDATE sessions SET email = 'camille@exemple.fr' WHERE id = ?").bind(s.id).run(); // e-mail donné à l'identification
  boiteEssai.length = 0;
  const tel = await navigateur.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await tel.newPage();
  p.on("pageerror", (e: Error) => erreurs.push(`retrait : ${e.message}`));
  const photo = (nom: string) => p.screenshot({ path: join(captures, `retrait-${nom}.png`) });
  await p.goto(`http://localhost:${port}/retrait/`);
  await p.getByLabel("Votre e-mail").fill("Camille@Exemple.fr");
  await photo("01-email");
  await p.getByRole("button", { name: "Recevoir mon lien" }).click();
  await p.getByRole("heading", { name: "C'est envoyé" }).waitFor();
  await photo("02-envoye");
  assert.equal(boiteEssai.length, 1, "un e-mail envoyé");
  const lien = /https?:\/\/\S+#acces=[\w-]+/.exec(boiteEssai[0]!.texte)?.[0] ?? "";
  assert.ok(lien.startsWith(`http://localhost:${port}/retrait/#acces=`), `lien d'accès : ${lien}`);
  await p.goto(lien);
  await p.getByRole("heading", { name: "Bonjour Camille" }).waitFor();
  await p.locator(".ecran-video").first().click();
  await p.locator(".ecran-video video").first().waitFor();
  await p.waitForTimeout(800);
  await photo("03-mes-videos");
  await p.getByRole("button", { name: "Supprimer ces réponses" }).click();
  await p.getByRole("heading", { name: "Vous confirmez ?" }).waitFor();
  await photo("04-confirmation");
  await p.getByRole("button", { name: "Oui, supprimer mes réponses" }).click();
  await p.getByRole("heading", { name: "Plus aucune vidéo" }).waitFor();
  await photo("05-termine");
  await tel.close();
  const apres = await db.prepare("SELECT retiree_le, email FROM sessions WHERE id = ?").bind(s.id).first<any>();
  assert.ok(apres.retiree_le, "session retirée par le visiteur");
  assert.equal(apres.email, null, "e-mail effacé");
  const restes = await db.prepare("SELECT COUNT(*) AS n FROM reponses WHERE session_id = ? AND (cle_source IS NOT NULL OR cle_miniature IS NOT NULL)").bind(s.id).first<any>();
  assert.equal(restes.n, 0, "vidéos et miniatures effacées");
  assert.ok(![...objets.keys()].some((k) => k.includes(s.id)), "plus aucun fichier de la session dans le stockage");
}

async function scenarioAuto() {
  await page.getByText("Votre avis compte").waitFor();
  await capture("01-accueil");
  await bouton("Commencer");
  await page.getByText("Comment vous appelez-vous ?").waitFor();
  await touche("C");
  for (const c of "amille") await touche(c);
  await capture("02-identification");
  await bouton("Continuer");
  await page.getByText("Avant de commencer").waitFor();
  await cocher("J'accepte que Démo Auto");
  await cocher("J'accepte aussi");
  await bouton("C'est parti");
  await page.getByText("Placez votre visage").waitFor();
  await cocher("Flouter mon visage");
  await page.waitForTimeout(600);
  await capture("03-cadrage");
  await bouton("Je suis prêt");
  await page.getByText("Quel modèle allez-vous essayer ?").waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "La berline" }).click();
  await page.getByText("Bon essai !").waitFor();
  await bouton("Je suis de retour");
  await page.getByText("Votre avis compte").waitFor();
  await bouton("Je reviens");
  await bouton("Camille");
  await page.getByText("Merci !").waitFor({ timeout: 60_000 });
  await capture("04-fin");
  return { sessions: 1, consentDiffusion: 1, prenom: "Camille" };
}

async function scenarioFabrice() {
  await page.getByText("la cabine sait tout").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.ambiance), "pop");
  await page.waitForTimeout(2200);
  await capture("01-accueil");
  await bouton("J'assume tout");
  await page.getByText("ton prénom ?").waitFor();
  await page.getByText("Ton prénom").first().waitFor(); // textes fixes au tutoiement
  await touche("F");
  for (const c of "abrice") await touche(c);
  await page.waitForTimeout(500);
  await capture("02-identification");
  await bouton("Continuer");
  await page.getByText("Bon, Fabrice, voici le deal.").waitFor();
  await cocher("J'accepte que Parlobox");
  await page.getByText("En savoir plus sur tes données").waitFor();
  assert.equal(await page.getByRole("checkbox", { name: /^J'accepte aussi/ }).count(), 0, "pas de diffusion publique");
  await page.waitForTimeout(1200);
  await capture("03-regles");
  await bouton("C'est parti");
  await page.getByText("ta chemise du jour").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(900);
  await capture("04-choix");
  await page.getByRole("button", { name: "Personne. Froissée, assumée." }).click();
  const titres = parcours.etapes.filter((e: any) => e.type === "question").map((e: any) => e.titreCourt);
  for (const [i, titre] of titres.entries()) {
    const n = String(i + 1);
    await page.locator(".titre-court", { hasText: titre }).waitFor({ timeout: 30_000 });
    await page.locator("#compte:not([hidden])").waitFor();
    await page.waitForTimeout(350);
    if (i === 0) assert.equal(await page.locator("#compte-lire").textContent(), "Prends le temps de lire.");
    await capture(`05-q${n}-a-lire`);
    await page.locator("#rec:not([hidden])").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    await capture(`06-q${n}-on-tourne`);
  }
  await page.getByText("Merci Fabrice, le dossier est clos.").waitFor({ timeout: 90_000 });
  await page.waitForTimeout(2500);
  await capture("07-fin");
  // Portrait (9:16) : accueil et une question.
  await page.setViewportSize({ width: 720, height: 1280 });
  await page.getByText("la cabine sait tout").waitFor({ timeout: 25_000 });
  await page.waitForTimeout(2200);
  await capture("08-accueil-portrait");
  await bouton("J'assume tout");
  await touche("F"); await touche("a"); await touche("b");
  await bouton("Continuer");
  await cocher("J'accepte que Parlobox");
  await bouton("C'est parti");
  await page.getByRole("button", { name: "Par moi, évidemment" }).click();
  await page.locator("#rec:not([hidden])").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await capture("09-question-portrait");
  return { sessions: 2, consentDiffusion: 0, prenom: "Fabrice" };
}

async function scenarioAlexandre() {
  await page.getByText("vent de face").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.ambiance), "marine");
  assert.equal(await page.locator(".visuel-accueil").count(), 1, "visuel de l'accueil affiché");
  await page.waitForTimeout(2400);
  await capture("01-accueil");
  await bouton("Je largue les amarres");
  await page.getByText("Pour le livre de bord").waitFor();
  await touche("A");
  for (const c of "lexandre") await touche(c);
  await page.waitForTimeout(500);
  await capture("02-identification");
  await bouton("Continuer");
  await page.getByText("Bon, Alexandre, voici les consignes").waitFor();
  await cocher("J'accepte que Parlobox");
  await page.waitForTimeout(1200);
  await capture("03-regles");
  await bouton("C'est parti");
  const titres = parcours.etapes.filter((e: any) => e.type === "question").map((e: any) => e.titreCourt);
  for (const [i, titre] of titres.entries()) {
    const n = String(i + 1);
    await page.locator(".titre-court", { hasText: titre }).waitFor({ timeout: 30_000 });
    await page.locator("#compte:not([hidden])").waitFor();
    await page.waitForTimeout(400);
    await capture(`04-q${n}-a-lire`);
    await page.locator("#rec:not([hidden])").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    await capture(`05-q${n}-on-tourne`);
  }
  await page.getByText("Bien navigué, Alexandre.").waitFor({ timeout: 90_000 });
  await page.waitForTimeout(2500);
  await capture("06-fin");
  await page.setViewportSize({ width: 720, height: 1280 });
  await page.getByText("vent de face").waitFor({ timeout: 25_000 });
  await page.waitForTimeout(2400);
  await capture("07-accueil-portrait");
  await bouton("Je largue les amarres");
  await touche("A"); await touche("l"); await touche("e");
  await bouton("Continuer");
  await cocher("J'accepte que Parlobox");
  await bouton("C'est parti");
  await page.locator("#rec:not([hidden])").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await capture("08-question-portrait");
  return { sessions: 2, consentDiffusion: 0, prenom: "Alexandre" };
}

async function scenarioPfa() {
  await page.getByText("Ton avis compte.").waitFor();
  assert.equal(await page.locator(".visuel-accueil").count(), 1, "visuel de l'accueil affiché");
  // Polices de la Fabrique, hébergées par la plateforme et bien chargées.
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.fonts.check('700 40px "Barlow Condensed"')), true, "Barlow Condensed chargée");
  assert.equal(await page.evaluate(() => document.fonts.check('400 20px "Barlow"')), true, "Barlow chargée");
  await page.waitForTimeout(2400);
  await capture("01-accueil");
  await bouton("Je me lance");
  await page.getByText("ton prénom ?").waitFor();
  assert.equal(await page.getByText("E-mail").count(), 0, "prénom seul : pas d'e-mail demandé");
  await touche("I");
  for (const c of "nès") await touche(c);
  await page.waitForTimeout(500);
  await capture("02-identification");
  await bouton("Continuer");
  await page.getByText("Merci Inès !").waitFor();
  assert.equal(await page.getByRole("checkbox", { name: /^J'accepte aussi/ }).count(), 0, "pas de diffusion publique proposée");
  await cocher("J'accepte que PFA");
  await page.waitForTimeout(1200);
  await capture("03-regles");
  await bouton("C'est parti");
  await page.getByText("Place ton visage dans l'ovale").waitFor();
  await page.waitForTimeout(1200);
  await capture("03b-cadrage");
  await bouton("Je suis prêt");
  const titres = parcours.etapes.filter((e: any) => e.type === "question").map((e: any) => e.titreCourt);
  for (const [i, titre] of titres.entries()) {
    const n = String(i + 1);
    await page.locator(".titre-court", { hasText: titre }).waitFor({ timeout: 30_000 });
    await page.locator("#compte:not([hidden])").waitFor();
    await page.waitForTimeout(400);
    await capture(`04-q${n}-a-lire`);
    await page.locator("#rec:not([hidden])").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    await capture(`05-q${n}-on-tourne`);
  }
  await page.getByText("Merci Inès !").waitFor({ timeout: 90_000 });
  await page.waitForTimeout(2500);
  await capture("06-fin");
  await page.setViewportSize({ width: 720, height: 1280 });
  await page.getByText("Ton avis compte.").waitFor({ timeout: 25_000 });
  await page.waitForTimeout(2400);
  await capture("07-accueil-portrait");
  await bouton("Je me lance");
  await touche("L"); await touche("o"); await touche("u");
  await bouton("Continuer");
  await cocher("J'accepte que PFA");
  await bouton("C'est parti");
  await bouton("Je suis prêt");
  await page.locator("#rec:not([hidden])").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await capture("08-question-portrait");
  return { sessions: 2, consentDiffusion: 0, prenom: "Inès" };
}

async function scenarioGeely() {
  const question = async (titre: string, nom: string) => {
    await page.locator(".titre-court", { hasText: titre }).waitFor({ timeout: 30_000 });
    await page.locator("#compte:not([hidden])").waitFor();
    await page.waitForTimeout(400);
    await capture(`${nom}-a-lire`);
    await page.locator("#rec:not([hidden])").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    await capture(`${nom}-on-tourne`);
  };
  const option = (libelle: string) => page.locator(".option", { hasText: libelle }).first().click();
  await page.getByText("Vous avez 2 minutes ?").waitFor();
  await page.waitForTimeout(2200);
  await capture("01-accueil");
  await bouton("Allez, je me lance");
  await page.getByText("On commence simple").waitFor();
  await touche("C");
  for (const c of "amille") await touche(c);
  await page.waitForTimeout(500);
  await capture("02-prenom");
  await bouton("Continuer");
  await page.getByText("Avant de tourner").waitFor();
  await cocher("J'accepte que Geely");
  await cocher("J'accepte aussi");
  await page.waitForTimeout(900);
  await capture("03-consentement");
  await bouton("C'est parti");
  await page.getByText("Placez votre visage").waitFor();
  await page.waitForTimeout(800);
  await capture("04-cadrage");
  await bouton("Je suis prêt");
  await page.getByText("vous en êtes où avec Geely").waitFor();
  await page.waitForTimeout(900);
  await capture("05-aiguillage");
  await option("J'ai jeté un œil");
  await page.getByText("Laquelle vous a fait de l'œil").waitFor();
  await page.waitForTimeout(900);
  await capture("06-modele");
  await option("Starray EM-i");
  await page.getByText("Geely, vous connaissiez").waitFor();
  await page.waitForTimeout(700);
  await capture("07-qualification");
  await option("De nom");
  await question("Premier regard", "08-a1");
  await question("Le petit doute", "09-a2");
  await question("Le déclic", "10-a3");
  await page.getByText("Et si la suite se passait au volant").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(700);
  await capture("11-essai");
  await option("Je vais l'essayer");
  await page.getByText("Bon essai, Camille").waitFor();
  await page.waitForTimeout(900);
  await capture("12-pause");
  await bouton("À tout à l'heure");
  await page.getByText("Vous avez 2 minutes ?").waitFor();
  await bouton("Je reviens");
  await page.waitForTimeout(500);
  await capture("13-reprise");
  await bouton("Camille");
  await question("Le moment « ah, quand même »", "14-b1");
  await question("Le bémol", "15-b2");
  await question("À un ami", "16-b3");
  await page.getByText("Merci Camille, c'est dans la boîte.").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1600);
  await capture("17-fin");
  // Choix enregistrés, dans la session du visiteur.
  for (let i = 0; i < 40; i++) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM choix").first<any>();
    if (n.n >= 4) break;
    await page.waitForTimeout(250);
  }
  const choix = await db.prepare("SELECT etape_id, option_id FROM choix ORDER BY etape_id").all<any>();
  assert.deepEqual(Object.fromEntries(choix.results.map((c: any) => [c.etape_id, c.option_id])),
    { aiguillage: "coup-oeil", "modele-a": "starray", "connu-a": "de-nom", "essai-a": "essayer" }, "choix enregistrés");
  if (process.env.E2E_VIDEO) return { sessions: 1, consentDiffusion: 1, prenom: "Camille" };
  // Portrait (futur écran 9:16) : accueil et aiguillage.
  await page.setViewportSize({ width: 720, height: 1280 });
  await page.getByText("Vous avez 2 minutes ?").waitFor({ timeout: 25_000 });
  await page.waitForTimeout(2000);
  await capture("18-accueil-portrait");
  return { sessions: 1, consentDiffusion: 1, prenom: "Camille" };
}

/** Visite de l'espace de gestion avec les réponses que le scénario vient d'enregistrer. */
async function visiteAdmin() {
  const admin = await contexte.newPage();
  admin.on("pageerror", (e: Error) => erreurs.push(`admin : ${e.message}`));
  await admin.setViewportSize(process.env.E2E_VIDEO ? { width: 1280, height: 720 } : { width: 1440, height: 900 });
  const pause = (ms: number) => (process.env.E2E_VIDEO ? admin.waitForTimeout(ms) : Promise.resolve());
  const photo = async (nom: string) => { await admin.screenshot({ path: join(captures, `admin-${nom}.png`) }); await pause(2200); };
  // Une réponse « d'avant les miniatures » : Parlorama doit fabriquer sa vignette.
  const sansMiniature = await db.prepare("SELECT r.id, r.cle_miniature FROM reponses r ORDER BY r.cree_le LIMIT 1").first<any>();
  assert.ok(sansMiniature.cle_miniature, "la cabine a envoyé une miniature");
  await db.prepare("UPDATE reponses SET cle_miniature = NULL WHERE id = ?").bind(sansMiniature.id).run();
  objets.delete(sansMiniature.cle_miniature);
  await admin.goto(`http://localhost:${port}/admin/`);
  await admin.getByRole("heading", { name: "Tableau de bord" }).waitFor();
  await photo("01-tableau-de-bord");
  await admin.getByLabel("Menu").getByRole("link", { name: "Campagnes" }).click();
  await admin.getByRole("heading", { name: "Campagnes" }).waitFor();
  await photo("02-campagnes");
  await admin.locator("td a").first().click();
  await admin.locator(".session").first().waitFor();
  for (let i = 0; i < 40; i++) {
    const r = await db.prepare("SELECT cle_miniature FROM reponses WHERE id = ?").bind(sansMiniature.id).first<any>();
    if (r.cle_miniature) break;
    await admin.waitForTimeout(250);
  }
  assert.ok((await db.prepare("SELECT cle_miniature FROM reponses WHERE id = ?").bind(sansMiniature.id).first<any>()).cle_miniature, "miniature rattrapée par Parlorama");
  await admin.waitForFunction(() => document.querySelectorAll(".ecran-video .vignette").length >= 5 && [...document.querySelectorAll<HTMLImageElement>(".ecran-video .vignette")].every((i) => i.complete && i.naturalWidth > 0));
  await photo("03-campagne-reponses");
  await admin.locator(".ecran-video").first().click();
  await admin.locator(".ecran-video video").first().waitFor();
  await admin.waitForTimeout(1500);
  await photo("04-lecture-video");
  const titre = parcours.etapes.find((e: any) => e.type === "question" && e.pistes)?.titreCourt ?? "";
  await admin.getByRole("button", { name: titre, exact: true }).click();
  await admin.locator(".question-texte").waitFor();
  await photo("05-reponses-par-question");
  await admin.getByRole("tab", { name: "Parcours" }).click();
  await admin.locator(".editeur-etapes").waitFor();
  await photo("06-parcours");
  await admin.getByRole("tab", { name: "Consentement" }).click();
  await admin.getByText("Usage interne (obligatoire)").waitFor();
  await photo("07-consentement");
  await admin.getByRole("link", { name: "Cabines" }).click();
  await admin.getByRole("button", { name: "Nouvelle cabine" }).click();
  await admin.getByLabel("Nom de la cabine").fill("Tablette salon 2");
  await admin.getByRole("button", { name: "Créer la cabine" }).click();
  await admin.locator(".code").first().waitFor();
  // Renommer puis supprimer la nouvelle cabine (jamais utilisée).
  const nouvelle = admin.locator("article.cabine", { hasText: "Tablette salon 2" });
  await nouvelle.getByRole("button", { name: "Renommer" }).click();
  await nouvelle.getByLabel("Nouveau nom pour Tablette salon 2").fill("Salon de Lyon");
  await nouvelle.getByRole("button", { name: "Enregistrer" }).click();
  await admin.locator("article.cabine", { hasText: "Salon de Lyon" }).waitFor();
  await photo("08-cabines");
  const lyon = admin.locator("article.cabine", { hasText: "Salon de Lyon" });
  await lyon.getByRole("button", { name: "Supprimer" }).click();
  await lyon.getByRole("button", { name: "Confirmer la suppression" }).click();
  await admin.getByText("Cabine supprimée.").waitFor();
  assert.equal(await admin.locator("article.cabine", { hasText: "Salon de Lyon" }).count(), 0);
  // La tablette démo, déjà utilisée, propose aussi la suppression (en retrait) : on ne la touche pas.
  await admin.getByRole("button", { name: "Nouvelle cabine" }).click();
  await admin.getByLabel("Nom de la cabine").fill("Tablette salon 2");
  await admin.getByRole("button", { name: "Créer la cabine" }).click();
  await admin.locator("article.cabine", { hasText: "Tablette salon 2" }).waitFor();
  await admin.getByRole("link", { name: "Clients" }).click();
  await admin.getByRole("button", { name: "Nouveau client" }).click();
  await admin.getByLabel("Nom de marque").fill("Maison Lumière");
  await admin.getByLabel("Raison sociale").fill("Maison Lumière SAS (fictive)");
  await admin.getByLabel("Contact RGPD").fill("dpo@maison-lumiere.test");
  await admin.getByRole("button", { name: "Créer le client" }).click();
  await admin.getByRole("cell", { name: "Maison Lumière", exact: true }).waitFor();
  await photo("09-clients");
  await admin.getByRole("link", { name: "Comptes" }).click();
  await admin.getByRole("button", { name: "Nouveau compte" }).click();
  await admin.getByLabel("E-mail").fill("marketing@maison-lumiere.test");
  await admin.locator("select[name=client_id]").selectOption({ label: "Maison Lumière" });
  await admin.getByRole("button", { name: "Créer le compte" }).click();
  await admin.getByRole("cell", { name: "marketing@maison-lumiere.test" }).waitFor();
  await photo("10-comptes");
  await admin.getByRole("link", { name: "Journal" }).click();
  await admin.getByRole("cell", { name: "Vidéo visionnée" }).first().waitFor();
  await photo("11-journal");
  await visiteEdition(admin, photo);
  if (process.env.E2E_PARLOMIX) await visiteParlomix(admin, photo);
  await admin.close();
}

/** Modifications : fiche client et logo, rôle d'un compte, éditeur de parcours et aperçu, actions sur un visiteur. */
async function visiteEdition(admin: any, photo: (nom: string) => Promise<void>) {
  // Fiche client : couleurs et logo.
  await admin.getByRole("link", { name: "Clients" }).click();
  await admin.getByRole("row", { name: /Maison Lumière/ }).getByRole("button", { name: "Modifier" }).click();
  await admin.locator("form input[type=file]").setInputFiles(process.env.E2E_LOGO ?? "/tmp/claude-0/e2e/logo-essai.png");
  await admin.getByRole("button", { name: "Enregistrer" }).click();
  await admin.locator("img.logo-client.petit").first().waitFor();
  await photo("15-client-logo");
  // Rôle d'un compte.
  await admin.getByRole("link", { name: "Comptes" }).click();
  await admin.getByLabel("Rôle de marketing@maison-lumiere.test").selectOption("validateur_client");
  await admin.getByRole("button", { name: "Enregistrer" }).click();
  await admin.getByText("Rôle modifié").waitFor();
  // Nouvelle campagne en brouillon et éditeur de parcours.
  await admin.getByLabel("Menu").getByRole("link", { name: "Campagnes" }).click();
  await admin.getByRole("button", { name: "Nouvelle campagne" }).click();
  await admin.getByLabel("Client").selectOption({ label: "Maison Lumière" });
  await admin.getByLabel("Nom de la campagne").fill("Printemps en boutique");
  await admin.getByRole("button", { name: "Créer la campagne" }).click();
  await admin.getByRole("heading", { name: "Printemps en boutique" }).waitFor();
  await admin.getByRole("tab", { name: "Parcours" }).click();
  await admin.getByRole("button", { name: "Parcours neutre Parlobox (démo)" }).click();
  await admin.getByText("Parcours valide").waitFor();
  await admin.getByRole("button", { name: /Le coup de cœur/ }).click();
  await admin.locator("#ed-q-coup-de-coeur-texte").fill("Qu'est-ce qui vous a fait sourire en boutique ?");
  await admin.locator("summary", { hasText: "Ajouter une étape" }).click();
  await admin.locator(".type-etape strong", { hasText: /^Question$/ }).click();
  await admin.getByText("Parcours valide").waitFor();
  await photo("16-editeur-parcours");
  // Aperçu dans la vraie cabine.
  const [cabine] = await Promise.all([admin.waitForEvent("popup"), admin.getByRole("button", { name: "Aperçu dans la cabine" }).click()]);
  await cabine.setViewportSize({ width: 1280, height: 720 });
  await cabine.getByText("Une minute pour dire").waitFor();
  await cabine.getByText("Aperçu : rien n'est enregistré").waitFor();
  await cabine.waitForTimeout(1800);
  await cabine.screenshot({ path: join(captures, "admin-17-apercu-cabine.png") });
  await cabine.close();
  await admin.getByRole("button", { name: "Enregistrer la version" }).click();
  await admin.getByText("Nouvelle version du parcours enregistrée").waitFor();
  const v = await db.prepare("SELECT p.config FROM parcours_versions p JOIN campagnes c ON c.parcours_version_id = p.id WHERE c.nom = 'Printemps en boutique'").first<any>();
  const config = JSON.parse(v.config);
  assert.equal(config.etapes.filter((e: any) => e.type === "question").length, 6, "5 questions du modèle + 1 ajoutée");
  assert.ok(config.etapes.some((e: any) => e.texte === "Qu'est-ce qui vous a fait sourire en boutique ?"));
  // Actions sur un visiteur dans la campagne de démo : retrait de l'accord de diffusion, recherche.
  await admin.getByLabel("Menu").getByRole("link", { name: "Campagnes" }).click();
  await admin.getByRole("link", { name: "Démo Parlobox (neutre)" }).click();
  await admin.getByLabel("Rechercher un prénom").fill("cam");
  await admin.locator(".session").first().waitFor();
  assert.equal(await admin.locator(".session").count(), 1);
  await admin.getByRole("button", { name: "Retirer l'accord de diffusion" }).click();
  await admin.getByRole("button", { name: "Confirmer : usage interne seulement" }).click();
  await admin.getByText("Accord de diffusion retiré").waitFor();
  await admin.getByLabel("Rechercher un prénom").fill("cam");
  await admin.locator(".session", { hasText: "Usage interne seulement" }).waitFor();
  await photo("18-reponses-actions");
}

/** Parlomix : un montage par personne (16:9 et 9:16) et un montage par question, vérifiés avec ffprobe. */
async function visiteParlomix(admin: any, photo: (nom: string) => Promise<void>) {
  await admin.getByLabel("Menu").getByRole("link", { name: "Campagnes" }).click();
  await admin.getByRole("link", { name: "Démo Parlobox (neutre)" }).click();
  await admin.getByRole("tab", { name: "Parlomix" }).click();
  await admin.getByRole("heading", { name: "Créer un Parlomix" }).waitFor();
  // Par personne : Camille, qui a répondu aux cinq questions.
  const valeur = await admin.locator("select option", { hasText: /^Camille/ }).first().getAttribute("value");
  await admin.locator("select").first().selectOption(valeur);
  await photo("12-parlomix-creation");
  await admin.getByRole("button", { name: "Créer le Parlomix" }).click();
  await admin.locator(".apercu-parlomix").waitFor();
  await admin.waitForTimeout(6000);
  await photo("13-parlomix-montage-en-cours");
  await admin.getByText("Parlomix prêts : 16:9 et 9:16.").waitFor({ timeout: 240_000 });
  await admin.getByRole("button", { name: "Par question" }).click();
  await admin.locator("label.case-admin", { hasText: "9:16" }).locator("input").uncheck();
  await admin.getByRole("button", { name: "Créer le Parlomix" }).click();
  await admin.getByText("Parlomix prêt : 16:9.").waitFor({ timeout: 240_000 });
  await admin.locator(".parlomix-liste .ecran-video").first().click();
  await admin.locator(".parlomix-liste video").first().waitFor();
  await admin.waitForTimeout(2500);
  await admin.waitForFunction(() => document.querySelectorAll(".parlomix-liste .vignette").length >= 2);
  await photo("14-parlomix-liste");
  const films = await db.prepare("SELECT id, type, format, cle, cle_miniature, type_mime, duree_ms, nb_extraits FROM parlomix WHERE statut = 'pret' ORDER BY cree_le").all<any>();
  assert.equal(films.results.length, 3, "trois Parlomix prêts");
  for (const f of films.results) assert.ok(f.cle_miniature && objets.has(f.cle_miniature), `${f.type} ${f.format} : vignette`);
  assert.equal(films.results[0].nb_extraits, nbQuestions, "le Parlomix de Camille monte ses cinq réponses");
  for (const f of films.results) {
    const fichier = join(captures, `parlomix-${f.type}-${f.format.replace(":", "x")}.${f.type_mime === "video/mp4" ? "mp4" : "webm"}`);
    writeFileSync(fichier, objets.get(f.cle)!);
    const flux = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "csv=p=0", fichier]).toString().trim().split("\n");
    const volume = spawnSync("ffmpeg", ["-hide_banner", "-i", fichier, "-af", "volumedetect", "-f", "null", "-"]).stderr.toString();
    // Durée réelle : on décode tout (les fichiers de MediaRecorder n'annoncent pas toujours leur durée).
    const decode = spawnSync("ffmpeg", ["-hide_banner", "-i", fichier, "-f", "null", "-"]).stderr.toString();
    const temps = [...decode.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
    const dureeReelle = temps ? Number(temps[1]) * 3600 + Number(temps[2]) * 60 + Number(temps[3]) : 0;
    bilanParlomix.push({ type: f.type, format: f.format, mime: f.type_mime, extraits: f.nb_extraits, prevu_s: f.duree_ms / 1000, reel_s: dureeReelle, flux, volume_max: /max_volume: (\S+ dB)/.exec(volume)?.[1] });
    assert.ok(flux.some((x: string) => x.startsWith("audio")), `${f.type} ${f.format} : piste son`);
    assert.ok(flux.some((x: string) => x.startsWith(f.format === "9:16" ? "video,720,1280" : "video,1280,720")), `${f.type} ${f.format} : dimensions`);
    assert.ok(Math.abs(dureeReelle - f.duree_ms / 1000) < 3, `${f.type} ${f.format} : durée proche du plan`);
  }
}
const bilanParlomix: any[] = [];

/** Campagne habillée : choix des visiteurs dans Parlorama, éditeur, Parlomix aux couleurs de la campagne (vérifié avec ffprobe). */
async function visiteAdminGeely() {
  const admin = await contexte.newPage();
  admin.on("pageerror", (e: Error) => erreurs.push(`admin : ${e.message}`));
  await admin.setViewportSize({ width: 1440, height: 900 });
  const photo = (nom: string) => admin.screenshot({ path: join(captures, `geely-admin-${nom}.png`) });
  await admin.goto(`http://localhost:${port}/admin/`);
  await admin.getByRole("heading", { name: "Tableau de bord" }).waitFor();
  await admin.getByLabel("Menu").getByRole("link", { name: "Campagnes" }).click();
  await admin.getByRole("link", { name: "Geely — concession" }).click();
  await admin.getByRole("heading", { name: "Ce que les visiteurs ont choisi" }).waitFor();
  await admin.locator(".choix-visiteur .pastille", { hasText: "Starray EM-i" }).first().waitFor();
  await photo("01-reponses-choix");
  await admin.getByRole("tab", { name: "Parcours" }).click();
  await admin.locator(".editeur-etapes").waitFor();
  await admin.getByRole("button", { name: /Premier regard/ }).click();
  await admin.getByText("Fond de l'écran").waitFor();
  await photo("02-editeur-habillage");
  await admin.getByRole("tab", { name: "Parlomix" }).click();
  await admin.getByRole("heading", { name: "Créer un Parlomix" }).waitFor();
  await admin.getByRole("button", { name: "Créer le Parlomix" }).click();
  await admin.locator(".apercu-parlomix").waitFor();
  // L'ouverture (fond et modèle), puis une transition.
  await admin.waitForFunction(() => /Montage/.test(document.querySelector(".suivi-parlomix strong")?.textContent ?? ""), null, { timeout: 60_000 });
  await admin.waitForTimeout(1400);
  await admin.locator(".apercu-parlomix").screenshot({ path: join(captures, "geely-parlomix-ouverture.png") });
  await admin.waitForTimeout(8200);
  await admin.locator(".apercu-parlomix").screenshot({ path: join(captures, "geely-parlomix-suite.png") });
  await admin.getByText("Parlomix prêts : 16:9 et 9:16.").waitFor({ timeout: 300_000 });
  await admin.waitForFunction(() => document.querySelectorAll(".parlomix-liste .vignette").length >= 2);
  await photo("03-parlomix-liste");
  const films = await db.prepare("SELECT format, cle, type_mime, duree_ms, nb_extraits, plan FROM parlomix WHERE statut = 'pret' ORDER BY cree_le").all<any>();
  assert.equal(films.results.length, 2, "deux Parlomix prêts");
  for (const f of films.results) {
    const plan = JSON.parse(f.plan);
    assert.equal(plan.theme.policeTitres, "Michroma", "le plan garde l'habillage");
    assert.equal(plan.sequences[0].visuel, "starray", "ouverture : le modèle choisi par Camille");
    assert.equal(f.nb_extraits, nbQuestions);
    const fichier = join(captures, `geely-parlomix-${f.format.replace(":", "x")}.${f.type_mime === "video/mp4" ? "mp4" : "webm"}`);
    writeFileSync(fichier, objets.get(f.cle)!);
    const flux = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "csv=p=0", fichier]).toString().trim().split("\n");
    assert.ok(flux.some((x: string) => x.startsWith("audio")), `${f.format} : piste son`);
    assert.ok(flux.some((x: string) => x.startsWith(f.format === "9:16" ? "video,720,1280" : "video,1280,720")), `${f.format} : dimensions`);
    // Une image de la carte d'ouverture, pour la contrôler à l'œil.
    spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1.2", "-i", fichier, "-frames:v", "1", join(captures, `geely-parlomix-${f.format.replace(":", "x")}-ouverture.png`)]);
    bilanParlomix.push({ format: f.format, mime: f.type_mime, extraits: f.nb_extraits, prevu_s: f.duree_ms / 1000, flux });
  }
  await admin.close();
}

try {
  await appairer();
  const attendu = scenario === "auto" ? await scenarioAuto() : scenario === "fabrice" ? await scenarioFabrice()
    : scenario === "alexandre" ? await scenarioAlexandre() : scenario === "pfa" ? await scenarioPfa() : scenario === "geely" ? await scenarioGeely() : await scenarioDemo();

  // La file d'envoi se vide.
  const videosRecues = () => [...objets.keys()].filter((k) => k.endsWith(".webm")).length;
  for (let i = 0; i < 60 && videosRecues() < nbQuestions; i++) await page.waitForTimeout(250);
  await page.waitForTimeout(1500);
  const sessions = await db.prepare("SELECT prenom, consent_diffusion FROM sessions ORDER BY cree_le").all<any>();
  const reponses = await db.prepare("SELECT etape_id, son_present, duree_ms, cle_source FROM reponses ORDER BY cree_le").all<any>();
  assert.ok(sessions.results.length >= 1, "au moins une session");
  assert.equal(sessions.results[0].prenom, attendu.prenom);
  assert.equal(sessions.results[0].consent_diffusion, attendu.consentDiffusion);
  const premieres = reponses.results.slice(0, nbQuestions);
  assert.equal(premieres.length, nbQuestions, `${nbQuestions} réponses pour le premier visiteur`);

  const bilan = [];
  for (const r of premieres) {
    const fichier = join(captures, `${scenario}-${r.etape_id}.webm`);
    writeFileSync(fichier, objets.get(r.cle_source)!);
    const flux = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", fichier]).toString().trim().split("\n");
    const image = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", fichier]).toString().trim();
    const volume = spawnSync("ffmpeg", ["-hide_banner", "-i", fichier, "-af", "volumedetect", "-f", "null", "-"]).stderr.toString();
    bilan.push({ etape: r.etape_id, image, duree_ms: r.duree_ms, son_detecte_tablette: r.son_present, flux, volume_max: /max_volume: (\S+ dB)/.exec(volume)?.[1] });
  }
  console.log(JSON.stringify({ scenario, erreurs, bilan }, null, 2));
  for (const b of bilan) {
    assert.ok(b.flux.some((f: string) => f.startsWith("opus")), `${b.etape} : piste son Opus présente`);
    assert.equal(b.son_detecte_tablette, 1, `${b.etape} : voix détectée par la tablette`);
    const [l, ht] = b.image.split(",").map(Number);
    assert.ok(l! * 3 === ht! * 4 && l! >= 960, `${b.etape} : image filmée en 4:3 (paysage), reçu ${b.image}`);
  }
  assert.deepEqual(erreurs, [], "aucune erreur dans la page");
  if (process.env.E2E_ADMIN) await (scenario === "geely" ? visiteAdminGeely() : visiteAdmin());
  if (scenario === "demo" && !process.env.E2E_VIDEO) await visiteRetrait();
  if (scenario === "demo" && process.env.E2E_ADMIN && !process.env.E2E_VIDEO) await visiteSuppressionCampagne();
  if (bilanParlomix.length) console.log(JSON.stringify({ parlomix: bilanParlomix }, null, 2));
  assert.deepEqual(erreurs, [], "aucune erreur dans la page");
  console.log(JSON.stringify({ ok: true, scenario }));
} catch (e) {
  await capture("zz-echec").catch(() => {});
  console.log(JSON.stringify({ ok: false, scenario, erreur: String(e), erreurs }, null, 2));
  process.exitCode = 1;
} finally {
  await contexte.close(); // termine l'enregistrement vidéo éventuel
  await navigateur.close();
  serveur.close();
}
