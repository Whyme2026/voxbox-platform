// @ts-check
// Parlorama · Why me (JobBox smartphone, usages RH) : campagnes, entreprises recruteuses, recruteurs, suivi des
// interviews et e-mails de test. Réservé aux comptes WhyMe. Tout le texte venant de la base est inséré en texte.

import { h } from "./dom.js";
import { genererQR, cheminQR } from "../../cabine/js/qr.js";

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
  const res = await fetch(chemin, {
    method: o.methode ?? "GET",
    headers: { ...enTetesDev(), ...(o.corps !== undefined ? { "content-type": "application/json" } : {}), ...(o.type ? { "content-type": o.type } : {}) },
    body: o.brut ?? (o.corps !== undefined ? JSON.stringify(o.corps) : undefined),
    credentials: "same-origin",
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.message ?? `Erreur ${res.status}`);
  return d;
}

function toast(/** @type {string} */ m, ton = "") {
  toastEl.textContent = m; toastEl.dataset.ton = ton; toastEl.hidden = false;
  clearTimeout(Number(toastEl.dataset.minuterie));
  toastEl.dataset.minuterie = String(setTimeout(() => { toastEl.hidden = true; }, 3500));
}
const essayer = (/** @type {() => Promise<unknown>} */ f) => f().catch((e) => toast(/** @type {Error} */ (e).message, "erreur"));
const FORMAT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
const date = (/** @type {string | null} */ iso) => (iso ? FORMAT.format(new Date(iso)) : "—");

const STATUTS_CAMPAGNE = /** @type {Record<string, [string, string]>} */ ({ brouillon: ["Brouillon", ""], active: ["Ouverte", "vert"], close: ["Close", ""] });
const STATUTS_CANDIDAT = /** @type {Record<string, [string, string]>} */ ({
  en_cours: ["En cours", "jaune"], termine: ["Montage en attente", "jaune"], montage: ["Montage en cours", "vox"], pret: ["Transmise", "vert"], erreur: ["Échec du montage", "rouge"],
});
const pastille = (/** @type {Record<string, [string, string]>} */ table, /** @type {string} */ s) => h("span", { class: "pastille", "data-ton": table[s]?.[1] ?? "" }, table[s]?.[0] ?? s);

function onglets(/** @type {string} */ actif) {
  const liens = [["campagnes", "Campagnes"], ["entreprises", "Entreprises"], ["recruteurs", "Recruteurs"], ["courriels", "E-mails"]];
  return h("div", { class: "onglets", role: "tablist" }, ...liens.map(([cle, lib]) =>
    h("button", { type: "button", role: "tab", "aria-selected": String(cle === actif), onclick: () => { location.hash = `#/${cle}`; } }, lib)));
}

function page(/** @type {string} */ titre, /** @type {string} */ sous, /** @type {string} */ actif, /** @type {any[]} */ ...corps) {
  contenu.replaceChildren(
    h("div", { class: "entete-page" }, h("div", {}, h("div", { class: "fil" }, h("a", { href: "index.html" }, "Parlorama"), " · Why me"), h("h1", {}, titre), h("p", { class: "sous" }, sous))),
    onglets(actif), ...corps);
}

// ------------------------------------------------------------------ campagnes

let modele = /** @type {any} */ (null);

