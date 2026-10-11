// @ts-check
// « Tu gardes la main » : lien de l'e-mail du candidat (#g=<jeton>). Supprimer sa vidéo (page publique et espace
// recruteur : décision du 11/10/2026), ou toutes ses données. Le jeton passe dans l'en-tête x-gestion.

const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const m = /#g=([\w-]{32,64})/.exec(location.hash);
const jeton = m?.[1] ?? "";
if (m) history.replaceState(null, "", location.pathname);
const echapper = (/** @type {unknown} */ t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** @param {string} action */
async function appeler(action) {
  const res = await fetch("/api/whyme/gestion", { method: "POST", headers: { "content-type": "application/json", "x-gestion": jeton }, body: JSON.stringify({ action }) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.message ?? "Erreur");
  return d;
}

/** @param {string} corps */
const ecran = (corps) => { app.innerHTML = `<section class="ecran"><div class="haut"><span class="marque">why me</span></div><div class="corps">${corps}</div></section>`; };

async function afficher() {
  let e;
  try { e = await appeler("etat"); } catch (err) { return ecran(`<h1>Lien non valable</h1><p class="alerte">${echapper(/** @type {Error} */ (err).message)}</p>`); }
  ecran(`<p class="surtitre">Tu gardes la main</p><h1>Bonjour ${echapper(e.prenom)}</h1>
    <p>Ta candidature (${echapper(e.evenement)}) a été transmise à <strong>${echapper(e.entreprises.join(", ") || "aucune entreprise")}</strong>.</p>
    <div class="carte" style="margin:16px 0">
      <h2>Ma vidéo</h2>
      ${e.video ? `<p>Elle est visible par les entreprises choisies${e.pagePublique ? ` et sur <a href="${echapper(e.pagePublique)}">ta page publique</a>` : ""}. La supprimer l'efface partout, définitivement ; ta candidature reste transmise.</p>
        <button class="bouton secondaire" id="video">Supprimer ma vidéo</button>` : "<p>Ta vidéo a été supprimée.</p>"}
    </div>
    <div class="carte">
      <h2>Toutes mes données</h2>
      <p>Vidéo, CV, identité : tout est effacé, et les entreprises ne verront plus ta candidature.</p>
      <button class="bouton secondaire" id="tout">Supprimer toutes mes données</button>
    </div>
    <p style="margin-top:16px"><a href="/whyme/confidentialite/">Politique de confidentialité</a></p>`);
  document.getElementById("video")?.addEventListener("click", async () => {
    if (!confirm("Supprimer ta vidéo, partout et définitivement ?")) return;
    await appeler("supprimer_video");
    afficher();
  });
  document.getElementById("tout")?.addEventListener("click", async () => {
    if (!confirm("Supprimer toutes tes données ? Ta candidature ne sera plus visible.")) return;
    await appeler("supprimer_tout");
    ecran(`<h1>C'est fait</h1><p>Toutes tes données ont été supprimées.</p>`);
  });
}

if (!jeton) ecran("<h1>Lien incomplet</h1><p>Ouvre le lien reçu par e-mail.</p>"); else afficher();

export {};
