// @ts-check
// Espace RH Why me (/rh/), réservé à l'équipe RH (séparée des comptes Parlobox). Organisation :
// - Campagnes : liste, création guidée (client, nom, événement), puis la page de la campagne avec ses onglets
//   Questionnaire (éditeur), Interviews et vidéos, Lien et QR code, Statistiques du client ;
// - Vidéos : toutes les vidéos montées ; Clients : organisations qui commandent, et leurs contacts ;
// - Entreprises : sous-clients et leurs recruteurs ; E-mails ; Équipe.
// Tout le texte venant de la base est inséré en texte (h()).

import { h } from "../../admin/js/dom.js";
import { genererQR, cheminQR } from "../../cabine/js/qr.js";
import { editeurCampagne } from "./editeur-campagne.js";

const contenu = /** @type {HTMLElement} */ (document.getElementById("contenu"));
const toastEl = /** @type {HTMLElement} */ (document.getElementById("toast"));

/** @returns {Record<string, string>} */
function enTetesDev() {
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) return {};
  let email = "admin@whyme.test";
  try { email = localStorage.getItem("voxbox.dev-email") ?? email; } catch { /* stockage indisponible */ }
  return { "x-dev-email": email };
}

async function api(/** @type {string} */ chemin, /** @type {{ methode?: string, corps?: unknown, brut?: Blob, type?: string }} */ o = {}) {
  let res;
  try {
    res = await fetch(chemin, {
      method: o.methode ?? "GET",
      headers: { ...enTetesDev(), ...(o.corps !== undefined ? { "content-type": "application/json" } : {}), ...(o.type ? { "content-type": o.type } : {}) },
      body: o.brut ?? (o.corps !== undefined ? JSON.stringify(o.corps) : undefined),
      credentials: "same-origin",
    });
  } catch {
    throw new Error("Connexion impossible : vérifiez le réseau, puis réessayez.");
  }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(d.message ?? "Accès refusé : rechargez la page pour vous reconnecter.");
    throw new Error(d.message ?? `Le serveur a répondu ${res.status}.`);
  }
  return d;
}

function toast(/** @type {string} */ m, ton = "ok") {
  toastEl.textContent = m; toastEl.dataset.ton = ton; toastEl.hidden = false;
  clearTimeout(Number(toastEl.dataset.minuterie));
  toastEl.dataset.minuterie = String(setTimeout(() => { toastEl.hidden = true; }, ton === "erreur" ? 6000 : 3500));
}
/** Lance une action ; en cas d'échec, montre le message du serveur (et rien d'autre). */
const essayer = (/** @type {() => Promise<unknown>} */ f) => f().catch((e) => toast(/** @type {Error} */ (e).message, "erreur"));
const FORMAT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
const date = (/** @type {string | null} */ iso) => (iso ? FORMAT.format(new Date(iso)) : "—");
const pluriel = (/** @type {number} */ n, /** @type {string} */ mot, motPluriel = `${mot}s`) => `${n} ${n > 1 ? motPluriel : mot}`;

const STATUTS_CAMPAGNE = /** @type {Record<string, [string, string]>} */ ({ brouillon: ["Brouillon", "jaune"], active: ["Ouverte aux candidats", "vert"], close: ["Close", ""] });
const STATUTS_CANDIDAT = /** @type {Record<string, [string, string]>} */ ({
  en_cours: ["En cours", "jaune"], termine: ["Montage en attente", "jaune"], montage: ["Montage en cours", "vox"], pret: ["Transmise", "vert"], erreur: ["Échec du montage", "rouge"],
});
const pastille = (/** @type {Record<string, [string, string]>} */ table, /** @type {string} */ s) => h("span", { class: "pastille", "data-ton": table[s]?.[1] ?? "" }, table[s]?.[0] ?? s);

/** Bouton à double confirmation (sans boîte de dialogue du navigateur), comme dans Parlorama. */
function boutonConfirme(/** @type {string} */ libelle, /** @type {string} */ confirmation, /** @type {() => Promise<void>} */ action, classe = "bouton discret") {
  const b = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: classe }, libelle));
  let arme = false;
  b.addEventListener("click", async () => {
    if (!arme) {
      arme = true; b.textContent = confirmation;
      setTimeout(() => { arme = false; b.textContent = libelle; }, 4000);
      return;
    }
    b.disabled = true;
    try { await action(); } catch (e) { toast(/** @type {Error} */ (e).message, "erreur"); b.disabled = false; b.textContent = libelle; arme = false; }
  });
  return b;
}

const champ = (/** @type {string} */ libelle, /** @type {HTMLElement} */ entree, /** @type {string | null} */ aide = null) =>
  h("label", { class: "champ" }, libelle, entree, aide ? h("span", { class: "aide-champ" }, aide) : null);

function page(/** @type {{ titre: string, sous?: string, fil?: [string, string] | null, droite?: any }} */ o, /** @type {any[]} */ ...corps) {
  contenu.replaceChildren(
    h("div", { class: "entete-page" },
      h("div", {}, o.fil ? h("div", { class: "fil" }, h("a", { href: o.fil[1] }, o.fil[0]), " ›") : null, h("h1", {}, o.titre), o.sous ? h("p", { class: "sous" }, o.sous) : null),
      o.droite ?? null),
    ...corps);
}

/** @type {{ email: string, role: string } | null} */
let moi = null;
let modele = /** @type {any} */ (null);
const chargerModele = async () => (modele ??= await fetch("/whyme/modele-campagne.json").then((r) => r.json()));

// ------------------------------------------------------------------ campagnes : liste et création

