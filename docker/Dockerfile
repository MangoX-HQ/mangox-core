FROM registry.gitlab.com/mangoads/mangox-backend-api/node20-alpine:latest

WORKDIR /app

COPY . .

RUN yarn install

COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

EXPOSE 5555
ENTRYPOINT ["./entrypoint.sh"]
