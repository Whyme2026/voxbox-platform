// @ts-check
// Page publique du QR code affiché à l'extérieur de la cabine : le visiteur retrouve ses vidéos et change d'avis.
// - /retrait/                 : saisie de l'e-mail donné dans la cabine, un lien d'accès lui est envoyé ;
// - /retrait/#acces=<jeton>   : ses passages et ses vidéos, avec « retirer la diffusion » ou « supprimer mes réponses » ;
// - /retrait/#<code>          : ancien lien par code de retrait (10 caractères), toujours reconnu.
// Le jeton et le code restent dans le fragment (#) : jamais envoyés dans l'adresse d'une requête.

// - /retrait/#parlomix=<jeton> : même accès, ouvert sur la fabrication de son Parlomix (lien de l'e-mail « recevoir »).

import { choixParPersonne, planParlomix, themeDepuisCouleurs, titreOuverture } from "./montage/plan.js";
import { analyserReponse, contientDuSon, fabriquer, formatsDisponibles } from "./montage/rendu.js";

const page = /** @type {HTMLElement} */ (document.getElementById("page"));

/**
 * @param {string} balise
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} enfants
 */
function h(balise, attrs = {}, ...enfants) {
  const el = document.createElement(balise);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const e of enfants) if (e) el.append(e);
  return el;
}

/** @param {...(Node | null | false)} contenu */
function afficher(...contenu) {
  page.replaceChildren(...contenu.filter((c) => c instanceof Node));
  const champ = page.querySelector("input");
  if (champ instanceof HTMLInputElement) champ.focus();
  window.scrollTo(0, 0);
}

/** @param {string} iso */
const jour = (iso) => new Date(iso.replace(" ", "T") + (/Z|[+-]\d\d:?\d\d$/.test(iso) ? "" : "Z"))
  .toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
