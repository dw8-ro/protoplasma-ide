# Hosted hub image (Railway or any container host). Hub only: no Electron, no node-pty.
# Env: PORT, DATA_DIR (mount a volume so teams survive redeploys), PROTO_OWNERS (logins allowed to create teams).
# Runs as root because platform volumes are mounted root-owned.
FROM node:24-alpine
WORKDIR /hub
RUN npm install --no-save ws@8.22.0
COPY src/hub.js src/shared.js ./src/
CMD ["node", "src/hub.js"]
