# Parlobox — consignes pour Claude

Plateforme de cabines vidéo d'avis consommateurs, **by whyme**. Nom de marque **Parlobox** depuis le 11/10/2026 (domaine
`parlobox.com`) ; anciens noms « Vox Boxes » puis « Parlopop » : ne plus les employer. Les noms techniques `voxbox`
(Workers, bases, stockages, dépôt) restent : invisibles pour les visiteurs, les changer demanderait de déplacer les données.
Vocabulaire : **Parlobox** = la marque, la cabine et l'expérience ; **Parlorama** = l'interface de gestion et de consultation (`/admin/`) ;
**Parlomètre** = mesure et indicateurs ; **Parlomix** = le clip monté (à venir). Maintenue par Claude, avec un développeur freelance en filet.
Ce qu'on assemble (14/10/2026, `docs/architecture.md`, « Gabarit, thème, parcours ») : **gabarit** = la cabine (code,
commun) ; **thème** = l'allure (ambiance + habillage, catalogue `public/admin/modeles/themes/`) ; **parcours** = le
déroulé (étapes, catalogue `public/admin/modeles/parcours/`) ; **campagne** = un thème + un parcours. Ne plus
mélanger : un parcours type n'a ni fond ni couleur, un thème n'a pas d'étape.
Lire `docs/architecture.md` avant toute modification structurelle, `docs/exploitation.md` en cas d'incident.
**Why me** (11/10/2026) : second produit sur la même plateforme, l'interview vidéo RH du candidat sur son propre
téléphone (JobBox ou lien). Code dans `src/whyme/`, `public/whyme/`, `public/recruteur/`, `public/rh/`, `montage/` ; lire `docs/whyme.md`.
Ses règles propres : aucune IA ni note, rushes effacés après montage, recruteurs 12 mois, tout en 9:16.
Univers RH **séparé de Parlopop** : back-office `/rh/` et comptes propres (`rh_equipe`), rien de Why me dans Parlorama ;
client (organisateur, statistiques agrégées seulement) et sous-clients (entreprises recruteuses, fiches communes).

## Règles du produit (non négociables)
- On analyse ce que les gens disent, **jamais les personnes** (aucune notation, aucun profilage d'individu).
- WhyMe est **sous-traitant**, la marque **responsable de traitement**. Données en **juridiction UE** uniquement.
- Deux consentements séparés : usage interne (obligatoire), diffusion publique (facultatif).
- Un compte client ne voit **que son client**. Le périmètre vient du compte, jamais de la requête.
- Rien n'est propre à un secteur : l'automobile n'est qu'une configuration (`fixtures/parcours-automobile.json`).
  L'allure d'une marque passe par l'habillage du parcours (polices, couleurs, ambiances « conversation », « pop » ou « marine », visuels SVG), jamais par
  du code propre à la marque : voir `fixtures/parcours-geely.json`.

## Règles de code
- TypeScript côté serveur, **aucune dépendance d'exécution**. Syntaxe « effaçable » uniquement (pas d'`enum`,
  pas de propriétés de paramètres) : les tests tournent directement avec Node.
- Code navigateur (`public/`) en JavaScript annoté (`// @ts-check` + JSDoc), sans étape de compilation, vérifié par `tsconfig.web.json`.
  La cabine ne charge **rien depuis internet** (ni police, ni module) : leçon Geely. Polices dans `public/polices/`.
- Direction artistique « la conversation » (bulles, Fredoka + Gabarito, couleurs douces) : voir `docs/architecture.md`.
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
npm run e2e -- <audio.wav> <dossier-captures> [demo|auto|fabrice|alexandre|pfa|geely|whyme]   # parcours complet + présence du son dans chaque vidéo
npm run cabine:local                            # serveur local avec une campagne de démo (code d'appairage affiché, /admin/)
E2E_ADMIN=1 npm run e2e -- …                     # ajoute la visite de l'espace de gestion (captures admin-*.png ; geely et pfa : vrai Parlomix)
npm run e2e:whyme -- <voix.wav> <camera.y4m> <captures>   # Why me : téléphone simulé, vrai montage ffmpeg
```
Tout changement de comportement s'accompagne d'un test. Les tests d'API utilisent une base SQLite locale
(`test/aide/d1-local.ts`) qui rejoue les migrations : ce qui passe ici passe sur D1.

## Environnements
| Environnement | Adresse | Worker | Base D1 | Stockage R2 | Mise en ligne |
|---|---|---|---|---|---|
| dev (local) | localhost | voxbox-dev | locale | locale | `npm run cabine:local` |
| test | voxbox-test.laurent-7ed.workers.dev | voxbox-test | voxbox-test (UE) | voxbox-media-test (UE) | chaque fusion dans `main` |
| production | app.parlobox.com | voxbox | voxbox-prod (UE) | voxbox-media-prod (UE) | branche `production` uniquement |

Rien ne part en production sans être passé par test : avancer `production` seulement sur demande explicite de
Laurent, migrations appliquées avant. Claude ne peut pas pousser ni fusionner vers `production` (contrôle de sécurité
de la session) : préparer, puis donner à Laurent le lien de comparaison avec le titre prérempli
(`docs/exploitation.md`, « Livrer une version »), et vérifier après sa fusion. Toute modification de la cabine augmente
`VERSION` dans `public/cabine/js/app.js`. Les deux environnements sont fermés par Cloudflare Access (3 personnes) ;
seules la cabine et la page de retrait Parlobox sont publiques, et seulement en test. Why me reste en test.
Procédures, accès et secrets : `docs/exploitation.md`.
