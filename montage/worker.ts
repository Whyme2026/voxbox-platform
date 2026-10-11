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
    // Le conteneur garde le secret reçu à son démarrage : si le secret a changé (ajout, rotation), on le redémarre.
    const empreinte = await empreinteCle(this.env.MONTAGE_CLE);
    if (conteneur.running && (await this.ctx.storage.get<string>("cle")) !== empreinte) {
      await conteneur.destroy();
      for (let i = 0; i < 50 && conteneur.running; i++) await new Promise((r) => setTimeout(r, 200));
    }
    if (!conteneur.running) {
      await this.ctx.storage.put("cle", empreinte);
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

async function empreinteCle(cle: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cle));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Sans secret (variable MONTAGE_CLE absente), le service refuse tout : jamais de montage ouvert à tous.
    if (!env.MONTAGE_CLE || env.MONTAGE_CLE.length < 32) return new Response("Service de montage non configuré (secret MONTAGE_CLE)", { status: 503 });
    const url = new URL(request.url);
    if (!["/monter", "/sante"].includes(url.pathname)) return new Response("Introuvable", { status: 404 });
    // Une seule instance : les montages sont traités l'un après l'autre (un peu plus de 10 s par interview).
    const instance = env.MONTAGE.get(env.MONTAGE.idFromName("montage"));
    return instance.fetch(request);
  },
};
