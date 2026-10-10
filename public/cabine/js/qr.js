// @ts-check
// Générateur de QR codes, sans dépendance (la cabine ne charge rien depuis internet).
// Mode octets (UTF-8), correction d'erreur de niveau M, versions 1 à 10 (jusqu'à 213 octets) : largement assez pour
// une adresse de retrait. Algorithme de la norme ISO/IEC 18004, d'après l'implémentation de référence de Nayuki.

// Tables du niveau M, indexées par version (1 à 10).
const ECC_PAR_BLOC = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NB_BLOCS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_M = 0; // bits de format du niveau M

/** Modules disponibles pour les données et la correction, pour une version. */
function modulesBruts(/** @type {number} */ v) {
  let n = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const a = Math.floor(v / 7) + 2;
    n -= (25 * a - 10) * a - 55;
    if (v >= 7) n -= 36;
  }
  return n;
}
const octetsDeDonnees = (/** @type {number} */ v) => Math.floor(modulesBruts(v) / 8) - /** @type {number} */ (ECC_PAR_BLOC[v]) * /** @type {number} */ (NB_BLOCS[v]);

/** Multiplication dans GF(2^8), polynôme 0x11D. */
function mul(/** @type {number} */ x, /** @type {number} */ y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function diviseurRS(/** @type {number} */ degre) {
  /** @type {number[]} */ const r = new Array(degre - 1).fill(0);
  r.push(1);
  let racine = 1;
  for (let i = 0; i < degre; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = mul(/** @type {number} */ (r[j]), racine);
      if (j + 1 < r.length) r[j] = /** @type {number} */ (r[j]) ^ /** @type {number} */ (r[j + 1]);
    }
    racine = mul(racine, 0x02);
  }
  return r;
}

function resteRS(/** @type {number[]} */ donnees, /** @type {number[]} */ diviseur) {
  /** @type {number[]} */ const r = diviseur.map(() => 0);
  for (const b of donnees) {
    const facteur = b ^ /** @type {number} */ (r.shift());
    r.push(0);
    diviseur.forEach((coef, i) => { r[i] = /** @type {number} */ (r[i]) ^ mul(coef, facteur); });
  }
  return r;
}

function positionsAlignement(/** @type {number} */ v, /** @type {number} */ taille) {
  if (v === 1) return [];
  const n = Math.floor(v / 7) + 2;
  const pas = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let pos = taille - 7; r.length < n; pos -= pas) r.splice(1, 0, pos);
  return r;
}

