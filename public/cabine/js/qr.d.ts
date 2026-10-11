// Types du générateur de QR code (public/cabine/js/qr.js), pour le code serveur qui le réutilise
// (sticker QR code de Why me). Le code navigateur garde ses annotations JSDoc.
export function genererQR(texte: string): { taille: number; modules: boolean[][]; version: number };
export function cheminQR(qr: { taille: number; modules: boolean[][] }, marge?: number): { d: string; cote: number };