/** @param {number | null} ms */
const duree = (ms) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}` : "");

/** @param {() => void} reessayer */
function erreurReseau(reessayer, message = "La connexion n'a pas abouti. Vérifiez votre réseau et réessayez.") {
  afficher(
    h("p", { class: "bulle douce" }, message),
    h("button", { type: "button", class: "principal", onclick: reessayer }, "Réessayer"),
  );
}

// ------------------------------------------------------------------ 1. demande du lien par e-mail

function demande(/** @type {string} */ message = "", /** @type {string} */ valeur = "") {
  const champ = /** @type {HTMLInputElement} */ (h("input", { id: "email", type: "email", inputmode: "email", autocomplete: "email", spellcheck: "false", placeholder: "vous@exemple.fr", maxlength: "160", value: valeur }));
  const envoyer = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "principal" }, "Recevoir mon lien"));
  const soumettre = async (/** @type {Event} */ ev) => {
    ev.preventDefault();
    const email = champ.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return demande("Cette adresse e-mail ne semble pas valide.", email);
    envoyer.disabled = true;
    try {
      const r = await fetch("/api/acces/demande", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      const corps = await r.json().catch(() => ({}));
      if (!r.ok) return erreurReseau(() => demande("", email), corps.message ?? undefined);
      envoye(email, corps.message);
    } catch { erreurReseau(() => demande("", email)); }
  };
  afficher(
    h("h1", { class: "bulle titre" }, "Vos vidéos Parlobox"),
    h("p", { class: "bulle douce" }, "Saisissez l'e-mail donné dans la cabine : nous vous envoyons un lien pour retrouver vos vidéos et, si vous le souhaitez, retirer votre accord ou les supprimer."),
    h("form", { class: "carte champ", onsubmit: soumettre },
      h("label", { for: "email" }, "Votre e-mail"), champ,
      message ? h("p", { class: "erreur", role: "alert" }, message) : null,
      envoyer),
    h("p", { class: "doux" }, "Pas d'e-mail donné dans la cabine ? Demandez à un conseiller, ou écrivez au contact indiqué dans le texte d'accord."),
  );
}

function envoye(/** @type {string} */ email, /** @type {string} */ message) {
  afficher(
    h("p", { class: "bulle visiteur" }, email),
    h("h1", { class: "bulle titre" }, "C'est envoyé"),
    h("p", { class: "bulle douce" }, message || "Si cette adresse correspond à des vidéos, un lien vient d'y être envoyé."),
    h("p", { class: "doux" }, "Le lien est valable une heure. Rien reçu après quelques minutes ?"),
    h("button", { type: "button", class: "secondaire", onclick: () => demande("", email) }, "Renvoyer un lien"),
  );
}

// ------------------------------------------------------------------ 2. mes vidéos (lien reçu par e-mail)

/** @param {string} jeton @param {string} chemin @param {RequestInit} [init] */
const acces = (jeton, chemin, init = {}) => fetch(chemin, { ...init, headers: { ...(init.headers ?? {}), "x-acces": jeton } });

async function mesVideos(/** @type {string} */ jeton, /** @type {string} */ annonce = "", /** @type {boolean} */ parlomixDabord = false) {
  afficher(h("p", { class: "bulle douce" }, "Un instant…"));
  let r;
  try { r = await acces(jeton, "/api/acces/moi"); } catch { return erreurReseau(() => mesVideos(jeton)); }
  if (r.status === 401) {
    const corps = await r.json().catch(() => ({}));
    return lienPerime(corps.message ?? "Ce lien n'est plus valable.");
  }
  if (!r.ok) return erreurReseau(() => mesVideos(jeton));
  const { passages } = await r.json();
  if (!passages.length) {
    return afficher(
      annonce ? h("p", { class: "bulle visiteur" }, annonce) : null,
      h("h1", { class: "bulle titre" }, "Plus aucune vidéo"),
      h("p", { class: "bulle douce" }, "Il n'y a plus de vidéo associée à votre adresse. Merci d'avoir pris le temps de répondre."),
    );
  }
  const avecVideos = passages.filter((/** @type {any} */ p) => p.reponses.length);
  if (parlomixDabord && avecVideos.length) {
    // Lien de l'e-mail : d'abord le Parlomix du dernier passage, puis la gestion de ses vidéos.
    const p = avecVideos[0];
    const tu = p.parlomix?.tutoiement === true;
    return afficher(
      h("h1", { class: "bulle titre" }, tu ? `${p.prenom}, ton Parlomix` : `${p.prenom}, votre Parlomix`),
      h("p", { class: "bulle douce" }, tu
        ? `Tes réponses pour ${p.marque}, montées en un petit film à garder ou à partager. Il se fabrique ici, sous tes yeux, en une minute environ.`
        : `Vos réponses pour ${p.marque}, montées en un petit film à garder ou à partager. Il se fabrique ici, sous vos yeux, en une minute environ.`),
      blocParlomix(jeton, p, true),
      h("h2", { class: "sous-titre" }, tu ? "Tes vidéos" : "Vos vidéos"),
      ...passages.map((/** @type {any} */ x) => cartePassage(jeton, x, x.id !== p.id)),
    );
  }
  afficher(
    annonce ? h("p", { class: "bulle visiteur" }, annonce) : null,
    h("h1", { class: "bulle titre" }, `Bonjour ${passages[0].prenom}`),
    h("p", { class: "bulle douce" }, passages.length > 1
      ? `Voici vos ${passages.length} passages en cabine. Vous pouvez changer d'avis à tout moment, sans avoir à vous justifier.`
      : "Voici vos réponses. Vous pouvez changer d'avis à tout moment, sans avoir à vous justifier."),
    ...passages.map((/** @type {any} */ p) => cartePassage(jeton, p)),
  );
}

function lienPerime(/** @type {string} */ message) {
  history.replaceState(null, "", location.pathname);
  afficher(
    h("h1", { class: "bulle titre" }, "Lien expiré"),
    h("p", { class: "bulle douce" }, `${message} Pour votre sécurité, chaque lien a une durée limitée.`),
    h("button", { type: "button", class: "principal", onclick: () => demande() }, "Recevoir un nouveau lien"),
  );
}

/** @param {string} jeton @param {any} p @param {boolean} [avecParlomix] */
function cartePassage(jeton, p, avecParlomix = true) {
  return h("section", { class: "carte passage", "aria-label": `${p.marque}, ${jour(p.date)}` },
    h("p", { class: "passage-tete" }, h("strong", {}, p.marque), h("span", { class: "doux" }, ` · ${jour(p.date)}`)),
    h("p", { class: "doux" }, p.diffusion
      ? "Usage interne et diffusion publique acceptés."
      : "Usage interne seulement : vos vidéos ne sont pas diffusées publiquement."),
    h("div", { class: "videos" }, ...p.reponses.map((/** @type {any} */ x) => tuileVideo(jeton, x))),
    avecParlomix && p.reponses.length && p.parlomix ? blocParlomix(jeton, p, false) : null,
    h("div", { class: "choix" },
      p.diffusion ? h("button", { type: "button", class: "secondaire", onclick: () => confirmer(p, "diffusion", () => agir(jeton, p, "diffusion"), () => mesVideos(jeton)) }, "Retirer seulement l'accord de diffusion") : null,
      h("button", { type: "button", class: "danger", onclick: () => confirmer(p, "tout", () => agir(jeton, p, "tout"), () => mesVideos(jeton)) }, "Supprimer ces réponses")),
    p.contact_rgpd ? h("p", { class: "doux petit" }, `Une question sur vos données ? Écrivez à ${p.contact_rgpd}.`) : null,
  );
}

