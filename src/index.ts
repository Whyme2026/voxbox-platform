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

export const VERSION = "0.1.0";

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
    return json({ service: "voxbox", version: VERSION, environnement: ctx.env.ENVIRONNEMENT, base }, base === "ok" ? 200 : 503);
  });

  routesEspace(r);
  routesAdmin(r);
  routesCabine(r);
  routesReponses(r);
  routesParlomix(r);
  routesRetrait(r);
  return r;
}

const routeur = construireRouteur();

export async function traiter(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) {
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Introuvable", { status: 404 });
  }
  const trouve = routeur.trouver(request.method, url.pathname);
  if (trouve === null) return json({ erreur: "introuvable", message: "Route inconnue" }, 404);
  if (trouve === "methode") return json({ erreur: "methode", message: "Méthode non permise" }, 405);
  try {
    return await trouve.gestionnaire({ request, env, params: trouve.params, url });
  } catch (e) {
    return erreur(e);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return traiter(request, env);
  },
};
