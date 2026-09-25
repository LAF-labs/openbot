#!/bin/sh
# The Bot's browser may reach the internet and nothing inside this deployment's network.
#
# WHY A FIREWALL AS WELL AS THE NAVIGATION GUARD. The guard (src/navigation-guard.ts) judges every
# document a page asks for, resolving its name first — but Chromium resolves the name again to send
# it, so a zone answering publicly to one lookup and privately to the next walks past it (DNS
# rebinding), and an image, a script or a `fetch()` is never paused for a verdict at all. Security
# review 2026-09-25 F1: a page the Bot opened could reach 169.254.169.254, this VM's Postgres and
# the host itself. Rules in this container's own network namespace are the one place every request
# the browser makes has to pass, whatever its name resolved to and whatever asked for it.
#
# What is refused: loopback-to-host, RFC 1918, CGNAT, link-local (the cloud metadata endpoint is
# 169.254.169.254 on AWS, OCI and GCP alike), and the reserved ranges `shared/net/host-verdict.ts`
# refuses by address — the same list, at the packet. What stays open: this container's own loopback
# (Docker's resolver is 127.0.0.11), answers on connections somebody else opened (the server calling
# :4100 — that is how its legitimate path keeps working), and the deployment's own egress proxy if
# it names one.
#
# Then this process gives up root for good. The rules are written as root with NET_ADMIN, and the
# computer runs as `pwuser` with an empty capability bounding set and no_new_privs, so nothing the
# browser runs can take them down again — not even a setuid binary.
#
# FAILS CLOSED. A container whose rules could not be written does not start: the Bot without a
# computer is an outage somebody sees; the Bot whose computer quietly reaches the metadata endpoint
# is not. AGENT_COMPUTER_EGRESS_FIREWALL=off is the one way past it, for a runtime that cannot grant
# NET_ADMIN, and it says so in the log.
set -eu

say() { printf '{"level":"%s","service":"agent-computer","event":"%s"%s}\n' "$1" "$2" "${3:-}"; }

drop_to_pwuser() {
  exec setpriv --reuid=pwuser --regid=pwuser --init-groups \
    --inh-caps=-all --bounding-set=-all --no-new-privs \
    env HOME=/home/pwuser "$@"
}

if [ "${AGENT_COMPUTER_EGRESS_FIREWALL:-on}" = "off" ]; then
  say warn egress_firewall_off
  if [ "$(id -u)" = 0 ]; then drop_to_pwuser "$@"; fi
  exec "$@"
fi

if [ "$(id -u)" != 0 ]; then
  say error egress_firewall_needs_root ',"hint":"run as root with cap_add NET_ADMIN (docker-compose.yml), or AGENT_COMPUTER_EGRESS_FIREWALL=off"'
  exit 1
fi

# Always refused, the private-host opt-in included: link-local holds the metadata endpoint.
ALWAYS4="169.254.0.0/16"
ALWAYS6="fe80::/10 fd00:ec2::254/128"
# Refused unless the deployment opted into browsing its own network (a laptop, never the fleet).
PRIVATE4="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/3"
PRIVATE6="::/128 ::1/128 ::ffff:0:0/96 64:ff9b::/96 fc00::/7 fec0::/10 ff00::/8"
if [ "${AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS:-}" = "true" ]; then
  PRIVATE4=""
  PRIVATE6=""
fi

# The egress proxy, when there is one, is the one private address the browser must reach.
PROXY_HOST=""
PROXY_PORT=""
if [ -n "${EGRESS_PROXY_DEFAULT:-}" ]; then
  hostport=$(printf '%s' "$EGRESS_PROXY_DEFAULT" | sed -E 's#^[a-z0-9+]+://##; s#/.*$##; s#^.*@##')
  PROXY_PORT=$(printf '%s' "$hostport" | sed -nE 's#^.*:([0-9]+)$#\1#p')
  PROXY_HOST=$(getent ahostsv4 "${hostport%:*}" | awk 'NR==1{print $1}')
  PROXY_PORT=${PROXY_PORT:-8080}
fi

apply() {
  tool=$1
  always=$2
  private=$3
  "$tool" -w -N LAF_EGRESS 2>/dev/null || "$tool" -w -F LAF_EGRESS
  "$tool" -w -A LAF_EGRESS -o lo -j RETURN
  "$tool" -w -A LAF_EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  if [ "$tool" = iptables ] && [ -n "$PROXY_HOST" ]; then
    "$tool" -w -A LAF_EGRESS -d "$PROXY_HOST" -p tcp --dport "$PROXY_PORT" -j RETURN
  fi
  # The resolver, port 53 only. Under compose it is Docker's own on 127.0.0.11 (loopback, above);
  # on a default bridge it is whatever the host names — 192.168.65.7 on Docker Desktop, and on OCI
  # the VCN resolver is 169.254.169.254 itself, whose port 80 stays refused. Measured 2026-09-25:
  # without this, a container on the default bridge could resolve nothing and reached no site at all.
  for server in $(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf); do
    case "$tool:$server" in
      iptables:*:*|ip6tables:*.*) continue ;;
    esac
    for protocol in udp tcp; do
      "$tool" -w -A LAF_EGRESS -d "$server" -p "$protocol" --dport 53 -j RETURN
    done
  done
  for range in $always $private; do
    # REJECT, not DROP: a refused page fails at once instead of hanging for the whole timeout.
    "$tool" -w -A LAF_EGRESS -d "$range" -j REJECT
  done
  "$tool" -w -C OUTPUT -j LAF_EGRESS 2>/dev/null || "$tool" -w -I OUTPUT 1 -j LAF_EGRESS
}

if ! apply iptables "$ALWAYS4" "$PRIVATE4"; then
  say error egress_firewall_failed ',"family":"ipv4"'
  exit 1
fi

# IPv6 matters only where the container has a routable IPv6 address; Docker gives none by default.
# Where it has one, rules that cannot be written are the same failure as above.
if ! apply ip6tables "$ALWAYS6" "$PRIVATE6" 2>/dev/null; then
  if awk '$4 != "20" && $4 != "10" { found = 1 } END { exit !found }' /proc/net/if_inet6 2>/dev/null; then
    say error egress_firewall_failed ',"family":"ipv6"'
    exit 1
  fi
  say info egress_firewall_no_ipv6
fi

say info egress_firewall_on ",\"privateHostsAllowed\":$([ -z "$PRIVATE4" ] && echo true || echo false)"
drop_to_pwuser "$@"
