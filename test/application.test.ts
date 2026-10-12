// La cabine s'installe comme application plein écran (sans barre d'adresse) sur la tablette : manifeste, icônes,
// service worker, et lien du manifeste qui part avec le cookie Cloudflare Access (production).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const cabine = join(import.meta.dirname, "../public/cabine");
const manifeste = JSON.parse(readFileSync(join(cabine, "manifest.webmanifest"), "utf8"));

/** Largeur et hauteur d'un PNG, lues dans son en-tête. */
function taillePng(chemin: string) {
  const b = readFileSync(chemin);
  assert.equal(b.subarray(1, 4).toString(), "PNG", `${chemin} n'est pas un PNG`);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

test("le manifeste ouvre la cabine en plein écran, limitée à /cabine/", () => {
  assert.equal(manifeste.display, "fullscreen");
  assert.equal(manifeste.start_url, "/cabine/");
  assert.equal(manifeste.scope, "/cabine/");
  assert.equal(manifeste.name, "Parlobox");
  assert.equal(manifeste.orientation, undefined, "aucune orientation imposée : la cabine sert en 16:9 comme en 9:16");
});

test("les icônes déclarées existent à la bonne taille, dont une masquable de 512", () => {
  for (const icone of manifeste.icons) {
    const chemin = join(cabine, icone.src);
    assert.ok(existsSync(chemin), `icône absente : ${icone.src}`);
    assert.equal(taillePng(chemin), icone.sizes);
  }
  const tailles = manifeste.icons.map((i: any) => i.sizes);
  assert.ok(tailles.includes("192x192") && tailles.includes("512x512"));
  assert.ok(manifeste.icons.some((i: any) => i.purpose === "maskable"));
});

test("la page de la cabine déclare le manifeste avec le cookie, et enregistre le service worker", () => {
  const page = readFileSync(join(cabine, "index.html"), "utf8");
  assert.match(page, /<link rel="manifest" href="manifest\.webmanifest" crossorigin="use-credentials">/);
  const app = readFileSync(join(cabine, "js/app.js"), "utf8");
  assert.match(app, /serviceWorker\?\.register\("sw\.js"\)/);
  const sw = readFileSync(join(cabine, "sw.js"), "utf8");
  assert.doesNotMatch(sw, /caches\.|respondWith/, "le service worker ne met rien en cache et ne répond à aucune requête");
});
