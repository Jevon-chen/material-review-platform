FROM node:18-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
# Zeabur persistent disk will mount at /data
# Create local dirs as fallback
RUN mkdir -p /app/data /app/uploads /data 2>/dev/null || true
EXPOSE 3000
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV UPLOAD_DIR=/data/uploads
CMD ["node", "server.js"]
