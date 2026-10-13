// @ts-check
// Application de la cabine : affiche le parcours écran par écran, filme, met les envois en file.

import { creerMoteur, diffusionProposee, personnaliser, decouperConsigne, visuelDeLEtape } from "./moteur.js";
import { creerClavier } from "./clavier.js";
import { ouvrirCamera, creerVumetre, enregistrer, formatEnregistrement } from "./enregistreur.js";
import { creerFlou, detectionDisponible } from "./flou.js";
import { creerFileEnvoi } from "./file-envoi.js";

const VERSION = "0.9.0";
const CLE_JETON = "voxbox.jeton";
const CLE_CONFIG = "voxbox.config";
const CLE_PAUSES = "voxbox.pauses";
const INACTIVITE_MS = 90_000;
const PAUSE_MAX_MS = 12 * 3600_000;

/** @type {any} */ let config = null;
/** @type {ReturnType<typeof creerMoteur> | null} */ let moteur = null;
/** @type {MediaStream | null} */ let camera = null;
/** @type {ReturnType<typeof creerVumetre> | null} */ let vumetre = null;
/** @type {ReturnType<typeof creerFlou> | null} */ let flou = null;
/** @type {Awaited<ReturnType<typeof creerFileEnvoi>> | null} */ let file = null;

/**
 * Visiteur en cours. Effacé entièrement à chaque retour à l'accueil.
 * @type {null | { id: string, prenom: string, nom: string, email: string, recontact: boolean, diffusion: boolean,
 *   floutage: boolean, repondues: string[], creeLe: string, envoyee: boolean, parcoursVersion: string, consentVersion: string, codeRetrait: string,
 *   choixFaits: { etape: string, option: string, quand: string }[] }}
 */
let visiteur = null;
let minuterieInactivite = 0;
let numeroEcran = 0;
/** @type {(() => void) | null} */ let annulerEnCours = null;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const cabine = $("cabine");
const scene = $("scene");
/** Couleur de fond de chaque ambiance (barre du navigateur). */
const FOND_AMBIANCE = /** @type {Record<string, string>} */ ({ conversation: "#F1F2F6", pop: "#FFF4DA", marine: "#0F2B46" });
/** Fonds et visuels de l'habillage de la campagne en cours. */
/** @type {Map<string, { couleur: string, couleurBas?: string, texte: string }>} */ let fonds = new Map();
/** @type {Map<string, { nom: string, svg: string }>} */ let visuels = new Map();
const clavier = creerClavier($("clavier"));
const apercu = $("apercu");
const ecoute = $("ecoute");
const video = /** @type {HTMLVideoElement} */ ($("video"));

// ------------------------------------------------------------------ utilitaires d'affichage

/** Petit constructeur d'éléments : h("p", { class: "x" }, "texte", enfant…) */
function h(/** @type {string} */ tag, /** @type {Record<string, any>} */ attrs = {}, /** @type {(Node|string|null|false)[]} */ ...enfants) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const e of enfants) if (e) el.append(e);
  return el;
}

const bouton = (/** @type {string} */ texte, /** @type {() => void} */ action, classe = "") =>
  h("button", { type: "button", class: `bouton ${classe}`.trim(), onclick: action }, texte);

function afficher(/** @type {(Node|null)[]} */ contenu, /** @type {string} */ type = "") {
  clavier.fermer();
  $("cabine").dataset.ecran = type;
  reperes(type);
  scene.replaceChildren(.../** @type {Node[]} */ (contenu.filter(Boolean)));
  // Ce que l'écran veut sous le clavier (.sous-clavier) quitte la scène pour la zone placée sous le clavier.
  const sousClavier = $("sous-clavier");
  sousClavier.replaceChildren(...scene.querySelectorAll(".sous-clavier > *"));
  scene.querySelectorAll(".sous-clavier").forEach((el) => el.remove());
  // L'aperçu caméra et l'état de la prise sont des éléments uniques, déplacés dans l'écran qui les demande.
  const place = scene.querySelector(".emplacement-camera");
  if (place) { place.append(apercu); apercu.hidden = false; video.play().catch(() => {}); }
  else if (apercu.parentElement !== document.body) { apercu.hidden = true; document.body.append(apercu); }
  const placeEcoute = scene.querySelector(".emplacement-ecoute");
  if (placeEcoute) { placeEcoute.append(ecoute); ecoute.hidden = false; }
  else if (ecoute.parentElement !== document.body) { ecoute.hidden = true; delete ecoute.dataset.etat; document.body.append(ecoute); }
  const premier = scene.querySelector("button:not([disabled])");
  if (premier instanceof HTMLElement) premier.focus({ preventScroll: true });
  numeroEcran += 1;
}

/** Texte fixe de la cabine selon le parcours : vouvoiement par défaut, tutoiement si le parcours le demande. */
const tv = (/** @type {string} */ vous, /** @type {string} */ tu) => (config?.parcours?.tutoiement === true ? tu : vous);

/** Texte du parcours avec le prénom du visiteur. */
const perso = (/** @type {string | undefined} */ t) => personnaliser(t ?? "", visiteur?.prenom ?? "");

/**
 * Repères de l'en-tête, au centre (sous l'objectif) : la progression des questions, ou le surtitre de l'accueil.
 * Plus d'étapes « Toi · Questions · Merci » (débrief PFA, 14/10/2026) : la signature « parlobox by whyme » reste seule à droite.
 */
function reperes(/** @type {string} */ _type, /** @type {{ numero: number, total: number } | null} */ progression = null, /** @type {string} */ surtitre = "") {
  const el = $("reperes");
  if (progression) {
    el.replaceChildren(
      h("span", { class: "points", "aria-hidden": "true" },
        ...Array.from({ length: progression.total }, (_, i) => h("i", { "data-etat": i + 1 < progression.numero ? "fait" : i + 1 === progression.numero ? "en-cours" : "a-venir" }))),
      h("span", {}, `Question ${progression.numero} sur ${progression.total}`));
    return;
  }
  if (surtitre) { el.replaceChildren(h("span", { class: "surtitre" }, surtitre)); return; }
  el.replaceChildren();
}

const bulle = (/** @type {string} */ classe, /** @type {(Node|string|null)[]} */ ...enfants) => h("p", { class: `bulle ${classe}` }, ...enfants);

/** Onde de la voix pendant l'enregistrement : 8 barres qui suivent le niveau réel du micro. */
function onde(/** @type {number} */ niveau) {
  const barres = $("onde").children;
  const profil = [0.45, 0.8, 1, 0.7, 0.9, 0.6, 0.85, 0.5];
  for (let i = 0; i < barres.length; i++) {
    /** @type {HTMLElement} */ (barres[i]).style.transform = `scaleY(${Math.max(0.22, Math.min(1, niveau * 1.4 * /** @type {number} */ (profil[i % profil.length])))})`;
  }
}

