// Point d'entrée du Worker Parlopop.
// - /api/*  : API JSON (routes/…)
// - le reste : fichiers statiques du dossier public/ (pages admin, espace client, cabine)

import type { Env, ExecutionContext } from "./types.ts";
import { Routeur } from "./routeur.ts";
import { erreur, json } from "./http.ts";
import { routesAdmin } from "./routes/admin.ts";
import { routesEspace } from "./routes/espace.ts";
import { routesCabine } from "./routes/cabine.ts";
import { routesReponses } from "./routes/reponses.ts";
import { routesParlomix } from "./routes/parlomix.ts";
import { routesRetrait } from "./routes/retrait.ts";
import { routesAcces } from "./routes/acces.ts";
import { routesWhymeCandidat } from "./whyme/candidat.ts";
import { routesWhymeMontage } from "./whyme/montage.ts";
import { routesWhymePublic } from "./whyme/public.ts";
import { routesWhymeRecruteur } from "./whyme/recruteur.ts";
import { routesWhymeAdmin } from "./whyme/admin.ts";
import { tachesWhyme } from "./whyme/taches.ts";
import { reprendreTranscriptions } from "./analyse/transcription.ts";

export const VERSION = "0.1.0";

/**
 * Parlorama est une page sans compilation : un onglet resté ouvert pendant un déploiement garde l'ancien code.
 * Chaque réponse de l'API annonce la version déployée (en-tête ci-dessous) ; Parlorama renvoie celle qu'il a
 * chargée, et une modification venant d'une version périmée est refusée (409) plutôt que mal interprétée
 * (ex. un ancien éditeur qui ne connaît pas l'habillage d'un parcours).
 */
export const EN_TETE_VERSION = "x-parlorama-version";
const versionDeploiement = (env: Env): string | null => env.VERSION_DEPLOIEMENT?.id ?? null;

export function construireRouteur(): Routeur {
  const r = new Routeur();

  // Santé : publique, ne révèle rien d'autre que l'état du service.
  r.get("/api/sante", async (ctx) => {
    let base = "ok";
    try {
      await ctx.env.DB.prepare("SELECT 1").first();
    } catch {
      base = "indisponible";
    }
    return json({ service: "voxbox", version: VERSION, deploiement: versionDeploiement(ctx.env), environnement: ctx.env.ENVIRONNEMENT, base }, base === "ok" ? 200 : 503);
  });

  routesEspace(r);
  routesAdmin(r);
  routesCabine(r);
  routesReponses(r);
  routesParlomix(r);
  routesRetrait(r);
  routesAcces(r);
  routesWhymeCandidat(r);
  routesWhymeMontage(r);
  routesWhymePublic(r);
  routesWhymeRecruteur(r);
  routesWhymeAdmin(r);
  return r;
}

const routeur = construireRouteur();

export async function traiter(request: Request, env: Env, execution?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) {
    // Why me : /i/<code> (QR code de la campagne) et /v/<code> (page vidéo du candidat) sont des pages fixes.
    const page = /^\/i\/[a-z0-9-]{1,40}\/?$/.test(url.pathname) ? "/whyme/candidat/" : /^\/v\/[A-Z0-9]{10}\/?$/.test(url.pathname) ? "/whyme/video/" : null;
    if (page && env.ASSETS) return env.ASSETS.fetch(new Request(new URL(page, url), request));
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Introuvable", { status: 404 });
  }
  const reponse = await repondre(request, env, url, execution);
  const version = versionDeploiement(env);
  if (version) reponse.headers.set(EN_TETE_VERSION, version);
  return reponse;
}

async function repondre(request: Request, env: Env, url: URL, execution?: ExecutionContext): Promise<Response> {
  const trouve = routeur.trouver(request.method, url.pathname);
  if (trouve === null) return json({ erreur: "introuvable", message: "Route inconnue" }, 404);
  if (trouve === "methode") return json({ erreur: "methode", message: "Méthode non permise" }, 405);
  // Modification envoyée par un Parlorama chargé avant le dernier déploiement : refusée, il faut recharger la page.
  const versionPage = request.headers.get(EN_TETE_VERSION);
  const version = versionDeploiement(env);
  if (request.method !== "GET" && versionPage && version && versionPage !== version && /^\/api\/(admin|espace)\//.test(url.pathname)) {
    return json({ erreur: "parlorama_perime", message: "Une nouvelle version de Parlorama est en ligne : rechargez la page avant de continuer." }, 409);
  }
  try {
    return await trouve.gestionnaire({ request, env, params: trouve.params, url, execution });
  } catch (e) {
    return erreur(e);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return traiter(request, env, ctx);
  },
  // Tâches planifiées (toutes les 5 minutes, voir wrangler.jsonc) : montages, reprises et purges de Why me ;
  // reprise des transcriptions de l'option Analyse de Parlopop. Indépendantes : l'échec de l'une n'arrête pas l'autre.
  async scheduled(_evenement: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tachesWhyme(env).then((b) => console.log("Why me, tâches planifiées", b)));
    ctx.waitUntil(reprendreTranscriptions(env).then((bilan) => {
      if (bilan.traitees) console.log("Parlopop, reprise des transcriptions", JSON.stringify(bilan));
    }));
  },
};