async function pageCampagnes() {
  const [{ campagnes }, { clients }] = await Promise.all([api("/api/rh/campagnes"), api("/api/rh/clients")]);
  const creation = formulaireCreation(clients);
  creation.hidden = campagnes.length > 0;
  const bouton = h("button", { type: "button", class: "bouton action", onclick: () => { creation.hidden = !creation.hidden; if (!creation.hidden) /** @type {HTMLElement | null} */ (creation.querySelector("select, input"))?.focus(); } }, "Nouvelle campagne");
  const liste = campagnes.length
    ? h("div", { class: "defile" }, h("table", { class: "tableau" },
      h("thead", {}, h("tr", {}, ...["Campagne", "Client", "Statut", "Interviews", "Vidéos prêtes", "Lien candidat"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...campagnes.map((/** @type {any} */ c) => h("tr", { class: "lien-ligne", onclick: () => { location.hash = `#/campagne/${c.id}`; } },
        h("td", {}, h("a", { href: `#/campagne/${c.id}` }, h("strong", {}, c.nom)), h("div", { class: "sous-ligne" }, c.config.evenement)),
        h("td", {}, c.client ?? h("span", { class: "pastille", "data-ton": "rouge" }, "À rattacher")),
        h("td", {}, pastille(STATUTS_CAMPAGNE, c.statut)),
        h("td", { class: "nombre" }, String(c.candidats)),
        h("td", { class: "nombre" }, String(c.prets)),
        h("td", {}, h("code", {}, `/i/${c.code}`)))))))
    : h("p", { class: "vide" }, "Aucune campagne pour l'instant : créez la première ci-dessus.");
  page({ titre: "Campagnes", sous: "Une campagne, c'est un événement (salon, forum, école…) commandé par un client : ses entreprises recruteuses, son questionnaire, son QR code.", droite: bouton },
    creation, h("section", { class: "carte" }, liste));
}

/** Création en trois questions ; tout le reste (entreprises, questions) se règle sur la page de la campagne. */
function formulaireCreation(/** @type {any[]} */ clients) {
  const choixClient = /** @type {HTMLSelectElement} */ (h("select", { name: "client_id", "aria-label": "Client" },
    h("option", { value: "" }, clients.length ? "Choisir le client…" : "Aucun client : créez-le à droite"),
    ...clients.map((c) => h("option", { value: c.id }, c.nom))));
  const nouveauClient = /** @type {HTMLInputElement} */ (h("input", { placeholder: "ex. PFA, VivaTech, Lycée Jean-Jaurès", maxlength: 80, "aria-label": "Nouveau client" }));
  const ajoutClient = h("button", { type: "button", class: "bouton discret petit", onclick: () => essayer(async () => {
    const nom = nouveauClient.value.trim();
    if (!nom) throw new Error("Saisissez le nom de l'organisation cliente.");
    if (nom.includes("@")) throw new Error("C'est une adresse e-mail : saisissez le nom de l'organisation (les personnes s'ajoutent dans l'onglet Clients).");
    const r = await api("/api/rh/clients", { methode: "POST", corps: { nom } });
    choixClient.append(h("option", { value: r.client.id }, r.client.nom));
    choixClient.value = r.client.id;
    nouveauClient.value = "";
    toast(`Client « ${r.client.nom} » créé`);
  }) }, "Créer ce client");
  const nom = /** @type {HTMLInputElement} */ (h("input", { name: "nom", maxlength: 80, placeholder: "ex. Mondial de l'Auto 2026" }));
  const evenement = /** @type {HTMLInputElement} */ (h("input", { name: "evenement", maxlength: 80, placeholder: "ex. Mondial de l'Auto" }));
  let evenementTouche = false;
  evenement.addEventListener("input", () => { evenementTouche = true; });
  nom.addEventListener("input", () => { if (!evenementTouche) evenement.value = nom.value.replace(/\s+20\d\d$/, "").trim(); });
  const code = /** @type {HTMLInputElement} */ (h("input", { name: "code", maxlength: 30, placeholder: "laissé vide : choisi automatiquement" }));
  const erreur = h("p", { class: "erreur-form", role: "alert", hidden: true });
  const form = /** @type {HTMLFormElement} */ (h("form", { class: "carte creation" },
    h("h2", {}, "Nouvelle campagne"),
    h("ol", { class: "etapes-creation" },
      h("li", {}, h("strong", {}, "Pour quel client ?"), h("span", { class: "aide-champ" }, "L'organisation qui commande la campagne. Elle verra les statistiques, jamais les candidats."),
        h("div", { class: "ligne-client" }, choixClient, h("span", { class: "ou" }, "ou"), nouveauClient, ajoutClient)),
      h("li", {}, h("strong", {}, "Comment l'appeler ?"),
        h("div", { class: "grille deux" },
          champ("Nom de la campagne (pour vous)", nom),
          champ("Événement (vu par le candidat)", evenement, "Affiché sur son téléphone : « JobBox · Mondial de l'Auto »."))),
      h("li", {}, h("strong", {}, "Et ensuite ?"), h("span", { class: "aide-champ" }, "La campagne est créée en brouillon, avec le questionnaire Why me de base (4 questions). Sur sa page, vous cochez les entreprises, ajustez les questions, l'essayez, puis l'ouvrez aux candidats."))),
    h("details", { class: "avance" }, h("summary", {}, "Option : adresse du QR code"), champ("Code dans l'adresse /i/…", code, "Minuscules, chiffres et tirets. Il ne change plus une fois la campagne ouverte.")),
    erreur,
    h("div", { class: "boutons" }, h("button", { class: "bouton action" }, "Créer la campagne"))));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    erreur.hidden = true;
    essayer(async () => {
      const manque = [!choixClient.value ? "choisissez ou créez le client" : "", !nom.value.trim() ? "donnez un nom à la campagne" : "", !evenement.value.trim() ? "indiquez l'événement" : ""].filter(Boolean);
      if (manque.length) { erreur.textContent = `Pour créer la campagne : ${manque.join(", ")}.`; erreur.hidden = false; return; }
      // Le modèle sert de base ; l'organisateur affiché au candidat est le client choisi (modifiable dans l'éditeur).
      const client = choixClient.selectedOptions[0]?.textContent ?? "";
      const config = { ...structuredClone(await chargerModele()), evenement: evenement.value.trim(), organisateur: client || undefined };
      const r = await api("/api/rh/campagnes", { methode: "POST", corps: { nom: nom.value.trim(), client_id: choixClient.value, code: code.value.trim() || undefined, config, entreprises: [] } });
      toast("Campagne créée en brouillon : cochez ses entreprises et vérifiez le questionnaire");
      location.hash = `#/campagne/${r.campagne.id}/questionnaire`;
    });
  });
  return form;
}

