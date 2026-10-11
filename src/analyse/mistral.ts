// Client minimal de l'API de transcription de Mistral AI (Voxtral), par HTTP, sans dépendance.
// Choix du 11/10/2026 : Mistral, seul sous-traitant de l'option Analyse, point d'accès européen (par défaut),
// formule payante à l'usage du compte WhyMe (jamais l'offre gratuite « Experiment », dont les requêtes peuvent servir à l'entraînement).
//
// ⚠ À vérifier au premier appel réel (la documentation publique ne le précise pas) : acceptation du WebM/Opus de la
// cabine, forme exacte des champs multiples (timestamp_granularities, context_bias) et des segments renvoyés.
// La lecture de la réponse est tolérante (segments ou mots, start/end) pour absorber ces écarts.

export const URL_TRANSCRIPTION = "https://api.mistral.ai/v1/audio/transcriptions";
export const MODELE_TRANSCRIPTION = "voxtral-mini-latest";
const DELAI_MS = 60_000;

/** Un morceau de texte horodaté (secondes depuis le début de la réponse). */
export interface Segment { d: number; f: number; t: string }

export interface Transcription {
  texte: string;
  langue: string | null;
  segments: Segment[];
}

/** Erreur du service. « definitive » : inutile de réessayer (requête refusée, fichier illisible…). */
export class ErreurTranscription extends Error {
  readonly definitive: boolean;
  constructor(message: string, definitive: boolean) {
    super(message);
    this.definitive = definitive;
  }
}

export type Fetch = (input: Request | string, init?: RequestInit) => Promise<Response>;

const nombre = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** Lecture tolérante de la réponse JSON : { text, language, segments | words: [{ start, end, text | word }] }. */
export function lireReponse(corps: unknown): Transcription {
  if (!corps || typeof corps !== "object") throw new ErreurTranscription("Réponse illisible du service de transcription", false);
  const o = corps as Record<string, unknown>;
  const brut = Array.isArray(o.words) && o.words.length ? o.words : Array.isArray(o.segments) ? o.segments : [];
  const segments: Segment[] = [];
  for (const x of brut) {
    if (!x || typeof x !== "object") continue;
    const s = x as Record<string, unknown>;
    const t = typeof s.text === "string" ? s.text : typeof s.word === "string" ? s.word : "";
    const d = nombre(s.start);
    const f = nombre(s.end);
    if (!t.trim() || d === null || f === null) continue;
    segments.push({ d, f, t: t.trim() });
  }
  const texte = typeof o.text === "string" ? o.text.trim() : segments.map((s) => s.t).join(" ");
  return { texte, langue: typeof o.language === "string" ? o.language.slice(0, 12) : null, segments };
}

/**
 * Envoie l'audio d'une réponse (le fichier de la cabine tel quel) et renvoie le texte horodaté.
 * Pas de langue imposée : le service ne l'accepte pas avec l'horodatage ; il la détecte.
 */
export async function transcrire(opts: {
  cle: string;
  audio: ArrayBuffer;
  type: string;
  nomFichier: string;
  vocabulaire: string[];
  fetch?: Fetch;
}): Promise<Transcription> {
  const form = new FormData();
  form.append("model", MODELE_TRANSCRIPTION);
  form.append("file", new Blob([opts.audio], { type: opts.type }), opts.nomFichier);
  form.append("timestamp_granularities", "word");
  for (const terme of opts.vocabulaire.slice(0, 100)) form.append("context_bias", terme);

  const appel = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await appel(URL_TRANSCRIPTION, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.cle}`, accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(DELAI_MS),
    });
  } catch (e) {
    throw new ErreurTranscription(`Service de transcription injoignable : ${(e as Error).message}`, false);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    // 429 (trop de requêtes) et 5xx : on réessaiera ; 401/403 : clé ou compte à vérifier, on réessaiera aussi
    // (une clé corrigée doit permettre de reprendre). Autres 4xx : la requête elle-même est refusée.
    const passager = res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403;
    throw new ErreurTranscription(`Transcription refusée (${res.status}) ${detail}`.trim(), !passager);
  }
  return lireReponse(await res.json().catch(() => null));
}
