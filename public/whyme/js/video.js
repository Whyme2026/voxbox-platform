// @ts-check
// Page vidéo publique d'un candidat Why me (/v/<code>, QR code du sticker). Lecture seule, sans téléchargement
// proposé (décision du 11/10/2026) ; la vidéo disparaît dès que le candidat la supprime ou à l'échéance.

const code = (location.pathname.match(/^\/v\/([A-Z0-9]{10})/) ?? [])[1] ?? "";
const texte = /** @type {HTMLElement} */ (document.getElementById("texte"));
const echapper = (/** @type {unknown} */ t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function charger() {
  const res = await fetch(`/api/whyme/videos/${code}`);
  if (!res.ok) {
    texte.innerHTML = `<h1 style="margin-top:24px">Cette vidéo n'est plus disponible</h1><p>Son auteur l'a supprimée, ou elle a expiré.</p>`;
    return;
  }
  const v = await res.json();
  // Feuille de style de la campagne (couleurs et motif), comme sur le téléphone du candidat.
  if (v.style?.couleurs) {
    const k = v.style.couleurs, r = document.documentElement.style;
    r.setProperty("--fuchsia", k.accent); r.setProperty("--fuchsia-fonce", k.accentFonce); r.setProperty("--rose", k.accentPale);
    r.setProperty("--greige", k.bulle); r.setProperty("--titre", k.titre); r.setProperty("--texte", k.texte);
    document.documentElement.dataset.style = v.style.id;
    if (v.style.motif && /^[a-z0-9-]+$/.test(v.style.motif)) {
      document.documentElement.dataset.motif = v.style.motif;
      document.documentElement.style.setProperty("--motif", `url("/whyme/motifs/${v.style.motif}.svg")`);
    }
  }
  document.title = `${v.prenom} · why me`;
  texte.innerHTML = `<p class="surtitre" style="margin-top:20px">Plus qu'un CV. Quelqu'un.</p><h1>${echapper(v.prenom)}</h1>`;
  const lecteur = document.createElement("div");
  lecteur.className = "lecteur";
  lecteur.innerHTML = `<video controls playsinline preload="metadata" controlslist="nodownload noplaybackrate" disablepictureinpicture ${v.aMiniature ? `poster="/api/whyme/videos/${code}/miniature"` : ""} src="/api/whyme/videos/${code}/flux"></video>`;
  lecteur.addEventListener("contextmenu", (e) => e.preventDefault());
  texte.after(lecteur);
  const pied = document.createElement("div");
  pied.className = "texte";
  pied.innerHTML = `<p style="margin-top:16px;font-size:15px">Interview réalisée avec la JobBox WhyMe · ${echapper(v.evenement)}.<br>Une minute pour découvrir la personne derrière le CV.</p>`;
  lecteur.after(pied);
}

charger().catch(() => { texte.innerHTML = "<p>Chargement impossible. Réessaie dans un instant.</p>"; });

export {};
