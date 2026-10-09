// Routeur minimal : méthode + motif de chemin avec paramètres (:id).

import type { Env } from "./types.ts";

export interface Contexte {
  request: Request;
  env: Env;
  params: Record<string, string>;
  url: URL;
}

export type Gestionnaire = (ctx: Contexte) => Promise<Response>;

interface Route { methode: string; motif: RegExp; noms: string[]; gestionnaire: Gestionnaire }

export class Routeur {
  private routes: Route[] = [];

  ajouter(methode: string, chemin: string, gestionnaire: Gestionnaire): this {
    const noms: string[] = [];
    const source = chemin.replace(/:([a-zA-Z_]+)/g, (_, nom: string) => {
      noms.push(nom);
      return "([^/]+)";
    });
    this.routes.push({ methode, motif: new RegExp(`^${source}/?$`), noms, gestionnaire });
    return this;
  }

  get(chemin: string, g: Gestionnaire) { return this.ajouter("GET", chemin, g); }
  post(chemin: string, g: Gestionnaire) { return this.ajouter("POST", chemin, g); }
  patch(chemin: string, g: Gestionnaire) { return this.ajouter("PATCH", chemin, g); }

  /** Renvoie le gestionnaire et ses paramètres, « methode » si le chemin existe sous une autre méthode, ou null. */
  trouver(methode: string, chemin: string): { gestionnaire: Gestionnaire; params: Record<string, string> } | "methode" | null {
    let cheminConnu = false;
    for (const r of this.routes) {
      const m = r.motif.exec(chemin);
      if (!m) continue;
      cheminConnu = true;
      if (r.methode !== methode) continue;
      const params: Record<string, string> = {};
      r.noms.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1] ?? ""); });
      return { gestionnaire: r.gestionnaire, params };
    }
    return cheminConnu ? "methode" : null;
  }
}
