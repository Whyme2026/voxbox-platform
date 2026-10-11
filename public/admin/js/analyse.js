// @ts-check
// Parlorama, onglet « Analyse » (option Analyse, lot 2) : ce que disent les visiteurs, par question, par thème et en direct.
// On montre des propos et des comptes de propos, jamais une note ni un profil de personne.
// Vues agrégées à partir de 100 visiteurs ; recherche par thèmes, direct et alertes dès la première réponse.

import { h } from "./dom.js";

/**
 * Outils fournis par admin.js (pas d'import circulaire).
 * @typedef {{
 *   api: (chemin: string, opts?: { methode?: string, corps?: unknown }) => Promise<any>,
 *   toast: (message: string, ton?: string) => void,
 *   lireDans: (ecran: HTMLElement, url: string) => Promise<string>,
 *   date: (iso: string | null | undefined) => string,
 *   ilYa: (iso: string | null | undefined) => string,
 * }} Outils
 */

const TONS = /** @type {const} */ (["positif", "neutre", "negatif"]);
const LIBELLE_TON = { positif: "positif", neutre: "neutre", negatif: "négatif" };
/** Sous ce nombre de propos, on montre des nombres, jamais de pourcentages. */
const MIN_POURCENTAGE = 30;
/** Enfants à poser, sans les absents. @returns {(Node | string)[]} */
const vrais = (/** @type {(Node | string | null | undefined | false)[]} */ ...xs) => /** @type {(Node | string)[]} */ (xs.filter((x) => x !== null && x !== undefined && x !== false));
const minutes = (/** @type {number} */ s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Écran vidéo qui démarre au moment de l'extrait. */
function extraitVideo(/** @type {Outils} */ o, /** @type {string} */ reponseId, /** @type {number | null} */ debut, /** @type {string} */ libelle) {
  const ecran = h("button", { type: "button", class: "ecran-video petit", "aria-label": `Lire l'extrait : ${libelle}` },
    h("span", { class: "lecture" }, "▶ ", debut !== null ? minutes(debut) : "Lire"));
  ecran.addEventListener("click", async () => {
    if (ecran.querySelector("video")) return;
    try {
      await o.lireDans(ecran, `/api/espace/reponses/${reponseId}/video`);
      const v = /** @type {HTMLVideoElement | null} */ (ecran.querySelector("video"));
      if (v && debut !== null) {
        const placer = () => { v.currentTime = Math.max(0, debut - 0.3); };
        if (v.readyState >= 1) placer(); else v.addEventListener("loadedmetadata", placer, { once: true });
      }
    } catch (e) { ecran.replaceChildren(h("span", { class: "lecture" }, /** @type {Error} */ (e).message)); }
  });
  return ecran;
}

function pastilleTon(/** @type {string} */ ton, /** @type {string} */ libelle = "") {
  return h("span", { class: `pastille ton-${ton}` }, libelle ? `${libelle} · ${LIBELLE_TON[/** @type {"positif"} */ (ton)] ?? ton}` : LIBELLE_TON[/** @type {"positif"} */ (ton)] ?? ton);
}

/** Barre de tonalité (positif, neutre, négatif) avec les nombres ; pourcentages seulement à partir de 30 propos. */
function barreTon(/** @type {{ n: number, positif: number, neutre: number, negatif: number }} */ t) {
  const pc = (/** @type {number} */ x) => Math.round((x / Math.max(t.n, 1)) * 100);
  const lisible = t.n >= MIN_POURCENTAGE
    ? `${pc(t.positif)} % positif, ${pc(t.neutre)} % neutre, ${pc(t.negatif)} % négatif`
    : `${t.positif} positif, ${t.neutre} neutre, ${t.negatif} négatif`;
  return h("div", { class: "barre-ton", role: "img", "aria-label": lisible },
    ...TONS.map((k) => h("span", { class: `ton-${k}`, style: `width: ${pc(t[k])}%` })));
}

// ------------------------------------------------------------------ vue « Par question »

async function vueParQuestion(/** @type {any} */ c, /** @type {Outils} */ o, /** @type {URLSearchParams} */ options) {
  const d = await o.api(`/api/espace/campagnes/${c.id}/analyse`);
  if (!d.grille.length) return h("section", { class: "carte vide" }, "Aucune grille de thèmes : WhyMe la définit avec la marque (Modifier la campagne).");
  if (!d.seuil.atteint) {
    const pc = Math.min(100, Math.round((d.seuil.visiteurs / d.seuil.requis) * 100));
    return h("section", { class: "carte pile seuil" },
      h("h2", {}, `L'analyse par question s'ouvre à ${d.seuil.requis} visiteurs`),
      h("div", { class: "jauge large", role: "img", "aria-label": `${d.seuil.visiteurs} visiteurs sur ${d.seuil.requis}` }, h("span", { style: `width: ${pc}%` })),
      h("p", { class: "sous" }, `${d.seuil.visiteurs} visiteur${d.seuil.visiteurs > 1 ? "s" : ""} sur ${d.seuil.requis}. En dessous de ce volume, une répartition par thème ou une tonalité ne veut rien dire.`),
      h("p", {}, "Les propos sont déjà transcrits et classés un par un : la recherche par thèmes, le direct et les alertes fonctionnent depuis la première réponse."),
      h("ul", { class: "liste-questions" }, ...d.questions.map((/** @type {any} */ q) =>
        h("li", {}, h("strong", {}, q.titre), ` · ${q.classees} réponse${q.classees > 1 ? "s" : ""} classée${q.classees > 1 ? "s" : ""}${q.en_cours ? `, ${q.en_cours} en cours` : ""}`))),
      h("div", { class: "boutons" },
        h("a", { class: "bouton", href: `#/campagnes/${c.id}?onglet=analyse&vue=direct` }, "Voir le direct"),
        h("a", { class: "bouton discret", href: `#/campagnes/${c.id}?onglet=analyse&vue=recherche` }, "Chercher par thème")));
  }

  const questions = d.questions.filter((/** @type {any} */ q) => q.reponses > 0);
  if (!questions.length) return h("section", { class: "carte vide" }, "Aucune réponse classée pour l'instant.");
  let qid = options.get("question") && questions.some((/** @type {any} */ q) => q.id === options.get("question")) ? options.get("question") : questions[0].id;
  const zone = h("div", { class: "pile", style: "gap: 18px" });
  const puces = h("div", { class: "puces", role: "group", "aria-label": "Question" });

  const dessiner = () => {
    const q = questions.find((/** @type {any} */ x) => x.id === qid);
    puces.replaceChildren(...questions.map((/** @type {any} */ x) => h("button", { type: "button", class: "puce", "aria-pressed": String(x.id === qid), onclick: () => { qid = x.id; dessiner(); } }, x.titre)));
    const max = Math.max(1, ...q.themes.map((/** @type {any} */ t) => t.n));
    let themeVerbatims = q.themes[0]?.id;
    const zoneVerbatims = h("div", {});
    const dessinerVerbatims = () => {
      const t = q.themes.find((/** @type {any} */ x) => x.id === themeVerbatims);
      zoneVerbatims.replaceChildren(...vrais(
        h("div", { class: "puces", role: "group", "aria-label": "Thème" }, ...q.themes.map((/** @type {any} */ x) =>
          h("button", { type: "button", class: "puce", "aria-pressed": String(x.id === themeVerbatims), onclick: () => { themeVerbatims = x.id; dessinerVerbatims(); } }, x.libelle))),
        !t || !t.verbatims.length ? h("p", { class: "vide" }, "Pas d'extrait assez long pour ce thème.")
          : h("div", { class: "verbatims" }, ...t.verbatims.map((/** @type {any} */ v) => h("figure", { class: "verbatim" },
            extraitVideo(o, v.reponse_id, v.debut, v.prenom),
            h("blockquote", { class: "bulle-visiteur" }, `« ${v.extrait} »`),
            h("figcaption", {}, `${v.prenom} · `, pastilleTon(v.tonalite), v.consent_diffusion ? " · diffusion acceptée" : " · usage interne")))),
        t ? h("a", { class: "bouton discret petit", href: `#/campagnes/${c.id}?onglet=analyse&vue=recherche&theme=${t.id}&question=${q.id}` }, `Voir les ${t.n} propos`) : null));
    };
    dessinerVerbatims();
    zone.replaceChildren(...vrais(
      h("div", { class: "bulle question-analysee" }, q.texte || q.titre),
      h("p", { class: "sous" }, `${q.classees} réponse${q.classees > 1 ? "s" : ""} classée${q.classees > 1 ? "s" : ""}${q.en_cours ? ` · ${q.en_cours} en cours` : ""}${q.echecs ? ` · ${q.echecs} impossible${q.echecs > 1 ? "s" : ""}` : ""}`),
      h("section", { class: "carte" },
        h("h2", {}, "De quoi parlent les gens"),
        q.themes.length ? h("div", { class: "barres-themes" }, ...q.themes.map((/** @type {any} */ t) => h("div", { class: "ligne-theme" },
          h("span", {}, t.libelle),
          h("span", { class: "jauge", "aria-hidden": "true" }, h("span", { style: `width: ${Math.round((t.n / max) * 100)}%` })),
          h("strong", {}, String(t.n))))) : h("p", { class: "vide" }, "Aucun thème de la grille abordé pour l'instant."),
        q.autres.length ? h("p", { class: "sous", style: "margin-top: 12px" }, "Autres sujets, hors grille : ", q.autres.map((/** @type {any} */ a) => `${a.sujet} (${a.n})`).join(", ")) : null,
        h("p", { class: "sous" }, "Une réponse peut toucher plusieurs thèmes.")),
      q.themes.length ? h("section", { class: "carte" },
        h("h2", {}, "Tonalité par thème"),
        h("div", { class: "tons" }, ...q.themes.map((/** @type {any} */ t) => h("div", { class: "ligne-ton" },
          h("span", {}, t.libelle), barreTon(t), h("span", { class: "nombres" }, `${t.positif} · ${t.neutre} · ${t.negatif}`)))),
        h("p", { class: "sous legende-tons" }, h("span", { class: "puce-ton ton-positif" }), "positif ", h("span", { class: "puce-ton ton-neutre" }), "neutre ",
          h("span", { class: "puce-ton ton-negatif" }), "négatif · lue dans le texte de chaque propos, jamais dans la voix ni l'image ; nombres de propos positifs · neutres · négatifs.")) : null,
      q.themes.length ? h("section", { class: "carte" }, h("h2", {}, "Verbatims représentatifs"), zoneVerbatims) : null));
  };
  dessiner();
  return h("div", {}, puces, zone);
}

// ------------------------------------------------------------------ vue « Recherche par thèmes »

async function vueRecherche(/** @type {any} */ c, /** @type {Outils} */ o, /** @type {URLSearchParams} */ options) {
  const grille = c.grille_themes ?? [];
  let theme = options.get("theme") ?? grille[0]?.id ?? "";
  let tonalite = "";
  const question = options.get("question") ?? "";
  const mots = /** @type {HTMLInputElement} */ (h("input", { type: "search", class: "recherche", placeholder: "Affiner par mots, ex. « clim »", "aria-label": "Affiner par mots" }));
  const puces = h("div", { class: "puces", role: "group", "aria-label": "Thème" });
  const tons = h("div", { class: "puces", role: "group", "aria-label": "Tonalité" });
  const resultats = h("section", { class: "carte" });
  const libelle = (/** @type {string} */ id) => grille.find((/** @type {any} */ t) => t.id === id)?.libelle ?? id;

  const chercher = async () => {
    puces.replaceChildren(
      h("button", { type: "button", class: "puce", "aria-pressed": String(!theme), onclick: () => { theme = ""; chercher(); } }, "Tous les propos"),
      ...grille.map((/** @type {any} */ t) => h("button", { type: "button", class: "puce", "aria-pressed": String(t.id === theme), onclick: () => { theme = t.id; chercher(); } }, t.libelle)));
    tons.replaceChildren(...[["", "Toutes tonalités"], ["positif", "Positifs"], ["neutre", "Neutres"], ["negatif", "Négatifs"]].map(([k, l]) =>
      h("button", { type: "button", class: "puce", "aria-pressed": String(k === tonalite), onclick: () => { tonalite = k; chercher(); } }, l)));
    const p = new URLSearchParams();
    if (theme) p.set("theme", theme);
    if (tonalite) p.set("tonalite", tonalite);
    if (question) p.set("question", question);
    if (mots.value.trim()) p.set("q", mots.value.trim());
    p.set("limite", "30");
    resultats.replaceChildren(h("p", { class: "attente" }, "Recherche…"));
    try {
      const r = await o.api(`/api/espace/campagnes/${c.id}/analyse/propos?${p}`);
      resultats.replaceChildren(...vrais(
        h("h2", {}, `${r.total} propos${theme ? ` · ${libelle(theme)}` : ""}`),
        r.propos.length ? h("div", { class: "liste-propos" }, ...r.propos.map((/** @type {any} */ x) => h("article", { class: "propos" },
          extraitVideo(o, x.reponse_id, x.debut, x.prenom),
          h("div", { class: "pile", style: "gap: 6px; min-width: 0" },
            h("blockquote", { class: "bulle-visiteur" }, `« ${x.extrait ?? ""}${x.theme_id ? "" : "…"} »`),
            h("div", { class: "meta-propos" }, `${x.prenom} · ${o.date(x.cree_le)}${x.cabine ? ` · ${x.cabine}` : ""} `,
              ...x.themes.map((/** @type {any} */ t) => pastilleTon(t.tonalite, libelle(t.id))),
              x.consent_diffusion ? null : h("span", { class: "pastille" }, "usage interne")))))) : h("p", { class: "vide" }, "Aucun propos ne correspond."),
        r.total > r.propos.length ? h("p", { class: "sous" }, `Les ${r.propos.length} plus récents sont affichés : affinez pour voir les autres.`) : null));
    } catch (e) { resultats.replaceChildren(h("p", { class: "erreurs" }, /** @type {Error} */ (e).message)); }
  };
  let delai = 0;
  mots.addEventListener("input", () => { clearTimeout(delai); delai = Number(setTimeout(chercher, 350)); });
  await chercher();
  return h("div", { class: "pile", style: "gap: 14px" },
    h("p", { class: "sous", style: "margin: 0" }, "Choisissez un thème : chaque propos s'ouvre au moment où le sujet est abordé dans la vidéo. Chaque recherche est enregistrée dans le journal."),
    puces, h("div", { class: "barre-reponses" }, tons, mots), resultats);
}

// ------------------------------------------------------------------ vue « Aujourd'hui en direct »

async function vueDirect(/** @type {any} */ c, /** @type {Outils} */ o) {
  const racine = h("div", { class: "pile", style: "gap: 18px" });
  const charger = async () => {
    const d = await o.api(`/api/espace/campagnes/${c.id}/direct`);
    const nonVues = d.alertes.filter((/** @type {any} */ a) => !a.alerte_vue_le).length;
    const max = Math.max(1, ...d.visiteurs.par_heure.map((/** @type {any} */ x) => x.n));
    racine.replaceChildren(
      h("div", { class: "barre-reponses" },
        h("p", { class: "sous", style: "margin: 0" }, "Chaque réponse est transcrite et classée environ une minute après l'enregistrement. Actualisé toutes les minutes."),
        h("span", { class: "pastille", "data-ton": "vox" }, `En direct · ${new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date())}`)),
      h("div", { class: "grille kpi" },
        h("div", { class: "carte" }, h("span", { class: "valeur" }, String(d.visiteurs.aujourdhui)), h("span", { class: "libelle" }, "visiteurs aujourd'hui")),
        h("div", { class: "carte" }, h("span", { class: "valeur" }, String(d.visiteurs.derniere_heure)), h("span", { class: "libelle" }, "dans la dernière heure")),
        h("div", { class: "carte" }, h("span", { class: "valeur", style: nonVues ? "color: var(--rouge)" : "" }, String(nonVues)), h("span", { class: "libelle" }, `alerte${nonVues > 1 ? "s" : ""} à traiter`))),
      h("div", { class: "colonnes-direct" },
        h("div", { class: "pile", style: "gap: 18px; min-width: 0" },
          d.visiteurs.par_heure.length ? h("section", { class: "carte" }, h("h2", {}, "Visiteurs par heure"),
            h("div", { class: "heures", role: "img", "aria-label": d.visiteurs.par_heure.map((/** @type {any} */ x) => `${x.heure} h : ${x.n}`).join(", ") },
              ...d.visiteurs.par_heure.map((/** @type {any} */ x) => h("div", { class: "heure" },
                h("span", { class: "colonne", style: `height: ${Math.max(4, Math.round((x.n / max) * 100))}%` }), h("span", { class: "n" }, String(x.n)), h("span", { class: "h" }, `${x.heure} h`))))) : null,
          h("section", { class: "carte" }, h("h2", {}, "Derniers propos"),
            d.derniers_propos.length ? h("div", { class: "pile", style: "gap: 14px" }, ...d.derniers_propos.map((/** @type {any} */ p) => h("div", { class: "pile", style: "gap: 6px" },
              h("div", { class: "meta-propos" }, `${o.ilYa(p.cree_le)} · ${p.prenom} · ${p.question} `,
                ...p.themes.map((/** @type {any} */ t) => pastilleTon(t.tonalite, t.libelle)),
                p.autre_sujet ? h("span", { class: "pastille" }, p.autre_sujet) : null,
                p.alerte ? h("span", { class: "pastille", "data-ton": "rouge" }, "alerte") : null),
              p.texte ? h("blockquote", { class: "bulle-visiteur" }, `« ${p.texte} »`) : h("p", { class: "attente" }, "Transcription en cours…"))))
              : h("p", { class: "vide" }, "Aucune réponse ces derniers jours."))),
        h("div", { class: "pile", style: "gap: 18px; min-width: 0" },
          h("section", { class: `carte${nonVues ? " alerte" : ""}` }, h("h2", {}, "Insatisfaction forte"),
            d.alertes.length ? h("div", { class: "pile", style: "gap: 16px" }, ...d.alertes.map((/** @type {any} */ a) => h("div", { class: "pile", style: "gap: 6px" },
              h("strong", {}, a.alerte_motif ?? "Insatisfaction forte"),
              a.extrait ? h("blockquote", { class: "bulle-visiteur" }, `« ${a.extrait} »`) : null,
              h("span", { class: "meta-propos" }, `${o.date(a.cree_le)} · ${a.prenom} · ${a.question}${a.recontact ? " · accepte d'être recontacté" : ""}`),
              h("div", { class: "boutons" },
                extraitVideo(o, a.reponse_id, null, a.prenom),
                a.alerte_vue_le ? h("span", { class: "pastille", "data-ton": "vert" }, `Vue par ${a.alerte_vue_par}`)
                  : h("button", { type: "button", class: "bouton discret petit", onclick: async () => {
                    try { await o.api(`/api/espace/reponses/${a.reponse_id}/alerte-vue`, { methode: "POST", corps: {} }); o.toast("Alerte marquée comme vue."); await charger(); }
                    catch (e) { o.toast(/** @type {Error} */ (e).message, "erreur"); }
                  } }, "Marquer comme vue")))))
              : h("p", { class: "vide", style: "text-align: left; padding: 0" }, "Aucune alerte aujourd'hui."),
            h("p", { class: "sous" }, "L'alerte porte sur un propos, pas sur la personne. Le recontact n'est possible que si le visiteur l'a accepté.")),
          h("section", { class: "carte" }, h("h2", {}, "Ce qui monte aujourd'hui"),
            d.sujets_qui_montent.length ? h("div", { class: "pile", style: "gap: 8px" }, ...d.sujets_qui_montent.map((/** @type {any} */ s) => h("div", { class: "ligne-montee" },
              h("span", {}, s.libelle), h("strong", {}, s.moyenne === null ? `${s.aujourdhui}` : s.moyenne === 0 ? `${s.aujourdhui} · nouveau` : `${s.aujourdhui} · ${s.moyenne} par jour avant`))))
              : h("p", { class: "vide", style: "text-align: left; padding: 0" }, "Rien de classé aujourd'hui.")),
          h("section", { class: "carte" }, h("h2", {}, "Cabines"),
            d.cabines.length ? h("div", { class: "pile", style: "gap: 8px" }, ...d.cabines.map((/** @type {any} */ cb) => {
              const enLigne = cb.vu_le && Date.now() - Date.parse(cb.vu_le) < 3 * 60_000;
              const batterie = cb.signal?.batterie;
              return h("div", { class: "ligne-montee" }, h("span", {}, cb.nom),
                h("span", { class: "pastille", "data-ton": !enLigne ? "rouge" : batterie !== null && batterie !== undefined && batterie < 20 && !cb.signal?.en_charge ? "jaune" : "vert" },
                  !enLigne ? `hors ligne · vue ${o.ilYa(cb.vu_le)}` : batterie !== null && batterie !== undefined ? `en ligne · batterie ${batterie} %` : "en ligne"));
            })) : h("p", { class: "vide", style: "text-align: left; padding: 0" }, "Aucune cabine affectée.")))));
  };
  await charger();
  // Actualisation toutes les minutes tant que la vue est affichée.
  const minuterie = setInterval(() => {
    if (!racine.isConnected) { clearInterval(minuterie); return; }
    if (document.visibilityState === "visible") charger().catch(() => {});
  }, 60_000);
  return racine;
}

/** Onglet « Analyse » d'une campagne avec l'option. */
export async function vueAnalyse(/** @type {any} */ c, /** @type {Outils} */ o, /** @type {URLSearchParams} */ options) {
  if (!c.option_analyse) return h("section", { class: "carte vide" }, "Cette campagne n'a pas l'option Analyse.");
  const vue = options.get("vue") ?? "question";
  const vues = [["question", "Par question"], ["recherche", "Recherche par thèmes"], ["direct", "Aujourd'hui en direct"]];
  const barre = h("div", { class: "puces sous-onglets", role: "tablist" }, ...vues.map(([k, l]) =>
    h("a", { class: "puce", role: "tab", "aria-selected": String(k === vue), "aria-pressed": String(k === vue), href: `#/campagnes/${c.id}?onglet=analyse&vue=${k}` }, l)));
  const contenu = vue === "recherche" ? await vueRecherche(c, o, options) : vue === "direct" ? await vueDirect(c, o) : await vueParQuestion(c, o, options);
  return h("div", {}, barre, contenu);
}
