# Why me (JobBox smartphone, usages RH)

Interview vidéo du candidat **sur son propre téléphone**, dans la JobBox (QR code de la campagne) ou en digital pur
(même lien). Produit distinct de Parlopop sur la même plateforme : même Worker, même base, même stockage, même
journal ; tables `wm_*` et `rh_equipe`, routes `/api/whyme`, `/api/recruteur`, `/api/montage`, `/api/rh`.
**Univers séparé de Parlopop** (12/10/2026) : back-office `/rh/` avec ses propres comptes (`rh_equipe`, amorçage par
`RH_ADMIN_EMAILS`) ; un compte Parlorama n'ouvre pas l'espace RH, un compte RH n'ouvre pas Parlorama, et Parlorama ne
montre plus rien de Why me.
Note de cadrage : projet « vox-boxes », `claude/whyme-jobbox-note-cadrage.md` (version 4, validée le 11/10/2026).

## Règles (non négociables)
- **Aucune IA, aucune note** : ni transcription, ni résumé, ni score. Le signal humain et la spontanéité d'abord.
- Rushes (prises par question) **effacés dès que le montage est prêt** ; le recruteur ne voit que le montage.
- Recruteurs : candidatures de **leur entreprise** seulement, **12 mois**, chaque lecture et téléchargement journalisés.
- Page publique : seulement avec l'accord du candidat, **24 mois** ; le candidat ne télécharge pas sa vidéo.
- Le candidat **supprime sa vidéo** depuis l'e-mail : elle disparaît partout (page publique et recruteurs) ;
  ou toutes ses données. Interview jamais terminée : effacée après 30 jours.
- Âge affiché sur la vidéo par défaut (`ageAffiche`, désactivable par campagne), annoncé au candidat avant ;
  âge minimum par campagne (15 ans par défaut).
- Tout est en **9:16** (720 × 1280). Aucun traceur tiers dans le parcours.

## Parcours candidat (`/i/<code>` → `public/whyme/candidat/`, `public/whyme/js/candidat.js`)
Accueil → CV facultatif (PDF ou Word, 5 Mo) → prénom, nom, e-mail (message de vigilance), âge → famille de postes
→ entreprises (une, plusieurs, « tout sélectionner ») → accords (candidature obligatoire, page publique facultative,
textes versionnés par empreinte) → téléphone posé (caméra, micro, écran maintenu allumé) → cadrage (lumière, son,
visage si le navigateur sait le détecter ; jamais bloquant au-delà de 25 s) → question d'essai (jamais envoyée) →
questions : lecture, enregistrement, puis « On garde » / « Je veux la revoir » (gardée seule au bout de
`validationAutoSec`), après revisionnage « Je garde » / « Je refais » (une reprise par question) → envoi → fin
(« ta vidéo arrive par e-mail », aucun montage montré).
- Enregistrement (`capture.js`) : WebM (VP9/VP8 + Opus) en priorité, MP4 seulement si le WebM n'existe pas (iPhone).
- File d'envoi (`envoi.js`) : IndexedDB, reprise après coupure ou rechargement. Jeton dans l'en-tête `x-jeton`.
- Reprise : même téléphone (stockage local) ou lien de l'e-mail `#reprise=<id>.<jeton>` (envoyé après 15 min
  d'inactivité ; le lien porte un nouveau jeton).

## Montage (`src/whyme/montage.ts` + service `montage/`)
Interview terminée → la plateforme appelle `POST /monter` du service (liaison interne `MONTAGE_SERVICE`, ou `MONTAGE_URL` hors Cloudflare) → le service lit le plan
(`/api/montage/travaux/:id`) et les prises, monte avec ffmpeg (pour chaque question, un plan de 3 s
qui la rappelle comme un message reçu : points « en train d'écrire », puis bulle fuchsia avec la question (ou son
titre court si elle dépasse 80 caractères) et une signature sonore discrète de deux notes montantes ; puis la
réponse sans ses blancs, logo et « prénom, âge » à l'image ; ni ouverture ni fermeture), renvoie miniature puis
film → finalisation : rushes effacés, candidatures transmises, e-mail. Secret partagé `MONTAGE_CLE`, qui ne circule
jamais : chaque requête est signée (HMAC horodaté, 5 min, en-tête `x-montage-signature`, `montage/signature.ts`),
car les journaux Cloudflare enregistrent les en-têtes ; le service n'appelle que les plateformes listées dans `MONTAGE_API_AUTORISEES`.
Conteneur : `montage/Dockerfile`, Worker `montage/worker.ts`, `montage/wrangler.jsonc` (juridiction UE).

## E-mails (`src/whyme/courriels.ts`)
Vidéo prête (entreprises nommées, bouton « Voir ma vidéo », sticker QR code PNG, « Tu gardes la main »), reprise,
connexion recruteur. Tous gardés 7 jours dans `wm_courriels` ; envoyés par Brevo si `BREVO_CLE` est configuré.