const chrono = (/** @type {number} */ s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Case à cocher tactile. */
function caseACocher(/** @type {Node | string} */ libelle, /** @type {boolean} */ coche, /** @type {(v: boolean) => void} */ surChangement, /** @type {string} */ precision = "") {
  const el = h("button", { type: "button", class: "case", role: "checkbox", "aria-checked": String(coche) },
    h("span", { class: "boite" }), h("span", {}, libelle, precision ? h("small", {}, precision) : null));
  el.addEventListener("click", () => {
    const v = el.getAttribute("aria-checked") !== "true";
    el.setAttribute("aria-checked", String(v));
    surChangement(v);
  });
  return el;
}

// ------------------------------------------------------------------ appairage et configuration

const jeton = () => { try { return localStorage.getItem(CLE_JETON); } catch { return null; } };

async function api(/** @type {string} */ chemin, /** @type {RequestInit} */ init = {}) {
  const res = await fetch(chemin, { ...init, headers: { authorization: `Bearer ${jeton()}`, ...(init.headers ?? {}) } });
  return res;
}

function ecranAppairage(message = "") {
  const champ = h("div", { class: "valeur", "data-indice": "Code à 6 caractères", "data-vide": "oui" });
  const valider = bouton("Appairer la cabine", async () => {
    valider.toggleAttribute("disabled", true);
    try {
      const res = await fetch("/api/cabine/appairer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: clavier.valeur() }) });
      const corps = await res.json();
      if (!res.ok) return ecranAppairage(corps.message ?? "Code refusé.");
      localStorage.setItem(CLE_JETON, corps.jeton);
      demarrer();
    } catch {
      ecranAppairage("Pas de connexion. Vérifiez le Wi-Fi puis réessayez.");
    }
  });
  valider.toggleAttribute("disabled", true);
  afficher([
    h("div", { class: "ecran" },
      h("h1", {}, "Appairer cette cabine"),
      h("p", { class: "chapo" }, "Saisissez le code affiché dans l'espace WhyMe, fiche de la cabine."),
      h("div", { class: "champ bulle visiteur", "aria-pressed": "true" }, h("span", { class: "etiquette" }, "Code d'appairage"), champ),
      message ? h("p", { class: "chapo", role: "alert" }, message) : null,
      h("div", { class: "actions droite" }, valider)),
  ], "appairage");
  clavier.ouvrir(champ, { mode: "code", max: 6, onChange: (v) => valider.toggleAttribute("disabled", v.length !== 6) });
}

/** Déploiement de la plateforme au chargement de la page : la cabine se recharge seule quand il change. */
/** @type {string | null} */ let deploiementCharge = null;

async function chargerConfig() {
  try {
    const res = await api("/api/cabine/config");
    if (res.status === 401) { localStorage.removeItem(CLE_JETON); return "desappairee"; }
    if (!res.ok) throw new Error(String(res.status));
    // Nouvelle version en ligne : une tablette en mode kiosque ne recharge jamais sa page d'elle-même. Entre deux
    // visiteurs seulement, on recharge pour prendre le nouveau code (sinon il ne s'applique qu'au prochain redémarrage).
    const deploiement = res.headers.get("x-parlorama-version");
    if (deploiement) {
      if (deploiementCharge && deploiement !== deploiementCharge && !visiteur) { location.reload(); return "ok"; }
      deploiementCharge ??= deploiement;
    }
    config = await res.json();
    localStorage.setItem(CLE_CONFIG, JSON.stringify(config));
  } catch {
    // Hors ligne : on rejoue la dernière configuration connue.
    try { config = JSON.parse(localStorage.getItem(CLE_CONFIG) ?? "null"); } catch { config = null; }
  }
  moteur = config?.parcours ? creerMoteur(config.parcours) : null;
  appliquerHabillage();
  return "ok";
}

/** Familles des polices auto-hébergées, proposées aux habillages de campagne. */
const POLICES = /** @type {Record<string, string>} */ ({ fredoka: '"Fredoka"', gabarito: '"Gabarito"', michroma: '"Michroma"', inter: '"Inter"', "barlow-condensed": '"Barlow Condensed"', barlow: '"Barlow"' });
/** Polices de titre très larges : tailles de titre réduites (voir cabine.css). */
const POLICES_LARGES = new Set(["michroma"]);
const COULEUR = /^#[0-9a-fA-F]{6}$/;
const valide = (/** @type {unknown} */ x) => typeof x === "string" && COULEUR.test(x);

/**
 * Thème : celui de Parlobox par défaut ; une marque cliente le remplace par ses couleurs
 * (couleurs.principale → la marque parle, couleurs.secondaire → le visiteur répond, couleurs.fond, couleurs.texte) et son logo.
 * L'habillage de la campagne (parcours.habillage) l'emporte : couleurs, couleur des bulles de la marque, polices,
 * titres en capitales, fonds par écran et visuels.
 */
function appliquerHabillage() {
  const client = config?.client;
  /** @type {any} */ const hab = config?.parcours?.habillage ?? {};
  const racine = document.documentElement.style;
  const c = { ...(client?.couleurs ?? {}) };
  const hc = hab.couleurs ?? {};
  if (valide(hc.marque)) c.principale = hc.marque;
  if (valide(hc.visiteur)) c.secondaire = hc.visiteur;
  if (valide(hc.fond)) c.fond = hc.fond;
  if (valide(hc.texte)) c.texte = hc.texte;
  for (const [cle, prop, sur] of [["principale", "--accent", "--sur-accent"], ["secondaire", "--parole", "--sur-parole"], ["fond", "--fond", ""], ["texte", "--texte", ""]]) {
    if (valide(c[cle])) {
      racine.setProperty(/** @type {string} */ (prop), c[cle]);
      if (sur) racine.setProperty(sur, contraste(c[cle]));
    } else {
      racine.removeProperty(/** @type {string} */ (prop));
      if (sur) racine.removeProperty(sur);
    }
  }
  // Bulles de la marque d'une autre couleur que l'accent (ex. blanches) ; une ombre douce si elles sont claires.
  if (valide(hc.bulle)) {
    racine.setProperty("--bulle", hc.bulle);
    racine.setProperty("--sur-bulle", contraste(hc.bulle));
    racine.setProperty("--ombre-bulle", contraste(hc.bulle) === "#FFFFFF" ? "none" : "0 1px 2px rgba(0, 0, 0, .06), 0 12px 28px -16px rgba(0, 0, 0, .3)");
  } else {
    for (const p of ["--bulle", "--sur-bulle", "--ombre-bulle"]) racine.removeProperty(p);
  }
  const titres = POLICES[hab.polices?.titres];
  const texte = POLICES[hab.polices?.texte];
  if (titres) racine.setProperty("--titres", `${titres}, system-ui, sans-serif`); else racine.removeProperty("--titres");
  if (texte) racine.setProperty("--police-texte", `${texte}, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`); else racine.removeProperty("--police-texte");
  if (POLICES_LARGES.has(hab.polices?.titres)) cabine.dataset.titres = "large"; else delete cabine.dataset.titres;
  cabine.toggleAttribute("data-majuscules", hab.titresMajuscules === true);
  if (config?.parcours?.disposition === "centree") cabine.dataset.disposition = "centree"; else delete cabine.dataset.disposition;
  cabine.toggleAttribute("data-habille", Boolean(config?.parcours?.habillage));
  fonds = new Map((hab.fonds ?? []).map((/** @type {any} */ a) => [a.id, a]));
  visuels = new Map((hab.visuels ?? []).map((/** @type {any} */ v) => [v.id, v]));
  appliquerFond(null);

  // En-tête, à gauche : le logo du client (à défaut, son nom si la campagne est habillée) et la ligne de la campagne
  // (habillage.entete). À droite, toujours, la signature « parlobox by whyme ».
  const logo = /** @type {HTMLImageElement} */ ($("logo"));
  const nom = $("nom-marque");
  logo.hidden = !client?.logo_url;
  nom.hidden = Boolean(client?.logo_url) || !config?.parcours?.habillage || !client?.nom;
  nom.textContent = nom.hidden ? "" : client.nom;
  if (client?.logo_url) { logo.src = client.logo_url; logo.alt = client.nom ?? ""; }
  const ligne = $("entete-texte");
  ligne.textContent = typeof hab.entete === "string" ? hab.entete.trim() : "";
  ligne.hidden = !ligne.textContent;
  // Ambiance graphique du parcours (« conversation » par défaut) et textes fixes au vouvoiement ou au tutoiement.
  const ambiance = ["pop", "marine"].includes(config?.parcours?.ambiance) ? config.parcours.ambiance : "conversation";
  document.documentElement.dataset.ambiance = ambiance;
  if (!valide(c.fond)) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", FOND_AMBIANCE[ambiance] ?? "#F1F2F6");
  $("ecoute-texte").textContent = tv("On vous écoute…", "On t'écoute…");
}

/** Fond d'un écran (fond, dégradé, couleur du texte) ; null : le fond de la campagne. */
function appliquerFond(/** @type {string | null | undefined} */ id) {
  const a = id ? fonds.get(id) : null;
  const style = cabine.style;
  if (a && valide(a.couleur) && valide(a.texte)) {
    style.setProperty("--fond", a.couleur);
    style.setProperty("--texte", a.texte);
    if (valide(a.couleurBas)) style.setProperty("--fond-scene", `linear-gradient(180deg, ${a.couleur}, ${a.couleurBas})`);
    else style.removeProperty("--fond-scene");
  } else {
    for (const p of ["--fond", "--texte", "--fond-scene"]) style.removeProperty(p);
  }
  const fond = a?.couleur ?? getComputedStyle(document.documentElement).getPropertyValue("--fond").trim();
  // Sur un fond sombre ou coloré, la signature « parlobox by whyme » passe en blanc (le magenta n'y serait pas lisible).
  cabine.toggleAttribute("data-fond-sombre", valide(fond) && contraste(fond) === "#FFFFFF");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", valide(fond) ? fond : "#F1F2F6");
}

/** Image d'un visuel de l'habillage (SVG affiché comme une image : rien n'y est exécuté). */
function imageVisuel(/** @type {string | null} */ id, /** @type {string} */ classe, /** @type {string | undefined} */ alt = undefined) {
  const v = id ? visuels.get(id) : null;
  if (!v) return null;
  return h("img", { class: `visuel ${classe}`.trim(), src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(v.svg)}`, alt: alt ?? v.nom, draggable: "false" });
}

/** Visuel d'une étape (le sien, ou celui de la dernière option choisie pour « choix »). */
const visuelEtape = (/** @type {any} */ e, /** @type {string} */ classe) =>
  config?.parcours ? imageVisuel(visuelDeLEtape(config.parcours, e, visiteur?.choixFaits ?? []), classe) : null;

/** Blanc ou encre selon la luminance de la couleur de marque. */
function contraste(/** @type {string} */ hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * /** @type {number} */ (r) + 0.7152 * /** @type {number} */ (g) + 0.0722 * /** @type {number} */ (b);
  return L > 0.4 ? "#23263F" : "#FFFFFF";
}

// ------------------------------------------------------------------ caméra

async function preparerCamera() {
  if (camera) return true;
  try {
    const orientation = window.matchMedia("(orientation: portrait)").matches ? "portrait" : "paysage";
    camera = await ouvrirCamera(orientation);
    video.srcObject = camera;
    await video.play().catch(() => {});
    // L'aperçu montre exactement ce qui est filmé : si la tablette ne fournit pas le 4:3 demandé, l'image entière
    // est affichée (avec des bandes) plutôt que recadrée.
    const r = video.videoWidth / video.videoHeight;
    const attendu = orientation === "paysage" ? 4 / 3 : 3 / 4;
    if (r && Math.abs(r - attendu) > 0.02) apercu.dataset.format = "autre"; else delete apercu.dataset.format;
    vumetre = creerVumetre(camera);
    return true;
  } catch {
    return false;
  }
}

function activerFlou(/** @type {boolean} */ actif) {
  const existant = apercu.querySelector("canvas");
  if (actif && !flou) {
    flou = creerFlou(video, { niveau: "fort" });
    apercu.insertBefore(flou.canevas, video.nextSibling);
    video.style.visibility = "hidden";
  } else if (!actif && flou) {
    flou.arreter(); flou = null;
    existant?.remove();
    video.style.visibility = "";
  }
}

function fluxAEnregistrer() {
  if (!camera) throw new Error("Caméra indisponible");
  if (!flou) return camera;
  const v = flou.flux().getVideoTracks()[0];
  return new MediaStream([.../** @type {MediaStreamTrack[]} */ ([v]), ...camera.getAudioTracks()]);
}

// ------------------------------------------------------------------ pauses avant / après

/** @returns {{ id: string, prenom: string, reprise: string, quand: number, campagne?: string, visiteur: any }[]} */
function pauses() {
  try {
    const liste = JSON.parse(localStorage.getItem(CLE_PAUSES) ?? "[]");
    const valides = liste.filter((/** @type {any} */ p) => Date.now() - p.quand < PAUSE_MAX_MS && p.campagne === config?.campagne?.id);
    if (valides.length !== liste.length) localStorage.setItem(CLE_PAUSES, JSON.stringify(valides));
    return valides;
  } catch { return []; }
}
function enregistrerPause(/** @type {string} */ reprise) {
  if (!visiteur) return;
  const liste = pauses().filter((p) => p.id !== visiteur?.id);
  liste.push({ id: visiteur.id, prenom: visiteur.prenom, reprise, quand: Date.now(), campagne: config?.campagne?.id, visiteur });
  localStorage.setItem(CLE_PAUSES, JSON.stringify(liste));
}
function retirerPause(/** @type {string} */ id) {
  localStorage.setItem(CLE_PAUSES, JSON.stringify(pauses().filter((p) => p.id !== id)));
}

// ------------------------------------------------------------------ session et envois

/** Code de retrait (10 caractères lisibles, sans O/0 ni I/1) : affiché en QR code sur l'écran de fin, même hors ligne. */
function codeRetrait() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...crypto.getRandomValues(new Uint8Array(10))].map((o) => alphabet[o % alphabet.length]).join("");
}

function nouvelleSession() {
  visiteur = {
    id: crypto.randomUUID(), prenom: "", nom: "", email: "", recontact: false, diffusion: false,
    floutage: false, repondues: [], creeLe: new Date().toISOString(), envoyee: false,
    parcoursVersion: config.campagne.parcours_version_id, consentVersion: config.consentement.id,
    codeRetrait: codeRetrait(),
    choixFaits: [],
  };
}

/** Miniature JPEG (320×180) de l'image filmée, floutée si le visiteur l'a demandé. */
function prendreMiniature() {
  /** @type {CanvasImageSource} */
  const source = flou ? flou.canevas : video;
  const l = flou ? flou.canevas.width : video.videoWidth;
  const ht = flou ? flou.canevas.height : video.videoHeight;
  if (!l || !ht) return Promise.resolve(null);
  const c = document.createElement("canvas");
  c.width = 320; c.height = 180;
  const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
  const ratio = Math.max(320 / l, 180 / ht);
  // Recadrage « remplir », décalé vers le haut pour garder le visage.
  ctx.drawImage(source, (320 - l * ratio) / 2, (180 - ht * ratio) * 0.3, l * ratio, ht * ratio);
  return new Promise((ok) => c.toBlob((b) => ok(b), "image/jpeg", 0.72));
}

/** Met la création de session en file, une seule fois, avant toute vidéo. */
async function envoyerSession() {
  if (!visiteur || visiteur.envoyee || !file) return;
  visiteur.envoyee = true;
  await file.ajouter({
    methode: "POST", chemin: "/api/cabine/sessions", type: "application/json",
    corps: JSON.stringify({
      id: visiteur.id, cree_le: visiteur.creeLe,
      parcours_version_id: visiteur.parcoursVersion, consentement_version_id: visiteur.consentVersion,
      prenom: visiteur.prenom || "Visiteur", nom: visiteur.nom || undefined, email: visiteur.email || undefined,
      recontact: visiteur.recontact, consent_interne: true, consent_diffusion: visiteur.diffusion,
      code_retrait: visiteur.codeRetrait,
    }),
  });
  // Choix faits avant l'accord : envoyés seulement maintenant, après la session.
  for (const c of visiteur.choixFaits) await envoyerChoix(c);
}

/** Met en file un choix du visiteur (qualification, aiguillage) : rattaché à sa session, renvoi sans doublon. */
async function envoyerChoix(/** @type {{ etape: string, option: string, quand: string }} */ c) {
  if (!visiteur || !file) return;
  await file.ajouter({
    methode: "PUT", chemin: `/api/cabine/sessions/${visiteur.id}/choix/${encodeURIComponent(c.etape)}`, type: "application/json",
    corps: JSON.stringify({ option_id: c.option, cree_le: c.quand }),
  });
}

function enregistrerChoix(/** @type {string} */ etape, /** @type {string} */ option) {
  if (!visiteur) return;
  const c = { etape, option, quand: new Date().toISOString() };
  visiteur.choixFaits = [...(visiteur.choixFaits ?? []).filter((x) => x.etape !== etape), c];
  if (visiteur.envoyee) envoyerChoix(c);
}

// ------------------------------------------------------------------ écrans du parcours

function aller(/** @type {string | null} */ id) {
  annulerEnCours?.(); annulerEnCours = null;
  if (!id || !moteur) return accueil();
  const e = moteur.etape(id);
  relancerInactivite();
  appliquerFond(/** @type {string | undefined} */ (e.fond));
  switch (e.type) {
    case "accueil": return ecranAccueil(e);
    case "identification": return ecranIdentification(e);
    case "consentement": return ecranConsentement(e);
    case "cadrage": return ecranCadrage(e);
    case "question": return ecranQuestion(e);
    case "choix": return ecranChoix(e);
    case "pause": return ecranPause(e);
    case "fin": return ecranFin(e);
    default: return aller(moteur.suivante(id));
  }
}

const suite = (/** @type {any} */ e, /** @type {string | undefined} */ choix = undefined) => aller(/** @type {any} */ (moteur).suivante(e.id, choix));

function accueil() {
  visiteur = null;
  activerFlou(false);
  appliquerFond(null);
  if (!config?.campagne || !moteur) return ecranAttente();
  aller(moteur.premiere());
}

function ecranAttente() {
  afficher([
    h("div", { class: "ecran" },
      h("h1", {}, "Bientôt prêt"),
      h("p", { class: "chapo" }, "Cette cabine attend le lancement de sa campagne.")),
  ], "attente");
  setTimeout(async () => { await chargerConfig(); if (!visiteur) accueil(); }, 30_000);
}

function ecranAccueil(/** @type {any} */ e) {
  const enPause = pauses();
  /** @type {string[]} */
  const bulles = Array.isArray(e.bulles) && e.bulles.length ? e.bulles : ["Bonjour !"];
  afficher([
    h("div", { class: "ecran" },
      h("div", { class: "deux" },
        h("div", { class: "colonne" },
          h("h1", {}, e.titre),
          e.texte ? h("p", { class: "chapo" }, e.texte) : null,
          visuelEtape(e, "visuel-accueil"),
          enPause.length ? h("div", { class: "actions" }, bouton("Je reviens", ecranReprise, "secondaire")) : null),
        h("section", { class: `carte conversation${e.bullesGrandes ? " grandes" : ""}`, "aria-label": tv("La cabine vous parle", "La cabine te parle") },
          ...bulles.map((t) => bulle("marque arrive", t)),
          h("p", { class: "bulle marque arrive ecrit", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
          h("div", { class: "actions droite arrive" }, bouton(e.bouton, () => { nouvelleSession(); suite(e); }))))),
  ], "accueil");
  reperes("accueil", null, e.surtitre ?? "");
}

function ecranReprise() {
  appliquerFond(null);
  const liste = pauses().sort((a, b) => a.prenom.localeCompare(b.prenom, "fr"));
  afficher([
    h("div", { class: "ecran" },
      bulle("marque grande arrive", tv("Content de vous revoir !", "Content de te revoir !")),
      h("p", { class: "chapo" }, tv("Touchez votre prénom pour reprendre là où vous en étiez.", "Touche ton prénom pour reprendre là où tu en étais.")),
      h("div", { class: "reprises" }, ...liste.map((p) => bouton(p.prenom, () => {
        visiteur = p.visiteur;
        retirerPause(p.id);
        activerFlou(Boolean(visiteur?.floutage));
        aller(p.reprise);
      }, "secondaire"))),
      h("button", { type: "button", class: "lien", onclick: accueil }, "Retour")),
  ], "reprise");
}

function ecranIdentification(/** @type {any} */ e) {
  if (!visiteur) return accueil();
  const v = visiteur;
  /** @type {{ cle: "prenom"|"nom"|"email", etiquette: string, indice: string, mode: "nom"|"email", max: number, principal: boolean }[]} */
  const defs = [{ cle: "prenom", etiquette: tv("Votre prénom", "Ton prénom"), indice: tv("Votre prénom", "Ton prénom"), mode: "nom", max: 40, principal: true }];
  if (e.demanderNom) defs.push({ cle: "nom", etiquette: "Nom, facultatif", indice: tv("Votre nom", "Ton nom"), mode: "nom", max: 60, principal: false });
  if (e.demanderEmail) defs.push({ cle: "email", etiquette: tv("E-mail, facultatif : pour retrouver vos vidéos et changer d'avis", "E-mail, facultatif : pour retrouver tes vidéos et changer d'avis"), indice: tv("vous@exemple.fr", "toi@exemple.fr"), mode: "email", max: 160, principal: false });

  // Accord sur cet écran (identification.accord) : entre le prénom et le bouton, obligatoire pour continuer.
  let accord = !e.accord;
  // Diffusion publique (réseaux sociaux…) sous l'accord, facultative, si la campagne la propose (débrief PFA, 14/10/2026).
  const diffusion = Boolean(e.accord && e.proposerDiffusion) && diffusionProposee(config.parcours) && Boolean(config.consentement?.texte_diffusion);
  if (!diffusion) v.diffusion = false;
  const continuer = bouton("Continuer", () => { if (!accord) return; if (e.accord) { if (!diffusion) v.diffusion = false; envoyerSession(); } suite(e); });
  const majBouton = () => continuer.toggleAttribute("disabled", v.prenom.trim().length < 1 || !accord);
  const marque = config.client?.nom ?? "la marque";
  const details = h("p", { class: "texte-legal", hidden: true }, config.consentement?.texte_interne ?? "");
  const blocAccord = e.accord ? h("div", { class: "accord-identification" },
    caseACocher(`J'accepte que ${marque} consulte mes réponses pour mieux comprendre l'avis de ses visiteurs.`, false,
      (x) => { accord = x; majBouton(); }, "Obligatoire pour commencer."),
    diffusion ? caseACocher(config.consentement.texte_diffusion, v.diffusion, (x) => { v.diffusion = x; }) : null,
    h("button", { type: "button", class: "lien", onclick: () => { details.hidden = !details.hidden; } }, tv("En savoir plus sur vos données", "En savoir plus sur tes données")),
    details) : null;
  const recontact = h("button", { type: "button", class: "case", role: "checkbox", "aria-checked": String(v.recontact), hidden: !v.email,
    onclick: () => { v.recontact = !v.recontact; recontact.setAttribute("aria-checked", String(v.recontact)); } },
    h("span", { class: "boite" }), h("span", {}, "J'accepte aussi d'être recontacté(e) par la marque."));

  const champs = defs.map((d) => {
    const valeur = h("span", { class: "valeur", "data-indice": d.indice, "data-vide": v[d.cle] ? "non" : "oui" }, v[d.cle]);
    const el = h("button", { type: "button", class: d.principal ? "champ bulle visiteur" : "champ secondaire", "aria-pressed": "false" },
      h("span", { class: "etiquette" }, d.etiquette), valeur);
    el.addEventListener("click", () => {
      scene.querySelectorAll(".champ").forEach((c) => c.setAttribute("aria-pressed", "false"));
      el.setAttribute("aria-pressed", "true");
      clavier.ouvrir(valeur, { mode: d.mode, max: d.max, valeur: v[d.cle], onChange: (x) => {
        v[d.cle] = x;
        if (d.cle === "email") { recontact.hidden = !x; if (!x) { v.recontact = false; recontact.setAttribute("aria-checked", "false"); } }
        majBouton();
        relancerInactivite();
      } });
    });
    return el;
  });

  // L'accord et le bouton vont sous le clavier : on tape son prénom, on coche, on continue, dans l'ordre de lecture.
  afficher([
    h("div", { class: "ecran" },
      h("div", { class: "colonne" },
        h("h1", { class: "bulle marque grande arrive" }, perso(e.titre)),
        e.texte ? bulle("marque douce moyenne arrive", perso(e.texte)) : null),
      h("div", { class: "champs" }, ...champs),
      recontact),
    h("div", { class: "sous-clavier" },
      blocAccord,
      h("div", { class: "actions droite" }, continuer)),
  ], "identification");
  majBouton();
  champs[0]?.click();
}

async function ecranConsentement(/** @type {any} */ e) {
  if (!visiteur) return accueil();
  const v = visiteur;
  // Accord et cadrage sur le même écran : la caméra s'ouvre tout de suite, l'ovale s'affiche sur l'image.
  if (e.avecCamera) {
    if (!(await preparerCamera())) return ecranErreurCamera();
    activerFlou(v.floutage);
  }
  const marque = config.client?.nom ?? "la marque";
  const proposee = Boolean(e.proposerDiffusion) && diffusionProposee(config.parcours) && Boolean(config.consentement?.texte_diffusion);
  if (!proposee) v.diffusion = false;
  let accord = false;
  const partir = bouton(e.bouton, async () => {
    if (!accord) return;
    if (v.floutage) await preparerCamera();
    envoyerSession();
    suite(e);
  });
  partir.toggleAttribute("disabled", true);
  const details = h("p", { class: "texte-legal", hidden: true }, config.consentement?.texte_interne ?? "");

  afficher([
    h("div", { class: `ecran${e.avecCamera ? " ecran-cadrage ecran-accord-camera" : ""}` },
      h("div", { class: "deux" },
        h("section", { class: "colonne", "aria-label": "Comment ça marche" },
          e.texte ? bulle("marque moyenne arrive", perso(e.texte)) : null,
          h("h1", {}, perso(e.titre)),
          e.avecCamera ? h("div", { class: "emplacement-camera" }) : null,
          !e.avecCamera && e.consignes?.length ? h("ol", { class: "consignes" }, ...e.consignes.map((/** @type {string} */ c, /** @type {number} */ i) => {
            const { chiffre, reste } = decouperConsigne(perso(c));
            return h("li", { class: "arrive", style: `animation-delay: ${0.15 * (i + 1)}s` }, h("span", { class: "chiffre", "aria-hidden": chiffre ? null : "true" }, chiffre ?? String(i + 1)), h("span", {}, reste));
          })) : null),
        h("section", { class: "carte accord", "aria-label": tv("Votre accord", "Ton accord") },
          h("div", { class: "cases" },
            caseACocher(`J'accepte que ${marque} consulte mes réponses pour mieux comprendre l'avis de ses visiteurs.`, false,
              (x) => { accord = x; partir.toggleAttribute("disabled", !x); }, "Obligatoire pour commencer."),
            proposee ? caseACocher(config.consentement.texte_diffusion, v.diffusion, (x) => { v.diffusion = x; }) : null,
            e.proposerFloutage ? caseACocher("Flouter mon visage", v.floutage, (x) => { v.floutage = x; if (e.avecCamera) activerFlou(x); }, tv("Votre voix reste, votre visage disparaît.", "Ta voix reste, ton visage disparaît.")) : null),
          h("button", { type: "button", class: "lien", onclick: () => { details.hidden = !details.hidden; } }, tv("En savoir plus sur vos données", "En savoir plus sur tes données")),
          details,
          h("div", { class: "actions" }, partir)))),
  ], "consentement");
}

async function ecranCadrage(/** @type {any} */ e) {
  if (!visiteur) return accueil();
  const v = visiteur;
  const ok = await preparerCamera();
  if (!ok) return ecranErreurCamera();
  activerFlou(v.floutage);
  afficher([
    h("div", { class: `ecran ecran-cadrage${e.conseils?.length ? " avec-conseils" : ""}` },
      e.texte ? bulle("marque moyenne arrive", perso(e.texte)) : null,
      h("div", { class: "texte-cadrage" },
        h("h1", { class: "bulle marque grande" }, perso(e.titre)),
        e.conseils?.length ? h("ul", { class: "conseils-cadrage" }, ...e.conseils.map((/** @type {string} */ c, /** @type {number} */ i) =>
          h("li", { class: "arrive", style: `animation-delay: ${0.15 * (i + 1)}s` }, h("span", { class: "puce", "aria-hidden": "true" }, String(i + 1)), h("span", {}, perso(c))))) : null,
        e.conclusion ? h("p", { class: "conclusion-cadrage arrive", style: `animation-delay: ${0.15 * ((e.conseils?.length ?? 0) + 1)}s` }, perso(e.conclusion)) : null),
      h("div", { class: "emplacement-camera" }),
      h("div", { class: "actions" },
        e.proposerFloutage ? h("div", { class: "cases" }, caseACocher("Flouter mon visage", v.floutage, (x) => { v.floutage = x; activerFlou(x); })) : null,
        e.reperes === false ? null : h("ul", { class: "verifs-cadrage", "aria-live": "polite" },
          repere("v-lumiere", "Lumière"),
          repere("v-son", tv("Son : dites « bonjour »", "Son : dis « bonjour »")),
          detectionDisponible() ? repere("v-visage", "Visage dans l'ovale") : null),
        h("span", { style: "flex: 1" }),
        bouton("Je suis prêt", () => { envoyerSession(); suite(e); }))),
  ], "cadrage");
  if (e.reperes !== false) suivreCadrage(); else $("guide-cadrage").classList.remove("ok");
}

/** Repère de l'écran de cadrage : pastille (en attente, ok, à corriger) et libellé. */
const repere = (/** @type {string} */ id, /** @type {string} */ libelle) => h("li", { id }, h("span", { class: "etat", "aria-hidden": "true" }, "…"), h("span", {}, libelle));

/** Lumière de l'image : moyenne générale, centre (visage) et bords (contre-jour), sur une image réduite. */
function mesurerImage() {
  const c = document.createElement("canvas");
  c.width = 48; c.height = 36;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g || !video.videoWidth) return null;
  g.drawImage(video, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let total = 0, centre = 0, nc = 0, bords = 0, nb = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      total += l;
      if (x > c.width * 0.32 && x < c.width * 0.68 && y > c.height * 0.12 && y < c.height * 0.68) { centre += l; nc++; } else { bords += l; nb++; }
    }
  }
  return { moyenne: total / (c.width * c.height), centre: centre / nc, bords: bords / nb };
}

/**
 * Repères de cadrage, comme pour Why me : lumière (image assez claire, pas de contre-jour), son (la personne a dit
 * bonjour) et visage bien placé quand le navigateur sait le détecter. Chaque repère passe au vert ; l'ovale aussi
 * quand tout est bon. Rien n'est bloquant : « Je suis prêt » reste toujours disponible.
 * S'arrête seul en quittant l'écran de cadrage.
 */
function suivreCadrage() {
  const guide = $("guide-cadrage");
  guide.classList.remove("ok");
  /** @type {any} */ const detecteur = detectionDisponible() ? new (/** @type {any} */ (globalThis)).FaceDetector({ fastMode: true, maxDetectedFaces: 1 }) : null;
  let voixMs = 0, precedent = performance.now(), sonOk = false;
  vumetre?.reprendre();
  const marquer = (/** @type {string} */ id, /** @type {boolean | null} */ ok) => {
    const li = document.getElementById(id);
    if (!li) return;
    li.dataset.etat = ok === null ? "" : ok ? "ok" : "ko";
    /** @type {HTMLElement} */ (li.querySelector(".etat")).textContent = ok === null ? "…" : ok ? "✓" : "!";
  };
  const tour = async () => {
    if (!document.querySelector(".ecran-cadrage")) { guide.classList.remove("ok"); return; }
    const t = performance.now();
    if ((vumetre?.niveau() ?? 0) > 0.3) voixMs += t - precedent;
    precedent = t;
    sonOk ||= voixMs > 300;
    const img = mesurerImage();
    const lumiere = img ? img.moyenne > 50 && img.bords - img.centre < 70 : null;
    let visage = true;
    if (detecteur) {
      try {
        const [v] = video.videoWidth ? await detecteur.detect(video) : [];
        const b = v?.boundingBox;
        visage = Boolean(b) && Math.abs((b.x + b.width / 2) / video.videoWidth - 0.5) < 0.15
          && (b.y + b.height / 2) / video.videoHeight > 0.25 && (b.y + b.height / 2) / video.videoHeight < 0.6 && b.width / video.videoWidth > 0.14;
      } catch { visage = false; }
      marquer("v-visage", visage);
    }
    marquer("v-lumiere", lumiere);
    marquer("v-son", sonOk ? true : null);
    guide.classList.toggle("ok", Boolean(lumiere) && sonOk && visage);
    setTimeout(tour, 250);
  };
  tour();
}

function ecranErreurCamera() {
  afficher([
    h("div", { class: "ecran" },
      h("h1", {}, "Caméra indisponible"),
      h("p", { class: "chapo" }, tv("La caméra ou le micro ne répond pas. Prévenez un conseiller : la cabine revient à l'accueil.", "La caméra ou le micro ne répond pas. Préviens un conseiller : la cabine revient à l'accueil."))),
  ], "erreur");
  setTimeout(accueil, 8000);
}

/** Compte à rebours sur l'aperçu : la bulle jaune et « On tourne dans N s ». */
function compte(/** @type {number} */ n) {
  $("compte").hidden = n <= 0;
  $("compte-chiffre").textContent = n > 0 ? String(n) : "";
  $("compte-detail").textContent = n > 1 ? `On tourne dans ${n} s` : "On tourne !";
}

async function ecranQuestion(/** @type {any} */ e) {
  if (!visiteur || !moteur) return accueil();
  const v = visiteur;
  if (!(await preparerCamera()) || !camera || !vumetre) return ecranErreurCamera();
  activerFlou(v.floutage);
  envoyerSession();
  const progression = moteur.progression(e.id, v.repondues);
  const derniere = progression.numero >= progression.total;
  /** @type {(() => void) | null} */ let arret = null;
  // Disposition centrée : pendant la lecture, le bouton permet de démarrer sans attendre la fin du compte à rebours.
  const centree = config?.parcours?.disposition === "centree";
  let enCours = false;
  const libelleSuivant = derniere ? "J'ai terminé" : "Question suivante";
  const suivant = bouton(centree ? "Je suis prêt" : libelleSuivant, () => { if (enCours) arret?.(); else if (centree) lancer(); }, "plein");
  suivant.toggleAttribute("disabled", !centree);
  const remplissage = h("span");
  const barre = h("div", { class: "barre-temps", role: "progressbar", "aria-label": "Temps restant" }, remplissage);
  const secondes = h("span", {}, `${e.dureeMaxSec} s`);
  const aPistes = Boolean(e.pistes?.length || e.aide);
  const texte = perso(e.texte);

  // Disposition V2 : la marque à gauche (question, idées, amorce), le visiteur à droite (temps, image, bouton).
  afficher([
    h("div", { class: "ecran ecran-question", "data-phase": "lire" },
      h("section", { class: "gauche", "aria-label": "La question" },
        h("div", { class: "tete arrive" },
          h("span", { class: "etiquette-pastille titre-court" }, e.titreCourt ?? `Question ${progression.numero}`),
          h("p", { class: "bulle marque grande question", "data-longueur": texte.length > 90 ? "longue" : texte.length > 55 ? "moyenne" : null }, texte),
          // Le temps pour réfléchir (et répondre), sous la question : valeurs réelles de l'étape.
          e.mentionTemps ? h("p", { class: "mention-temps" }, perso(e.mentionTemps)
            .replaceAll("{lecture}", String(Math.max(0, Number(e.compteARebours ?? 5))))
            .replaceAll("{duree}", String(e.dureeMaxSec))) : null),
        aPistes ? h("div", { class: "aide" },
          e.intitulePistes === "" ? null : h("span", { class: "intitule" }, e.intitulePistes ?? "Des idées, si besoin"),
          e.pistes?.length ? h("div", { class: "pistes" }, ...e.pistes.map((/** @type {string} */ p) => h("span", {}, p))) : null,
          e.aide ? h("p", { class: "chapo" }, perso(e.aide)) : null) : null,
        e.coupDePouce ? h("div", { class: "coup-de-pouce" },
          h("span", { class: "intitule" }, "Pour démarrer"),
          bulle("visiteur douce", perso(e.coupDePouce))) : null,
        visuelEtape(e, "visuel-question")),
      h("section", { class: "droite", "aria-label": tv("Votre réponse", "Ta réponse") },
        h("div", { class: "temps" }, h("div", { class: "emplacement-ecoute" }), barre, secondes),
        h("div", { class: "zone-camera" }, h("div", { class: "emplacement-camera" })),
        h("div", { class: "actions" }, suivant))),
  ], "question");
  ecoute.dataset.etat = "lire";
  reperes("question", progression);

  let annule = false;
  annulerEnCours = () => { annule = true; arret?.(); compte(0); $("rec").hidden = true; delete ecoute.dataset.etat; delete apercu.dataset.rec; };
  vumetre.reprendre();
  arreterInactivite();
  const temps = (/** @type {number} */ f) => { remplissage.style.transform = `scaleX(${Math.max(0, Math.min(1, f))})`; };
  temps(1);

  // Le temps de lire : compte à rebours sur l'aperçu, puis la caméra tourne.
  let reste = Math.max(0, Number(e.compteARebours ?? 5));
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let minuterie;
  const decompte = () => {
    if (annule || enCours) return;
    if (reste > 0) { compte(reste); reste -= 1; minuterie = setTimeout(decompte, 1000); return; }
    compte(0);
    lancer();
  };

  const lancer = () => {
    if (enCours) return;
    enCours = true;
    clearTimeout(minuterie);
    compte(0);
    suivant.textContent = libelleSuivant;
    document.querySelector(".ecran-question")?.setAttribute("data-phase", "rec");
    $("rec").hidden = false;
    ecoute.dataset.etat = "rec";
    apercu.dataset.rec = "";
    barre.dataset.etat = "rec";
    suivant.toggleAttribute("disabled", false);
    const prise = enregistrer({
      flux: fluxAEnregistrer(), vumetre: /** @type {any} */ (vumetre),
      dureeMaxSec: e.dureeMaxSec, silenceArretSec: e.silenceArretSec ?? 3,
      surNiveau: (n, ecoule) => {
        onde(n); temps(1 - ecoule / e.dureeMaxSec);
        $("chrono").textContent = chrono(ecoule);
        secondes.textContent = `${Math.max(0, Math.ceil(e.dureeMaxSec - ecoule))} s`;
      },
    });
    arret = prise.arreter;
    /** @type {Promise<Blob | null>} */
    let miniature = Promise.resolve(null);
    const minuterieMiniature = setTimeout(() => { miniature = prendreMiniature(); }, 1200);
    prise.resultat.then(async (r) => {
      clearTimeout(minuterieMiniature);
      $("rec").hidden = true;
      delete ecoute.dataset.etat;
      delete apercu.dataset.rec;
      onde(0);
      $("chrono").textContent = "0:00";
      if (annule) return;
      v.repondues.push(e.id);
      await file?.ajouter({
        methode: "PUT", chemin: `/api/cabine/sessions/${v.id}/reponses/${encodeURIComponent(e.id)}`,
        type: r.type.split(";")[0] ?? "video/webm", corps: r.blob,
        entetes: { "x-duree-ms": String(r.dureeMs), "x-son-present": r.sonPresent ? "1" : "0" },
      });
      const image = await miniature.catch(() => null);
      if (image) {
        await file?.ajouter({ methode: "PUT", chemin: `/api/cabine/sessions/${v.id}/reponses/${encodeURIComponent(e.id)}/miniature`, type: "image/jpeg", corps: image });
      }
      suite(e);
    }).catch(() => ecranErreurCamera());
  };
  decompte();
}

function ecranChoix(/** @type {any} */ e) {
  /** Fond d'une option : la couleur (ou le dégradé) de son fond. */
  const styleOption = (/** @type {any} */ o) => {
    const a = o.fond ? fonds.get(o.fond) : null;
    if (!a) return undefined;
    return `--fond-option: ${a.couleurBas ? `linear-gradient(180deg, ${a.couleur}, ${a.couleurBas})` : a.couleur}; --texte-option: ${a.texte}`;
  };
  afficher([
    h("div", { class: "ecran" },
      h("h1", { class: "bulle marque grande arrive" }, perso(e.titre)),
      h("div", { class: "options" }, ...e.options.map((/** @type {any} */ o) =>
        h("button", { type: "button", class: "option", style: styleOption(o), onclick: () => { enregistrerChoix(e.id, o.id); suite(e, o.id); } },
          imageVisuel(o.visuel ?? null, "", "") ?? (o.image ? h("img", { src: o.image, alt: "" }) : null),
          h("span", { class: "libelle" }, o.libelle),
          o.detail ? h("span", { class: "detail" }, perso(o.detail)) : null)))),
  ], "choix");
}

function ecranPause(/** @type {any} */ e) {
  if (!visiteur || !moteur) return accueil();
  envoyerSession();
  enregistrerPause(/** @type {string} */ (moteur.suivante(e.id)));
  const prenom = visiteur.prenom;
  activerFlou(false);
  afficher([
    h("div", { class: "ecran" },
      h("h1", { class: "bulle marque grande arrive" }, perso(e.titre)),
      e.texte ? bulle("marque moyenne arrive", perso(e.texte)) : null,
      bulle("marque douce moyenne arrive", tv(`À votre retour, touchez « Je reviens » puis « ${prenom || "votre prénom"} ».`, `À ton retour, touche « Je reviens » puis « ${prenom || "ton prénom"} ».`)),
      visuelEtape(e, "visuel-fin"),
      h("div", { class: "actions droite" }, bouton(e.bouton, accueil))),
  ], "pause");
  const ecran = numeroEcran;
  setTimeout(() => { if (numeroEcran === ecran) accueil(); }, 12_000);
}

/**
 * Rappel du droit de changer d'avis : le QR code affiché à l'extérieur de la cabine mène à la page où l'on retire
 * son accord ou supprime ses vidéos (avec l'e-mail donné à l'identification).
 */
function rappelRetrait() {
  const picto = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  picto.setAttribute("viewBox", "0 0 24 24");
  picto.setAttribute("class", "picto-qr");
  picto.setAttribute("aria-hidden", "true");
  picto.innerHTML = '<g fill="currentColor"><path d="M3 3h7v7H3zM5 5v3h3V5zM14 3h7v7h-7zm2 2v3h3V5zM3 14h7v7H3zm2 2v3h3v-3z"/><path d="M14 14h3v3h-3zM18 14h3v3h-3zM14 18h3v3h-3zM18 18h3v3h-3z"/></g>';
  return h("div", { class: "carte retrait arrive" }, picto,
    h("div", { class: "texte-retrait" },
      h("strong", {}, tv("Vous changez d'avis ?", "Tu changes d'avis ?")),
      h("span", {}, tv(
        "Scannez le QR code à l'extérieur de la cabine : vous pourrez retirer votre accord ou supprimer vos vidéos, à tout moment.",
        "Scanne le QR code à l'extérieur de la cabine : tu pourras retirer ton accord ou supprimer tes vidéos, à tout moment."))));
}

function ecranFin(/** @type {any} */ e) {
  if (visiteur) retirerPause(visiteur.id);
  activerFlou(false);
  const nb = visiteur?.repondues.length ?? 0;
  let reste = Math.max(3, Number(e.retourAccueilSec ?? 20));
  const libelle = h("span", {}, `Retour à l'accueil dans ${reste} s`);
  const coche = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  coche.setAttribute("viewBox", "0 0 24 24");
  coche.setAttribute("aria-hidden", "true");
  coche.innerHTML = '<path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>';
  afficher([
    h("div", { class: "ecran" },
      h("div", { class: "deux" },
        h("section", { class: "colonne", "aria-label": "Fin de la conversation" },
          h("h1", { class: "bulle marque grande arrive" }, perso(e.titre)),
          nb ? h("p", { class: "bulle visiteur envoye arrive" }, coche, nb > 1 ? `${nb} réponses envoyées` : "1 réponse envoyée") : null,
          e.texte ? bulle("marque moyenne arrive", perso(e.texte)) : null,
          visuelEtape(e, "visuel-fin")),
        h("div", { class: "colonne" },
          e.sortie ? h("p", { class: "sortie" }, perso(e.sortie)) : null,
          rappelRetrait())),
      h("div", { class: "retour", style: `--duree: ${reste}s` }, h("div", { class: "barre" }, h("span")), libelle)),
  ], "fin");
  const ecran = numeroEcran;
  const tic = () => {
    if (numeroEcran !== ecran) return;
    if (--reste <= 0) return accueil();
    libelle.textContent = `Retour à l'accueil dans ${reste} s`;
    setTimeout(tic, 1000);
  };
  setTimeout(tic, 1000);
}

// ------------------------------------------------------------------ inactivité, état, signal

function arreterInactivite() { clearTimeout(minuterieInactivite); }
function relancerInactivite() {
  arreterInactivite();
  minuterieInactivite = window.setTimeout(() => {
    // Visiteur parti en cours de route : ses réponses déjà filmées partent quand même.
    if (visiteur) envoyerSession();
    accueil();
  }, INACTIVITE_MS);
}
document.addEventListener("pointerdown", () => { if (visiteur) relancerInactivite(); }, { passive: true });

function etatReseau(/** @type {number} */ enAttente, /** @type {boolean} */ enLigne) {
  const el = $("etat-reseau");
  el.dataset.etat = enLigne ? "en-ligne" : "hors-ligne";
  el.textContent = !enLigne ? `Hors ligne · ${enAttente} envoi(s) en attente` : enAttente ? `${enAttente} envoi(s) en cours` : "";
}

async function signal() {
  if (!jeton() || !navigator.onLine) return;
  /** @type {any} */ let batterie = null;
  try { batterie = await /** @type {any} */ (navigator).getBattery?.(); } catch {}
  const conn = /** @type {any} */ (navigator).connection;
  await api("/api/cabine/signal", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reseau: conn?.effectiveType ?? "en ligne", batterie: batterie?.level, en_charge: batterie?.charging,
      file: await file?.compter(), micro: Boolean(camera?.getAudioTracks()[0]?.readyState === "live"), version: VERSION,
    }),
  }).catch(() => {});
}

