// Essai de bout en bout de la cabine, dans un vrai Chrome sans écran avec caméra et micro simulés.
// Vérifie le parcours complet (appairage, identification, consentement, flou, questions, choix, pause avant/après,
// reprise, fin), puis que chaque vidéo reçue par le serveur contient bien une piste son.
//
// node test/e2e/parcours.e2e.ts <fichier-audio.wav> <dossier-captures>
// Nécessite Playwright et Chromium (variables PLAYWRIGHT_MODULE et PLAYWRIGHT_BROWSERS_PATH).

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import assert from "node:assert/strict";
import { demarrerServeur, preparer, objets, db } from "./serveur.ts";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "/opt/npm-tools/node_modules/playwright");

const [audio, captures = "captures"] = process.argv.slice(2);
if (!audio) throw new Error("Fichier audio de test manquant");
mkdirSync(captures, { recursive: true });

// Parcours automobile, accéléré pour l'essai.
const parcours = JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/parcours-automobile.json"), "utf8"));
for (const e of parcours.etapes) if (e.type === "question") Object.assign(e, { compteARebours: 1, dureeMaxSec: 8, silenceArretSec: 2 });

const port = 8790 + Math.floor(Math.random() * 100);
const serveur = await demarrerServeur(port);
const { code } = await preparer(parcours);

const navigateur = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audio}`, "--autoplay-policy=no-user-gesture-required"],
});
const page = await navigateur.newPage({ viewport: { width: 1280, height: 800 } });
const erreurs: string[] = [];
page.on("pageerror", (e: Error) => erreurs.push(e.message));
page.on("console", (m: any) => { if (m.type() === "error") erreurs.push(m.text()); });

const capture = (nom: string) => page.screenshot({ path: join(captures, `${nom}.png`) });
const touche = (t: string) => page.locator(".touche", { hasText: new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).first().click();
const bouton = (t: string) => page.getByRole("button", { name: t, exact: true }).click();

try {
  await page.goto(`http://localhost:${port}/cabine/`);
  await page.getByText("Appairer cette cabine").waitFor();
  await capture("01-appairage");
  for (const c of code) await touche(c);
  await bouton("Appairer la cabine");

  await page.getByText("Votre avis compte").waitFor();
  await capture("02-accueil");
  await bouton("Commencer");

  await page.getByText("Comment vous appelez-vous ?").waitFor();
  await touche("C");
  for (const c of "amille") await touche(c);
  await capture("03-identification");
  await bouton("Continuer");

  await page.getByText("Avant de commencer").waitFor();
  await page.getByRole("checkbox").click(); // diffusion publique acceptée
  await capture("04-consentement");
  await bouton("C'est parti");

  await page.getByText("Placez votre visage").waitFor();
  await page.getByRole("checkbox", { name: "Flouter mon visage" }).click();
  await page.waitForTimeout(800);
  await capture("05-cadrage-flou");
  await bouton("Je suis prêt");

  await page.getByText("Question 1 sur 4").waitFor();
  await page.waitForTimeout(1600);
  await capture("06-question-enregistrement");

  await page.getByText("Quel modèle allez-vous essayer ?").waitFor({ timeout: 20_000 });
  await capture("07-choix");
  await page.getByRole("button", { name: "La berline" }).click();

  await page.getByText("Bon essai !").waitFor();
  await capture("08-pause");
  await bouton("Je suis de retour");

  await page.getByText("Votre avis compte").waitFor();
  await bouton("Je reviens");
  await capture("09-reprise");
  await bouton("Camille");

  await page.getByText("Question 2 sur 4").waitFor();
  await page.getByText("Merci !").waitFor({ timeout: 60_000 });
  await capture("10-fin");

  // Portrait (grand écran 9:16) : simple vérification de mise en page.
  await page.setViewportSize({ width: 720, height: 1280 });
  await page.getByText("Votre avis compte").waitFor({ timeout: 20_000 });
  await capture("11-accueil-portrait");

  // La file d'envoi se vide : 1 session, 4 vidéos.
  for (let i = 0; i < 40 && objets.size < 4; i++) await page.waitForTimeout(250);
  const sessions = await db.prepare("SELECT prenom, consent_diffusion FROM sessions").all<any>();
  const reponses = await db.prepare("SELECT etape_id, son_present, duree_ms, cle_source FROM reponses ORDER BY cree_le").all<any>();
  assert.equal(sessions.results.length, 1, "une seule session");
  assert.equal(sessions.results[0].prenom, "Camille");
  assert.equal(sessions.results[0].consent_diffusion, 1);
  assert.equal(reponses.results.length, 4, "quatre réponses");

  const bilan = [];
  for (const r of reponses.results) {
    const fichier = join(captures, `${r.etape_id}.webm`);
    writeFileSync(fichier, objets.get(r.cle_source)!);
    const flux = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", fichier]).toString().trim().split("\n");
    const volume = spawnSync("ffmpeg", ["-hide_banner", "-i", fichier, "-af", "volumedetect", "-f", "null", "-"]).stderr.toString();
    bilan.push({ etape: r.etape_id, duree_ms: r.duree_ms, son_detecte_tablette: r.son_present, flux, volume_max: /max_volume: (\S+ dB)/.exec(volume)?.[1] });
  }
  console.log(JSON.stringify({ erreurs, bilan }, null, 2));
  for (const b of bilan) {
    assert.ok(b.flux.some((f: string) => f.startsWith("opus")), `${b.etape} : piste son Opus présente`);
    assert.equal(b.son_detecte_tablette, 1, `${b.etape} : voix détectée par la tablette`);
  }
  console.log(JSON.stringify({ ok: true }));
} catch (e) {
  await capture("zz-echec").catch(() => {});
  console.log(JSON.stringify({ ok: false, erreur: String(e), erreurs }, null, 2));
  process.exitCode = 1;
} finally {
  await navigateur.close();
  serveur.close();
}
