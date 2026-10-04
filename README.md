# Billard anglais

Billard anglais (blackball) jouable dans le navigateur, à **2 ou 3 joueurs**, sur le même écran ou **en ligne à distance** (souris, tactile ou clavier).
À trois joueurs, une troisième couleur entre en jeu : rouges, jaunes et bleues.

- Physique 2D maison : chocs entre billes, bandes, mâchoires et poches, coulé / rétro.
- Règles du pub anglais : table ouverte après la casse, deux coups après une faute, bille en main derrière la ligne de baulk.
- Ligne de visée avec bille fantôme et direction de la bille visée (rose si la bille est interdite).
- Animations : la queue part frapper la blanche, les billes glissent et s'enfoncent dans les poches (onde de leur couleur),
  la blanche à pois rouges roule visiblement.
- Sons synthétisés (aucun fichier) : chocs, bandes, coup de queue, chute puis roulement dans la gouttière, roulement sur le drap,
  signaux de faute, de changement de main et de victoire.
- Table tournée automatiquement en portrait sur téléphone.
- Jeu en ligne : une salle, un lien à partager, chacun joue depuis son appareil et voit la visée des autres.
- Aucune dépendance d'exécution : TypeScript compilé en modules ES, servi par nginx ; petit serveur de salons en Node pur.

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

## Jeu en ligne

Dans le menu, choisir **En ligne**, puis **Créer une salle** : un code (`K7QPM`) et un lien (`https://…/#salle=K7QPM`)
s'affichent, à envoyer aux autres joueurs. La partie démarre quand toutes les places sont prises.

- Le navigateur du joueur qui tire calcule le coup ; les autres écrans rejouent l'animation en direct puis se recalent sur
  l'état officiel envoyé à la fin du coup. Les tables restent donc identiques même si deux navigateurs calculent légèrement différemment.
- Le serveur (`server/relay.mjs`) ne connaît pas les règles : il tient les places, relaie les messages (flux SSE + POST) et refuse
  qu'un joueur joue hors de son tour. Il garde en mémoire le dernier état de chaque salle.
- Un joueur qui recharge la page ou perd la connexion reprend sa place en rouvrant le lien (jeton gardé dans le navigateur).
- Revanche lancée par l'hôte, la casse passe au joueur suivant. Les salles inactives depuis 2 h sont supprimées.
- Les salles vivent en mémoire : redémarrer le relais ferme les parties en cours.

## Développement

Node 22 suffit, la seule dépendance de développement est TypeScript.

```bash
npm ci
npm run dev        # build + rechargement à chaque modification, http://localhost:5173 (relais inclus sous /api)
npm test           # tests unitaires (règles, physique, parties complètes simulées, relais de salons)
npm run build      # site statique dans dist/
npm run preview    # sert dist/ sur http://localhost:4173 (relais inclus)
npm run relay      # relais de salons seul, port 8081
```

Pour essayer le jeu en ligne en local, ouvrir le lien de la salle dans une fenêtre de navigation privée (autre place).

Ajouter `?debug` à l'URL expose `window.__billard` (partie en cours) pour les tests de bout en bout.

```
src/game/     physique, table, triangle, règles, orchestration d'une partie (sans DOM)
src/render/   rendu canvas et transformation monde ↔ écran
src/ui/       commandes, bandeau des joueurs, sons synthétisés
src/net/      connexion au serveur de salons (jeu en ligne)
server/       serveur de salons (Node, sans dépendance)
web/          index.html et styles
public/       favicon, manifeste
tests/        tests node:test
deploy/       configuration nginx et exemple de Traefik
```

## Déploiement avec Traefik

L'image est un nginx non root qui écoute sur le port 8080, avec un healthcheck sur `/healthz`, en-têtes de sécurité (CSP stricte)
et cache immuable des fichiers versionnés. Le jeu en ligne ajoute un second service, `relay` (image `…/billard-anglais-relay`,
Node non root, port 8081), que Traefik sert sur le même domaine sous `/api/`. Sans lui, le jeu sur un seul écran fonctionne toujours.

Sur le serveur, avec un Traefik déjà en place sur un réseau Docker externe :

```bash
cp .env.example .env     # DOMAIN, IMAGE (ghcr.io/<owner>/billard-anglais), TAG, réseau / entrypoint / certresolver Traefik
docker compose pull
docker compose up -d
```

Les conteneurs tournent en lecture seule, sans capacités, limités à 64 Mo (site) et 128 Mo (relais). Pour construire les images sur place plutôt que les tirer :
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
2. publie les images multi-architecture (amd64 et arm64) `ghcr.io/<owner>/billard-anglais` et `ghcr.io/<owner>/billard-anglais-relay`
   avec les tags `1.0.0`, `1.0`, `1` et `latest` ;
3. crée la release GitHub avec l'archive `billard-anglais-v1.0.0-web.zip` (le site statique, servable par n'importe quel serveur web ;
   le jeu en ligne demande en plus le relais sous `/api/`).

Le workflow `ci.yml` vérifie chaque push et pull request : typage, tests, build, puis construction des deux images et tests de fumée
(healthcheck, CSP, cache des assets, création d'une salle).

Au premier push, les images GHCR sont privées : les rendre publiques dans les réglages du paquet, ou faire un `docker login ghcr.io` sur le serveur.
