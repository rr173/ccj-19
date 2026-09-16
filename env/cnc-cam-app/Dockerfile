FROM node:20-alpine
WORKDIR /app
COPY . .
RUN node test/run-tests.js && node test/dom-shim-test.js
ENV PORT=8081
EXPOSE 8081
CMD ["node", "server.js"]
