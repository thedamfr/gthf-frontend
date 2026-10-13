# Frontend GTHF

## Summary (30 secondes)

Le frontend public GTHF utilise Next.js et le CMS Strapi voisin `gthf-cms`.
Les sources, dépôts et ressources Kubernetes adoptent le nom GTHF ; les
identités PostgreSQL et les buckets existants sont conservés. Le
[plan de renommage](documentation/renommage-gthf.md) précise les invariants,
les Golden Journeys et les preuves à rattacher à la révision candidate.

## Synthèse (3 minutes)

Le développement utilise Node 22.12 à 24 et les dépendances verrouillées npm.
Les contrôles locaux sont `npm test`, `npm run lint`, `npm run test:delivery`,
`npm run build`, puis `npm run test:delivery:runtime`. Ce dernier utilise
un CMS simulé ; il ne prouve pas une livraison Kubernetes.

La commande `npm run test:e2e -- staging` vérifie les Golden Journeys sur
l'environnement isolé : droits, contenu public et GPX, persistance d'un
brouillon, preview, publication, upload et nettoyage. La commande
`npm run test:e2e -- production` vérifie les parcours publics sans écriture.
Elles utilisent les accès existants de Penthouse, gardés hors Git.

Le nom du namespace de production reste `gthf-staging` pour cette migration.
L'activation opérationnelle doit conserver les données et l'isolation du staging,
et qualifier les digests des images reconstruites pour le renommage.
Un renommage du code ne prouve pas que la migration a été exécutée. Les annexes ci-dessous décrivent
l'architecture, le développement et les procédures antérieures.

## Annexes

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Architecture GTHF et documentation transverse

Le produit GTHF est réparti entre deux dépôts :

