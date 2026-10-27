ARG NODE_IMAGE=node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

FROM ${NODE_IMAGE} AS downloader

ARG OMP_VERSION=18.1.2
ARG OMP_ASSET_SHA256=c6a306347a57c872bf38587e81132db50490228867e3e179a363a4cf874da1a0

RUN apt-get -o Acquire::http::Timeout=10 -o Acquire::Retries=2 update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && curl --fail --location --proto '=https' --tlsv1.2 \
    "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-x64" \
    --output /tmp/omp \
  && printf '%s  %s\n' "${OMP_ASSET_SHA256}" /tmp/omp | sha256sum --check --strict \
  && chmod 0555 /tmp/omp

FROM ${NODE_IMAGE} AS omp-runtime

ARG OMP_VERSION=18.1.2
ARG OMP_NATIVE_BASELINE_SHA256=cb35f7aa87353e1d603b39636236ef31fe8f776af231ec319a981e6a69d812f4

ENV COUNCIL_OMP_VERSION=${OMP_VERSION}

LABEL org.opencontainers.image.title="Council OMP isolated runtime" \
  org.opencontainers.image.version="${OMP_VERSION}" \
  org.opencontainers.image.source="https://github.com/can1357/oh-my-pi/tree/v18.1.2" \
  org.opencontainers.image.licenses="MIT"

RUN apt-get -o Acquire::http::Timeout=10 -o Acquire::Retries=2 update \
  && apt-get install -y --no-install-recommends bash git libarchive-tools ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 omp \
  && useradd --system --uid 10001 --gid omp --home-dir /home/omp omp \
  && mkdir -p /usr/local/libexec/council /usr/share/licenses/omp /opt/council-omp-config /council-config /workspace \
  && chown omp:omp /council-config /workspace \
  && chmod 0555 /usr/local/libexec/council /opt/council-omp-config \
  && chmod 0755 /council-config /workspace

COPY --from=downloader --chown=root:root /tmp/omp /usr/local/bin/omp
COPY --chown=root:root deploy/omp-runtime/init-workspace.mjs /usr/local/libexec/council/init-workspace.mjs
COPY --chown=root:root deploy/omp-runtime/collect-artifacts.mjs /usr/local/libexec/council/collect-artifacts.mjs
COPY --chown=root:root deploy/omp-runtime/run-omp.sh /usr/local/libexec/council/run-omp.sh
COPY --chown=root:root deploy/omp-runtime/LICENSE.omp /usr/share/licenses/omp/LICENSE
COPY --chown=root:root deploy/omp-runtime/THIRD_PARTY_NOTICES.md /usr/share/licenses/omp/THIRD_PARTY_NOTICES.md

RUN chmod 0555 /usr/local/bin/omp /usr/local/libexec/council/*.mjs /usr/local/libexec/council/run-omp.sh \
  && chmod 0444 /usr/share/licenses/omp/* \
  && mkdir -p /tmp/omp-native-home /tmp/omp-native-agent \
  && (HOME=/tmp/omp-native-home PI_CODING_AGENT_DIR=/tmp/omp-native-agent \
    timeout 30s omp --mode rpc --no-rules --no-skills --no-extensions --no-title --no-tools \
    </dev/null >/tmp/omp-native-extract.log 2>&1 || true) \
  && printf '%s  %s\n' "${OMP_NATIVE_BASELINE_SHA256}" \
    "/tmp/omp-native-home/.omp/natives/${OMP_VERSION}/pi_natives.linux-x64-baseline.node" \
    | sha256sum --check --strict \
  && install -m 0555 \
    "/tmp/omp-native-home/.omp/natives/${OMP_VERSION}/pi_natives.linux-x64-baseline.node" \
    /usr/local/bin/pi_natives.linux-x64-baseline.node \
  && rm -rf /tmp/omp-native-home /tmp/omp-native-agent /tmp/omp-native-extract.log \
  && omp --version

USER 10001:10001
WORKDIR /workspace
CMD ["omp", "--version"]
