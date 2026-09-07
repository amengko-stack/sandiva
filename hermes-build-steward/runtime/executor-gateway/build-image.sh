#!/bin/sh
set -eu
case "${1:-}" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "python image must be digest pinned" >&2; exit 2;; esac
tag="${2:-sandiva-exec01-gateway:code-qa}"
root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
epoch="${SOURCE_DATE_EPOCH:-1704067200}"
archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT HUP INT TERM
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='*.pyo' \
  -C "$root" -cf "$archive" .
docker buildx build --pull=false --provenance=false \
  --build-arg "SOURCE_DATE_EPOCH=$epoch" --build-arg "PYTHON_IMAGE=$1" \
  --output "type=docker,name=$tag,rewrite-timestamp=true" \
  -f runtime/executor-gateway/Dockerfile - < "$archive"
docker image inspect "$tag" --format '{{.Id}}'
