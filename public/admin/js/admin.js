// @ts-check
// Parlorama, l'interface de Parlopop : WhyMe (clients, campagnes, cabines, comptes, journal) et clients (leurs campagnes, leurs réponses).
// Une seule page, navigation par ancre (#/campagnes/…). Tout le texte venant de la base est inséré en texte, jamais en HTML.

import { h } from "./dom.js";
import { editeurParcours } from "./editeur.js";
import { choixParPersonne, choixParQuestion, planParlomix, themeDepuisCouleurs, dureeSegments, CLIPS_MAX } from "./montage/plan.js";
import { analyserReponse, fabriquer, formatsDisponibles, contientDuSon, dessinerCarte } from "./montage/rendu.js";

/** @typedef {{ email: string, role: string, client: any, droits: string[], environnement: string }} Moi */

/** @type {Moi | null} */ let moi = null;
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const contenu = $("contenu");

// ------------------------------------------------------------------ utilitaires

/** Icône SVG à partir d'un tracé (aucune donnée externe). */
function icone(/** @type {string} */ d) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2");
  s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d); s.append(p);
  return s;
}
const ICONES = {
  accueil: "M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z",
  campagnes: "M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  cabines: "M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM9 17h6M12 7a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
  clients: "M4 21V8l8-5 8 5v13M9 21v-6h6v6",
  comptes: "M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 20v-1a4 4 0 0 0-3-3.8M16 4.2a3.5 3.5 0 0 1 0 6.6",
  journal: "M6 3h9l4 4v14H6zM14 3v5h5M9 12h6M9 16h6",
  lecture: "M8 5v14l11-7z",
  whyme: "M15 10l4.6-2.3A1 1 0 0 1 21 8.6v6.8a1 1 0 0 1-1.4.9L15 14M5 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
};

const peut = (/** @type {string} */ droit) => Boolean(moi?.droits.includes(droit));
const estWhyme = () => moi?.role === "admin_whyme" || moi?.role === "operateur_whyme";

/**
 * En local seulement, l'identité vient de l'en-tête X-Dev-Email (refusé partout ailleurs par le serveur).
 * @returns {Record<string, string>}
 */
function enTetesDev() {
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) return {};
  let email = "admin@whyme.test";
  try { email = localStorage.getItem("voxbox.dev-email") ?? email; } catch { /* stockage indisponible */ }
  return { "x-dev-email": email };
}

// ------------------------------------------------------------------ version de Parlorama
// Cette page n'est pas recompilée : un onglet ouvert pendant un déploiement garde l'ancien code. L'API annonce la
// version déployée dans chaque réponse ; dès qu'elle change, un bandeau demande de recharger, et le serveur refuse
// toute modification envoyée par l'ancienne page (409 « parlorama_perime »).
const EN_TETE_VERSION = "x-parlorama-version";
/** @type {string | null} */ let versionChargee = null;
function noterVersion(/** @type {Response} */ res) {
  const v = res.headers.get(EN_TETE_VERSION);
  if (!v) return;
  if (!versionChargee) versionChargee = v;
  else if (v !== versionChargee) signalerNouvelleVersion();
}
function signalerNouvelleVersion() {
  if (document.getElementById("nouvelle-version")) return;
  document.body.append(h("div", { id: "nouvelle-version", class: "nouvelle-version", role: "alert" },
    h("span", {}, "Une nouvelle version de Parlorama vient d'être mise en ligne. Rechargez la page avant de continuer : les modifications faites depuis cette page seraient refusées."),
    h("button", { type: "button", class: "bouton action petit", onclick: () => location.reload() }, "Recharger")));
}
async function verifierVersion() {
  try { noterVersion(await fetch("/api/sante", { cache: "no-store" })); } catch { /* hors ligne : on réessaiera */ }
}
setInterval(verifierVersion, 2 * 60_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") verifierVersion(); });

async function api(/** @type {string} */ chemin, /** @type {{ methode?: string, corps?: unknown }} */ opts = {}) {
  const res = await fetch(chemin, {
    method: opts.methode ?? "GET",
    headers: {
      ...enTetesDev(), ...(opts.corps !== undefined ? { "content-type": "application/json" } : {}),
      ...(versionChargee ? { [EN_TETE_VERSION]: versionChargee } : {}),
    },
    body: opts.corps !== undefined ? JSON.stringify(opts.corps) : undefined,
    credentials: "same-origin",
  });
  noterVersion(res);
  const corps = await res.json().catch(() => ({}));
  if (res.status === 409 && corps.erreur === "parlorama_perime") signalerNouvelleVersion();
  if (!res.ok) {
    const e = /** @type {Error & { corps?: any, status?: number }} */ (new Error(corps.message ?? `Erreur ${res.status}`));
    e.corps = corps; e.status = res.status;
    throw e;
  }
  return corps;
}

function toast(/** @type {string} */ message, ton = "") {
  const t = $("toast");
  t.textContent = message; t.dataset.ton = ton; t.hidden = false;
  clearTimeout(Number(t.dataset.minuterie));
  t.dataset.minuterie = String(setTimeout(() => { t.hidden = true; }, 3500));
}

const FORMAT_DATE = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
const FORMAT_JOUR = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });
const date = (/** @type {string | null | undefined} */ iso) => (iso ? FORMAT_DATE.format(new Date(iso)) : "—");
const jour = (/** @type {string | null | undefined} */ iso) => (iso ? FORMAT_JOUR.format(new Date(`${iso}T12:00:00Z`)) : "—");
function ilYa(/** @type {string | null | undefined} */ iso) {
  if (!iso) return "jamais";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}
const duree = (/** @type {number | null} */ ms) => (ms ? `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}` : "—");

const STATUTS = /** @type {Record<string, [string, string]>} */ ({
  brouillon: ["Brouillon", ""], validee: ["Validée par le client", "jaune"], active: ["Active", "vert"], close: ["Close", ""],
});
const statut = (/** @type {string} */ s) => h("span", { class: "pastille", "data-ton": STATUTS[s]?.[1] ?? "" }, STATUTS[s]?.[0] ?? s);
const ROLES = /** @type {Record<string, string>} */ ({
  admin_whyme: "Administrateur WhyMe", operateur_whyme: "Opérateur WhyMe", validateur_client: "Validateur (client)", lecteur_client: "Lecteur (client)",
});
const ACTIONS = /** @type {Record<string, string>} */ ({
  "client.creation": "Client créé", "client.modification": "Client modifié", "client.logo": "Logo du client",
  "utilisateur.role": "Rôle modifié", "campagne.modification": "Campagne modifiée", "campagne.suppression": "Campagne supprimée",
  "campagne.export": "Export des visiteurs", "session.retrait": "Retrait d'accord d'un visiteur", "session.diffusion_retiree": "Accord de diffusion retiré",
  "parlomix.suppression": "Parlomix supprimé",
  "utilisateur.creation": "Compte créé", "utilisateur.desactivation": "Compte désactivé", "utilisateur.reactivation": "Compte réactivé",
  "campagne.creation": "Campagne créée", "campagne.parcours": "Nouveau parcours", "campagne.consentement": "Nouveaux textes de consentement",
  "campagne.statut.validee": "Campagne validée", "campagne.statut.active": "Campagne activée", "campagne.statut.close": "Campagne close",
  "campagne.statut.brouillon": "Campagne repassée en brouillon",
  "cabine.creation": "Cabine créée", "cabine.renommage": "Cabine renommée", "cabine.suppression": "Cabine supprimée", "cabine.retrait": "Cabine retirée", "cabine.affectation": "Cabine affectée", "cabine.nouveau_code": "Nouveau code d'appairage", "cabine.appairage": "Tablette appairée",
  "reponse.visionnage": "Vidéo visionnée", "demo.preparation": "Préparation de la démo", "journal.correction": "Correction du journal",
  "parlomix.creation": "Parlomix créé", "parlomix.visionnage": "Parlomix visionné",
});
const TYPES_ETAPES = /** @type {Record<string, string>} */ ({
  accueil: "Accueil", identification: "Identification", consentement: "Mode d'emploi et accord", cadrage: "Cadrage",
  question: "Question", choix: "Choix", pause: "Pause", fin: "Fin",
});

/** Cabine considérée en ligne si elle a donné signe de vie depuis moins de 3 minutes. */
const enLigne = (/** @type {any} */ c) => Boolean(c.vu_le) && Date.now() - Date.parse(c.vu_le) < 3 * 60_000;
const signal = (/** @type {any} */ c) => { try { return c.dernier_signal ? JSON.parse(c.dernier_signal) : {}; } catch { return {}; } };

function enTete(/** @type {string} */ titre, /** @type {any} */ sous = null, /** @type {any} */ droite = null, /** @type {any} */ fil = null) {
  return h("div", { class: "entete-page" },
    h("div", {}, fil ? h("div", { class: "fil" }, fil) : null, h("h1", {}, titre), sous ? h("p", { class: "sous" }, sous) : null),
    droite);
}

/** Bouton à double confirmation (sans boîte de dialogue du navigateur). */
function boutonConfirme(/** @type {string} */ libelle, /** @type {string} */ confirmation, /** @type {() => Promise<void>} */ action, classe = "bouton discret") {
  const b = h("button", { type: "button", class: classe }, libelle);
  let arme = false;
  b.addEventListener("click", async () => {
    if (!arme) {
      arme = true; b.textContent = confirmation;
      setTimeout(() => { arme = false; b.textContent = libelle; }, 4000);
      return;
    }
    b.setAttribute("disabled", "");
    try { await action(); } catch (e) { toast(/** @type {Error} */ (e).message, "erreur"); b.removeAttribute("disabled"); }
  });
  return b;
}

/** Lit les champs d'un formulaire en objet. */
function valeurs(/** @type {HTMLFormElement} */ f) {
  /** @type {Record<string, string>} */ const v = {};
  for (const [k, x] of new FormData(f).entries()) v[k] = String(x).trim();
  return v;
}

function champ(/** @type {string} */ libelle, /** @type {HTMLElement} */ entree, classe = "") {
  return h("label", { class: `champ ${classe}`.trim() }, libelle, entree);
}

// ------------------------------------------------------------------ navigation

const PAGES = [
  { cle: "accueil", chemin: "#/", libelle: "Tableau de bord", visible: () => estWhyme() },
  { cle: "campagnes", chemin: "#/campagnes", libelle: "Campagnes", visible: () => peut("campagnes.lire") },
  { cle: "cabines", chemin: "#/cabines", libelle: "Cabines", visible: () => peut("cabines.gerer") },
  { cle: "clients", chemin: "#/clients", libelle: "Clients", visible: () => peut("clients.gerer") },
  { cle: "comptes", chemin: "#/comptes", libelle: "Comptes", visible: () => peut("utilisateurs.gerer") },
  { cle: "journal", chemin: "#/journal", libelle: "Journal", visible: () => peut("journal.lire") },
  // Why me (JobBox smartphone, usages RH) : produit distinct, page à part (whyme.html).
  { cle: "whyme", chemin: "whyme.html", libelle: "Why me (RH)", visible: () => estWhyme() },
];

function menu(/** @type {string} */ actif) {
  $("menu").replaceChildren(...PAGES.filter((p) => p.visible()).map((p) =>
    h("a", { href: p.chemin, "aria-current": p.cle === actif ? "page" : null },
      icone(ICONES[/** @type {keyof typeof ICONES} */ (p.cle)]), p.libelle)));
}

