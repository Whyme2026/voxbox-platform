# Service de montage Why me : Node (sans dépendance) + ffmpeg. Image linux/amd64 pour Cloudflare Containers.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY monter.ts serveur.ts signature.ts ./
COPY polices ./polices
COPY motifs ./motifs
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "--no-warnings", "serveur.ts"]
