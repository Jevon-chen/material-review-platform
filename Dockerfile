FROM node:18-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
RUN mkdir -p data uploads
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
