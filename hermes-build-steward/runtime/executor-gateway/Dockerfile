ARG PYTHON_IMAGE
FROM ${PYTHON_IMAGE}
WORKDIR /opt/sandiva/gateway
COPY src/hermes_steward /opt/sandiva/gateway/hermes_steward
COPY runtime/executor-gateway/entrypoint.py /opt/sandiva/bin/exec01-gateway
ENV PYTHONPATH=/opt/sandiva/gateway
USER 65532:65532
ENTRYPOINT ["python", "/opt/sandiva/bin/exec01-gateway"]
