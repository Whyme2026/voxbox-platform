// Serveur local pour les essais de bout en bout : la vraie application (traiter), une base SQLite
// qui rejoue les migrations, un stockage vidéo en mémoire qui garde les octets, les fichiers de public/.
// Lancement : node test/e2e/serveur.ts <port>  → affiche en JSON le code d'appairage de la cabine de test.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { readFileSync } from "node:fs";
import { traiter } from "../../src/index.ts";
import type { Env, R2Bucket } from "../../src/types.ts";
import { creerD1 } from "../aide/d1-local.ts";

const PUBLIC = join(import.meta.dirname, "../../public");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff": "font/woff", ".webm": "video/webm",
};

export const objets = new Map<string, Uint8Array>();
const media: R2Bucket = {
  async put(key, value) {
    const octets = value instanceof ArrayBuffer ? new Uint8Array(value) : new TextEncoder().encode(String(value));
    objets.set(key, octets);
    return { key, size: octets.byteLength };
  },
  async get(key) {
    const o = objets.get(key);
    return o ? { key, size: o.byteLength, body: new Response(o).body ?? undefined, httpMetadata: { contentType: key.endsWith(".mp4") ? "video/mp4" : "video/webm" } } : null;
  },
  async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) objets.delete(k); },
};

const ADMIN = "admin@whyme.test";
const db = creerD1();
const env: Env = {
  DB: db, MEDIA: media, ENVIRONNEMENT: "dev", AUTH_MODE: "dev", ADMIN_EMAILS: ADMIN,
  ASSETS: {
    async fetch(req: Request) {
      let chemin = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^(\.\.[/\\])+/, "");
      let fichier = join(PUBLIC, chemin);
      try { if ((await stat(fichier)).isDirectory()) fichier = join(fichier, "index.html"); } catch { /* introuvable */ }
      try {
        return new Response(await readFile(fichier), { headers: { "content-type": TYPES[extname(fichier)] ?? "application/octet-stream" } });
      } catch {
        return new Response("Introuvable", { status: 404 });
      }
    },
  },
};

async function appel(methode: string, chemin: string, corps?: unknown) {
  const r = await traiter(new Request(`http://localhost${chemin}`, {
    method: methode, headers: { "x-dev-email": ADMIN, "content-type": "application/json" }, body: corps ? JSON.stringify(corps) : undefined,
  }), env);
  return (await r.json()) as any;
}

/** Client, campagne active avec le parcours fourni, cabine affectée. Renvoie le code d'appairage. */
export async function preparer(parcours: unknown, client: { nom: string; couleurs?: Record<string, string> } = { nom: "Parlopop" }, nomCampagne = "Essai") {
  const cl = await appel("POST", "/api/admin/clients", { nom: client.nom, raison_sociale: `${client.nom} (démo)`, contact_rgpd: "rgpd@demo.test", couleurs: client.couleurs });
  const cp = await appel("POST", "/api/admin/campagnes", { client_id: cl.client.id, nom: nomCampagne, debut: "2026-10-01", fin: "2026-12-31" });
  const id = cp.campagne.id;
  await appel("POST", `/api/admin/campagnes/${id}/parcours`, { config: parcours });
  await appel("POST", `/api/admin/campagnes/${id}/consentement`, {});
  await appel("POST", `/api/admin/campagnes/${id}/statut`, { statut: "validee" });
  await appel("POST", `/api/admin/campagnes/${id}/statut`, { statut: "active" });
  const cab = await appel("POST", "/api/admin/cabines", { nom: "Tablette démo 1" });
  await appel("PATCH", `/api/admin/cabines/${cab.cabine.id}`, { campagne_id: id });
  return { code: cab.cabine.code_appairage as string, campagneId: id as string };
}

export function demarrerServeur(port: number) {
  const serveur = createServer(async (req, res) => {
    const morceaux: Buffer[] = [];
    for await (const m of req) morceaux.push(m as Buffer);
    const corps = morceaux.length ? Buffer.concat(morceaux) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const reponse = await traiter(new Request(`http://localhost:${port}${req.url}`, {
      method: req.method, headers, body: corps && req.method !== "GET" && req.method !== "HEAD" ? corps : undefined,
    }), env);
    res.writeHead(reponse.status, Object.fromEntries(reponse.headers));
    res.end(Buffer.from(await reponse.arrayBuffer()));
  });
  return new Promise<typeof serveur>((ok) => serveur.listen(port, "127.0.0.1", () => ok(serveur)));
}

export { db };

// Lancement direct (essais manuels).
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const port = Number(process.argv[2] ?? 8787);
  const parcours = JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/parcours-demo.json"), "utf8"));
  await demarrerServeur(port);
  console.log(JSON.stringify({ url: `http://localhost:${port}/cabine/`, admin: `http://localhost:${port}/admin/`, ...(await preparer(parcours, { nom: "Parlopop" }, "Démo Parlopop (neutre)")) }));
}
