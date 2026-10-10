// @ts-check
// Page publique de retrait : /retrait/#<code>. Le code est dans le fragment (#), jamais envoyé dans l'URL
// d'une requête ni conservé dans les journaux du serveur.

const page = /** @type {HTMLElement} */ (document.getElementById("page"));

/**
 * @param {string} balise
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} enfants
 */
function h(balise, attrs = {}, ...enfants) {
  const el = document.createElement(balise);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const e of enfants) if (e) el.append(e);
  return el;
}

/** @param {...(Node | null | false)} contenu */
function afficher(...contenu) {
  page.replaceChildren(...contenu.filter((c) => c instanceof Node));
  const premier = page.querySelector("button, input");
  if (premier instanceof HTMLElement && premier.tagName === "INPUT") premier.focus();
}

/** @param {string} brut */
const normaliser = (brut) => brut.toUpperCase().replace(/[^A-Z0-9]/g, "");
const VALIDE = /^[A-HJ-NP-Z2-9]{10}$/;

/** @param {string} iso */
const jour = (iso) => new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z"))
  .toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

/** @param {any} info */
function habiller(info) {
  const c = info.couleurs ?? {};
  if (typeof c.principale === "string") document.documentElement.style.setProperty("--accent", c.principale);
  if (typeof c.secondaire === "string") document.documentElement.style.setProperty("--parole", c.secondaire);
  const logo = /** @type {HTMLImageElement} */ (document.getElementById("logo"));
  if (info.logo_url) { logo.src = info.logo_url; logo.alt = info.marque; logo.hidden = false; }
}

function saisie(/** @type {string} */ message = "") {
  const champ = /** @type {HTMLInputElement} */ (h("input", { id: "code", inputmode: "text", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", placeholder: "XXXX-XXXX-XX", maxlength: "14" }));
  const envoyer = (/** @type {Event} */ ev) => { ev.preventDefault(); ouvrir(normaliser(champ.value)); };
  afficher(
    h("h1", { class: "bulle titre" }, "Retirer mon accord"),
    h("p", { class: "bulle douce" }, "Saisissez le code affiché sous le QR code, à la fin de votre passage dans la cabine."),
    h("form", { class: "carte champ", onsubmit: envoyer },
      h("label", { for: "code" }, "Votre code"), champ,
      message ? h("p", { class: "erreur", role: "alert" }, message) : null,
      h("button", { type: "submit", class: "principal" }, "Continuer")),
  );
}

/** @param {string} code */
async function ouvrir(code) {
  if (!VALIDE.test(code)) return saisie("Ce code n'est pas valide : 10 lettres et chiffres.");
  afficher(h("p", { class: "bulle douce" }, "Un instant…"));
  let r;
  try { r = await fetch(`/api/retrait/${code}`, { headers: { accept: "application/json" } }); }
  catch { return erreurReseau(() => ouvrir(code)); }
  if (r.status === 404) return saisie("Nous ne trouvons pas ce code. Vérifiez-le, ou contactez la marque.");
  if (!r.ok) return erreurReseau(() => ouvrir(code));
  const info = await r.json();
  habiller(info);
  if (info.retiree_le) return termine(info, "tout");
  choix(code, info);
}

/** @param {string} code @param {any} info */
function choix(code, info) {
  afficher(
    h("h1", { class: "bulle titre" }, info.prenom ? `Bonjour ${info.prenom}` : "Bonjour"),
    h("p", { class: "bulle douce" }, `Vous avez répondu en vidéo pour ${info.marque} le ${jour(info.date)}. Vous pouvez changer d'avis à tout moment, sans avoir à vous justifier.`),
    h("div", { class: "carte" },
      h("p", {}, info.diffusion
        ? "Vous aviez accepté que vos réponses servent en interne et puissent être diffusées publiquement."
        : "Vous aviez accepté que vos réponses servent en interne uniquement."),
      h("p", { class: "doux" }, `Campagne : ${info.campagne}`)),
    h("div", { class: "choix" },
      info.diffusion ? h("button", { type: "button", class: "secondaire", onclick: () => confirmer(code, info, "diffusion") }, "Retirer seulement l'accord de diffusion") : null,
      h("button", { type: "button", class: "danger", onclick: () => confirmer(code, info, "tout") }, "Supprimer mes réponses")),
    contact(info),
  );
}

/** @param {string} code @param {any} info @param {"tout" | "diffusion"} portee */
function confirmer(code, info, portee) {
  const bouton = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: portee === "tout" ? "danger" : "principal" },
    portee === "tout" ? "Oui, supprimer mes réponses" : "Oui, ne plus diffuser"));
  bouton.addEventListener("click", async () => {
    bouton.disabled = true;
    try {
      const r = await fetch(`/api/retrait/${code}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ portee }) });
      if (!r.ok) throw new Error(String(r.status));
      termine(info, portee);
    } catch { bouton.disabled = false; erreurReseau(() => confirmer(code, info, portee)); }
  });
  afficher(
    h("h1", { class: "bulle titre" }, "Vous confirmez ?"),
    h("p", { class: "bulle douce" }, portee === "tout"
      ? "Vos vidéos seront supprimées définitivement et vos coordonnées effacées. Cela ne peut pas être annulé."
      : "Vos réponses resteront utilisées en interne par la marque, mais ne seront plus diffusées publiquement."),
    h("div", { class: "choix" }, bouton,
      h("button", { type: "button", class: "lien", onclick: () => choix(code, info) }, "Non, revenir")),
  );
}

/** @param {any} info @param {"tout" | "diffusion"} portee */
function termine(info, portee) {
  afficher(
    h("p", { class: "bulle visiteur" }, portee === "tout" ? "Mes réponses sont supprimées" : "Mes réponses ne seront plus diffusées"),
    h("p", { class: "bulle douce" }, portee === "tout"
      ? "C'est fait. Vos vidéos ont été supprimées et vos coordonnées effacées. Merci d'avoir pris le temps de répondre."
      : "C'est fait. Vos réponses ne seront plus diffusées publiquement. Merci pour votre participation."),
    contact(info),
  );
  history.replaceState(null, "", location.pathname);
}

/** @param {any} info */
function contact(info) {
  return info.contact_rgpd
    ? h("p", { class: "doux" }, `Une question sur vos données ? Écrivez à ${info.contact_rgpd}.`)
    : null;
}

/** @param {() => void} reessayer */
function erreurReseau(reessayer) {
  afficher(
    h("p", { class: "bulle douce" }, "La connexion n'a pas abouti. Vérifiez votre réseau et réessayez."),
    h("button", { type: "button", class: "principal", onclick: reessayer }, "Réessayer"),
  );
}

const depuisLien = normaliser(decodeURIComponent(location.hash.slice(1)));
if (depuisLien) ouvrir(depuisLien); else saisie();
