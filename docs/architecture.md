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
- **Lien de retrait** : public, à venir.
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

## Cabine (tablette)
Page `public/cabine/`, sans compilation ni dépendance :
- `moteur.js` : déroulé du parcours (logique pure, testée avec Node) ;
- `clavier.js` : clavier dessiné dans la page, aucun champ natif (ni clavier système, ni saisie automatique) ;
- `enregistreur.js` : WebM + Opus uniquement, vumètre, arrêt après N s de silence une fois la parole commencée,
  « son présent » si au moins 0,6 s de voix ;
- `flou.js` : flou doux elliptique, irréversible (réduction forte puis flou), détection intégrée au navigateur ;
  sans détecteur, toute l'image est floutée ;
- `file-envoi.js` : file IndexedDB strictement ordonnée (session puis vidéos), reprise après coupure ;
- `app.js` : écrans, pauses avant/après (reprise par le prénom, 12 h max), inactivité 90 s, signal de vie.
La session est créée par la tablette (UUID) pour fonctionner hors ligne ; l'envoi est idempotent.

## Points à vérifier (lot 0)
- Déploiement automatique depuis GitHub (Workers Builds) et application des migrations D1 dans ce cadre.
- Protection Access limitée aux chemins des espaces (la cabine et le retrait doivent rester publics).
- Traitement vidéo : Cloudflare Containers (offre payante ~5 $/mois) ou petit serveur UE.
