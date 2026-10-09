// @ts-check
// Application de la cabine : affiche le parcours écran par écran, filme, met les envois en file.

import { creerMoteur, diffusionProposee } from "./moteur.js";
import { creerClavier } from "./clavier.js";
import { ouvrirCamera, creerVumetre, enregistrer, formatEnregistrement } from "./enregistreur.js";
import { creerFlou, detectionDisponible } from "./flou.js";
import { creerFileEnvoi } from "./file-envoi.js";

const VERSION = "0.2.0";
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
 *   floutage: boolean, repondues: string[], creeLe: string, envoyee: boolean, parcoursVersion: string, consentVersion: string }}
 */
let visiteur = null;
let minuterieInactivite = 0;
let numeroEcran = 0;
/** @type {(() => void) | null} */ let annulerEnCours = null;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const scene = $("scene");
const clavier = creerClavier($("clavier"));
const cadre = /** @type {HTMLElement} */ (document.querySelector(".cadre"));
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

function afficher(/** @type {(Node|null)[]} */ contenu, { camera: avecCamera = false } = {}) {
  clavier.fermer();
  $("zone-camera").hidden = !avecCamera;
  $("cabine").classList.toggle("sans-camera", !avecCamera);
  scene.replaceChildren(.../** @type {Node[]} */ (contenu.filter(Boolean)));
  const premier = scene.querySelector("button");
  if (premier instanceof HTMLElement) premier.focus({ preventScroll: true });
  numeroEcran += 1;
}

function etatCadre(/** @type {string} */ etat) { cadre.dataset.etat = etat; }

function anneauTemps(/** @type {number} */ fraction) {
  // Propriété de style (et non attribut) : la feuille de style l'emporterait sur l'attribut.
  $("anneau-temps").style.strokeDashoffset = String(100 - Math.max(0, Math.min(1, fraction)) * 100);
}
function anneauVoix(/** @type {number} */ niveau) {
  $("anneau-voix").style.transform = `scale(${1 + niveau * 0.06})`;
  $("anneau-voix").style.opacity = String(0.25 + niveau * 0.75);
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
    h("h1", {}, "Appairer cette cabine"),
    h("p", {}, "Saisissez le code affiché dans l'espace WhyMe, fiche de la cabine."),
    h("div", { class: "champ", "aria-pressed": "true" }, h("span", { class: "etiquette" }, "Code d'appairage"), champ),
    message ? h("p", { role: "alert" }, message) : null,
    h("div", { class: "actions" }, valider),
  ]);
  clavier.ouvrir(champ, { mode: "code", max: 6, onChange: (v) => valider.toggleAttribute("disabled", v.length !== 6) });
}

async function chargerConfig() {
  try {
    const res = await api("/api/cabine/config");
    if (res.status === 401) { localStorage.removeItem(CLE_JETON); return "desappairee"; }
    if (!res.ok) throw new Error(String(res.status));
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

function appliquerHabillage() {
  const client = config?.client;
  const racine = document.documentElement.style;
  const principale = client?.couleurs?.principale;
  if (principale) {
    racine.setProperty("--marque", principale);
    racine.setProperty("--sur-marque", contraste(principale));
  } else {
    racine.removeProperty("--marque"); racine.removeProperty("--sur-marque");
  }
  $("marque").textContent = client?.nom ?? "";
  const logo = /** @type {HTMLImageElement} */ ($("logo"));
  logo.hidden = !client?.logo_url;
  if (client?.logo_url) { logo.src = client.logo_url; logo.alt = client.nom ?? ""; }
}

/** Blanc ou encre selon la luminance de la couleur de marque. */
function contraste(/** @type {string} */ hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * /** @type {number} */ (r) + 0.7152 * /** @type {number} */ (g) + 0.0722 * /** @type {number} */ (b);
  return L > 0.4 ? "#221F3A" : "#FFFFFF";
}

// ------------------------------------------------------------------ caméra

async function preparerCamera() {
  if (camera) return true;
  try {
    const orientation = window.matchMedia("(orientation: portrait)").matches ? "portrait" : "paysage";
    camera = await ouvrirCamera(orientation);
    video.srcObject = camera;
    await video.play().catch(() => {});
    vumetre = creerVumetre(camera);
    return true;
  } catch {
    return false;
  }
}

function activerFlou(/** @type {boolean} */ actif) {
  const existant = cadre.querySelector("canvas");
  if (actif && !flou) {
    flou = creerFlou(video, { niveau: "fort" });
    cadre.insertBefore(flou.canevas, video.nextSibling);
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

function nouvelleSession() {
  visiteur = {
    id: crypto.randomUUID(), prenom: "", nom: "", email: "", recontact: false, diffusion: false,
    floutage: false, repondues: [], creeLe: new Date().toISOString(), envoyee: false,
    parcoursVersion: config.campagne.parcours_version_id, consentVersion: config.consentement.id,
  };
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
    }),
  });
}

