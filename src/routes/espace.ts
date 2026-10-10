// API de l'espace client (et commune) : identité, campagnes du client, validation.
// Un compte client ne voit que son propre client : le périmètre vient de son compte, jamais de la requête.

import type { Routeur } from "../routeur.ts";
import { identifier } from "../auth/identite.ts";
import { exiger, peut, perimetreClient, type Action } from "../auth/droits.ts";
import { json } from "../http.ts";
import { changerStatut, chargerCampagne, detailCampagne } from "./campagnes-commun.ts";

const ACTIONS: Action[] = [
  "clients.gerer", "utilisateurs.gerer", "campagnes.gerer", "campagnes.lire",
  "campagnes.valider", "cabines.gerer", "reponses.lire", "visiteurs.gerer", "journal.lire",
];

export function routesEspace(r: Routeur): void {
  r.get("/api/moi", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    const client = id.clientId
      ? await ctx.env.DB.prepare("SELECT id, nom, logo_url, couleurs FROM clients WHERE id = ?").bind(id.clientId).first()
      : null;
    return json({
      email: id.email,
      role: id.role,
      client,
      droits: ACTIONS.filter((a) => peut(id, a)),
      environnement: ctx.env.ENVIRONNEMENT,
    });
  });

  r.get("/api/espace/campagnes", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "campagnes.lire");
    const client = perimetreClient(id, ctx.url.searchParams.get("client"));
    const sql = "SELECT id, client_id, nom, debut, fin, statut, validee_par, validee_le, maj_le FROM campagnes"
      + (client ? " WHERE client_id = ?" : "") + " ORDER BY cree_le DESC";
    const st = ctx.env.DB.prepare(sql);
    const { results } = await (client ? st.bind(client) : st).all();
    return json({ campagnes: results });
  });

  r.get("/api/espace/campagnes/:id", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "campagnes.lire");
    const c = await chargerCampagne(ctx.env.DB, id, ctx.params.id!);
    return json({ campagne: await detailCampagne(ctx.env.DB, c) });
  });

  // Le validateur du client approuve questions et textes : la campagne peut alors être activée par WhyMe.
  r.post("/api/espace/campagnes/:id/valider", async (ctx) => {
    const id = await identifier(ctx.request, ctx.env);
    exiger(id, "campagnes.valider");
    const c = await chargerCampagne(ctx.env.DB, id, ctx.params.id!);
    await changerStatut(ctx.env.DB, id, c, "validee");
    return json({ campagne: { ...c, statut: "validee", validee_par: id.email } });
  });
}
