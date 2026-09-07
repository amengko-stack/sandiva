ARG SOURCE_DATE_EPOCH=1704067200
ARG PYTHON_IMAGE
FROM ${PYTHON_IMAGE}
ARG SOURCE_DATE_EPOCH
RUN mkdir -p /opt/sandiva/gateway /opt/sandiva/bin \
 && touch -d "@${SOURCE_DATE_EPOCH}" /opt /opt/sandiva /opt/sandiva/gateway /opt/sandiva/bin
WORKDIR /opt/sandiva/gateway
COPY src/hermes_steward /opt/sandiva/gateway/hermes_steward
COPY runtime/executor-gateway/entrypoint.py /opt/sandiva/bin/exec01-gateway
ENV PYTHONPATH=/opt/sandiva/gateway
USER 65532:65532
ENTRYPOINT ["python", "/opt/sandiva/bin/exec01-gateway"]
