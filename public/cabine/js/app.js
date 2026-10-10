// @ts-check
// Application de la cabine : affiche le parcours écran par écran, filme, met les envois en file.

import { creerMoteur, diffusionProposee, personnaliser, decouperConsigne } from "./moteur.js";
import { creerClavier } from "./clavier.js";
import { ouvrirCamera, creerVumetre, enregistrer, formatEnregistrement } from "./enregistreur.js";
import { creerFlou, detectionDisponible } from "./flou.js";
import { creerFileEnvoi } from "./file-envoi.js";

const VERSION = "0.3.0";
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
const apercu = $("apercu");
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
  // L'aperçu caméra est un élément unique, déplacé dans l'écran qui le demande.
  const place = scene.querySelector(".emplacement-camera");
  if (place) { place.append(apercu); apercu.hidden = false; video.play().catch(() => {}); }
  else if (apercu.parentElement !== document.body) { apercu.hidden = true; document.body.append(apercu); }
  const premier = scene.querySelector("button:not([disabled])");
  if (premier instanceof HTMLElement) premier.focus({ preventScroll: true });
  numeroEcran += 1;
}

/** Texte du parcours avec le prénom du visiteur. */
const perso = (/** @type {string | undefined} */ t) => personnaliser(t ?? "", visiteur?.prenom ?? "");

/** Repères de l'en-tête : étapes du parcours (Vous, Mode d'emploi, Questions, Merci) ou progression des questions. */
const ETAPES_REPERES = /** @type {const} */ ([["identification", "Vous"], ["consentement", "Mode d'emploi"], ["question", "Questions"], ["fin", "Merci"]]);
function reperes(/** @type {string} */ type, /** @type {{ numero: number, total: number } | null} */ progression = null, /** @type {string} */ surtitre = "") {
  const el = $("reperes");
  if (progression) {
    el.replaceChildren(
      h("span", { class: "points", "aria-hidden": "true" },
        ...Array.from({ length: progression.total }, (_, i) => h("i", { "data-etat": i + 1 < progression.numero ? "fait" : i + 1 === progression.numero ? "en-cours" : "a-venir" }))),
      h("span", {}, `Question ${progression.numero} sur ${progression.total}`));
    return;
  }
  if (surtitre) { el.replaceChildren(h("span", { class: "surtitre" }, surtitre)); return; }
  const presents = new Set(config?.parcours?.etapes?.map((/** @type {any} */ e) => e.type) ?? []);
  const liste = ETAPES_REPERES.filter(([t]) => presents.has(t));
  const ici = liste.findIndex(([t]) => t === type);
  if (ici < 0 || type === "accueil") { el.replaceChildren(); return; }
  el.replaceChildren(h("nav", { "aria-label": "Étapes", class: "reperes" },
    ...liste.map(([, nom], i) => h("span", { class: "pas", "data-etat": i < ici ? "fait" : i === ici ? "en-cours" : "a-venir" }, nom))));
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

/**
 * Thème : celui de Parlopop par défaut ; une marque cliente le remplace par ses couleurs
 * (couleurs.principale → la marque parle, couleurs.secondaire → le visiteur répond, couleurs.fond, couleurs.texte) et son logo.
 */
function appliquerHabillage() {
  const client = config?.client;
  const racine = document.documentElement.style;
  const c = client?.couleurs ?? {};
  const valide = (/** @type {unknown} */ x) => typeof x === "string" && /^#[0-9a-fA-F]{6}$/.test(x);
  for (const [cle, prop, sur] of [["principale", "--accent", "--sur-accent"], ["secondaire", "--parole", "--sur-parole"], ["fond", "--fond", ""], ["texte", "--texte", ""]]) {
    if (valide(c[cle])) {
      racine.setProperty(/** @type {string} */ (prop), c[cle]);
      if (sur) racine.setProperty(sur, contraste(c[cle]));
    } else {
      racine.removeProperty(/** @type {string} */ (prop));
      if (sur) racine.removeProperty(sur);
    }
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", valide(c.fond) ? c.fond : "#F1F2F6");
  const logo = /** @type {HTMLImageElement} */ ($("logo"));
  logo.hidden = !client?.logo_url;
  $("voxbox").hidden = Boolean(client?.logo_url);
  if (client?.logo_url) { logo.src = client.logo_url; logo.alt = client.nom ?? ""; }
}

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

const suite = (/** @type {any} */ e, /** @type {string | undefined} */ choix = undefined) => aller(/** @type {any} */ (moteur).suivante(e.id, choix));

function accueil() {
  visiteur = null;
  activerFlou(false);
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
          enPause.length ? h("div", { class: "actions" }, bouton("Je reviens", ecranReprise, "secondaire")) : null),
        h("section", { class: "carte conversation", "aria-label": "La cabine vous parle" },
          ...bulles.map((t) => bulle("marque arrive", t)),
          h("p", { class: "bulle marque arrive ecrit", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
          h("div", { class: "actions droite arrive" }, bouton(e.bouton, () => { nouvelleSession(); suite(e); }))))),
  ], "accueil");
  reperes("accueil", null, e.surtitre ?? "");
}