async function router() {
  const [, page = "", id = ""] = (location.hash.replace(/^#/, "").split("?")[0] ?? "").split("/");
  const cle = page || (estWhyme() ? "accueil" : "campagnes");
  menu(cle);
  contenu.replaceChildren(h("p", { class: "attente" }, "Chargement…"));
  try {
    /** @type {Node} */ let vue;
    if (cle === "accueil") vue = await vueAccueil();
    else if (cle === "campagnes" && id) vue = await vueCampagne(id);
    else if (cle === "campagnes") vue = await vueCampagnes();
    else if (cle === "cabines") vue = await vueCabines();
    else if (cle === "clients") vue = await vueClients();
    else if (cle === "comptes") vue = await vueComptes();
    else if (cle === "journal") vue = await vueJournal();
    else vue = h("p", { class: "vide" }, "Page inconnue.");
    contenu.replaceChildren(vue);
    contenu.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (e) {
    contenu.replaceChildren(h("div", { class: "carte" }, h("h2", {}, "Impossible d'afficher cette page"), h("p", {}, /** @type {Error} */ (e).message)));
  }
}

// ------------------------------------------------------------------ tableau de bord

async function vueAccueil() {
  const [{ campagnes }, { cabines }, { journal }] = await Promise.all([
    api("/api/admin/campagnes"), api("/api/admin/cabines"), peut("journal.lire") ? api("/api/admin/journal?limite=8") : Promise.resolve({ journal: [] }),
  ]);
  const actives = campagnes.filter((/** @type {any} */ c) => c.statut === "active");
  const visiteurs = campagnes.reduce((/** @type {number} */ n, /** @type {any} */ c) => n + Number(c.nb_sessions ?? 0), 0);
  const videos = campagnes.reduce((/** @type {number} */ n, /** @type {any} */ c) => n + Number(c.nb_reponses ?? 0), 0);
  const prenom = (moi?.email.split("@")[0] ?? "").split(/[._-]/)[0] ?? "";

  return h("div", {},
    enTete("Tableau de bord", null, h("span", { class: "bulle" }, `Bonjour ${prenom.charAt(0).toUpperCase()}${prenom.slice(1)} !`)),
    h("h2", { class: "titre-parlometre" }, "Parlomètre", h("span", {}, "ce que disent vos cabines, en chiffres")),
    h("div", { class: "grille kpi" },
      kpi(actives.length, "Campagnes actives", `${campagnes.length} au total`),
      kpi(`${cabines.filter(enLigne).length} / ${cabines.length}`, "Cabines en ligne", "signe de vie depuis moins de 3 min"),
      kpi(visiteurs, "Visiteurs", "sessions avec accord"),
      kpi(videos, "Réponses vidéo", "reçues et stockées en UE")),
    h("div", { class: "grille deux" },
      h("div", { class: "pile" },
        h("section", { class: "carte" }, h("h2", {}, "Campagnes"), tableauCampagnes(campagnes.slice(0, 8)))),
      h("div", { class: "pile" },
        h("section", { class: "carte" }, h("h2", {}, "Cabines"),
          cabines.length ? h("div", { class: "pile", style: "gap: 10px" }, ...cabines.map((/** @type {any} */ c) =>
            h("div", { style: "display: flex; justify-content: space-between; gap: 10px; align-items: center" },
              h("div", {}, h("strong", {}, c.nom), h("div", { style: "font-size: 13px; color: var(--doux)" }, c.campagne_nom ?? "Aucune campagne")),
              etatCabine(c)))) : h("p", { class: "vide" }, "Aucune cabine.")),
        journal.length ? h("section", { class: "carte" }, h("h2", {}, "Dernières actions"),
          h("div", { class: "pile", style: "gap: 8px" }, ...journal.map((/** @type {any} */ j) =>
            h("div", { style: "font-size: 14px" }, h("strong", {}, ACTIONS[j.action] ?? j.action),
              h("div", { style: "color: var(--doux); font-size: 13px" }, `${j.utilisateur_email} · ${ilYa(j.quand)}`))))) : null)));
}

/** Taille lisible : 820 Ko, 12,4 Mo, 1,23 Go (unités de 1 000, comme le stockage et sa facturation). */
function taille(/** @type {number | null | undefined} */ octets) {
  const n = Number(octets ?? 0);
  const f = (/** @type {number} */ x, /** @type {number} */ d) => x.toLocaleString("fr-FR", { maximumFractionDigits: d });
  if (n < 1e3) return `${f(n, 0)} o`;
  if (n < 1e6) return `${f(n / 1e3, 0)} Ko`;
  if (n < 1e9) return `${f(n / 1e6, n < 1e8 ? 1 : 0)} Mo`;
  return `${f(n / 1e9, 2)} Go`;
}

/** Durée lisible : 42 s, 12 min 05 s, 2 h 14 min. */
function dureeLongue(/** @type {number} */ ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

/** Tableau de bord de la campagne : volume de stockage (vidéos, Parlomix, miniatures), chargé sans bloquer la page. */
function chiffresCampagne(/** @type {any} */ c) {
  const zone = h("div", { class: "grille kpi chiffres-campagne", "aria-busy": "true" },
    kpi("…", "Stockage", "calcul en cours"), kpi("…", "Réponses vidéo", ""), kpi("…", "Par réponse", ""));
  api(`/api/espace/campagnes/${c.id}/volume`).then(({ volume: v }) => {
    const parReponse = v.videos.nombre ? v.videos.octets / v.videos.nombre : 0;
    const parMinute = v.videos.dureeMs ? (v.videos.octets / v.videos.dureeMs) * 60_000 : 0;
    zone.removeAttribute("aria-busy");
    zone.replaceChildren(
      kpi(`${v.nonMesures ? "≥ " : ""}${taille(v.octets)}`, "Stockage",
        `vidéos ${taille(v.videos.octets)} · Parlomix ${taille(v.parlomix.octets)} · miniatures ${taille(v.miniatures.octets)}${v.nonMesures ? ` · ${v.nonMesures} fichier(s) en cours de mesure` : ""}`),
      kpi(v.videos.nombre, "Réponses vidéo", v.videos.dureeMs ? `${dureeLongue(v.videos.dureeMs)} filmées · ${v.parlomix.nombre} Parlomix` : `${v.parlomix.nombre} Parlomix`),
      kpi(v.videos.nombre ? taille(parReponse) : "—", "Par réponse", parMinute ? `≈ ${taille(parMinute)} par minute filmée` : "en moyenne"));
  }).catch(() => zone.replaceChildren(kpi("—", "Stockage", "indisponible pour l'instant")));
  return zone;
}

function kpi(/** @type {any} */ valeur, /** @type {string} */ libelle, /** @type {string} */ detail) {
  return h("div", { class: "carte" }, h("span", { class: "valeur" }, String(valeur)), h("span", { class: "libelle" }, libelle), h("span", { class: "detail" }, detail));
}

function etatCabine(/** @type {any} */ c) {
  if (!c.appairee) return h("span", { class: "pastille", "data-ton": "jaune" }, "À appairer");
  return enLigne(c) ? h("span", { class: "pastille", "data-ton": "vert" }, "En ligne") : h("span", { class: "pastille" }, `Vue ${ilYa(c.vu_le)}`);
}

function tableauCampagnes(/** @type {any[]} */ liste) {
  if (!liste.length) return h("p", { class: "vide" }, "Aucune campagne pour l'instant.");
  return h("div", { class: "defile" }, h("table", { class: "tableau" },
    h("thead", {}, h("tr", {}, h("th", {}, "Campagne"), estWhyme() ? h("th", {}, "Client") : null, h("th", {}, "Statut"),
      h("th", { class: "nombre" }, "Visiteurs"), h("th", { class: "nombre" }, "Vidéos"),
      liste.some((c) => c.octets !== undefined) ? h("th", { class: "nombre" }, "Stockage") : null, h("th", {}, "Dernier passage"))),
    h("tbody", {}, ...liste.map((c) => h("tr", { class: "lien-ligne", onclick: () => { location.hash = `#/campagnes/${c.id}`; } },
      h("td", {}, h("a", { href: `#/campagnes/${c.id}` }, c.nom)), estWhyme() ? h("td", {}, c.client_nom) : null, h("td", {}, statut(c.statut)),
      h("td", { class: "nombre" }, String(c.nb_sessions ?? "—")), h("td", { class: "nombre" }, String(c.nb_reponses ?? "—")),
      c.octets !== undefined ? h("td", { class: "nombre" }, taille(c.octets)) : null,
      h("td", {}, ilYa(c.derniere_session)))))));
}

// ------------------------------------------------------------------ campagnes

async function vueCampagnes() {
  const { campagnes } = await api(estWhyme() ? "/api/admin/campagnes" : "/api/espace/campagnes");
  const page = h("div", {},
    enTete("Campagnes", estWhyme() ? "Chaque campagne a son parcours, ses textes de consentement validés par le client et ses cabines." : moi?.client?.nom ?? null,
      peut("campagnes.gerer") ? h("button", { type: "button", class: "bouton action", onclick: () => { form.hidden = !form.hidden; } }, "Nouvelle campagne") : null));
  const form = peut("campagnes.gerer") ? await formulaireCampagne() : h("span");
  form.hidden = true;
  page.append(form, h("section", { class: "carte" }, tableauCampagnes(campagnes)));
  return page;
}

async function formulaireCampagne() {
  const { clients } = await api("/api/admin/clients");
  const f = /** @type {HTMLFormElement} */ (h("form", { class: "carte formulaire", style: "margin-bottom: 18px" },
    champ("Client", h("select", { name: "client_id", required: true }, ...clients.map((/** @type {any} */ c) => h("option", { value: c.id }, c.nom)))),
    champ("Nom de la campagne", h("input", { name: "nom", required: true, maxlength: 120, placeholder: "Salon de l'auto, mars" })),
    champ("Début", h("input", { name: "debut", type: "date" })),
    champ("Fin", h("input", { name: "fin", type: "date" })),
    champ("Conservation des vidéos (jours)", h("input", { name: "conservation_jours", type: "number", min: 1, max: 1095, value: 365 })),
    h("div", { class: "boutons" }, h("button", { type: "submit", class: "bouton" }, "Créer la campagne"))));
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const v = valeurs(f);
    try {
      const r = await api("/api/admin/campagnes", { methode: "POST", corps: { ...v, debut: v.debut || undefined, fin: v.fin || undefined, conservation_jours: Number(v.conservation_jours) } });
      toast("Campagne créée. Ajoutez maintenant son parcours.");
      location.hash = `#/campagnes/${r.campagne.id}`;
    } catch (e) { toast(/** @type {Error} */ (e).message, "erreur"); }
  });
  return f;
}

async function vueCampagne(/** @type {string} */ id) {
  const base = estWhyme() ? "/api/admin/campagnes" : "/api/espace/campagnes";
  const { campagne: c } = await api(`${base}/${id}`);
  const onglet = new URLSearchParams(location.hash.split("?")[1] ?? "").get("onglet") ?? "reponses";

  const actions = h("div", { class: "boutons" });
  const changer = async (/** @type {string} */ cible, /** @type {string} */ message) => {
    await api(`/api/admin/campagnes/${c.id}/statut`, { methode: "POST", corps: { statut: cible } });
    toast(message); router();
  };
  if (peut("campagnes.gerer") && estWhyme()) {
    actions.append(h("button", { type: "button", class: "bouton discret", onclick: () => { edition.hidden = !edition.hidden; if (!edition.hidden) edition.querySelector("input")?.focus(); } },
      c.statut === "close" ? "Renommer" : "Modifier"));
  }
  if (peut("campagnes.gerer") && estWhyme() && (c.statut === "brouillon" || c.statut === "close")) {
    // Une campagne close (ex. campagne d'essai) se supprime avec tout ce qu'elle contient.
    const avecDonnees = c.statut === "close";
    actions.append(boutonConfirme("Supprimer la campagne", avecDonnees ? "Confirmer : tout supprimer, vidéos comprises" : "Confirmer la suppression", async () => {
      const r = await api(`/api/admin/campagnes/${c.id}`, { methode: "DELETE" });
      toast(avecDonnees && r.campagne.visiteurs ? `Campagne supprimée : ${r.campagne.visiteurs} visiteur(s), ${r.campagne.fichiers_supprimes} fichier(s).` : "Campagne supprimée.");
      location.hash = "#/campagnes";
    }, "bouton danger"));
  }
  if (peut("campagnes.gerer")) {
    if (c.statut === "brouillon" && peut("campagnes.valider")) actions.append(boutonConfirme("Valider", "Confirmer la validation", () => changer("validee", "Campagne validée."), "bouton discret"));
    if (c.statut === "validee") actions.append(
      boutonConfirme("Repasser en brouillon", "Confirmer", () => changer("brouillon", "Campagne repassée en brouillon.")),
      boutonConfirme("Activer", "Confirmer l'activation", () => changer("active", "Campagne active : les cabines affectées la jouent."), "bouton action"));
    if (c.statut === "active") actions.append(boutonConfirme("Clore la campagne", "Confirmer la clôture", () => changer("close", "Campagne close."), "bouton danger"));
  } else if (c.statut === "brouillon" && peut("campagnes.valider")) {
    actions.append(boutonConfirme("Valider les questions et les textes", "Confirmer la validation", async () => {
      await api(`/api/espace/campagnes/${c.id}/valider`, { methode: "POST", corps: {} });
      toast("Merci, la campagne est validée."); router();
    }, "bouton action"));
  }

  const infos = [
    c.client_nom ?? null,
    c.debut || c.fin ? `du ${jour(c.debut)} au ${jour(c.fin)}` : null,
    c.conservation_jours ? `vidéos conservées ${c.conservation_jours} jours` : null,
    c.option_analyse ? "option Analyse" : null,
    c.validee_par ? `validée par ${c.validee_par}` : null,
  ].filter(Boolean).join(" · ");

  // Modification du nom, des dates et de la durée de conservation.
  const edition = /** @type {HTMLFormElement} */ (h("form", { class: "carte formulaire", style: "margin-bottom: 18px", hidden: true },
    champ("Nom de la campagne", h("input", { name: "nom", required: true, maxlength: 120, value: c.nom })),
    c.statut === "close" ? null : champ("Début", h("input", { name: "debut", type: "date", value: c.debut ?? null })),
    c.statut === "close" ? null : champ("Fin", h("input", { name: "fin", type: "date", value: c.fin ?? null })),
    c.statut === "close" ? null : champ("Conservation des vidéos (jours)", h("input", { name: "conservation_jours", type: "number", min: 1, max: 1095, value: c.conservation_jours, disabled: c.statut === "active" })),
    c.statut === "close" ? null : h("label", { class: "champ large case-option" },
      h("span", { style: "display: flex; gap: 10px; align-items: center; color: var(--encre)" },
        h("input", { type: "checkbox", name: "option_analyse", checked: Boolean(c.option_analyse), disabled: c.statut === "active", style: "min-height: 0; width: 20px; height: 20px" }),
        "Option Analyse (transcription des réponses par Mistral AI, dans l'UE)"),
      h("span", { style: "font-weight: 400; font-size: 13px" }, c.statut === "active"
        ? "Elle ne change plus une fois la campagne active : elle figure dans les textes acceptés par les visiteurs."
        : "Vendue au contrat. L'activer ou la retirer régénère les textes de consentement et remet la campagne en brouillon. Sans elle, rien n'est envoyé hors de la plateforme.")),
    c.statut === "close" ? null : champ("Vocabulaire de la campagne (un terme par ligne : noms de modèles, de marques…)",
      h("textarea", { name: "vocabulaire", rows: 3, placeholder: "Ex. : Geely EX5", style: "min-height: 70px" }, (c.vocabulaire ?? []).join("\n")), "large"),
    c.statut === "close" ? h("p", { class: "large", style: "margin: 0; font-size: 13px; color: var(--doux)" }, "Campagne close : seul son nom peut encore changer.")
      : c.statut === "active" ? h("p", { class: "large", style: "margin: 0; font-size: 13px; color: var(--doux)" }, "La durée de conservation ne change plus une fois la campagne active : elle figure dans les textes acceptés par les visiteurs.")
      : c.statut === "validee" ? h("p", { class: "large", style: "margin: 0; font-size: 13px; color: var(--doux)" }, "Changer la durée régénère les textes de consentement et remet la campagne en brouillon (nouvelle validation du client).") : null,
    h("div", { class: "boutons large" }, h("button", { type: "submit", class: "bouton" }, "Enregistrer"),
      h("button", { type: "button", class: "bouton discret", onclick: () => { edition.hidden = true; } }, "Annuler"))));
  edition.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const v = valeurs(edition);
    try {
      const vocabulaire = (v.vocabulaire ?? "").split("\n").map((t) => t.trim()).filter(Boolean);
      await api(`/api/admin/campagnes/${c.id}`, { methode: "PATCH", corps: c.statut === "close" ? { nom: v.nom } : {
        nom: v.nom, debut: v.debut || null, fin: v.fin || null, vocabulaire,
        ...(c.statut === "active" ? {} : { conservation_jours: Number(v.conservation_jours), option_analyse: v.option_analyse === "on" }),
      } });
      toast("Campagne enregistrée."); router();
    } catch (e) { toast(/** @type {Error} */ (e).message, "erreur"); }
  });

  const zone = h("div", {});
  const onglets = [["reponses", "Réponses"], ["parlomix", "Parlomix"], ["parcours", "Parcours"], ["consentement", "Consentement"]];
  const barre = h("div", { class: "onglets", role: "tablist" }, ...onglets.map(([cle, libelle]) =>
    h("button", { type: "button", role: "tab", "aria-selected": String(cle === onglet), onclick: () => { location.hash = `#/campagnes/${c.id}?onglet=${cle}`; } }, libelle)));

  const options = new URLSearchParams(location.hash.split("?")[1] ?? "");
  if (onglet === "parlomix") zone.append(peut("reponses.lire") ? await vueParlomix(c, options) : h("p", { class: "vide" }, "Vous n'avez pas accès aux réponses."));
  else if (onglet === "parcours") zone.append(await vueParcours(c));
  else if (onglet === "consentement") zone.append(vueConsentement(c));
  else zone.append(peut("reponses.lire") ? await vueReponses(c) : h("p", { class: "vide" }, "Vous n'avez pas accès aux réponses."));

  return h("div", {},
    enTete(c.nom, h("span", {}, statut(c.statut), " ", infos), actions, h("a", { href: "#/campagnes" }, "Campagnes")),
    edition, peut("reponses.lire") ? chiffresCampagne(c) : null, barre, zone);
}