// ------------------------------------------------------------------ une campagne

function qrSvg(/** @type {string} */ adresse) {
  const { d, cote } = cheminQR(genererQR(adresse));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${cote} ${cote}`); svg.setAttribute("width", "200"); svg.setAttribute("height", "200");
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `QR code vers ${adresse}`);
  svg.innerHTML = `<rect width="${cote}" height="${cote}" fill="#fff"/><path d="${d}" fill="#2A2D30"/>`;
  return svg;
}

const ONGLETS_CAMPAGNE = [["questionnaire", "Questionnaire"], ["interviews", "Interviews et vidéos"], ["lien", "Lien et QR code"], ["statistiques", "Statistiques du client"]];

async function campagne(/** @type {string} */ id, /** @type {string} */ onglet) {
  const [{ campagnes }, { clients }, { entreprises: toutes }] = await Promise.all([api("/api/rh/campagnes"), api("/api/rh/clients"), api("/api/rh/entreprises")]);
  const c = campagnes.find((/** @type {any} */ x) => x.id === id);
  if (!c) { toast("Cette campagne n'existe plus", "erreur"); location.hash = "#/campagnes"; return; }
  const actif = ONGLETS_CAMPAGNE.some(([k]) => k === onglet) ? onglet : c.statut === "brouillon" ? "questionnaire" : "interviews";
  const recharger = () => { router(); };
  const statut = (/** @type {string} */ s, /** @type {string} */ message) => async () => {
    await api(`/api/rh/campagnes/${id}/statut`, { methode: "POST", corps: { statut: s } }); toast(message); recharger();
  };

  // Ce qu'il faut avant d'ouvrir : dit clairement, au lieu d'une erreur au clic.
  const manques = [!c.client_id ? "rattacher un client" : "", !c.entreprises.length ? "cocher au moins une entreprise (onglet Questionnaire)" : ""].filter(Boolean);
  const actions = h("div", { class: "boutons" }, pastille(STATUTS_CAMPAGNE, c.statut),
    c.statut === "brouillon" && !manques.length ? boutonConfirme("Ouvrir aux candidats", "Confirmer l'ouverture", statut("active", "Campagne ouverte : le QR code fonctionne"), "bouton action") : null,
    c.statut === "brouillon" && c.candidats === 0 ? boutonConfirme("Supprimer", "Confirmer la suppression", async () => { await api(`/api/rh/campagnes/${id}`, { methode: "DELETE" }); toast("Campagne supprimée"); location.hash = "#/campagnes"; }, "bouton danger") : null,
    c.statut === "active" ? boutonConfirme("Repasser en brouillon", "Confirmer (le QR code s'arrête)", statut("brouillon", "Campagne repassée en brouillon : le QR code ne fonctionne plus")) : null,
    c.statut === "active" ? boutonConfirme("Clore", "Confirmer la clôture", statut("close", "Campagne close"), "bouton danger") : null,
    c.statut === "close" ? boutonConfirme("Rouvrir", "Confirmer la réouverture", statut("active", "Campagne rouverte")) : null);

  const bandeau = c.statut === "brouillon"
    ? h("div", { class: `bandeau-etat${manques.length ? " a-faire" : " pret"}` },
      manques.length ? `Brouillon : le QR code ne fonctionne pas encore. Pour ouvrir la campagne, il reste à ${manques.join(" et à ")}.`
        : "Brouillon prêt : essayez le parcours depuis l'onglet Questionnaire, puis « Ouvrir aux candidats ».")
    : c.statut === "active" ? h("div", { class: "bandeau-etat pret" }, "Ouverte : les candidats peuvent scanner le QR code. Le questionnaire et les entreprises sont figés (repassez en brouillon pour les modifier).")
      : h("div", { class: "bandeau-etat" }, "Close : le QR code ne fonctionne plus. Les vidéos restent accessibles aux recruteurs pendant 12 mois.");

  const onglets = h("div", { class: "onglets", role: "tablist" }, ...ONGLETS_CAMPAGNE.map(([cle, lib]) =>
    h("button", { type: "button", role: "tab", "aria-selected": String(cle === actif), onclick: () => { location.hash = `#/campagne/${id}/${cle}`; } },
      cle === "interviews" ? `${lib} (${c.candidats})` : lib)));

  /** @type {any} */ let corps;
  if (actif === "questionnaire") corps = ongletQuestionnaire(c, clients, toutes, recharger, (await api("/api/rh/styles")).styles);
  else if (actif === "interviews") corps = await ongletInterviews(c);
  else if (actif === "lien") corps = ongletLien(c);
  else corps = vueStatistiques(await api(`/api/rh/campagnes/${id}/statistiques`), "Ce que voit le client dans son espace : des statistiques, jamais un candidat.");

  page({ titre: c.nom, sous: [c.client ?? "client à rattacher", c.config.evenement, pluriel(c.entreprises.length, "entreprise")].join(" · "), fil: ["Campagnes", "#/campagnes"], droite: actions },
    bandeau, onglets, corps);
}

