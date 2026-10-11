// Worker « voxbox-montage » : point d'entrée du service de montage hébergé dans Cloudflare Containers
// (juridiction UE, voir wrangler.jsonc). La plateforme appelle POST /monter avec le secret partagé ; ce Worker
// démarre le conteneur (une seule instance, nommée « montage ») et lui transmet la requête.
// Déployé à part de la plateforme : `npx wrangler deploy -c montage/wrangler.jsonc` (offre Workers payante).

import { DurableObject } from "cloudflare:workers";

interface Env {
  MONTAGE: DurableObjectNamespace;
  MONTAGE_CLE: string;
  MONTAGE_API_AUTORISEES: string;
}

const PORT = 8080;

export class ConteneurMontage extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const conteneur = this.ctx.container!;
    if (!conteneur.running) {
      conteneur.start({
        env: { MONTAGE_CLE: this.env.MONTAGE_CLE, MONTAGE_API_AUTORISEES: this.env.MONTAGE_API_AUTORISEES, PORT: String(PORT) },
        enableInternet: true, // le service lit et renvoie les vidéos à la plateforme
      });
    }
    const port = conteneur.getTcpPort(PORT);
    // start() rend la main avant que le serveur écoute : on attend qu'il réponde.
    for (let essai = 0; essai < 100; essai++) {
      try {
        const sante = await port.fetch("http://conteneur/sante");
        if (sante.ok) break;
      } catch { /* pas encore prêt */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const url = new URL(request.url);
    return port.fetch(new Request(`http://conteneur${url.pathname}`, request));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!["/monter", "/sante"].includes(url.pathname)) return new Response("Introuvable", { status: 404 });
    // Une seule instance : les montages sont traités l'un après l'autre (un peu plus de 10 s par interview).
    const instance = env.MONTAGE.get(env.MONTAGE.idFromName("montage"));
    return instance.fetch(request);
  },
};
