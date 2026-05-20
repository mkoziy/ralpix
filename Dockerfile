FROM node:22-bookworm-slim

ARG TARGETARCH

LABEL org.opencontainers.image.source="https://github.com/mkoziy/ralpix"
LABEL org.opencontainers.image.description="pi with the ralpix extension, ripgrep, and fzf preinstalled"

ENV DEBIAN_FRONTEND=noninteractive
ENV FZF_DEFAULT_COMMAND="rg --files --hidden --follow --glob '!.git'"
ENV FZF_CTRL_T_COMMAND="rg --files --hidden --follow --glob '!.git'"
ENV PI_AGENT_DIR=/home/pi/.pi/agent
ENV PI_KNOWLEDGE_CUTOFF=2025-01-01
ENV RALPIX_HOME=/home/pi/.ralpix
ENV REVDIFF_VERSION=v1.3.0
ENV REVDIFF_AUTO_UPDATE=1
ENV REVDIFF_GITHUB_REPO=umputun/revdiff
ENV REVDIFF_INSTALL_DIR=/home/pi/.local/bin
ENV REVDIFF_VERSION_FILE=/home/pi/.local/bin/.revdiff-version
ENV REVDIFF_TARGETARCH=$TARGETARCH
ENV PATH="${REVDIFF_INSTALL_DIR}:$PATH"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    fd-find \
    fzf \
    git \
    ripgrep \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @earendil-works/pi-coding-agent

RUN useradd --create-home --shell /bin/bash pi \
  && mkdir -p /opt/ralpix "${PI_AGENT_DIR}" "${RALPIX_HOME}" /workspace "${REVDIFF_INSTALL_DIR}" \
  && chown -R pi:pi /opt/ralpix /home/pi /workspace

WORKDIR /opt/ralpix
COPY . .

RUN printf '{\n  "packages": [\n    "/opt/ralpix"\n  ]\n}\n' > "${PI_AGENT_DIR}/settings.json" \
  && cp docker/pi-agent/AGENTS.md "${PI_AGENT_DIR}/AGENTS.md" \
  && cp docker/pi-agent/start-pi.sh /usr/local/bin/start-pi \
  && chmod +x /opt/ralpix/docker/pi-agent/revdiff-common.sh \
  && chmod +x /opt/ralpix/docker/pi-agent/install-revdiff.sh \
  && chmod +x /opt/ralpix/docker/pi-agent/update-revdiff.sh \
  && chmod +x /usr/local/bin/start-pi \
  && /opt/ralpix/docker/pi-agent/install-revdiff.sh \
  && chown -R pi:pi "${PI_AGENT_DIR}" "${RALPIX_HOME}" "${REVDIFF_INSTALL_DIR}"

USER pi
WORKDIR /workspace

CMD ["start-pi"]
