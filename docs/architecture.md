# Architecture

## Vue d'ensemble
Un seul Worker Cloudflare sert l'API (`/api/*`) et les pages statiques (`public/`).

```
tablette (cabine) ─┐
lien / QR code ────┼──► Worker voxbox ──► D1 (données, UE)
espace WhyMe ──────┤        │          ──► R2 (vidéos, UE)
espace client ─────┘        ├────────────► traitement vidéo (semaine 3)
                             └────────────► Mistral AI (UE) : transcription, option Analyse seulement
```

## Authentification
- **Espaces WhyMe et client** : Cloudflare Access (code à usage unique envoyé par e-mail par Cloudflare, gratuit jusqu'à 50 comptes).
  Le Worker **vérifie lui-même** le jeton `Cf-Access-Jwt-Assertion` (`src/auth/access-jwt.ts`) : signature RS256,
  émetteur, audience, expiration. Un e-mail authentifié mais absent de la table `utilisateurs` n'a aucun accès.
- **Administrateurs d'office** : variable `ADMIN_EMAILS` (dans le tableau de bord Cloudflare, pas dans le code).
- **Cabine** (`/cabine/`, `/api/cabine/*`) : jamais Cloudflare Access. La tablette est appairée une fois avec un code
  à usage unique (fiche cabine, espace WhyMe) et reçoit un jeton secret ; seule son empreinte SHA-256 est stockée.
  Un nouveau code révoque l'ancienne tablette. ⚠ Ces chemins doivent être exclus de la protection Access (règle « bypass »).
- **Retrait par le visiteur** (`/retrait/`, `/api/acces/*`, `/api/retrait/*`) : public, jamais Cloudflare Access
  (⚠ règle « bypass »). Décision du 10/10/2026 : plus de QR code propre à chaque session sur l'écran de fin, qui
  rappelle seulement le **QR code fixe affiché à l'extérieur de la cabine** (affiche imprimable : Parlorama > Cabines >
  « Affiche QR à imprimer », `public/admin/affiche.html`). Ce QR code ouvre `/retrait/` :
  1. le visiteur saisit l'e-mail donné à l'identification ; si des passages y correspondent, un lien valable une heure
     lui est envoyé (`src/routes/acces.ts`, `src/courriel.ts`) ; la réponse est la même dans tous les cas (on ne révèle
     pas qui est passé en cabine) ; trois demandes par heure au plus par adresse ; seule l'empreinte SHA-256 du jeton
     est gardée, et les demandes de plus d'un jour sont effacées (migration `0007_acces_visiteur.sql`) ;
  2. le lien `/retrait/#acces=<jeton>` montre ses passages (toutes marques confondues : ce sont ses propres données) et
     ses vidéos ; pour chacun, « retirer seulement l'accord de diffusion » ou « supprimer ces réponses » (mêmes effets
     que depuis Parlorama, `src/rgpd/retrait.ts`). Le jeton passe dans l'en-tête `x-acces`, jamais dans une adresse.
     Visionnages et retraits sont journalisés « visiteur (accès par e-mail) ».
  L'e-mail reste facultatif (sans lui : contact RGPD de la marque) et ne vaut pas accord pour être recontacté (case
  séparée). L'ancien lien par code de retrait (`/retrait/#<code>`, `/api/retrait/<code>`) reste reconnu.
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

## Habillage de campagne (parcours.habillage)
Une campagne peut prendre l'allure de sa marque sans une ligne de code propre à la marque : tout est dans le parcours,
versionné et validé par le client comme le reste. Clés (toutes facultatives, contrôlées par `validerHabillage`) :
- `polices` : `titres` et `texte` parmi `fredoka`, `gabarito`, `michroma`, `inter`, `barlow-condensed`, `barlow` (auto-hébergées, OFL). Une police
  de titre très large (Michroma) est dessinée plus petite et en graisse normale ; boutons et saisie restent dans la
  police du texte.
