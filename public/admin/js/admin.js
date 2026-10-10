// @ts-check
// Espace Vox Boxes : WhyMe (clients, campagnes, cabines, comptes, journal) et clients (leurs campagnes, leurs réponses).
// Une seule page, navigation par ancre (#/campagnes/…). Tout le texte venant de la base est inséré en texte, jamais en HTML.

/** @typedef {{ email: string, role: string, client: any, droits: string[], environnement: string }} Moi */

/** @type {Moi | null} */ let moi = null;
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const contenu = $("contenu");

// ------------------------------------------------------------------ utilitaires

/** h("p", { class: "x" }, "texte", enfant…) */
function h(/** @type {string} */ tag, /** @type {Record<string, any>} */ attrs = {}, /** @type {any[]} */ ...enfants) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const e of enfants.flat()) if (e !== null && e !== undefined && e !== false) el.append(e instanceof Node ? e : String(e));
  return el;
}

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

async function api(/** @type {string} */ chemin, /** @type {{ methode?: string, corps?: unknown }} */ opts = {}) {
  const res = await fetch(chemin, {
    method: opts.methode ?? "GET",
    headers: { ...enTetesDev(), ...(opts.corps !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.corps !== undefined ? JSON.stringify(opts.corps) : undefined,
    credentials: "same-origin",
  });
  const corps = await res.json().catch(() => ({}));
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
  "client.creation": "Client créé", "client.modification": "Client modifié",
  "utilisateur.creation": "Compte créé", "utilisateur.desactivation": "Compte désactivé", "utilisateur.reactivation": "Compte réactivé",
  "campagne.creation": "Campagne créée", "campagne.parcours": "Nouveau parcours", "campagne.consentement": "Nouveaux textes de consentement",
  "campagne.statut.validee": "Campagne validée", "campagne.statut.active": "Campagne activée", "campagne.statut.close": "Campagne close",
  "campagne.statut.brouillon": "Campagne repassée en brouillon",
  "cabine.creation": "Cabine créée", "cabine.affectation": "Cabine affectée", "cabine.nouveau_code": "Nouveau code d'appairage", "cabine.appairage": "Tablette appairée",
  "reponse.visionnage": "Vidéo visionnée",
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
      h("th", { class: "nombre" }, "Visiteurs"), h("th", { class: "nombre" }, "Vidéos"), h("th", {}, "Dernier passage"))),
    h("tbody", {}, ...liste.map((c) => h("tr", { class: "lien-ligne", onclick: () => { location.hash = `#/campagnes/${c.id}`; } },
      h("td", {}, h("a", { href: `#/campagnes/${c.id}` }, c.nom)), estWhyme() ? h("td", {}, c.client_nom) : null, h("td", {}, statut(c.statut)),
      h("td", { class: "nombre" }, String(c.nb_sessions ?? "—")), h("td", { class: "nombre" }, String(c.nb_reponses ?? "—")),
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
    c.validee_par ? `validée par ${c.validee_par}` : null,
  ].filter(Boolean).join(" · ");

  const zone = h("div", {});
  const onglets = [["reponses", "Réponses"], ["parcours", "Parcours"], ["consentement", "Consentement"]];
  const barre = h("div", { class: "onglets", role: "tablist" }, ...onglets.map(([cle, libelle]) =>
    h("button", { type: "button", role: "tab", "aria-selected": String(cle === onglet), onclick: () => { location.hash = `#/campagnes/${c.id}?onglet=${cle}`; } }, libelle)));

  if (onglet === "parcours") zone.append(vueParcours(c));
  else if (onglet === "consentement") zone.append(vueConsentement(c));
  else zone.append(peut("reponses.lire") ? await vueReponses(c) : h("p", { class: "vide" }, "Vous n'avez pas accès aux réponses."));

  return h("div", {},
    enTete(c.nom, h("span", {}, statut(c.statut), " ", infos), actions, h("a", { href: "#/campagnes" }, "Campagnes")),
    barre, zone);
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
  const puces = h("div", { class: "puces", role: "group", "aria-label": "Filtrer par question" });
  const dessinerPuces = () => puces.replaceChildren(
    h("button", { type: "button", class: "puce", "aria-pressed": String(!filtre), onclick: () => { filtre = ""; dessiner(); } }, "Par visiteur"),
    ...donnees.questions.map((/** @type {any} */ q) => h("button", { type: "button", class: "puce", "aria-pressed": String(filtre === q.id), onclick: () => { filtre = q.id; dessiner(); } }, q.titre)));

  const dessiner = () => {
    dessinerPuces();
    if (!filtre) {
      zone.replaceChildren(...donnees.sessions.map((/** @type {any} */ s) => h("article", { class: "carte session" },
        h("div", { class: "session-tete" },
          h("span", { class: "prenom" }, s.prenom),
          h("span", { class: "quand" }, `${date(s.cree_le)}${s.cabine_nom ? ` · ${s.cabine_nom}` : ""}`),
          s.retiree_le ? h("span", { class: "pastille", "data-ton": "rouge" }, "Accord retiré")
            : s.consent_diffusion ? h("span", { class: "pastille", "data-ton": "vert" }, "Diffusion publique autorisée")
            : h("span", { class: "pastille" }, "Usage interne seulement"),
          s.recontact ? h("span", { class: "pastille", "data-ton": "vox" }, "Accepte d'être recontacté") : null),
        s.reponses.length ? h("div", { class: "videos" }, ...s.reponses.map((/** @type {any} */ r) => tuileVideo(r, questions[r.etape_id]?.titre ?? r.etape_id)))
          : h("p", { class: "vide", style: "padding: 0; text-align: left" }, s.retiree_le ? "Les vidéos ne sont plus disponibles." : "Réponses en cours d'envoi depuis la cabine."))));
    } else {
      const toutes = donnees.sessions.flatMap((/** @type {any} */ s) => s.reponses.filter((/** @type {any} */ r) => r.etape_id === filtre).map((/** @type {any} */ r) => ({ r, s })));
      zone.replaceChildren(h("section", { class: "carte" },
        h("p", { class: "question-texte" }, questions[filtre]?.texte || questions[filtre]?.titre),
        toutes.length ? h("div", { class: "videos" }, ...toutes.map((/** @type {{ r: any, s: any }} */ { r, s }) => tuileVideo(r, s.prenom, date(s.cree_le))))
          : h("p", { class: "vide" }, "Personne n'a encore répondu à cette question.")));
    }
  };
  dessiner();
  return h("div", {},
    h("p", { class: "sous", style: "margin: 0 0 12px; color: var(--doux)" },
      `${donnees.total} visiteur${donnees.total > 1 ? "s" : ""}. Chaque visionnage est enregistré dans le journal.`),
    puces, zone);
}

function tuileVideo(/** @type {any} */ r, /** @type {string} */ titre, /** @type {string} */ sous = "") {
  const ecran = h("button", { type: "button", class: "ecran-video", "aria-label": `Lire la réponse : ${titre}` },
    h("span", { class: "lecture" }, icone(ICONES.lecture), "Lire"));
  ecran.addEventListener("click", async () => {
    if (ecran.querySelector("video")) return;
    ecran.replaceChildren(h("span", { class: "lecture" }, "Chargement…"));
    try {
      const res = await fetch(`/api/espace/reponses/${r.id}/video`, { headers: enTetesDev(), credentials: "same-origin" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? "Vidéo indisponible");
      const url = URL.createObjectURL(await res.blob());
      const v = /** @type {HTMLVideoElement} */ (h("video", { src: url, controls: true, playsinline: true }));
      ecran.replaceChildren(v);
      v.play().catch(() => {});
    } catch (e) {
      ecran.replaceChildren(h("span", { class: "lecture" }, /** @type {Error} */ (e).message));
    }
  });
  return h("div", { class: "video" }, ecran,
    h("div", { class: "legende" }, h("strong", {}, titre), h("span", {}, sous || duree(r.duree_ms))),
    r.son_present === false ? h("span", { class: "pastille", "data-ton": "rouge" }, "Son non détecté") : null);
}

/** Affichage d'un texte du parcours : l'emplacement {prenom} devient « [prénom] ». */
const lisible = (/** @type {string} */ t) => String(t).replaceAll("{prenom}", "[prénom]");

function vueParcours(/** @type {any} */ c) {
  const p = c.parcours;
  const bloc = h("div", { class: "grille deux" });
  const gauche = h("section", { class: "carte" });
  if (!p) gauche.append(h("h2", {}, "Parcours"), h("p", { class: "vide" }, "Aucun parcours pour l'instant."));
  else {
    const fichier = new Blob([JSON.stringify(p.config, null, 2)], { type: "application/json" });
    gauche.append(
      h("div", { style: "display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px" },
        h("h2", { style: "margin: 0" }, `Parcours, version ${p.numero}`),
        h("a", { class: "bouton discret petit", href: URL.createObjectURL(fichier), download: `parcours-v${p.numero}.json` }, "Télécharger le JSON")),
      h("p", { style: "margin: 0 0 14px; color: var(--doux); font-size: 14px" }, `Créée par ${p.cree_par}, ${date(p.cree_le)}`),
      h("ol", { class: "etapes" }, ...p.config.etapes.map((/** @type {any} */ e, /** @type {number} */ i) => h("li", {},
        h("span", { class: "num" }, String(i + 1)),
        h("span", { class: "texte" }, h("strong", {}, lisible(e.titreCourt ?? e.titre ?? TYPES_ETAPES[e.type] ?? e.type)), h("span", {}, lisible(e.texte ?? (e.titreCourt ? e.titre : "") ?? ""))),
        h("span", { class: "pastille sans-point" }, TYPES_ETAPES[e.type] ?? e.type)))));
  }
  bloc.append(gauche);
  if (peut("campagnes.gerer") && c.statut !== "active" && c.statut !== "close") {
    const zoneTexte = /** @type {HTMLTextAreaElement} */ (h("textarea", { name: "config", spellcheck: "false", placeholder: "Collez ici le fichier de parcours (JSON)" }));
    if (p) zoneTexte.value = JSON.stringify(p.config, null, 2);
    const erreurs = h("ul", { class: "erreurs", hidden: true });
    const f = /** @type {HTMLFormElement} */ (h("form", { class: "carte pile" },
      h("h2", { style: "margin: 0" }, "Nouvelle version"),
      h("p", { style: "margin: 0; color: var(--doux); font-size: 14px" }, "Toute nouvelle version remet la campagne en brouillon : le client devra la valider à nouveau."),
      champ("Fichier de parcours (JSON)", zoneTexte), erreurs,
      h("div", { class: "boutons" }, h("button", { type: "submit", class: "bouton" }, "Enregistrer la version"))));
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      erreurs.hidden = true;
      let config;
      try { config = JSON.parse(zoneTexte.value); } catch { erreurs.replaceChildren(h("li", {}, "Le texte n'est pas un JSON valide.")); erreurs.hidden = false; return; }
      try {
        await api(`/api/admin/campagnes/${c.id}/parcours`, { methode: "POST", corps: { config } });
        toast("Nouvelle version enregistrée."); router();
      } catch (e) {
        const pb = /** @type {any} */ (e).corps?.problemes ?? [/** @type {Error} */ (e).message];
        erreurs.replaceChildren(...pb.map((/** @type {string} */ x) => h("li", {}, x))); erreurs.hidden = false;
      }
    });
    bloc.append(f);
  } else if (c.statut === "active") {
    bloc.append(h("section", { class: "carte" }, h("h2", {}, "Modifier le parcours"),
      h("p", { style: "margin: 0; color: var(--doux)" }, "Une campagne active ne se modifie plus. Pour changer les questions, créez une nouvelle campagne.")));
  }
  return bloc;
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
      h("button", { type: "button", class: "bouton action", onclick: () => { f.hidden = !f.hidden; if (!f.hidden) nom.focus(); } }, "Nouvelle cabine")),
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
  return h("article", { class: "carte cabine" },
    h("span", { class: "nom" }, cab.nom),
    h("dl", {}, ...details.map((d) => [h("dt", {}, /** @type {any} */ (d)[0]), h("dd", {}, /** @type {any} */ (d)[1])])),
    champ("Campagne jouée", choix),
    cab.code_appairage ? h("div", { class: "pile", style: "gap: 6px" }, h("span", { style: "font-size: 14px; color: var(--doux)" }, "Code d'appairage à saisir sur la tablette"), h("span", { class: "code" }, cab.code_appairage)) : null,
    h("div", { class: "boutons" }, boutonConfirme(cab.appairee ? "Nouveau code (déconnecte la tablette)" : "Nouveau code", "Confirmer", async () => {
      await api(`/api/admin/cabines/${cab.id}/code`, { methode: "POST", corps: {} });
      toast("Nouveau code généré."); router();
    }, "bouton discret petit")));
}