/** Réponses : par visiteur, ou toutes les réponses à une même question (pour écouter ce que les gens disent d'un sujet). */
async function vueReponses(/** @type {any} */ c) {
  const donnees = await api(`/api/espace/campagnes/${c.id}/sessions`);
  if (!donnees.sessions.length) {
    return h("section", { class: "carte vide" }, c.statut === "active"
      ? "Aucun visiteur pour l'instant. Les réponses apparaissent ici dès qu'une cabine les a envoyées."
      : "Aucune réponse : la campagne n'a pas encore été jouée.");
  }
  /** @type {Record<string, any>} */
  const questions = Object.fromEntries(donnees.questions.map((/** @type {any} */ q) => [q.id, q]));
  const zone = h("div", { class: "sessions" });
  let filtre = "";
  // Recherche par prénom et filtre par cabine.
  const recherche = /** @type {HTMLInputElement} */ (h("input", { type: "search", placeholder: "Rechercher un prénom", "aria-label": "Rechercher un prénom", class: "recherche" }));
  const cabinesVues = [...new Map(donnees.sessions.filter((/** @type {any} */ s) => s.cabine_id).map((/** @type {any} */ s) => [s.cabine_id, s.cabine_nom])).entries()];
  const choixCabine = /** @type {HTMLSelectElement} */ (h("select", { class: "choix-compact", "aria-label": "Cabine" }, h("option", { value: "" }, "Toutes les cabines"),
    ...cabinesVues.map(([id, nom]) => h("option", { value: id }, nom ?? "Cabine"))));
  // Choix déclarés par les visiteurs (qualification, aiguillage, modèle) : filtre, pastilles et répartition.
  /** @type {{ id: string, titre: string, options: { id: string, libelle: string }[] }[]} */
  const etapesChoix = donnees.choix ?? [];
  const libelleOption = (/** @type {string} */ etape, /** @type {string} */ option) =>
    etapesChoix.find((x) => x.id === etape)?.options.find((o) => o.id === option)?.libelle ?? option;
  const filtreChoix = /** @type {HTMLSelectElement} */ (h("select", { class: "choix-compact", "aria-label": "Filtrer par choix", hidden: !etapesChoix.length },
    h("option", { value: "" }, "Tous les parcours"),
    ...etapesChoix.map((e) => h("optgroup", { label: e.titre }, ...e.options.map((o) => h("option", { value: `${e.id}=${o.id}` }, o.libelle))))));
  const garde = (/** @type {any} */ s) => (!choixCabine.value || s.cabine_id === choixCabine.value)
    && (!filtreChoix.value || s.choix?.[filtreChoix.value.split("=")[0] ?? ""] === filtreChoix.value.split("=")[1])
    && (!recherche.value.trim() || String(s.prenom).toLocaleLowerCase("fr").includes(recherche.value.trim().toLocaleLowerCase("fr")));
  recherche.addEventListener("input", () => dessiner());
  choixCabine.addEventListener("change", () => dessiner());
  filtreChoix.addEventListener("change", () => dessiner());

  /** Répartition des choix (ce que les visiteurs ont déclaré, en nombre) sur les visiteurs affichés. */
  const repartition = () => {
    const visibles = donnees.sessions.filter((/** @type {any} */ s) => !s.retiree_le && garde(s));
    const etapes = etapesChoix.map((e) => {
      const total = visibles.filter((/** @type {any} */ s) => s.choix?.[e.id]).length;
      return { e, total, lignes: e.options.map((o) => ({ o, n: visibles.filter((/** @type {any} */ s) => s.choix?.[e.id] === o.id).length })) };
    }).filter((x) => x.total > 0);
    if (!etapes.length) return null;
    return h("section", { class: "carte repartition-choix" },
      h("h2", { style: "margin: 0" }, "Ce que les visiteurs ont choisi"),
      h("div", { class: "grille-choix" }, ...etapes.map(({ e, total, lignes }) => h("div", { class: "pile", style: "gap: 6px" },
        h("strong", {}, e.titre), h("span", { class: "detail-verif" }, `${total} réponse${total > 1 ? "s" : ""}`),
        ...lignes.map(({ o, n }) => h("div", { class: "ligne-choix" },
          h("span", {}, o.libelle),
          h("span", { class: "jauge", "aria-hidden": "true" }, h("span", { style: `width: ${total ? Math.round((n / total) * 100) : 0}%` })),
          h("span", { class: "nombre" }, `${n} · ${total ? Math.round((n / total) * 100) : 0} %`)))))));
  };
  const zoneRepartition = h("div", {});
  const puces = h("div", { class: "puces", role: "group", "aria-label": "Filtrer par question" });
  const dessinerPuces = () => puces.replaceChildren(
    h("button", { type: "button", class: "puce", "aria-pressed": String(!filtre), onclick: () => { filtre = ""; dessiner(); } }, "Par visiteur"),
    ...donnees.questions.map((/** @type {any} */ q) => h("button", { type: "button", class: "puce", "aria-pressed": String(filtre === q.id), onclick: () => { filtre = q.id; dessiner(); } }, q.titre)));

  const dessiner = () => {
    dessinerPuces();
    zoneRepartition.replaceChildren(...[repartition()].filter((x) => x !== null));
    const visibles = donnees.sessions.filter(garde);
    if (!visibles.length) { zone.replaceChildren(h("section", { class: "carte vide" }, "Aucun visiteur ne correspond à cette recherche.")); return; }
    if (!filtre) {
      zone.replaceChildren(...visibles.map((/** @type {any} */ s) => h("article", { class: "carte session" },
        h("div", { class: "session-tete" },
          h("span", { class: "prenom" }, s.prenom),
          h("span", { class: "quand" }, `${date(s.cree_le)}${s.cabine_nom ? ` · ${s.cabine_nom}` : ""}`),
          s.retiree_le ? h("span", { class: "pastille", "data-ton": "rouge" }, "Accord retiré")
            : s.consent_diffusion ? h("span", { class: "pastille", "data-ton": "vert" }, "Diffusion publique autorisée")
            : h("span", { class: "pastille" }, "Usage interne seulement"),
          s.recontact ? h("span", { class: "pastille", "data-ton": "vox" }, "Accepte d'être recontacté") : null,
          s.reponses.length && !s.retiree_le ? h("a", { class: "bouton discret petit", style: "margin-left: auto", href: `#/campagnes/${c.id}?onglet=parlomix&personne=${s.id}` }, "Parlomix de cette personne") : null),
        Object.keys(s.choix ?? {}).length ? h("div", { class: "choix-visiteur", "aria-label": "Ses choix" },
          ...etapesChoix.filter((e) => s.choix[e.id]).map((e) => h("span", { class: "pastille sans-point", title: e.titre }, libelleOption(e.id, s.choix[e.id])))) : null,
        peut("visiteurs.gerer") && !s.retiree_le ? h("div", { class: "boutons actions-visiteur" },
          s.consent_diffusion ? boutonConfirme("Retirer l'accord de diffusion", "Confirmer : usage interne seulement", async () => {
            await api(`/api/espace/sessions/${s.id}/diffusion-retiree`, { methode: "POST", corps: {} });
            toast("Accord de diffusion retiré : ses vidéos restent pour l'usage interne."); router();
          }, "bouton discret petit") : null,
          boutonConfirme("Supprimer ses données (retrait d'accord)", "Confirmer : vidéos et Parlomix supprimés définitivement", async () => {
            const r = await api(`/api/espace/sessions/${s.id}/retrait`, { methode: "POST", corps: {} });
            toast(`Données supprimées : ${r.session.videos_supprimees} vidéo(s), ${r.session.parlomix_supprimes} Parlomix.`); router();
          }, "bouton danger petit")) : null,
        s.reponses.length ? h("div", { class: "videos" }, ...s.reponses.map((/** @type {any} */ r) => tuileVideo(r, questions[r.etape_id]?.titre ?? r.etape_id)))
          : h("p", { class: "vide", style: "padding: 0; text-align: left" }, s.retiree_le ? "Les vidéos ne sont plus disponibles." : "Réponses en cours d'envoi depuis la cabine."))));
    } else {
      const toutes = visibles.flatMap((/** @type {any} */ s) => s.reponses.filter((/** @type {any} */ r) => r.etape_id === filtre).map((/** @type {any} */ r) => ({ r, s })));
      zone.replaceChildren(h("section", { class: "carte" },
        h("div", { style: "display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 12px" },
          h("p", { class: "question-texte" }, questions[filtre]?.texte || questions[filtre]?.titre),
          toutes.length ? h("a", { class: "bouton discret petit", href: `#/campagnes/${c.id}?onglet=parlomix&question=${filtre}` }, "Parlomix de cette question") : null),
        toutes.length ? h("div", { class: "videos" }, ...toutes.map((/** @type {{ r: any, s: any }} */ { r, s }) => tuileVideo(r, s.prenom, date(s.cree_le))))
          : h("p", { class: "vide" }, "Personne n'a encore répondu à cette question.")));
    }
  };
  dessiner();
  const exporter = h("a", { class: "bouton discret petit", href: `/api/espace/campagnes/${c.id}/export.csv`, download: "" }, "Exporter les visiteurs (tableur)");
  if (!lectureDirecte()) {
    // En local, l'identité passe par un en-tête : téléchargement par le script.
    exporter.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const res = await fetch(`/api/espace/campagnes/${c.id}/export.csv`, { headers: enTetesDev() });
      const lien = h("a", { href: URL.createObjectURL(await res.blob()), download: `visiteurs-${c.slug ?? "campagne"}.csv` });
      lien.click();
    });
  }
  return h("div", {},
    h("div", { class: "barre-reponses" },
      h("p", { class: "sous", style: "margin: 0; color: var(--doux)" },
        `${donnees.total} visiteur${donnees.total > 1 ? "s" : ""}. Chaque visionnage et chaque export sont enregistrés dans le journal.`),
      h("div", { class: "boutons" }, recherche, cabinesVues.length > 1 ? choixCabine : null, filtreChoix, exporter)),
    zoneRepartition, puces, zone);
}

