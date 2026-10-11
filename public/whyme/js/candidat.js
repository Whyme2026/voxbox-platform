// @ts-check
// Parcours du candidat Why me, sur son propre téléphone (QR code de la JobBox, ou lien en digital pur).
// Accueil → CV → identité → famille de postes → entreprises → accords → téléphone posé → cadrage →
// question d'essai → questions (« On garde » / « Je veux la revoir », une reprise par question) → fin.
// Une fois le téléphone posé, tout s'enchaîne sans le toucher, sauf pour revoir ou refaire une réponse.
// La vidéo montée n'est pas montrée ici : le candidat la découvre par e-mail (décision du 11/10/2026).
// Aperçu (/i/apercu, ouvert depuis l'éditeur de l'espace RH) : le même parcours sur un brouillon, caméra comprise,
// sans rien envoyer ni enregistrer.

import { creerVumetre, detecterVisage, diagnostic, enregistrer, mesurerImage, ouvrirCamera } from "./capture.js";
import { creerFileEnvoi } from "./envoi.js";

/** @typedef {{ id: string, texte: string, dureeSec: number, lectureSec: number }} Question */
/** @typedef {{ code: string, evenement: string, organisateur: string | null, accueil: { titre: string, message: string }, familles: { id: string, nom: string }[], questionEssai: { texte: string, dureeSec: number }, questions: Question[], ageAffiche: boolean, ageMinimum: number, validationAutoSec: number, tutoiement?: boolean, style?: any }} Campagne */

const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const code = (location.pathname.match(/^\/i\/([a-z0-9-]+)/) ?? [])[1] ?? new URLSearchParams(location.search).get("code") ?? "";
const CLE_LOCALE = `whyme:${code}`;
/** Brouillon de l'éditeur RH déposé par l'onglet qui a ouvert l'aperçu (même origine). */
const CLE_APERCU = "whyme-apercu";
const APERCU = code === "apercu";

const etat = {
  /** @type {Campagne} */ campagne: /** @type {any} */ (null),
  /** @type {{ id: string, nom: string, logo: string | null }[]} */ entreprises: [],
  /** @type {{ candidature: string, public: string, informationAge: string | null }} */ textes: /** @type {any} */ (null),
  empreinte: "",
  /** @type {File | null} */ cv: null,
  identite: { prenom: "", nom: "", email: "", age: "" },
  /** @type {string | null} */ famille: null,
  /** @type {Set<string>} */ choisies: new Set(),
  consentCandidature: false,
  consentPublic: false,
  id: "",
  jeton: "",
  /** @type {Set<string>} */ faites: new Set(),
  /** @type {Set<string>} */ reprisesUtilisees: new Set(),
  /** @type {MediaStream | null} */ flux: null,
  /** @type {ReturnType<typeof creerVumetre> | null} */ vumetre: null,
  /** @type {Awaited<ReturnType<typeof creerFileEnvoi>> | null} */ file: null,
  /** @type {any} */ verrouEcran: null,
};

// ------------------------------------------------------------------ outils

/** Tutoiement (par défaut) ou vouvoiement, selon le réglage de la campagne. */
const T = (/** @type {string} */ tu, /** @type {string} */ vous) => (etat.campagne?.tutoiement === false ? vous : tu);

/** Feuille de style de la campagne : couleurs (variables CSS de whyme.css) et motif (data-style, motifs/). */
function appliquerStyle(/** @type {any} */ style) {
  if (!style?.couleurs) return;
  const k = style.couleurs;
  const r = document.documentElement.style;
  r.setProperty("--fuchsia", k.accent); r.setProperty("--fuchsia-fonce", k.accentFonce); r.setProperty("--rose", k.accentPale);
  r.setProperty("--greige", k.bulle); r.setProperty("--titre", k.titre); r.setProperty("--texte", k.texte); r.setProperty("--fond", k.fond);
  document.documentElement.dataset.style = style.id;
  if (style.motif) document.documentElement.dataset.motif = style.motif;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", k.accent);
}