- `gthf-frontend` : application publique Next.js ;
- [`gthf-cms`](https://github.com/thedamfr/gthf-cms) : CMS Strapi et
  schémas éditoriaux.

Le schéma exécutable appartient au CMS ; son contrat public est consommé par
le frontend. Les PRD qui décrivent ce contrat ou une fonctionnalité concernant
les deux applications sont conservés une seule fois dans
[`documentation/`](documentation/). Chaque PRD nomme les dépôts concernés,
l’ordre de déploiement et les contraintes de compatibilité.

Cet emplacement est la source canonique de la documentation d’architecture, pas
un couplage de déploiement. Chaque dépôt conserve ses branches, ses pull
requests et son cycle de livraison. Ne pas dupliquer les PRD dans le CMS :
ajouter un lien vers la source canonique.

Le classeur de cadrage des villes et itinéraires, ses exports CSV et leur
manifeste sont décrits dans
[`documentation/data/gthf_villes_et_produits_seo/`](documentation/data/gthf_villes_et_produits_seo/).

## Livraison continue OVH

Les PR de livraison sont fusionnées et les premières images GHCR sont vérifiées
en staging isolé et en production. Le [runbook](documentation/deploiement_continu.md)
conserve leurs digests, recettes et l’incident suivi d’une reprise. La livraison automatique passe par un réconciliateur local sur Penthouse ;
GitHub Actions publie les candidats sans connexion au serveur. Le namespace `gthf-staging`
et le bucket `gthdf-staging-media` désignent la production malgré leur nom.
La recette utilise [le frontend staging](https://staging.gthf.fr/) et
[le CMS staging](https://staging-cms.gthf.fr/), protégés par authentification.

Le build frontend ne nécessite plus de CMS ni de secret. Au runtime,
`STRAPI_URL` désigne l'API interne, `PUBLIC_STRAPI_URL` son origine publique,
`SITE_URL` celle du site et `STRAPI_API_TOKEN` le jeton serveur. Les variables
legacy `NEXT_PUBLIC_STRAPI_URL` et `NEXT_PUBLIC_SITE_URL` restent acceptées.
`/api/health` expose la version ; `/api/ready` vérifie l'accès au contenu global.
Après `npm run build`, `npm run test:delivery:runtime` démarre le serveur
standalone avec un CMS de test local et vérifie la première lecture d'un
chapitre absent au build. La CI exécute aussi ce contrôle.

## Getting Started

Le projet requiert Node.js 22.12 ou une version plus récente de Node 22 à 24.
L'image de production utilise la version Node 24 épinglée dans le `Dockerfile`.

Create `.env.local` from `.env.example`. `PREVIEW_SECRET` must contain the
same long random value in the frontend and CMS environments. Keep it
server-only: do not prefix it with `NEXT_PUBLIC_`.

Toutes les lectures authentifiées utilisent `STRAPI_API_TOKEN`, strictement
serveur. La variable legacy `NEXT_PUBLIC_STRAPI_API_TOKEN` n’est pas prise en
charge et ne doit jamais être définie. Les origines objet autorisées se
configurent avec `STRAPI_MEDIA_ORIGINS`.

Le fond cartographique des fiches itinéraires est contrôlé côté serveur par
`ITINERARY_BASEMAP_ENABLED`. La valeur par défaut est `false` : le schéma SVG
autonome reste alors affiché et aucun appel à OpenFreeMap n’est effectué. La
valeur exacte `true` active le fond Positron différé ; remettre la variable à
`false` constitue le retour arrière immédiat en cas d’indisponibilité du
fournisseur ou avant validation de la politique de confidentialité.

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Routes principales

- `/` : Homepage CMS (header, intro, carte, principes, horizons, FAQ, rencontres)
- `/chapitres` : Liste des chapitres
- `/chapitres/[slug]` : Détail chapitre
- `/villes/[slug]` : Hub d'une ville publiée et activée dans Strapi
- `/checkpoints` : Page checkpoints CMS + accordéon
- `/gpx-builder` : Générateur d’une portion officielle entre deux villes
- `/itineraires-velo` : Liste HTML des itinéraires publiés et indexables
- `/itineraires-velo/[slug]` : Itinéraire ville à ville publié et vérifié
- `/blog` : Liste des articles avec filtre par catégorie (`?category=slug`)
- `/article/[slug]` : Détail article
- `/a-propos` : Page à propos CMS (title + blocks)
- `/mentions-legales` : Mentions légales CMS

## Validation PRD 01 en local

Avec Strapi sur `http://localhost:1337` et Next sur
`http://localhost:3000`, lancer :

```bash
npm test
npm run lint
npm run test:integration:prd01
```

Le smoke test contrôle une ville publique, les 404 des villes privées, le
résumé serveur d'un chapitre, le sitemap et une preview Draft Mode protégée.
Sur une fiche itinéraire en Draft Mode, le bandeau signale explicitement la
prévisualisation et permet de recharger la même URL hors Draft Mode sans
conserver le cookie de preview.

## Validation PRD 02 et revue sur téléphone

Avec Strapi démarré par `npm run develop` dans `gthf-cms` et le frontend
démarré par `npm run dev` dans ce dossier, lancer depuis le frontend :

```bash
npm test
npm run lint
npm run test:integration:prd02
npm run test:integration:prd02:geometry
```

La recette PRD 02 appelle uniquement le frontend local sur
`http://localhost:3000`. Elle vérifie le HTML serveur de `/chapitres`, les dix
liens dans l'ordre public, l'absence d'image de galerie dans le HTML initial,
le refus des paramètres par l'endpoint de proximité et le contrat de son JSON.
Elle affiche aussi le poids JSON et gzip de l'index ainsi qu'un benchmark local
du calcul de proximité. La limite compressée est de 500 Ko, avec une cible de
250 Ko ; le benchmark local sert de garde-fou et ne remplace pas la mesure sur
le téléphone Android médian de la recette.

`LOCAL_FRONTEND_URL` peut changer le port, mais le script refuse une URL non
loopback afin d'éviter tout appel involontaire à la production. Le nombre
d'itérations peut être ajusté de 5 à 200 avec
`PRD02_BENCHMARK_ITERATIONS` (20 par défaut). Aucun secret n'est nécessaire ou
affiché par cette recette.

La recette géométrique charge uniquement le Strapi et le frontend locaux. Elle
compare leurs 20 références GPX, servies par Strapi ou par l’origine de
stockage objet explicitement approuvée, avec l’index simplifié. Elle refuse
toute autre origine, impose une tolérance de distance de 25 m, puis vérifie les
gagnants séparés de plus de 50 m et les cas de jonction ambigus. Elle lit les
variables de `.env.local` sans afficher le jeton Strapi.

Le PRD 02 est livré en production depuis le 5 août 2026. Les dix chapitres y
sont ordonnés de `1` à `10`, la migration des vingt versions brouillon et
publiée est terminée et l’index de proximité mesuré par la recette pèse
53,1 Kio gzip. Le document de référence conserve le bilan complet :
[`documentation/prd_02_retrouver_chapitre_mobile.md`](documentation/prd_02_retrouver_chapitre_mobile.md).

Pour la revue depuis un téléphone, conserver les deux commandes npm actives,
contrôler la redirection avec `tailscale serve status`, puis ouvrir l'URL HTTPS
MagicDNS du frontend depuis un appareil du même tailnet. L'HTTPS est nécessaire
pour tester la géolocalisation. Le smoke test reste lancé sur le Mac contre
`localhost` ; il ne faut pas lui transmettre l'URL Tailscale.

## Validation PRD 03 du GPX Builder

Le Builder remplace le fusionneur par deux comboboxes `départ → arrivée`. Le
serveur compare les portions AB et BA et retient automatiquement la plus
courte ; le navigateur n’envoie aucun choix de sens.
Le visuel du parcours complet repris depuis l’accueil précise que le GPX suit
une section de la boucle officielle, et un lien conduit vers les dix chapitres.
Les payloads des endpoints du Builder ne contiennent ni URL de média, ni
coordonnées d’ancrage, ni empreinte de source. Les endpoints serveur sont :

- `POST /api/gpx-builder/preview` pour le résumé ;
- `POST /api/gpx-builder/download` pour le GPX 1.1.

Après une prévisualisation valide, la réponse peut aussi fournir le lien
secondaire `Découvrir cet itinéraire` lorsqu’une fiche catalogue publique
représente exactement le même parcours AB, les mêmes villes ordonnées, les
mêmes ancres, sources et jonctions. Le rapprochement réutilise la garde
publique côté serveur. Une correspondance partielle ou inversée et une panne
du catalogue n’affichent aucun lien. Le lookup est plafonné à une seconde afin
de ne retarder ni la prévisualisation ni le téléchargement du GPX.

Le bloc « À savoir » conduit vers `/itineraires-velo`. Cet index serveur liste
dans son HTML initial toutes les fiches publiques indexables afin de fournir un
chemin de navigation et de crawl indépendant du sitemap XML.

Le maillage interne du catalogue reste volontairement borné et rendu côté
serveur. Une page ville affiche au plus cinq itinéraires qui ont cette ville
pour extrémité : les choix `featuredOnCityPages` et `editorialOrder` passent en
premier, puis les places restantes sont complétées automatiquement dans un
ordre stable. Chaque fiche itinéraire propose au plus trois autres portions
publiques et indexables ayant exactement la même ville de départ. La fiche
courante, les previews et les pages `noindex` sont toujours exclues.

Les fiches `/itineraires-velo/[slug]` publient une seule distance : celle de
la géométrie GPX active. La distance à vol d’oiseau reste un critère interne
d’éligibilité et n’entre ni dans le DTO public, ni dans le HTML, ni dans les
metadata. Le H1, le CTA, les cartes, les pages-ville et les recommandations
utilisent le même formateur de direction française et le même arrondi au
dixième de kilomètre. Les champs CMS optionnels `City.fromLabel` et
`City.toLabel` permettent de traiter une exception éditoriale ; le fallback
gère les articles `Le`/`Les`, les voyelles et les cas ordinaires.

Cette version du frontend doit être déployée après le schéma CMS qui ajoute
ces deux champs. Aucune migration de contenu n’est requise. En rollback,
redéployer l’ancien frontend et conserver les champs CMS additifs.

Avant une recette locale, déployer ou démarrer le schéma CMS, préparer et
publier les ancrages et jonctions relus, puis activer
`Global.gpxBuilderEnabled`. Tant que cette valeur reste à `false`, la page
affiche volontairement un état indisponible.

Depuis le frontend :

```bash
npm test
npm run lint
npm run build
```

La recette manuelle minimale couvre une portion dans un chapitre, le cas
Boulogne-sur-Mer → Gravelines sur deux chapitres, le passage par l’origine et
un cas BA dont le profil diffère d’AB. Réimporter les exports dans deux
applications de navigation et vérifier qu’aucune ligne ne relie une rupture
qualifiée. Le contrat complet et le bilan local sont conservés dans
[`documentation/prd_03_gpx_builder_ville_a_ville.md`](documentation/prd_03_gpx_builder_ville_a_ville.md).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Déploiement

La production est hébergée sur le serveur OVH Gravelines, dans le namespace
MicroK8s `gthf-staging` validé avant la bascule DNS. Clever Cloud reste
provisoirement disponible comme voie de retour arrière ; ne pas supprimer ses
applications, sa base ou son bucket tant que les sauvegardes OVH et la période
d'observation post-bascule ne sont pas validées.

Depuis le 11 septembre 2026, GitHub Actions construit et publie les images par
SHA et digest GHCR. Le service local sur Penthouse qualifie les candidats en
staging puis les promeut en production. Le [runbook de livraison](documentation/deploiement_continu.md)
porte les résultats vérifiés, la procédure de pause et les preuves d’exploitation.

Le staging complet utilise `gthdf-qualification` avec ses applications,
PostgreSQL, volume, médias, configuration et comptes propres. Les domaines
staging ne partagent plus les applications de production. Les réservations
protègent les démonstrations sur cet environnement partagé. L’identité S3 est
partagée entre les seuls buckets GTHF sur instruction du propriétaire ; les
recettes bornent leurs écritures au stockage staging.

Les tags locaux antérieurs et les commandes Clever restent des références
historiques ou des moyens de secours. La livraison courante emploie le déployeur
avec un manifeste candidat par digest ; ne pas appliquer un overlay portant
les tags historiques pour remplacer les images en ligne.

Pour les PRD 01 à 03, déployer d'abord le schéma CMS, exécuter et contrôler
les migrations manuelles avec les commandes npm documentées dans le README du
CMS, puis déployer le frontend. Ces migrations ne sont jamais ajoutées au
démarrage automatique de l'application.

La migration a d'abord été recettée sur le VPS Hetzner, puis répétée et promue
sur OVH. Elle utilise deux images indépendantes, un PostgreSQL 17 local et un
bucket S3 OVH Paris dédié. Le choix d'architecture, les commandes
d'exploitation, le rollback DNS et les résultats vérifiés sont documentés dans
[`documentation/adr_hebergement_microk8s_partage.md`](documentation/adr_hebergement_microk8s_partage.md)
et [`infrastructure/README.md`](infrastructure/README.md).