- `titresMajuscules` : titres, questions, options et cartes du Parlomix en capitales.
- `couleurs` : `marque` (accent : cases, repères, boutons secondaires), `bulle` (fond des bulles de la marque ;
  ombre douce si elle est claire), `visiteur` (bulles et actions du visiteur), `fond`, `texte`. Elles l'emportent sur
  la fiche client pour cette campagne.
- `fonds` (8 au plus) : `{ id, nom?, couleur, couleurBas?, texte }` (à ne pas confondre avec `parcours.ambiance`, le style général « conversation » ou « pop »). Une étape (`fond`) ou une option de choix prend
  ce fond (couleur ou dégradé vertical) ; le texte posé dessus suit `texte`, celui des surfaces blanches (cartes,
  clavier, options) reste à l'encre.
- `visuels` (12 au plus, 40 000 caractères chacun) : `{ id, nom, svg }`, SVG autonome affiché comme une image
  (`data:` dans une balise `img` : aucun script n'y tourne) ; le serveur refuse en plus scripts, gestionnaires
  d'événements, liens et ressources externes. Une étape ou une option affiche `visuel` ; la valeur réservée
  `"choix"` affiche le visuel de la dernière option choisie qui en a un (ex. le modèle que le visiteur a désigné).
- `parlomix` (12/10/2026) : `{ ouverture?, jingle?, fond?, visuel? }`. `ouverture` : titre de la carte d'ouverture
  du Parlomix par personne, 60 caractères au plus, `{prenom}` remplacé (ex. « Le Salon de l'auto de {prenom} ») ;
  `jingle` : `parlobox` (par défaut) ou `turbo` ; `fond` et `visuel` : ceux de la carte d'ouverture, parmi les
  `fonds` et `visuels` de l'habillage. Ne touche que le montage, jamais l'écran de la cabine.
Sans logo, l'en-tête d'une campagne habillée affiche le nom de la marque dans la police des titres.
Références : `fixtures/parcours-geely.json` (première campagne habillée, silhouettes de voitures dessinées par WhyMe,
à remplacer par les visuels officiels de la marque) ; `fixtures/parcours-pfa.json` (Fabrique de l'Innovation, Mondial
de l'Auto 2026 : Barlow, dégradé rouge-indigo, rayons et voiture au trait, disposition centrée, Parlomix « turbo »).

## Réglages généraux du parcours
- `ambiance` : `conversation` (par défaut), `pop` ou `marine` (voir plus bas).
- `tutoiement` : textes fixes de la cabine au tutoiement ; les textes légaux restent au vouvoiement.
- `disposition` (12/10/2026) : `cote` (par défaut) ou `centree`, voir « Disposition centrée » plus bas.

## Choix des visiteurs (migration `0005_choix.sql`)
Les étapes `choix` servent d'embranchement **et** de qualification (« vous connaissiez la marque ? », modèle
désigné). La cabine envoie chaque choix par la file d'envoi (`PUT /api/cabine/sessions/:id/choix/:etape`,
idempotent, après la session ; un choix fait avant l'accord part avec la session). Parlorama les montre par visiteur,
filtre les visiteurs par choix, affiche leur répartition, et l'export ajoute une colonne par étape « choix ».
Ce que la personne a déclaré, jamais une note ni un profil calculé. Supprimés avec ses réponses en cas de retrait.
La progression « question N sur M » suit le chemin le plus court : une suite facultative (revenir après un essai)
ne gonfle pas le total.

## Parcours de démonstration et direction artistique
- `fixtures/parcours-demo.json` : parcours **neutre Parlobox**, base vendue puis personnalisée par marque.
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
- **Ambiance** (réglage du parcours, `"ambiance"`) : `conversation` (par défaut, ci-dessus), `pop` ou `marine` (festif, esprit BD :
  contours d'encre, ombres franches, trame de points, bulles de travers, rayons à l'accueil, confettis à la fin ;
  rose `#FF5C93`, jaune `#FFD23F`, cyan `#3EC1F3` en décor, papier crème). Tout est en CSS (`:root[data-ambiance="pop"]`),
  les couleurs d'une marque restent prioritaires. Exemple : `fixtures/parcours-fabrice.json`.
  Troisième ambiance, `marine` (10/10/2026) : bord de mer et impertinence. Nuit marine `#0F2B46`, orange bouée
  `#FF6B3D` pour la cabine, jaune ciré `#FFD23F` pour le visiteur, écume `#F6F1E6` pour le texte et les cartes,
  turquoise `#3FA7C9` en décor. Deux rangs de vagues roulent en bas de chaque écran (masque SVG en ligne, plus hautes
  à l'accueil et à la fin), mouettes à l'accueil, écume qui monte à la fin, fanions pour le surtitre et les titres
  courts, bouée pour le compte à rebours, phrase de sortie soulignée d'une vague. Le décor reste visible sur une
  campagne habillée. Exemple : `fixtures/parcours-alexandre.json` (visuels SVG kite, gamelle, coupe, manche à air,
  bouteille). Le Parlomix prend les couleurs de l'ambiance quand la marque n'en impose pas
  (`themeDepuisCouleurs(couleurs, habillage, ambiance)`, ambiance renvoyée avec les sessions).
- **Visuel de question** : affiché à côté de la caméra en paysage ; une question qui a à la fois des pistes et un coup de
  pouce n'a plus la place de l'afficher sur la cabine (il reste sur les cartes du Parlomix).
- **Tutoiement** (`"tutoiement": true`) : les textes fixes de la cabine passent au tutoiement (prénom, accord, « On t'écoute… »).
  Les textes légaux restent au vouvoiement ; le texte de consentement cite le bouton « C'est parti », à garder tel quel.
  Les deux réglages se font dans l'éditeur (panneau « Réglages »).

## Parlorama, l'espace de gestion (`/admin/`)
Une page sans compilation (`public/admin/`), même direction artistique, protégée par Cloudflare Access.
- **Chiffres de la campagne** (en tête de la page de campagne) : stockage total (vidéos des réponses, Parlomix,
  miniatures), nombre de réponses et durée filmée, taille moyenne par réponse et par minute filmée
  (`GET /api/espace/campagnes/:id/volume`, `src/volumes.ts`). Taille notée à chaque envoi (migration
  `0006_volumes.sql`) ; les fichiers plus anciens sont mesurés après coup par les métadonnées du stockage, 150 par
  affichage. La liste des campagnes de WhyMe affiche aussi le stockage de chacune. Unités de 1 000 (Mo, Go).
- **Onglet resté ouvert pendant un déploiement** : chaque réponse de l'API porte l'en-tête `x-parlorama-version`
  (identifiant du déploiement, liaison `version_metadata`). Parlorama renvoie la version qu'il a chargée ; dès qu'elle
  change, un bandeau demande de recharger, et toute modification (`/api/admin`, `/api/espace`, hors GET) venant de
  l'ancienne page est refusée en 409 `parlorama_perime`. Leçon du 10/10/2026 : un ancien éditeur, qui ne connaissait
  pas l'habillage, signalait 42 « erreurs » sur un parcours valide. Sans en-tête (scripts, tests), rien n'est vérifié.
- WhyMe : tableau de bord (campagnes, cabines en ligne, visiteurs, vidéos), campagnes (statut, parcours lisible et
  nouvelle version en JSON, textes de consentement), réponses vidéo par visiteur ou par question, cabines (état,
  affectation, code d'appairage), clients, comptes, journal.
- Comptes client : leurs campagnes et leurs réponses uniquement, validation des questions et des textes.
- Vidéos : `GET /api/espace/reponses/:id/video`, droit `reponses.lire`, cloisonnement par client,
  **chaque visionnage est journalisé** ; plus rien n'est servi si le visiteur a retiré son accord. Lecture en continu
  (requêtes partielles « Range ») ; un seul visionnage journalisé par lecture.
- Modifier et supprimer : fiches client (couleurs, logo PNG/JPEG/WebP envoyé dans R2 et servi publiquement par
  `/api/cabine/logo/<client>.<ext>`, SVG refusé), rôle des comptes, nom/dates/conservation des campagnes (durée figée
  une fois active ; la changer régénère les textes et remet en brouillon), renommer une campagne close, suppression d'un brouillon sans visiteur ou d'une campagne close avec toutes ses données (vidéos, miniatures, Parlomix, visiteurs ; journalisée),
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
  plan (ouverture, réponses séparées par une carte animée et le jingle, fin), recadrage 9:16, **jingles composés par
  le code**, propriété de WhyMe : `parlobox` (quatre notes de marimba et une bulle, 1,1 s) et `turbo` (12/10/2026,
  pour l'automobile : moteur qui monte en régime, souffle, arpège électro sur grosse caisse à 150 bpm, accord final ;
  3 s à l'ouverture, qui dure alors 3 s, et 0,9 s entre les réponses). Bruit pseudo-aléatoire à graine fixe : le
  même jingle à chaque montage.
- `public/admin/js/montage/rendu.js` : canevas + MediaRecorder, MP4 si le navigateur sait (sinon WebM), coupes
  franches (enregistrement en pause pendant les recherches), cartes et bandeaux aux couleurs du client, limiteur
  sur le son, vérification que le film contient du son (sinon nouveau montage en WebM : leçon Geely).
- API (`src/routes/parlomix.ts`, migration `0002_parlomix.sql`) : le plan est vérifié (réponses de la campagne,
  même question, même cabine, personnes n'ayant pas retiré leur accord), le film est stocké dans R2, chaque
  visionnage est journalisé. **Dès qu'une personne montée retire son accord, le Parlomix n'est plus servi.**
  « Diffusable » seulement si toutes les personnes montées ont accepté la diffusion publique.
- **Habillage** : le thème du film reprend celui de la campagne (`themeDepuisCouleurs(couleurs, habillage)`) :
  polices, capitales, couleur des bulles, et pour chaque carte le fond de la question qui suit. L'ouverture
  d'un Parlomix par personne montre le visuel de son choix (le modèle désigné) ; dans un Parlomix par question,
  chaque transition montre celui de la personne. Le plan ne garde que les identifiants : les visuels sont chargés
  depuis l'habillage au moment du rendu. `habillage.parlomix` peut imposer le titre (`titreOuverture`), le jingle,
  le fond et le visuel de l'ouverture.
- Limites : le film se fabrique en temps réel (onglet ouvert et visible), 95 Mo au plus par film.

## Écran de question V2 : la base de toutes les ambiances (10/10/2026)
- La marque parle à gauche : surtitre, question (taille de l'habillage, modulée par la longueur du texte), idées
  (pistes), amorce (« Pour démarrer », bulle du visiteur qui pointe vers l'image), visuel éventuel.
- Le visiteur répond à droite : une seule ligne de temps (« Prenez le temps de lire », puis l'onde et « On vous
  écoute… » avec la barre et les secondes restantes), son image en 4:3, le bouton juste dessous. Le compte à rebours
  s'affiche dans l'image ; avant la prise, le bouton n'est qu'un contour en pointillés.
- Portrait : la même suite empilée, image en 3:4.
- **Un nouveau thème ne touche pas à la disposition** : il passe par les jetons de couleur, les polices, l'ambiance
  (`conversation`, `pop`, `marine`…) et les visuels de l'habillage. Maquettes : canevas « Parlobox : direction
  artistique », lignes V2.

## Disposition centrée des questions (12/10/2026)
Option du parcours (`"disposition": "centree"`), en paysage seulement ; le portrait garde la suite empilée.
- Constat au Mondial de l'Auto : avec la question à gauche et l'image à droite, l'œil fait des allers-retours entre
  la question, l'image et l'objectif (en haut au centre de la tablette) ; en relisant, le visiteur regarde de côté.
- La question en haut au centre, juste sous l'objectif ; l'image centrée dessous, le bouton à sa droite.
  `.ecran-question[data-phase]` : `lire` (question en grand, image voilée avec le compte à rebours), puis `rec`
  (question resserrée sur une ligne, sans étiquette ni intitulé, image plus grande : environ 575 × 430 au lieu de
  476 × 357 sur une tablette 1280 × 720). La question ne change pas de place entre les deux phases.
- Pendant la lecture, le bouton « Je suis prêt » démarre la prise sans attendre la fin du compte à rebours.
- Largeur de l'image calculée sur la hauteur disponible (`--hors-camera` par phase), pas en pourcentage : une
  colonne de grille « auto » n'a pas de base pour un pourcentage.
- Maquettes des trois options étudiées (côte à côte avec lecture allongée, centrée, sous-titre sur l'image) : canevas
  « Parlobox × Fabrique de l'Innovation PFA ».

## Purge à échéance (11/10/2026)
Les textes acceptés par le visiteur promettent la suppression de ses vidéos au bout de la durée de conservation de la
campagne. Chaque session porte sa date (`sessions.purge_prevue_le`, fixée à sa création ; la durée ne change plus
une fois la campagne active). La tâche planifiée (toutes les 5 minutes) purge les sessions échues par paquets de 40
(`src/rgpd/purge.ts`) : vidéos, miniatures et Parlomix où la personne figure (stockage d'abord), puis réponses,
transcriptions, thèmes classés et choix (`effacementSession`, partagé avec le retrait d'accord). Il reste une trace
anonyme (`prenom = '(supprimé)'`, `purgee_le`) et une ligne de journal `session.purge` sans prénom. Une session en
échec (stockage indisponible) est reprise au passage suivant. Une vidéo renvoyée plus tard par une tablette restée
hors ligne est refusée (410). Parlorama affiche sur la campagne la prochaine suppression automatique et le nombre de
visiteurs concernés dans les 30 jours. Why me a sa propre purge (`src/whyme/taches.ts`).

## Alertes d'exploitation (11/10/2026)
Ce qui empêche une cabine de bien recueillir les avis, détecté pendant l'événement (`src/exploitation/alertes.ts`,
migration `0011_alertes_exploitation.sql`, tâche planifiée toutes les 5 minutes) : cabine d'une campagne active sans
signe de vie depuis 10 min (mais vue dans les 12 h : sinon elle est rangée), batterie sous 20 % hors charge, file
d'envoi d'au moins 10 éléments, micro inaccessible, au moins 2 des 6 dernières vidéos d'une cabine sans voix détectée
(leçon Geely), transcriptions ou classements abandonnés en 24 h (option Analyse). Une alerte s'ouvre une fois, se
met à jour, se ferme seule quand le problème disparaît (seuils dans `SEUILS`). À l'ouverture, un e-mail groupé part aux
comptes WhyMe (ADMIN_EMAILS et comptes admin/opérateur actifs) dès que Brevo est configuré ; sinon l'alerte reste dans
le tableau de bord de Parlorama, et sera signalée par e-mail à la mise en place de Brevo si elle est toujours ouverte.
« Je m'en occupe » note qui la prend en charge. Aucune donnée personnelle.

## Option Analyse, lot 1 : transcription (11/10/2026)
Décisions : note `parlobox-note-demarrage-reporting.md` du projet. L'analyse des propos est une **option vendue
campagne par campagne** ; Mistral AI (UE) est le seul sous-traitant pour toute la chaîne (Voxtral pour la
transcription, Mistral Large 3 pour le classement au lot 2).
- **Réglage** (migration `0009_option_analyse.sql`) : `campagnes.option_analyse`, modifiable seulement avant
  l'activation (comme la durée de conservation : elle figure dans les textes). L'activer ou la retirer régénère les
  textes (`MENTION_ANALYSE`, `src/rgpd/consentement.ts`) et remet la campagne en brouillon. Un texte rédigé à la main
  doit parler de transcription et d'analyse. `consentement_versions.analyse` dit si une version l'annonce ; une
  campagne avec l'option ne se valide pas sans elle. `campagnes.vocabulaire` (100 termes au plus, modifiable en cours
  de campagne) aide à reconnaître les noms de modèles.
- **Quand transcrire** : une réponse est mise « à faire » à sa réception si la campagne a l'option **et** si la version
  des textes acceptée par le visiteur l'annonce (pas de rétroactivité), sauf si la tablette n'a détecté aucune voix.
  L'envoi part après la réponse à la tablette (`waitUntil`) ; une tâche planifiée toutes les 5 minutes reprend les
  réponses à faire ou bloquées (`src/analyse/transcription.ts`). Réservation `a_faire → en_cours` : un seul envoi par
  réponse ; 3 essais au plus ; nouvelle vérification au moment d'envoyer (accord retiré, option retirée → rien ne part).
- **Service** (`src/analyse/mistral.ts`) : `POST https://api.mistral.ai/v1/audio/transcriptions`, modèle
  `voxtral-mini-latest`, fichier de la cabine tel quel (pas besoin du traitement vidéo), horodatage au mot, langue
  détectée (non imposable avec l'horodatage). Sans secret `MISTRAL_API_KEY`, rien n'est envoyé.
- **Données** : le texte va dans `reponses.transcription`, les mots horodatés dans `transcription_segments`
  (`[{ d, f, t }]`). Ils vivent dans la ligne de la réponse : un retrait d'accord ou la suppression de la campagne les
  efface avec elle ; un nouvel envoi de la vidéo les remet à faire. La liste des sessions ne donne que l'état ; le texte
  se lit par `GET /api/espace/reponses/:id/transcription`, même périmètre que la vidéo, **chaque lecture journalisée**.
- **Parlorama** : case « Option Analyse » et vocabulaire dans « Modifier » ; sous chaque vidéo, état (« en cours »,
  « impossible ») ou bouton « Lire la transcription » (lignes horodatées ; un clic place la vidéo à ce moment).
- Reste à faire : la transcription dans la page du visiteur (`/retrait/`) et dans la purge à échéance (quand elle
  existera).

## Option Analyse, lot 2 : thèmes, tonalité, direct et alertes (11/10/2026)
- **Grille de thèmes** (`campagnes.grille_themes`, migration `0010_analyse_themes.sql`) : 15 thèmes au plus, libellé et
  description facultative ; réglée par WhyMe avec la marque (Parlorama > Modifier, « Libellé : ce qu'il couvre »).
  Modifiable en cours de campagne : les réponses déjà transcrites sont reclassées. Sans grille : transcription seule.
- **Classement** (`src/analyse/classement.ts`) : juste après la transcription (même `waitUntil`), puis reprise planifiée.
  Mistral Large 3 (`mistral-large-latest`, JSON, température 0) reçoit la question et le texte, jamais la vidéo ni la
  voix. La consigne interdit tout jugement sur la personne et traite le texte comme une donnée. La sortie est
  contrôlée : thèmes de la grille seulement, tonalité `positif | neutre | negatif`, extrait gardé seulement s'il est
  recopié exactement, puis situé dans les mots horodatés (`reponse_themes.debut/fin`). En plus : `autre_sujet` (hors
  grille) et `alerte` (insatisfaction forte et explicite) avec son motif. 3 essais au plus ; un nouvel envoi de la
  vidéo efface le classement ; `reponse_themes` est effacée avec la réponse (retrait d'accord, suppression).
- **La marque voit le classement dès qu'il est fait** (décision du 11/10/2026), pas de relecture préalable par WhyMe.
- **Vues** (`src/routes/analyse.ts`, onglet « Analyse » de Parlorama, `public/admin/js/analyse.js`), droit
  `reponses.lire`, cloisonnement par client, chaque consultation qui montre des propos journalisée :
  - « Par question » : de quoi parlent les gens, tonalité par thème (nombres ; pourcentages à partir de 30 propos),
    verbatims représentatifs (un par tonalité présente, sans doublon, qui ouvrent la vidéo au bon moment).
    **Ouvert à partir de 100 visiteurs** par défaut (`SEUIL_VISITEURS`), réglable par campagne entre 20 et 1000
    (`campagnes.seuil_analyse`, migration `0014_seuil_analyse.sql`, Parlorama > Modifier, journalisé ; modifiable en
    cours de campagne car absent des textes acceptés) ; en dessous, une jauge et l'avancement par question.
  - « Recherche par thèmes » : propos d'un thème, filtrables par tonalité, question et mots. Dès la première réponse.
  - « Aujourd'hui en direct » (heure de Paris, actualisé chaque minute) : visiteurs du jour et par heure, derniers
    propos, sujets qui montent (mentions du jour contre la moyenne des jours précédents), alertes du jour et alertes
    non vues (« Marquer comme vue », journalisé), état des cabines. Dès la première réponse.

## Format de captation (décision du 10/10/2026, en place)
- **On filme en 4:3** : 1280 × 960 en paysage, 960 × 1280 (3:4) en portrait, à 2,5 Mb/s comme aujourd'hui (taille des
  fichiers inchangée, environ 19 Mo par minute).
- Pourquoi : les capteurs des caméras frontales de tablette sont en 4:3 ; le 16:9 n'en est qu'un recadrage, qui
  enlève un quart de la hauteur (front et menton coupés dès qu'on bouge). Le 4:3 donne aussi plus de matière au
  Parlomix 9:16 (bande de 540 × 960 au lieu de 405 × 720, soit 78 % de pixels en plus).
- L'aperçu de la cabine est au même format : **ce qui est montré est exactement ce qui est enregistré** (pas de zone
  filmée cachée, ce qui compte pour le consentement).
- Parlomix 16:9 : recadrage en hauteur, décalé vers le haut pour garder le visage. 9:16 : bande centrée sur le visage
  (existant).
- Si une tablette ne fournit pas de 4:3, on enregistre ce qu'elle donne et l'aperçu montre l'image entière (bandes
  plutôt que zone cachée). À vérifier sur la vraie tablette.

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
  miniature de chaque réponse, rappel du QR code extérieur sur l'écran de fin (retour à l'accueil après 20 s par défaut) ;
  - **écran de cadrage** (12/10/2026) : ovale du visage et ligne des épaules (`#guide-cadrage`, dans l'aperçu,
    au-dessus de l'image et du flou), affiché seulement sur cet écran. Repères comme pour Why me : « Lumière »
    (image assez claire, pas de contre-jour, sur une image réduite à 48 × 36), « Son : dis bonjour » (vumètre), et
    « Visage dans l'ovale » si le navigateur a `FaceDetector`. Chaque repère passe au vert, l'ovale aussi quand tout
    est bon. Rien n'est bloquant. (L'ovale annoncé par le texte manquait depuis le passage du prototype Geely.)
  - **rechargement automatique** (version 0.4.0) : l'API renvoie l'identifiant du déploiement (`x-parlorama-version`) ;
    quand il change, la cabine se recharge entre deux visiteurs (au plus 5 minutes après la mise en ligne). Une
    tablette en mode kiosque ne recharge jamais sa page d'elle-même. `VERSION` de `app.js` est envoyée dans le
    signal de vie : l'augmenter à chaque changement de la cabine ;
- `qr.js` : générateur de QR code (mode octets, correction M, versions 1 à 10), vérifié par décodage OpenCV dans les tests ;
  plus utilisé par l'écran de fin, gardé pour produire le QR code de l'affiche extérieure.
La session est créée par la tablette (UUID) pour fonctionner hors ligne ; l'envoi est idempotent.

## Déploiement et accès (réglé le 12/10/2026)
- Workers Builds : `main` déploie le test, la branche `production` déploie `app.parlobox.com`. Les migrations D1 restent
  manuelles, appliquées avant le code qui en dépend (`docs/exploitation.md`, « Livrer une version »).
- Cloudflare Access protège tout l'hôte ; la cabine et le retrait passent par une application d'exception séparée
  (ouverte en test, pas encore en production). Détail dans `docs/exploitation.md`, « Cloudflare Access ».
- Traitement vidéo côté serveur : Cloudflare Containers, déjà utilisé par Why me (`voxbox-montage`) ; à brancher pour
  Parlomix.
