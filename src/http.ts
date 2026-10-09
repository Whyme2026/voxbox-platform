// Petits utilitaires HTTP partagés : réponses JSON, erreurs typées, lecture du corps.

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const nonAutorise = (msg = "Authentification requise") => new HttpError(401, "non_authentifie", msg);
export const interdit = (msg = "Accès refusé") => new HttpError(403, "interdit", msg);
export const introuvable = (msg = "Introuvable") => new HttpError(404, "introuvable", msg);
export const invalide = (msg: string) => new HttpError(400, "invalide", msg);
export const conflit = (msg: string) => new HttpError(409, "conflit", msg);

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function erreur(e: unknown): Response {
  if (e instanceof HttpError) return json({ erreur: e.code, message: e.message }, e.status);
  console.error("Erreur non gérée", e);
  return json({ erreur: "erreur_serveur", message: "Erreur interne" }, 500);
}

export async function lireJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw invalide("Le corps doit être en JSON");
  let data: unknown;
  try {
    data = await request.json();
  } catch {
    throw invalide("JSON illisible");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalide("Objet JSON attendu");
  return data as Record<string, unknown>;
}

/** Lecture d'un champ texte : obligatoire ou non, longueur bornée, espaces retirés. */
export function texte(data: Record<string, unknown>, cle: string, opts: { requis?: boolean; max?: number } = {}): string | undefined {
  const v = data[cle];
  if (v === undefined || v === null || v === "") {
    if (opts.requis) throw invalide(`Champ « ${cle} » obligatoire`);
    return undefined;
  }
  if (typeof v !== "string") throw invalide(`Champ « ${cle} » : texte attendu`);
  const t = v.trim();
  if (opts.requis && !t) throw invalide(`Champ « ${cle} » obligatoire`);
  if (t.length > (opts.max ?? 500)) throw invalide(`Champ « ${cle} » trop long`);
  return t;
}

export const maintenant = () => new Date().toISOString();
export const nouvelId = () => crypto.randomUUID();
