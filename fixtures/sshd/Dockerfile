# Disposable sshd host for the SSH SyncTarget acceptance suite (architecture §7.1
# target 2, §13.4). Test infrastructure only — never a production image.
#
# EXTRA_PACKAGES selects the two hosts the suite needs:
#   "coreutils findutils tar" GNU host: `sha256sum --zero`, `find -print0`, and
#                          POSIX/GNU tar exist, so the §7.3 phase-1 probe passes.
#   ""                     busybox host: the probe MUST fail loudly at acquire.
#
# Key-based auth only. Authorized keys are injected at container start from a
# keypair the test generates, and live under /etc/ssh/authorized_keys/<user> so
# no ownership fixups are needed in the agent's home directory.
FROM alpine:3.21

ARG EXTRA_PACKAGES=""

RUN apk add --no-cache openssh-server ${EXTRA_PACKAGES} \
  && ssh-keygen -A \
  && adduser -D -s /bin/sh agent \
  && passwd -u agent \
  && mkdir -p /etc/ssh/authorized_keys \
  && printf '%s\n' \
    'Port 22' \
    'PermitRootLogin no' \
    'PasswordAuthentication no' \
    'KbdInteractiveAuthentication no' \
    'PubkeyAuthentication yes' \
    'AuthorizedKeysFile /etc/ssh/authorized_keys/%u' \
    'LogLevel VERBOSE' \
    > /etc/ssh/sshd_config \
  && install -d -m 0755 -o agent -g agent /workspace

# sshd deliberately does NOT run as PID 1: the kill matrix (§7.5) kills the real
# sshd process and revives it with `docker exec`, which needs the container — and
# its published port — to outlive the kill.
CMD ["sh", "-c", "/usr/sbin/sshd -e && exec tail -f /dev/null"]
