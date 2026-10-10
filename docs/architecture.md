# Architecture

## Vue d'ensemble
Un seul Worker Cloudflare sert l'API (`/api/*`) et les pages statiques (`public/`).

```
tablette (cabine) ─┐
lien / QR code ────┼──► Worker voxbox ──► D1 (données, UE)
espace WhyMe ──────┤        │          ──► R2 (vidéos, UE)
espace client ─────┘        └────────────► traitement vidéo (semaine 3)
```

## Authentification
- **Espaces WhyMe et client** : Cloudflare Access (code à usage unique envoyé par e-mail par Cloudflare, gratuit jusqu'à 50 comptes).
  Le Worker **vérifie lui-même** le jeton `Cf-Access-Jwt-Assertion` (`src/auth/access-jwt.ts`) : signature RS256,
  émetteur, audience, expiration. Un e-mail authentifié mais absent de la table `utilisateurs` n'a aucun accès.
- **Administrateurs d'office** : variable `ADMIN_EMAILS` (dans le tableau de bord Cloudflare, pas dans le code).
- **Cabine** (`/cabine/`, `/api/cabine/*`) : jamais Cloudflare Access. La tablette est appairée une fois avec un code
  à usage unique (fiche cabine, espace WhyMe) et reçoit un jeton secret ; seule son empreinte SHA-256 est stockée.
  Un nouveau code révoque l'ancienne tablette. ⚠ Ces chemins doivent être exclus de la protection Access (règle « bypass »).
- **Lien de retrait** (`/retrait/`, `/api/retrait/*`) : public, jamais Cloudflare Access (⚠ règle « bypass » à
  ajouter, comme pour la cabine). Le seul secret est le code de retrait de la session : 10 caractères sans O/0 ni I/1
  (32^10 combinaisons), tiré par la tablette (pour fonctionner hors ligne) et accepté par le serveur s'il est libre.
  L'écran de fin l'affiche en **QR code** (générateur local `public/cabine/js/qr.js`, rien de chargé d'internet)
  et en clair (XXXX-XXXX-XX). Le code est placé après `#` dans l'adresse : il n'apparaît dans aucun journal de
  serveur. La page propose « retirer seulement l'accord de diffusion » ou « supprimer mes réponses » (mêmes
  effets que le retrait depuis Parlorama, `src/rgpd/retrait.ts`), journalisé « visiteur (lien de retrait) ».
- **Développement local** : `AUTH_MODE=dev` et en-tête `X-Dev-Email`, refusé hors `localhost` et en production.

## Rôles
| Rôle | Périmètre | Peut |
|---|---|---|
| admin_whyme | tous les clients | tout, dont comptes et fiches clients |
| operateur_whyme | tous les clients | campagnes, cabines, consultation |
| validateur_client | son client | consulter, valider questions et textes |
| lecteur_client | son client | consulter |

## Campagnes
`brouillon → validee → active → close`. La validation est faite par le client (ou un admin WhyMe).
Toute modification du parcours ou des textes crée une **nouvelle version** et remet la campagne en brouillon.
Une campagne active ou close n'est plus modifiable. Chaque session garde la version de parcours et de consentement qu'elle a vue.

## Parcours
Fichier JSON validé par `src/parcours/schema.ts` : étapes `accueil`, `identification`, `consentement`, `cadrage`,
`question`, `choix` (embranchement), `pause` (avant/après), `fin`. Contrôles : identifiants uniques, renvois valides,
consentement avant toute question, toutes les étapes atteignables, fin obligatoire.

## Parcours de démonstration et direction artistique
- `fixtures/parcours-demo.json` : parcours **neutre Parlopop**, base vendue puis personnalisée par marque.
  Accueil (la cabine « parle » en bulles), prénom (+ e-mail facultatif), mode d'emploi + accord (bouton grisé tant que
  l'accord obligatoire n'est pas donné), 5 questions (titre court, pistes, coup de pouce), fin personnalisée.
  Choix, pause avant/après, cadrage : options par campagne. `{prenom}` est remplacé dans tous les textes affichés.
- Direction artistique « la conversation » (validée le 10/10/2026 sur maquette 16:9) : fonds clairs, une seule forme,
  la bulle (la marque parle à gauche, le visiteur répond à droite), titres en **Fredoka**, texte en **Gabarito**,
  indigo `#3F4C8F` pour la marque, jaune beurre `#F2D27A` pour le visiteur et les boutons, corail réservé à l'enregistrement.
  Une marque remplace ces couleurs via `clients.couleurs` (`principale`, `secondaire`, `fond`, `texte`) et son logo.
- Polices libres (licence OFL, copies dans `public/polices/`), réduites aux caractères latins et servies par le Worker :
  rien n'est chargé depuis internet.
- Flou : niveau **fort** retenu (10/10/2026).