// ------------------------------------------------------------------ 3. mon Parlomix, fabriqué dans le navigateur

/**
 * Parlomix d'un passage (9:16, à partager) : fabriqué ici, dans le navigateur du visiteur, avec les mêmes règles que
 * dans Parlorama (blancs coupés, question en bulle, jingle, couleurs de la campagne). Rien n'est envoyé ni gardé
 * côté serveur : on évite de monter d'avance un film pour chaque visiteur. Seul le fait est tracé dans le journal.
 * @param {string} jeton @param {any} p @param {boolean} grand
 */
function blocParlomix(jeton, p, grand) {
  const tu = p.parlomix?.tutoiement === true;
  const zone = h("div", { class: "parlomix" });
  const lancer = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: grand ? "principal" : "secondaire" }, "Créer mon Parlomix"));
  const depart = () => zone.replaceChildren(...[lancer, grand ? null : h("p", { class: "doux petit" }, tu ? "Tes réponses montées en un petit film, à garder ou à partager." : "Vos réponses montées en un petit film, à garder ou à partager.")].filter((x) => x !== null));
  lancer.addEventListener("click", () => fabriquerParlomix(jeton, p, zone, depart));
  if (!formatsDisponibles().length) {
    zone.replaceChildren(h("p", { class: "doux" }, "Ce navigateur ne sait pas fabriquer de vidéo. Ouvrez ce lien dans Chrome ou Safari à jour."));
  } else depart();
  return h("section", { class: `carte bloc-parlomix${grand ? " grand" : ""}`, "aria-label": "Mon Parlomix" }, zone);
}

