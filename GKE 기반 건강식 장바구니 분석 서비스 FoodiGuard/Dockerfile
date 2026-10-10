FROM node:22-alpine AS build

WORKDIR /app

COPY mobile/package*.json ./
RUN npm ci

COPY mobile/ ./
RUN npx expo export --platform web

FROM nginx:1.27-alpine

# 백엔드 위치는 배포 환경마다 다르므로 실행 시 API_UPSTREAM으로 주입한다.
ENV API_UPSTREAM=http://foodiguard-api.default.svc.cluster.local
ENV NGINX_ENVSUBST_FILTER=^API_

COPY nginx.conf /etc/nginx/templates/default.conf.template
RUN rm -rf /usr/share/nginx/html/*
COPY --from=build /app/dist/ /usr/share/nginx/html/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
