#!/usr/bin/env bash
# ADR 0002 requires this: certbot's renewal timer fails silently, and that is the known
# cost of choosing nginx over Caddy. A cron entry nobody reads is not monitoring, so this
# exits non-zero — wire it to whatever actually pages someone.
#
#   ./check-certificate-expiry.sh staging.example.test 14
set -euo pipefail

HOST="${1:?usage: check-certificate-expiry.sh <host> [warn_days]}"
WARN_DAYS="${2:-14}"

end_date=$(echo | openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null \
  | openssl x509 -noout -enddate | cut -d= -f2)

end_epoch=$(date -d "$end_date" +%s 2>/dev/null || date -jf '%b %d %T %Y %Z' "$end_date" +%s)
days_left=$(( (end_epoch - $(date +%s)) / 86400 ))

echo "certificate for ${HOST} expires in ${days_left} day(s) (${end_date})"
[ "$days_left" -ge "$WARN_DAYS" ] || { echo "ALERT: under ${WARN_DAYS} days" >&2; exit 1; }
