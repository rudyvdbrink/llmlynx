# File tools for llmlynx agents (see docker-compose.yml): MarkItDown reads
# documents, PDFium renders PDF pages, python-docx, python-pptx and openpyxl
# edit Office files, and Pandoc (with Typst for PDF) makes documents. Pandoc
# and Typst come from the official pandoc/typst image, whose versions belong
# together. Update the pins here and in requirements.txt regularly.
FROM pandoc/typst:3.11.0.0-debian AS pandoc

FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ORT_DISABLE_TELEMETRY=1
# The libraries Pandoc links to
RUN apt-get update \
    && apt-get install -y --no-install-recommends liblua5.4-0 libgmp10 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=pandoc /usr/local/bin/pandoc /usr/local/bin/typst /usr/local/bin/
WORKDIR /app
COPY requirements.txt ./
RUN pip install --root-user-action=ignore -r requirements.txt
COPY src ./src
# The tools run as an unprivileged user, in a read-only container (see docker-compose.yml)
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin files
USER files
WORKDIR /app/src
EXPOSE 8080
CMD ["python", "server.py"]