// ------------------------------------------------------------------ démarrage

/** Aperçu depuis l'éditeur de Parlorama : le brouillon est joué tel quel, rien n'est envoyé ni enregistré. */
const APERCU = new URLSearchParams(location.search).get("apercu") === "1";

async function demarrerApercu() {
  try { config = JSON.parse(localStorage.getItem("voxbox.apercu") ?? "null"); } catch { config = null; }
  if (!config?.parcours) {
    return afficher([h("div", { class: "ecran" }, h("h1", {}, "Aperçu indisponible"), h("p", { class: "chapo" }, "Rouvrez l'aperçu depuis l'éditeur de parcours de Parlorama."))], "erreur");
  }
  moteur = creerMoteur(config.parcours);
  appliquerHabillage();
  document.body.append(h("div", { class: "bandeau-apercu" }, "Aperçu : rien n'est enregistré"));
  await preparerCamera();
  accueil();
  // Mise à jour en direct quand l'éditeur rouvre l'aperçu avec un nouveau brouillon.
  window.addEventListener("storage", (e) => {
    if (e.key !== "voxbox.apercu" || !e.newValue) return;
    try { config = JSON.parse(e.newValue); moteur = creerMoteur(config.parcours); appliquerHabillage(); accueil(); } catch { /* brouillon illisible */ }
  });
}

