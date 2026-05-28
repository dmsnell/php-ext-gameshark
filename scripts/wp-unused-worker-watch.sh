#!/usr/bin/env bash
set -Eeuo pipefail

RUN_DIR=${RUN_DIR:?RUN_DIR required}
ROLE=${ROLE:-worker}
INTERVAL=${INTERVAL:-300}
OUT="$RUN_DIR/logs/tmux-workers/${ROLE}.log"
mkdir -p "$(dirname "$OUT")"

while true; do
	{
		echo "=== $(date -u +%FT%TZ) role=$ROLE ==="
		if [[ -f "$RUN_DIR/coverage.json" ]]; then
			node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const count = (o) => Object.keys(o || {}).length;
console.log(`frontend=${count(c.frontend_urls)} admin=${count(c.admin_screens)} rest=${count(c.rest_routes)} xmlrpc=${count(c.xmlrpc_methods)} outcomes=${JSON.stringify(c.outcomes || {})}`);
' "$RUN_DIR/coverage.json" || true
		fi
		case "$ROLE" in
			*Contrarian*|*contrarian*)
				echo "check: low novelty, repeated failures, state collisions, report interpretability, size limits"
				tail -n 20 "$RUN_DIR/logs/events.jsonl" 2>/dev/null | rg '"outcome":"(timeout|server_error|selector_failure|auth_blocked)"' || true
				;;
			*Docs*|*docs*)
				echo "check: overlooked WP surfaces: admin-ajax, admin-post, cron, auth lifecycle, feeds, sitemaps, privacy, import/export"
				tail -n 10 "$RUN_DIR/logs/review-loop.log" 2>/dev/null || true
				;;
			*Test*|*test*|*Smoke*|*smoke*)
				echo "check: smoke gates, routes, login, REST, upload, report write"
				tail -n 20 "$RUN_DIR/logs/php-server.log" 2>/dev/null || true
				;;
			*)
				echo "check: worker progress and recent events"
				tail -n 20 "$RUN_DIR/logs/events.jsonl" 2>/dev/null || true
				;;
		esac
	} >> "$OUT" 2>&1
	sleep "$INTERVAL"
done