## Parlorama, l'espace de gestion (`/admin/`)
Une page sans compilation (`public/admin/`), même direction artistique, protégée par Cloudflare Access.
- WhyMe : tableau de bord (campagnes, cabines en ligne, visiteurs, vidéos), campagnes (statut, parcours lisible et
  nouvelle version en JSON, textes de consentement), réponses vidéo par visiteur ou par question, cabines (état,
  affectation, code d'appairage), clients, comptes, journal.
- Comptes client : leurs campagnes et leurs réponses uniquement, validation des questions et des textes.
- Vidéos : `GET /api/espace/reponses/:id/video`, droit `reponses.lire`, cloisonnement par client,
  **chaque visionnage est journalisé** ; plus rien n'est servi si le visiteur a retiré son accord. Lecture en continu
  (requêtes partielles « Range ») ; un seul visionnage journalisé par lecture.
- Modifier et supprimer : fiches client (couleurs, logo PNG/JPEG/WebP envoyé dans R2 et servi publiquement par
  `/api/cabine/logo/<client>.<ext>`, SVG refusé), rôle des comptes, nom/dates/conservation des campagnes (durée figée
  une fois active ; la changer régénère les textes et remet en brouillon), suppression d'un brouillon sans visiteur,
  cabines (renommer ; supprimer, ou retirer si déjà utilisée), Parlomix (auteur ou WhyMe).
- Visiteurs (droit `visiteurs.gerer` : WhyMe et validateurs du client) : **retrait d'accord** (vidéos, réponses et
  Parlomix où la personne apparaît supprimés, session anonymisée, trace dans le journal sans le prénom) et retrait du
  seul accord de diffusion. Recherche par prénom, filtre par cabine, **export CSV** (e-mail seulement si la personne
  accepte d'être recontactée, export journalisé).
- **Éditeur de parcours** (`public/admin/js/editeur.js`) : étapes en cartes (ajouter, déplacer, dupliquer, supprimer),
  champs par type, renvois (« Ensuite », options d'un choix), vérification par le serveur
  (`POST /api/admin/parcours/valider`, mêmes règles qu'à l'enregistrement), modèles (parcours neutre, copie d'une
  autre campagne), mode JSON, **aperçu dans la vraie cabine** (`/cabine/?apercu=1`, brouillon passé par le stockage
  du navigateur, rien n'est envoyé). Les identifiants d'étape ne changent plus une fois créés : les réponses y sont
  rattachées d'une version à l'autre.
- **Miniatures** (migration `0004_miniatures.sql`) : la cabine envoie une image JPEG 320×180 prise 1,2 s après le
  début de chaque réponse (floutée si le visiteur l'a demandé), juste après la vidéo. Pour les réponses plus
  anciennes, Parlorama fabrique la miniature lui-même quand la tuile apparaît à l'écran (lecture journalisée à part,
  `reponse.miniature`), une seule fois. Un Parlomix a pour miniature sa carte d'ouverture. Les miniatures sont
  effacées avec les vidéos lors d'un retrait d'accord et ne sont plus servies ensuite.

## Parlomix (montages)
Décision du 10/10/2026 : le montage se fabrique **dans Parlorama**, dans le navigateur de la personne qui le lance
(gratuit, rien ne quitte l'UE). Le même plan de montage pourra être exécuté plus tard par un serveur de rendu.
- `public/admin/js/montage/plan.js` (logique pure, testée) : repérage des blancs à partir de l'enveloppe du son
  (début et fin coupés, silences de plus de 0,7 s raccourcis), choix des réponses (par personne ; par question dans
  la campagne ou dans une cabine ; filtre « diffusion acceptée » ; prénoms ou « Avis n° k » ; 20 réponses au plus),
  plan (ouverture, réponses séparées par une carte animée et le jingle, fin), recadrage 9:16, **jingle composé par
  le code** (quatre notes de marimba et une bulle, propriété de WhyMe).
- `public/admin/js/montage/rendu.js` : canevas + MediaRecorder, MP4 si le navigateur sait (sinon WebM), coupes
  franches (enregistrement en pause pendant les recherches), cartes et bandeaux aux couleurs du client, limiteur
  sur le son, vérification que le film contient du son (sinon nouveau montage en WebM : leçon Geely).
- API (`src/routes/parlomix.ts`, migration `0002_parlomix.sql`) : le plan est vérifié (réponses de la campagne,
  même question, même cabine, personnes n'ayant pas retiré leur accord), le film est stocké dans R2, chaque
  visionnage est journalisé. **Dès qu'une personne montée retire son accord, le Parlomix n'est plus servi.**
  « Diffusable » seulement si toutes les personnes montées ont accepté la diffusion publique.
- Limites : le film se fabrique en temps réel (onglet ouvert et visible), 95 Mo au plus par film.

## Cabine (tablette)
Page `public/cabine/`, sans compilation ni dépendance :
- `moteur.js` : déroulé du parcours (logique pure, testée avec Node) ;
- `clavier.js` : clavier dessiné dans la page, aucun champ natif (ni clavier système, ni saisie automatique) ;
- `enregistreur.js` : WebM + Opus uniquement, vumètre, arrêt après N s de silence une fois la parole commencée,
  « son présent » si au moins 0,6 s de voix ;
- `flou.js` : flou doux elliptique, irréversible (réduction forte puis flou), détection intégrée au navigateur ;
  sans détecteur, toute l'image est floutée ;
- `file-envoi.js` : file IndexedDB strictement ordonnée (session puis vidéos), reprise après coupure ;
- `app.js` : écrans en bulles (16:9 d'abord, portrait 9:16 géré), pauses avant/après (reprise par le prénom, 12 h max), inactivité 90 s, signal de vie,
  miniature de chaque réponse, QR code du lien de retrait sur l'écran de fin (retour à l'accueil après 20 s par défaut, le temps de scanner) ;
- `qr.js` : générateur de QR code (mode octets, correction M, versions 1 à 10), vérifié par décodage OpenCV dans les tests.
La session est créée par la tablette (UUID) pour fonctionner hors ligne ; l'envoi est idempotent.

## Points à vérifier (lot 0)
- Déploiement automatique depuis GitHub (Workers Builds) et application des migrations D1 dans ce cadre.
- Protection Access limitée aux chemins des espaces (la cabine et le retrait doivent rester publics).
- Traitement vidéo : Cloudflare Containers (offre payante ~5 $/mois) ou petit serveur UE.
