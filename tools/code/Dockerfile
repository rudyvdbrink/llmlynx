# Runs code, installs packages and runs git for llmlynx's chats (see
# docker-compose.yml): Python and Node.js, each run in a bubblewrap jail of its
# own without network.
# Python and Node.js are the current long-term versions, pinned; Node.js and
# npm come from the official node image. The libraries every run has are in
# requirements-builtin.txt; the server's own are in a virtual environment that
# runs do not see. Update the pins here and in both requirements files regularly.
FROM node:26.13.1-bookworm-slim AS node

FROM python:3.14.10-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
# bubblewrap makes the jails; Node.js needs the C++ runtime and libatomic
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap libstdc++6 libatomic1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version
# The libraries every run has, so most work needs no install
COPY requirements-builtin.txt /opt/
RUN pip install --root-user-action=ignore -r /opt/requirements-builtin.txt
# The server, in an environment of its own
COPY requirements.txt /opt/server/
RUN python -m venv /opt/server/venv && /opt/server/venv/bin/pip install -r /opt/server/requirements.txt
# git, for the git tool only (src/gitrepo.py): it is moved out of /usr to /opt/git, which only
# git's jails see, so runs of code have no git. Its hooks and templates folders stay empty.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/git/hooks /opt/git/templates \
    && mv /usr/lib/git-core /opt/git/libexec \
    && rm -rf /usr/bin/git /usr/bin/git-* /usr/bin/scalar /usr/share/git-core /usr/share/gitweb /usr/share/perl5/Git /usr/share/perl5/Git.pm \
    && GIT_EXEC_PATH=/opt/git/libexec /opt/git/libexec/git --version \
    && ! command -v git
COPY gitconfig /opt/git/gitconfig
# What runs inside each jail, and matplotlib's font list, made once here rather than in every run
COPY jail /opt/jail
RUN MPLCONFIGDIR=/opt/jail/matplotlib python -c "import matplotlib.font_manager" \
    && chmod -R a+rX /opt/jail
# How a run finds the chat's packages, also when its code sets PYTHONPATH (see sitecustomize.py)
COPY sitecustomize.py /opt/
RUN mv /opt/sitecustomize.py "$(python -c 'import sysconfig; print(sysconfig.get_path("purelib"))')/" \
    && python -c "import sitecustomize"
COPY src /opt/server/src
COPY bench.py /opt/server/
# The server runs as an unprivileged user, in a read-only container; installed
# packages go to /packages, a volume of their own (see docker-compose.yml)
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin code \
    && mkdir /packages && chown code /packages
USER code
WORKDIR /opt/server/src
EXPOSE 8080
CMD ["/opt/server/venv/bin/python", "server.py"]
