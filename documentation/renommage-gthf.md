# Renommage des projets et ressources GTHF

## Summary (30 secondes)

La source utilise `gthf-frontend`, `gthf-cms`, `gthf-staging` (production)
et `gthf-qualification`. PostgreSQL conserve sa base et son rôle `gthdf` ;
les buckets et URLs de médias existants restent valides. La migration du
cluster, les images servies et les Golden Journeys doivent être qualifiés
séparément de ce changement de source. Suivi :
[issue #40](https://github.com/thedamfr/gthf-frontend/issues/40).

## Synthèse (3 minutes)

Les manifestes, CI, scripts Ansible, réconciliateur, tests et métadonnées npm
adoptent GTHF. La branche de publication devient `gthf-release`, le registre
`ghcr.io/thedamfr/gthf-{frontend,cms}`, l'état local
`/home/ubuntu/gthf-delivery` et les unités `gthf-delivery.service`/`.timer`.
Les anciens noms de ressources ne sont pas modifiables en place : la bascule
opérationnelle doit préserver les données, les secrets et l'isolation staging.

Les données SQL, mots de passe, rôles applicatifs persistés et buckets ne
sont pas renommés. Les anciennes images restent compatibles avec la lecture
`GTHDF_REVISION` ; les nouvelles utilisent `GTHF_REVISION`. Le proxy de staging
cible les services GTHF et emploie un cookie GTHF. Lors d'une reprise d'une
ancienne image, monter explicitement le nouveau proxy ou fournir des services
compatibles ; son ancien code embarque les anciens noms DNS.

Le diff entre le frontend déployé `636d7b6a6226d225141df69d57d45c6bc344f7c7`
et la base de cette modification `996ba6b6c1ee4366f431dc661d3194d841231cc1`
porte uniquement sur cinq documents Markdown. Reconstruire cette branche
n'ajoute donc aucune fonctionnalité antérieure non livrée ; les seuls changements
runtime concernent le renommage et sa compatibilité. Une reconstruction produit
cependant un nouveau digest, à vérifier et à consigner.

Les Golden Journeys s'exécutent avec `npm run test:e2e -- staging`, puis
`npm run test:e2e -- production`. Le staging vérifie les refus d'accès et la
reprise authentifiée, la lecture du contenu et du GPX, les droits admin,
la persistance d'un brouillon modifié, la preview, la publication, les médias
et le nettoyage. La production ne reçoit aucune écriture de cette suite.
Les tests utilisent les applications et données réelles de recette, sans
navigateur ; ils ne valident pas le rendu visuel ni les interactions JavaScript.
Un build, une fixture locale ou un HTTP 200 seul ne remplace pas ces parcours.
Le playbook historique `deploy.yml` refuse désormais toute mutation avant de
vérifier la preuve privée de migration qualifiée et les identités réelles du
namespace, du PVC et de son PV préservé. Il ne peut pas amorcer une base vide.

## Annexes

### Identités conservées

| Élément | Identité conservée | Justification |
|---|---|---|
| PostgreSQL | base et rôle `gthdf` | Identités persistées sans migration SQL |
| Médias production OVH | `gthdf-staging-media` | URLs d'objets déjà enregistrées |
| Médias qualification OVH | `gthf-staging-media-bis` | Isolation existante |
| Médias Clever historiques | `/gthdf-media/` | Compatibilité des URLs publiées |
| Credentials et rôles Strapi | Valeurs existantes | Aucun renouvellement implicite |

### Qualification reproductible

Depuis le checkout candidat, avec Node 24.19.0 comme en CI :

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run lint
npm run test:delivery
npm run build
npm run test:delivery:runtime
npm run test:e2e -- staging
npm run test:e2e -- production
```

Les deux dernières commandes requièrent le serveur autorisé Penthouse, le
contexte MicroK8s attendu et les accès de recette privés existants. Elles
consultent les secrets nécessaires sans les afficher. Le staging crée un
article et un média temporaires puis les supprime, y compris après un échec.
Les logs privés doivent rester hors Git. La sortie finale nomme la suite
`Golden Journeys`, l'environnement, les scénarios et l'horodatage.

Rattacher à la PR le SHA source testé, les digests réellement servis, les
commandes exactes, l'environnement, les scénarios et résultats, les liens CI,
les artefacts expurgés et les limites. Une modification ultérieure du contenu
testé exige une requalification adaptée. Le rapport opérationnel doit distinguer
la source préparée, sa qualification isolée et la version réellement active.

### Bascule et retour arrière

1. Capturer l'état utile et suspendre le réconciliateur avant de changer les
   noms, pour qu'un ancien déployeur ne recrée pas les anciennes ressources.
2. Préparer les cibles en conservant l'identité des volumes et les données.
   Les PVC renommés doivent rester attachés aux volumes attendus ; ne pas
   laisser un provisionnement automatique créer une base vide.
3. Adapter images, références de secrets, DNS internes, proxy de staging,
   certificats, ingresses et sondes Prometheus aux nouveaux noms.
4. Exécuter les Golden Journeys et observer la santé continue après bascule.
5. Installer le déployeur GTHF uniquement avec un état privé cohérent et des
   preuves au SHA/digest attendus, puis réactiver le circuit autorisé.

En cas d'échec, conserver les preuves et rétablir les routes et workloads
sauvegardés avec leurs volumes et images compatibles. Cette procédure ne
prescrit ni suppression de données, ni restauration destructive, ni double
montage concurrent de PostgreSQL. Les anciens états et manifestes conservés
servent au retour arrière, sans réécriture de leur historique.

### Protection du playbook historique après migration

Le retour Copilot [discussion #4263122333](https://github.com/thedamfr/gthf-frontend/pull/41#discussion_r4263122333)
a identifié qu'un `apply -k` sur le nouveau namespace pouvait sinon provisionner
un PVC vide. Le playbook invoque `require-qualified-storage.py` avant toute
mutation Kubernetes. Une preuve absente, une qualification incomplète, un
namespace recréé, un PVC non lié ou une divergence de PV/UID/hostPath bloque
l'application. Ce garde-fou ne participe pas à l'amorçage du script de migration.

Après les Golden Journeys réels de staging **et** production, l'opérateur
consigne `/home/ubuntu/gthf-delivery/rename-qualified.json`, fichier régulier
privé mode 600 détenu par `ubuntu`. Son schéma est le suivant ; les valeurs
entre chevrons doivent être remplacées par les valeurs vérifiées, jamais par
un état simulé :

```json
{
  "schemaVersion": 1,
  "status": "qualified",
  "namespace": "gthf-staging",
  "namespaceUid": "<UID du namespace vérifié>",
  "qualifiedAt": "<date UTC ISO-8601 des Golden Journeys>",
  "runtimeRevisions": { "frontend": "<SHA servi de 40 caractères>", "cms": "<SHA servi de 40 caractères>" },
  "goldenJourneys": { "staging": "passed", "production": "passed" },
  "storage": {
    "pvc": "gthf-postgres",
    "pvcUid": "<UID du PVC vérifié>",
    "pv": "gthf-staging-postgres-preserved",
    "pvUid": "<UID du PV vérifié>",
    "hostPath": "<chemin existant conservé et vérifié>"
  }
}
```

Le PV doit rester `Bound`, avec rétention `Retain`, affinité de nœud et
`claimRef` correspondant au namespace, au nom et à l'UID du PVC. Le garde-fou
ne lit aucun Secret. `npm run test:delivery` couvre les volumes absents,
nouvellement provisionnés, réattribués, les mauvais chemins et les preuves
incomplètes. Les preuves du code de garde-fou sont distinctes des SHA runtime
construits avant cette correction d'infrastructure.
