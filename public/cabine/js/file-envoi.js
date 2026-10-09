// @ts-check
// File d'envoi locale (IndexedDB) : sessions et vidéos sont d'abord enregistrées sur la tablette,
// puis envoyées dans l'ordre. Rien n'est perdu si le Wi-Fi coupe ou si la tablette redémarre.

const BASE = "voxbox-cabine";
const MAGASIN = "envois";

/**
 * @typedef {{ id?: number, methode: string, chemin: string, corps: Blob | string, type: string, entetes?: Record<string,string>, tentatives: number, prochainEssai: number, cree: number }} Envoi
 */

function ouvrirBase() {
  return new Promise((/** @type {(db: IDBDatabase) => void} */ resolve, reject) => {
    const req = indexedDB.open(BASE, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(MAGASIN, { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @template T @param {IDBRequest<T>} req @returns {Promise<T>} */
const attendre = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

/**
 * @param {{ jeton: () => string | null, surEtat?: (enAttente: number, enLigne: boolean) => void, surRejet?: (envoi: Envoi, statut: number) => void }} options
 */
export async function creerFileEnvoi(options) {
  const db = await ouvrirBase();
  let enCours = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let reveil;

  const magasin = (/** @type {IDBTransactionMode} */ mode) => db.transaction(MAGASIN, mode).objectStore(MAGASIN);
  const compter = () => attendre(magasin("readonly").count());

  const signaler = async () => options.surEtat?.(await compter(), navigator.onLine);

  /** @param {Omit<Envoi, "tentatives" | "prochainEssai" | "cree" | "id">} envoi */
  const ajouter = async (envoi) => {
    await attendre(magasin("readwrite").add({ ...envoi, tentatives: 0, prochainEssai: 0, cree: Date.now() }));
    await signaler();
    traiter();
  };

  const planifier = (/** @type {number} */ ms) => { clearTimeout(reveil); reveil = setTimeout(traiter, ms); };

  // Envoi strictement dans l'ordre : une session est toujours créée avant ses vidéos.
  const traiter = async () => {
    if (enCours) return;
    enCours = true;
    try {
      for (;;) {
        const curseur = await attendre(magasin("readonly").openCursor());
        if (!curseur) break;
        const envoi = /** @type {Envoi} */ (curseur.value);
        if (envoi.prochainEssai > Date.now()) { planifier(envoi.prochainEssai - Date.now()); break; }
        const jeton = options.jeton();
        if (!jeton) break;
        let statut = 0;
        try {
          const res = await fetch(envoi.chemin, {
            method: envoi.methode,
            headers: { authorization: `Bearer ${jeton}`, "content-type": envoi.type, ...(envoi.entetes ?? {}) },
            body: envoi.corps,
          });
          statut = res.status;
        } catch { statut = 0; } // réseau absent
        if (statut >= 200 && statut < 300) {
          await attendre(magasin("readwrite").delete(/** @type {number} */ (envoi.id)));
        } else if (statut === 0 || statut === 401 || statut === 408 || statut === 429 || statut >= 500) {
          // Erreur passagère (réseau, serveur, jeton en cours de renouvellement) : on réessaie plus tard.
          const tentatives = envoi.tentatives + 1;
          const attente = Math.min(60_000, 2000 * 2 ** Math.min(tentatives, 5));
          await attendre(magasin("readwrite").put({ ...envoi, tentatives, prochainEssai: Date.now() + attente }));
          planifier(attente);
          break;
        } else {
          // Refus définitif (requête invalide, campagne close…) : on retire l'envoi pour ne pas bloquer la file.
          options.surRejet?.(envoi, statut);
          await attendre(magasin("readwrite").delete(/** @type {number} */ (envoi.id)));
        }
        await signaler();
      }
    } finally {
      enCours = false;
      await signaler();
    }
  };

  window.addEventListener("online", () => traiter());
  setInterval(() => traiter(), 30_000);
  traiter();
  return { ajouter, compter, traiter };
}
