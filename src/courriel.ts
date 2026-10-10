// Envoi d'e-mails transactionnels (lien d'accès du visiteur). Aucune dépendance : l'API HTTP de Brevo (société
// française, données hébergées dans l'UE) est appelée directement. Sans clé configurée :
// - en développement, le message est gardé dans une boîte d'essai (lue par les tests) et affiché dans la console ;
// - ailleurs, l'envoi est refusé (503) plutôt que perdu en silence.

import type { Env } from "./types.ts";
import { HttpError } from "./http.ts";

export interface Courriel { a: string; sujet: string; texte: string; html: string }

/** Messages « envoyés » en développement, pour les tests. */
export const boiteEssai: Courriel[] = [];

export const courrielConfigure = (env: Env) => Boolean(env.BREVO_CLE) || env.AUTH_MODE === "dev";

export async function envoyerCourriel(env: Env, c: Courriel): Promise<void> {
  if (env.BREVO_CLE) {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_CLE, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: "Parlopop by whyme", email: env.COURRIEL_EXPEDITEUR ?? "parlopop@whyme.jobs" },
        to: [{ email: c.a }],
        subject: c.sujet,
        textContent: c.texte,
        htmlContent: c.html,
      }),
    });
    if (!res.ok) throw new HttpError(502, "courriel_echec", "L'e-mail n'a pas pu être envoyé, réessayez dans un instant");
    return;
  }
  if (env.AUTH_MODE === "dev") {
    boiteEssai.push(c);
    console.log(`[courriel d'essai] à ${c.a} : ${c.sujet}\n${c.texte}`);
    return;
  }
  throw new HttpError(503, "courriel_indisponible", "L'envoi d'e-mails n'est pas encore configuré");
}
