// Lien de retrait : la page publique /retrait/#<code> (QR code de l'écran de fin) permet au visiteur de retirer
// lui-même son accord, total ou seulement pour la diffusion. Le code est le seul secret : 32^10 combinaisons.
// ⚠ /retrait et /api/retrait doivent être exclus de Cloudflare Access (comme la cabine).

import type { Routeur } from "../routeur.ts";
import { introuvable, invalide, json, lireJson } from "../http.ts";
import { CODE_RETRAIT } from "./cabine.ts";
import { retirerAccord, retirerDiffusion, sessionPour } from "../rgpd/retrait.ts";

const VISITEUR = "visiteur (lien de retrait)";

export function routesRetrait(r: Routeur): void {
  r.get("/api/retrait/:code", async (ctx) => {
    const code = (ctx.params.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!CODE_RETRAIT.test(code)) throw introuvable("Code inconnu");
    const s = await ctx.env.DB.prepare(
      `SELECT s.prenom, s.cree_le, s.consent_diffusion, s.retiree_le, ca.nom AS campagne, cl.nom AS marque, cl.contact_rgpd, cl.logo_url, cl.couleurs
         FROM sessions s JOIN campagnes ca ON ca.id = s.campagne_id JOIN clients cl ON cl.id = ca.client_id
        WHERE s.code_retrait = ?`,
    ).bind(code).first<{ prenom: string; cree_le: string; consent_diffusion: number; retiree_le: string | null; campagne: string; marque: string; contact_rgpd: string; logo_url: string | null; couleurs: string }>();
    if (!s) throw introuvable("Code inconnu");
    return json({
      marque: s.marque, campagne: s.campagne, contact_rgpd: s.contact_rgpd, logo_url: s.logo_url, couleurs: JSON.parse(s.couleurs) as unknown,
      date: s.cree_le, prenom: s.retiree_le ? null : s.prenom, retiree_le: s.retiree_le, diffusion: Boolean(s.consent_diffusion),
    });
  });

  r.post("/api/retrait/:code", async (ctx) => {
    const code = (ctx.params.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!CODE_RETRAIT.test(code)) throw introuvable("Code inconnu");
    const d = await lireJson(ctx.request);
    if (d.portee !== "tout" && d.portee !== "diffusion") throw invalide("portee : « tout » ou « diffusion »");
    const s = await sessionPour(ctx.env.DB, "code_retrait", code);
    if (!s) throw introuvable("Code inconnu");
    if (d.portee === "diffusion") {
      await retirerDiffusion(ctx.env, VISITEUR, s, "visiteur");
      return json({ retrait: "diffusion" });
    }
    await retirerAccord(ctx.env, VISITEUR, s, "visiteur");
    return json({ retrait: "tout" });
  });
}