function ongletQuestionnaire(/** @type {any} */ c, /** @type {any[]} */ clients, /** @type {any[]} */ toutes, /** @type {() => void} */ recharger, /** @type {any[]} */ styles) {
  // Identité de la campagne : nom interne et client (modifiables à tout moment).
  const nom = /** @type {HTMLInputElement} */ (h("input", { value: c.nom, maxlength: 80 }));
  const client = /** @type {HTMLSelectElement} */ (h("select", {}, h("option", { value: "" }, "Choisir…"), ...clients.map((x) => h("option", { value: x.id, selected: x.id === c.client_id }, x.nom))));
  const identite = h("section", { class: "carte formulaire-ligne" },
    champ("Nom de la campagne (pour vous)", nom), champ("Client", client),
    h("button", { type: "button", class: "bouton discret", onclick: () => essayer(async () => {
      if (!nom.value.trim()) throw new Error("Le nom de la campagne ne peut pas être vide.");
      await api(`/api/rh/campagnes/${c.id}`, { methode: "PATCH", corps: { nom: nom.value.trim(), ...(client.value ? { client_id: client.value } : {}) } });
      toast("Nom et client enregistrés"); recharger();
    }) }, "Enregistrer"));
  const editeur = editeurCampagne({
    config: c.config,
    entreprises: toutes,
    choisies: c.entreprises.map((/** @type {any} */ e) => e.id),
    lectureSeule: c.statut !== "brouillon",
    valider: async (config) => (await api("/api/rh/campagnes/verifier", { methode: "POST", corps: { config } })).problemes,
    enregistrer: async (config, ents) => { await api(`/api/rh/campagnes/${c.id}`, { methode: "PATCH", corps: { config, entreprises: ents } }); toast("Questionnaire enregistré"); },
    apresEnregistrement: recharger,
    apercu: async (config, ents) => {
      const d = await api("/api/rh/campagnes/apercu", { methode: "POST", corps: { config, entreprises: ents } });
      try { localStorage.setItem("whyme-apercu", JSON.stringify(d)); } catch { throw new Error("Aperçu impossible : le stockage du navigateur est indisponible (navigation privée ?)."); }
      window.open("/i/apercu", "_blank");
    },
    modele: async () => structuredClone(await chargerModele()),
    styles,
  });
  return h("div", { class: "pile" }, identite, editeur);
}

async function ongletInterviews(/** @type {any} */ c) {
  const [{ candidats, questions }, { videos }] = await Promise.all([api(`/api/rh/campagnes/${c.id}/candidats`), api(`/api/rh/videos?campagne=${encodeURIComponent(c.id)}`)]);
  const lignes = candidats.map((/** @type {any} */ x) => h("tr", {},
    h("td", {}, x.supprime_le ? h("em", {}, "données supprimées") : `${x.prenom} ${x.nom}`),
    h("td", {}, pastille(STATUTS_CANDIDAT, x.statut), x.erreur ? h("div", { class: "sous-ligne" }, x.erreur) : null),
    h("td", { class: "nombre" }, x.statut === "pret" ? "—" : `${x.prises} / ${questions}`),
    h("td", {}, x.entreprises ?? "—"),
    h("td", {}, [x.a_cv ? "CV" : "", x.consent_public ? "page publique" : ""].filter(Boolean).join(" · ") || "—"),
    h("td", {}, date(x.cree_le)),
    h("td", {}, x.courriel_envoye_le ? date(x.courriel_envoye_le) : "—"),
    h("td", {}, h("div", { class: "boutons" },
      x.a_video ? h("button", { type: "button", class: "bouton discret petit", onclick: () => lire(x) }, "Voir") : null,
      ["termine", "montage", "erreur"].includes(x.statut) ? h("button", { type: "button", class: "bouton discret petit", onclick: () => essayer(async () => {
        const r = await api(`/api/rh/candidats/${x.id}/montage`, { methode: "POST" });
        toast(r.demande ? "Montage relancé : la vidéo arrive dans quelques minutes" : "Montage demandé : le service le reprendra dès qu'il répond");
        router();
      }) }, "Relancer le montage") : null))));
  return h("div", { class: "pile" },
    h("section", { class: "carte" }, h("h2", {}, `Vidéos montées (${videos.length})`),
      videos.length ? galerie(videos) : h("p", { class: "vide" }, c.statut === "brouillon" ? "Aucune vidéo : la campagne n'est pas encore ouverte." : "Aucune vidéo montée pour l'instant.")),
    h("section", { class: "carte" }, h("h2", {}, `Toutes les interviews (${candidats.length})`),
      h("p", { class: "aide-champ" }, "Y compris celles en cours ou en montage. « Transmise » : la vidéo est prête et les entreprises choisies par le candidat la voient."),
      candidats.length ? h("div", { class: "defile" }, h("table", { class: "tableau" }, h("thead", {}, h("tr", {}, ...["Candidat", "État", "Réponses", "Entreprises choisies", "Fourni", "Commencée", "E-mail envoyé", ""].map((t) => h("th", {}, t)))), h("tbody", {}, ...lignes)))
        : h("p", { class: "vide" }, "Aucune interview pour l'instant.")));
}

