// @ts-check
// Service worker de la cabine : il ne sert qu'à rendre la cabine installable comme application plein écran
// (Chrome Android, manifest.webmanifest). Il ne met RIEN en cache et ne touche à aucune requête : la cabine garde
// sa propre file d'envoi (IndexedDB) et son rechargement automatique à chaque mise en ligne.

/** @type {any} */ const sw = self;

sw.addEventListener("install", () => sw.skipWaiting());
sw.addEventListener("activate", (/** @type {any} */ e) => e.waitUntil(sw.clients.claim()));
// Gestionnaire vide : la requête part sur le réseau comme sans service worker (exigé par les Chrome plus anciens
// pour proposer l'installation).
sw.addEventListener("fetch", () => {});