/** En local, l'identité passe par un en-tête : la vidéo est téléchargée puis lue. En ligne, le lecteur la lit en continu. */
const lectureDirecte = () => !["localhost", "127.0.0.1"].includes(location.hostname);

/** Message compréhensible pour une coupure réseau (« Failed to fetch ») ou une session expirée. */
function messageReseau(/** @type {unknown} */ e) {
  return e instanceof TypeError
    ? "Connexion interrompue pendant le chargement. Réessayez ; si cela continue, rechargez la page (votre session a peut-être expiré)."
    : /** @type {Error} */ (e).message;
}

/** Téléchargement avec une nouvelle tentative en cas de coupure réseau. */
async function telechargerVideo(/** @type {string} */ url) {
  for (let essai = 1; ; essai++) {
    try {
      const res = await fetch(url, { headers: enTetesDev(), credentials: "same-origin" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? "Vidéo indisponible");
      return await res.blob();
    } catch (e) {
      if (!(e instanceof TypeError) || essai >= 2) throw e;
    }
  }
}

/**
 * Remplace le contenu d'un écran par le lecteur vidéo. En ligne, lecture en continu (démarrage immédiat) ;
 * en local, téléchargement complet. Renvoie l'adresse à utiliser pour « Télécharger ».
 */
async function lireDans(/** @type {HTMLElement} */ ecran, /** @type {string} */ url) {
  ecran.replaceChildren(h("span", { class: "lecture" }, "Chargement…"));
  const source = lectureDirecte() ? url : URL.createObjectURL(await telechargerVideo(url));
  const v = /** @type {HTMLVideoElement} */ (h("video", { src: source, controls: true, playsinline: true, preload: "auto" }));
  v.addEventListener("error", () => {
    ecran.replaceChildren(h("span", { class: "lecture" }, "Lecture impossible : connexion interrompue ou session expirée. Rechargez la page puis réessayez."));
  });
  ecran.replaceChildren(v);
  v.play().catch(() => {});
  return lectureDirecte() ? `${url}?telecharger=1` : source;
}

// ------------------------------------------------------------------ miniatures

/** Adresse lisible par une balise <img> ou <video> : directe en ligne, blob en local (l'identité passe par un en-tête). */
async function sourceMedia(/** @type {string} */ url) {
  return lectureDirecte() ? url : URL.createObjectURL(await telechargerVideo(url));
}

/** Pose une vignette sous le bouton « Lire » d'un écran vidéo. */
function poserVignette(/** @type {HTMLElement} */ ecran, /** @type {string} */ source) {
  const img = /** @type {HTMLImageElement} */ (h("img", { class: "vignette", alt: "", loading: "lazy", decoding: "async" }));
  img.addEventListener("error", () => img.remove());
  img.src = source;
  ecran.querySelector(".vignette")?.remove();
  ecran.prepend(img);
}

/**
 * Image JPEG tirée d'une vidéo (recadrage « cover »), vers 1,2 s : après le compte à rebours, le visiteur parle.
 * @returns {Promise<Blob>}
 */
async function imageDeVideo(/** @type {string} */ url, largeur = 320, hauteur = 180) {
  const src = await sourceMedia(url);
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto";
  /** @param {"loadeddata" | "seeked"} evenement */
  const attendre = (evenement) => new Promise((ok, ko) => {
    const delai = setTimeout(() => ko(new Error("Vidéo trop lente à charger")), 20_000);
    v.addEventListener(evenement, () => { clearTimeout(delai); ok(null); }, { once: true });
    v.addEventListener("error", () => { clearTimeout(delai); ko(new Error("Vidéo illisible")); }, { once: true });
  });
  try {
    const pret = attendre("loadeddata");
    v.src = src;
    await pret;
    const cale = attendre("seeked");
    v.currentTime = Number.isFinite(v.duration) && v.duration > 0 ? Math.min(1.2, v.duration / 2) : 1.2;
    await cale;
    const c = document.createElement("canvas");
    c.width = largeur; c.height = hauteur;
    const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
    const ratio = Math.max(largeur / v.videoWidth, hauteur / v.videoHeight);
    ctx.drawImage(v, (largeur - v.videoWidth * ratio) / 2, (hauteur - v.videoHeight * ratio) / 2, v.videoWidth * ratio, v.videoHeight * ratio);
    return await new Promise((ok, ko) => c.toBlob((b) => (b ? ok(b) : ko(new Error("Image impossible"))), "image/jpeg", 0.72));
  } finally {
    v.removeAttribute("src"); v.load();
    if (src.startsWith("blob:")) URL.revokeObjectURL(src);
  }
}

/**
 * Rattrapage : les réponses enregistrées avant les miniatures en reçoivent une, fabriquée ici une par une,
 * seulement pour les tuiles affichées à l'écran. Chaque lecture est tracée à part dans le journal (reponse.miniature).
 * @type {{ r: any, ecran: HTMLElement }[]}
 */
const aRattraper = [];
let rattrapageEnCours = false;
const observateurMiniatures = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entrees) => {
  for (const e of entrees) {
    if (!e.isIntersecting) continue;
    observateurMiniatures?.unobserve(e.target);
    const tache = /** @type {any} */ (e.target).tacheMiniature;
    if (tache) { aRattraper.push(tache); rattraper(); }
  }
}, { rootMargin: "200px" });

