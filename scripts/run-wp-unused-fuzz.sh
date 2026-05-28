#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PHP_BIN=${PHP_BIN:-"$ROOT/php-src/.install/bin/php"}
GAMESHARK_EXT=${GAMESHARK_EXT:-"$ROOT/extension/modules/gameshark.so"}
DURATION_SECONDS=${DURATION_SECONDS:-7200}
RUN_ID=${RUN_ID:-"gs-unused-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 3)"}
RUN_DIR=${RUN_DIR:-"/tmp/gameshark-wp-$RUN_ID"}
PORT=${PORT:-}
CALLBACK_PORT=${CALLBACK_PORT:-}
PRESERVE=${PRESERVE:-1}

usage() {
	cat <<USAGE
usage: $0 [--duration seconds] [--port port] [--run-dir path]

Environment:
  PHP_BIN=$PHP_BIN
  GAMESHARK_EXT=$GAMESHARK_EXT
  PRESERVE=$PRESERVE
USAGE
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--duration) DURATION_SECONDS=$2; shift 2 ;;
		--port) PORT=$2; shift 2 ;;
		--run-dir) RUN_DIR=$2; shift 2 ;;
		--help) usage; exit 0 ;;
		*) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
	esac
done

WP_SRC="$ROOT/wordpress-develop/src"
WP="$RUN_DIR/site"
LOG_DIR="$RUN_DIR/logs"
REPORT_DIR="$RUN_DIR/reports"
QUEUE_DIR="$RUN_DIR/queue"
UNUSED_DB="$RUN_DIR/gameshark-unused.sqlite"
SMOKE_DB="$RUN_DIR/gameshark-smoke.sqlite"
MANIFEST="$RUN_DIR/manifest.json"
PRIVATE_ENV="$RUN_DIR/db.private.env"

PHP_PID=""
DB_NAME=""
DB_USER=""
DB_PASS=""

find_port() {
	local start=$1
	local end=$2
	local port
	for port in $(seq "$start" "$end"); do
		if ! ss -ltn "( sport = :$port )" | rg -q ":$port\\b"; then
			echo "$port"
			return 0
		fi
	done
	return 1
}

json_escape() {
	node -e 'process.stdout.write(JSON.stringify(process.argv[1]).slice(1,-1))' "$1"
}

write_manifest() {
	local status=${1:-running}
	local now
	now=$(date -u +%FT%TZ)
	cat > "$MANIFEST" <<JSON
{
  "run_id": "$(json_escape "$RUN_ID")",
  "status": "$(json_escape "$status")",
  "updated_at": "$now",
  "run_dir": "$(json_escape "$RUN_DIR")",
  "wp_root": "$(json_escape "$WP")",
  "base_url": "http://127.0.0.1:$PORT",
  "callback_url": "http://127.0.0.1:$CALLBACK_PORT",
  "duration_seconds": $DURATION_SECONDS,
  "php_bin": "$(json_escape "$PHP_BIN")",
  "gameshark_ext": "$(json_escape "$GAMESHARK_EXT")",
  "unused_db": "$(json_escape "$UNUSED_DB")",
  "db_name": "$(json_escape "$DB_NAME")",
  "db_user": "$(json_escape "$DB_USER")",
  "db_host": "127.0.0.1",
  "php_server_pid": ${PHP_PID:-null},
  "php_server_command": "$(json_escape "GAMESHARK_DB=$UNUSED_DB GAMESHARK_UNUSED=1 $PHP_BIN -d extension=$GAMESHARK_EXT -S 127.0.0.1:$PORT -t $WP $RUN_DIR/router.php")",
  "caveat": "This is an observed runtime coverage profile from this transient php -S run, not proof of dead code."
}
JSON
}

create_db() {
	DB_NAME="gs_wp_$(echo "$RUN_ID" | tr -cd '[:alnum:]_' | cut -c1-48)"
	DB_USER="gsu_$(openssl rand -hex 6)"
	DB_PASS="$(openssl rand -hex 18)"
	sudo -n mariadb -uroot <<SQL
CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci;
CREATE USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
CREATE USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL
	cat > "$PRIVATE_ENV" <<ENV
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASS=$DB_PASS
DB_HOST=127.0.0.1
ENV
	chmod 600 "$PRIVATE_ENV"
	"$PHP_BIN" -r 'new mysqli($argv[1], $argv[2], $argv[3], $argv[4]); echo "db ok\n";' 127.0.0.1 "$DB_USER" "$DB_PASS" "$DB_NAME"
}

