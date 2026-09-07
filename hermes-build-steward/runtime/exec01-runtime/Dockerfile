ARG BUILD_IMAGE
ARG EXECUTOR_IMAGE
FROM ${BUILD_IMAGE} AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -buildid=" -o /out/exec01-runtime ./main.go

FROM ${EXECUTOR_IMAGE}
COPY --from=build --chmod=0555 /out/exec01-runtime /opt/sandiva/bin/exec01-runtime
USER 65532:65532
ENTRYPOINT ["/opt/sandiva/bin/exec01-runtime"]