/** @param {string} jeton @param {any} p @param {HTMLElement} zone @param {() => void} recommencer */
async function fabriquerParlomix(jeton, p, zone, recommencer) {
  const tu = p.parlomix?.tutoiement === true;
  const etape = h("strong", {}, "Préparation");
  const barre = h("span", { class: "barre-parlomix" }, h("span", {}));
  const apercu = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "apercu-parlomix" }));
  const avancer = (/** @type {number} */ f) => { /** @type {HTMLElement} */ (barre.firstChild).style.width = `${Math.round(f * 100)}%`; };
  zone.replaceChildren(etape, barre, apercu,
    h("p", { class: "doux petit" }, tu ? "Garde cette page ouverte : le film se fabrique en direct, à peu près en sa durée réelle." : "Gardez cette page ouverte : le film se fabrique en direct, à peu près en sa durée réelle."));
  try {
    const px = p.parlomix;
    const session = { id: p.id, prenom: p.prenom, cree_le: p.date, consent_diffusion: p.diffusion, retiree_le: null, cabine_id: null, cabine_nom: null, choix: px.choix ?? {},
      reponses: p.reponses.map((/** @type {any} */ r) => ({ id: r.id, etape_id: r.etape_id, duree_ms: r.duree_ms, son_present: null })) };
    const choix = choixParPersonne(/** @type {any} */ (session), px.questions ?? [], px.etapes_choix ?? []);
    /** @type {Map<string, Blob>} */ const videos = new Map();
    const clips = [];
    for (const [i, x] of choix.entries()) {
      etape.textContent = `Réponse ${i + 1} sur ${choix.length}`;
      avancer(i / choix.length / 4);
      const r = await acces(jeton, `/api/acces/reponses/${x.id}/video`);
      if (r.status === 401) { const c = await r.json().catch(() => ({})); return lienPerime(c.message ?? "Ce lien n'est plus valable."); }
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      videos.set(x.id, blob);
      const a = await analyserReponse(blob);
      const dureeMs = a.dureeMs || x.dureeMs;
      clips.push({ ...x, dureeMs, segments: a.segments.length ? a.segments : /** @type {[number, number][]} */ ([[0, dureeMs]]) });
    }
    const theme = themeDepuisCouleurs(px.client?.couleurs, px.habillage, px.ambiance);
    theme.client = p.marque;
    const logo = await chargerImage(px.client?.logo_url);
    /** @type {Map<string, HTMLImageElement>} */ const visuels = new Map();
    for (const v of px.habillage?.visuels ?? []) {
      const img = await chargerImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(v.svg)}`);
      if (img) visuels.set(v.id, img);
    }
    const plan = planParlomix({ type: "personne", titre: titreOuverture(theme, p.prenom), sousTitre: p.campagne, signature: p.marque, clips, format: "9:16", theme });
    etape.textContent = "Montage en cours";
    const progression = (/** @type {number} */ f) => avancer(0.25 + f * 0.75);
    let film = await fabriquer({ plan, videos, apercu, logo, visuels, surProgression: progression });
    if (!(await contientDuSon(film.blob)) && film.type === "video/mp4") {
      // Leçon Geely : un MP4 peut perdre le son sans erreur. On refait le film en WebM.
      const webm = formatsDisponibles().find((f) => f.startsWith("video/webm"));
      if (webm) film = await fabriquer({ plan, videos, apercu, logo, visuels, format: webm, surProgression: progression });
    }
    acces(jeton, `/api/acces/sessions/${p.id}/parlomix`, { method: "POST" }).catch(() => {});
    const url = URL.createObjectURL(film.blob);
    const extension = film.type.includes("mp4") ? "mp4" : "webm";
    const nom = `parlomix-${p.prenom.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "moi"}.${extension}`;
    const fichier = new File([film.blob], nom, { type: film.type });
    const partage = /** @type {any} */ (navigator).canShare?.({ files: [fichier] })
      ? h("button", { type: "button", class: "secondaire", onclick: () => /** @type {any} */ (navigator).share({ files: [fichier], title: "Mon Parlomix" }).catch(() => {}) }, "Partager")
      : null;
    zone.replaceChildren(
      h("video", { class: "film-parlomix", src: url, controls: true, playsinline: true }),
      h("div", { class: "choix" },
        h("a", { class: "principal", href: url, download: nom }, "Télécharger"),
        partage ?? "",
        h("button", { type: "button", class: "lien", onclick: recommencer }, "Refaire")),
      h("p", { class: "doux petit" }, tu ? "Ton film n'est gardé nulle part ailleurs que sur ton appareil : télécharge-le pour le garder." : "Votre film n'est gardé nulle part ailleurs que sur votre appareil : téléchargez-le pour le garder."),
    );
  } catch (e) {
    zone.replaceChildren(h("p", { class: "erreur", role: "alert" }, "Le montage n'a pas abouti. Vérifiez la connexion et réessayez."),
      h("button", { type: "button", class: "secondaire", onclick: recommencer }, "Réessayer"));
    console.warn("Parlomix", e);
  }
}

/** Image (logo hébergé par la plateforme, visuel SVG) prête à dessiner ; null si elle ne se charge pas. */
async function chargerImage(/** @type {string | null | undefined} */ src) {
  if (!src || !(src.startsWith("/") || src.startsWith("data:"))) return null;
  const img = new Image();
  img.src = src;
  try { await img.decode(); return img; } catch { return null; }
}

/** @param {string} jeton @param {any} x */
function tuileVideo(jeton, x) {
  const ecran = h("button", { type: "button", class: "ecran-video", "aria-label": `Lire : ${x.question}` }, h("span", {}, "▶ Lire"));
  ecran.addEventListener("click", async () => {
    if (ecran.querySelector("video")) return;
    ecran.replaceChildren(h("span", {}, "Chargement…"));
    try {
      const r = await acces(jeton, `/api/acces/reponses/${x.id}/video`);
      if (!r.ok) throw new Error(String(r.status));
      const v = /** @type {HTMLVideoElement} */ (h("video", { src: URL.createObjectURL(await r.blob()), controls: true, playsinline: true }));
      ecran.replaceChildren(v);
      v.play().catch(() => {});
    } catch { ecran.replaceChildren(h("span", {}, "Lecture impossible. Réessayez.")); }
  });
  return h("figure", { class: "video" }, ecran, h("figcaption", {}, h("span", {}, x.question), h("span", { class: "doux" }, duree(x.duree_ms))));
}

/** @param {string} jeton @param {any} p @param {"tout" | "diffusion"} portee */
async function agir(jeton, p, portee) {
  const r = await acces(jeton, `/api/acces/sessions/${p.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ portee }) });
  if (r.status === 401) { const c = await r.json().catch(() => ({})); return lienPerime(c.message ?? "Ce lien n'est plus valable."); }
  if (!r.ok) throw new Error(String(r.status));
  mesVideos(jeton, portee === "tout" ? `Mes réponses pour ${p.marque} sont supprimées` : `Mes réponses pour ${p.marque} ne seront plus diffusées`);
}