async function campagnes() {
  const [{ campagnes }, { entreprises }] = await Promise.all([api("/api/admin/whyme/campagnes"), api("/api/admin/whyme/entreprises")]);
  modele ??= await fetch("/whyme/modele-campagne.json").then((r) => r.json()).catch(() => ({}));
  const liste = h("table", { class: "tableau" }, h("thead", {}, h("tr", {}, ...["Campagne", "Événement", "Code du QR", "Entreprises", "Interviews", "Statut"].map((t) => h("th", {}, t)))),
    h("tbody", {}, ...campagnes.map((/** @type {any} */ c) => h("tr", { class: "lien-ligne", onclick: () => { location.hash = `#/campagne/${c.id}`; } },
      h("td", {}, h("strong", {}, c.nom)), h("td", {}, c.config.evenement), h("td", {}, h("code", {}, `/i/${c.code}`)),
      h("td", {}, c.entreprises.map((/** @type {any} */ e) => e.nom).join(", ")), h("td", { class: "nombre" }, `${c.prets} / ${c.candidats}`),
      h("td", {}, pastille(STATUTS_CAMPAGNE, c.statut))))));
  const form = /** @type {HTMLFormElement} */ (h("form", { class: "grille" },
    h("label", { class: "champ" }, "Nom interne", h("input", { name: "nom", required: true, placeholder: "Mondial de l'Auto 2026 · PFA" })),
    h("label", { class: "champ" }, "Code dans l'adresse du QR (facultatif)", h("input", { name: "code", placeholder: "mondial-2026" })),
    h("fieldset", { class: "champ" }, h("legend", {}, "Entreprises proposées"),
      ...(entreprises.length ? entreprises.map((/** @type {any} */ e) => h("label", {}, h("input", { type: "checkbox", name: "entreprise", value: e.id }), ` ${e.nom}`)) : [h("p", {}, "Créez d'abord les entreprises (onglet Entreprises).")])),
    h("label", { class: "champ" }, "Questionnaire et réglages (JSON)", h("textarea", { name: "config", rows: "18", spellcheck: "false", style: "font-family:monospace;font-size:13px" }, JSON.stringify(modele, null, 2))),
    h("div", { class: "boutons" }, h("button", { class: "bouton action" }, "Créer la campagne"))));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    essayer(async () => {
      const f = new FormData(form);
      let config;
      try { config = JSON.parse(String(f.get("config"))); } catch { throw new Error("Le JSON du questionnaire est illisible"); }
      const r = await api("/api/admin/whyme/campagnes", { methode: "POST", corps: { nom: f.get("nom"), code: f.get("code") || undefined, config, entreprises: f.getAll("entreprise") } });
      toast("Campagne créée");
      location.hash = `#/campagne/${r.campagne.id}`;
    });
  });
  page("Why me", "Interviews vidéo des candidats sur leur propre téléphone (JobBox ou lien).", "campagnes",
    h("section", { class: "carte" }, h("h2", {}, "Campagnes"), campagnes.length ? liste : h("p", { class: "vide" }, "Aucune campagne pour l'instant.")),
    h("section", { class: "carte", style: "margin-top:18px" }, h("h2", {}, "Nouvelle campagne"), form));
}

