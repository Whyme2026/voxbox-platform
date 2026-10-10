// Essais de bout en bout de la cabine, dans un vrai Chrome sans écran avec caméra et micro simulés.
// Deux scénarios :
//  - demo : parcours neutre Parlopop (accueil, consignes et accord, 5 questions, fin), flou activé ;
//  - auto : parcours automobile (prénom, consentement, cadrage, choix, pause avant/après, reprise).
// Chaque scénario vérifie ensuite que toutes les vidéos reçues contiennent une piste son et de la voix.
//
// node test/e2e/parcours.e2e.ts <fichier-audio.wav> <dossier-captures> [demo|auto]
// Nécessite Playwright et Chromium (variables PLAYWRIGHT_MODULE et PLAYWRIGHT_BROWSERS_PATH).

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import assert from "node:assert/strict";
import { demarrerServeur, preparer, objets, db } from "./serveur.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "/opt/npm-tools/node_modules/playwright");

const [audio, captures = "captures", scenario = "demo"] = process.argv.slice(2);
if (!audio) throw new Error("Fichier audio de test manquant");
mkdirSync(captures, { recursive: true });

const fixture = scenario === "auto" ? "parcours-automobile.json" : "parcours-demo.json";
const parcours = JSON.parse(readFileSync(join(import.meta.dirname, `../../fixtures/${fixture}`), "utf8"));
// Parcours accéléré pour l'essai. E2E_RYTHME=demo garde un rythme proche du réel (pour filmer une démonstration).
const rythmeDemo = process.env.E2E_RYTHME === "demo";
for (const e of parcours.etapes) {
  if (e.type === "question") Object.assign(e, rythmeDemo ? { compteARebours: 3, dureeMaxSec: 9, silenceArretSec: 3 } : { compteARebours: 2, dureeMaxSec: 8, silenceArretSec: 2 });
}
const nbQuestions = parcours.etapes.filter((e: any) => e.type === "question").length;

const port = 8790 + Math.floor(Math.random() * 100);
const serveur = await demarrerServeur(port);
const { code } = await preparer(parcours,
  scenario === "auto" ? { nom: "Démo Auto", couleurs: { principale: "#0F6E5A", fond: "#F4F6F5", texte: "#10231D" } } : { nom: "Parlopop" },
  scenario === "auto" ? "Essai routier" : "Démo Parlopop (neutre)");

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
  await capture("02-identification");
  await bouton("Continuer");
  await page.getByText("Comment ça marche").waitFor();
  await page.getByText("Merci Camille ! Avant de commencer").waitFor();
  // Le bouton reste grisé tant que l'accord obligatoire n'est pas donné.
  assert.equal(await page.getByRole("button", { name: "C'est parti" }).isDisabled(), true);
  await cocher("J'accepte que Parlopop");
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
  if (process.env.E2E_VIDEO) return { sessions: 1, consentDiffusion: 1, prenom: "Camille" }; // film en 16:9 seulement
  // Portrait (écran tourné, futur format 9:16) : mise en page de l'accueil et d'une question.
  await page.setViewportSize({ width: 720, height: 1280 });
  await page.getByText("Une minute pour dire").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1800);
  await capture("07-accueil-portrait");
  await bouton("Je me lance");
  await touche("L"); await touche("é"); await touche("a");
  await bouton("Continuer");
  await cocher("J'accepte que Parlopop");
  await bouton("C'est parti");
  await page.locator("#rec:not([hidden])").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await capture("08-question-portrait");
  return { sessions: 2, consentDiffusion: 1, prenom: "Camille" };
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

/** Visite de l'espace de gestion avec les réponses que le scénario vient d'enregistrer. */
async function visiteAdmin() {
  const admin = await contexte.newPage();
  admin.on("pageerror", (e: Error) => erreurs.push(`admin : ${e.message}`));
  await admin.setViewportSize(process.env.E2E_VIDEO ? { width: 1280, height: 720 } : { width: 1440, height: 900 });
  const pause = (ms: number) => (process.env.E2E_VIDEO ? admin.waitForTimeout(ms) : Promise.resolve());
  const photo = async (nom: string) => { await admin.screenshot({ path: join(captures, `admin-${nom}.png`) }); await pause(2200); };
  await admin.goto(`http://localhost:${port}/admin/`);
  await admin.getByRole("heading", { name: "Tableau de bord" }).waitFor();
  await photo("01-tableau-de-bord");
  await admin.getByRole("link", { name: "Campagnes", exact: true }).click();
  await admin.getByRole("heading", { name: "Campagnes" }).waitFor();
  await photo("02-campagnes");
  await admin.locator("td a").first().click();
  await admin.locator(".session").first().waitFor();
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
  await admin.getByRole("link", { name: "Campagnes", exact: true }).click();
  await admin.getByRole("button", { name: "Nouvelle campagne" }).click();
  await admin.getByLabel("Client").selectOption({ label: "Maison Lumière" });
  await admin.getByLabel("Nom de la campagne").fill("Printemps en boutique");
  await admin.getByRole("button", { name: "Créer la campagne" }).click();
  await admin.getByRole("heading", { name: "Printemps en boutique" }).waitFor();
  await admin.getByRole("tab", { name: "Parcours" }).click();
  await admin.getByRole("button", { name: "Parcours neutre Parlopop (démo)" }).click();
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
  await admin.getByRole("link", { name: "Campagnes", exact: true }).click();
  await admin.getByRole("link", { name: "Démo Parlopop (neutre)" }).click();
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
  await admin.getByRole("link", { name: "Campagnes", exact: true }).click();
  await admin.locator("td a").first().click();
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
  await photo("14-parlomix-liste");
  const films = await db.prepare("SELECT id, type, format, cle, type_mime, duree_ms, nb_extraits FROM parlomix WHERE statut = 'pret' ORDER BY cree_le").all<any>();
  assert.equal(films.results.length, 3, "trois Parlomix prêts");
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

try {
  await appairer();
  const attendu = scenario === "auto" ? await scenarioAuto() : await scenarioDemo();

  // La file d'envoi se vide.
  for (let i = 0; i < 60 && objets.size < nbQuestions; i++) await page.waitForTimeout(250);
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
    const volume = spawnSync("ffmpeg", ["-hide_banner", "-i", fichier, "-af", "volumedetect", "-f", "null", "-"]).stderr.toString();
    bilan.push({ etape: r.etape_id, duree_ms: r.duree_ms, son_detecte_tablette: r.son_present, flux, volume_max: /max_volume: (\S+ dB)/.exec(volume)?.[1] });
  }
  console.log(JSON.stringify({ scenario, erreurs, bilan }, null, 2));
  for (const b of bilan) {
    assert.ok(b.flux.some((f: string) => f.startsWith("opus")), `${b.etape} : piste son Opus présente`);
    assert.equal(b.son_detecte_tablette, 1, `${b.etape} : voix détectée par la tablette`);
  }
  assert.deepEqual(erreurs, [], "aucune erreur dans la page");
  if (process.env.E2E_ADMIN) await visiteAdmin();
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
