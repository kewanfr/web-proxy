# 🔒 web-proxy

Web proxy auto-hébergé. Toutes les requêtes (HTML, CSS, JS, images…) transitent par le backend Node.js — le réseau ne voit que ton serveur proxy.

## Structure

```
web-proxy/
├── src/
│   ├── server.js      # Backend Node.js (Express + réécriture des URLs)
│   └── index.html     # Interface frontend servie par le backend
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example
├── .dockerignore
└── .gitignore
```

## Démarrage rapide

```bash
# 1. Cloner / copier le repo
git clone <ton-repo> web-proxy && cd web-proxy

# 2. Configurer le port (optionnel, défaut : 3000)
cp .env.example .env
# éditer .env si besoin

# 3. Build & lancer
docker compose up -d --build

# Accès : http://localhost:3000
```

## Configuration reverse proxy

Le conteneur écoute sur `HOST_PORT` (défaut `3000`).  
Pointe ton reverse proxy vers `http://localhost:3000` (ou `http://web-proxy:3000` si même stack Docker).

### Exemples

**Caddy** (`Caddyfile`) :
```
proxy.tondomaine.com {
    reverse_proxy localhost:3000
}
```

**Nginx** :
```nginx
server {
    listen 80;
    server_name proxy.tondomaine.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
    }
}
```

**Traefik** (labels dans docker-compose.yml) :
```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.web-proxy.rule=Host(`proxy.tondomaine.com`)"
  - "traefik.http.services.web-proxy.loadbalancer.server.port=3000"
```

### Même stack Docker que le reverse proxy

Si ton reverse proxy tourne déjà dans Docker avec un réseau partagé (`proxy-net` par exemple), dans `docker-compose.yml` :

```yaml
networks:
  proxy-net:
    external: true   # décommenter cette ligne
```

Et pointe vers `http://web-proxy:3000`.

## Commandes utiles

```bash
# Logs en temps réel
docker compose logs -f

# Arrêter
docker compose down

# Rebuild après modification
docker compose up -d --build

# Sans Docker (dev local)
npm install
node src/server.js
```

## Fonctionnement

1. Tu entres une URL dans la barre de recherche
2. Le frontend envoie la requête à `/proxy/<url encodée en base64>`
3. Le serveur Node.js fetch la page distante, réécrit toutes les URLs (src, href, CSS url(), @import…) pour qu'elles repassent par le proxy
4. Un script est injecté dans chaque page pour intercepter les requêtes dynamiques (fetch, XHR, history, clics)
5. Le réseau ne voit que des connexions vers ton serveur proxy

## Limites

- Les sites avec anti-iframe strict peuvent ne pas s'afficher
- Les WebSockets ne sont pas proxifiés
- Les SPA très complexes peuvent générer ponctuellement des requêtes directes
