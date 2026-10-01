#!/usr/bin/env bash
# WHARF owns only WHARF-POOLER and its jump. Never flush DOCKER-USER or save
# Docker's complete transient ruleset. Tenant policies are installed first.
set -euo pipefail
exec 9>/run/lock/wharf-pooler-firewall.lock
flock -x 9

iptables -w 5 -S DOCKER-USER >/dev/null 2>&1 || {
  echo 'Docker DOCKER-USER is unavailable. This feature requires Docker with the iptables backend (including iptables-nft).' >&2
  exit 1
}

container=$(docker ps -q --filter label=com.docker.compose.project=wharf-pooler --filter label=com.docker.compose.service=supavisor)
if [[ ! "$container" =~ ^[a-f0-9]+$ ]]; then
  # A stopped pooler must not leave rules accepting traffic to a recycled IP.
  if [[ "${1:-}" != '--check' ]]; then
    for tool in iptables ip6tables; do
      if command -v "$tool" >/dev/null && "$tool" -w 5 -S WHARF-POOLER >/dev/null 2>&1; then
        "$tool" -w 5 -F WHARF-POOLER
      fi
    done
  fi
  echo 'Exactly one running WHARF pooler is required.' >&2
  exit 1
fi

# WHARF owns these public host ports; refuse a different mapping.
for port in 5432 6543; do
  mappings=$(docker port "$container" "$port/tcp")
  echo "$mappings" | grep -Fxq "0.0.0.0:$port" || {
    echo "The WHARF pooler must publish host port $port on IPv4." >&2
    exit 1
  }
done
ipv4=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{if .IPAddress}}{{println .IPAddress}}{{end}}{{end}}' "$container")
ipv6=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{if .GlobalIPv6Address}}{{println .GlobalIPv6Address}}{{end}}{{end}}' "$container")
[[ -n "$ipv4" ]] || { echo 'The pooler has no IPv4 container address.' >&2; exit 1; }
for ip in $ipv4; do
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
done
for ip in $ipv6; do
  [[ "$ip" =~ ^[a-fA-F0-9:]+$ ]] || exit 1
done
if [[ -n "$ipv6" ]]; then
  ip6tables -w 5 -S DOCKER-USER >/dev/null
fi
[[ "${1:-}" != '--check' ]] || exit 0

apply_family() {
  local tool="$1" restore="$2" addresses="$3" bits="$4"
  # Atomic replacement of our chain only. Match both the actual container
  # destination and ORIGINAL published port, after Docker's DNAT. A database
  # container, the admin API, and a differently published port never match.
  {
    echo '*filter'
    echo ':WHARF-POOLER - [0:0]'
    echo '-F WHARF-POOLER'
    for ip in $addresses; do
      for port in 5432 6543; do
        echo "-A WHARF-POOLER -d $ip/$bits -p tcp --dport $port -m conntrack --ctdir ORIGINAL --ctstate DNAT --ctorigdstport $port -j ACCEPT"
        # A blanket DOCKER-USER drop may otherwise discard the matching reply
        # before Docker's own established-connection rule can see it.
        echo "-A WHARF-POOLER -s $ip/$bits -p tcp --sport $port -m conntrack --ctdir REPLY --ctstate DNAT --ctorigdstport $port -j ACCEPT"
      done
    done
    echo 'COMMIT'
  } | "$restore" --wait 5 --noflush

  # Keep our exception before pre-existing source restrictions. Removing only
  # our own jump is safe to repeat and preserves every administrator rule.
  while "$tool" -w 5 -C DOCKER-USER -m comment --comment wharf-pooler -j WHARF-POOLER 2>/dev/null; do
    "$tool" -w 5 -D DOCKER-USER -m comment --comment wharf-pooler -j WHARF-POOLER
  done
  "$tool" -w 5 -I DOCKER-USER 1 -m comment --comment wharf-pooler -j WHARF-POOLER
}

apply_family iptables iptables-restore "$ipv4" 32
if command -v ip6tables >/dev/null && ip6tables -w 5 -S DOCKER-USER >/dev/null 2>&1; then
  apply_family ip6tables ip6tables-restore "$ipv6" 128
fi
