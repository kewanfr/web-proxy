FROM node:22-alpine

# Métadonnées
LABEL maintainer="web-proxy"
LABEL description="Web proxy auto-hébergé – toutes les requêtes transitent par le serveur Node.js"

# Dossier de travail
WORKDIR /app

# Copie des fichiers de dépendances en premier (cache Docker)
COPY package.json package-lock.json* ./

# Installation des dépendances (prod uniquement)
RUN npm install --omit=dev && npm cache clean --force

# Copie du reste du code
COPY src/ ./src/

# L'application écoute sur ce port (configurable via PORT env)
EXPOSE 3000

# Utilisateur non-root pour la sécurité
RUN addgroup -S proxy && adduser -S proxy -G proxy
USER proxy

# Lancement
CMD ["node", "src/server.js"]
