// Service de montage Why me : petit serveur HTTP sans dépendance, qui tourne dans un conteneur Cloudflare en
// juridiction UE (montage/worker.ts) ou sur un serveur en Europe.
//   POST /monter { id, api }   (en-tête x-montage-cle) → 202, le montage part en file
//   GET  /sante                 → état du service
// Pour chaque interview : plan et prises lus sur la plateforme (/api/montage/*), montage ffmpeg, miniature puis
// film renvoyés à la plateforme. En cas d'échec, la plateforme est prévenue (/api/montage/echec).
// Variables : MONTAGE_CLE (secret partagé), MONTAGE_API_AUTORISEES (origines acceptées, séparées par des virgules),
// PORT (8080 par défaut).

import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monter, type PlanMontage } from "./monter.ts";

const CLE = process.env.MONTAGE_CLE ?? "";
const AUTORISEES = (process.env.MONTAGE_API_AUTORISEES ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const file: { id: string; api: string }[] = [];
let enCours: string | null = null;
let faits = 0;

function egal(a: string, b: string): boolean {
  if (a.length !== b.length || !a.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function appeler(api: string, chemin: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${api}${chemin}`, { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), "x-montage-cle": CLE } });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${chemin} : ${res.status} ${await res.text().catch(() => "")}`);
  return res;
}

export async function traiterTravail(id: string, api: string): Promise<void> {
  const dossier = await mkdtemp(join(tmpdir(), "whyme-prises-"));
  try {
    const plan = (await (await appeler(api, `/api/montage/travaux/${id}`)).json()) as PlanMontage;
    const sources: string[] = [];
    for (const q of plan.questions) {
      const octets = new Uint8Array(await (await appeler(api, `/api/montage/prises/${id}/${q.id}`)).arrayBuffer());
      const f = join(dossier, `${q.id}.${q.type === "video/mp4" ? "mp4" : "webm"}`);
      await writeFile(f, octets);
      sources.push(f);
    }
    const r = await monter(plan, sources);
    await appeler(api, `/api/montage/miniature/${id}`, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: r.miniature });
    await appeler(api, `/api/montage/resultat/${id}`, { method: "PUT", headers: { "content-type": "video/mp4", "x-duree-ms": String(r.dureeMs) }, body: r.mp4 });
    faits++;
    console.log(`Montage ${id} : ${Math.round(r.mp4.byteLength / 1e5) / 10} Mo, ${Math.round(r.dureeMs / 1000)} s`);
  } catch (e) {
    console.error(`Montage ${id} : échec`, e);
    await appeler(api, `/api/montage/echec/${id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: String((e as Error).message ?? e).slice(0, 400) }),
    }).catch(() => {});
  } finally {
    await rm(dossier, { recursive: true, force: true });
  }
}

async function vider(): Promise<void> {
  if (enCours) return;
  while (file.length) {
    const t = file.shift()!;
    enCours = t.id;
    await traiterTravail(t.id, t.api);
    enCours = null;
  }
}

export function demarrerService(port: number) {
  if (!CLE) throw new Error("MONTAGE_CLE manquant");
  const serveur = createServer(async (req, res) => {
    const repondre = (status: number, corps: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(corps)); };
    if (req.method === "GET" && (req.url === "/sante" || req.url === "/health")) return repondre(200, { service: "montage whyme", enCours, attente: file.length, faits });
    if (req.method !== "POST" || req.url !== "/monter") return repondre(404, { erreur: "introuvable" });
    if (!egal(String(req.headers["x-montage-cle"] ?? ""), CLE)) return repondre(401, { erreur: "non_authentifie" });
    let corps = "";
    for await (const m of req) corps += m;
    let d: { id?: unknown; api?: unknown };
    try { d = JSON.parse(corps); } catch { return repondre(400, { erreur: "json" }); }
    const id = typeof d.id === "string" && /^[0-9a-f-]{36}$/.test(d.id) ? d.id : null;
    const api = typeof d.api === "string" ? d.api.replace(/\/$/, "") : "";
    // Le secret n'est envoyé qu'aux plateformes connues (jamais à une adresse fournie par la requête seule).
    if (!id || !/^https?:\/\//.test(api) || (AUTORISEES.length && !AUTORISEES.includes(api))) return repondre(400, { erreur: "invalide" });
    if (!file.some((t) => t.id === id) && enCours !== id) file.push({ id, api });
    repondre(202, { file: file.length });
    void vider();
  });
  return new Promise<typeof serveur>((ok) => serveur.listen(port, "0.0.0.0", () => ok(serveur)));
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8080);
  await demarrerService(port);
  console.log(`Service de montage Why me sur le port ${port}`);
}