// ------------------------------------------------------------------ clients

async function vueClients() {
  const { clients } = await api("/api/admin/clients");
  const f = /** @type {HTMLFormElement} */ (h("form", { class: "carte formulaire", style: "margin-bottom: 18px", hidden: true },
    champ("Nom de marque", h("input", { name: "nom", required: true, maxlength: 80 })),
    champ("Raison sociale (responsable de traitement)", h("input", { name: "raison_sociale", required: true, maxlength: 160 })),
    champ("Contact RGPD affiché au visiteur", h("input", { name: "contact_rgpd", required: true, maxlength: 160, placeholder: "dpo@marque.fr" })),
    champ("Logo (adresse https, facultatif)", h("input", { name: "logo_url", type: "url", maxlength: 500 })),
    champ("Couleur de la marque", h("input", { name: "principale", type: "color", value: "#3F4C8F" })),
    champ("Couleur des réponses", h("input", { name: "secondaire", type: "color", value: "#F2D27A" })),
    h("div", { class: "boutons" }, h("button", { type: "submit", class: "bouton" }, "Créer le client"))));
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const v = valeurs(f);
    try {
      await api("/api/admin/clients", { methode: "POST", corps: {
        nom: v.nom, raison_sociale: v.raison_sociale, contact_rgpd: v.contact_rgpd, logo_url: v.logo_url || undefined,
        couleurs: { principale: v.principale?.toUpperCase(), secondaire: v.secondaire?.toUpperCase() },
      } });
      toast("Client créé."); router();
    } catch (e) { toast(/** @type {Error} */ (e).message, "erreur"); }
  });
  return h("div", {},
    enTete("Clients", "WhyMe est sous-traitant ; chaque marque est responsable de traitement de ses données.",
      h("button", { type: "button", class: "bouton action", onclick: () => { f.hidden = !f.hidden; } }, "Nouveau client")),
    f,
    h("section", { class: "carte" }, clients.length ? h("div", { class: "defile" }, h("table", { class: "tableau" },
      h("thead", {}, h("tr", {}, h("th", {}, "Marque"), h("th", {}, "Responsable de traitement"), h("th", {}, "Contact RGPD"), h("th", {}, "Couleurs"))),
      h("tbody", {}, ...clients.map((/** @type {any} */ c) => h("tr", {},
        h("td", {}, h("strong", {}, c.nom)), h("td", {}, c.raison_sociale), h("td", {}, c.contact_rgpd),
        h("td", {}, h("span", { style: "display: inline-flex; gap: 6px" }, ...["principale", "secondaire"].filter((k) => c.couleurs?.[k]).map((k) =>
          h("span", { title: c.couleurs[k], style: `display: inline-block; width: 22px; height: 22px; border-radius: 8px 8px 8px 3px; background: ${/^#[0-9a-fA-F]{6}$/.test(c.couleurs[k]) ? c.couleurs[k] : "transparent"}` })))))))))
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
        h("td", {}, u.email), h("td", {}, ROLES[u.role] ?? u.role), h("td", {}, u.client_nom ?? "WhyMe"),
        h("td", {}, u.actif ? h("span", { class: "pastille", "data-ton": "vert" }, "Actif") : h("span", { class: "pastille" }, "Désactivé")),
        h("td", { style: "text-align: right" }, u.email === moi?.email ? null : boutonConfirme(u.actif ? "Désactiver" : "Réactiver", "Confirmer", async () => {
          await api(`/api/admin/utilisateurs/${u.id}`, { methode: "PATCH", corps: { actif: !u.actif } });
          toast(u.actif ? "Compte désactivé." : "Compte réactivé."); router();
        }, "bouton discret petit")))))))
      : h("p", { class: "vide" }, "Aucun compte en dehors des administrateurs d'office.")),
    h("p", { style: "color: var(--doux); font-size: 14px" }, "Les administrateurs d'office sont définis dans la configuration du serveur et n'apparaissent pas ici."));
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
