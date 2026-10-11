// Essai de bout en bout de Why me, dans un vrai Chrome sans écran, en téléphone (390 × 844, tactile), avec caméra
// et micro simulés, et le vrai service de montage (ffmpeg) branché sur la plateforme locale :
//  1. le candidat scanne le QR code, joint son CV, s'identifie, choisit un métier et une entreprise, donne ses accords ;
//  2. il pose son téléphone : cadrage (lumière et son contrôlés), essai, 4 questions — la 1re gardée d'un geste,
//     la 2e revue puis refaite, la 3e gardée sans geste, la 4e revue puis gardée ;
//  3. le montage 9:16 est fait par le service, la candidature transmise, l'e-mail émis (boîte de test) ;
//  4. page vidéo publique, « Tu gardes la main », espace recruteur (connexion par lien, lecture), page Parlorama.
// Vérifie que le film monté a du son, est en 720 × 1280, et que les rushes ont été effacés.
//
// node test/e2e/whyme.e2e.ts <voix.wav> <camera.y4m> <dossier-captures>
// Nécessite Playwright et Chromium (variables PLAYWRIGHT_MODULE et PLAYWRIGHT_BROWSERS_PATH), ffmpeg et ffprobe.

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [audio, camera, captures = "captures-whyme"] = process.argv.slice(2);
if (!audio || !camera) throw new Error("Usage : whyme.e2e.ts <voix.wav> <camera.y4m> [captures]");
mkdirSync(captures, { recursive: true });

const CLE = "cle-de-montage-pour-l-essai-de-bout-en-bout";
process.env.MONTAGE_CLE = CLE;
const { demarrerServeur, objets, db, env } = await import("./serveur.ts");
const { demarrerService } = await import("../../montage/serveur.ts");

const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE ?? "/opt/npm-tools/node_modules/playwright");

const port = 8900 + Math.floor(Math.random() * 50);
const portMontage = port + 60;
await demarrerServeur(port);
const serviceMontage = await demarrerService(portMontage);
Object.assign(env, { MONTAGE_URL: `http://127.0.0.1:${portMontage}`, MONTAGE_CLE: CLE });
const base = `http://localhost:${port}`;

async function appel(methode: string, chemin: string, corps?: unknown) {
  const r = await fetch(`${base}${chemin}`, { method: methode, headers: { "x-dev-email": "admin@whyme.test", "content-type": "application/json" }, body: corps ? JSON.stringify(corps) : undefined });
  const d = (await r.json()) as any;
  if (!r.ok) throw new Error(`${chemin} : ${JSON.stringify(d)}`);
  return d;
}

// Campagne accélérée pour l'essai : 3 s de lecture, 5 s de réponse, 3 s avant de garder sans geste.
const config = JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/whyme-campagne-demo.json"), "utf8"));
config.questionEssai.dureeSec = 5;
for (const q of config.questions) Object.assign(q, { dureeSec: 5, lectureSec: 3 });
config.validationAutoSec = 3;
const ids: Record<string, string> = {};
const pfa = (await appel("POST", "/api/rh/clients", { nom: "PFA" })).client.id;
await appel("POST", `/api/rh/clients/${pfa}/contacts`, { email: "contact@pfa.test" });
for (const nom of ["Verkor", "Valeo", "Renault", "Stellantis"]) ids[nom] = (await appel("POST", "/api/rh/entreprises", { nom })).entreprise.id;
await appel("POST", "/api/rh/recruteurs", { email: "rh@verkor.test", entreprise_id: ids.Verkor });
const cp = await appel("POST", "/api/rh/campagnes", { nom: "Mondial 2026 (essai)", code: "mondial-essai", client_id: pfa, config, entreprises: Object.values(ids) });
await appel("POST", `/api/rh/campagnes/${cp.campagne.id}/statut`, { statut: "active" });