const MASQUES = [
  (/** @type {number} */ x, /** @type {number} */ y) => (x + y) % 2 === 0,
  (/** @type {number} */ _x, /** @type {number} */ y) => y % 2 === 0,
  (/** @type {number} */ x) => x % 3 === 0,
  (/** @type {number} */ x, /** @type {number} */ y) => (x + y) % 3 === 0,
  (/** @type {number} */ x, /** @type {number} */ y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (/** @type {number} */ x, /** @type {number} */ y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (/** @type {number} */ x, /** @type {number} */ y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (/** @type {number} */ x, /** @type {number} */ y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * QR code d'un texte.
 * @param {string} texte
 * @returns {{ taille: number, modules: boolean[][], version: number }} modules[y][x], true = sombre
 */
export function genererQR(texte) {
  const octets = [...new TextEncoder().encode(texte)];
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const bits = 4 + (v <= 9 ? 8 : 16) + 8 * octets.length;
    if (bits <= octetsDeDonnees(v) * 8) { version = v; break; }
  }
  if (!version) throw new Error("Texte trop long pour le QR code");
  const v = version;
  const taille = v * 4 + 17;
  const capacite = octetsDeDonnees(v);

  // Flux de bits : mode octets, longueur, données, terminaison, bourrage.
  /** @type {number[]} */ const bits = [];
  const ajouter = (/** @type {number} */ val, /** @type {number} */ n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  ajouter(0b0100, 4);
  ajouter(octets.length, v <= 9 ? 8 : 16);
  for (const o of octets) ajouter(o, 8);
  ajouter(0, Math.min(4, capacite * 8 - bits.length));
  ajouter(0, (8 - (bits.length % 8)) % 8);
  for (let bourrage = 0xec; bits.length < capacite * 8; bourrage ^= 0xec ^ 0x11) ajouter(bourrage, 8);
  /** @type {number[]} */ const donnees = [];
  for (let i = 0; i < bits.length; i += 8) donnees.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // Correction d'erreur par blocs, puis entrelacement.
  const nbBlocs = /** @type {number} */ (NB_BLOCS[v]);
  const eccLong = /** @type {number} */ (ECC_PAR_BLOC[v]);
  const totalMots = Math.floor(modulesBruts(v) / 8);
  const nbCourts = nbBlocs - (totalMots % nbBlocs);
  const longCourt = Math.floor(totalMots / nbBlocs);
  const div = diviseurRS(eccLong);
  /** @type {number[][]} */ const blocs = [];
  for (let i = 0, k = 0; i < nbBlocs; i++) {
    const d = donnees.slice(k, k + longCourt - eccLong + (i < nbCourts ? 0 : 1));
    k += d.length;
    const ecc = resteRS(d, div);
    if (i < nbCourts) d.push(0);
    blocs.push(d.concat(ecc));
  }
  /** @type {number[]} */ const mots = [];
  for (let i = 0; i < /** @type {number[]} */ (blocs[0]).length; i++) {
    blocs.forEach((b, j) => { if (i !== longCourt - eccLong || j >= nbCourts) mots.push(/** @type {number} */ (b[i])); });
  }

  // Motifs fixes.
  const modules = Array.from({ length: taille }, () => new Array(taille).fill(false));
  const fixe = Array.from({ length: taille }, () => new Array(taille).fill(false));
  const poser = (/** @type {number} */ x, /** @type {number} */ y, /** @type {boolean} */ sombre) => { modules[y][x] = sombre; fixe[y][x] = true; };
  for (let i = 0; i < taille; i++) { poser(6, i, i % 2 === 0); poser(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [taille - 4, 3], [3, taille - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = /** @type {number} */ (cx) + dx, y = /** @type {number} */ (cy) + dy;
      if (x >= 0 && x < taille && y >= 0 && y < taille) { const d = Math.max(Math.abs(dx), Math.abs(dy)); poser(x, y, d !== 2 && d !== 4); }
    }
  }
  const al = positionsAlignement(v, taille);
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) poser(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const formater = (/** @type {number} */ masque) => {
    const d = (FORMAT_M << 3) | masque;
    let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const f = ((d << 10) | r) ^ 0x5412;
    const bit = (/** @type {number} */ i) => ((f >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) poser(8, i, bit(i));
    poser(8, 7, bit(6)); poser(8, 8, bit(7)); poser(7, 8, bit(8));
    for (let i = 9; i < 15; i++) poser(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) poser(taille - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) poser(8, taille - 15 + i, bit(i));
    poser(8, taille - 8, true);
  };
  formater(0); // réserve les emplacements
  if (v >= 7) {
    let r = v;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (v << 12) | r;
    for (let i = 0; i < 18; i++) {
      const sombre = ((b >>> i) & 1) !== 0;
      const a = taille - 11 + (i % 3), c = Math.floor(i / 3);
      poser(a, c, sombre); poser(c, a, sombre);
    }
  }

  // Placement des mots en zigzag.
  let n = 0;
  for (let droite = taille - 1; droite >= 1; droite -= 2) {
    if (droite === 6) droite = 5;
    for (let vert = 0; vert < taille; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = droite - j;
        const montant = ((droite + 1) & 2) === 0;
        const y = montant ? taille - 1 - vert : vert;
        if (!fixe[y][x] && n < mots.length * 8) {
          modules[y][x] = ((/** @type {number} */ (mots[n >>> 3]) >>> (7 - (n & 7))) & 1) !== 0;
          n++;
        }
      }
    }
  }

  // Choix du masque : celui qui donne la pénalité la plus faible.
  const appliquer = (/** @type {number} */ m) => {
    for (let y = 0; y < taille; y++) for (let x = 0; x < taille; x++) if (!fixe[y][x] && /** @type {Function} */ (MASQUES[m])(x, y)) modules[y][x] = !modules[y][x];
  };
  let meilleur = 0, scoreMin = Infinity;
  for (let m = 0; m < 8; m++) {
    appliquer(m); formater(m);
    const s = penalite(modules);
    if (s < scoreMin) { scoreMin = s; meilleur = m; }
    appliquer(m); // annule (le masque est son propre inverse)
  }
  appliquer(meilleur);
  formater(meilleur);
  return { taille, modules, version: v };
}

/** Pénalité simplifiée de la norme (suites, carrés 2×2, motifs de repère, équilibre clair/sombre). */
function penalite(/** @type {boolean[][]} */ m) {
  const t = m.length;
  let s = 0;
  const lignes = (/** @type {(i: number, j: number) => boolean} */ lire) => {
    for (let i = 0; i < t; i++) {
      let suite = 1;
      /** @type {boolean[]} */ const l = [];
      for (let j = 0; j < t; j++) {
        l.push(lire(i, j));
        if (j > 0 && lire(i, j) === lire(i, j - 1)) { suite++; if (suite === 5) s += 3; else if (suite > 5) s++; } else suite = 1;
      }
      const motif = l.map((b) => (b ? "1" : "0")).join("");
      s += 40 * ((motif.match(/(?=10111010000|00001011101)/g) ?? []).length);
    }
  };
  lignes((i, j) => /** @type {boolean} */ (m[i]?.[j]));
  lignes((i, j) => /** @type {boolean} */ (m[j]?.[i]));
  let sombres = 0;
  for (let y = 0; y < t; y++) for (let x = 0; x < t; x++) {
    if (m[y]?.[x]) sombres++;
    if (y < t - 1 && x < t - 1) { const c = m[y]?.[x]; if (c === m[y]?.[x + 1] && c === m[y + 1]?.[x] && c === m[y + 1]?.[x + 1]) s += 3; }
  }
  s += Math.floor(Math.abs(sombres * 20 - t * t * 10) / (t * t)) * 10;
  return s;
}

/** Tracé SVG (chemin) des modules sombres, avec une marge de 4 modules. */
export function cheminQR(/** @type {{ taille: number, modules: boolean[][] }} */ qr, marge = 4) {
  let d = "";
  qr.modules.forEach((ligne, y) => ligne.forEach((sombre, x) => { if (sombre) d += `M${x + marge} ${y + marge}h1v1h-1z`; }));
  return { d, cote: qr.taille + 2 * marge };
}