function ongletLien(/** @type {any} */ c) {
  const adresse = `${location.origin}/i/${c.code}`;
  return h("div", { class: "grille deux" },
    h("section", { class: "carte" }, h("h2", {}, "QR code de la JobBox"), qrSvg(adresse),
      h("p", {}, h("code", {}, adresse)),
      h("div", { class: "boutons" },
        h("button", { type: "button", class: "bouton discret petit", onclick: () => essayer(async () => { await navigator.clipboard.writeText(adresse); toast("Adresse copiée"); }) }, "Copier l'adresse"),
        c.statut === "active" ? h("a", { class: "bouton discret petit", href: adresse, target: "_blank", rel: "noopener" }, "Ouvrir comme un candidat") : null)),
    h("section", { class: "carte" }, h("h2", {}, "À savoir"),
      h("ul", { class: "liste-aide" },
        h("li", {}, "Un seul QR code pour toutes les cabines de la campagne ; il marche aussi envoyé par lien (digital)."),
        h("li", {}, c.statut === "active" ? "La campagne est ouverte : le QR code fonctionne." : "Le QR code ne fonctionne que lorsque la campagne est ouverte."),
        h("li", {}, "Le candidat utilise son téléphone et son réseau ; sa vidéo montée lui arrive par e-mail."))));
}

/** Statistiques agrégées d'une campagne (même vue que celle du client dans son espace). */
function vueStatistiques(/** @type {any} */ s, /** @type {string} */ titre) {
  const barres = (/** @type {{ nom: string, n: number }[]} */ lignes) => {
    if (!lignes.length) return h("p", { class: "vide" }, "Rien pour l'instant.");
    const max = Math.max(1, ...lignes.map((l) => l.n));
    return h("div", { class: "barres" }, ...lignes.map((l) => h("div", { class: "ligne" }, h("span", {}, l.nom),
      h("span", { class: "jauge" }, h("span", { style: `width:${Math.round((l.n / max) * 100)}%` })), h("span", { class: "n" }, String(l.n)))));
  };
  const kpi = (/** @type {number} */ v, /** @type {string} */ l) => h("div", { class: "carte" }, h("span", { class: "valeur" }, String(v)), h("span", { class: "libelle" }, l));
  return h("section", { class: "pile" }, h("p", { class: "aide-champ" }, titre),
    h("div", { class: "grille kpi" }, kpi(s.commencees, "interviews commencées"), kpi(s.terminees, "terminées"), kpi(s.transmises, "vidéos transmises"), kpi(s.candidatures, "candidatures")),
    h("div", { class: "grille deux" },
      h("div", { class: "carte" }, h("h2", {}, "Candidatures par entreprise"), barres(s.parEntreprise.map((/** @type {any} */ e) => ({ nom: e.nom, n: e.candidatures })))),
      h("div", { class: "carte" }, h("h2", {}, "Candidats par famille de métiers"), barres(s.parFamille.filter((/** @type {any} */ f) => f.candidats).map((/** @type {any} */ f) => ({ nom: f.nom, n: f.candidats }))))));
}

// ------------------------------------------------------------------ vidéos montées

const lecteur = /** @type {HTMLDialogElement} */ (h("dialog", { class: "lecteur-rh", "aria-label": "Vidéo du candidat" }));
document.body.append(lecteur);
lecteur.addEventListener("close", () => lecteur.replaceChildren());

/** Lecture d'une vidéo montée dans une fenêtre (9:16), avec le CV et la page publique s'il y en a. */
function lire(/** @type {{ id: string, prenom: string, nom: string, a_cv?: boolean | number, code_public?: string | null }} */ v) {
  const video = h("video", { src: `/api/rh/candidats/${v.id}/video`, controls: true, playsinline: true, autoplay: true, preload: "metadata" });
  lecteur.replaceChildren(
    h("div", { class: "lecteur-tete" }, h("strong", {}, `${v.prenom} ${v.nom}`), h("button", { type: "button", class: "bouton discret petit", onclick: () => lecteur.close() }, "Fermer")),
    video,
    h("div", { class: "boutons", style: "margin-top:10px" },
      v.a_cv ? h("a", { class: "bouton discret petit", href: `/api/rh/candidats/${v.id}/cv`, target: "_blank", rel: "noopener" }, "CV") : null,
      v.code_public ? h("a", { class: "bouton discret petit", href: `/v/${v.code_public}`, target: "_blank", rel: "noopener" }, "Page publique") : null));
  lecteur.showModal();
}

function galerie(/** @type {any[]} */ videos) {
  return h("div", { class: "galerie" }, ...videos.map((v) => {
    const image = h("span", { class: "image" });
    if (v.a_miniature) image.style.backgroundImage = `url("/api/rh/candidats/${v.id}/miniature")`;
    return h("button", { type: "button", class: "vignette-video", onclick: () => lire(v), "aria-label": `Voir la vidéo de ${v.prenom} ${v.nom}` },
      image, h("strong", {}, `${v.prenom} ${v.nom}`),
      h("span", { class: "meta" }, [v.age ? `${v.age} ans` : "", v.famille, v.a_cv ? "CV" : ""].filter(Boolean).join(" · ") || " "),
      h("span", { class: "meta" }, v.entreprises ?? "—"),
      h("span", { class: "meta" }, `${v.campagne} · ${date(v.pret_le)}`));
  }));
}