async function rattraper() {
  if (rattrapageEnCours) return;
  rattrapageEnCours = true;
  try {
    while (aRattraper.length) {
      const { r, ecran } = /** @type {{ r: any, ecran: HTMLElement }} */ (aRattraper.shift());
      if (!ecran.isConnected || ecran.querySelector("video") || r.miniature) continue;
      try {
        const image = await imageDeVideo(`/api/espace/reponses/${r.id}/video?pour=miniature`);
        const res = await fetch(`/api/espace/reponses/${r.id}/miniature`, {
          method: "PUT", body: image, credentials: "same-origin", headers: { ...enTetesDev(), "content-type": "image/jpeg" },
        });
        if (!res.ok) continue;
        r.miniature = true;
        if (!ecran.querySelector("video")) poserVignette(ecran, URL.createObjectURL(image));
      } catch { /* vidéo illisible ou réseau : la tuile reste sans vignette */ }
    }
  } finally {
    rattrapageEnCours = false;
  }
}

function tuileVideo(/** @type {any} */ r, /** @type {string} */ titre, /** @type {string} */ sous = "") {
  const ecran = h("button", { type: "button", class: "ecran-video", "aria-label": `Lire la réponse : ${titre}` },
    h("span", { class: "lecture" }, icone(ICONES.lecture), "Lire"));
  if (r.miniature) {
    sourceMedia(`/api/espace/reponses/${r.id}/miniature`).then((src) => poserVignette(ecran, src)).catch(() => {});
  } else if (r.statut !== "en_attente" && observateurMiniatures) {
    /** @type {any} */ (ecran).tacheMiniature = { r, ecran };
    observateurMiniatures.observe(ecran);
  }
  ecran.addEventListener("click", async () => {
    if (ecran.querySelector("video")) return;
    try { await lireDans(ecran, `/api/espace/reponses/${r.id}/video`); }
    catch (e) { ecran.replaceChildren(h("span", { class: "lecture" }, messageReseau(e))); }
  });
  return h("div", { class: "video" }, ecran,
    h("div", { class: "legende" }, h("strong", {}, titre), h("span", {}, sous || duree(r.duree_ms))),
    r.son_present === false ? h("span", { class: "pastille", "data-ton": "rouge" }, "Son non détecté") : null,
    blocTranscription(r, ecran));
}

// ------------------------------------------------------------------ transcriptions (option Analyse)

/**
 * Regroupe les mots horodatés en lignes lisibles : nouvelle ligne après une fin de phrase, un silence de plus de
 * 0,8 s ou 14 mots.
 * @param {{ d: number, f: number, t: string }[]} segments
 * @returns {{ d: number, f: number, texte: string }[]}
 */
function lignesTranscription(segments) {
  /** @type {{ d: number, f: number, texte: string }[]} */
  const lignes = [];
  let mots = 0;
  for (const s of segments) {
    const der = lignes[lignes.length - 1];
    const couper = !der || s.d - der.f > 0.8 || mots >= 14 || /[.!?…]$/.test(der.texte);
    if (couper) { lignes.push({ d: s.d, f: s.f, texte: s.t }); mots = s.t.split(/\s+/).length; }
    else { der.texte += (/^[,.;:!?…)]/.test(s.t) ? "" : " ") + s.t; der.f = s.f; mots += s.t.split(/\s+/).length; }
  }
  return lignes;
}

const minutes = (/** @type {number} */ s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** État et lecture de la transcription d'une réponse. Le texte n'est chargé qu'à la demande (lecture journalisée). */
function blocTranscription(/** @type {any} */ r, /** @type {HTMLElement} */ ecran) {
  if (!r.transcription_etat) return null;
  if (r.transcription_etat === "a_faire" || r.transcription_etat === "en_cours") return h("span", { class: "pastille", "data-ton": "jaune" }, "Transcription en cours");
  if (r.transcription_etat === "echec") return h("span", { class: "pastille", "data-ton": "rouge" }, "Transcription impossible");
  const zone = h("div", { class: "transcription", hidden: true });
  const bouton = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "bouton discret petit", "aria-expanded": "false" }, "Lire la transcription"));
  bouton.addEventListener("click", async () => {
    if (!zone.hidden) { zone.hidden = true; bouton.setAttribute("aria-expanded", "false"); bouton.textContent = "Lire la transcription"; return; }
    if (!zone.childElementCount) {
      bouton.disabled = true;
      try {
        const { transcription: t } = await api(`/api/espace/reponses/${r.id}/transcription`);
        const lignes = lignesTranscription(t.segments ?? []);
        zone.replaceChildren(...(lignes.length ? lignes.map((l) => {
          // Un clic sur une ligne place la vidéo à ce moment (si elle est ouverte).
          const b = h("button", { type: "button", class: "ligne-transcription", "data-debut": String(l.d) },
            h("span", { class: "temps" }, minutes(l.d)), h("span", {}, l.texte));
          b.addEventListener("click", () => {
            const v = /** @type {HTMLVideoElement | null} */ (ecran.querySelector("video"));
            if (v) { v.currentTime = l.d; v.play().catch(() => {}); } else ecran.click();
          });
          return b;
        }) : [h("p", { class: "ligne-transcription" }, t.texte || "Aucune parole reconnue.")]));
      } catch (e) {
        toast(/** @type {Error} */ (e).message, "erreur");
        bouton.disabled = false;
        return;
      }
      bouton.disabled = false;
    }
    zone.hidden = false; bouton.setAttribute("aria-expanded", "true"); bouton.textContent = "Masquer la transcription";
  });
  return h("div", { class: "pile", style: "gap: 6px" }, bouton, zone);
}

// ------------------------------------------------------------------ Parlomix (montages)

/**
 * Parlomix : création (par personne, par question dans la campagne ou dans une cabine) et liste des montages.
 * Le film est fabriqué ici, dans le navigateur, puis envoyé au stockage de la plateforme.
 */
