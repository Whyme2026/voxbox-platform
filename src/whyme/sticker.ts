// Sticker QR code de Why me : image PNG carrée (cadre fuchsia, QR code anthracite sur blanc) qui mène à la page
// vidéo publique du candidat. Fabriquée sans dépendance : le QR code vient du générateur de la cabine, le PNG est
// encodé ici (zlib par CompressionStream, CRC32 maison).

import { genererQR } from "../../public/cabine/js/qr.js";

const FUCHSIA = [0xc6, 0x01, 0x7c];
const ENCRE = [0x2a, 0x2d, 0x30];
const BLANC = [0xff, 0xff, 0xff];

let tableCrc: Uint32Array | null = null;
function crc32(octets: Uint8Array): number {
  if (!tableCrc) {
    tableCrc = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tableCrc[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const o of octets) c = tableCrc[(c ^ o) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function bloc(type: string, donnees: Uint8Array): Uint8Array {
  const sortie = new Uint8Array(12 + donnees.length);
  const vue = new DataView(sortie.buffer);
  vue.setUint32(0, donnees.length);
  sortie.set(new TextEncoder().encode(type), 4);
  sortie.set(donnees, 8);
  vue.setUint32(8 + donnees.length, crc32(sortie.subarray(4, 8 + donnees.length)));
  return sortie;
}

async function zlib(octets: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const flux = new Blob([octets]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(flux).arrayBuffer());
}

/** Image RGB (largeur × hauteur × 3) encodée en PNG. */
export async function encoderPng(largeur: number, hauteur: number, rgb: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const lignes = new Uint8Array(hauteur * (largeur * 3 + 1));
  for (let y = 0; y < hauteur; y++) {
    lignes[y * (largeur * 3 + 1)] = 0; // pas de filtre
    lignes.set(rgb.subarray(y * largeur * 3, (y + 1) * largeur * 3), y * (largeur * 3 + 1) + 1);
  }
  const entete = new Uint8Array(13);
  const v = new DataView(entete.buffer);
  v.setUint32(0, largeur);
  v.setUint32(4, hauteur);
  entete.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  const parties = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloc("IHDR", entete),
    bloc("IDAT", await zlib(lignes)),
    bloc("IEND", new Uint8Array(0)),
  ];
  const total = parties.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let i = 0;
  for (const p of parties) { png.set(p, i); i += p.length; }
  return png;
}

/** Sticker : QR code de l'adresse, cadre fuchsia arrondi. */
export async function stickerPng(adresse: string): Promise<Uint8Array<ArrayBuffer>> {
  const qr = genererQR(adresse);
  const module = 12;
  const marge = 4;          // zone blanche réglementaire, en modules
  const cadre = 28;         // épaisseur du cadre fuchsia, en pixels
  const cote = (qr.taille + 2 * marge) * module + 2 * cadre;
  const rgb = new Uint8Array(cote * cote * 3);
  const rayon = 48;
  for (let y = 0; y < cote; y++) {
    for (let x = 0; x < cote; x++) {
      // Coins arrondis : blanc à l'extérieur du rayon.
      const dx = x < rayon ? rayon - x : x >= cote - rayon ? x - (cote - rayon - 1) : 0;
      const dy = y < rayon ? rayon - y : y >= cote - rayon ? y - (cote - rayon - 1) : 0;
      let c = BLANC;
      if (dx * dx + dy * dy <= rayon * rayon) {
        const interieur = x >= cadre && y >= cadre && x < cote - cadre && y < cote - cadre;
        if (!interieur) c = FUCHSIA;
        else {
          const mx = Math.floor((x - cadre) / module) - marge;
          const my = Math.floor((y - cadre) / module) - marge;
          if (mx >= 0 && my >= 0 && mx < qr.taille && my < qr.taille && qr.modules[my]![mx]) c = ENCRE;
        }
      }
      rgb.set(c, (y * cote + x) * 3);
    }
  }
  return encoderPng(cote, cote, rgb);
}
