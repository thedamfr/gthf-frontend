# Infrastructure GTHF autohébergée

## Summary (30 secondes)

Les manifestes et outils courants utilisent `gthf-staging` pour la production
et `gthf-qualification` pour le staging isolé. Le
[plan de renommage](../documentation/renommage-gthf.md) documente la bascule,
les données à conserver et les Golden Journeys. Les états datés en annexe
restent des preuves historiques et ne décrivent pas automatiquement le cluster actuel.

## Synthèse (3 minutes)

Les composants Kubernetes, images, dépôts, labels et unités de livraison
adoptent le préfixe `gthf`. Les données PostgreSQL restent sous l'identité
`gthdf` ; les buckets médias et URLs Clever existants sont inchangés.
Les sources du réconciliateur ciblent `/home/ubuntu/gthf-delivery` et
`gthf-delivery.timer` ; l'état privé doit être migré avant leur activation.

La migration opérationnelle conserve les volumes et qualifie les images reconstruites
avec les seuls changements de noms, sur une base runtime identique à la production.
Elle requiert une bascule contrôlée des routes et du proxy de staging,
puis les commandes `npm run test:e2e -- staging` et
`npm run test:e2e -- production`. Le diff de la base `main` vers la version
servie a été vérifié : seuls des documents avaient changé avant ce renommage. Les anciennes procédures et noms ci-dessous
sont conservés pour comprendre les preuves datées et le retour arrière.

## Annexes — historique antérieur au renommage

Ce dossier conserve l’historique de migration Hetzner puis OVH, ainsi que les
ressources de livraison actuelles. Sur Penthouse, la production utilise
`gthdf-staging` et le staging isolé utilise `gthdf-qualification`. L’ancien
namespace unique appartenait à la recette initiale ; les procédures historiques
ci-dessous ne doivent pas remplacer la livraison courante par digest.

## Livraison GHCR vérifiée — 11 septembre 2026

Le [runbook actuel](../documentation/deploiement_continu.md) est la référence
pour les images réellement servies, les recettes, le retour arrière initial et
la promotion initiale vérifiée à 14:36 UTC. Le réconciliateur local est maintenant
actif : le premier candidat frontend publié par GitHub Actions a passé staging
puis production à 17:42 UTC, avec 456 contrôles origine sans erreur. Le runbook
commun distingue cette livraison automatique de l’amorçage manuel initial.