function ecranReprise() {
  const liste = pauses().sort((a, b) => a.prenom.localeCompare(b.prenom, "fr"));
  afficher([
    h("div", { class: "ecran" },
      bulle("marque grande arrive", "Content de vous revoir !"),
      h("p", { class: "chapo" }, "Touchez votre prénom pour reprendre là où vous en étiez."),
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
  const defs = [{ cle: "prenom", etiquette: "Votre prénom", indice: "Votre prénom", mode: "nom", max: 40, principal: true }];
  if (e.demanderNom) defs.push({ cle: "nom", etiquette: "Nom, facultatif", indice: "Votre nom", mode: "nom", max: 60, principal: false });
  if (e.demanderEmail) defs.push({ cle: "email", etiquette: "E-mail, facultatif : pour être recontacté(e) par la marque", indice: "vous@exemple.fr", mode: "email", max: 160, principal: false });

  const continuer = bouton("Continuer", () => suite(e));
  const majBouton = () => continuer.toggleAttribute("disabled", v.prenom.trim().length < 1);
  const recontact = h("button", { type: "button", class: "case", role: "checkbox", "aria-checked": String(v.recontact), hidden: !v.email,
    onclick: () => { v.recontact = !v.recontact; recontact.setAttribute("aria-checked", String(v.recontact)); } },
    h("span", { class: "boite" }), h("span", {}, "J'accepte d'être recontacté(e) par la marque."));

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

  afficher([
    h("div", { class: "ecran" },
      h("div", { class: "colonne" },
        h("h1", { class: "bulle marque grande arrive" }, perso(e.titre)),
        e.texte ? bulle("marque douce moyenne arrive", perso(e.texte)) : null),
      h("div", { class: "champs" }, ...champs),
      recontact,
      h("div", { class: "actions droite" }, continuer)),
  ], "identification");
  majBouton();
  champs[0]?.click();
}

function ecranConsentement(/** @type {any} */ e) {
  if (!visiteur) return accueil();
  const v = visiteur;
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
    h("div", { class: "ecran" },
      h("div", { class: "deux" },
        h("section", { class: "colonne", "aria-label": "Comment ça marche" },
          e.texte ? bulle("marque moyenne arrive", perso(e.texte)) : null,
          h("h1", {}, perso(e.titre)),
          e.consignes?.length ? h("ol", { class: "consignes" }, ...e.consignes.map((/** @type {string} */ c, /** @type {number} */ i) => {
            const { chiffre, reste } = decouperConsigne(perso(c));
            return h("li", { class: "arrive", style: `animation-delay: ${0.15 * (i + 1)}s` }, h("span", { class: "chiffre", "aria-hidden": chiffre ? null : "true" }, chiffre ?? String(i + 1)), h("span", {}, reste));
          })) : null),
        h("section", { class: "carte accord", "aria-label": "Votre accord" },
          h("div", { class: "cases" },
            caseACocher(`J'accepte que ${marque} consulte mes réponses pour mieux comprendre l'avis de ses clients.`, false,
              (x) => { accord = x; partir.toggleAttribute("disabled", !x); }, "Obligatoire pour commencer."),
            proposee ? caseACocher(config.consentement.texte_diffusion, v.diffusion, (x) => { v.diffusion = x; }) : null,
            e.proposerFloutage ? caseACocher("Flouter mon visage", v.floutage, (x) => { v.floutage = x; }, "Votre voix reste, votre visage disparaît.") : null),
          h("button", { type: "button", class: "lien", onclick: () => { details.hidden = !details.hidden; } }, "En savoir plus sur vos données"),
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
    h("div", { class: "ecran ecran-cadrage" },
      h("h1", { class: "bulle marque grande" }, perso(e.titre)),
      h("div", { class: "emplacement-camera" }),
      h("div", { class: "actions" },
        e.proposerFloutage ? h("div", { class: "cases" }, caseACocher("Flouter mon visage", v.floutage, (x) => { v.floutage = x; activerFlou(x); })) : null,
        h("span", { style: "flex: 1" }),
        bouton("Je suis prêt", () => { envoyerSession(); suite(e); }))),
  ], "cadrage");
}

function ecranErreurCamera() {
  afficher([
    h("div", { class: "ecran" },
      h("h1", {}, "Caméra indisponible"),
      h("p", { class: "chapo" }, "La caméra ou le micro ne répond pas. Prévenez un conseiller : la cabine revient à l'accueil.")),
  ], "erreur");
  setTimeout(accueil, 8000);
}

/** Compte à rebours sur l'aperçu : la bulle jaune et « On tourne dans N secondes ». */
function compte(/** @type {number} */ n) {
  $("compte").hidden = n <= 0;
  $("compte-chiffre").textContent = n > 0 ? String(n) : "";
  $("compte-detail").textContent = n > 1 ? `On tourne dans ${n} secondes.` : "On tourne !";
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
  const suivant = bouton(derniere ? "J'ai terminé" : "Question suivante", () => arret?.(), "plein");
  suivant.toggleAttribute("disabled", true);
  const remplissage = h("span");
  const barre = h("div", { class: "barre-temps", role: "progressbar", "aria-label": "Temps restant" }, remplissage);
  const secondes = h("span", {}, `${e.dureeMaxSec} s`);
  const aPistes = Boolean(e.pistes?.length || e.aide);

  afficher([
    h("div", { class: "ecran ecran-question" },
      h("div", { class: "tete arrive" },
        h("span", { class: "etiquette-pastille titre-court" }, e.titreCourt ?? `Question ${progression.numero}`),
        h("p", { class: "bulle marque grande question" }, perso(e.texte))),
      h("div", { class: "corps" },
        h("div", { class: "zone-camera" },
          h("div", { class: "emplacement-camera" }),
          h("div", { class: "temps" }, barre, secondes)),
        h("div", { class: "aide" },
          aPistes ? h("div", { class: "colonne", style: "gap: 12px" },
            h("span", { class: "intitule" }, "Des idées, si besoin :"),
            e.pistes?.length ? h("div", { class: "pistes" }, ...e.pistes.map((/** @type {string} */ p) => h("span", {}, p))) : null,
            e.aide ? h("p", { class: "chapo" }, perso(e.aide)) : null) : h("span"),
          e.coupDePouce ? h("div", { class: "coup-de-pouce" },
            h("span", { class: "intitule" }, "Pour démarrer"),
            bulle("visiteur douce", perso(e.coupDePouce))) : null),
        h("div", { class: "actions" }, suivant))),
  ], "question");
  reperes("question", progression);

  let annule = false;
  annulerEnCours = () => { annule = true; arret?.(); compte(0); $("rec").hidden = true; $("ecoute").hidden = true; delete apercu.dataset.rec; };
  vumetre.reprendre();
  arreterInactivite();
  const temps = (/** @type {number} */ f) => { remplissage.style.transform = `scaleX(${Math.max(0, Math.min(1, f))})`; };
  temps(1);

  // Le temps de lire : compte à rebours sur l'aperçu, puis la caméra tourne.
  let reste = Math.max(0, Number(e.compteARebours ?? 5));
  const decompte = () => {
    if (annule) return;
    if (reste > 0) { compte(reste); reste -= 1; setTimeout(decompte, 1000); return; }
    compte(0);
    lancer();
  };

  const lancer = () => {
    $("rec").hidden = false;
    $("ecoute").hidden = false;
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
    prise.resultat.then(async (r) => {
      $("rec").hidden = true;
      $("ecoute").hidden = true;
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
      suite(e);
    }).catch(() => ecranErreurCamera());
  };
  decompte();
}

function ecranChoix(/** @type {any} */ e) {
  afficher([
    h("div", { class: "ecran" },
      h("h1", { class: "bulle marque grande arrive" }, perso(e.titre)),
      h("div", { class: "options" }, ...e.options.map((/** @type {any} */ o) =>
        h("button", { type: "button", class: "option", onclick: () => suite(e, o.id) },
          o.image ? h("img", { src: o.image, alt: "" }) : null, o.libelle)))),
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
      bulle("marque douce moyenne arrive", `À votre retour, touchez « Je reviens » puis « ${prenom || "votre prénom"} ».`),
      h("div", { class: "actions droite" }, bouton(e.bouton, accueil))),
  ], "pause");
  const ecran = numeroEcran;
  setTimeout(() => { if (numeroEcran === ecran) accueil(); }, 12_000);
}

function ecranFin(/** @type {any} */ e) {
  if (visiteur) retirerPause(visiteur.id);
  activerFlou(false);
  const nb = visiteur?.repondues.length ?? 0;
  let reste = Math.max(3, Number(e.retourAccueilSec ?? 10));
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
          e.texte ? bulle("marque moyenne arrive", perso(e.texte)) : null),
        e.sortie ? h("p", { class: "sortie" }, perso(e.sortie)) : h("span")),
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

async function demarrer() {
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
