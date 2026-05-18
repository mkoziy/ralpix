FROM node:22-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/mkoziy/ralpix"
LABEL org.opencontainers.image.description="pi with the ralpix extension, ripgrep, and fzf preinstalled"

ENV DEBIAN_FRONTEND=noninteractive
ENV FZF_DEFAULT_COMMAND="rg --files --hidden --follow --glob '!.git'"
ENV FZF_CTRL_T_COMMAND="rg --files --hidden --follow --glob '!.git'"
ENV PI_AGENT_DIR=/home/pi/.pi/agent
ENV PI_KNOWLEDGE_CUTOFF=2025-01-01
ENV RALPIX_HOME=/home/pi/.ralpix

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    fd-find \
    fzf \
    git \
    ripgrep \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @earendil-works/pi-coding-agent

RUN useradd --create-home --shell /bin/bash pi \
  && mkdir -p /opt/ralpix "${PI_AGENT_DIR}" "${RALPIX_HOME}" /workspace \
  && chown -R pi:pi /opt/ralpix /home/pi /workspace

WORKDIR /opt/ralpix
COPY . .

RUN printf '{\n  "packages": [\n    "/opt/ralpix"\n  ]\n}\n' > "${PI_AGENT_DIR}/settings.json" \
  && cp docker/pi-agent/AGENTS.md "${PI_AGENT_DIR}/AGENTS.md" \
  && cp docker/pi-agent/start-pi.sh /usr/local/bin/start-pi \
  && chmod +x /usr/local/bin/start-pi \
  && chown -R pi:pi "${PI_AGENT_DIR}" "${RALPIX_HOME}"

USER pi
WORKDIR /workspace

CMD ["start-pi"]