Le namespace `gthdf-qualification` contient maintenant les trois applications,
PostgreSQL et son PVC distinct, une copie éditoriale sans identités de production
et les médias staging. Les 2 720 objets sont copiés, les 2 209 références réécrites,
et les accès de recette sont dédiés. Les domaines
[frontend staging](https://staging.gthf.fr/) et [CMS staging](https://staging-cms.gthf.fr/)
servent cette pile isolée avec authentification. Les recettes CRUD, preview,
publication, upload et nettoyage ont réussi.

Le bucket staging est `gthf-staging-media-bis` à Gravelines ; le bucket historique
`gthdf-staging-media` reste celui de production à Paris. L’identité S3 `gthf`,
partagée entre ces seuls buckets sur instruction du propriétaire, est installée
dans les deux environnements. Les secrets Strapi restent distincts.

Prometheus et Grafana sont désormais gérés par la plateforme
[`infra-sincere`](https://github.com/thedamfr/infra-sincere/blob/main/documentation/observabilite.md).
Les sondes `production-http` des applications `gthdf-frontend` et `gthdf-cms`
sont présentes, fraîches et saines après la promotion. Le
[guide de surveillance](https://github.com/thedamfr/infra-sincere/blob/main/documentation/deploiement-surveillance-notifications.md)
décrit les requêtes, les alertes et la procédure de notification. Leur installation
n’est pas assurée par le playbook historique GTHF décrit plus bas.

Les sections suivantes conservent l’historique de migration. Elles ne décrivent
pas les routes ni les images actuellement en service ; ne pas les utiliser pour
écraser la configuration de livraison par digest.

## Historique — état du 10 septembre 2026

Sur `game-prod-ovh-gra`, contexte `microk8s`, les workloads de
`gthdf-staging` sont prêts : frontend `gthdf-frontend:production`, CMS
`gthdf-cms:staging` et PostgreSQL `gthdf-postgres:staging`. Ces tags mutables
correspondent à l'overlay versionné ; ils ne prouvent pas le SHA Git de leur
contenu. Les domaines `staging.gthf.fr` et `staging-cms.gthf.fr` sont des alias
de la même charge et des mêmes données que la production. Cet état est un
écart à corriger ; il n'autorise pas des tests d'écriture isolés.

La cible est décrite dans la
[recette complète et isolée](../documentation/history/deploiement_continu_2026-09-10.md#staging-complet-et-isolé-à-construire) :
frontend, CMS et PostgreSQL dédiés, PVC/caches, espace média, configurations et
secrets distincts de la production. Les agents travaillant en parallèle
coordonnent l'occupation et la version du staging GTHF partagé, avec un jeu de
données contrôlé et des parcours CRUD/médias fonctionnels. Des instances par PR
restent une option ultérieure, pas une exigence du staging de base. La production
historique reste dans `gthdf-staging` tant qu'une migration explicite n'est pas
préparée ; aucune commande de ce runbook ne crée à elle seule cette isolation.

Les sources sont désormais rangées sous `/home/ubuntu/source/gthdf-frontend`
et `/home/ubuntu/source/gthdf-cms`. Ce rangement ne change pas les chemins
historiques des scripts : le playbook lit toujours, par défaut, l'overlay déjà
présent sous `/home/production/gthdf-staging-prep/frontend`. Il ne copie pas le
checkout, ne construit pas les images et ne les importe pas. Un checkout à jour
n'implique donc pas un déploiement à jour.

Les deux dépôts n'ont pas de workflow GitHub Actions versionné. La
[cible de livraison continue](../documentation/deploiement_continu.md)
documente le travail restant pour automatiser un push sur `main` et ne
reconstruire que les composants concernés. Les commandes ci-dessous décrivent
la procédure existante et sa préparation historique, pas une CI/CD active.

## Périmètre

- `ansible/playbooks/audit.yml` vérifie sans mutation le disque, MicroK8s,
  l'IngressClass, les API cert-manager et la StorageClass ;
- `ansible/playbooks/deploy.yml` applique uniquement `gthdf-staging` et masque
  les tâches qui lisent ou appliquent les secrets ; il redémarre **les deux**
  runtimes CMS et frontend dès que le Secret ou une ressource de l'overlay a
  changé, même si la modification ne concerne qu'un composant ;
- `ansible/playbooks/observability.yml` active Metrics Server sur le seul hôte
  OVH et génère un accès K9s techniquement limité à la lecture ;
- `kubernetes/base/` décrit Next.js, Strapi, PostgreSQL 17 avec PostGIS, le PVC,
  les quotas et les politiques réseau ;
- `kubernetes/overlays/staging/` ajoute les DNS, le certificat, Traefik et la
  configuration du bucket OVH Paris dédié.

Le certificat est émis par un `Issuer` Let's Encrypt HTTP-01 limité au namespace
`gthdf-staging`. Il n'utilise ni ne modifie le `ClusterIssuer` Cloudflare de
Podcast Studio. Le minimum CPU du `LimitRange` reste à 10 mCPU afin d'autoriser
les pods solveurs HTTP-01 créés par cert-manager. Une politique réseau dédiée
ouvre uniquement leur port éphémère 8089 pendant la validation ACME.

La plateforme partagée — MicroK8s, ingress et cert-manager — reste administrée
hors de ce dépôt, à l'exception explicite de Metrics Server et du compte
d'observation en lecture seule. Le namespace `podcast-studio` reste hors du
périmètre de déploiement GTHDF.
Le frontend force son port d'écoute à 3000 afin de ne pas hériter du port 1337
de Strapi depuis le `ConfigMap` partagé par les deux applications.
Son système de fichiers racine reste en lecture seule. Un init-container copie
les artefacts App Router dans un `emptyDir` monté uniquement sur
`/app/.next/server/app`, ce qui autorise les écritures du cache ISR sans rendre
le reste de l'image modifiable.

## Prérequis de staging

Lors de la première recette, deux enregistrements DNS ont pointé vers le VPS
Hetzner :

- `staging.gthf.fr` ;
- `staging-cms.gthf.fr`.

Créer aussi le bucket `gthdf-staging-media` dans OVH Object Storage Paris
(`eu-west-par`). Pour la répétition et la promotion du 9 septembre 2026,
l'utilisateur a explicitement autorisé la réutilisation temporaire du couple de
clés S3 du Studio dans le secret GTHDF ; le bucket reste distinct. Ces clés
doivent encore être remplacées par des identifiants limités au seul bucket
GTHDF.

Installer Ansible dans un environnement virtuel local, puis lancer l'audit :

```bash
cd infrastructure/ansible
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/ansible-playbook \
  -i inventories/staging/hosts.yml \
  playbooks/audit.yml
```

Après validation sur Hetzner, auditer OVH avec l'inventaire dédié :

```bash
cd infrastructure/ansible
.venv/bin/ansible-playbook \
  -i inventories/ovh/hosts.yml \
  playbooks/audit.yml
```

Cet inventaire versionné cible uniquement `ubuntu@penthouse`, dont le nom
d'hôte attendu est `game-prod-ovh-gra`. Le playbook historique ne
configure pas Ubuntu, MicroK8s, Traefik ou cert-manager et ne peut appliquer que
le namespace `gthdf-staging`.

`inventories/ovh/hosts.yml` est suivi par Git via une exception ciblée et
conserve le groupe Ansible `gthdf_staging`. L'exemple
`inventories/staging/hosts.example.yml` concerne l'ancienne recette Hetzner.
Utiliser l'inventaire OVH existant. Vérifier l'identité effective de l'hôte
et le contexte Kubernetes avant toute application ;
`deploy.yml` contrôle le namespace, mais ne fait pas lui-même ces deux
vérifications d'identité.

L'audit exige au moins 6 Gio libres. Un échec sur ce seuil interdit un build ou
un rollout supplémentaire tant qu'un nettoyage explicitement relu n'a pas été
effectué.

## Images

La direction à implémenter est de sélectionner et construire les composants
sur des runners GitHub Actions, publier leurs images sur GHCR par SHA/digest,
puis les déployer automatiquement sur Penthouse après CI verte sur `main`.
La [cible de livraison continue](../documentation/deploiement_continu.md)
détaille la transition depuis les imports et tags locaux ci-dessous. Le build
local restera réservé au secours explicitement autorisé.

### Procédure locale actuelle

Les images sont construites séparément depuis un checkout propre de chaque
dépôt. Sur ce serveur, le builder local s'utilise avec `sudo -n docker`.
PostgreSQL utilise le contexte `infrastructure/docker/postgres` du frontend,
Strapi la racine de `gthdf-cms` et Next.js la racine de `gthdf-frontend`.

Le build Next.js reçoit seulement `GTHDF_REVISION` pour la preuve de version.
Il réussit sans CMS ni secret. Les valeurs `STRAPI_URL=http://gthdf-cms:1337`,
`PUBLIC_STRAPI_URL=https://cms.gthf.fr`, `SITE_URL=https://gthf.fr`,
`STRAPI_MEDIA_ORIGINS` et le secret `STRAPI_API_TOKEN` sont injectés au runtime
par les ConfigMaps et Secrets Kubernetes. Les domaines média admis par
l'optimiseur d'images sont définis dans `next.config.ts`, relu au build ;
le Dockerfile n'accepte pas d'argument `NEXT_IMAGE_REMOTE_ORIGINS`.

Ne pas exécuter un script complet en root. Docker et MicroK8s ont des stockages
d'images distincts : construire
localement ne suffit pas à rendre l'image disponible au cluster. Docker a été
installé le 10 septembre ; le build applicatif complet depuis ces checkouts
reste à valider. Le runtime Next.js et son init-container doivent utiliser
exactement la même image.

### Lanceur distant historique

Le lanceur existant récupère encore le jeton via `clever-cli` et le supprime
du builder après usage. Par défaut, il utilise SSH `qg-codex` et le contexte
`/var/tmp/gthdf-staging-20260909/frontend`, **sans synchroniser les sources**.
Ces commandes sont conservées pour expliquer la recette initiale ; ne pas les
utiliser comme preuve d'un build du checkout courant :

```bash
npm run infra:staging:build-frontend
npm run infra:production:build-frontend
```

Le second point d'entrée sélectionne les URLs publiques et le tag production.
`GTHDF_DOCKER_SSH_HOST` et `GTHDF_REMOTE_FRONTEND_CONTEXT` permettent de choisir
un builder et son contexte déjà préparé. Le lanceur appelle `docker` sans sudo
et ne réalise ni import MicroK8s, ni rollout. La suppression de la dépendance
Clever et le build d'un SHA exact sur le builder autorisé sont des évolutions
à implémenter, pas des fonctions actuelles de ce script.

L'overlay conserve les deux Ingress de staging avec leur en-tête `noindex`, et
ajoute deux Ingress de production sans cet en-tête. Le certificat de production
est séparé du certificat de staging afin que celui-ci reste valide pendant la
bascule DNS. Le retour arrière consiste à restaurer les anciennes cibles DNS ;
les Ingress de staging continuent alors à servir la même base et le même bucket.

Pour un MicroK8s sans registry, exporter chaque image avec `docker save`, la
copier sur le VPS, puis la charger sur tous les nœuds en passant impérativement
l'archive sur l'entrée standard : `microk8s images import < image.tar`.
Passer le chemin comme argument ne charge pas l'image. L'overlay utilise
`imagePullPolicy: Never` pour PostgreSQL et les conteneurs principaux CMS et
frontend. L'init-container frontend `seed-next-app-cache` conserve
`IfNotPresent` : il utilise l'image locale si elle est présente et peut tenter
un pull si elle manque. Vérifier que les deux références frontend sont
identiques et disponibles après import.

Réimporter un tag identique ne change pas le PodTemplate ; si ni Secret ni
overlay ne changent, Ansible ne redémarre pas les pods. Il faut donc aujourd'hui
une activation explicite et vérifiée après import. La cible est de remplacer
ces tags réutilisés par une référence d'image propre à chaque commit, y compris
pour l'init-container du frontend.

## Secrets et rendu

Copier `kubernetes/overlays/staging/secrets.example.env` hors du dépôt sous
`/home/production/gthdf-staging-prep/secrets.env`, renseigner les valeurs sans
les journaliser, puis appliquer le mode `0600`. Le secret Kubernetes reste
propre à GTHDF et le bucket est dédié. Les clés S3 partagées temporairement avec
le Studio sont injectées uniquement dans ce fichier privé ; aucune de leurs
valeurs ne doit apparaître dans le dépôt.

Avant déploiement :

```bash
microk8s kubectl kustomize \
  /home/production/gthdf-staging-prep/frontend/infrastructure/kubernetes/overlays/staging
```

Le rendu ne doit contenir que le namespace `gthdf-staging`. Le déploiement
idempotent est ensuite lancé depuis `infrastructure/ansible` :

```bash
.venv/bin/ansible-playbook \
  -i inventories/staging/hosts.yml \
  playbooks/deploy.yml
```

Sur OVH, remplacer seulement l'inventaire :

```bash
.venv/bin/ansible-playbook \
  -i inventories/ovh/hosts.yml \
  playbooks/deploy.yml
```

## Observabilité légère du VPS OVH

Le playbook global d'observabilité est volontairement séparé du déploiement
`gthdf-staging`. Il refuse tout inventaire autre que
`production@game-prod-ovh-gra`, vérifie le prérequis d'authentification du
kubelet, puis applique le manifeste Metrics Server livré par la version de
MicroK8s installée sur le serveur :

```bash
cd infrastructure/ansible
.venv/bin/ansible-playbook \
  -i inventories/ovh/hosts.yml \
  playbooks/observability.yml
```

Le ServiceAccount `vps-observer`, dans `vps-observability`, peut lire les
workloads, les nœuds et `metrics.k8s.io` sur le cluster. Il ne peut ni lire les
Secrets, ni créer ou modifier un pod. Le kubeconfig produit sur le serveur est
copié sur le Mac en mode `0600` :

```bash
mkdir -p ~/.kube
scp production@game-prod-ovh-gra:/home/production/gthdf-staging-prep/k9s-readonly.kubeconfig \
  ~/.kube/gthdf-ovh-readonly.yaml
chmod 0600 ~/.kube/gthdf-ovh-readonly.yaml
```

K9s se lance depuis le dépôt avec :

```bash
npm run infra:ovh:k9s
```

Le lanceur ouvre tous les namespaces, ajoute `--readonly` et établit
automatiquement un tunnel SSH vers l'API Kubernetes liée à
`127.0.0.1:16443`. Aucun port d'administration n'est exposé publiquement.
`kubectl top` et Metrics Server montrent la
consommation récente ; ils ne conservent pas d'historique. Au relevé initial du
9 septembre, Prometheus, Grafana et le Dashboard Kubernetes n’étaient pas
installés. Prometheus/Grafana sont depuis gérés par `infra-sincere`, comme
indiqué dans l’état actuel en tête de ce document.

Lors de l'installation du 9 septembre 2026, le nœud consommait environ 150 à
175 mCPU et 3,2 Gio de RAM. GTHDF au repos représentait environ 8 mCPU et
617 Mio ; Metrics Server ajoutait environ 2 mCPU et 22 Mio.

## Recette et reprise de données

L'ordre de recette est : PostgreSQL, Strapi, puis Next.js. Le playbook applique
cependant l'overlay complet avant ses attentes de rollout ; il n'ordonnance pas
un changement de schéma entre deux livraisons. Contrôler les trois
rollouts, `/_health`, `/api/health`, le certificat, l'en-tête `X-Robots-Tag`,
l'administration, une lecture de média et enfin un upload de test.

`/api/health` renvoie seulement `{ "status": "ok" }` : il ne teste ni Strapi,
ni PostgreSQL, ni la version de l'image. La validation de livraison doit aussi
lire un contenu publié connu, son média et une page qui le consomme. Un upload
de recette est une écriture à organiser explicitement, sans l'inclure dans une
sonde périodique de production.

La reprise de production doit rester non destructive : dump PostgreSQL depuis
Clever, restauration dans `gthdf-staging`, puis copie des objets Cellar vers le
bucket OVH dédié. Ne jamais lancer les scripts de migration applicative avant
la comparaison des versions de schéma et une sauvegarde nommée. La mesure de
référence du 9 septembre 2026 est d'environ 53 Mo pour PostgreSQL et 386 Mo pour
2 766 objets ; elle devra être recalculée au moment de la répétition.

Le dump de référence nécessite les extensions PostGIS et pgvector. L'image de
base de données est donc construite sur PostgreSQL 17 + PostGIS 3.6 avec le
commit de pgvector 0.8.6 épinglé.

Le dump complet, compressé au format custom et créé en mode `0600`, se produit
sans afficher les identifiants Clever :

```bash
npm run infra:staging:dump-postgres
```

En cas d'échec après la bascule, restaurer d'abord les deux CNAME Clever décrits
plus bas, puis conserver le PVC et le bucket pour diagnostic et arrêter les
trois workloads GTHDF si nécessaire. Ne supprimer ni namespace, ni volume, ni
objet pendant l'analyse.

### Répétition OVH du 9 septembre 2026

La recette Hetzner a été répétée sur `production@game-prod-ovh-gra` après
autorisation explicite. L'audit a validé Ubuntu 26.04, MicroK8s, l'IngressClass
`public`, cert-manager, la StorageClass et environ 838 Go libres. Les trois
images ont été importées dans MicroK8s sans installer Docker sur le nœud.

Le dump Clever a été restauré avec 117 tables publiques, 2 209 lignes dans
`files`, PostGIS 3.6.4 et pgvector 0.8.6. Les recettes directes de l'origin OVH
retournent 200 pour le frontend et sa route de santé, et 204 pour Strapi. Un
second passage Ansible termine avec `changed=0`.

Les deux DNS de staging ont ensuite été basculés vers l'origin OVH
`141.94.98.109`. Le certificat `gthdf-staging-tls` est `Ready=True` et la
recette publique valide le frontend, Strapi, le contenu restauré, un GPX et une
image. Le cache ISR a été sollicité sur l'origin après ajout de son volume
écrivable dédié, sans nouvelle erreur de système de fichiers en lecture seule.
Aucun DNS de production n'a été modifié dans cette étape.

Le bucket privé `gthdf-staging-media` a été créé dans `eu-west-par`. Les 2 766
objets Cellar, soit 385 707 923 octets, y ont été copiés avec une lecture
publique objet par objet ; la source Clever n'a pas été supprimée. La base de
staging référence désormais l'origine virtual-host OVH dans les 2 209 lignes
`files` et leurs 131 ensembles de formats imbriqués. La recette finale confirme
zéro URL Cellar dans l'API et le HTML public.

### Promotion DNS du 9 septembre 2026

Après la recette utilisateur, `gthf.fr` et `cms.gthf.fr` ont été promus sur
l'origin OVH `141.94.98.109`. Dans Cloudflare, leurs CNAME proxifiés vers
`domain.par.clever-cloud.com` ont été remplacés par des enregistrements A
proxifiés en conservant le TTL automatique. Le certificat
`gthdf-production-tls` est séparé du certificat de staging et est `Ready=True`.
Les Ingress de production ne portent pas le middleware `staging-noindex`.

Le rollback DNS exact consiste à recréer pour ces deux noms les CNAME proxifiés
vers `domain.par.clever-cloud.com`, TTL automatique. Ne modifier ni les
enregistrements MX/TXT, ni `staging.gthf.fr`, ni `staging-cms.gthf.fr`.

Le frontend a été reconstruit à Nuremberg avec
`npm run infra:production:build-frontend`. Le jeton Strapi a été monté comme
secret BuildKit temporaire puis supprimé ; l'image a été transférée directement
vers MicroK8s sans archive sur le Mac. L'image `gthdf-frontend:production` est
exécutée sur OVH. La recette publique confirme les mentions légales OVH, un
`robots.txt` pointant vers `https://gthf.fr/sitemap.xml` et 252 URLs de
production dans le sitemap, tandis que staging conserve son en-tête `noindex`.
