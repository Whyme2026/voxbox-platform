// Parlorama ouvert pendant un déploiement : la version déployée est annoncée, et une modification envoyée par
// une page périmée est refusée plutôt que mal interprétée.
import { test } from "node:test";
import assert from "node:assert/strict";
import { traiter } from "../src/index.ts";
import { ADMIN, creerEnv } from "./aide/env.ts";

const env = () => creerEnv({ VERSION_DEPLOIEMENT: { id: "v2" } }).env;
const appel = (e: ReturnType<typeof env>, methode: string, chemin: string, entetes: Record<string, string> = {}, corps?: unknown) =>
  traiter(new Request(`http://localhost${chemin}`, {
    method: methode, headers: { "x-dev-email": ADMIN, "content-type": "application/json", ...entetes }, body: corps === undefined ? undefined : JSON.stringify(corps),
  }), e);
const valider = { config: { version: 1, langue: "fr", etapes: [] } };

test("chaque réponse de l'API annonce la version déployée", async () => {
  const e = env();
  const r = await appel(e, "GET", "/api/sante");
  assert.equal(r.headers.get("x-parlorama-version"), "v2");
  assert.equal(((await r.json()) as any).deploiement, "v2");
});

test("une modification envoyée par un Parlorama périmé est refusée (409), la lecture reste permise", async () => {
  const e = env();
  const perime = await appel(e, "POST", "/api/admin/parcours/valider", { "x-parlorama-version": "v1" }, valider);
  assert.equal(perime.status, 409);
  assert.equal(((await perime.json()) as any).erreur, "parlorama_perime");
  assert.equal((await appel(e, "POST", "/api/admin/parcours/valider", { "x-parlorama-version": "v2" }, valider)).status, 200);
  assert.equal((await appel(e, "POST", "/api/admin/parcours/valider", {}, valider)).status, 200, "sans en-tête (scripts) : accepté");
  assert.equal((await appel(e, "GET", "/api/admin/campagnes", { "x-parlorama-version": "v1" })).status, 200);
});

test("sans version connue (développement local), rien n'est vérifié", async () => {
  const { env: e } = creerEnv();
  const r = await appel(e, "POST", "/api/admin/parcours/valider", { "x-parlorama-version": "v1" }, valider);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-parlorama-version"), null);
});