/**
 * Confirmation avant d'agir.
 * @param {any} p passage (marque) @param {"tout" | "diffusion"} portee
 * @param {() => Promise<void>} faire @param {() => void} revenir
 */
function confirmer(p, portee, faire, revenir) {
  const bouton = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: portee === "tout" ? "danger" : "principal" },
    portee === "tout" ? "Oui, supprimer mes réponses" : "Oui, ne plus diffuser"));
  bouton.addEventListener("click", async () => {
    bouton.disabled = true;
    try { await faire(); } catch { bouton.disabled = false; erreurReseau(() => confirmer(p, portee, faire, revenir)); }
  });
  afficher(
    h("h1", { class: "bulle titre" }, "Vous confirmez ?"),
    h("p", { class: "bulle douce" }, portee === "tout"
      ? `Vos vidéos pour ${p.marque} seront supprimées définitivement et vos coordonnées effacées. Cela ne peut pas être annulé.`
      : `Vos réponses resteront utilisées en interne par ${p.marque}, mais ne seront plus diffusées publiquement.`),
    h("div", { class: "choix" }, bouton,
      h("button", { type: "button", class: "lien", onclick: revenir }, "Non, revenir")),
  );
}

// ------------------------------------------------------------------ ancien lien par code de retrait

/** @param {string} code */
async function parCode(code) {
  afficher(h("p", { class: "bulle douce" }, "Un instant…"));
  let r;
  try { r = await fetch(`/api/retrait/${code}`, { headers: { accept: "application/json" } }); } catch { return erreurReseau(() => parCode(code)); }
  if (r.status === 404) return demande();
  if (!r.ok) return erreurReseau(() => parCode(code));
  const info = await r.json();
  const p = { marque: info.marque };
  if (info.retiree_le) {
    return afficher(h("p", { class: "bulle visiteur" }, "Mes réponses sont supprimées"),
      h("p", { class: "bulle douce" }, "C'est fait. Vos vidéos ont été supprimées et vos coordonnées effacées."));
  }
  const faire = async (/** @type {"tout" | "diffusion"} */ portee) => {
    const res = await fetch(`/api/retrait/${code}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ portee }) });
    if (!res.ok) throw new Error(String(res.status));
    history.replaceState(null, "", location.pathname);
    afficher(h("p", { class: "bulle visiteur" }, portee === "tout" ? "Mes réponses sont supprimées" : "Mes réponses ne seront plus diffusées"),
      h("p", { class: "bulle douce" }, "C'est fait. Merci d'avoir pris le temps de répondre."));
  };
  afficher(
    h("h1", { class: "bulle titre" }, info.prenom ? `Bonjour ${info.prenom}` : "Bonjour"),
    h("p", { class: "bulle douce" }, `Vous avez répondu en vidéo pour ${info.marque} le ${jour(info.date)}.`),
    h("div", { class: "choix" },
      info.diffusion ? h("button", { type: "button", class: "secondaire", onclick: () => confirmer(p, "diffusion", () => faire("diffusion"), () => parCode(code)) }, "Retirer seulement l'accord de diffusion") : null,
      h("button", { type: "button", class: "danger", onclick: () => confirmer(p, "tout", () => faire("tout"), () => parCode(code)) }, "Supprimer mes réponses")),
  );
}

// ------------------------------------------------------------------ démarrage

function demarrer() {
  const fragment = decodeURIComponent(location.hash.slice(1));
  const m = /^(acces|parlomix)=([\w-]{40,})$/.exec(fragment);
  const code = fragment.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (m?.[2]) mesVideos(m[2], "", m[1] === "parlomix");
  else if (/^[A-HJ-NP-Z2-9]{10}$/.test(code)) parCode(code);
  else demande();
}
// Un lien ouvert dans un onglet déjà sur la page ne change que le fragment : on relit alors la page.
window.addEventListener("hashchange", () => { if (location.hash) demarrer(); });
demarrer();
