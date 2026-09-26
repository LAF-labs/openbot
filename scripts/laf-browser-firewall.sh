#!/usr/bin/env bash
# laf-browser-firewall — the host's rules for the Bot's browser (docs/laf/deploying.md, "The other
# direction is the host's job too"). The fleet installs it as /usr/local/sbin/laf-browser-firewall
# with a unit ordered after docker.service; a self-hosted VM runs it as root before `compose up`
# and after every boot: `sudo ./scripts/laf-browser-firewall.sh apply`. `remove` takes it away.
# The same rules as laf-control's core/host-firewall.ts, which the fleet writes from.
set -Eeuo pipefail
# A failure inside $(…) — the rules not applied — must fail the run, not vanish into a summary.
shopt -s inherit_errexit

root="${LAF_FIREWALL_ROOT:-}"
bridge=laf-browser
env_file="${LAF_ENV_FILE:-$root/home/ubuntu/openbot/.env}"
forward_chain=LAF-BROWSER
host_chain=LAF-BROWSER-HOST

always4="169.254.0.0/16"
always6="fe80::/10 fd00:ec2::254/128"
private4="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/3"
private6="::/128 ::1/128 ::ffff:0:0/96 64:ff9b::/96 fc00::/7 fec0::/10 ff00::/8"

say() { logger -t laf-browser-firewall "$*" 2>/dev/null || true; }

env_value() {
  [ -r "$env_file" ] || return 0
  sed -n "s/^$1=//p" "$env_file" | tail -n 1 | tr -d "\"' "
}

private=refused
if [ "$(env_value AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS)" = true ]; then
  private=allowed
  private4=""
  private6=""
fi

# The upstreams Docker's resolver forwards to. Ubuntu's /etc/resolv.conf names systemd-resolved's
# stub (127.0.0.53), which Docker skips for the file behind it — so this reads that file too.
resolvers() {
  local file="$root/etc/resolv.conf"
  [ -r "$root/run/systemd/resolve/resolv.conf" ] && file="$root/run/systemd/resolve/resolv.conf"
  [ -r "$file" ] || return 0
  awk '$1 == "nameserver" { print $2 }' "$file" | grep -v -E '^(127\.|::1$)' || true
}

# The deployment's egress proxy, when it names one: the one private address the browser must reach.
proxy_host=""
proxy_port=""
proxy="$(env_value EGRESS_PROXY_DEFAULT)"
if [ -n "$proxy" ]; then
  hostport=$(printf '%s' "$proxy" | sed -E 's#^[a-zA-Z0-9+]+://##; s#/.*$##; s#^.*@##')
  proxy_port=$(printf '%s' "$hostport" | sed -nE 's#^.*:([0-9]+)$#\1#p')
  proxy_port=${proxy_port:-8080}
  proxy_host=$(getent ahostsv4 "${hostport%:*}" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)
fi

rules() {
  local family=$1 reject always ranges server protocol range
  if [ "$family" = 4 ]; then
    reject=icmp-admin-prohibited
    always=$always4
    ranges=$private4
  else
    reject=icmp6-adm-prohibited
    always=$always6
    ranges=$private6
  fi
  echo "*filter"
  echo ":$forward_chain - [0:0]"
  echo ":$host_chain - [0:0]"
  # Across the bridge: the server calling the computer, and nothing else.
  echo "-A $forward_chain -o $bridge -p tcp --dport 4100 -j RETURN"
  echo "-A $forward_chain -o $bridge -j REJECT --reject-with $reject"
  for server in $(resolvers); do
    case "$family:$server" in
      4:*:*|6:*.*) continue ;;
    esac
    for protocol in udp tcp; do
      echo "-A $forward_chain -d $server -p $protocol --dport 53 -j RETURN"
      echo "-A $host_chain -d $server -p $protocol --dport 53 -j RETURN"
    done
  done
  if [ "$family" = 4 ] && [ -n "$proxy_host" ]; then
    echo "-A $forward_chain -d $proxy_host -p tcp --dport $proxy_port -j RETURN"
    echo "-A $host_chain -d $proxy_host -p tcp --dport $proxy_port -j RETURN"
  fi
  for range in $always $ranges; do
    echo "-A $forward_chain -d $range -j REJECT --reject-with $reject"
  done
  # The host itself, every port — unless the deployment opted into its own network.
  if [ "$private" = refused ]; then
    echo "-A $host_chain -j REJECT --reject-with $reject"
  fi
  echo "COMMIT"
}

# A jump, once: checked before it is inserted, so a second run adds nothing.
jump() {
  local tool=$1 chain=$2
  shift 2
  "$tool" -w -C "$chain" "$@" 2>/dev/null || "$tool" -w -I "$chain" 1 "$@"
}

unjump() {
  local tool=$1 chain=$2
  shift 2
  while "$tool" -w -C "$chain" "$@" 2>/dev/null; do "$tool" -w -D "$chain" "$@"; done
}

apply_family() {
  local family=$1 tool=iptables forward=DOCKER-USER
  [ "$family" = 6 ] && tool=ip6tables
  rules "$family" | "$tool-restore" -w --noflush
  # Docker jumps to DOCKER-USER from FORWARD before its own rules, and keeps that jump first when
  # it restarts. Where it does not manage this family at all, FORWARD itself is the place.
  "$tool" -w -N DOCKER-USER 2>/dev/null || true
  "$tool" -w -C FORWARD -j DOCKER-USER 2>/dev/null || forward=FORWARD
  jump "$tool" "$forward" -i "$bridge" -m conntrack --ctstate NEW -j "$forward_chain"
  jump "$tool" INPUT -i "$bridge" -m conntrack --ctstate NEW -j "$host_chain"
  echo "$("$tool" -w -S "$forward_chain" | grep -c '^-A') + $("$tool" -w -S "$host_chain" | grep -c '^-A')"
}

remove_family() {
  local tool=$1
  for forward in DOCKER-USER FORWARD; do
    unjump "$tool" "$forward" -i "$bridge" -m conntrack --ctstate NEW -j "$forward_chain"
  done
  unjump "$tool" INPUT -i "$bridge" -m conntrack --ctstate NEW -j "$host_chain"
  for chain in "$forward_chain" "$host_chain"; do
    "$tool" -w -F "$chain" 2>/dev/null || true
    "$tool" -w -X "$chain" 2>/dev/null || true
  done
}

case "${1:-apply}" in
  apply)
    # Bridge-local traffic (the browser to the server beside it) meets iptables only through this.
    bridged=on
    modprobe br_netfilter 2>/dev/null || true
    sysctl -q -w net.bridge.bridge-nf-call-iptables=1 >/dev/null 2>&1 || bridged=off
    sysctl -q -w net.bridge.bridge-nf-call-ip6tables=1 >/dev/null 2>&1 || true
    v4=$(apply_family 4)
    v6=none
    if ip6tables -w -S INPUT >/dev/null 2>&1; then v6=$(apply_family 6); fi
    dns=$(resolvers | tr '\n' ' ' | sed 's/ $//')
    summary="bridge=$bridge v4=$v4 v6=$v6 dns=${dns:-none} private=$private bridged=$bridged${proxy_host:+ proxy=$proxy_host:$proxy_port}"
    say "applied $summary"
    echo "$summary"
    ;;
  remove)
    remove_family iptables
    ip6tables -w -S INPUT >/dev/null 2>&1 && remove_family ip6tables
    say "removed"
    echo "removed"
    ;;
  *)
    echo "usage: $0 [apply|remove]" >&2
    exit 2
    ;;
esac
