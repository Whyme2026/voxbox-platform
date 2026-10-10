import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Code navigateur (JavaScript), testé tel quel.
import { genererQR, cheminQR } from "../public/cabine/js/qr.js";

/** Image PGM (niveaux de gris) du QR, 6 pixels par module, avec marge. */
function pgm(qr: { taille: number; modules: boolean[][] }) {
  const e = 6, marge = 4, cote = (qr.taille + 2 * marge) * e;
  const pixels = Buffer.alloc(cote * cote, 255);
  qr.modules.forEach((l, y) => l.forEach((s, x) => {
    if (!s) return;
    for (let dy = 0; dy < e; dy++) for (let dx = 0; dx < e; dx++) pixels[((y + marge) * e + dy) * cote + (x + marge) * e + dx] = 0;
  }));
  return Buffer.concat([Buffer.from(`P5 ${cote} ${cote} 255\n`), pixels]);
}

/** Décodage par OpenCV quand il est installé (machine de développement de Claude) ; sinon le test est ignoré. */
const decodeur = spawnSync("python3", ["-c", "import cv2"]).status === 0;

test("QR : tailles et structure (versions 1 à 10)", () => {
  assert.equal(genererQR("abc").version, 1);
  assert.equal(genererQR("abc").taille, 21);
  const long = genererQR("x".repeat(150));
  assert.equal(long.taille, long.version * 4 + 17);
  // Motifs de repère dans les trois coins.
  for (const [x, y] of [[0, 0], [long.taille - 7, 0], [0, long.taille - 7]]) {
    assert.equal(long.modules[y]![x], true);
    assert.equal(long.modules[y + 1]![x + 1], false);
    assert.equal(long.modules[y + 3]![x + 3], true);
  }
  assert.throws(() => genererQR("x".repeat(300)));
  assert.match(cheminQR(genererQR("a")).d, /^M\d+ \d+h1v1h-1z/);
});

test("QR : relu par un vrai décodeur (adresses de retrait de plusieurs longueurs)", { skip: !decodeur && "OpenCV absent" }, () => {
  const dossier = mkdtempSync(join(tmpdir(), "qr-"));
  const textes = [
    "https://parlopop.fr/retrait/#K7Q2MZ4XPA",
    "https://voxbox-test.laurent-7ed.workers.dev/retrait/#ABCDEFGHJK",
    "Bonjour, élégant et fun : ça marche ?",
    `https://parlopop.fr/r/${"Z".repeat(120)}`,
  ];
  textes.forEach((t, i) => writeFileSync(join(dossier, `${i}.pgm`), pgm(genererQR(t))));
  const script = `
import cv2, sys
d = cv2.QRCodeDetector()
for i in range(${textes.length}):
    img = cv2.imread(sys.argv[1] + "/" + str(i) + ".pgm", cv2.IMREAD_GRAYSCALE)
    val, pts, _ = d.detectAndDecode(img)
    print(val)
`;
  const r = spawnSync("python3", ["-c", script, dossier], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split("\n"), textes);
});