async function vueParlomix(/** @type {any} */ c, /** @type {URLSearchParams} */ options) {
  const [donnees, { parlomix }] = await Promise.all([api(`/api/espace/campagnes/${c.id}/sessions?limite=300`), api(`/api/espace/campagnes/${c.id}/parlomix`)]);
  const sessions = donnees.sessions.filter((/** @type {any} */ s) => !s.retiree_le && s.reponses.length);
  const questions = donnees.questions;
  const cabines = [...new Map(sessions.filter((/** @type {any} */ s) => s.cabine_id).map((/** @type {any} */ s) => [s.cabine_id, s.cabine_nom])).entries()];

  const liste = h("div", { class: "videos parlomix-liste" });
  const dessinerListe = (/** @type {any[]} */ elements) => liste.replaceChildren(...(elements.length ? elements.map(tuileParlomix)
    : [h("p", { class: "vide", style: "grid-column: 1 / -1" }, "Aucun Parlomix pour l'instant. Créez le premier ci-dessus.")]));
  dessinerListe(parlomix);

  if (!sessions.length) {
    return h("div", { class: "pile" }, h("section", { class: "carte vide" }, "Il faut des réponses pour faire un Parlomix : aucune pour l'instant."),
      h("section", { class: "carte" }, h("h2", {}, "Parlomix de la campagne"), liste));
  }

  let type = options.get("question") ? "question" : "personne";
  const puceType = (/** @type {string} */ valeur, /** @type {string} */ libelle) => h("button", { type: "button", class: "puce", "aria-pressed": String(type === valeur), onclick: () => { type = valeur; majFormulaire(); } }, libelle);
  const typesPuces = h("div", { class: "puces", role: "group", "aria-label": "Type de Parlomix" });
  const choixPersonne = /** @type {HTMLSelectElement} */ (h("select", {}, ...sessions.map((/** @type {any} */ s) =>
    h("option", { value: s.id, selected: s.id === options.get("personne") }, `${s.prenom} · ${date(s.cree_le)}${s.cabine_nom ? ` · ${s.cabine_nom}` : ""} · ${s.reponses.length} réponse${s.reponses.length > 1 ? "s" : ""}`))));
  const choixQuestion = /** @type {HTMLSelectElement} */ (h("select", {}, ...questions.map((/** @type {any} */ q) => h("option", { value: q.id, selected: q.id === options.get("question") }, q.titre))));
  const choixCabine = /** @type {HTMLSelectElement} */ (h("select", {}, h("option", { value: "" }, "Toutes les cabines"), ...cabines.map(([id, nom]) => h("option", { value: id }, nom ?? "Cabine"))));
  const case_ = (/** @type {string} */ libelle, coche = true) => {
    const entree = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: coche }));
    return { entree, element: h("label", { class: "case-admin" }, entree, libelle) };
  };
  const format169 = case_("16:9 (présentations)");
  const format916 = case_("9:16 (réseaux sociaux)");
  const diffusion = case_("Seulement les personnes qui acceptent la diffusion publique", false);
  const prenoms = case_("Afficher les prénoms");
  const champPersonne = champ("Personne", choixPersonne);
  const champQuestion = champ("Question", choixQuestion);
  const champCabine = champ("Cabine", choixCabine);
  const resume = h("p", { class: "resume-parlomix" });
  const lancer = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "bouton action" }, "Créer le Parlomix"));
  const suivi = h("div", { class: "suivi-parlomix", hidden: true });

  const selection = () => type === "personne"
    ? choixParPersonne(/** @type {any} */ (sessions.find((/** @type {any} */ s) => s.id === choixPersonne.value)), questions, donnees.choix ?? [])
      .filter(() => !diffusion.entree.checked || sessions.find((/** @type {any} */ s) => s.id === choixPersonne.value)?.consent_diffusion)
    : choixParQuestion(sessions, {
      etape: choixQuestion.value, cabine: choixCabine.value || null, diffusionSeulement: diffusion.entree.checked, avecPrenoms: prenoms.entree.checked,
      question: questions.find((/** @type {any} */ q) => q.id === choixQuestion.value), etapesChoix: donnees.choix ?? [],
    });

  function majFormulaire() {
    typesPuces.replaceChildren(puceType("personne", "Par personne"), puceType("question", "Par question"));
    champPersonne.hidden = type !== "personne";
    champQuestion.hidden = champCabine.hidden = prenoms.element.hidden = type !== "question";
    const choix = selection();
    const total = sessions.filter((/** @type {any} */ s) => !choixCabine.value || s.cabine_id === choixCabine.value)
      .flatMap((/** @type {any} */ s) => s.reponses).filter((/** @type {any} */ r) => r.etape_id === choixQuestion.value).length;
    const secondes = Math.round(choix.reduce((n, x) => n + x.dureeMs, 0) / 1000);
    resume.textContent = !choix.length ? "Aucune réponse ne correspond à ces critères."
      : `${choix.length} réponse${choix.length > 1 ? "s" : ""}${type === "question" && total > CLIPS_MAX ? ` (les ${CLIPS_MAX} plus récentes sur ${total})` : ""}, ${Math.floor(secondes / 60)} min ${String(secondes % 60).padStart(2, "0")} avant coupe des blancs.`;
    lancer.disabled = !choix.length || (!format169.entree.checked && !format916.entree.checked);
  }
  for (const el of [choixPersonne, choixQuestion, choixCabine, format169.entree, format916.entree, diffusion.entree, prenoms.entree]) el.addEventListener("change", majFormulaire);
  majFormulaire();

  lancer.addEventListener("click", async () => {
    const choix = selection();
    const formats = /** @type {("16:9" | "9:16")[]} */ ([format169.entree.checked ? "16:9" : null, format916.entree.checked ? "9:16" : null].filter(Boolean));
    if (!choix.length || !formats.length) return;
    if (!formatsDisponibles().length) { toast("Ce navigateur ne sait pas enregistrer de vidéo. Utilisez Chrome à jour.", "erreur"); return; }
    lancer.disabled = true;
    const etape = h("strong", {}, "Préparation");
    const detail = h("span", {});
    const barre = h("span", { class: "barre-parlomix" }, h("span", {}));
    const apercu = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "apercu-parlomix" }));
    suivi.hidden = false;
    suivi.replaceChildren(h("div", { class: "pile", style: "gap: 8px; flex: 1; min-width: 240px" }, etape, detail, barre,
      h("span", { class: "detail-parlomix" }, "Gardez cet onglet ouvert et visible : le film se fabrique en direct, à peu près en sa durée réelle.")), apercu);
    const avancer = (/** @type {number} */ f) => { /** @type {HTMLElement} */ (barre.firstChild).style.width = `${Math.round(f * 100)}%`; };
    try {
      // 1. Les réponses : téléchargement et repérage des blancs.
      /** @type {Map<string, Blob>} */ const videos = new Map();
      const clips = [];
      for (const [i, x] of choix.entries()) {
        detail.textContent = `Réponse ${i + 1} sur ${choix.length} : téléchargement et coupe des blancs`;
        avancer(i / choix.length);
        const blob = await telechargerVideo(`/api/espace/reponses/${x.id}/video`);
        videos.set(x.id, blob);
        const a = await analyserReponse(blob);
        const dureeMs = a.dureeMs || x.dureeMs;
        clips.push({ ...x, dureeMs, segments: a.segments.length ? a.segments : /** @type {[number, number][]} */ ([[0, dureeMs]]) });
      }
      const avant = clips.reduce((n, x) => n + x.dureeMs, 0);
      const apres = clips.reduce((n, x) => n + dureeSegments(x.segments), 0);
      // Habillage de la campagne : le Parlomix reprend polices, couleurs, ambiances et visuels de la cabine.
      const theme = themeDepuisCouleurs(c.client?.couleurs, donnees.habillage, donnees.ambiance);
      const logo = await chargerLogo(c.client?.logo_url);
      const visuels = await chargerVisuels(donnees.habillage);
      const question = questions.find((/** @type {any} */ q) => q.id === choixQuestion.value);
      const personne = sessions.find((/** @type {any} */ s) => s.id === choixPersonne.value);
      const cabineNom = cabines.find(([id]) => id === choixCabine.value)?.[1];
      const titre = type === "personne" ? personne.prenom : question.titre;
      const sousTitre = type === "personne" ? c.nom : `${question.texte}${cabineNom ? ` · ${cabineNom}` : ""}`;

      // 2. Un film par format.
      for (const format of formats) {
        etape.textContent = `Montage ${format}`;
        detail.textContent = `${clips.length} réponse${clips.length > 1 ? "s" : ""}, ${Math.round((avant - apres) / 1000)} s de blancs coupés`;
        const plan = planParlomix({ type: /** @type {"personne" | "question"} */ (type), titre, sousTitre, signature: c.client?.nom ?? "Parlopop", clips, format, theme });
        let film = await fabriquer({ plan, videos, apercu, logo, visuels, surProgression: avancer });
        if (!(await contientDuSon(film.blob)) && film.type === "video/mp4") {
          // Leçon Geely : un MP4 peut perdre le son sans erreur. On refait le film en WebM.
          detail.textContent = "Son absent du MP4 : nouveau montage en WebM";
          const webm = formatsDisponibles().find((f) => f.startsWith("video/webm"));
          if (webm) film = await fabriquer({ plan, videos, apercu, logo, visuels, format: webm, surProgression: avancer });
        }
        etape.textContent = `Envoi ${format}`;
        detail.textContent = `${Math.round(film.blob.size / 1e5) / 10} Mo`;
        const decl = await api(`/api/espace/campagnes/${c.id}/parlomix`, { methode: "POST", corps: {
          type, format, titre: `${titre}${cabineNom && type === "question" ? ` · ${cabineNom}` : ""}`, plan,
          session_id: type === "personne" ? personne.id : undefined,
          etape_id: type === "question" ? question.id : undefined,
          cabine_id: type === "question" && choixCabine.value ? choixCabine.value : undefined,
        } });
        const res = await fetch(`/api/espace/parlomix/${decl.parlomix.id}/fichier`, {
          method: "PUT", body: film.blob, credentials: "same-origin",
          headers: { ...enTetesDev(), "content-type": film.type, "x-duree-ms": String(film.dureeMs) },
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? "Envoi impossible");
        // Vignette : la carte d'ouverture du film, sans bloquer si elle échoue.
        await envoyerVignetteParlomix(decl.parlomix.id, plan, logo, visuels).catch(() => {});
      }
      suivi.replaceChildren(h("strong", {}, `Parlomix prêt${formats.length > 1 ? "s" : ""} : ${formats.join(" et ")}.`));
      toast("Parlomix prêt.");
      dessinerListe((await api(`/api/espace/campagnes/${c.id}/parlomix`)).parlomix);
    } catch (e) {
      suivi.replaceChildren(h("strong", { style: "color: var(--rouge)" }, `Le montage a échoué : ${messageReseau(e)}`));
    } finally {
      lancer.disabled = false;
    }
  });

  return h("div", { class: "pile" },
    h("section", { class: "carte pile" },
      h("div", {}, h("h2", { style: "margin: 0 0 4px" }, "Créer un Parlomix"),
        h("p", { style: "margin: 0; color: var(--doux); font-size: 14px" }, "Les blancs sont coupés, les réponses s'enchaînent avec une animation aux couleurs de la campagne et le jingle Parlopop.")),
      typesPuces,
      h("div", { class: "formulaire" }, champPersonne, champQuestion, champCabine),
      h("div", { class: "options-parlomix" }, format169.element, format916.element, diffusion.element, prenoms.element),
      h("div", { class: "boutons" }, lancer, resume),
      suivi),
    h("section", { class: "carte" }, h("h2", {}, "Parlomix de la campagne"), liste));
}

/** Vignette d'un Parlomix : sa carte d'ouverture (titre aux couleurs de la campagne), au format du film. */
async function envoyerVignetteParlomix(/** @type {string} */ id, /** @type {any} */ plan, /** @type {HTMLImageElement | null} */ logo, /** @type {Map<string, HTMLImageElement>} */ visuels) {
  const portrait = plan.format === "9:16";
  const c = document.createElement("canvas");
  c.width = portrait ? 180 : 320; c.height = portrait ? 320 : 180;
  const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
  const intro = plan.sequences.find((/** @type {any} */ x) => x.type === "carte" && x.role === "intro");
  if (!intro) return;
  dessinerCarte(ctx, intro, 0.75, plan.theme, logo, visuels);
  const image = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.8));
  if (!image) return;
  await fetch(`/api/espace/parlomix/${id}/miniature`, {
    method: "PUT", body: image, credentials: "same-origin", headers: { ...enTetesDev(), "content-type": "image/jpeg" },
  });
}

/** Visuels de l'habillage (SVG autonomes, vérifiés par le serveur) en images, pour les cartes du Parlomix. */
async function chargerVisuels(/** @type {any} */ habillage) {
  /** @type {Map<string, HTMLImageElement>} */ const visuels = new Map();
  for (const v of habillage?.visuels ?? []) {
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(v.svg)}`;
    try { await img.decode(); visuels.set(v.id, img); } catch { /* visuel illisible : la carte s'en passe */ }
  }
  return visuels;
}

/** Logo du client pour les cartes du Parlomix (seulement s'il est hébergé par la plateforme : sinon le canevas serait bloqué). */
async function chargerLogo(/** @type {string | null | undefined} */ url) {
  if (!url || !url.startsWith("/")) return null;
  const img = new Image();
  img.src = url;
  try { await img.decode(); return img; } catch { return null; }
}

function tuileParlomix(/** @type {any} */ p) {
  const portrait = p.format === "9:16";
  const ecran = h("button", { type: "button", class: `ecran-video${portrait ? " portrait" : ""}`, "aria-label": `Lire le Parlomix : ${p.titre}`, disabled: !p.disponible },
    h("span", { class: "lecture" }, p.disponible ? icone(ICONES.lecture) : null, p.disponible ? "Lire" : "Plus disponible"));
  if (p.miniature && p.disponible) {
    sourceMedia(`/api/espace/parlomix/${p.id}/miniature`).then((src) => poserVignette(ecran, src)).catch(() => {});
  }
  const telecharger = h("a", { class: "bouton discret petit", hidden: true }, "Télécharger");
  ecran.addEventListener("click", async () => {
    if (ecran.querySelector("video")) return;
    try {
      const lien = await lireDans(ecran, `/api/espace/parlomix/${p.id}/video`);
      telecharger.setAttribute("href", lien);
      telecharger.setAttribute("download", `parlomix-${p.titre.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}-${p.format.replace(":", "x")}.${p.type_mime === "video/mp4" ? "mp4" : "webm"}`);
      telecharger.hidden = false;
    } catch (e) {
      ecran.replaceChildren(h("span", { class: "lecture" }, messageReseau(e)));
    }
  });
  return h("div", { class: "video" }, ecran,
    h("div", { class: "legende" }, h("strong", {}, p.titre), h("span", {}, duree(p.duree_ms))),
    h("div", { class: "boutons", style: "gap: 6px" },
      h("span", { class: "pastille sans-point" }, p.type === "personne" ? "Par personne" : p.cabine_nom ? "Par question, une cabine" : "Par question"),
      h("span", { class: "pastille sans-point" }, p.format),
      !p.disponible ? h("span", { class: "pastille", "data-ton": "rouge" }, "Accord retiré")
        : p.diffusable ? h("span", { class: "pastille", "data-ton": "vert" }, "Diffusable") : h("span", { class: "pastille" }, "Usage interne"),
      telecharger,
      p.cree_par === moi?.email || (estWhyme() && peut("campagnes.gerer")) ? boutonConfirme("Supprimer", "Confirmer", async () => {
        await api(`/api/espace/parlomix/${p.id}`, { methode: "DELETE" });
        toast("Parlomix supprimé."); router();
      }, "bouton danger petit") : null),
    h("span", { style: "font-size: 13px; color: var(--doux)" }, `${p.nb_extraits} réponse${p.nb_extraits > 1 ? "s" : ""} · ${date(p.cree_le)} · ${p.cree_par}`));
}

/** Affichage d'un texte du parcours : l'emplacement {prenom} devient « [prénom] ». */
const lisible = (/** @type {string} */ t) => String(t).replaceAll("{prenom}", "[prénom]");

async function vueParcours(/** @type {any} */ c) {
  const p = c.parcours;
  const modifiable = peut("campagnes.gerer") && estWhyme() && c.statut !== "active" && c.statut !== "close";
  /** @type {{ libelle: string, charger: () => Promise<any> }[]} */
  const modeles = [{ libelle: "Parcours neutre Parlopop (démo)", charger: async () => (await fetch("modeles/parcours-neutre.json")).json() }];
  if (modifiable) {
    const { campagnes } = await api("/api/admin/campagnes");
    for (const autre of campagnes.filter((/** @type {any} */ x) => x.id !== c.id && x.parcours_version_id).slice(0, 12)) {
      modeles.push({ libelle: `Copier : ${autre.nom} (${autre.client_nom})`, charger: async () => (await api(`/api/admin/campagnes/${autre.id}`)).campagne.parcours?.config });
    }
  }
  const entete = h("div", { class: "entete-parcours" },
    h("span", { style: "color: var(--doux); font-size: 14px" }, p ? `Version ${p.numero}, créée par ${p.cree_par}, ${date(p.cree_le)}` : "Pas encore de parcours."),
    c.statut === "active" ? h("span", { class: "pastille", "data-ton": "jaune" }, "Campagne active : le parcours ne se modifie plus (créez une nouvelle campagne et copiez-le)") : null,
    p ? h("a", { class: "bouton discret petit", href: URL.createObjectURL(new Blob([JSON.stringify(p.config, null, 2)], { type: "application/json" })), download: `parcours-v${p.numero}.json` }, "Télécharger le JSON") : null);
  return h("div", { class: "pile" }, entete, editeurParcours({
    config: p?.config ?? { version: 1, langue: "fr", etapes: [] },
    lectureSeule: !modifiable,
    modeles,
    valider: async (config) => modifiable ? (await api("/api/admin/parcours/valider", { methode: "POST", corps: { config } })).problemes : [],
    enregistrer: async (config) => {
      await api(`/api/admin/campagnes/${c.id}/parcours`, { methode: "POST", corps: { config } });
      toast("Nouvelle version du parcours enregistrée. La campagne repasse en brouillon : à faire valider."); router();
    },
    apercu: (config) => {
      const diffusion = config.etapes.some((/** @type {any} */ e) => e.type === "consentement" && e.proposerDiffusion);
      const apercu = {
        cabine: { id: "apercu", nom: "Aperçu" },
        campagne: { id: "apercu", nom: c.nom, parcours_version_id: "apercu" },
        client: c.client ?? { nom: "Parlopop", logo_url: null, couleurs: {} },
        parcours: config,
        consentement: {
          id: "apercu",
          texte_interne: c.consentement?.texte_interne ?? "Texte de consentement (généré depuis la fiche client, onglet Consentement).",
          texte_diffusion: diffusion ? (c.consentement?.texte_diffusion ?? `J'accepte aussi que ${c.client?.nom ?? "la marque"} utilise ma vidéo dans ses communications publiques.`) : null,
        },
      };
      try { localStorage.setItem("voxbox.apercu", JSON.stringify(apercu)); } catch { toast("Aperçu impossible : stockage du navigateur indisponible.", "erreur"); return; }
      window.open("/cabine/?apercu=1", "parlopop-apercu");
    },
  }));
}

