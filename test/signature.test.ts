// Signature « parlobox by whyme » en haut à droite de la cabine (14/10/2026) : texte seul, « me » en fuchsia.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cabine = join(import.meta.dirname, "../public/cabine");
const html = readFileSync(join(cabine, "index.html"), "utf8");
const css = readFileSync(join(cabine, "cabine.css"), "utf8");

test("signature : « parlobox by whyme » en texte seul, « me » isolé pour le fuchsia", () => {
  const debut = html.indexOf('id="signature"');
  assert.ok(debut > 0, "signature présente");
  const bloc = html.slice(debut, html.indexOf("</header>", debut));
  assert.ok(bloc.includes(">parlobox<"), "parlobox en minuscules");
  assert.ok(bloc.includes('why<span class="signature-me">me</span>'), "« me » dans son propre élément");
  assert.ok(!bloc.includes("<svg"), "plus de pictogramme bulle");
});

test("signature : fuchsia #C4007A sur fond clair, #FF6FAE sur fond sombre", () => {
  assert.match(css, /\.signature \{ --fuchsia-whyme: #C4007A;/);
  assert.match(css, /\.signature-me \{ color: var\(--fuchsia-whyme\); \}/);
  assert.match(css, /\.cabine\[data-fond-sombre\] \.signature \{ color: #FFFFFF; --fuchsia-whyme: #FF6FAE; \}/);
});
