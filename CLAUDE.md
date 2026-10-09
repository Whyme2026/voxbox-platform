# Vox Boxes — consignes pour Claude

Plateforme de cabines vidéo d'avis consommateurs, **by whyme**. Maintenue par Claude, avec un développeur freelance en filet.
Lire `docs/architecture.md` avant toute modification structurelle, `docs/exploitation.md` en cas d'incident.

## Règles du produit (non négociables)
- On analyse ce que les gens disent, **jamais les personnes** (aucune notation, aucun profilage d'individu).
- WhyMe est **sous-traitant**, la marque **responsable de traitement**. Données en **juridiction UE** uniquement.
- Deux consentements séparés : usage interne (obligatoire), diffusion publique (facultatif).
- Un compte client ne voit **que son client**. Le périmètre vient du compte, jamais de la requête.
- Rien n'est propre à un secteur : l'automobile n'est qu'une configuration (`fixtures/parcours-automobile.json`).

## Règles de code
- TypeScript côté serveur, **aucune dépendance d'exécution**.
- Code navigateur (`public/`) en JavaScript annoté (`// @ts-check` + JSDoc), sans étape de compilation, vérifié par `tsconfig.web.json`.
  La cabine ne charge **rien depuis internet** (ni police, ni module) : leçon Geely. Syntaxe « effaçable » uniquement (pas d'`enum`, pas de propriétés de paramètres) : les tests tournent directement avec Node.
- Imports avec l'extension `.ts`.
- Code, noms et messages en **français**.
- Toute écriture sensible passe par un `batch` qui inclut sa ligne de `journal` (atomique).
- Toute route protégée : `identifier()` puis `exiger()` (voir `src/auth/droits.ts`).
- Nouveau schéma = **nouvelle migration** numérotée dans `migrations/`, jamais de modification d'une migration déjà appliquée.

## Vérifier avant d'envoyer
```
npm run check      # typecheck + tests (Node ≥ 22.18, sans installation)
```
Tout changement de la cabine se vérifie aussi de bout en bout, dans un vrai Chrome avec caméra et micro simulés :
```
npm run e2e -- <audio.wav> <dossier-captures>   # parcours complet + présence du son dans chaque vidéo
npm run cabine:local                            # serveur local avec une campagne de démo (code d'appairage affiché)
```
Tout changement de comportement s'accompagne d'un test. Les tests d'API utilisent une base SQLite locale
(`test/aide/d1-local.ts`) qui rejoue les migrations : ce qui passe ici passe sur D1.

## Environnements
| Environnement | Worker | Base D1 | Stockage R2 |
|---|---|---|---|
| dev (local) | voxbox-dev | locale | locale |
| test | voxbox-test | voxbox-test (UE) | voxbox-media-test (UE) |
| production | voxbox | voxbox-prod (UE) | voxbox-media-prod (UE) |

Rien ne part en production sans être passé par test.