function vueConsentement(/** @type {any} */ c) {
  const t = c.consentement;
  const carte = h("section", { class: "carte pile" });
  if (!t) carte.append(h("h2", {}, "Textes de consentement"), h("p", { class: "vide" }, "Pas encore de textes."));
  else carte.append(
    h("h2", { style: "margin: 0" }, `Textes de consentement, version ${t.numero}`),
    h("div", {}, h("strong", {}, "Usage interne (obligatoire)"), h("p", { class: "texte-long" }, t.texte_interne)),
    h("div", {}, h("strong", {}, "Diffusion publique (facultatif)"), h("p", { class: "texte-long" }, t.texte_diffusion)),
    h("p", { style: "margin: 0; font-size: 13px; color: var(--doux)" }, `Empreinte ${String(t.empreinte).slice(0, 16)}… · ${date(t.cree_le)}. Chaque visiteur est rattaché à la version exacte qu'il a acceptée.`));
  if (peut("campagnes.gerer") && c.statut !== "active" && c.statut !== "close") {
    carte.append(h("div", { class: "boutons" }, boutonConfirme(t ? "Régénérer depuis la fiche client" : "Générer depuis la fiche client", "Confirmer", async () => {
      await api(`/api/admin/campagnes/${c.id}/consentement`, { methode: "POST", corps: {} });
      toast("Textes générés : à faire valider par le client."); router();
    })));
  }
  return carte;
}

// ------------------------------------------------------------------ cabines

async function vueCabines() {
  const [{ cabines }, { campagnes }] = await Promise.all([api("/api/admin/cabines"), api("/api/admin/campagnes")]);
  const jouables = campagnes.filter((/** @type {any} */ c) => c.statut !== "close");
  const nom = /** @type {HTMLInputElement} */ (h("input", { name: "nom", required: true, maxlength: 60, placeholder: "Tablette salon 1" }));
  const f = /** @type {HTMLFormElement} */ (h("form", { class: "carte formulaire", style: "margin-bottom: 18px", hidden: true },
    champ("Nom de la cabine", nom), h("div", { class: "boutons" }, h("button", { type: "submit", class: "bouton" }, "Créer la cabine"))));
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try { await api("/api/admin/cabines", { methode: "POST", corps: { nom: nom.value } }); toast("Cabine créée : saisissez son code sur la tablette."); router(); }
    catch (e) { toast(/** @type {Error} */ (e).message, "erreur"); }
  });

  return h("div", {},
    enTete("Cabines", "Une tablette s'appaire une fois avec un code à usage unique, puis joue la campagne qui lui est affectée.",
      h("div", { class: "boutons" },
        h("a", { class: "bouton discret", href: "affiche.html", target: "_blank", rel: "noopener" }, "Affiche QR à imprimer"),
        h("button", { type: "button", class: "bouton action", onclick: () => { f.hidden = !f.hidden; if (!f.hidden) nom.focus(); } }, "Nouvelle cabine"))),
    f,
    cabines.length ? h("div", { class: "cabines" }, ...cabines.map((/** @type {any} */ cab) => carteCabine(cab, jouables)))
      : h("section", { class: "carte vide" }, "Aucune cabine pour l'instant."));
}

function carteCabine(/** @type {any} */ cab, /** @type {any[]} */ campagnes) {
  const s = signal(cab);
  const choix = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": `Campagne de ${cab.nom}` },
    h("option", { value: "" }, "Aucune campagne"),
    ...campagnes.map((c) => h("option", { value: c.id, selected: c.id === cab.campagne_id }, `${c.nom} (${c.client_nom})${c.statut === "active" ? "" : ` · ${STATUTS[c.statut]?.[0] ?? c.statut}`}`))));
  choix.addEventListener("change", async () => {
    try { await api(`/api/admin/cabines/${cab.id}`, { methode: "PATCH", corps: { campagne_id: choix.value || null } }); toast("Affectation enregistrée. La tablette la prend en compte entre deux visiteurs."); }
    catch (e) { toast(/** @type {Error} */ (e).message, "erreur"); router(); }
  });
  const details = [
    ["État", etatCabine(cab)],
    ["Dernier signal", ilYa(cab.vu_le)],
    s.batterie !== undefined && s.batterie !== null ? ["Batterie", `${s.batterie} %${s.en_charge ? " (en charge)" : ""}`] : null,
    s.file !== undefined && s.file !== null ? ["Envois en attente", String(s.file)] : null,
    s.micro !== undefined && s.micro !== null ? ["Micro", s.micro ? "actif" : "inactif"] : null,
    s.version ? ["Version", s.version] : null,
  ].filter(Boolean);
  // Nom modifiable sur place.
  const titre = h("span", { class: "nom" }, cab.nom);
  const entree = /** @type {HTMLInputElement} */ (h("input", { value: cab.nom, maxlength: 60, "aria-label": `Nouveau nom pour ${cab.nom}` }));
  const renommage = /** @type {HTMLFormElement} */ (h("form", { class: "renommage", hidden: true }, entree,
    h("button", { type: "submit", class: "bouton petit" }, "Enregistrer"),
    h("button", { type: "button", class: "bouton discret petit", onclick: () => { renommage.hidden = true; ligneTitre.hidden = false; } }, "Annuler")));
  renommage.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await api(`/api/admin/cabines/${cab.id}`, { methode: "PATCH", corps: { nom: entree.value } });
      toast("Cabine renommée."); router();
    } catch (e) { toast(/** @type {Error} */ (e).message, "erreur"); }
  });
  const ligneTitre = h("div", { class: "titre-cabine" }, titre,
    h("button", { type: "button", class: "bouton discret petit", onclick: () => { ligneTitre.hidden = true; renommage.hidden = false; entree.focus(); entree.select(); } }, "Renommer"));
  const utilisee = Number(cab.nb_sessions ?? 0) > 0;
  return h("article", { class: "carte cabine" },
    ligneTitre, renommage,
    h("dl", {}, ...details.map((d) => [h("dt", {}, /** @type {any} */ (d)[0]), h("dd", {}, /** @type {any} */ (d)[1])])),
    champ("Campagne jouée", choix),
    cab.code_appairage ? h("div", { class: "pile", style: "gap: 6px" }, h("span", { style: "font-size: 14px; color: var(--doux)" }, "Code d'appairage à saisir sur la tablette"), h("span", { class: "code" }, cab.code_appairage)) : null,
    h("div", { class: "boutons" },
      boutonConfirme(cab.appairee ? "Nouveau code (déconnecte la tablette)" : "Nouveau code", "Confirmer", async () => {
        await api(`/api/admin/cabines/${cab.id}/code`, { methode: "POST", corps: {} });
        toast("Nouveau code généré."); router();
      }, "bouton discret petit"),
      boutonConfirme("Supprimer", utilisee ? "Confirmer (la tablette sera déconnectée)" : "Confirmer la suppression", async () => {
        const r = await api(`/api/admin/cabines/${cab.id}`, { methode: "DELETE" });
        toast(r.cabine.resultat === "retiree"
          ? "Cabine retirée : tablette déconnectée. Les réponses déjà recueillies restent dans leurs campagnes."
          : "Cabine supprimée.");
        router();
      }, "bouton danger petit")),
    utilisee ? h("span", { style: "font-size: 13px; color: var(--doux)" },
      `${cab.nb_sessions} visiteur${cab.nb_sessions > 1 ? "s" : ""} recueilli${cab.nb_sessions > 1 ? "s" : ""} : en cas de suppression, ces réponses restent dans leurs campagnes.`) : null);
}

// ------------------------------------------------------------------ clients

