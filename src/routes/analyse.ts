// Option Analyse, lot 2 : ce que la marque lit dans Parlorama (décisions du 11/10/2026).
// - « Par question » : de quoi parlent les gens, tonalité par thème, verbatims représentatifs. Vues agrégées :
//   ouvertes à partir de 100 visiteurs par défaut, réglable par campagne entre 20 et 1000 (en dessous, une répartition ne veut rien dire).
// - « Recherche par thèmes » et « Aujourd'hui en direct » (avec les alertes) : dès la première réponse.
// - La marque voit le classement dès qu'il est fait. Même périmètre que les vidéos (droit reponses.lire,
//   cloisonnement par client), et chaque consultation qui montre des propos est journalisée.
// On restitue des propos et des comptes de propos, jamais une note ni un profil de personne.

import type { Routeur, Contexte } from "../routeur.ts";
import { identifier, type Identite } from "../auth/identite.ts";
import { exiger, verifierAppartenance } from "../auth/droits.ts";
import { conflit, HttpError, introuvable, json, maintenant } from "../http.ts";
import { journaliser, ligneJournal } from "../journal.ts";
import { chargerCampagne, type LigneCampagne } from "./campagnes-commun.ts";
import { libellesParcours } from "./reponses.ts";
import type { Theme, Tonalite } from "../analyse/classement.ts";

/** Seuil d'ouverture des vues agrégées par défaut, en visiteurs (environ 450 réponses). Réglable par campagne (seuil_analyse). */
export const SEUIL_VISITEURS = 100;
/** Plus petit seuil réglable : en dessous, une répartition isolerait trop facilement une personne. */
export const SEUIL_MINIMUM = 20;
const FUSEAU = "Europe/Paris";

const jourParis = (iso: string) => new Intl.DateTimeFormat("fr-CA", { timeZone: FUSEAU, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const FORMAT_HEURE = new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, hour: "2-digit", hourCycle: "h23" });
/** Heure (0 à 23) à Paris. formatToParts : le format seul donne « 20 h », pas un nombre. */
export const heureParis = (iso: string) => Number(FORMAT_HEURE.formatToParts(new Date(iso)).find((p) => p.type === "hour")?.value ?? 0);

async function campagneAnalysee(ctx: Contexte): Promise<{ id: Identite; c: LigneCampagne; grille: Theme[] }> {
  const id = await identifier(ctx.request, ctx.env);
  exiger(id, "reponses.lire");
  const c = await chargerCampagne(ctx.env.DB, id, ctx.params.id!);
  if (c.option_analyse !== 1) throw conflit("Cette campagne n'a pas l'option Analyse");
  return { id, c, grille: JSON.parse(c.grille_themes) as Theme[] };
}

/** Visiteurs comptés pour le seuil : accord non retiré, au moins une réponse vidéo reçue. */
async function nombreVisiteurs(ctx: Contexte, campagneId: string): Promise<number> {
  const r = await ctx.env.DB.prepare(
    `SELECT COUNT(DISTINCT s.id) AS n FROM sessions s JOIN reponses r ON r.session_id = s.id
      WHERE s.campagne_id = ? AND s.retiree_le IS NULL AND s.purgee_le IS NULL AND r.cle_source IS NOT NULL`,
  ).bind(campagneId).first<{ n: number }>();
  return r?.n ?? 0;
}

interface LigneTheme {
  reponse_id: string; etape_id: string; theme_id: string; tonalite: Tonalite; extrait: string | null; debut: number | null; fin: number | null;
  prenom: string; session_id: string; cree_le: string; miniature: number; consent_diffusion: number; cabine: string | null;
}

/** Jusqu'à 3 verbatims pour un thème : un par tonalité présente (la plus fréquente d'abord), puis des extraits de la plus fréquente. */
export function verbatimsRepresentatifs<T extends { tonalite: Tonalite; extrait: string | null }>(lignes: T[], n = 3): T[] {
  // Extraits assez longs pour dire quelque chose, et une seule fois chacun (deux personnes peuvent dire la même chose).
  const vus = new Set<string>();
  const avec = lignes.filter((l) => {
    if (!l.extrait || l.extrait.split(/\s+/).length < 4) return false;
    const cle = l.extrait.toLocaleLowerCase("fr").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (vus.has(cle)) return false;
    vus.add(cle);
    return true;
  });
  const parTon = new Map<Tonalite, T[]>();
  for (const l of avec) parTon.set(l.tonalite, [...(parTon.get(l.tonalite) ?? []), l]);
  const ordre = [...parTon.entries()].sort((a, b) => b[1].length - a[1].length);
  const choisis: T[] = [];
  for (const [, ls] of ordre) if (choisis.length < n) choisis.push(ls[0]!);
  const majorite = ordre[0]?.[1] ?? [];
  for (const l of majorite.slice(1)) if (choisis.length < n) choisis.push(l);
  return choisis;
}