const echapper = (/** @type {unknown} */ t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attendre = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const $ = (/** @type {string} */ s, /** @type {ParentNode} */ racine = document) => /** @type {HTMLElement} */ (racine.querySelector(s));

/** @param {string} html */
function afficher(html) {
  app.innerHTML = html;
  window.scrollTo(0, 0);
  const titre = app.querySelector("h1, h2");
  if (titre instanceof HTMLElement) { titre.tabIndex = -1; titre.focus({ preventScroll: true }); }
}

/** En-tête commun : marque, évenement, étape. */
function haut(etape = "") {
  return `<div class="haut"><span class="marque" aria-label="why me">why me</span>${etape ? `<span class="etapes">${echapper(etape)}</span>` : ""}</div>`;
}

/** Attend un clic sur l'un des boutons [data-choix] et renvoie sa valeur. */
function choix(/** @type {ParentNode} */ racine = app) {
  return new Promise((/** @type {(v: string) => void} */ resolve) => {
    racine.querySelectorAll("[data-choix]").forEach((b) => b.addEventListener("click", () => resolve(/** @type {HTMLElement} */ (b).dataset.choix ?? ""), { once: true }));
  });
}

async function api(/** @type {string} */ methode, /** @type {string} */ chemin, /** @type {unknown} */ corps = undefined) {
  if (APERCU) return {}; // aperçu : rien ne part
  const res = await fetch(chemin, {
    method: methode,
    headers: { ...(corps ? { "content-type": "application/json" } : {}), ...(etat.jeton ? { "x-jeton": etat.jeton } : {}) },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const donnees = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(donnees.message ?? `Erreur ${res.status}`), { statut: res.status, code: donnees.erreur });
  return donnees;
}

function nouveauJeton() {
  const o = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const memoriser = () => { if (APERCU) return; try { localStorage.setItem(CLE_LOCALE, JSON.stringify({ id: etat.id, jeton: etat.jeton })); } catch { /* stockage indisponible */ } };
const oublier = () => { try { localStorage.removeItem(CLE_LOCALE); } catch { /* stockage indisponible */ } };

function erreurBloquante(/** @type {string} */ titre, /** @type {string} */ message) {
  afficher(`<section class="ecran">${haut()}<div class="corps"><h1>${echapper(titre)}</h1><p class="alerte">${echapper(message)}</p></div></section>`);
}

// ------------------------------------------------------------------ démarrage

async function demarrer() {
  if (!code) return erreurBloquante("Lien incomplet", "Scanne de nouveau le QR code de la JobBox.");
  let donnees;
  if (APERCU) {
    try { donnees = JSON.parse(localStorage.getItem(CLE_APERCU) ?? "null"); } catch { donnees = null; }
    if (!donnees?.campagne) return erreurBloquante("Aperçu indisponible", "Ouvre l'aperçu depuis l'éditeur de la campagne, dans l'espace RH.");
    const bandeau = document.createElement("div");
    bandeau.className = "bandeau-apercu";
    bandeau.textContent = "Aperçu · rien n'est enregistré";
    document.body.prepend(bandeau);
    document.body.style.paddingTop = "26px";
  } else {
    try {
      donnees = await api("GET", `/api/whyme/campagnes/${encodeURIComponent(code)}`);
    } catch (e) {
      return erreurBloquante("Interview fermée", /** @type {Error} */ (e).message || "Cette interview n'est pas ouverte en ce moment.");
    }
  }
  etat.campagne = donnees.campagne;
  appliquerStyle(etat.campagne.style);
  etat.entreprises = donnees.entreprises;
  etat.textes = donnees.textes;
  etat.empreinte = donnees.empreinte;
  document.title = `why me · ${etat.campagne.evenement}`;

  // Reprise : lien de l'e-mail (#reprise=<id>.<jeton>) ou même téléphone après un rechargement.
  const lien = /#reprise=([0-9a-f-]{36})\.([\w-]{32,64})/.exec(location.hash);
  let session = lien ? { id: lien[1], jeton: lien[2] } : null;
  if (lien) history.replaceState(null, "", location.pathname);
  if (!session && !APERCU) { try { session = JSON.parse(localStorage.getItem(CLE_LOCALE) ?? "null"); } catch { session = null; } }
  if (session?.id && session?.jeton) {
    etat.id = session.id; etat.jeton = session.jeton;
    try {
      const s = await api("GET", `/api/whyme/candidats/${etat.id}`);
      if (s.statut === "en_cours") {
        etat.identite.prenom = s.prenom;
        s.prises.forEach((/** @type {{ question: string, reprise: boolean }} */ p) => { etat.faites.add(p.question); if (p.reprise) etat.reprisesUtilisees.add(p.question); });
        memoriser();
        return reprendre();
      }
      oublier();
      if (lien) return fin(true);
    } catch {
      oublier();
    }
    etat.id = ""; etat.jeton = "";
  }
  await accueil();
}

async function reprendre() {
  const restantes = etat.campagne.questions.filter((q) => !etat.faites.has(q.id)).length;
  afficher(`<section class="ecran">${haut()}<div class="corps">
    <p class="surtitre">${echapper(etat.campagne.evenement)}</p>
    <h1>On reprend, ${echapper(etat.identite.prenom)} !</h1>
    <p>${T("Tes réponses déjà enregistrées sont gardées.", "Vos réponses déjà enregistrées sont gardées.")} ${restantes > 1 ? T(`Il te reste ${restantes} questions.`, `Il vous reste ${restantes} questions.`) : restantes === 1 ? T("Il te reste une question.", "Il vous reste une question.") : "Il ne reste qu'à terminer l'envoi."}</p>
    <div class="actions"><button class="bouton" data-choix="ok">Je reprends</button></div></div></section>`);
  await choix();
  await preparerFile();
  if (restantes) await tournage();
  await fin();
}

// ------------------------------------------------------------------ avant le tournage

async function accueil() {
  const c = etat.campagne;
  const n = c.questions.length;
  const minutes = Math.max(1, Math.round(c.questions.reduce((s, q) => s + q.dureeSec + q.lectureSec + 6, 30) / 60));
  const probleme = diagnostic(c.tutoiement === false);
  afficher(`<section class="ecran">${haut()}<div class="corps">
    <p class="surtitre">JobBox · ${echapper(c.evenement)}</p>
    <h1>${echapper(c.accueil.titre).replace(/(Quelqu'un\.?)$/, '<span class="accent">$1</span>')}</h1>
    <div class="bulle">${echapper(c.accueil.message)}</div>
    <div class="bulle">${T("Sois toi-même : pas de piège, pas de note. Juste toi, en vidéo, pour les entreprises que tu choisis.", "Soyez vous-même : pas de piège, pas de note. Juste vous, en vidéo, pour les entreprises que vous choisissez.")}</div>
    <div class="chiffres"><div><strong>${n}</strong><span>questions</span></div><div><strong>${c.questions[0]?.dureeSec ?? 10} s</strong><span>par réponse</span></div><div><strong>${minutes} min</strong><span>en tout</span></div></div>
    ${probleme ? `<p class="alerte" role="alert">${echapper(probleme)}</p>` : ""}
  </div>
  <div class="actions"><button class="bouton" data-choix="go" ${probleme ? "disabled" : ""}>C'est parti !</button></div></section>`);
  await choix();
  await etapeCv();
}

const nbEtapes = () => 4 + (etat.campagne.familles.length ? 1 : 0);

async function etapeCv() {
  afficher(`<section class="ecran">${haut(`Étape 1 sur ${nbEtapes()}`)}<div class="corps">
    <h2>${T("Tu as un CV sur ton téléphone ?", "Vous avez un CV sur votre téléphone ?")}</h2>
    <p>${T("Il accompagnera ta vidéo chez les recruteurs. C'est facultatif.", "Il accompagnera votre vidéo chez les recruteurs. C'est facultatif.")}</p>
    <label class="depot">
      <input type="file" id="cv" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden>
      <span id="cv-texte">${etat.cv ? `<span class="nom-fichier">${echapper(etat.cv.name)}</span><br>${T("Touche pour changer", "Touchez pour changer")}` : "<strong>Joindre mon CV</strong><br>PDF ou Word, 5 Mo au plus"}</span>
    </label>
    <p class="erreur" id="cv-erreur" role="alert"></p>
  </div>
  <div class="actions"><button class="bouton" data-choix="suite" id="cv-suite" ${etat.cv ? "" : "hidden"}>Continuer</button><button class="bouton secondaire" data-choix="sans" id="cv-sans">Je n'ai pas de CV</button></div></section>`);
  const champ = /** @type {HTMLInputElement} */ ($("#cv"));
  champ.addEventListener("change", () => {
    const f = champ.files?.[0];
    $("#cv-erreur").textContent = "";
    if (!f) return;
    const ok = /\.(pdf|docx?)$/i.test(f.name);
    if (!ok) { $("#cv-erreur").textContent = "Format non accepté : PDF ou Word seulement."; return; }
    if (f.size > 5 * 1024 * 1024) { $("#cv-erreur").textContent = "Ce fichier dépasse 5 Mo."; return; }
    etat.cv = f;
    $("#cv-texte").innerHTML = `<span class="nom-fichier">${echapper(f.name)}</span><br>${T("Touche pour changer", "Touchez pour changer")}`;
    $("#cv-suite").hidden = false;
    $("#cv-sans").hidden = true;
  });
  const r = await choix();
  if (r === "sans") etat.cv = null;
  await etapeIdentite();
}

async function etapeIdentite() {
  const c = etat.campagne;
  const i = etat.identite;
  afficher(`<section class="ecran">${haut(`Étape 2 sur ${nbEtapes()}`)}<form class="corps" id="form" novalidate>
    <h2>Faisons connaissance</h2>
    <div class="champ"><label for="prenom">Prénom</label><input id="prenom" name="prenom" autocomplete="given-name" required maxlength="60" value="${echapper(i.prenom)}"></div>
    <div class="champ"><label for="nom">Nom</label><input id="nom" name="nom" autocomplete="family-name" required maxlength="80" value="${echapper(i.nom)}"></div>
    <div class="champ"><label for="email">E-mail</label><input id="email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" required maxlength="200" value="${echapper(i.email)}">
      <p class="vigilance">${T("C'est là que tu recevras ta vidéo : vérifie-le bien.", "C'est là que vous recevrez votre vidéo : vérifiez-le bien.")}</p></div>
    <div class="champ"><label for="age">Âge</label><input id="age" name="age" type="number" inputmode="numeric" min="10" max="99" required value="${echapper(i.age)}">
      ${c.ageAffiche ? `<span class="aide">${echapper(etat.textes.informationAge ?? "")}</span>` : ""}</div>
    <p class="erreur" id="erreur" role="alert"></p>
    <button type="submit" hidden></button>
  </form>
  <div class="actions"><button class="bouton" id="valider">Continuer</button></div></section>`);
  const form = /** @type {HTMLFormElement} */ ($("#form"));
  await new Promise((/** @type {(v?: unknown) => void} */ ok) => {
    const valider = (/** @type {Event} */ e) => {
      e.preventDefault();
      const v = (/** @type {string} */ n) => /** @type {HTMLInputElement} */ (form.elements.namedItem(n)).value.trim();
      Object.assign(i, { prenom: v("prenom"), nom: v("nom"), email: v("email"), age: v("age") });
      const age = Number(i.age);
      let msg = "";
      if (!i.prenom || !i.nom) msg = T("Ton prénom et ton nom sont nécessaires.", "Votre prénom et votre nom sont nécessaires.");
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(i.email)) msg = "Cette adresse e-mail ne semble pas complète.";
      else if (!Number.isInteger(age) || age < 10 || age > 99) msg = T("Indique ton âge.", "Indiquez votre âge.");
      else if (age < c.ageMinimum) msg = `Cette interview est ouverte à partir de ${c.ageMinimum} ans. ${T("Rapproche-toi", "Rapprochez-vous")} de l'équipe de la JobBox.`;
      $("#erreur").textContent = msg;
      if (!msg) ok();
    };
    form.addEventListener("submit", valider);
    $("#valider").addEventListener("click", valider);
  });
  if (c.familles.length) await etapeFamille();
  await etapeEntreprises();
}

async function etapeFamille() {
  afficher(`<section class="ecran">${haut(`Étape 3 sur ${nbEtapes()}`)}<div class="corps">
    <h2>${T("Quel métier t'attire ?", "Quel métier vous attire ?")}</h2><p>Un seul choix.</p>
    <div class="choix" role="radiogroup">${etat.campagne.familles.map((f) => `<button class="option" role="radio" aria-checked="${etat.famille === f.id}" data-famille="${echapper(f.id)}">${echapper(f.nom)}</button>`).join("")}</div>
  </div><div class="actions"><button class="bouton" data-choix="suite" id="suite" ${etat.famille ? "" : "disabled"}>Continuer</button></div></section>`);
  app.querySelectorAll("[data-famille]").forEach((b) => b.addEventListener("click", () => {
    etat.famille = /** @type {HTMLElement} */ (b).dataset.famille ?? null;
    app.querySelectorAll("[data-famille]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    /** @type {HTMLButtonElement} */ ($("#suite")).disabled = false;
  }));
  await choix();
}

async function etapeEntreprises() {
  const n = etat.campagne.familles.length ? 4 : 3;
  const initiales = (/** @type {string} */ nom) => nom.split(/\s+/).map((m) => m[0]).join("").slice(0, 2).toUpperCase();
  afficher(`<section class="ecran">${haut(`Étape ${n} sur ${nbEtapes()}`)}<div class="corps">
    <h2>${T("Chez qui veux-tu postuler ?", "Chez qui voulez-vous postuler ?")}</h2>
    <p>Une ou plusieurs entreprises. <button class="lien-tout" id="tout">Tout sélectionner</button></p>
    <div class="grille" role="group" aria-label="Entreprises">${etat.entreprises.map((e) => `<button class="option entreprise" role="checkbox" aria-checked="${etat.choisies.has(e.id)}" data-entreprise="${echapper(e.id)}">
      ${e.logo ? `<img src="${echapper(e.logo)}" alt="">` : `<span class="initiales" aria-hidden="true">${echapper(initiales(e.nom))}</span>`}<span>${echapper(e.nom)}</span></button>`).join("")}</div>
  </div><div class="actions"><button class="bouton" data-choix="suite" id="suite" ${etat.choisies.size ? "" : "disabled"}>Je postule</button></div></section>`);
  const maj = () => {
    app.querySelectorAll("[data-entreprise]").forEach((b) => b.setAttribute("aria-checked", String(etat.choisies.has(/** @type {HTMLElement} */ (b).dataset.entreprise ?? ""))));
    /** @type {HTMLButtonElement} */ ($("#suite")).disabled = !etat.choisies.size;
    $("#tout").textContent = etat.choisies.size === etat.entreprises.length ? "Tout désélectionner" : "Tout sélectionner";
  };
  app.querySelectorAll("[data-entreprise]").forEach((b) => b.addEventListener("click", () => {
    const id = /** @type {HTMLElement} */ (b).dataset.entreprise ?? "";
    if (etat.choisies.has(id)) etat.choisies.delete(id); else etat.choisies.add(id);
    maj();
  }));
  $("#tout").addEventListener("click", () => {
    if (etat.choisies.size === etat.entreprises.length) etat.choisies.clear(); else etat.entreprises.forEach((e) => etat.choisies.add(e.id));
    maj();
  });
  maj();
  await choix();
  await etapeAccords();
}

async function etapeAccords() {
  const noms = etat.entreprises.filter((e) => etat.choisies.has(e.id)).map((e) => e.nom);
  afficher(`<section class="ecran">${haut(`Étape ${nbEtapes()} sur ${nbEtapes()}`)}<div class="corps">
    <h2>${T("Tes accords", "Vos accords")}</h2>
    <p>${T("Ta candidature partira chez", "Votre candidature partira chez")} <strong>${echapper(noms.join(", "))}</strong> ${T("une fois ta vidéo montée.", "une fois votre vidéo montée.")}</p>
    <label class="case obligatoire"><input type="checkbox" id="c-candidature" ${etat.consentCandidature ? "checked" : ""}><span><strong>Transmettre ma candidature (obligatoire)</strong>Les entreprises choisies verront ma vidéo et mon CV pendant 12 mois.
      <details><summary>Le détail</summary>${echapper(etat.textes.candidature)}</details></span></label>
    <label class="case"><input type="checkbox" id="c-public" ${etat.consentPublic ? "checked" : ""}><span><strong>Ma page vidéo et mon QR code (facultatif)</strong>Pour partager ma vidéo sur mon CV ou LinkedIn. Je peux la supprimer quand je veux.
      <details><summary>Le détail</summary>${echapper(etat.textes.public)}</details></span></label>
    ${etat.textes.informationAge ? `<p class="vigilance">${echapper(etat.textes.informationAge)}</p>` : ""}
    <p><a href="/whyme/confidentialite/" target="_blank" rel="noopener">Politique de confidentialité</a></p>
    <p class="erreur" id="erreur" role="alert"></p>
  </div><div class="actions"><button class="bouton" id="valider" ${etat.consentCandidature ? "" : "disabled"}>Je valide</button><button class="bouton discret" data-choix="retour">Revenir aux entreprises</button></div></section>`);
  const cc = /** @type {HTMLInputElement} */ ($("#c-candidature"));
  const cp = /** @type {HTMLInputElement} */ ($("#c-public"));
  const bouton = /** @type {HTMLButtonElement} */ ($("#valider"));
  cc.addEventListener("change", () => { etat.consentCandidature = cc.checked; bouton.disabled = !cc.checked; });
  cp.addEventListener("change", () => { etat.consentPublic = cp.checked; });
  const retour = choix();
  const valide = new Promise((/** @type {(v: string) => void} */ ok) => bouton.addEventListener("click", async () => {
    bouton.disabled = true;
    bouton.textContent = "Un instant…";
    try {
      await creerCandidat();
      ok("ok");
    } catch (e) {
      const err = /** @type {any} */ (e);
      $("#erreur").textContent = err.statut === 409 && err.code === "textes_changes" ? T("Les conditions ont changé : recharge la page.", "Les conditions ont changé : rechargez la page.") : err.message || T("Envoi impossible : vérifie ta connexion.", "Envoi impossible : vérifiez votre connexion.");
      bouton.disabled = false;
      bouton.textContent = "Je valide";
    }
  }));
  if ((await Promise.race([retour, valide])) === "retour") return etapeEntreprises();
  await tournage();
  await fin();
}

async function creerCandidat() {
  if (!etat.id) { etat.id = crypto.randomUUID(); etat.jeton = nouveauJeton(); }
  const i = etat.identite;
  await api("POST", `/api/whyme/campagnes/${encodeURIComponent(code)}/candidats`, {
    id: etat.id, jeton: etat.jeton, prenom: i.prenom, nom: i.nom, email: i.email, age: Number(i.age),
    famille: etat.famille, entreprises: [...etat.choisies], consent_candidature: true, consent_public: etat.consentPublic, empreinte: etat.empreinte,
  });
  memoriser();
  await preparerFile();
  if (etat.cv) {
    const type = etat.cv.type || (/\.pdf$/i.test(etat.cv.name) ? "application/pdf" : /\.docx$/i.test(etat.cv.name) ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/msword");
    await etat.file?.ajouter({ cle: `${etat.id}:cv`, chemin: `/api/whyme/candidats/${etat.id}/cv`, corps: etat.cv, type, entetes: { "x-nom-fichier": encodeURIComponent(etat.cv.name) } });
  }
}

async function preparerFile() {
  if (etat.file) return;
  if (APERCU) {
    // Aperçu : une file qui ne garde rien.
    etat.file = /** @type {any} */ ({ ajouter: async () => {}, restants: async () => 0, vide: async () => {} });
    return;
  }
  etat.file = await creerFileEnvoi({
    candidat: etat.id,
    jeton: () => etat.jeton,
    surRejet: (statut, message) => {
      if (statut === 401) { oublier(); erreurBloquante("Interview reprise ailleurs", T("Cette interview continue depuis le lien reçu par e-mail. Ouvre-le pour terminer.", "Cette interview continue depuis le lien reçu par e-mail. Ouvrez-le pour terminer.")); }
      else console.warn("Envoi refusé", statut, message);
    },
  });
}

// ------------------------------------------------------------------ tournage (plein écran)

const SILHOUETTE = `<svg viewBox="0 0 300 400" aria-hidden="true"><path d="M150 40c-46 0-78 36-78 84 0 34 14 62 36 78-4 14-10 24-20 30-38 12-70 34-80 64v104h284V296c-10-30-42-52-80-64-10-6-16-16-20-30 22-16 36-44 36-78 0-48-32-84-78-84z" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="5" stroke-dasharray="10 10"/></svg>`;

/** @type {HTMLElement | null} */
let scene = null;

function ouvrirScene() {
  scene = document.createElement("div");
  scene.className = "tournage";
  scene.innerHTML = `<video class="camera" playsinline muted autoplay></video><video class="relecture" playsinline hidden></video>
    <div class="voile"></div><div class="silhouette" hidden>${SILHOUETTE}</div>
    <div class="bandeau" hidden></div><div class="bas"></div>`;
  document.body.append(scene);
  const v = /** @type {HTMLVideoElement} */ ($("video.camera", scene));
  v.srcObject = etat.flux;
  void v.play().catch(() => {});
  return scene;
}

const bandeau = (/** @type {string} */ html) => { const b = $(".bandeau", /** @type {HTMLElement} */ (scene)); b.hidden = !html; b.innerHTML = html; };
const bas = (/** @type {string} */ html) => { $(".bas", /** @type {HTMLElement} */ (scene)).innerHTML = html; };

function anneau(/** @type {number} */ restant, /** @type {number} */ total) {
  const r = 36, c = 2 * Math.PI * r;
  return `<div class="anneau" role="timer" aria-live="off"><svg viewBox="0 0 84 84"><circle class="piste" cx="42" cy="42" r="${r}"/><circle class="avance" cx="42" cy="42" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.max(0, restant) / total)}"/></svg><span class="chiffre">${Math.ceil(Math.max(0, restant))}</span></div>`;
}

/** Compte à rebours de `sec` secondes ; un clic sur [data-choix] l'interrompt. Renvoie "fin" ou la valeur cliquée. */
function decompte(/** @type {number} */ sec, /** @type {(restant: number) => void} */ dessiner) {
  return new Promise((/** @type {(v: string) => void} */ resolve) => {
    const debut = performance.now();
    const arret = new AbortController();
    let fini = false;
    const terminer = (/** @type {string} */ v) => { if (fini) return; fini = true; arret.abort(); resolve(v); };
    const tic = () => {
      if (fini) return;
      const restant = sec - (performance.now() - debut) / 1000;
      if (restant <= 0) return terminer("fin");
      dessiner(restant);
      setTimeout(tic, 200);
    };
    tic();
    /** @type {HTMLElement} */ (scene).addEventListener("click", (e) => {
      const b = /** @type {HTMLElement} */ (e.target).closest("[data-choix]");
      if (b) terminer(/** @type {HTMLElement} */ (b).dataset.choix ?? "");
    }, { signal: arret.signal });
  });
}

/** Le décompte redessine la zone du bas : on garde les boutons et on ne remplace que l'anneau / le texte. */
function zoneDecompte(/** @type {string} */ boutons) {
  bas(`<div id="minuteur"></div>${boutons}`);
  return (/** @type {string} */ html) => { const m = document.getElementById("minuteur"); if (m) m.innerHTML = html; };
}

async function tournage() {
  // 1. Téléphone posé : le geste ouvre caméra et micro (autorisation) et garde l'écran allumé.
  afficher(`<section class="ecran">${haut()}<div class="corps">
    <h2>${T("Installe ton téléphone", "Installez votre téléphone")}</h2>
    <div class="bulle">${T("Pose-le sur le support, <strong>en portrait</strong>, à hauteur de tes yeux.", "Posez-le sur le support, <strong>en portrait</strong>, à hauteur de vos yeux.")}</div>
    <div class="bulle">${T("Ensuite, ne le touche plus : tout s'enchaîne tout seul. Tu n'auras à toucher l'écran que pour revoir ou refaire une réponse.", "Ensuite, ne le touchez plus : tout s'enchaîne tout seul. Vous n'aurez à toucher l'écran que pour revoir ou refaire une réponse.")}</div>
    <div class="bulle">${T("Pas de support ? Cale-le face à toi, à environ un bras de distance.", "Pas de support ? Calez-le face à vous, à environ un bras de distance.")}</div>
    <p class="erreur" id="erreur" role="alert"></p>
  </div><div class="actions"><button class="bouton" id="pret">Mon téléphone est en place</button></div></section>`);
  await new Promise((/** @type {(v?: unknown) => void} */ ok) => {
    $("#pret").addEventListener("click", async () => {
      try {
        etat.flux ??= await ouvrirCamera();
        etat.vumetre ??= creerVumetre(etat.flux);
        await etat.vumetre.reprendre();
        try { etat.verrouEcran = await /** @type {any} */ (navigator).wakeLock?.request("screen"); } catch { /* facultatif */ }
        ok();
      } catch (e) {
        $("#erreur").textContent = T("Impossible d'ouvrir la caméra et le micro. Autorise-les dans les réglages de ton navigateur, puis réessaie.", "Impossible d'ouvrir la caméra et le micro. Autorisez-les dans les réglages de votre navigateur, puis réessayez.");
        console.error(e);
      }
    });
  });

  ouvrirScene();
  await cadrage();
  await essai();
  const questions = etat.campagne.questions;
  for (const [i, q] of questions.entries()) {
    if (etat.faites.has(q.id)) continue;
    await question(q, i + 1, questions.length);
  }
  scene?.remove();
  scene = null;
  etat.flux?.getTracks().forEach((t) => t.stop());
  etat.flux = null;
  try { await etat.verrouEcran?.release(); } catch { /* déjà relâché */ }
}

/** 2. Cadrage : lumière, son et visage contrôlés ; on avance seul dès que tout va bien. */
async function cadrage() {
  const s = /** @type {HTMLElement} */ (scene);
  $(".silhouette", s).hidden = false;
  bandeau(`<p class="surtitre">Réglage</p><p class="question">${T("Place ton visage dans la silhouette", "Placez votre visage dans la silhouette")}</p><p class="consigne">${T("Puis dis « bonjour » à voix haute.", "Puis dites « bonjour » à voix haute.")}</p>`);
  const video = /** @type {HTMLVideoElement} */ ($("video.camera", s));
  const debut = performance.now();
  let voixMs = 0, okDepuis = 0, precedent = performance.now(), forcer = false;
  const avecVisage = /** @type {any} */ (window).FaceDetector !== undefined;
  bas(`<div class="verifs"><ul><li id="v-lumiere"><span class="etat">…</span><span>Lumière</span></li><li id="v-son"><span class="etat">…</span><span>${T("Son : dis « bonjour »", "Son : dites « bonjour »")}</span></li>${avecVisage ? `<li id="v-visage"><span class="etat">…</span><span>Visage dans la silhouette</span></li>` : ""}</ul></div><p class="message" id="conseil" hidden></p><button class="bouton secondaire" id="forcer" hidden>Continuer quand même</button>`);
  $("#forcer").addEventListener("click", () => { forcer = true; });
  const marquer = (/** @type {string} */ id, /** @type {boolean | null} */ ok) => {
    const li = document.getElementById(id);
    if (!li) return;
    li.className = ok === null ? "" : ok ? "ok" : "ko";
    /** @type {HTMLElement} */ (li.querySelector(".etat")).textContent = ok === null ? "…" : ok ? "✓" : "!";
  };
  while (!forcer) {
    await attendre(250);
    const t = performance.now();
    const niveau = etat.vumetre?.niveau() ?? 0;
    if (niveau > 0.32) voixMs += t - precedent;
    precedent = t;
    const img = mesurerImage(video);
    const lumiere = img.moyenne > 55 && img.bords - img.centre < 70;
    const son = voixMs > 300;
    let visage = true;
    let conseil = "";
    if (avecVisage) {
      const v = await detecterVisage(video);
      if (v === null) { visage = false; conseil = T("On ne voit pas ton visage : place-toi face au téléphone.", "On ne voit pas votre visage : placez-vous face au téléphone."); }
      else if (v) {
        visage = v.largeur > 0.2 && v.x > 0.28 && v.x < 0.72 && v.y > 0.2 && v.y < 0.62;
        if (v.largeur <= 0.2) conseil = T("Rapproche-toi un peu.", "Rapprochez-vous un peu.");
        else if (v.y >= 0.62) conseil = T("Monte un peu le téléphone.", "Montez un peu le téléphone.");
        else if (v.y <= 0.2) conseil = T("Descends un peu le téléphone.", "Descendez un peu le téléphone.");
        else if (v.x <= 0.28 || v.x >= 0.72) conseil = T("Centre-toi dans la silhouette.", "Centrez-vous dans la silhouette.");
      }
    }
    if (!lumiere) conseil = img.moyenne <= 55 ? T("C'est un peu sombre : tourne-toi vers la lumière.", "C'est un peu sombre : tournez-vous vers la lumière.") : T("Il y a du contre-jour : évite d'avoir une fenêtre derrière toi.", "Il y a du contre-jour : évitez d'avoir une fenêtre derrière vous.");
    else if (!son && !conseil) conseil = T("Dis « bonjour » à voix haute.", "Dites « bonjour » à voix haute.");
    marquer("v-lumiere", lumiere);
    marquer("v-son", son ? true : null);
    if (avecVisage) marquer("v-visage", visage);
    const c = $("#conseil");
    c.hidden = !conseil; c.textContent = conseil; c.className = "message";
    if (lumiere && son && visage) {
      okDepuis ||= t;
      if (t - okDepuis > 1200) break;
    } else okDepuis = 0;
    // Pas de blocage dur : après 25 s, le candidat peut passer outre (on ne le perd pas).
    if (t - debut > 25_000) $("#forcer").hidden = false;
  }
  $(".silhouette", s).hidden = true;
  bas(`<p class="message ok">Parfait ! On commence par un essai.</p>`);
  await attendre(1600);
}

/** 3. Question d'essai : enregistrée sur le téléphone seulement, jamais envoyée. */
async function essai() {
  const q = etat.campagne.questionEssai;
  bandeau(`<p class="surtitre">Essai · rien n'est envoyé</p><p class="question">${echapper(q.texte)}</p>`);
  const maj = zoneDecompte(`<button class="bouton secondaire" data-choix="go">Je suis prêt</button>`);
  await decompte(5, (r) => maj(anneau(r, 5)));
  const prise = await prendre(q.dureeSec);
  const voir = await decider({ titre: "Voilà comment ça marche !", garder: "Passer aux questions", revoir: "Voir mon essai", auto: 8 });
  if (voir === "revoir") {
    await relire(prise.blob, "Passer aux questions", null, 6);
  }
}

/**
 * 4. Une question : lecture, enregistrement, puis « On garde » ou « Je veux la revoir ».
 * Après revisionnage : « Je garde » ou « Je refais » (une reprise par question).
 */
async function question(/** @type {Question} */ q, /** @type {number} */ n, /** @type {number} */ total) {
  let reprise = etat.reprisesUtilisees.has(q.id);
  for (;;) {
    bandeau(`<p class="surtitre">Question ${n} sur ${total}${reprise ? " · deuxième prise" : ""}</p><p class="question">${echapper(q.texte)}</p>`);
    const maj = zoneDecompte(`<button class="bouton secondaire" data-choix="go">Je suis prêt</button>`);
    await decompte(q.lectureSec, (r) => maj(anneau(r, q.lectureSec)));
    const prise = await prendre(q.dureeSec);
    const auto = etat.campagne.validationAutoSec;
    let decision = await decider({ titre: prise.sonPresent ? "On garde ?" : T("On t'a peu entendu : revois-la si tu veux", "On vous a peu entendu : revoyez-la si vous voulez"), garder: "On garde", revoir: "Je veux la revoir", auto: prise.sonPresent ? auto : auto + 3 });
    if (decision === "revoir") decision = await relire(prise.blob, "Je garde", reprise ? null : "Je refais", auto);
    if (decision === "refaire" && !reprise) {
      reprise = true;
      etat.reprisesUtilisees.add(q.id);
      bas(`<p class="message">${T("Vérifie ton cadrage, on recommence.", "Vérifiez votre cadrage, on recommence.")}</p>`);
      await attendre(2000);
      continue;
    }
    await garder(q, prise, reprise);
    return;
  }
}

/** Enregistre `dureeSec` secondes ; « J'ai terminé » arrête plus tôt. */
async function prendre(/** @type {number} */ dureeSec) {
  bas(`<span class="enregistre">${T("On t'écoute", "On vous écoute")}</span><div id="minuteur">${anneau(dureeSec, dureeSec)}</div><div class="vumetre"><i id="vu"></i></div><button class="bouton discret" id="stop">J'ai terminé</button>`);
  const rec = enregistrer({
    flux: /** @type {MediaStream} */ (etat.flux), vumetre: /** @type {any} */ (etat.vumetre), dureeSec,
    surTemps: (ecoule, niveau) => {
      const m = document.getElementById("minuteur");
      if (m) m.innerHTML = anneau(dureeSec - ecoule, dureeSec);
      const vu = document.getElementById("vu");
      if (vu) vu.style.width = `${Math.round(niveau * 100)}%`;
    },
  });
  $("#stop").addEventListener("click", () => rec.arreter(), { once: true });
  return rec.resultat;
}

/** Écran de décision avec validation automatique au bout de `auto` secondes. Renvoie "garder" ou "revoir". */
async function decider(/** @type {{ titre: string, garder: string, revoir: string, auto: number }} */ o) {
  const maj = zoneDecompte(`<p class="message">${echapper(o.titre)}</p><button class="bouton" data-choix="garder">${echapper(o.garder)}</button><button class="bouton secondaire" data-choix="revoir">${echapper(o.revoir)}</button>`);
  const r = await decompte(o.auto, (restant) => maj(`<span class="auto">${echapper(o.garder)} dans ${Math.ceil(restant)} s</span>`));
  return r === "revoir" ? "revoir" : "garder";
}

/** Relecture de la prise (avec le son), puis « Je garde » / « Je refais ». Renvoie "garder" ou "refaire". */
async function relire(/** @type {Blob} */ blob, /** @type {string} */ garder, /** @type {string | null} */ refaire, /** @type {number} */ auto) {
  const s = /** @type {HTMLElement} */ (scene);
  const v = /** @type {HTMLVideoElement} */ ($("video.relecture", s));
  const url = URL.createObjectURL(blob);
  v.src = url; v.hidden = false; v.muted = false;
  bandeau("");
  const boutons = `<button class="bouton" data-choix="garder">${echapper(garder)}</button>${refaire ? `<button class="bouton secondaire" data-choix="refaire">${echapper(refaire)}</button>` : ""}`;
  bas(`<p class="message">${T("Ta réponse", "Votre réponse")}</p>${boutons}`);
  const finLecture = new Promise((r) => { v.onended = r; v.onerror = r; });
  try { await v.play(); } catch { /* lecture refusée : on passe directement au choix */ }
  const arret = new AbortController();
  const pendant = new Promise((/** @type {(v: string) => void} */ resolve) => s.addEventListener("click", (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest("[data-choix]");
    if (b) resolve(/** @type {HTMLElement} */ (b).dataset.choix ?? "");
  }, { signal: arret.signal }));
  let r = await Promise.race([finLecture.then(() => ""), pendant]);
  arret.abort();
  if (!r) {
    const maj = zoneDecompte(`<p class="message">Alors ?</p>${boutons}`);
    r = await decompte(auto, (restant) => maj(`<span class="auto">${echapper(garder)} dans ${Math.ceil(restant)} s</span>`));
  }
  v.pause(); v.hidden = true; v.removeAttribute("src"); v.load();
  URL.revokeObjectURL(url);
  return r === "refaire" ? "refaire" : "garder";
}

async function garder(/** @type {Question} */ q, /** @type {{ blob: Blob, type: string, dureeMs: number, sonPresent: boolean }} */ prise, /** @type {boolean} */ reprise) {
  const priseId = crypto.randomUUID();
  await etat.file?.ajouter({
    cle: `${etat.id}:${q.id}`, chemin: `/api/whyme/candidats/${etat.id}/prises/${q.id}`, corps: prise.blob, type: prise.type,
    entetes: { "x-duree-ms": String(prise.dureeMs), "x-son-present": prise.sonPresent ? "1" : "0", "x-reprise": reprise ? "1" : "0", "x-prise-id": priseId },
  });
  etat.faites.add(q.id);
  bas(`<p class="message ok">C'est gardé !</p>`);
  await attendre(900);
}

// ------------------------------------------------------------------ fin

async function fin(dejaTermine = false) {
  const prenom = etat.identite.prenom;
  if (!dejaTermine) {
    afficher(`<section class="ecran">${haut()}<div class="corps"><h2>${T("Envoi de tes réponses…", "Envoi de vos réponses…")}</h2>
      <p>${T("Garde cette page ouverte quelques secondes.", "Gardez cette page ouverte quelques secondes.")}</p><div class="progression"><i id="barre"></i></div><p id="etat-envoi" role="status"></p></div></section>`);
    const total = Math.max(1, (await etat.file?.restants()) ?? 1);
    const suivi = setInterval(async () => {
      const r = (await etat.file?.restants()) ?? 0;
      const b = document.getElementById("barre");
      if (b) b.style.width = `${Math.round(100 * (1 - r / total))}%`;
      const e = document.getElementById("etat-envoi");
      if (e) e.textContent = navigator.onLine ? "" : "Pas de réseau : l'envoi reprendra dès que possible.";
    }, 400);
    await etat.file?.vide();
    clearInterval(suivi);
    for (let essai = 0; ; essai++) {
      try { await api("POST", `/api/whyme/candidats/${etat.id}/terminer`); break; } catch (e) {
        if (/** @type {any} */ (e).statut && /** @type {any} */ (e).statut < 500) { console.error(e); break; }
        await attendre(Math.min(10_000, 1500 * (essai + 1)));
      }
    }
    oublier();
  }
  if (APERCU) {
    return afficher(`<section class="ecran">${haut()}<div class="corps">
      <h1>Fin de l'aperçu</h1>
      <div class="bulle">C'est ici que le candidat apprend que sa vidéo est en cours de montage et qu'il la recevra par e-mail.</div>
      <div class="bulle">Rien n'a été enregistré : ni réponse, ni vidéo.</div>
      <p style="margin-top:20px">Tu peux fermer cet onglet et revenir à l'éditeur.</p>
    </div></section>`);
  }
  afficher(`<section class="ecran">${haut()}<div class="corps">
    <h1>Merci${prenom ? ` ${echapper(prenom)}` : ""} !</h1>
    <div class="bulle">${T("Ta vidéo est en cours de montage.", "Votre vidéo est en cours de montage.")}</div>
    <div class="bulle">${T("Tu la recevras par e-mail dans quelques minutes, avec ton QR code à ajouter à ton CV.", "Vous la recevrez par e-mail dans quelques minutes, avec votre QR code à ajouter à votre CV.")}</div>
    <div class="bulle">${T("Pense à regarder tes courriers indésirables.", "Pensez à regarder vos courriers indésirables.")}</div>
    <p style="margin-top:20px">${T("Tu peux reprendre ton téléphone.", "Vous pouvez reprendre votre téléphone.")}</p>
  </div></section>`);
}

// Portrait obligatoire pendant le tournage : en paysage, on le demande.
const surOrientation = () => {
  const paysage = window.innerWidth > window.innerHeight * 1.1 && window.innerWidth < 1100;
  document.body.dataset.paysage = String(paysage);
  if (scene && paysage) bandeau(`<p class="question">${T("Tourne ton téléphone en portrait", "Tournez votre téléphone en portrait")}</p>`);
};
window.addEventListener("resize", surOrientation);

demarrer().catch((e) => {
  console.error(e);
  erreurBloquante("Oups", T("Quelque chose s'est mal passé. Recharge la page : tes réponses déjà envoyées sont gardées.", "Quelque chose s'est mal passé. Rechargez la page : vos réponses déjà envoyées sont gardées."));
});