drop_db() {
	if [[ -n "${DB_NAME:-}" && -n "${DB_USER:-}" ]]; then
		sudo -n mariadb -uroot <<SQL || true
DROP DATABASE IF EXISTS \`$DB_NAME\`;
DROP USER IF EXISTS '$DB_USER'@'127.0.0.1';
DROP USER IF EXISTS '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL
	fi
}

write_wp_config() {
	local salt
	{
		echo "<?php"
		echo "define( 'DB_NAME', '$DB_NAME' );"
		echo "define( 'DB_USER', '$DB_USER' );"
		echo "define( 'DB_PASSWORD', '$DB_PASS' );"
		echo "define( 'DB_HOST', '127.0.0.1' );"
		echo "define( 'DB_CHARSET', 'utf8mb4' );"
		echo "define( 'DB_COLLATE', '' );"
		for salt in AUTH_KEY SECURE_AUTH_KEY LOGGED_IN_KEY NONCE_KEY AUTH_SALT SECURE_AUTH_SALT LOGGED_IN_SALT NONCE_SALT; do
			echo "define( '$salt', '$(openssl rand -hex 32)' );"
		done
		cat <<PHP
\$table_prefix = 'wp_';
define( 'WP_DEBUG', true );
define( 'WP_DEBUG_LOG', true );
define( 'WP_DEBUG_DISPLAY', false );
define( 'SCRIPT_DEBUG', true );
define( 'WP_ENVIRONMENT_TYPE', 'local' );
define( 'WP_DEVELOPMENT_MODE', 'core' );
define( 'FS_METHOD', 'direct' );
define( 'WP_HOME', 'http://127.0.0.1:$PORT' );
define( 'WP_SITEURL', 'http://127.0.0.1:$PORT' );
if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
PHP
	} > "$WP/wp-config.php"
}

write_router() {
	cat > "$RUN_DIR/router.php" <<'PHP'
<?php
$path = parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );
$file = __DIR__ . '/site' . $path;
if ( $path !== '/' && is_file( $file ) ) {
	return false;
}
require __DIR__ . '/site/index.php';
PHP
}

write_fixture_plugin() {
	mkdir -p "$WP/wp-content/plugins/gameshark-fixture"
	cat > "$WP/wp-content/plugins/gameshark-fixture/gameshark-fixture.php" <<'PHP'
<?php
/*
Plugin Name: Gameshark Fixture
Description: Local deterministic plugin for Gameshark WordPress unused-mode fuzzing.
Version: 0.1.0
*/

function gameshark_fixture_value() {
	return array( 'fixture' => true, 'time' => time() );
}

add_action( 'rest_api_init', function () {
	register_rest_route( 'gameshark-fixture/v1', '/ping', array(
		'methods'             => array( 'GET', 'POST' ),
		'permission_callback' => '__return_true',
		'callback'            => function ( WP_REST_Request $request ) {
			return rest_ensure_response( array( 'ok' => true, 'method' => $request->get_method(), 'data' => gameshark_fixture_value() ) );
		},
	) );
} );

add_shortcode( 'gameshark_fixture', function () {
	return '<span class="gameshark-fixture-shortcode">fixture</span>';
} );

add_action( 'wp_ajax_gameshark_fixture_ajax', 'gameshark_fixture_ajax' );
add_action( 'wp_ajax_nopriv_gameshark_fixture_ajax', 'gameshark_fixture_ajax' );
function gameshark_fixture_ajax() {
	wp_send_json_success( gameshark_fixture_value() );
}

add_action( 'admin_post_gameshark_fixture_post', 'gameshark_fixture_admin_post' );
add_action( 'admin_post_nopriv_gameshark_fixture_post', 'gameshark_fixture_admin_post' );
function gameshark_fixture_admin_post() {
	wp_safe_redirect( home_url( '/?gameshark_fixture_post=1' ) );
	exit;
}

add_action( 'admin_menu', function () {
	add_options_page( 'Gameshark Fixture', 'Gameshark Fixture', 'manage_options', 'gameshark-fixture', function () {
		echo '<div class="wrap"><h1>Gameshark Fixture</h1><p>Fixture settings page.</p></div>';
	} );
} );

register_activation_hook( __FILE__, function () {
	if ( ! wp_next_scheduled( 'gameshark_fixture_cron' ) ) {
		wp_schedule_single_event( time() + 60, 'gameshark_fixture_cron' );
	}
} );

add_action( 'gameshark_fixture_cron', function () {
	update_option( 'gameshark_fixture_cron_ran', time() );
} );
PHP
}

start_server() {
	local db=$1
	local log=$2
	GAMESHARK_DB="$db" \
	GAMESHARK_UNUSED=1 \
	GAMESHARK_UNUSED_CAPTURE_QUERY=1 \
	"$PHP_BIN" -d extension="$GAMESHARK_EXT" \
		-S "127.0.0.1:$PORT" -t "$WP" "$RUN_DIR/router.php" \
		> "$log" 2>&1 &
	PHP_PID=$!
	write_manifest running
	for _ in $(seq 1 80); do
		if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
			return 0
		fi
		sleep 0.25
	done
	echo "php -S did not become ready; see $log" >&2
	return 1
}

stop_server() {
	if [[ -n "${PHP_PID:-}" ]] && kill -0 "$PHP_PID" 2>/dev/null; then
		kill -TERM "$PHP_PID" 2>/dev/null || true
		for _ in $(seq 1 40); do
			if ! kill -0 "$PHP_PID" 2>/dev/null; then
				wait "$PHP_PID" 2>/dev/null || true
				PHP_PID=""
				return 0
			fi
			sleep 0.25
		done
		kill -KILL "$PHP_PID" 2>/dev/null || true
		wait "$PHP_PID" 2>/dev/null || true
	fi
	PHP_PID=""
}

generate_reports() {
	mkdir -p "$REPORT_DIR"
	if [[ -f "$UNUSED_DB" ]]; then
		GAMESHARK_DB="$UNUSED_DB" "$PHP_BIN" -d memory_limit=-1 -d extension="$GAMESHARK_EXT" -r 'echo gameshark_unused_report();' > "$REPORT_DIR/unused-latest.txt" 2> "$REPORT_DIR/unused-latest.err" || true
		GAMESHARK_DB="$UNUSED_DB" "$PHP_BIN" -d memory_limit=-1 -d extension="$GAMESHARK_EXT" -r 'echo gameshark_unused_report("json");' > "$REPORT_DIR/unused-latest.json" 2> "$REPORT_DIR/unused-latest-json.err" || true
		"$PHP_BIN" -d memory_limit=-1 "$ROOT/scripts/wp-unused-aggregate-report.php" "$UNUSED_DB" text > "$REPORT_DIR/unused-aggregate.txt" 2> "$REPORT_DIR/unused-aggregate.err" || true
		GAMESHARK_COLOR=always "$PHP_BIN" -d memory_limit=-1 "$ROOT/scripts/wp-unused-aggregate-report.php" "$UNUSED_DB" text > "$REPORT_DIR/unused-aggregate-color.txt" 2> "$REPORT_DIR/unused-aggregate-color.err" || true
		"$PHP_BIN" -d memory_limit=-1 "$ROOT/scripts/wp-unused-aggregate-report.php" "$UNUSED_DB" json > "$REPORT_DIR/unused-aggregate.json" 2> "$REPORT_DIR/unused-aggregate-json.err" || true
	fi
}

cleanup() {
	local status=$?
	stop_server || true
	generate_reports || true
	if [[ "$status" -eq 0 ]]; then
		write_manifest complete || true
	else
		write_manifest partial || true
	fi
	if [[ "$PRESERVE" != "1" ]]; then
		drop_db || true
	else
		echo "preserving MariaDB DB/user for inspection: $DB_NAME / $DB_USER" >> "$LOG_DIR/cleanup.log" 2>/dev/null || true
	fi
	exit "$status"
}
trap cleanup EXIT INT TERM

if [[ ! -x "$PHP_BIN" ]]; then echo "missing PHP_BIN=$PHP_BIN" >&2; exit 2; fi
if [[ ! -f "$GAMESHARK_EXT" ]]; then echo "missing GAMESHARK_EXT=$GAMESHARK_EXT" >&2; exit 2; fi
if [[ ! -d "$WP_SRC" ]]; then echo "missing WordPress source at $WP_SRC" >&2; exit 2; fi
if ! sudo -n mariadb -uroot -e 'SELECT 1' >/dev/null 2>&1; then echo "sudo root MariaDB access is required" >&2; exit 2; fi

PORT=${PORT:-$(find_port 18100 18199)}
CALLBACK_PORT=${CALLBACK_PORT:-$(find_port 18200 18299)}

mkdir -p "$RUN_DIR" "$LOG_DIR" "$REPORT_DIR" "$QUEUE_DIR" "$RUN_DIR/cookies" "$RUN_DIR/screenshots" "$RUN_DIR/traces"
chmod 700 "$RUN_DIR"

echo "run_id=$RUN_ID"
echo "run_dir=$RUN_DIR"
echo "base=http://127.0.0.1:$PORT"
echo "duration_seconds=$DURATION_SECONDS"

cp -a "$WP_SRC" "$WP"
write_router
create_db
write_wp_config
write_fixture_plugin
write_manifest setup

"$PHP_BIN" "$ROOT/scripts/wp-unused-seed.php" "$WP" "$RUN_DIR" "http://127.0.0.1:$PORT" "$RUN_ID" | tee "$LOG_DIR/seed.log"

echo "starting smoke server"
start_server "$SMOKE_DB" "$LOG_DIR/php-smoke.log"

curl -fsS "http://127.0.0.1:$PORT/" >/dev/null
curl -fsS "http://127.0.0.1:$PORT/wp-json/" >/dev/null
curl -fsS "http://127.0.0.1:$PORT/feed/" >/dev/null
curl -fsS "http://127.0.0.1:$PORT/wp-sitemap.xml" >/dev/null || true
curl -fsS "http://127.0.0.1:$PORT/not-found-$RUN_ID" >/dev/null || true

RUN_DIR="$RUN_DIR" BASE_URL="http://127.0.0.1:$PORT" CALLBACK_PORT="$CALLBACK_PORT" DURATION_SECONDS=20 SMOKE_ONLY=1 \
	node "$ROOT/scripts/wp-unused-fuzz-runner.cjs"

stop_server
echo "smoke gate complete"

echo "starting two-hour fuzz server"
start_server "$UNUSED_DB" "$LOG_DIR/php-server.log"
write_manifest fuzzing

RUN_DIR="$RUN_DIR" BASE_URL="http://127.0.0.1:$PORT" CALLBACK_PORT="$CALLBACK_PORT" DURATION_SECONDS="$DURATION_SECONDS" SMOKE_ONLY=0 \
	node "$ROOT/scripts/wp-unused-fuzz-runner.cjs"

stop_server
generate_reports

cat > "$RUN_DIR/summary.md" <<EOF
# Gameshark WordPress unused fuzz run

- Run ID: \`$RUN_ID\`
- Base URL: \`http://127.0.0.1:$PORT\`
- Duration requested: \`$DURATION_SECONDS\` seconds
- Gameshark DB: \`$UNUSED_DB\`
- Aggregate text report: \`$REPORT_DIR/unused-aggregate.txt\`
- Aggregate color text report: \`$REPORT_DIR/unused-aggregate-color.txt\`
- Aggregate JSON report: \`$REPORT_DIR/unused-aggregate.json\`
- Latest request text report: \`$REPORT_DIR/unused-latest.txt\`
- Latest request JSON report: \`$REPORT_DIR/unused-latest.json\`

This is an observed runtime coverage profile from one transient \`php -S\`
WordPress run. It is not proof of dead code.
EOF

write_manifest complete
echo "complete: $RUN_DIR"