/** Rend la cabine installable en application plein écran (voir sw.js). Sans effet si le navigateur ne sait pas. */
function enregistrerApplication() {
  try { navigator.serviceWorker?.register("sw.js").catch(() => {}); } catch { /* navigateur sans service worker */ }
}

async function demarrer() {
  if (APERCU) return demarrerApercu();
  enregistrerApplication();
  if (!formatEnregistrement()) {
    return afficher([h("div", { class: "ecran" }, h("h1", {}, "Navigateur non compatible"), h("p", { class: "chapo" }, "Ce navigateur ne sait pas enregistrer la vidéo avec le son. Utilisez Chrome à jour."))], "erreur");
  }
  if (!jeton()) return ecranAppairage();
  const etat = await chargerConfig();
  if (etat === "desappairee") return ecranAppairage("Cette cabine a été déconnectée. Saisissez un nouveau code.");
  file ??= await creerFileEnvoi({ jeton, surEtat: etatReseau, surRejet: (envoi, statut) => console.warn("Envoi refusé", statut, envoi.chemin) });
  await preparerCamera();
  accueil();
  signal();
  setInterval(signal, 60_000);
  // Configuration rafraîchie régulièrement, appliquée seulement entre deux visiteurs.
  setInterval(async () => { if (!visiteur) { await chargerConfig(); if (!visiteur) accueil(); } }, 5 * 60_000);
}

window.addEventListener("online", () => file?.traiter());
window.addEventListener("offline", async () => etatReseau((await file?.compter()) ?? 0, false));
demarrer();