/** Formulaire de fiche client, en création ou en modification. */
function formulaireClient(/** @type {any} */ c = null) {
  const couleurs = c?.couleurs ?? {};
  const fichier = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept: "image/png,image/jpeg,image/webp" }));
  const apercuLogo = /** @type {HTMLImageElement} */ (h("img", { class: "logo-client", alt: "", src: c?.logo_url ?? null, hidden: !c?.logo_url }));
  fichier.addEventListener("change", () => {
    const f = fichier.files?.[0];
    if (f) { apercuLogo.src = URL.createObjectURL(f); apercuLogo.hidden = false; }
  });
  const f = /** @type {HTMLFormElement} */ (h("form", { class: "carte formulaire", style: "margin-bottom: 18px" },
    champ("Nom de marque", h("input", { name: "nom", required: true, maxlength: 80, value: c?.nom ?? null })),
    champ("Raison sociale (responsable de traitement)", h("input", { name: "raison_sociale", required: true, maxlength: 160, value: c?.raison_sociale ?? null })),
    champ("Contact RGPD affiché au visiteur", h("input", { name: "contact_rgpd", required: true, maxlength: 160, placeholder: "dpo@marque.fr", value: c?.contact_rgpd ?? null })),
    champ("Couleur de la marque", h("input", { name: "principale", type: "color", value: couleurs.principale ?? "#3F4C8F" })),
    champ("Couleur des réponses", h("input", { name: "secondaire", type: "color", value: couleurs.secondaire ?? "#F2D27A" })),
    h("div", { class: "champ" }, "Logo (PNG, JPEG ou WebP, 1 Mo au plus)", h("div", { class: "ligne-logo" }, apercuLogo, fichier)),
    h("div", { class: "boutons large" },
      h("button", { type: "submit", class: "bouton" }, c ? "Enregistrer" : "Créer le client"),
      h("button", { type: "button", class: "bouton discret", onclick: () => { f.remove(); } }, "Annuler"))));
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const v = valeurs(f);
    const corps = {
      nom: v.nom, raison_sociale: v.raison_sociale, contact_rgpd: v.contact_rgpd,
      couleurs: { ...couleurs, principale: v.principale?.toUpperCase(), secondaire: v.secondaire?.toUpperCase() },
    };
    try {
      const r = c ? await api(`/api/admin/clients/${c.id}`, { methode: "PATCH", corps }) : await api("/api/admin/clients", { methode: "POST", corps });
      const logo = fichier.files?.[0];
      if (logo) {
        const res = await fetch(`/api/admin/clients/${r.client.id}/logo`, { method: "PUT", body: logo, credentials: "same-origin", headers: { ...enTetesDev(), "content-type": logo.type } });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? "Logo refusé");
      }
      toast(c ? "Fiche client enregistrée. La cabine l'affichera entre deux visiteurs." : "Client créé."); router();
    } catch (e) { toast(/** @type {Error} */ (e).message, "erreur"); }
  });
  return f;
}

async function vueClients() {
  const { clients } = await api("/api/admin/clients");
  const zoneFormulaire = h("div", {});
  const ouvrir = (/** @type {any} */ c) => { zoneFormulaire.replaceChildren(formulaireClient(c)); zoneFormulaire.scrollIntoView({ behavior: "smooth", block: "start" }); };
  return h("div", {},
    enTete("Clients", "WhyMe est sous-traitant ; chaque marque est responsable de traitement de ses données.",
      h("button", { type: "button", class: "bouton action", onclick: () => ouvrir(null) }, "Nouveau client")),
    zoneFormulaire,
    h("section", { class: "carte" }, clients.length ? h("div", { class: "defile" }, h("table", { class: "tableau" },
      h("thead", {}, h("tr", {}, h("th", {}, "Marque"), h("th", {}, "Responsable de traitement"), h("th", {}, "Contact RGPD"), h("th", {}, "Habillage"), h("th", {}, ""))),
      h("tbody", {}, ...clients.map((/** @type {any} */ c) => h("tr", {},
        h("td", {}, h("strong", {}, c.nom)), h("td", {}, c.raison_sociale), h("td", {}, c.contact_rgpd),
        h("td", {}, h("span", { style: "display: inline-flex; gap: 6px; align-items: center" },
          c.logo_url ? h("img", { class: "logo-client petit", src: c.logo_url, alt: `Logo ${c.nom}` }) : null,
          ...["principale", "secondaire"].filter((k) => c.couleurs?.[k]).map((k) =>
            h("span", { title: c.couleurs[k], style: `display: inline-block; width: 22px; height: 22px; border-radius: 8px 8px 8px 3px; background: ${/^#[0-9a-fA-F]{6}$/.test(c.couleurs[k]) ? c.couleurs[k] : "transparent"}` })))),
        h("td", { style: "text-align: right" }, h("button", { type: "button", class: "bouton discret petit", onclick: () => ouvrir(c) }, "Modifier")))))))
      : h("p", { class: "vide" }, "Aucun client.")));
}

// ------------------------------------------------------------------ comptes

async function vueComptes() {
  const [{ utilisateurs }, { clients }] = await Promise.all([api("/api/admin/utilisateurs"), api("/api/admin/clients")]);
  const role = /** @type {HTMLSelectElement} */ (h("select", { name: "role" }, ...Object.entries(ROLES).map(([k, v]) => h("option", { value: k, selected: k === "lecteur_client" }, v))));
  const client = /** @type {HTMLSelectElement} */ (h("select", { name: "client_id" }, ...clients.map((/** @type {any} */ c) => h("option", { value: c.id }, c.nom))));
  const champClient = champ("Client", client);
  const majClient = () => { champClient.hidden = role.value.endsWith("_whyme"); };
  role.addEventListener("change", majClient);
  const f = /** @type {HTMLFormElement} */ (h("form", { class: "carte formulaire", style: "margin-bottom: 18px", hidden: true },
    champ("E-mail (celui utilisé pour se connecter)", h("input", { name: "email", type: "email", required: true, maxlength: 160 })),
    champ("Rôle", role), champClient,
    h("div", { class: "boutons" }, h("button", { type: "submit", class: "bouton" }, "Créer le compte"))));
  majClient();
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const v = valeurs(f);
    try {
      await api("/api/admin/utilisateurs", { methode: "POST", corps: { email: v.email, role: v.role, client_id: v.role.endsWith("_whyme") ? undefined : v.client_id } });
      toast("Compte créé. La personne se connecte avec cet e-mail."); router();
    } catch (e) { toast(/** @type {Error} */ (e).message, "erreur"); }
  });
  return h("div", {},
    enTete("Comptes", "Un compte client ne voit que les campagnes de son client.",
      h("button", { type: "button", class: "bouton action", onclick: () => { f.hidden = !f.hidden; } }, "Nouveau compte")),
    f,
    h("section", { class: "carte" }, utilisateurs.length ? h("div", { class: "defile" }, h("table", { class: "tableau" },
      h("thead", {}, h("tr", {}, h("th", {}, "E-mail"), h("th", {}, "Rôle"), h("th", {}, "Client"), h("th", {}, "État"), h("th", {}, ""))),
      h("tbody", {}, ...utilisateurs.map((/** @type {any} */ u) => h("tr", {},
        h("td", {}, u.email),
        h("td", {}, u.email === moi?.email ? (ROLES[u.role] ?? u.role) : choixRole(u, clients)),
        h("td", {}, u.client_nom ?? "WhyMe"),
        h("td", {}, u.actif ? h("span", { class: "pastille", "data-ton": "vert" }, "Actif") : h("span", { class: "pastille" }, "Désactivé")),
        h("td", { style: "text-align: right" }, u.email === moi?.email ? null : boutonConfirme(u.actif ? "Désactiver" : "Réactiver", "Confirmer", async () => {
          await api(`/api/admin/utilisateurs/${u.id}`, { methode: "PATCH", corps: { actif: !u.actif } });
          toast(u.actif ? "Compte désactivé." : "Compte réactivé."); router();
        }, "bouton discret petit")))))))
      : h("p", { class: "vide" }, "Aucun compte en dehors des administrateurs d'office.")),
    h("p", { style: "color: var(--doux); font-size: 14px" }, "Les administrateurs d'office sont définis dans la configuration du serveur et n'apparaissent pas ici."));
}

/** Rôle d'un compte, modifiable directement (avec le client pour un compte client). */
function choixRole(/** @type {any} */ u, /** @type {any[]} */ clients) {
  const role = /** @type {HTMLSelectElement} */ (h("select", { class: "choix-compact", "aria-label": `Rôle de ${u.email}` },
    ...Object.entries(ROLES).map(([k, v]) => h("option", { value: k, selected: k === u.role }, v))));
  const client = /** @type {HTMLSelectElement} */ (h("select", { class: "choix-compact", "aria-label": `Client de ${u.email}`, hidden: true },
    ...clients.map((c) => h("option", { value: c.id, selected: c.id === u.client_id }, c.nom))));
  const valider = h("button", { type: "button", class: "bouton petit", hidden: true }, "Enregistrer");
  const maj = () => {
    const change = role.value !== u.role || (!role.value.endsWith("_whyme") && client.value !== u.client_id);
    client.hidden = role.value.endsWith("_whyme");
    valider.hidden = !change;
  };
  role.addEventListener("change", maj);
  client.addEventListener("change", maj);
  valider.addEventListener("click", async () => {
    try {
      await api(`/api/admin/utilisateurs/${u.id}`, { methode: "PATCH", corps: { role: role.value, client_id: role.value.endsWith("_whyme") ? undefined : client.value } });
      toast("Rôle modifié : il s'applique dès la prochaine page ouverte par la personne."); router();
    } catch (e) { toast(/** @type {Error} */ (e).message, "erreur"); }
  });
  return h("span", { class: "ligne-role" }, role, client, valider);
}

// ------------------------------------------------------------------ journal

async function vueJournal() {
  const { journal } = await api("/api/admin/journal?limite=200");
  return h("div", {},
    enTete("Journal", "Toutes les actions sensibles et chaque visionnage de vidéo. Le journal ne se modifie jamais."),
    h("section", { class: "carte" }, journal.length ? h("div", { class: "defile" }, h("table", { class: "tableau" },
      h("thead", {}, h("tr", {}, h("th", {}, "Quand"), h("th", {}, "Qui"), h("th", {}, "Action"), h("th", {}, "Détails"))),
      h("tbody", {}, ...journal.map((/** @type {any} */ j) => h("tr", {},
        h("td", { style: "white-space: nowrap" }, date(j.quand)), h("td", {}, j.utilisateur_email),
        h("td", {}, ACTIONS[j.action] ?? j.action),
        h("td", { style: "color: var(--doux); font-size: 13px" }, resumeDetails(j)))))))
      : h("p", { class: "vide" }, "Rien pour l'instant.")));
}

function resumeDetails(/** @type {any} */ j) {
  let d = {};
  try { d = j.details ? JSON.parse(j.details) : {}; } catch { /* détails illisibles */ }
  const morceaux = Object.entries(d).filter(([k]) => !k.endsWith("_id")).map(([k, v]) => `${k} : ${v}`);
  return morceaux.join(" · ") || (j.cible_type ? `${j.cible_type}` : "");
}

// ------------------------------------------------------------------ démarrage

async function demarrer() {
  try {
    moi = await api("/api/moi");
  } catch (e) {
    const err = /** @type {any} */ (e);
    contenu.replaceChildren(h("div", { class: "carte", style: "max-width: 560px" },
      h("h1", { style: "font-family: var(--titres); font-weight: 600; margin-top: 0" }, err.status === 403 ? "Accès non autorisé" : "Connexion impossible"),
      h("p", {}, err.status === 403 ? "Votre compte n'a pas accès à la plateforme. Demandez à WhyMe de vous créer un compte." : err.message)));
    return;
  }
  const m = /** @type {Moi} */ (moi);
  $("qui").replaceChildren(h("strong", {}, m.email), ROLES[m.role] ?? m.role, m.client ? ` · ${m.client.nom}` : "",
    m.environnement === "production" ? "" : h("div", { style: "margin-top: 6px" }, h("span", { class: "pastille", "data-ton": "jaune" }, m.environnement === "test" ? "Environnement de test" : "Développement local")));
  window.addEventListener("hashchange", router);
  router();
}

demarrer();