async function pageVideos() {
  const { videos } = await api("/api/rh/videos");
  const campagnesDispo = [...new Map(videos.map((/** @type {any} */ v) => [v.campagne_id, v.campagne])).entries()];
  const recherche = /** @type {HTMLInputElement} */ (h("input", { type: "search", placeholder: "Nom, entreprise…", "aria-label": "Rechercher" }));
  const filtre = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Campagne" }, h("option", { value: "" }, "Toutes les campagnes"), ...campagnesDispo.map(([id, nom]) => h("option", { value: id }, nom))));
  const zone = h("div", {});
  const dessiner = () => {
    const q = recherche.value.trim().toLowerCase();
    const liste = videos.filter((/** @type {any} */ v) => (!filtre.value || v.campagne_id === filtre.value) && (!q || `${v.prenom} ${v.nom} ${v.entreprises ?? ""}`.toLowerCase().includes(q)));
    zone.replaceChildren(liste.length ? galerie(liste) : h("p", { class: "vide" }, videos.length ? "Aucune vidéo ne correspond." : "Aucune vidéo montée pour l'instant."));
  };
  recherche.addEventListener("input", dessiner);
  filtre.addEventListener("change", dessiner);
  dessiner();
  page({ titre: "Vidéos", sous: `${pluriel(videos.length, "vidéo montée", "vidéos montées")}, toutes campagnes. Chaque lecture est journalisée.` },
    h("section", { class: "carte" }, h("div", { class: "filtres-videos" }, recherche, filtre), zone));
}

// ------------------------------------------------------------------ clients et contacts

async function pageClients() {
  const { clients } = await api("/api/rh/clients");
  const nom = /** @type {HTMLInputElement} */ (h("input", { required: true, maxlength: 80, placeholder: "ex. PFA, VivaTech, Lycée Jean-Jaurès" }));
  const form = /** @type {HTMLFormElement} */ (h("form", { class: "carte formulaire-ligne" }, champ("Nom de l'organisation cliente", nom), h("button", { class: "bouton action" }, "Ajouter le client")));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    essayer(async () => {
      if (nom.value.includes("@")) throw new Error("C'est une adresse e-mail : saisissez le nom de l'organisation. La personne s'ajoute ensuite comme contact, dans la fiche du client.");
      await api("/api/rh/clients", { methode: "POST", corps: { nom: nom.value.trim() } }); toast("Client ajouté"); await pageClients();
    });
  });
  const fiche = (/** @type {any} */ c) => {
    const email = /** @type {HTMLInputElement} */ (h("input", { type: "email", required: true, placeholder: "prenom.nom@client.fr" }));
    const ajout = /** @type {HTMLFormElement} */ (h("form", { class: "formulaire-ligne" }, champ("Ajouter un contact (une personne de ce client)", email), h("button", { class: "bouton discret" }, "Ajouter")));
    ajout.addEventListener("submit", (e) => { e.preventDefault(); essayer(async () => { await api(`/api/rh/clients/${c.id}/contacts`, { methode: "POST", corps: { email: email.value.trim() } }); toast("Contact ajouté : il peut se connecter sur /recruteur/"); await pageClients(); }); });
    return h("section", { class: "carte pile" },
      h("div", { class: "tete-fiche" }, h("div", {}, h("h2", {}, c.nom), h("span", { class: "sous-ligne" }, c.campagnes ? pluriel(c.campagnes, "campagne") : "Aucune campagne")),
        c.campagnes ? null : boutonConfirme("Supprimer", "Confirmer la suppression", async () => { await api(`/api/rh/clients/${c.id}`, { methode: "DELETE" }); toast("Client supprimé"); await pageClients(); }, "bouton danger petit")),
      c.contacts.length ? h("table", { class: "tableau" }, h("tbody", {}, ...c.contacts.map((/** @type {any} */ k) => h("tr", {}, h("td", {}, k.email),
        h("td", {}, h("span", { class: "pastille", "data-ton": k.actif ? "vert" : "" }, k.actif ? "Actif" : "Désactivé")),
        h("td", { class: "nombre" }, h("button", { type: "button", class: "bouton discret petit", onclick: () => essayer(async () => { await api(`/api/rh/contacts/${k.id}`, { methode: "PATCH", corps: { actif: !k.actif } }); toast(k.actif ? "Contact désactivé" : "Contact réactivé"); await pageClients(); }) }, k.actif ? "Désactiver" : "Réactiver"))))))
        : h("p", { class: "aide-champ" }, "Aucun contact : personne chez ce client ne voit encore ses statistiques."),
      ajout);
  };
  page({ titre: "Clients", sous: "Le client est l'organisation qui commande la campagne (ex. la PFA au Mondial de l'Auto). Ses contacts se connectent sur /recruteur/ et n'y voient que les statistiques de ses campagnes, jamais un candidat." },
    form, h("div", { class: "grille deux", style: "margin-top:18px" }, ...(clients.length ? clients.map(fiche) : [h("p", { class: "vide" }, "Aucun client.")])));
}

// ------------------------------------------------------------------ entreprises et leurs recruteurs