// ------------------------------------------------------------------ écrans du parcours

function aller(/** @type {string | null} */ id) {
  annulerEnCours?.(); annulerEnCours = null;
  if (!id || !moteur) return accueil();
  const e = moteur.etape(id);
  relancerInactivite();
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

const suite = (/** @type {any} */ e, /** @type {string} */ choix = undefined) => aller(/** @type {any} */ (moteur).suivante(e.id, choix));

function accueil() {
  visiteur = null;
  activerFlou(false);
  etatCadre("");
  if (!config?.campagne || !moteur) return ecranAttente();
  aller(moteur.premiere());
}

function ecranAttente() {
  afficher([
    h("h1", {}, "Bientôt prêt"),
    h("p", {}, "Cette cabine attend le lancement de sa campagne."),
  ]);
  setTimeout(async () => { await chargerConfig(); if (!visiteur) accueil(); }, 30_000);
}

function ecranAccueil(/** @type {any} */ e) {
  const enPause = pauses();
  afficher([
    h("h1", {}, e.titre),
    e.texte ? h("p", {}, e.texte) : null,
    h("div", { class: "actions" },
      bouton(e.bouton, () => { nouvelleSession(); suite(e); }),
      enPause.length ? bouton("Je reviens", ecranReprise, "secondaire") : null,
    ),
  ]);
}

function ecranReprise() {
  const liste = pauses().sort((a, b) => a.prenom.localeCompare(b.prenom, "fr"));
  afficher([
    h("h1", {}, "Content de vous revoir"),
    h("p", {}, "Touchez votre prénom pour reprendre là où vous en étiez."),
    h("div", { class: "reprises" }, ...liste.map((p) => bouton(p.prenom, () => {
      visiteur = p.visiteur;
      retirerPause(p.id);
      activerFlou(Boolean(visiteur?.floutage));
      aller(p.reprise);
    }, "secondaire"))),
    h("div", { class: "actions" }, h("button", { type: "button", class: "lien", onclick: accueil }, "Retour")),
  ]);
}

function ecranIdentification(/** @type {any} */ e) {
  if (!visiteur) return accueil();
  const v = visiteur;
  /** @type {{ cle: "prenom"|"nom"|"email", etiquette: string, indice: string, mode: "nom"|"email", max: number }[]} */
  const defs = [{ cle: "prenom", etiquette: "Prénom", indice: "Votre prénom", mode: "nom", max: 40 }];
  if (e.demanderNom) defs.push({ cle: "nom", etiquette: "Nom (facultatif)", indice: "Votre nom", mode: "nom", max: 60 });
  if (e.demanderEmail) defs.push({ cle: "email", etiquette: "E-mail (facultatif)", indice: "vous@exemple.fr", mode: "email", max: 160 });

  const continuer = bouton("Continuer", () => suite(e));
  const majBouton = () => continuer.toggleAttribute("disabled", v.prenom.trim().length < 1);
  const recontact = h("button", { type: "button", class: "case", role: "checkbox", "aria-checked": String(v.recontact), hidden: !v.email,
    onclick: () => { v.recontact = !v.recontact; recontact.setAttribute("aria-checked", String(v.recontact)); } },
    h("span", { class: "boite" }), h("span", {}, "J'accepte d'être recontacté(e) par la marque."));

  const champs = defs.map((d) => {
    const valeur = h("span", { class: "valeur", "data-indice": d.indice, "data-vide": v[d.cle] ? "non" : "oui" }, v[d.cle]);
    const el = h("button", { type: "button", class: "champ", "aria-pressed": "false" }, h("span", { class: "etiquette" }, d.etiquette), valeur);
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

  afficher([
    h("h1", {}, e.titre),
    h("div", { class: "champs" }, ...champs),
    recontact,
    h("div", { class: "actions" }, continuer),
  ]);
  majBouton();
  champs[0]?.click();
}

function ecranConsentement(/** @type {any} */ e) {
  if (!visiteur) return accueil();
  const v = visiteur;
  const proposee = Boolean(e.proposerDiffusion) && diffusionProposee(config.parcours) && Boolean(config.consentement?.texte_diffusion);
  if (!proposee) v.diffusion = false;
  const details = h("p", { class: "texte-legal", hidden: true }, config.consentement?.texte_interne ?? "");
  const caseDiffusion = proposee
    ? h("button", { type: "button", class: "case", role: "checkbox", "aria-checked": String(v.diffusion),
        onclick: () => { v.diffusion = !v.diffusion; caseDiffusion?.setAttribute("aria-checked", String(v.diffusion)); } },
        h("span", { class: "boite" }), h("span", {}, config.consentement.texte_diffusion))
    : null;
  afficher([
    h("h1", {}, e.titre),
    h("p", {}, "Vos réponses sont filmées pour aider la marque à comprendre l'avis de ses clients. Elles restent à usage interne."),
    caseDiffusion,
    h("button", { type: "button", class: "lien", onclick: () => { details.hidden = !details.hidden; } }, "En savoir plus"),
    details,
    h("div", { class: "actions" }, bouton(e.bouton, () => suite(e))),
  ]);
}

async function ecranCadrage(/** @type {any} */ e) {
  if (!visiteur) return accueil();
  const v = visiteur;
  const ok = await preparerCamera();
  if (!ok) return ecranErreurCamera();
  etatCadre("");
  anneauTemps(0);
  activerFlou(v.floutage);
  const caseFlou = e.proposerFloutage
    ? h("button", { type: "button", class: "case", role: "checkbox", "aria-checked": String(v.floutage),
        onclick: () => { v.floutage = !v.floutage; caseFlou?.setAttribute("aria-checked", String(v.floutage)); activerFlou(v.floutage); } },
        h("span", { class: "boite" }), h("span", {}, "Flouter mon visage"))
    : null;
  afficher([
    h("h1", {}, e.titre),
    h("p", {}, v.floutage && !detectionDisponible() ? "Toute l'image sera floutée." : "Restez bien dans le cercle pendant vos réponses."),
    caseFlou,
    h("div", { class: "actions" }, bouton("Je suis prêt", () => { envoyerSession(); suite(e); })),
  ], { camera: true });
}

function ecranErreurCamera() {
  afficher([
    h("h1", {}, "Caméra indisponible"),
    h("p", {}, "La caméra ou le micro ne répond pas. Prévenez un conseiller ; la cabine va revenir à l'accueil."),
  ]);
  setTimeout(accueil, 8000);
}

function ecranQuestion(/** @type {any} */ e) {
  if (!visiteur || !camera || !vumetre || !moteur) return accueil();
  const v = visiteur;
  envoyerSession();
  const { numero, total } = moteur.progression(e.id, v.repondues);
  const suivant = bouton(numero >= total ? "Terminer" : "Question suivante", () => arret?.());
  suivant.toggleAttribute("disabled", true);
  afficher([
    h("span", { class: "progression" }, `Question ${numero} sur ${total}`),
    h("p", { class: "question" }, e.texte),
    e.aide ? h("p", {}, e.aide) : null,
    h("div", { class: "actions" }, suivant),
  ], { camera: true });

  /** @type {(() => void) | null} */ let arret = null;
  let annule = false;
  annulerEnCours = () => { annule = true; arret?.(); $("compte").textContent = ""; $("voyant").hidden = true; };
  vumetre.reprendre();
  arreterInactivite();

  // Compte à rebours, puis enregistrement.
  const attente = Math.max(0, Number(e.compteARebours ?? 4));
  let reste = attente;
  etatCadre("compte");
  anneauTemps(1);
  const decompte = () => {
    if (annule) return;
    if (reste > 0) {
      $("compte").textContent = String(reste);
      anneauTemps(reste / Math.max(attente, 1));
      reste -= 1;
      setTimeout(decompte, 1000);
      return;
    }
    $("compte").textContent = "";
    lancer();
  };

  const lancer = () => {
    etatCadre("rec");
    $("voyant").hidden = false;
    suivant.toggleAttribute("disabled", false);
    const prise = enregistrer({
      flux: fluxAEnregistrer(), vumetre: /** @type {any} */ (vumetre),
      dureeMaxSec: e.dureeMaxSec, silenceArretSec: e.silenceArretSec ?? 3,
      surNiveau: (n, ecoule) => { anneauVoix(n); anneauTemps(1 - ecoule / e.dureeMaxSec); },
    });
    arret = prise.arreter;
    prise.resultat.then(async (r) => {
      $("voyant").hidden = true;
      etatCadre("");
      anneauVoix(0);
      if (annule) return;
      v.repondues.push(e.id);
      await file?.ajouter({
        methode: "PUT", chemin: `/api/cabine/sessions/${v.id}/reponses/${encodeURIComponent(e.id)}`,
        type: r.type.split(";")[0] ?? "video/webm", corps: r.blob,
        entetes: { "x-duree-ms": String(r.dureeMs), "x-son-present": r.sonPresent ? "1" : "0" },
      });
      suite(e);
    }).catch(() => ecranErreurCamera());
  };
  decompte();
}

function ecranChoix(/** @type {any} */ e) {
  afficher([
    h("h1", {}, e.titre),
    h("div", { class: "options" }, ...e.options.map((/** @type {any} */ o) =>
      h("button", { type: "button", class: "option", onclick: () => suite(e, o.id) },
        o.image ? h("img", { src: o.image, alt: "" }) : null, o.libelle))),
  ]);
}

function ecranPause(/** @type {any} */ e) {
  if (!visiteur || !moteur) return accueil();
  envoyerSession();
  enregistrerPause(/** @type {string} */ (moteur.suivante(e.id)));
  const prenom = visiteur.prenom;
  activerFlou(false);
  afficher([
    h("h1", {}, e.titre),
    h("p", {}, e.texte ?? ""),
    h("p", {}, `À votre retour, touchez « Je reviens » puis « ${prenom || "votre prénom"} ».`),
    h("div", { class: "actions" }, bouton(e.bouton, accueil)),
  ]);
  const ecran = numeroEcran;
  setTimeout(() => { if (numeroEcran === ecran) accueil(); }, 12_000);
}

function ecranFin(/** @type {any} */ e) {
  if (visiteur) retirerPause(visiteur.id);
  activerFlou(false);
  afficher([h("h1", {}, e.titre), e.texte ? h("p", {}, e.texte) : null]);
  const ecran = numeroEcran;
  setTimeout(() => { if (numeroEcran === ecran) accueil(); }, Math.max(3, Number(e.retourAccueilSec ?? 10)) * 1000);
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

async function demarrer() {
  if (!formatEnregistrement()) {
    return afficher([h("h1", {}, "Navigateur non compatible"), h("p", {}, "Ce navigateur ne sait pas enregistrer la vidéo avec le son. Utilisez Chrome à jour.")]);
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
