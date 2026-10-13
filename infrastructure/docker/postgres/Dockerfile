# syntax=docker/dockerfile:1.7

FROM postgis/postgis:17-3.6-alpine@sha256:a8ffa9afeea4ad6eada171fa2afdb57cd3eb90f92ce20156aa2cb8411d70e0cd AS pgvector-build

ADD https://github.com/pgvector/pgvector.git#8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c /tmp/pgvector

RUN apk add --no-cache --virtual .build-deps \
      build-base \
      clang21 \
      llvm21-dev \
    && make -C /tmp/pgvector clean \
    && make -C /tmp/pgvector OPTFLAGS="" \
    && make -C /tmp/pgvector DESTDIR=/tmp/pgvector-root install \
    && install -D -m 0644 /tmp/pgvector/LICENSE /tmp/pgvector-root/usr/share/doc/pgvector/LICENSE

FROM postgis/postgis:17-3.6-alpine@sha256:a8ffa9afeea4ad6eada171fa2afdb57cd3eb90f92ce20156aa2cb8411d70e0cd

LABEL org.opencontainers.image.source="https://github.com/thedamfr/gthf-frontend"
LABEL org.opencontainers.image.description="PostgreSQL 17 with PostGIS 3.6 and pgvector 0.8.6 for GTHF"

COPY --from=pgvector-build /tmp/pgvector-root/ /