async function pageEntreprises() {
  const [{ entreprises }, { recruteurs }] = await Promise.all([api("/api/rh/entreprises"), api("/api/rh/recruteurs")]);
  const nom = /** @type {HTMLInputElement} */ (h("input", { required: true, maxlength: 80, placeholder: "ex. Verkor, Valeo, Renault" }));
  const form = /** @type {HTMLFormElement} */ (h("form", { class: "carte formulaire-ligne" }, champ("Nom de l'entreprise recruteuse", nom), h("button", { class: "bouton action" }, "Ajouter l'entreprise")));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    essayer(async () => {
      if (nom.value.includes("@")) throw new Error("C'est une adresse e-mail : saisissez le nom de l'entreprise. Le recruteur s'ajoute ensuite dans la fiche de l'entreprise.");
      await api("/api/rh/entreprises", { methode: "POST", corps: { nom: nom.value.trim() } }); toast("Entreprise ajoutée"); await pageEntreprises();
    });
  });
  const fiche = (/** @type {any} */ e) => {
    const fichier = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true }));
    fichier.addEventListener("change", () => essayer(async () => {
      const f = fichier.files?.[0];
      if (!f) return;
      await api(`/api/rh/entreprises/${e.id}/logo`, { methode: "PUT", brut: f, type: f.type });
      toast("Logo enregistré"); await pageEntreprises();
    }));
    const email = /** @type {HTMLInputElement} */ (h("input", { type: "email", required: true, placeholder: "prenom.nom@entreprise.fr" }));
    const ajout = /** @type {HTMLFormElement} */ (h("form", { class: "formulaire-ligne" }, champ("Ajouter un recruteur", email), h("button", { class: "bouton discret" }, "Ajouter")));
    ajout.addEventListener("submit", (ev) => { ev.preventDefault(); essayer(async () => { await api("/api/rh/recruteurs", { methode: "POST", corps: { email: email.value.trim(), entreprise_id: e.id } }); toast("Recruteur ajouté : il se connecte sur /recruteur/"); await pageEntreprises(); }); });
    const siens = recruteurs.filter((/** @type {any} */ r) => r.entreprise_id === e.id);
    const utilisee = e.campagnes > 0 || e.candidatures > 0;
    return h("section", { class: "carte pile" },
      h("div", { class: "tete-fiche" },
        h("div", { class: "nom-logo" }, e.logo ? h("img", { src: `${e.logo}?v=${Date.now()}`, alt: "" }) : h("span", { class: "sans-logo" }, "logo"),
          h("div", {}, h("h2", {}, e.nom), h("span", { class: "sous-ligne" }, [e.campagnes ? pluriel(e.campagnes, "campagne") : "aucune campagne", e.candidatures ? pluriel(e.candidatures, "candidature") : ""].filter(Boolean).join(" · ")))),
        h("div", { class: "boutons" }, fichier, h("button", { type: "button", class: "bouton discret petit", onclick: () => fichier.click() }, e.logo ? "Changer le logo" : "Ajouter un logo"),
          utilisee ? null : boutonConfirme("Supprimer", "Confirmer la suppression", async () => { await api(`/api/rh/entreprises/${e.id}`, { methode: "DELETE" }); toast("Entreprise supprimée"); await pageEntreprises(); }, "bouton danger petit"))),
      siens.length ? h("table", { class: "tableau" }, h("tbody", {}, ...siens.map((/** @type {any} */ r) => h("tr", {}, h("td", {}, r.email),
        h("td", {}, h("span", { class: "pastille", "data-ton": r.actif ? "vert" : "" }, r.actif ? "Actif" : "Désactivé")),
        h("td", { class: "nombre" }, h("button", { type: "button", class: "bouton discret petit", onclick: () => essayer(async () => { await api(`/api/rh/recruteurs/${r.id}`, { methode: "PATCH", corps: { actif: !r.actif } }); toast(r.actif ? "Recruteur désactivé" : "Recruteur réactivé"); await pageEntreprises(); }) }, r.actif ? "Désactiver" : "Réactiver"))))))
        : h("p", { class: "aide-champ" }, "Aucun recruteur : personne dans cette entreprise ne voit encore les candidatures."),
      ajout);
  };
  page({ titre: "Entreprises", sous: "Les entreprises recruteuses (sous-clients) : une fiche par entreprise, commune à toutes les campagnes. Ses recruteurs se connectent sur /recruteur/ et voient les candidats qui l'ont choisie, dans toutes les campagnes. Logo PNG, JPEG ou WebP, 1 Mo au plus." },
    form, h("div", { class: "grille deux", style: "margin-top:18px" }, ...(entreprises.length ? entreprises.map(fiche) : [h("p", { class: "vide" }, "Aucune entreprise.")])));
}

// ------------------------------------------------------------------ e-mails

async function pageCourriels() {
  const { courriels, brevo, expediteur, montage, montageCle } = await api("/api/rh/courriels");
  /** @type {Record<string, string>} */
  const etatsMontage = {
    identique: "Configuré : le service répond, avec le même secret.",
    differente: "Le service répond, mais son secret MONTAGE_CLE diffère de celui de la plateforme : les montages sont refusés.",
    injoignable: "Configuré, mais le service ne répond pas pour l'instant.",
  };
  const apercu = h("iframe", { title: "Aperçu de l'e-mail", class: "apercu-courriel", sandbox: "allow-popups allow-popups-to-escape-sandbox" });
  page({ titre: "E-mails", sous: "Les e-mails envoyés aux candidats, recruteurs et contacts, gardés 7 jours. Touchez-en un pour le lire." },
    h("div", { class: "grille deux" },
      h("div", { class: "carte" }, h("strong", {}, "Envoi par Brevo"), h("p", {}, brevo ? `Configuré : les e-mails partent de ${expediteur}.` : "Non configuré : les e-mails restent ici, sans partir.")),
      h("div", { class: "carte" }, h("strong", {}, "Service de montage"), h("p", {}, montage ? (etatsMontage[montageCle] ?? "Configuré.") : "Non configuré : les interviews terminées attendent leur montage."))),
    h("div", { class: "grille deux", style: "margin-top:18px" },
      h("section", { class: "carte" }, courriels.length ? h("table", { class: "tableau" }, h("tbody", {}, ...courriels.map((/** @type {any} */ c) => h("tr", { class: "lien-ligne", onclick: () => { /** @type {HTMLIFrameElement} */ (apercu).srcdoc = c.html.replace("<head>", "<head><base target=\"_blank\">").replace("<html lang=\"fr\"><body", "<html lang=\"fr\"><head><base target=\"_blank\"></head><body"); } },
        h("td", {}, h("strong", {}, c.sujet), h("div", { class: "sous-ligne" }, `${c.a} · ${date(c.cree_le)}`)),
        h("td", {}, h("span", { class: "pastille", "data-ton": c.envoye ? "vert" : "jaune" }, c.envoye ? "Transmis à Brevo" : "Non envoyé")),
        h("td", { class: "nombre" }, brevo ? h("button", { class: "bouton discret petit", type: "button", onclick: (/** @type {Event} */ e) => {
          e.stopPropagation();
          essayer(async () => { await api(`/api/rh/courriels/${c.id}/renvoyer`, { methode: "POST" }); toast(`Renvoyé à ${c.a}`); });
        } }, "Renvoyer") : "")))))
        : h("p", { class: "vide" }, "Aucun e-mail.")),
      h("section", { class: "carte" }, apercu)));
}