function qrSvg(/** @type {string} */ adresse) {
  const { d, cote } = cheminQR(genererQR(adresse));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${cote} ${cote}`); svg.setAttribute("width", "180"); svg.setAttribute("height", "180");
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `QR code vers ${adresse}`);
  svg.innerHTML = `<rect width="${cote}" height="${cote}" fill="#fff"/><path d="${d}" fill="#2A2D30"/>`;
  return svg;
}

async function campagne(/** @type {string} */ id) {
  const { campagnes } = await api("/api/admin/whyme/campagnes");
  const c = campagnes.find((/** @type {any} */ x) => x.id === id);
  if (!c) { location.hash = "#/campagnes"; return; }
  const { candidats, questions } = await api(`/api/admin/whyme/campagnes/${id}/candidats`);
  const adresse = `${location.origin}/i/${c.code}`;
  const statut = (/** @type {string} */ s) => essayer(async () => { await api(`/api/admin/whyme/campagnes/${id}/statut`, { methode: "POST", corps: { statut: s } }); toast("Statut modifié"); await campagne(id); });
  const boutons = h("div", { class: "boutons" },
    c.statut !== "active" ? h("button", { class: "bouton action", onclick: () => statut("active") }, "Ouvrir la campagne") : null,
    c.statut === "active" ? h("button", { class: "bouton discret", onclick: () => statut("close") }, "Clore") : null,
    c.statut === "active" ? h("button", { class: "bouton discret", onclick: () => statut("brouillon") }, "Repasser en brouillon") : null,
    h("a", { class: "bouton discret", href: adresse, target: "_blank", rel: "noopener" }, "Ouvrir le parcours candidat"));
  const lignes = candidats.map((/** @type {any} */ x) => h("tr", {},
    h("td", {}, x.supprime_le ? h("em", {}, "données supprimées") : `${x.prenom} ${x.nom}`),
    h("td", {}, pastille(STATUTS_CANDIDAT, x.statut), x.erreur ? h("div", { class: "sous", style: "font-size:13px" }, x.erreur) : null),
    h("td", { class: "nombre" }, x.statut === "pret" ? "—" : `${x.prises} / ${questions}`),
    h("td", {}, x.entreprises ?? "—"),
    h("td", {}, [x.a_cv ? "CV" : "", x.consent_public ? "page publique" : ""].filter(Boolean).join(" · ") || "—"),
    h("td", {}, date(x.cree_le)),
    h("td", {}, x.courriel_envoye_le ? date(x.courriel_envoye_le) : "—"),
    h("td", {}, h("div", { class: "boutons" },
      x.a_video ? h("a", { class: "bouton discret petit", href: `/api/admin/whyme/candidats/${x.id}/video`, target: "_blank", rel: "noopener" }, "Vidéo") : null,
      x.code_public && x.a_video ? h("a", { class: "bouton discret petit", href: `/v/${x.code_public}`, target: "_blank", rel: "noopener" }, "Page publique") : null,
      ["termine", "montage", "erreur"].includes(x.statut) ? h("button", { class: "bouton discret petit", onclick: () => essayer(async () => { await api(`/api/admin/whyme/candidats/${x.id}/montage`, { methode: "POST" }); toast("Montage relancé"); await campagne(id); }) }, "Relancer le montage") : null))));
  page(c.nom, `${c.config.evenement} · ${c.config.questions.length} questions · ${c.entreprises.map((/** @type {any} */ e) => e.nom).join(", ")}`, "campagnes",
    h("div", { class: "grille deux" },
      h("section", { class: "carte" }, h("h2", {}, "Statut"), pastille(STATUTS_CAMPAGNE, c.statut), h("p", {}, "Le questionnaire et les entreprises ne changent plus une fois la campagne ouverte."), boutons),
      h("section", { class: "carte" }, h("h2", {}, "QR code de la JobBox"), qrSvg(adresse), h("p", {}, h("code", {}, adresse)))),
    h("section", { class: "carte", style: "margin-top:18px" }, h("h2", {}, `Interviews (${candidats.length})`),
      candidats.length ? h("table", { class: "tableau" }, h("thead", {}, h("tr", {}, ...["Candidat", "État", "Réponses", "Entreprises", "Fourni", "Commencée", "E-mail", ""].map((t) => h("th", {}, t)))), h("tbody", {}, ...lignes))
        : h("p", { class: "vide" }, "Aucune interview pour l'instant.")),
    h("section", { class: "carte", style: "margin-top:18px" }, h("h2", {}, "Questionnaire"),
      h("ol", {}, ...c.config.questions.map((/** @type {any} */ q) => h("li", {}, `${q.texte} `, h("span", { class: "sous" }, `(${q.lectureSec} s de lecture, ${q.dureeSec} s de réponse)`)))),
      h("p", {}, `Âge ${c.config.ageAffiche ? "affiché" : "non affiché"} sur la vidéo · âge minimum ${c.config.ageMinimum} ans`)));
}

// ------------------------------------------------------------------ entreprises et recruteurs

async function entreprises() {
  const { entreprises } = await api("/api/admin/whyme/entreprises");
  const form = /** @type {HTMLFormElement} */ (h("form", { class: "boutons" }, h("input", { name: "nom", required: true, placeholder: "Nom de l'entreprise", style: "flex:1;min-height:42px;padding:0 12px;border-radius:12px;border:1.5px solid #E1E3EC" }), h("button", { class: "bouton action" }, "Ajouter")));
  form.addEventListener("submit", (e) => { e.preventDefault(); essayer(async () => { await api("/api/admin/whyme/entreprises", { methode: "POST", corps: { nom: new FormData(form).get("nom") } }); await entreprises(); }); });
  const ligne = (/** @type {any} */ e) => {
    const fichier = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true }));
    fichier.addEventListener("change", () => essayer(async () => {
      const f = fichier.files?.[0];
      if (!f) return;
      await api(`/api/admin/whyme/entreprises/${e.id}/logo`, { methode: "PUT", brut: f, type: f.type });
      toast("Logo enregistré"); await entreprises();
    }));
    return h("tr", {}, h("td", {}, e.logo ? h("img", { src: `${e.logo}?v=${Date.now()}`, alt: "", style: "max-height:32px;max-width:120px" }) : "—"),
      h("td", {}, h("strong", {}, e.nom)), h("td", { class: "nombre" }, String(e.recruteurs)),
      h("td", {}, fichier, h("button", { class: "bouton discret petit", onclick: () => fichier.click() }, e.logo ? "Changer le logo" : "Ajouter un logo")));
  };
  page("Entreprises recruteuses", "Communes à toutes les campagnes. Logo PNG, JPEG ou WebP (1 Mo au plus).", "entreprises",
    h("section", { class: "carte" }, form,
      entreprises.length ? h("table", { class: "tableau", style: "margin-top:12px" }, h("thead", {}, h("tr", {}, ...["Logo", "Entreprise", "Recruteurs", ""].map((t) => h("th", {}, t)))), h("tbody", {}, ...entreprises.map(ligne)))
        : h("p", { class: "vide" }, "Aucune entreprise.")));
}

async function recruteurs() {
  const [{ recruteurs }, { entreprises }] = await Promise.all([api("/api/admin/whyme/recruteurs"), api("/api/admin/whyme/entreprises")]);
  const form = /** @type {HTMLFormElement} */ (h("form", { class: "boutons" },
    h("input", { name: "email", type: "email", required: true, placeholder: "recruteur@entreprise.fr", style: "flex:1;min-height:42px;padding:0 12px;border-radius:12px;border:1.5px solid #E1E3EC" }),
    h("select", { name: "entreprise_id", required: true, style: "min-height:42px;border-radius:12px;padding:0 10px" }, ...entreprises.map((/** @type {any} */ e) => h("option", { value: e.id }, e.nom))),
    h("button", { class: "bouton action" }, "Ajouter")));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    essayer(async () => { const f = new FormData(form); await api("/api/admin/whyme/recruteurs", { methode: "POST", corps: { email: f.get("email"), entreprise_id: f.get("entreprise_id") } }); toast("Recruteur ajouté"); await recruteurs(); });
  });
  page("Recruteurs", "Ils se connectent sur /recruteur/ avec un lien reçu par e-mail, et ne voient que les candidatures de leur entreprise.", "recruteurs",
    h("section", { class: "carte" }, form,
      h("table", { class: "tableau", style: "margin-top:12px" }, h("thead", {}, h("tr", {}, ...["E-mail", "Entreprise", "Créé", "État", ""].map((t) => h("th", {}, t)))),
        h("tbody", {}, ...recruteurs.map((/** @type {any} */ r) => h("tr", {}, h("td", {}, r.email), h("td", {}, r.entreprise), h("td", {}, date(r.cree_le)),
          h("td", {}, h("span", { class: "pastille", "data-ton": r.actif ? "vert" : "" }, r.actif ? "Actif" : "Désactivé")),
          h("td", {}, h("button", { class: "bouton discret petit", onclick: () => essayer(async () => { await api(`/api/admin/whyme/recruteurs/${r.id}`, { methode: "PATCH", corps: { actif: !r.actif } }); await recruteurs(); }) }, r.actif ? "Désactiver" : "Réactiver"))))))),
    h("p", {}, "Adresse de l'espace recruteur : ", h("a", { href: "/recruteur/", target: "_blank" }, `${location.origin}/recruteur/`)));
}

async function courriels() {
  const { courriels, brevo, montage } = await api("/api/admin/whyme/courriels");
  const apercu = h("iframe", { title: "Aperçu de l'e-mail", style: "width:100%;height:640px;border:1px solid #E1E3EC;border-radius:12px;background:#fff", sandbox: "allow-popups allow-popups-to-escape-sandbox" });
  page("E-mails Why me", "Gardés 7 jours. Sans clé Brevo (environnement de test), ils ne partent pas : c'est ici qu'on les lit et qu'on suit leurs liens.", "courriels",
    h("div", { class: "grille kpi" },
      h("div", { class: "carte" }, h("strong", {}, "Envoi par Brevo"), h("p", {}, brevo ? "Configuré : les e-mails partent." : "Non configuré : e-mails gardés ici.")),
      h("div", { class: "carte" }, h("strong", {}, "Service de montage"), h("p", {}, montage ? "Configuré." : "Non configuré : les interviews terminées attendent leur montage."))),
    h("div", { class: "grille deux" },
      h("section", { class: "carte" }, courriels.length ? h("table", { class: "tableau" }, h("tbody", {}, ...courriels.map((/** @type {any} */ c) => h("tr", { class: "lien-ligne", onclick: () => { /** @type {HTMLIFrameElement} */ (apercu).srcdoc = c.html.replace("<head>", "<head><base target=\"_blank\">").replace("<html lang=\"fr\"><body", "<html lang=\"fr\"><head><base target=\"_blank\"></head><body"); } },
        h("td", {}, h("strong", {}, c.sujet), h("div", { class: "sous", style: "font-size:13px" }, `${c.a} · ${date(c.cree_le)}`)), h("td", {}, h("span", { class: "pastille", "data-ton": c.envoye ? "vert" : "jaune" }, c.envoye ? "Envoyé" : "Non envoyé"))))))
        : h("p", { class: "vide" }, "Aucun e-mail.")),
      h("section", { class: "carte" }, h("p", { class: "sous" }, "Touchez un e-mail pour l'afficher ; ses liens s'ouvrent dans un nouvel onglet."), apercu)));
}

// ------------------------------------------------------------------ navigation

async function router() {
  const [, pageCle = "campagnes", id = ""] = location.hash.replace(/^#/, "").split("/");
  try {
    if (pageCle === "campagne" && id) await campagne(id);
    else if (pageCle === "entreprises") await entreprises();
    else if (pageCle === "recruteurs") await recruteurs();
    else if (pageCle === "courriels") await courriels();
    else await campagnes();
  } catch (e) {
    contenu.replaceChildren(h("p", { class: "vide" }, /** @type {Error} */ (e).message));
  }
}
window.addEventListener("hashchange", router);
router();