## Clients et sous-clients (12/10/2026)
- **Client** (`wm_clients`) : celui qui commande la campagne, ex. la PFA au Mondial de l'Auto. Toute campagne est
  rattachée à un client avant d'ouvrir (modifiable à tout moment). Ses **contacts** (`wm_contacts_client`) ne voient
  que des **statistiques agrégées** de ses campagnes (commencées, terminées, transmises, candidatures par entreprise,
  par famille de métiers, par jour) : jamais une identité, une vidéo ni un CV. Le candidat postule chez les
  entreprises, pas chez le client : rien à ajouter à son consentement.
- **Sous-clients** : les entreprises recruteuses (`wm_entreprises`), une fiche **commune** à toutes les campagnes et
  à tous les clients. Les recruteurs d'une entreprise voient dans un seul espace les candidats de toutes les
  campagnes où elle participe.
- Une adresse e-mail = un seul compte partenaire (recruteur ou contact client).

## Espace partenaires (`/recruteur/`)
Lien de connexion par e-mail (15 min, usage unique, 3 demandes par heure), session de 12 h. Le même espace sert :
- au **recruteur** : liste, filtres (événement, métier, nom), lecture et téléchargement de la vidéo, CV ;
- au **contact client** (« Espace organisateur ») : statistiques de ses campagnes (`/api/recruteur/statistiques`).
L'adresse reste `/recruteur/` pour ne pas toucher aux chemins publics Access ; à renommer avec le domaine dédié.

## Espace RH (`/rh/`, équipe RH, derrière Cloudflare Access)
Campagnes (client, configuration JSON, modèle `fixtures/whyme-campagne-demo.json`, QR code, ouverture/clôture, suivi
des interviews, relance du montage, statistiques telles que les voit le client), clients et contacts, entreprises et
logos, recruteurs, e-mails (renvoi possible), équipe (administrateurs : `admin_rh` ; opérateurs : `operateur_rh`, sans
gestion de l'équipe).

## Tâches planifiées (cron, toutes les 5 minutes, `src/whyme/taches.ts`)
Relance des montages (3 essais), e-mails de reprise, purges (30 jours, 12 et 24 mois), CV effacé à la fin de l'accès
des recruteurs, e-mails et jetons échus.

## Vérifier
```
npm run check
npm run e2e:whyme -- <voix.wav> <camera.y4m> <dossier-captures>   # téléphone simulé + vrai montage ffmpeg
```
La voix de test doit ressembler à de la parole (syllabes) : un son continu est atténué par la réduction de bruit du
navigateur et passe pour du silence.

## Éditeur de campagne et vidéos (espace RH, 12/10/2026)
- **Éditeur** (page d'une campagne, `public/rh/js/editeur-campagne.js`) : événement et accueil, question d'essai,
  questions (3 à 5 : ajouter, déplacer, dupliquer, supprimer ; texte, titre court, lecture, durée), entreprises
  proposées, familles de métiers, réglages (âge affiché, âge minimum, « On garde » automatique), mode expert JSON.
  Modifiable en brouillon seulement. Vérification par le serveur (`POST /api/rh/campagnes/verifier`, mêmes règles
  qu'à l'enregistrement). Aperçu en direct : l'écran du téléphone et la bulle du plan « question » du film (la
  question si elle tient en 80 caractères, sinon son titre court).
- **Essayer le parcours** : `POST /api/rh/campagnes/apercu` renvoie ce que recevrait le téléphone ; l'éditeur le
  dépose dans le navigateur et ouvre `/i/apercu` : le vrai parcours, caméra comprise, sans aucun envoi
  (bandeau « Aperçu · rien n'est enregistré »). Le code `apercu` est réservé.
- **Vidéos** : onglet Vidéos (toutes campagnes, recherche, filtre) et galerie dans chaque campagne ; vignettes 9:16,
  lecture dans une fenêtre, CV et page publique. `GET /api/rh/videos`, `/api/rh/candidats/:id/miniature|video|cv`
  (lecture de la vidéo et du CV journalisées).

## Repasse ergonomique de l'espace RH (12/10/2026)
- Un seul menu (barre latérale) : Campagnes, Vidéos, Clients, Entreprises et recruteurs (fusionnés), E-mails, Équipe.
- Création de campagne en trois questions (client, avec création du client sur place ; nom ; événement) ; les
  entreprises et le questionnaire se règlent ensuite sur la page de la campagne. Les entreprises ne sont exigées
  qu'à l'ouverture, et ce qui manque est dit avant le clic (bandeau d'état).
- Page d'une campagne : statut et actions à double confirmation en haut (Ouvrir, Repasser en brouillon, Clore,
  Rouvrir, Supprimer un brouillon sans interview), onglets Questionnaire, Interviews et vidéos, Lien et QR code,
  Statistiques du client.
- Une adresse e-mail saisie comme nom de client ou d'entreprise est refusée (confusion avec contacts et
  recruteurs). Clients et entreprises qui n'ont servi à rien se suppriment.
- Corrigé : après une action réussie (ajout d'entreprise, de client, de contact, de recruteur, d'un membre de
  l'équipe), la page affichait « … is not a function » : la fonction de la page était masquée par une variable du
  même nom. Les pages s'appellent désormais pageClients, pageEntreprises, etc.
