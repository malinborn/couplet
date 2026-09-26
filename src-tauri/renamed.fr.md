# md-mini s'appelle désormais couplet

**Powerful for you and your AI, yet minimalistic.**

La même app, les mêmes fonctions d'IA, un nouveau nom. Tout ce que vous aviez a suivi tout seul : les fenêtres ouvertes, la position du curseur, les brouillons non enregistrés, les copies de secours, votre thème et vos fichiers récents.

## À faire — une fois, deux minutes

1. **Redémarrez les sessions de vos agents d'IA.** Une session ouverte avant la mise à jour reste reliée à l'ancien md-mini et ne verra pas couplet tant que vous ne l'aurez pas redémarrée.
2. **Réexpliquez-le à votre agent.** Ouvrez **IA → Apprends couplet à ton IA**, copiez le prompt et donnez-le à votre agent. Il enregistre le serveur MCP `couplet` à la place de `mdmini`, remplace le skill `mdmini` par `couplet`, met à jour la note dans `CLAUDE.md` (ou dans la configuration de votre agent) et vous dit à la fin ce qu'il a changé.
3. **Si vous avez installé depuis le DMG et non via Homebrew,** supprimez `/Applications/md-mini.app`. Vos données sont déjà dans couplet, et l'ancienne app, si vous l'ouvrez par mégarde, démarrera vide.

## Pourquoi nous avons changé de nom

**Il existe deux apps nommées mdmini.** L'autre possède mdmini.com. Deux petits éditeurs sous le même nom, ce sont des recherches confuses, un mauvais téléchargement de temps en temps et des rapports de bug sur l'app de quelqu'un d'autre. Nous ne voulions pas en faire votre problème, alors nous nous sommes écartés plutôt que de nous battre pour le nom.

**Et l'ancien nom ne disait plus la vérité.** md-mini a commencé comme un éditeur markdown minimaliste. Il est devenu une page sur laquelle vous et votre agent d'IA travaillez ensemble. L'agent vous amène à une ligne, réécrit le document ouvert sous vos yeux, pose ses questions avec de vrais boutons et répond aux commentaires que vous laissez dans la marge. Un couplet, ce sont deux vers qui se lisent comme un seul, et c'est désormais toute l'idée. Le minimalisme reste : c'est notre façon de construire, simplement plus tout le propos.

## Ce qui fonctionne même sans cela

| | |
|---|---|
| **Terminal** | `mdmini` fonctionne toujours, comme second nom de `couplet`, à côté du court `coup`. Scripts, alias et `$EDITOR` n'ont besoin d'aucun changement. |
| **Agents d'IA** | Un enregistrement MCP sous le nom `mdmini` continue de fonctionner une fois l'agent redémarré, s'il appelle la commande `mdmini` — c'est ainsi que « Teach Your AI » le configurait. Un enregistrement avec le chemin complet vers `md-mini.app` cessera de fonctionner : l'étape 2 le corrige. |
| **Homebrew** | `brew upgrade --cask mdmini` vous fait passer à couplet et continue de fonctionner ensuite. |
| **Vos données** | Déplacées du dossier de md-mini vers celui de couplet au premier lancement. Le dossier de md-mini garde une note indiquant où elles sont parties. |

## Où nous trouver

Le site est désormais **couplet.pro**, et l'ancienne adresse md-mini.com mène au même endroit. Le code reste où il était, sur GitHub.

Merci d'être là depuis le début. Le carnet est le même, il porte simplement un nom qui correspond mieux à ce qu'il fait aujourd'hui.
