import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { verifierJetonAccess, viderCacheJwks, type ChargeurJwks } from "../src/auth/access-jwt.ts";

const EQUIPE = "https://whyme.cloudflareaccess.com";
const AUD = "aud-voxbox-test";

const paire = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const autrePaire = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const jwkPublique = (await crypto.subtle.exportKey("jwk", paire.publicKey)) as JsonWebKey;
const chargeur: ChargeurJwks = async () => ({ keys: [{ kid: "k1", kty: "RSA", n: jwkPublique.n!, e: jwkPublique.e! }] });

const b64url = (o: Uint8Array | string) =>
  Buffer.from(typeof o === "string" ? o : o).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function signer(charge: Record<string, unknown>, cle = paire.privateKey, kid = "k1"): Promise<string> {
  const h = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const p = b64url(JSON.stringify(charge));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cle, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

const maintenant = Math.floor(Date.now() / 1000);
const valide = { iss: EQUIPE, aud: [AUD], email: "Laurent@Exemple.fr", exp: maintenant + 300, iat: maintenant };
const opts = { teamDomain: EQUIPE, aud: AUD, chargeur };

beforeEach(() => viderCacheJwks());

test("un jeton valide renvoie l'e-mail en minuscules", async () => {
  assert.equal(await verifierJetonAccess(await signer(valide), opts), "laurent@exemple.fr");
});

test("un jeton expiré est refusé", async () => {
  assert.equal(await verifierJetonAccess(await signer({ ...valide, exp: maintenant - 3600 }), opts), null);
});

test("un jeton émis pour une autre application est refusé", async () => {
  assert.equal(await verifierJetonAccess(await signer({ ...valide, aud: ["autre"] }), opts), null);
});

test("un jeton d'un autre émetteur est refusé", async () => {
  assert.equal(await verifierJetonAccess(await signer({ ...valide, iss: "https://pirate.example" }), opts), null);
});

test("un jeton signé avec une autre clé est refusé", async () => {
  assert.equal(await verifierJetonAccess(await signer(valide, autrePaire.privateKey), opts), null);
});

test("un jeton modifié après signature est refusé", async () => {
  const j = await signer(valide);
  const [h, , s] = j.split(".");
  const faux = b64url(JSON.stringify({ ...valide, email: "admin@whyme.test" }));
  assert.equal(await verifierJetonAccess(`${h}.${faux}.${s}`, opts), null);
});

test("un jeton mal formé est refusé", async () => {
  assert.equal(await verifierJetonAccess("pas-un-jeton", opts), null);
  assert.equal(await verifierJetonAccess("a.b.c", opts), null);
});
