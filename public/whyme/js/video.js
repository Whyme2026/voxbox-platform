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