// ------------------------------------------------------------------ équipe RH

async function pageEquipe() {
  const { equipe, dOffice } = await api("/api/rh/equipe");
  const email = /** @type {HTMLInputElement} */ (h("input", { type: "email", required: true, placeholder: "prenom@whyme.jobs" }));
  const role = /** @type {HTMLSelectElement} */ (h("select", {}, h("option", { value: "operateur_rh" }, "Opérateur (gère les campagnes)"), h("option", { value: "admin_rh" }, "Administrateur (gère aussi l'équipe)")));
  const form = /** @type {HTMLFormElement} */ (h("form", { class: "carte formulaire-ligne" }, champ("Adresse", email), champ("Rôle", role), h("button", { class: "bouton action" }, "Donner l'accès")));
  form.addEventListener("submit", (e) => { e.preventDefault(); essayer(async () => { await api("/api/rh/equipe", { methode: "POST", corps: { email: email.value.trim(), role: role.value } }); toast("Accès ajouté"); await pageEquipe(); }); });
  page({ titre: "Équipe RH", sous: "Les comptes WhyMe qui gèrent Why me. Indépendants de Parlorama : un compte Parlobox n'ouvre pas cet espace, et inversement. La personne doit aussi pouvoir passer Cloudflare Access." },
    form,
    h("section", { class: "carte", style: "margin-top:18px" },
      h("table", { class: "tableau" }, h("thead", {}, h("tr", {}, ...["Adresse", "Rôle", "État", ""].map((t) => h("th", {}, t)))),
        h("tbody", {},
          ...dOffice.map((/** @type {string} */ e) => h("tr", {}, h("td", {}, e), h("td", {}, "Administrateur"), h("td", {}, h("span", { class: "pastille", "data-ton": "vert" }, "D'office")), h("td", {}))),
          ...equipe.map((/** @type {any} */ m) => h("tr", {}, h("td", {}, m.email), h("td", {}, m.role === "admin_rh" ? "Administrateur" : "Opérateur"),
            h("td", {}, h("span", { class: "pastille", "data-ton": m.actif ? "vert" : "" }, m.actif ? "Actif" : "Retiré")),
            h("td", { class: "nombre" }, m.actif && m.email !== moi?.email ? boutonConfirme("Retirer l'accès", "Confirmer", async () => { await api("/api/rh/equipe/retirer", { methode: "POST", corps: { email: m.email } }); toast("Accès retiré"); await pageEquipe(); }, "bouton discret petit") : null)))))));
}

// ------------------------------------------------------------------ navigation

async function router() {
  const [, cle = "campagnes", id = "", onglet = ""] = location.hash.replace(/^#/, "").split("/");
  const rubrique = cle === "campagne" ? "campagnes" : cle === "recruteurs" ? "entreprises" : cle;
  document.querySelectorAll(".menu a").forEach((a) => {
    if (a.getAttribute("href") === `#/${rubrique}`) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  try {
    if (cle === "campagne" && id) await campagne(id, onglet);
    else if (cle === "videos") await pageVideos();
    else if (cle === "clients") await pageClients();
    else if (cle === "equipe" && moi?.role === "admin_rh") await pageEquipe();
    else if (cle === "entreprises" || cle === "recruteurs") await pageEntreprises();
    else if (cle === "courriels") await pageCourriels();
    else await pageCampagnes();
  } catch (e) {
    contenu.replaceChildren(h("div", { class: "carte" }, h("h2", {}, "Cette page n'a pas pu s'afficher"), h("p", {}, /** @type {Error} */ (e).message),
      h("button", { type: "button", class: "bouton discret", onclick: () => router() }, "Réessayer")));
  }
}
window.addEventListener("hashchange", router);
api("/api/rh/moi").then((m) => {
  moi = m;
  /** @type {HTMLElement} */ (document.getElementById("qui")).replaceChildren(h("strong", {}, m.email), m.role === "admin_rh" ? "Administrateur RH" : "Opérateur RH");
  /** @type {HTMLElement} */ (document.getElementById("menu-equipe")).hidden = m.role !== "admin_rh";
  router();
}).catch((e) => { contenu.replaceChildren(h("div", { class: "carte" }, h("h2", {}, "Accès à l'espace RH"), h("p", {}, /** @type {Error} */ (e).message))); });
