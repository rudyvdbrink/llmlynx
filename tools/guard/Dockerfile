# syntax=docker/dockerfile:1
# The guard for llmlynx (see docker-compose.yml): scans text
# for prompt injections with Llama Prompt Guard 2, on the CPU with onnxruntime.
# The image holds exactly one model, chosen with the GUARD_MODEL build
# argument: 22m (the default) or 86m. The build downloads it as an ONNX file
# from a public repository, at a pinned revision, and checks every file
# against its SHA-256 (build/models.json): it needs no account and no token.
# The model is under the Llama 4 Community License; its LICENSE and NOTICE are
# in the image, beside the model. Update the pins in build/models.json and in
# requirements.txt regularly.
ARG GUARD_MODEL=22m

FROM python:3.13-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ORT_DISABLE_TELEMETRY=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --root-user-action=ignore -r requirements.txt

# Downloads the pinned model, checks it and runs it once (build/prepare_model.py)
FROM base AS model
ARG GUARD_MODEL
WORKDIR /build
COPY build/prepare_model.py build/models.json src/model.py ./
RUN GUARD_MODEL="$GUARD_MODEL" python prepare_model.py /build/model

FROM base
COPY --from=model /build/model ./model
COPY src ./src
COPY bench.py ./
# The model is in the image: the server makes no request to Hugging Face
ENV HF_HUB_OFFLINE=1
# The server runs as an unprivileged user, in a read-only container (see docker-compose.yml)
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin guard
USER guard
WORKDIR /app/src
EXPOSE 8080
CMD ["python", "server.py"]