export function routesAnalyse(r: Routeur): void {
  // « Par question » : répartition des thèmes, tonalité par thème, verbatims. Vues agrégées à partir du seuil.
  r.get("/api/espace/campagnes/:id/analyse", async (ctx) => {
    const { id, c, grille } = await campagneAnalysee(ctx);
    const visiteurs = await nombreVisiteurs(ctx, c.id);
    const requis = c.seuil_analyse ?? SEUIL_VISITEURS;
    const atteint = visiteurs >= requis;
    const { questions } = await libellesParcours(ctx.env.DB, c.id);
    const etats = await ctx.env.DB.prepare(
      `SELECT r.etape_id, COUNT(*) AS reponses,
              SUM(r.transcription_etat = 'faite') AS transcrites, SUM(r.analyse_etat = 'faite') AS classees,
              SUM(r.transcription_etat IN ('a_faire', 'en_cours') OR r.analyse_etat IN ('a_faire', 'en_cours')) AS en_cours,
              SUM(r.transcription_etat = 'echec' OR r.analyse_etat = 'echec') AS echecs
         FROM reponses r JOIN sessions s ON s.id = r.session_id
        WHERE s.campagne_id = ? AND s.retiree_le IS NULL AND s.purgee_le IS NULL AND r.cle_source IS NOT NULL
        GROUP BY r.etape_id`,
    ).bind(c.id).all<{ etape_id: string; reponses: number; transcrites: number; classees: number; en_cours: number; echecs: number }>();
    const parEtape = new Map(etats.results.map((e) => [e.etape_id, e]));
    const base = {
      seuil: { visiteurs, requis, atteint },
      grille,
    };
    if (!atteint) {
      return json({ ...base, questions: questions.map((q) => ({ id: q.id, titre: q.titre, texte: q.texte, ...(parEtape.get(q.id) ?? { reponses: 0, transcrites: 0, classees: 0, en_cours: 0, echecs: 0 }) })) });
    }
    const { results: lignes } = await ctx.env.DB.prepare(
      `SELECT t.reponse_id, r.etape_id, t.theme_id, t.tonalite, t.extrait, t.debut, t.fin, s.prenom, s.id AS session_id, r.cree_le,
              r.cle_miniature IS NOT NULL AS miniature, s.consent_diffusion, cb.nom AS cabine
         FROM reponse_themes t JOIN reponses r ON r.id = t.reponse_id JOIN sessions s ON s.id = r.session_id
         LEFT JOIN cabines cb ON cb.id = s.cabine_id
        WHERE s.campagne_id = ? AND s.retiree_le IS NULL AND s.purgee_le IS NULL AND r.analyse_etat = 'faite'
        ORDER BY r.cree_le DESC`,
    ).bind(c.id).all<LigneTheme>();
    const { results: autres } = await ctx.env.DB.prepare(
      `SELECT r.etape_id, lower(r.autre_sujet) AS sujet, COUNT(*) AS n FROM reponses r JOIN sessions s ON s.id = r.session_id
        WHERE s.campagne_id = ? AND s.retiree_le IS NULL AND r.analyse_etat = 'faite' AND r.autre_sujet IS NOT NULL
        GROUP BY r.etape_id, lower(r.autre_sujet) ORDER BY n DESC`,
    ).bind(c.id).all<{ etape_id: string; sujet: string; n: number }>();
    await journaliser(ctx.env.DB, id, { action: "analyse.consultation", cibleType: "campagne", cibleId: c.id, clientId: c.client_id, details: { vue: "par_question" } });
    return json({
      ...base,
      questions: questions.map((q) => {
        const dela = lignes.filter((l) => l.etape_id === q.id);
        const themes = grille.map((t) => {
          const ls = dela.filter((l) => l.theme_id === t.id);
          return {
            id: t.id, libelle: t.libelle, n: ls.length,
            positif: ls.filter((l) => l.tonalite === "positif").length,
            neutre: ls.filter((l) => l.tonalite === "neutre").length,
            negatif: ls.filter((l) => l.tonalite === "negatif").length,
            verbatims: verbatimsRepresentatifs(ls).map(({ etape_id: _e, theme_id: _t, ...v }) => ({ ...v, miniature: Boolean(v.miniature), consent_diffusion: Boolean(v.consent_diffusion) })),
          };
        }).filter((t) => t.n > 0).sort((a, b) => b.n - a.n);
        return {
          id: q.id, titre: q.titre, texte: q.texte,
          ...(parEtape.get(q.id) ?? { reponses: 0, transcrites: 0, classees: 0, en_cours: 0, echecs: 0 }),
          themes,
          autres: autres.filter((a) => a.etape_id === q.id).slice(0, 6).map(({ sujet, n }) => ({ sujet, n })),
        };
      }),
    });
  });

  // « Recherche par thèmes » : propos d'un thème (ou contenant des mots), filtrables. Dès la première réponse.
  r.get("/api/espace/campagnes/:id/analyse/propos", async (ctx) => {
    const { id, c, grille } = await campagneAnalysee(ctx);
    const p = ctx.url.searchParams;
    const theme = p.get("theme") || null;
    if (theme && !grille.some((t) => t.id === theme)) throw introuvable("Thème inconnu pour cette campagne");
    const tonalite = ["positif", "neutre", "negatif"].includes(p.get("tonalite") ?? "") ? p.get("tonalite") : null;
    const question = p.get("question") || null;
    const cabine = p.get("cabine") || null;
    const mots = (p.get("q") ?? "").trim().slice(0, 80);
    const limite = Math.min(Math.max(Number(p.get("limite") ?? 60) || 60, 1), 200);
    const conditions = ["s.campagne_id = ?", "s.retiree_le IS NULL", "s.purgee_le IS NULL", "r.transcription_etat = 'faite'"];
    const valeurs: unknown[] = [c.id];
    if (question) { conditions.push("r.etape_id = ?"); valeurs.push(question); }
    if (cabine) { conditions.push("s.cabine_id = ?"); valeurs.push(cabine); }
    if (mots) { conditions.push("r.transcription LIKE ? ESCAPE '\\'"); valeurs.push(`%${mots.replace(/[\\%_]/g, (x) => `\\${x}`)}%`); }
    let sql: string;
    if (theme) {
      conditions.push("t.theme_id = ?"); valeurs.push(theme);
      if (tonalite) { conditions.push("t.tonalite = ?"); valeurs.push(tonalite); }
      sql = `SELECT r.id AS reponse_id, r.etape_id, s.id AS session_id, s.prenom, cb.nom AS cabine, r.cree_le, r.cle_miniature IS NOT NULL AS miniature,
                    s.consent_diffusion, t.theme_id, t.tonalite, COALESCE(t.extrait, substr(r.transcription, 1, 220)) AS extrait, t.debut, t.fin
               FROM reponse_themes t JOIN reponses r ON r.id = t.reponse_id JOIN sessions s ON s.id = r.session_id
               LEFT JOIN cabines cb ON cb.id = s.cabine_id WHERE ${conditions.join(" AND ")}`;
    } else {
      if (tonalite) { conditions.push("EXISTS (SELECT 1 FROM reponse_themes x WHERE x.reponse_id = r.id AND x.tonalite = ?)"); valeurs.push(tonalite); }
      sql = `SELECT r.id AS reponse_id, r.etape_id, s.id AS session_id, s.prenom, cb.nom AS cabine, r.cree_le, r.cle_miniature IS NOT NULL AS miniature,
                    s.consent_diffusion, NULL AS theme_id, NULL AS tonalite, substr(r.transcription, 1, 220) AS extrait, NULL AS debut, NULL AS fin
               FROM reponses r JOIN sessions s ON s.id = r.session_id
               LEFT JOIN cabines cb ON cb.id = s.cabine_id WHERE ${conditions.join(" AND ")}`;
    }
    const total = await ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).bind(...valeurs).first<{ n: number }>();
    const { results } = await ctx.env.DB.prepare(`${sql} ORDER BY r.cree_le DESC LIMIT ${limite}`).bind(...valeurs).all<Record<string, unknown>>();
    // Thèmes de chaque réponse trouvée (pour les pastilles), en une requête.
    const ids = [...new Set(results.map((x) => String(x.reponse_id)))];
    const { results: tous } = ids.length
      ? await ctx.env.DB.prepare(`SELECT reponse_id, theme_id, tonalite FROM reponse_themes WHERE reponse_id IN (${ids.map(() => "?").join(",")})`).bind(...ids)
        .all<{ reponse_id: string; theme_id: string; tonalite: Tonalite }>()
      : { results: [] };
    await journaliser(ctx.env.DB, id, {
      action: "analyse.recherche", cibleType: "campagne", cibleId: c.id, clientId: c.client_id,
      details: { theme, tonalite, question, mots: mots ? mots.length : undefined, resultats: results.length },
    });
    return json({
      total: total?.n ?? 0,
      grille,
      propos: results.map((x) => ({
        ...x, miniature: Boolean(x.miniature), consent_diffusion: Boolean(x.consent_diffusion),
        themes: tous.filter((t) => t.reponse_id === x.reponse_id).map(({ theme_id, tonalite: ton }) => ({ id: theme_id, tonalite: ton })),
      })),
    });
  });

  // « Aujourd'hui en direct » : visiteurs du jour, derniers propos, sujets qui montent, alertes, cabines. Dès la première réponse.
  r.get("/api/espace/campagnes/:id/direct", async (ctx) => {
    const { id, c, grille } = await campagneAnalysee(ctx);
    const maintenantIso = maintenant();
    const aujourdhui = jourParis(maintenantIso);
    // Huit jours suffisent pour la comparaison (aujourd'hui et les sept jours précédents).
    const depuis = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const { results: sessions } = await ctx.env.DB.prepare(
      "SELECT id, cree_le FROM sessions WHERE campagne_id = ? AND retiree_le IS NULL AND purgee_le IS NULL AND cree_le >= ?",
    ).bind(c.id, depuis).all<{ id: string; cree_le: string }>();
    const duJour = sessions.filter((s) => jourParis(s.cree_le) === aujourdhui);
    const parHeure = new Map<number, number>();
    for (const s of duJour) parHeure.set(heureParis(s.cree_le), (parHeure.get(heureParis(s.cree_le)) ?? 0) + 1);
    const derniereHeure = sessions.filter((s) => Date.parse(s.cree_le) >= Date.now() - 3_600_000).length;

    const { results: recents } = await ctx.env.DB.prepare(
      `SELECT r.id AS reponse_id, r.etape_id, r.cree_le, s.prenom, r.transcription, r.analyse_etat, r.transcription_etat, r.alerte, r.autre_sujet
         FROM reponses r JOIN sessions s ON s.id = r.session_id
        WHERE s.campagne_id = ? AND s.retiree_le IS NULL AND s.purgee_le IS NULL AND r.cle_source IS NOT NULL AND r.cree_le >= ?
        ORDER BY r.cree_le DESC LIMIT 12`,
    ).bind(c.id, depuis).all<{ reponse_id: string; etape_id: string; cree_le: string; prenom: string; transcription: string | null; analyse_etat: string | null; transcription_etat: string | null; alerte: number; autre_sujet: string | null }>();
    const { results: themesRecents } = await ctx.env.DB.prepare(
      `SELECT t.reponse_id, t.theme_id, t.tonalite, r.cree_le FROM reponse_themes t JOIN reponses r ON r.id = t.reponse_id JOIN sessions s ON s.id = r.session_id
        WHERE s.campagne_id = ? AND s.retiree_le IS NULL AND r.cree_le >= ?`,
    ).bind(c.id, depuis).all<{ reponse_id: string; theme_id: string; tonalite: Tonalite; cree_le: string }>();

    // Sujets qui montent : mentions du jour contre la moyenne des jours précédents où la campagne a tourné.
    const joursPrecedents = new Set(themesRecents.map((t) => jourParis(t.cree_le)).filter((j) => j !== aujourdhui));
    const montants = grille.map((t) => {
      const duTheme = themesRecents.filter((x) => x.theme_id === t.id);
      const ajd = duTheme.filter((x) => jourParis(x.cree_le) === aujourdhui).length;
      const avant = duTheme.length - ajd;
      return { id: t.id, libelle: t.libelle, aujourdhui: ajd, moyenne: joursPrecedents.size ? Math.round((avant / joursPrecedents.size) * 10) / 10 : null };
    }).filter((x) => x.aujourdhui > 0).sort((a, b) => (b.aujourdhui - (b.moyenne ?? 0)) - (a.aujourdhui - (a.moyenne ?? 0))).slice(0, 5);

    // Alertes : celles du jour, plus celles des jours précédents pas encore vues.
    const { results: alertes } = await ctx.env.DB.prepare(
      `SELECT r.id AS reponse_id, r.etape_id, r.cree_le, r.alerte_motif, r.alerte_vue_le, r.alerte_vue_par, s.prenom, s.recontact,
              (SELECT t.extrait FROM reponse_themes t WHERE t.reponse_id = r.id AND t.tonalite = 'negatif' AND t.extrait IS NOT NULL LIMIT 1) AS extrait
         FROM reponses r JOIN sessions s ON s.id = r.session_id
        WHERE s.campagne_id = ? AND s.retiree_le IS NULL AND s.purgee_le IS NULL AND r.alerte = 1
        ORDER BY r.cree_le DESC LIMIT 50`,
    ).bind(c.id).all<{ reponse_id: string; etape_id: string; cree_le: string; alerte_motif: string | null; alerte_vue_le: string | null; alerte_vue_par: string | null; prenom: string; recontact: number; extrait: string | null }>();
    const alertesUtiles = alertes.filter((a) => jourParis(a.cree_le) === aujourdhui || !a.alerte_vue_le);

    const { results: cabines } = await ctx.env.DB.prepare("SELECT id, nom, vu_le, dernier_signal FROM cabines WHERE campagne_id = ? ORDER BY nom")
      .bind(c.id).all<{ id: string; nom: string; vu_le: string | null; dernier_signal: string | null }>();
    const { questions } = await libellesParcours(ctx.env.DB, c.id);
    const titre = (etape: string) => questions.find((q) => q.id === etape)?.titre ?? etape;

    await journaliser(ctx.env.DB, id, { action: "analyse.consultation", cibleType: "campagne", cibleId: c.id, clientId: c.client_id, details: { vue: "direct" } });
    return json({
      jour: aujourdhui,
      visiteurs: { aujourdhui: duJour.length, derniere_heure: derniereHeure, par_heure: [...parHeure.entries()].sort((a, b) => a[0] - b[0]).map(([heure, n]) => ({ heure, n })) },
      derniers_propos: recents.map((x) => ({
        reponse_id: x.reponse_id, cree_le: x.cree_le, prenom: x.prenom, question: titre(x.etape_id),
        texte: x.transcription ? x.transcription.slice(0, 240) : null,
        etat: x.transcription_etat === "faite" ? (x.analyse_etat === "faite" ? "classe" : "transcrit") : "en_cours",
        alerte: Boolean(x.alerte), autre_sujet: x.autre_sujet,
        themes: themesRecents.filter((t) => t.reponse_id === x.reponse_id).map((t) => ({ id: t.theme_id, libelle: grille.find((g) => g.id === t.theme_id)?.libelle ?? t.theme_id, tonalite: t.tonalite })),
      })),
      sujets_qui_montent: montants,
      alertes: alertesUtiles.map((a) => ({ ...a, question: titre(a.etape_id), recontact: Boolean(a.recontact) })),
      cabines: cabines.map((cb) => ({ id: cb.id, nom: cb.nom, vu_le: cb.vu_le, signal: cb.dernier_signal ? JSON.parse(cb.dernier_signal) as unknown : null })),
    });
  });

  // Alerte prise en compte (par la marque ou WhyMe). Journalisé.
  r.post("/api/espace/reponses/:id/alerte-vue", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "reponses.lire");
    const rep = await ctx.env.DB.prepare(
      `SELECT r.id, r.alerte, r.alerte_vue_le, s.retiree_le, c.client_id, c.id AS campagne_id
         FROM reponses r JOIN sessions s ON s.id = r.session_id JOIN campagnes c ON c.id = s.campagne_id WHERE r.id = ?`,
    ).bind(ctx.params.id).first<{ id: string; alerte: number; alerte_vue_le: string | null; retiree_le: string | null; client_id: string; campagne_id: string }>();
    if (!rep) throw introuvable("Réponse introuvable");
    verifierAppartenance(id, rep.client_id);
    if (rep.retiree_le) throw new HttpError(410, "retiree", "Cette réponse n'est plus disponible");
    if (!rep.alerte) throw conflit("Cette réponse n'est pas une alerte");
    if (rep.alerte_vue_le) return json({ alerte: { vue_le: rep.alerte_vue_le } });
    const now = maintenant();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE reponses SET alerte_vue_le = ?, alerte_vue_par = ? WHERE id = ? AND alerte_vue_le IS NULL").bind(now, id.email, rep.id),
      ligneJournal(ctx.env.DB, id, { action: "reponse.alerte_vue", cibleType: "reponse", cibleId: rep.id, clientId: rep.client_id, details: { campagne_id: rep.campagne_id } }),
    ]);
    return json({ alerte: { vue_le: now, vue_par: id.email } });
  });
}
