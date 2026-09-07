ARG SOURCE_DATE_EPOCH=1704067200
ARG BUILD_IMAGE
ARG EXECUTOR_IMAGE
FROM ${BUILD_IMAGE} AS build
ARG SOURCE_DATE_EPOCH
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -buildid=" -o /out/exec01-runtime ./main.go \
 && touch -d "@${SOURCE_DATE_EPOCH}" /out /out/exec01-runtime

FROM ${EXECUTOR_IMAGE}
ARG SOURCE_DATE_EPOCH
RUN mkdir -p /opt/sandiva/bin \
 && touch -d "@${SOURCE_DATE_EPOCH}" /opt /opt/sandiva /opt/sandiva/bin
COPY --from=build --chmod=0555 /out/exec01-runtime /opt/sandiva/bin/exec01-runtime
COPY --chmod=0444 policy/ /opt/sandiva/
USER 65532:65532
ENTRYPOINT ["/opt/sandiva/bin/exec01-runtime"]
