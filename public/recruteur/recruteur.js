// @ts-check
// Espace recruteur Why me. Connexion par lien reçu par e-mail (#lien=<jeton>, 15 min, usage unique), puis session
// de 12 h gardée dans l'onglet (sessionStorage). Le jeton voyage dans l'en-tête Authorization : vidéos et CV sont
// donc chargés par fetch puis affichés depuis la mémoire. Chaque lecture et chaque téléchargement sont journalisés.

const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const compte = /** @type {HTMLElement} */ (document.getElementById("compte"));
const lecteur = /** @type {HTMLDialogElement} */ (document.getElementById("lecteur"));
const video = /** @type {HTMLVideoElement} */ (document.getElementById("lecteur-video"));
const echapper = (/** @type {unknown} */ t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const CLE = "whyme-recruteur";

/** @type {{ jeton: string, entreprise: string, email: string } | null} */
let session = null;
try { session = JSON.parse(sessionStorage.getItem(CLE) ?? "null"); } catch { session = null; }

async function appeler(/** @type {string} */ chemin, /** @type {RequestInit} */ init = {}) {
  const res = await fetch(chemin, { ...init, headers: { ...(init.headers ?? {}), ...(session ? { authorization: `Bearer ${session.jeton}` } : {}) } });
  if (res.status === 401 && session) { sessionStorage.removeItem(CLE); session = null; connexion("Votre session a expiré : reconnectez-vous."); throw new Error("session"); }
  return res;
}

function connexion(/** @type {string} */ message = "") {
  compte.innerHTML = "";
  app.innerHTML = `<div class="connexion carte"><h1>Espace recruteur</h1>
    <p>Retrouvez les candidatures vidéo transmises à votre entreprise. Saisissez votre adresse professionnelle : nous vous envoyons un lien de connexion.</p>
    ${message ? `<p class="alerte">${echapper(message)}</p>` : ""}
    <form id="form" class="champ"><label for="email">Adresse e-mail</label><input id="email" type="email" autocomplete="email" required>
    <button class="bouton" style="margin-top:12px">Recevoir mon lien</button></form><p id="retour" role="status"></p></div>`;
  /** @type {HTMLFormElement} */ (document.getElementById("form")).addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = /** @type {HTMLInputElement} */ (document.getElementById("email")).value.trim();
    const res = await fetch("/api/recruteur/lien", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const d = await res.json().catch(() => ({}));
    /** @type {HTMLElement} */ (document.getElementById("retour")).textContent = d.message ?? "Vérifiez l'adresse saisie.";
  });
}