const navigateur = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audio}`, `--use-file-for-fake-video-capture=${camera}`, "--autoplay-policy=no-user-gesture-required"],
});
const telephone = await navigateur.newContext({ ...devices["iPhone 13"], userAgent: devices["Pixel 7"].userAgent, permissions: ["camera", "microphone"] });
const page = await telephone.newPage();
const erreurs: string[] = [];
page.on("pageerror", (e: Error) => erreurs.push(e.message));
page.on("console", (m: any) => { if (m.type() === "error" && !/404|401/.test(m.text())) erreurs.push(m.text()); });
const capture = (nom: string, p = page) => p.screenshot({ path: join(captures, `whyme-${nom}.png`) });
const bouton = (t: string | RegExp, p = page) => p.getByRole("button", { name: t }).first();

// 1. Avant le tournage.
await page.goto(`${base}/i/mondial-essai`);
await page.getByText("Plus qu'un CV").waitFor();
await page.waitForTimeout(900);
await capture("01-accueil");
await bouton("C'est parti !").click();
await page.getByText("Tu as un CV").waitFor();
await page.locator("#cv").setInputFiles({ name: "CV Camille Martin.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% CV de démonstration\n") });
await page.getByText("CV Camille Martin.pdf").waitFor();
await capture("02-cv");
await bouton("Continuer").click();
await page.getByLabel("Prénom").fill("Camille");
await page.getByLabel("Nom", { exact: true }).fill("Martin");
await page.getByLabel("E-mail").fill("camille@exemple.fr");
await page.getByLabel("Âge").fill("23");
await capture("03-identite");
await bouton("Continuer").click();
await page.getByText("Quel métier t'attire").waitFor();
await page.getByRole("radio", { name: "Gérer & Administrer" }).click();
await capture("04-metier");
await bouton("Continuer").click();
await page.getByText("Chez qui veux-tu postuler").waitFor();
await page.getByRole("checkbox", { name: "Verkor" }).click();
await capture("05-entreprises");
await bouton("Je postule").click();
await page.getByText("Tes accords").waitFor();
await page.locator("#c-candidature").check();
await page.locator("#c-public").check();
await capture("06-accords");
await bouton("Je valide").click();

// 2. Tournage.
await page.getByText("Installe ton téléphone").waitFor();
await capture("07-installation");
await bouton("Mon téléphone est en place").click();
await page.getByText("Place ton visage dans la silhouette").waitFor();
await page.waitForTimeout(500);
await capture("08-cadrage");
await page.getByText("Parfait ! On commence par un essai.").waitFor({ timeout: 30_000 });
await page.getByText("Essai · rien n'est envoyé").waitFor();
await capture("09-essai-lecture");
await bouton("Je suis prêt").click();
await page.getByText("On t'écoute").waitFor();
await page.waitForTimeout(1500);
await capture("10-essai-enregistrement");
await bouton("Passer aux questions").click({ timeout: 15_000 });

// Question 1 : gardée d'un geste.
await page.getByText("Question 1 sur 4").waitFor();
await capture("11-question-lecture");
await page.getByText("On t'écoute").waitFor({ timeout: 10_000 });
await page.waitForTimeout(2000);
await capture("12-question-enregistrement");
await bouton("On garde").waitFor({ timeout: 10_000 });
await capture("13-on-garde");
await bouton("On garde").click();

// Question 2 : revue, puis refaite (une seule reprise), la seconde prise est gardée sans geste.
await page.getByText("Question 2 sur 4").waitFor();
await bouton("Je veux la revoir").click({ timeout: 20_000 });
await bouton("Je refais").waitFor();
await page.waitForTimeout(800);
await capture("14-revoir");
await bouton("Je refais").click();
await page.getByText("Question 2 sur 4 · deuxième prise").waitFor();
await bouton("On garde").waitFor({ timeout: 20_000 });
// Plus de reprise possible : la relecture ne propose plus « Je refais ».
await bouton("Je veux la revoir").click();
await page.waitForTimeout(600);
assert.equal(await page.getByRole("button", { name: "Je refais" }).count(), 0, "une seule reprise par question");
await capture("15-revoir-sans-reprise");
await bouton("Je garde").click();

// Question 3 : gardée sans aucun geste.
await page.getByText("Question 3 sur 4").waitFor();
await page.getByText("Question 4 sur 4").waitFor({ timeout: 30_000 });
// Question 4 : revue puis gardée.
await bouton("Je veux la revoir").click({ timeout: 20_000 });
await bouton("Je garde").click();

// 3. Fin : la vidéo n'est pas montrée, elle arrive par e-mail.
await page.getByText("Ta vidéo est en cours de montage").waitFor({ timeout: 30_000 });
await page.waitForTimeout(900);
await capture("16-fin");
assert.equal(await page.locator("video:visible").count(), 0, "aucune vidéo montrée en fin de parcours");

const candidat = db.sqlite.prepare("SELECT id, statut FROM wm_candidats WHERE prenom = 'Camille'").get() as { id: string; statut: string };
let ligne: any;
for (let i = 0; i < 120; i++) {
  ligne = db.sqlite.prepare("SELECT statut, erreur, code_public, montage_cle, montage_duree_ms FROM wm_candidats WHERE id = ?").get(candidat.id);
  if (ligne.statut === "pret" || ligne.statut === "erreur") break;
  await new Promise((r) => setTimeout(r, 500));
}
assert.equal(ligne.statut, "pret", `montage : ${ligne.statut} ${ligne.erreur ?? ""}`);
const film = objets.get(ligne.montage_cle)!;
writeFileSync(join(captures, "whyme-montage.mp4"), film);
const sonde = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", join(captures, "whyme-montage.mp4")]).toString());
assert.ok(sonde.streams.some((s: any) => s.codec_type === "audio"), "le montage a du son");
const image = sonde.streams.find((s: any) => s.codec_type === "video");
assert.deepEqual([image.width, image.height], [720, 1280], "montage en 9:16");
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", join(captures, "whyme-montage.mp4"),
  "-vf", "fps=1/3,scale=180:-1,tile=8x1", "-frames:v", "1", join(captures, "whyme-17-planche-montage.png")]);
assert.ok(![...objets.keys()].some((k) => k.includes(candidat.id) && /q-[a-z]+-/.test(k)), "rushes effacés après le montage");
const reponsesCv = [...objets.keys()].filter((k) => k.includes(candidat.id) && k.endsWith("cv.pdf"));
assert.equal(reponsesCv.length, 1, "CV reçu");
const prise2 = db.sqlite.prepare("SELECT COUNT(*) AS n FROM journal WHERE action = 'whyme.candidature.transmise' AND cible_id = ?").get(candidat.id) as any;
assert.equal(prise2.n, 1);

// 4. L'e-mail, la page publique, « Tu gardes la main ».
const mail = db.sqlite.prepare("SELECT texte, html FROM wm_courriels WHERE sorte = 'video_prete'").get() as { texte: string; html: string };
const lienVideo = /(http:\/\/localhost:\d+\/v\/[A-Z0-9]{10})/.exec(mail.texte)![1]!;
const lienGestion = /(http:\/\/localhost:\d+\/whyme\/gerer\/#g=[\w-]+)/.exec(mail.texte)![1]!;
const bureau = await navigateur.newContext({ viewport: { width: 1280, height: 860 } });
const courriel = await bureau.newPage();
await courriel.setContent(mail.html);
await courriel.waitForTimeout(800);
await capture("18-email", courriel);

await page.goto(lienVideo);
await page.locator("video").waitFor();
// Le Chromium de Playwright n'a pas de décodeur H.264 (Chrome, Safari et Firefox l'ont) : on vérifie alors le flux
// servi plutôt que la lecture.
const h264 = await page.evaluate(() => document.createElement("video").canPlayType('video/mp4; codecs="avc1.64001F, mp4a.40.2"') !== "");
if (h264) {
  await page.waitForFunction(() => (document.querySelector("video") as HTMLVideoElement).readyState >= 1, null, { timeout: 15_000 });
  const duree = await page.evaluate(() => (document.querySelector("video") as HTMLVideoElement).duration);
  assert.ok(duree > 20, `la page publique lit le montage (${duree} s)`);
} else {
  const flux = await fetch(`${base}/api/whyme/videos/${lienVideo.split("/v/")[1]}/flux`, { headers: { range: "bytes=0-99" } });
  assert.equal(flux.status, 206);
  assert.equal(flux.headers.get("content-type"), "video/mp4");
}
await page.waitForTimeout(800);
await capture("19-page-video");
await page.goto(lienGestion);
await page.getByText("Tu gardes la main").waitFor();
await capture("20-gerer");

// Espace recruteur : demande de lien, connexion, lecture.
const rh = await bureau.newPage();
await rh.goto(`${base}/recruteur/`);
await rh.getByLabel("Adresse e-mail").fill("rh@verkor.test");
await bouton("Recevoir mon lien", rh).click();
await rh.getByText("un lien de connexion vient").waitFor();
await capture("21-recruteur-connexion", rh);
const lienRh = /(http:\/\/localhost:\d+\/recruteur\/#lien=[\w-]+)/.exec((db.sqlite.prepare("SELECT texte FROM wm_courriels WHERE sorte = 'connexion_recruteur'").get() as any).texte)![1]!;
await rh.goto(lienRh);
await rh.getByText("Camille Martin").waitFor();
await rh.waitForTimeout(800);
await capture("22-recruteur-liste", rh);
await rh.getByRole("button", { name: /Voir la vidéo de Camille/ }).click();
if (h264) await rh.waitForFunction(() => (document.getElementById("lecteur-video") as HTMLVideoElement).readyState >= 2, null, { timeout: 15_000 });
else await rh.waitForFunction(() => (document.getElementById("lecteur-video") as HTMLVideoElement).src.startsWith("blob:"), null, { timeout: 15_000 });
await rh.waitForTimeout(1500);
await capture("23-recruteur-video", rh);
const lectures = db.sqlite.prepare("SELECT COUNT(*) AS n FROM journal WHERE utilisateur_email = 'rh@verkor.test' AND action = 'recruteur.video.lecture'").get() as any;
assert.equal(lectures.n, 1, "lecture du recruteur journalisée");

// Contact du client (organisateur) : statistiques seulement, dans le même espace.
const orga = await bureau.newPage();
await orga.goto(`${base}/recruteur/`);
await orga.getByLabel("Adresse e-mail").fill("contact@pfa.test");
await orga.getByRole("button", { name: "Recevoir mon lien" }).click();
await orga.getByText("un lien de connexion vient").waitFor();
const lienOrga = /#lien=([\w-]+)/.exec((db.sqlite.prepare("SELECT texte FROM wm_courriels WHERE a = 'contact@pfa.test'").get() as any).texte)![1];
await orga.goto(`${base}/recruteur/#lien=${lienOrga}`);
await orga.getByText("Candidatures par entreprise").waitFor();
await capture("24-organisateur-statistiques", orga);

// Espace RH (séparé de Parlorama).
const admin = await bureau.newPage();
await admin.goto(`${base}/rh/#/campagne/${cp.campagne.id}`);
await admin.getByText("Interviews (1)").waitFor();
await capture("25-rh-campagne", admin);
await admin.goto(`${base}/rh/#/clients`);
await admin.getByText("contact@pfa.test").waitFor();
await capture("26-rh-clients", admin);
await admin.goto(`${base}/rh/#/courriels`);
await admin.getByText("Ta vidéo WhyMe est prête").waitFor();
await capture("27-rh-emails", admin);

assert.deepEqual(erreurs, [], `erreurs dans les pages : ${erreurs.join(" | ")}`);
await navigateur.close();
serviceMontage.close();
console.log(`Why me : parcours complet, montage ${Math.round(ligne.montage_duree_ms / 1000)} s en 720 × 1280 avec son, e-mail, page publique, recruteur. Captures dans ${captures}.`);
process.exit(0);
