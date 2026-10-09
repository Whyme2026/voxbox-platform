// Essais de bout en bout de la cabine, dans un vrai Chrome sans écran avec caméra et micro simulés.
// Deux scénarios :
//  - demo : parcours neutre Vox Box (accueil, consignes et accord, 5 questions, fin), flou activé ;
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
// Parcours accéléré pour l'essai.
for (const e of parcours.etapes) if (e.type === "question") Object.assign(e, { compteARebours: 1, dureeMaxSec: 8, silenceArretSec: 2 });
const nbQuestions = parcours.etapes.filter((e: any) => e.type === "question").length;

const port = 8790 + Math.floor(Math.random() * 100);
const serveur = await demarrerServeur(port);
const { code } = await preparer(parcours, scenario === "auto" ? { nom: "Démo Auto", couleurs: { principale: "#0F6E5A", fond: "#F4F6F5", texte: "#10231D" } } : { nom: "Vox Box" });

const navigateur = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audio}`, "--autoplay-policy=no-user-gesture-required"],
});
const portrait = { width: 834, height: 1194 };
const page = await navigateur.newPage({ viewport: portrait });
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
  await capture("01-accueil");
  await bouton("Je me lance");
  await page.getByText("Comment ça marche").waitFor();
  // Le bouton reste grisé tant que l'accord obligatoire n'est pas donné.
  assert.equal(await page.getByRole("button", { name: "C'est parti" }).isDisabled(), true);
  await cocher("J'accepte que Vox Box");
  await cocher("J'accepte aussi");
  await cocher("Flouter mon visage");
  await capture("02-consignes");
  await bouton("C'est parti");
  await page.locator(".titre-court", { hasText: "Le premier mot" }).waitFor();
  await page.waitForTimeout(400);
  await capture("03-question-compte-a-rebours");
  await page.locator("#rec:not([hidden])").waitFor();
  await page.waitForTimeout(1500);
  await capture("04-question-enregistrement");
  await page.locator(".titre-court", { hasText: "Le coup de cœur" }).waitFor({ timeout: 20_000 });
  await page.locator("#rec:not([hidden])").waitFor();
  await page.waitForTimeout(800);
  await capture("05-question-pistes");
  await page.getByText("Merci, c'est dans la boîte.").waitFor({ timeout: 90_000 });
  await capture("06-fin");
  // Paysage (tablette tournée) : mise en page de la question.
  await page.setViewportSize({ width: 1194, height: 834 });
  await page.getByText("Une minute pour dire").waitFor({ timeout: 20_000 });
  await capture("07-accueil-paysage");
  await bouton("Je me lance");
  await cocher("J'accepte que Vox Box");
  await bouton("C'est parti");
  await page.locator("#rec:not([hidden])").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await capture("08-question-paysage");
  return { sessions: 2, consentDiffusion: 1, prenom: "Visiteur" };
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
  console.log(JSON.stringify({ ok: true, scenario }));
} catch (e) {
  await capture("zz-echec").catch(() => {});
  console.log(JSON.stringify({ ok: false, scenario, erreur: String(e), erreurs }, null, 2));
  process.exitCode = 1;
} finally {
  await navigateur.close();
  serveur.close();
}