async function ouvrirSession(/** @type {string} */ lien) {
  const res = await fetch("/api/recruteur/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lien }) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return connexion(d.message ?? "Ce lien n'est pas valable.");
  session = { jeton: d.jeton, entreprise: d.entreprise, email: d.email };
  sessionStorage.setItem(CLE, JSON.stringify(session));
  await liste();
}

/** @param {string} chemin @param {string} nom */
async function telecharger(chemin, nom) {
  const res = await appeler(`${chemin}?telecharger=1`);
  if (!res.ok) return alert("Fichier indisponible");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = nom; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function liste() {
  const res = await appeler("/api/recruteur/candidats");
  const d = await res.json();
  compte.innerHTML = `<span>${echapper(d.entreprise)} · ${echapper(d.email)}</span><button class="bouton discret" id="sortir" style="width:auto">Se déconnecter</button>`;
  document.getElementById("sortir")?.addEventListener("click", async () => { await appeler("/api/recruteur/deconnexion", { method: "POST" }); sessionStorage.removeItem(CLE); session = null; connexion(); });
  /** @type {any[]} */
  const candidats = d.candidats;
  const evenements = [...new Set(candidats.map((c) => c.evenement))];
  const familles = [...new Set(candidats.map((c) => c.famille).filter(Boolean))];
  app.innerHTML = `<h1>Candidatures <span class="accent">${candidats.length}</span></h1>
    <p>Chaque candidat s'est présenté en vidéo, en quelques questions. Elles restent consultables 12 mois.</p>
    <div class="filtres"><input id="recherche" type="search" placeholder="Rechercher un nom" aria-label="Rechercher un nom">
      ${evenements.length > 1 ? `<select id="evenement" aria-label="Événement"><option value="">Tous les événements</option>${evenements.map((e) => `<option>${echapper(e)}</option>`).join("")}</select>` : ""}
      ${familles.length ? `<select id="famille" aria-label="Métier"><option value="">Tous les métiers</option>${familles.map((f) => `<option>${echapper(f)}</option>`).join("")}</select>` : ""}</div>
    <div class="liste" id="liste"></div>`;
  const dessiner = () => {
    const q = /** @type {HTMLInputElement} */ (document.getElementById("recherche")).value.trim().toLowerCase();
    const ev = /** @type {HTMLSelectElement | null} */ (document.getElementById("evenement"))?.value ?? "";
    const fa = /** @type {HTMLSelectElement | null} */ (document.getElementById("famille"))?.value ?? "";
    const visibles = candidats.filter((c) => (!q || `${c.prenom} ${c.nom}`.toLowerCase().includes(q)) && (!ev || c.evenement === ev) && (!fa || c.famille === fa));
    const zone = /** @type {HTMLElement} */ (document.getElementById("liste"));
    zone.innerHTML = visibles.length ? visibles.map((c) => `<article class="fiche">
      ${c.aVideo ? `<button class="vignette" data-video="${c.id}" data-titre="${echapper(`${c.prenom} ${c.nom}`)}" aria-label="Voir la vidéo de ${echapper(c.prenom)}"></button>` : `<div class="vignette sans">Le candidat a supprimé sa vidéo</div>`}
      <div class="infos"><h3>${echapper(c.prenom)} ${echapper(c.nom)}</h3>
        <span class="meta">${[c.age ? `${c.age} ans` : "", c.famille, c.evenement].filter(Boolean).map(echapper).join(" · ")}</span>
        <span class="meta"><a href="mailto:${echapper(c.email)}">${echapper(c.email)}</a></span>
        <span class="meta">Reçue le ${new Date(c.transmise_le).toLocaleDateString("fr-FR")}</span>
        <div class="liens">${c.aVideo ? `<button data-dl-video="${c.id}" data-nom="${echapper(`whyme-${c.prenom}-${c.nom}.mp4`)}">Télécharger la vidéo</button>` : ""}${c.aCv ? `<button data-cv="${c.id}" data-nom="${echapper(`CV-${c.prenom}-${c.nom}`)}">CV</button>` : ""}</div>
      </div></article>`).join("") : `<div class="vide">Aucune candidature pour l'instant.</div>`;
    // Miniatures chargées avec le jeton.
    zone.querySelectorAll("[data-video]").forEach(async (b) => {
      const c = candidats.find((x) => x.id === /** @type {HTMLElement} */ (b).dataset.video);
      if (!c?.aMiniature) return;
      const r = await appeler(`/api/recruteur/candidats/${c.id}/miniature`);
      if (r.ok) /** @type {HTMLElement} */ (b).style.backgroundImage = `url(${URL.createObjectURL(await r.blob())})`;
    });
  };
  ["recherche", "evenement", "famille"].forEach((id) => document.getElementById(id)?.addEventListener("input", dessiner));
  dessiner();
}

app.addEventListener("click", async (e) => {
  const cible = /** @type {HTMLElement} */ (e.target).closest("button");
  if (!cible) return;
  const d = cible.dataset;
  if (d.video) {
    /** @type {HTMLElement} */ (document.getElementById("lecteur-titre")).textContent = d.titre ?? "";
    video.removeAttribute("src");
    lecteur.showModal();
    const res = await appeler(`/api/recruteur/candidats/${d.video}/video`);
    if (res.ok) { video.src = URL.createObjectURL(await res.blob()); void video.play().catch(() => {}); }
  } else if (d.dlVideo) {
    await telecharger(`/api/recruteur/candidats/${d.dlVideo}/video`, d.nom ?? "video.mp4");
  } else if (d.cv) {
    await telecharger(`/api/recruteur/candidats/${d.cv}/cv`, d.nom ?? "cv");
  }
});
document.getElementById("fermer")?.addEventListener("click", () => lecteur.close());
lecteur.addEventListener("close", () => { video.pause(); if (video.src) URL.revokeObjectURL(video.src); video.removeAttribute("src"); });

/** Lien de connexion dans l'adresse (#lien=…), au chargement ou si la page est déjà ouverte. */
function lireLien() {
  const lien = /#lien=([\w-]{32,64})/.exec(location.hash);
  if (!lien) return false;
  history.replaceState(null, "", location.pathname);
  ouvrirSession(lien[1]);
  return true;
}
window.addEventListener("hashchange", lireLien);
if (!lireLien()) {
  if (session) liste().catch(() => {});
  else connexion();
}

export {};
