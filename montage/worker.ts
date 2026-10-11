// Worker « voxbox-montage » : point d'entrée du service de montage hébergé dans Cloudflare Containers
// (juridiction UE, voir wrangler.jsonc). La plateforme appelle POST /monter avec le secret partagé ; ce Worker
// garde la demande et la confie au conteneur (une seule instance, nommée « montage »).
// Déployé à part de la plateforme (Workers Builds, dossier montage/ ; offre Workers payante).

import { DurableObject } from "cloudflare:workers";
import { ENTETE_SIGNATURE, empreinteCourte, signer, verifierSignature } from "./signature.ts";

interface Env {
  MONTAGE: DurableObjectNamespace;
  MONTAGE_CLE: string;
  MONTAGE_API_AUTORISEES: string;
}

const PORT = 8080;
type Travail = { id: string; api: string };

/**
 * Le Durable Object reçoit les demandes, les garde dans son stockage (elles survivent à un redémarrage) et répond
 * tout de suite ; c'est son alarme qui démarre le conteneur (premier démarrage : jusqu'à 1 min 30), lui confie
 * les montages et reste active jusqu'à ce qu'ils soient finis. La plateforme n'attend donc jamais le conteneur.
 */
export class ConteneurMontage extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const file = (await this.ctx.storage.get<Travail[]>("file")) ?? [];
    if (url.pathname === "/monter") {
      const d = (await request.json().catch(() => null)) as { id?: unknown; api?: unknown } | null;
      const id = typeof d?.id === "string" && /^[0-9a-f-]{36}$/.test(d.id) ? d.id : null;
      const api = typeof d?.api === "string" ? d.api.replace(/\/$/, "") : "";
      const autorisees = this.env.MONTAGE_API_AUTORISEES.split(",").map((a) => a.trim().replace(/\/$/, "")).filter(Boolean);
      if (!id || !autorisees.includes(api)) return Response.json({ erreur: "invalide" }, { status: 400 });
      if (!file.some((t) => t.id === id)) file.push({ id, api });
      await this.ctx.storage.put("file", file);
      await this.ctx.storage.setAlarm(Date.now());
      return Response.json({ file: file.length }, { status: 202 });
    }
    // /sante : état du conteneur s'il tourne, sinon la file gardée ici.
    const conteneur = this.ctx.container!;
    const etat = { service: "montage whyme", conteneur: conteneur.running ? "démarré" : "arrêté", aTransmettre: file.length,
      derniereErreur: (await this.ctx.storage.get<string>("erreur")) ?? null, empreinteCle: await empreinteCourte(this.env.MONTAGE_CLE) };
    if (conteneur.running) {
      try {
        const r = await conteneur.getTcpPort(PORT).fetch("http://conteneur/sante");
        if (r.ok) return Response.json({ ...etat, ...(await r.json() as object) });
      } catch { /* conteneur en cours de démarrage */ }
    }
    return Response.json(etat);
  }

  async alarm(): Promise<void> {
    const file = (await this.ctx.storage.get<Travail[]>("file")) ?? [];
    if (!file.length) return;
    const conteneur = this.ctx.container!;
    try {
      // Le conteneur garde le secret reçu à son démarrage : si le secret a changé (ajout, rotation), on le redémarre.
      const empreinte = await empreinteCle(this.env.MONTAGE_CLE);
      if (conteneur.running && (await this.ctx.storage.get<string>("cle")) !== empreinte) {
        await conteneur.destroy().catch(() => {});
        for (let i = 0; i < 50 && conteneur.running; i++) await attendre(200);
      }
      if (!conteneur.running) {
        await this.ctx.storage.put("cle", empreinte);
        conteneur.start({
          env: { MONTAGE_CLE: this.env.MONTAGE_CLE, MONTAGE_API_AUTORISEES: this.env.MONTAGE_API_AUTORISEES, PORT: String(PORT) },
          enableInternet: true, // le service lit et renvoie les vidéos à la plateforme
        });
      }
      const port = conteneur.getTcpPort(PORT);
      let pret = false;
      let derniere = "";
      for (let essai = 0; essai < 180 && !pret; essai++) {
        try { pret = (await port.fetch("http://conteneur/sante")).ok; } catch (e) { derniere = String((e as Error).message ?? e); }
        if (!pret) await attendre(500);
      }
      if (!pret) throw new Error(`le conteneur ne répond pas (${derniere})`);
      const reste: Travail[] = [];
      for (const t of file) {
        const r = await port.fetch(new Request("http://conteneur/monter", {
          method: "POST",
          headers: { "content-type": "application/json", [ENTETE_SIGNATURE]: await signer(this.env.MONTAGE_CLE, "POST", "/monter") },
          body: JSON.stringify(t),
        }));
        if (r.status !== 202) { reste.push(t); derniere = `conteneur : ${r.status} ${await r.text()}`; }
      }
      await this.ctx.storage.put("file", reste);
      if (reste.length) throw new Error(derniere);
      await this.ctx.storage.delete("erreur");
      // Le conteneur ne vit que tant que le Durable Object est actif : l'alarme attend donc la fin des montages
      // (14 minutes au plus ; au-delà, la plateforme redemande le montage, qui reprend depuis le début).
      const fin = Date.now() + 14 * 60_000;
      while (Date.now() < fin) {
        await attendre(3_000);
        const etat = (await (await port.fetch("http://conteneur/sante")).json()) as { enCours: string | null; attente: number };
        if (!etat.enCours && !etat.attente) break;
        const suivants = (await this.ctx.storage.get<Travail[]>("file")) ?? [];
        if (suivants.length) { await this.ctx.storage.setAlarm(Date.now()); break; } // nouvelles demandes : alarme suivante
      }
    } catch (e) {
      const message = String((e as Error).message ?? e).slice(0, 300);
      console.error("Montage : transmission au conteneur en échec", message);
      await this.ctx.storage.put("erreur", `${new Date().toISOString()} ${message}`);
      await this.ctx.storage.setAlarm(Date.now() + 60_000); // nouvel essai dans une minute
    }
  }
}

const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function empreinteCle(cle: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cle));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Sans secret (variable MONTAGE_CLE absente), le service refuse tout : jamais de montage ouvert à tous.
    if (!env.MONTAGE_CLE || env.MONTAGE_CLE.length < 32) return new Response("Service de montage non configuré (secret MONTAGE_CLE)", { status: 503 });
    const url = new URL(request.url);
    const monter = request.method === "POST" && url.pathname === "/monter";
    if (!monter && !(request.method === "GET" && url.pathname === "/sante")) return new Response("Introuvable", { status: 404 });
    if (monter && !(await verifierSignature(env.MONTAGE_CLE, "POST", "/monter", request.headers.get(ENTETE_SIGNATURE)))) return Response.json({ erreur: "non_authentifie" }, { status: 401 });
    // Une seule instance : les montages sont traités l'un après l'autre (un peu plus de 10 s par interview).
    const instance = env.MONTAGE.get(env.MONTAGE.idFromName("montage"));
    return instance.fetch(request);
  },
};
