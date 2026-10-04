# Billard anglais

Billard anglais (blackball) jouable dans le navigateur, à **2 ou 3 joueurs** sur le même écran (souris, tactile ou clavier).
À trois joueurs, une troisième couleur entre en jeu : rouges, jaunes et bleues.

- Physique 2D maison : chocs entre billes, bandes, mâchoires et poches, coulé / rétro.
- Règles du pub anglais : table ouverte après la casse, deux coups après une faute, bille en main derrière la ligne de baulk.
- Ligne de visée avec bille fantôme et direction de la bille visée (rose si la bille est interdite).
- Table tournée automatiquement en portrait sur téléphone.
- Aucune dépendance d'exécution : TypeScript compilé en modules ES, servi par nginx.

## Règles retenues

| | 2 joueurs | 3 joueurs |
|---|---|---|
| Billes | 7 rouges, 7 jaunes, la noire | 4 rouges, 4 jaunes, 4 bleues, la noire |
| Attribution | la 1re bille rentrée sans faute après la casse donne sa couleur ; l'autre joueur reçoit l'autre | idem ; la dernière couleur revient automatiquement au dernier joueur sans couleur |
| Noire trop tôt ou avec faute | défaite | le joueur est éliminé, ses billes quittent la table, la noire est replacée |

Fautes : blanche empochée, aucune bille touchée, première bille touchée qui n'est pas la sienne (ou pas la noire quand on la joue),
bille d'un autre joueur empochée. Après une faute le joueur suivant a deux coups ; rentrer une bille ne consomme pas de coup.
Une noire rentrée à la casse est replacée sans pénalité.

Le moteur de règles est un module pur (`src/game/rules.ts`) couvert par des tests : pour changer une règle, c'est là.

## Développement

Node 22 suffit, la seule dépendance de développement est TypeScript.

```bash
npm ci
npm run dev        # build + rechargement à chaque modification, http://localhost:5173
npm test           # tests unitaires (règles, physique, parties complètes simulées)
npm run build      # site statique dans dist/
npm run preview    # sert dist/ sur http://localhost:4173
```

Ajouter `?debug` à l'URL expose `window.__billard` (partie en cours) pour les tests de bout en bout.

```
src/game/     physique, table, triangle, règles, orchestration d'une partie (sans DOM)
src/render/   rendu canvas et transformation monde ↔ écran
src/ui/       commandes, bandeau des joueurs, sons synthétisés
web/          index.html et styles
public/       favicon, manifeste
tests/        tests node:test
deploy/       configuration nginx et exemple de Traefik
```

## Déploiement avec Traefik

L'image est un nginx non root qui écoute sur le port 8080, avec un healthcheck sur `/healthz`, en-têtes de sécurité (CSP stricte)
et cache immuable des fichiers versionnés.

Sur le serveur, avec un Traefik déjà en place sur un réseau Docker externe :

```bash
cp .env.example .env     # DOMAIN, IMAGE (ghcr.io/<owner>/billard-anglais), TAG, réseau / entrypoint / certresolver Traefik
docker compose pull
docker compose up -d
```

Le conteneur tourne en lecture seule, sans capacités, limité à 64 Mo. Pour construire l'image sur place plutôt que la tirer :
`docker compose up -d --build`.

Pas encore de Traefik ? `deploy/traefik/compose.yaml` en démarre un minimal (Let's Encrypt en challenge HTTP) :

```bash
docker network create traefik
ACME_EMAIL=vous@exemple.fr docker compose -f deploy/traefik/compose.yaml up -d
```

Si le domaine passe par le proxy Cloudflare, le challenge HTTP peut échouer : utilisez un challenge DNS dans Traefik ou le mode SSL « Full (strict) ».

## Releases

Pousser un tag publie tout automatiquement :

```bash
git tag v1.0.0
git push origin v1.0.0
```

Le workflow `release.yml` :

1. lance les tests et construit le site ;
2. publie l'image multi-architecture (amd64 et arm64) sur `ghcr.io/<owner>/billard-anglais` avec les tags `1.0.0`, `1.0`, `1` et `latest` ;
3. crée la release GitHub avec l'archive `billard-anglais-v1.0.0-web.zip` (le site statique, servable par n'importe quel serveur web).

Le workflow `ci.yml` vérifie chaque push et pull request : typage, tests, build, puis construction de l'image et test de fumée
(healthcheck, CSP, cache des assets).

Au premier push, l'image GHCR est privée : la rendre publique dans les réglages du paquet, ou faire un `docker login ghcr.io` sur le serveur.
