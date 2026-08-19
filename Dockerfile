FROM node:14

WORKDIR /app

COPY server.js .
COPY package.json .

RUN npm install

EXPOSE 3000

CMD ["npm", "run", "dev"]