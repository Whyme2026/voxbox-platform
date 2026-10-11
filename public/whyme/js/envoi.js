// @ts-check
// File d'envoi du téléphone du candidat (Why me). Chaque prise gardée part tout de suite ; si le réseau coupe,
// elle attend dans le téléphone (IndexedDB) et repart dès que possible, même après un rechargement de la page.
// Le jeton du candidat voyage dans l'en-tête x-jeton, jamais dans l'adresse.

const BASE = "whyme-candidat";
const MAGASIN = "envois";

/**
 * @typedef {{ cle: string, candidat: string, chemin: string, corps: Blob, type: string, entetes: Record<string, string>, tentatives: number }} Envoi
 */

function ouvrirBase() {
  return new Promise((/** @type {(db: IDBDatabase) => void} */ resolve, reject) => {
    const req = indexedDB.open(BASE, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(MAGASIN, { keyPath: "cle" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @template T @param {IDBRequest<T>} req @returns {Promise<T>} */
const attendre = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

/**
 * @param {{ candidat: string, jeton: () => string, surEtat?: (restants: number, erreur: string | null) => void, surRejet?: (statut: number, message: string) => void }} o
 */
export async function creerFileEnvoi(o) {
  /** @type {IDBDatabase | null} */
  let db = null;
  try { db = await ouvrirBase(); } catch { db = null; } // navigation privée stricte : file en mémoire seulement
  /** @type {Map<string, Envoi>} */
  const memoire = new Map();
  let enCours = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let reveil;
  /** @type {(() => void)[]} */
  let attentes = [];

  const magasin = (/** @type {IDBTransactionMode} */ mode) => /** @type {IDBDatabase} */ (db).transaction(MAGASIN, mode).objectStore(MAGASIN);

  /** @returns {Promise<Envoi[]>} */
  const lister = async () => {
    if (!db) return [...memoire.values()];
    const tous = /** @type {Envoi[]} */ (await attendre(magasin("readonly").getAll()));
    return tous.filter((e) => e.candidat === o.candidat);
  };
  const retirer = async (/** @type {string} */ cle) => { memoire.delete(cle); if (db) await attendre(magasin("readwrite").delete(cle)); };
  const ecrire = async (/** @type {Envoi} */ e) => { memoire.set(e.cle, e); if (db) await attendre(magasin("readwrite").put(e)); };

  const signaler = async (/** @type {string | null} */ erreur = null) => {
    const restants = (await lister()).length;
    o.surEtat?.(restants, erreur);
    if (!restants) { const a = attentes; attentes = []; a.forEach((f) => f()); }
  };

  const traiter = async () => {
    if (enCours) return;
    enCours = true;
    clearTimeout(reveil);
    try {
      for (const e of await lister()) {
        let res;
        try {
          res = await fetch(e.chemin, { method: "PUT", body: e.corps, headers: { "content-type": e.type, "x-jeton": o.jeton(), ...e.entetes } });
        } catch {
          // Réseau coupé : on réessaie plus tard, sans perdre la prise.
          e.tentatives++;
          await ecrire(e);
          await signaler("hors_ligne");
          reveil = setTimeout(traiter, Math.min(15_000, 1500 * e.tentatives));
          return;
        }
        if (res.ok) { await retirer(e.cle); await signaler(); continue; }
        if (res.status >= 500 || res.status === 429) {
          e.tentatives++;
          await ecrire(e);
          await signaler("serveur");
          reveil = setTimeout(traiter, Math.min(20_000, 2000 * e.tentatives));
          return;
        }
        // Refus définitif (jeton changé, interview terminée, fichier refusé) : on ne s'acharne pas.
        const corps = await res.json().catch(() => ({}));
        await retirer(e.cle);
        o.surRejet?.(res.status, corps.message ?? `Erreur ${res.status}`);
        await signaler();
      }
    } finally {
      enCours = false;
    }
  };

  window.addEventListener("online", () => void traiter());

  return {
    /** Ajoute un envoi (une prise gardée, le CV) et le lance. */
    async ajouter(/** @type {{ cle: string, chemin: string, corps: Blob, type: string, entetes?: Record<string, string> }} */ e) {
      await ecrire({ ...e, candidat: o.candidat, entetes: e.entetes ?? {}, tentatives: 0 });
      await signaler();
      void traiter();
    },
    relancer: () => void traiter(),
    restants: async () => (await lister()).length,
    /** Promesse tenue quand tout est parti. */
    async vide() {
      if (!(await lister()).length) return;
      await new Promise((/** @type {(v?: unknown) => void} */ r) => { attentes.push(() => r()); void traiter(); });
    },
  };
}
