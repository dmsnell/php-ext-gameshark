# php-gameshark

`php-gameshark` is a PHP extension for comparing and inspecting separate PHP
executions. It is intended for questions like:

- Which user-defined PHP functions ran during one request but not another?
- Where did this value travel through userland and built-in PHP calls?
- Did a function or method violate a runtime pre-condition or post-condition?
- Which userland declarations were loaded but never reached at runtime?

The extension is loaded into PHP as `gameshark`. The C extension hooks PHP's
runtime, while the Rust core stores run data and reports in SQLite.

## Install And Build

### Supported targets

- PHP 8.2 or newer.
- Linux and macOS.
- Non-ZTS PHP builds.
- Rust with `cargo`.
- PHP development tools for the PHP binary that will load the extension:
  `phpize` and `php-config`.

PHP 8.0, PHP 8.1, and PHP 7.4 are not supported because the extension now
depends on PHP 8.2 declaration observer APIs. Windows support is deferred.

### Checkout

This repository contains the extension plus local upstream checkouts used for
development:

```sh
git submodule update --init --recursive
```

The extension itself lives in `extension/`.

### Build with an existing PHP

Use the `php-config` for the PHP installation that will load `gameshark.so`:

```sh
cd extension
PHP_CONFIG=/path/to/php-config scripts/build-unix.sh
```

The script runs `phpize`, configures the extension, builds the Rust static
library with `cargo build --release --locked`, runs the PHPT suite, and then
performs a small load/trace smoke test.

If `phpize` is not next to `php-config`, set it explicitly:

```sh
PHP_CONFIG=/opt/php/8.3/bin/php-config \
PHPIZE=/opt/php/8.3/bin/phpize \
scripts/build-unix.sh
```

### Build with this repo's local PHP

If the `php-src` submodule has already been built into `php-src/.install`, use:

```sh
cd extension
PHP_CONFIG=../php-src/.install/bin/php-config scripts/build-unix.sh
```

Load the built extension directly:

```sh
../php-src/.install/bin/php \
  -d extension="$PWD/modules/gameshark.so" \
  --ri gameshark
```

From the repository root, these variables are convenient for examples:

```sh
export PHP="$PWD/php-src/.install/bin/php"
export GAMESHARK_EXT="$PWD/extension/modules/gameshark.so"
```

For a system PHP, use:

```sh
export PHP=php
export GAMESHARK_EXT="$PWD/extension/modules/gameshark.so"
```

### Package

Create a source package with vendored Rust crates:

```sh
cd extension
scripts/package-source.sh
```

Create an ABI-specific binary package for the PHP build that produced
`modules/gameshark.so`:

```sh
PHP_CONFIG=/path/to/php-config scripts/package-binary-unix.sh
```

Binary artifacts are tied to a PHP minor version, PHP API number, OS, CPU
architecture, debug mode, and NTS/ZTS setting. Prefer source builds unless the
target PHP ABI exactly matches the artifact manifest.

## How Activation Works

Loading the extension alone keeps it mostly inert:

```sh
"$PHP" -d extension="$GAMESHARK_EXT" -r 'var_dump(gameshark_loaded());'
```

Runtime collection is enabled by environment variables and INI settings. The
same SQLite file should usually be reused for all runs that belong to one
debugging session.

Useful helper functions:

- `gameshark_loaded(): bool`
- `gameshark_side(): ?string`
- `gameshark_db_path(): ?string`
- `gameshark_compare(string $format = "text"): string|array`
- `gameshark_trace_report(string $format = "text"): string|array`
- `gameshark_unused_report(string $format = "text", ?int $run_id = null): string|array`
- `gameshark_invariants_status(): array`

Report formats:

- `"text"`: human-readable output. This is the default.
- `"array"`: decoded PHP array.
- `"json"`: raw JSON without human-report truncation.

Color control for text reports:

```sh
GAMESHARK_COLOR=always  # force ANSI color
GAMESHARK_COLOR=never   # disable ANSI color
GAMESHARK_COLOR=auto    # default behavior; color only for interactive output
NO_COLOR=1              # disables color unless GAMESHARK_COLOR is set
```

## Differential Mode

Differential mode compares two PHP invocations stored in one SQLite database.
The sides are named `left` and `right` to avoid implying ordering.

Set:

- `GAMESHARK_DB=/path/to/run.sqlite`
- `GAMESHARK_SIDE=left` or `GAMESHARK_SIDE=right`

When both are set, `gameshark` counts user-defined PHP function and method
calls during that invocation. Re-running the same side replaces that side's
data in the database.

Example:

```sh
DB=/tmp/gameshark-diff.sqlite
rm -f "$DB" "$DB-shm" "$DB-wal"

GAMESHARK_DB="$DB" GAMESHARK_SIDE=left \
  "$PHP" -d extension="$GAMESHARK_EXT" left.php

GAMESHARK_DB="$DB" GAMESHARK_SIDE=right \
  "$PHP" -d extension="$GAMESHARK_EXT" right.php

GAMESHARK_DB="$DB" \
  "$PHP" -d extension="$GAMESHARK_EXT" \
  -r 'echo gameshark_compare();'
```

JSON output:

```sh
GAMESHARK_DB="$DB" \
  "$PHP" -d extension="$GAMESHARK_EXT" \
  -r 'echo gameshark_compare("json");'
```

WordPress-shaped example:

```sh
DB=/tmp/wp-render-vs-rest.sqlite

GAMESHARK_DB="$DB" GAMESHARK_SIDE=left \
  "$PHP" -d extension="$GAMESHARK_EXT" -S 127.0.0.1:8888 -t wordpress-develop/src

# In another shell, exercise the normal page render.
curl -s 'http://127.0.0.1:8888/?p=1' >/dev/null

# Stop the server, then run the right side and exercise REST.
GAMESHARK_DB="$DB" GAMESHARK_SIDE=right \
  "$PHP" -d extension="$GAMESHARK_EXT" -S 127.0.0.1:8888 -t wordpress-develop/src

curl -s 'http://127.0.0.1:8888/wp-json/wp/v2/posts/1?context=view' >/dev/null

GAMESHARK_DB="$DB" \
  "$PHP" -d extension="$GAMESHARK_EXT" \
  -r 'echo gameshark_compare();'
```

## Trace-Value Mode

Trace-value mode records every function or method call whose arguments contain
the watched value. It does not need `left` or `right`; those names are only for
differential mode.

Set:

- `GAMESHARK_DB=/path/to/trace.sqlite`
- `GAMESHARK_TRACE_VALUE=value`

Strings are matched by substring. Numeric trace values match numeric arguments
and also match string arguments containing PHP's basic string form of the
number. Arrays and object properties are traversed, with cycle and depth
limits.

Example:

```sh
DB=/tmp/gameshark-trace.sqlite
rm -f "$DB" "$DB-shm" "$DB-wal"

GAMESHARK_DB="$DB" GAMESHARK_TRACE_VALUE='needle' \
  "$PHP" -d extension="$GAMESHARK_EXT" -r '
    function inner($value) {}
    function outer($value) { inner(["wrapped" => "prefix " . $value]); }
    outer("needle");
  '

GAMESHARK_DB="$DB" \
  "$PHP" -d extension="$GAMESHARK_EXT" \
  -r 'echo gameshark_trace_report();'
```

Untruncated JSON output:

```sh
GAMESHARK_DB="$DB" \
  "$PHP" -d extension="$GAMESHARK_EXT" \
  -r 'echo gameshark_trace_report("json");'
```

The trace report includes:

- matched function or method name;
- argument path, such as `arg0`, `arg1["key"]`, or `arg0->property`;
- matched value;
- preview of the containing string when the value appears inside a larger one;
- stack frames with argument previews;
- a high-precision monotonic timestamp for each event.

## Trace Filtering

Tracing every call can be expensive and noisy. Use a native Rust regex allow
pattern to inspect only selected functions or methods.

Set either:

- `GAMESHARK_TRACE_ALLOW_PATTERN='regex'`
- `-d gameshark.trace_allow_pattern='regex'`

The pattern is matched against the canonical lower-case call name:

- `function_name`
- `class::method`

Closures are skipped when a filter is active. Invalid regexes fail closed:
the run records no trace events and emits a startup warning.

Example:

```sh
DB=/tmp/gameshark-filtered-trace.sqlite
rm -f "$DB" "$DB-shm" "$DB-wal"

GAMESHARK_DB="$DB" \
GAMESHARK_TRACE_VALUE='<b>needle</b>' \
GAMESHARK_TRACE_ALLOW_PATTERN='^(?:preg_match|wp_kses|wpdb::prepare)$' \
  "$PHP" -d extension="$GAMESHARK_EXT" app.php

GAMESHARK_DB="$DB" \
  "$PHP" -d extension="$GAMESHARK_EXT" \
  -r 'echo gameshark_trace_report();'
```

## Following Transformations

Trace-value mode can optionally follow plausible string transformations. If a
function receives a matched value and returns a string containing a recognized
transformation of that value, the transformed value is added to the trace set.

Set:

- `GAMESHARK_TRACE_FOLLOW_TRANSFORMS=1`

Currently recognized transformations include:

- slash escaping, such as `O'Reilly` to `O\\'Reilly`;
- SQL quote doubling, such as `O'Reilly` to `O''Reilly`;
- HTML escaping;
- URL encoding and raw URL encoding;
- JSON string escaping;
- regex quoting;
- SQL `LIKE` escaping;
- slash stripping.

Example:

```sh
DB=/tmp/gameshark-transform-trace.sqlite
rm -f "$DB" "$DB-shm" "$DB-wal"

GAMESHARK_DB="$DB" \
GAMESHARK_TRACE_VALUE="O'Reilly" \
GAMESHARK_TRACE_FOLLOW_TRANSFORMS=1 \
"$PHP" -d extension="$GAMESHARK_EXT" <<'PHP'
<?php
function escape_sql($value) {
    return "WHERE title = '" . str_replace("'", "''", $value) . "'";
}
function sink($value) {}

$sql = escape_sql("O'Reilly");
sink($sql);
PHP

GAMESHARK_DB="$DB" \
  "$PHP" -d extension="$GAMESHARK_EXT" \
  -r 'echo gameshark_trace_report("json");'
```

Filtering applies before argument inspection. If a function is filtered out,
its arguments are not inspected and transformations produced by that frame are
not followed.

## Invariant Mode

Invariant mode attaches PHP callbacks to specific functions or methods. Hooks
can log, assert, collect state, or throw exceptions to stop the running script.

Enable it with either environment variables:

```sh
GAMESHARK_INVARIANTS=1
GAMESHARK_INVARIANTS_FILE=/absolute/path/to/invariants.php
```

or INI settings:

```sh
-d gameshark.invariants=1
-d gameshark.invariants_file=/absolute/path/to/invariants.php
```

The invariant file must return a zero-indexed list of specs. Each spec has:

- `id`: unique string;
- `target`: function or method name, such as `get_post`, `preg_match`,
  `WP_Query::get_posts`, or `DateTime::format`;
- `when`: `"pre"` or `"post"`;
- `hook`: callable.

Function and method names are enough; do not use `function:` or `method:`
prefixes. A leading namespace slash is accepted. Matching is case-insensitive.

The invariant file is normal PHP. It can perform setup, define helper
functions, read constants, and use globals from the running request.

### Hook calling convention

For a function pre-condition, the hook receives the same arguments as the
target function:

```php
static function ($arg1, $arg2): void {}
```

For an instance method pre-condition, the hook receives `$this` first, followed
by the method arguments:

```php
static function (SomeClass $self, $arg1, $arg2): void {}
```

For a function or static-method post-condition, the hook receives:

```php
static function ($return, array $args): void {}
```

For an instance method post-condition, the hook receives:

```php
static function (SomeClass $self, $return, array $args): void {}
```

`$args` is a captured zero-indexed array of the original target arguments.

### Invariant example

`/tmp/gameshark-invariants.php`:

```php
<?php

function gs_log(string $message): void {
    fwrite(STDOUT, "\033[33m[gameshark]\033[0m " . $message . "\n");
}

return [
    [
        'id' => 'preg-match-html-snippet',
        'target' => 'preg_match',
        'when' => 'pre',
        'hook' => static function ($pattern, $subject, $matches = null): void {
            if (is_string($subject) && str_contains($subject, '<main')) {
                gs_log('preg_match received HTML subject: ' . substr($subject, 0, 120));
            }
        },
    ],
    [
        'id' => 'get-post-wp-error',
        'target' => 'get_post',
        'when' => 'post',
        'hook' => static function ($return, array $args): void {
            if (class_exists('WP_Error') && $return instanceof WP_Error) {
                $user = function_exists('wp_get_current_user') ? wp_get_current_user() : null;
                $name = $user && !empty($user->display_name)
                    ? $user->display_name
                    : ($user->user_login ?? 'anonymous');

                gs_log('get_post returned WP_Error for user=' . $name);
            }
        },
    ],
];
```

Run with invariant mode:

```sh
"$PHP" \
  -d extension="$GAMESHARK_EXT" \
  -d gameshark.invariants=1 \
  -d gameshark.invariants_file=/tmp/gameshark-invariants.php \
  app.php
```

Inspect invariant status from PHP:

```php
var_export(gameshark_invariants_status());
```

### Built-in functions and methods

Invariant mode can hook built-in PHP functions and methods, such as
`preg_match`, `str_replace`, `array_merge`, `DateTime::format`, and
`DateTime::createFromFormat`.

If built-in hooks are configured, `gameshark` prints a warning because wrapping
internal calls can affect performance and program behavior. Suppress only when
the warning is expected:

```sh
-d gameshark.invariants_warn_builtins=0
```

or:

```sh
GAMESHARK_INVARIANTS_WARN_BUILTINS=0
```

## Unused Runtime Coverage Mode

Unused mode records userland declarations created during a run and reports
which of those declarations had no matching runtime access observed. This is a
coverage signal for loaded code, not proof that code is dead.

Enable it with:

```sh
DB=/tmp/gameshark-unused.sqlite

GAMESHARK_DB="$DB" \
GAMESHARK_UNUSED=1 \
  "$PHP" -d extension="$GAMESHARK_EXT" script.php

GAMESHARK_DB="$DB" \
  "$PHP" -d extension="$GAMESHARK_EXT" \
  -r 'echo gameshark_unused_report();'
```

JSON output is available for automation:

```sh
GAMESHARK_DB="$DB" \
  "$PHP" -d extension="$GAMESHARK_EXT" \
  -r 'echo gameshark_unused_report("json");'
```

By default `gameshark_unused_report()` selects the latest completed unused run
in the database. Pass a run id as the second argument to inspect an earlier
run:

```sh
GAMESHARK_DB="$DB" \
  "$PHP" -d extension="$GAMESHARK_EXT" \
  -r 'echo gameshark_unused_report("json", 1);'
```

The report includes uncalled functions, uncalled concrete methods, classes
with no `new` opcode observed, global constants without a read observed, and
class constants without a successful read observed. Direct constant fetches and
`defined()` checks are tracked separately as pre-dispatch observations, but do
not count as successful reads. The human text report shows the first 50 rows in
each section; use JSON or array output for complete untruncated data.
Opcode-derived observations are best effort: dynamic class names, dynamic
constant names, optimizer-folded constants, and namespace fallback constants can
be under-reported or reported with caveats.

For web SAPIs, the request path is recorded without the query string by
default. To store the full request URI and query string, opt in explicitly:

```sh
GAMESHARK_UNUSED_CAPTURE_QUERY=1
```

## Combining Modes

Differential and trace-value mode can run together:

```sh
DB=/tmp/gameshark-combined.sqlite
rm -f "$DB" "$DB-shm" "$DB-wal"

GAMESHARK_DB="$DB" \
GAMESHARK_SIDE=left \
GAMESHARK_TRACE_VALUE='needle' \
  "$PHP" -d extension="$GAMESHARK_EXT" script.php

GAMESHARK_DB="$DB" \
  "$PHP" -d extension="$GAMESHARK_EXT" \
  -r 'echo gameshark_compare(); echo gameshark_trace_report();'
```

Invariant mode can also run during a traced invocation. Hook callbacks are
guarded against recursive instrumentation, so calls made by the hook itself do
not recursively trigger more invariant hooks.

## Configuration Reference

Environment variables:

| Name | Meaning |
| --- | --- |
| `GAMESHARK_DB` | SQLite database path for differential or trace collection. |
| `GAMESHARK_SIDE` | Differential side: `left` or `right`. |
| `GAMESHARK_TRACE_VALUE` | String or number to trace through function arguments. |
| `GAMESHARK_TRACE_ALLOW_PATTERN` | Rust regex allow-list for traced function or method names. |
| `GAMESHARK_TRACE_FOLLOW_TRANSFORMS` | Enables transformed-value tracing when truthy. |
| `GAMESHARK_COLOR` | `always`, `never`, or default auto color behavior. |
| `GAMESHARK_INVARIANTS` | Enables invariant mode when truthy. |
| `GAMESHARK_INVARIANTS_FILE` | Absolute path to the invariant PHP file. |
| `GAMESHARK_INVARIANTS_WARN_BUILTINS` | Set to `0` to suppress built-in hook warnings. |
| `GAMESHARK_UNUSED` | Enables unused runtime coverage mode when truthy. |
| `GAMESHARK_UNUSED_CAPTURE_QUERY` | Set to `1` to store full request URI and query string. |

INI settings:

| Name | Meaning |
| --- | --- |
| `gameshark.trace_allow_pattern` | Same as `GAMESHARK_TRACE_ALLOW_PATTERN`; takes precedence when non-empty. |
| `gameshark.invariants` | Enables invariant mode. |
| `gameshark.invariants_file` | Absolute path to the invariant PHP file. |
| `gameshark.invariants_warn_builtins` | Built-in hook warning control. |
| `gameshark.unused` | Enables unused runtime coverage mode. |
| `gameshark.unused_capture_query` | Stores full request URI and query string when truthy. |

## Development

Run the full extension test suite:

```sh
cd extension
PHP_CONFIG=../php-src/.install/bin/php-config scripts/build-unix.sh
```

Run a subset:

```sh
make test TESTS='tests/019-trace-allow-pattern.phpt'
```

Smoke-test an existing build:

```sh
cd extension
PHP_CONFIG=../php-src/.install/bin/php-config scripts/smoke-load.sh
```

The important source files are:

- `extension/gameshark.c`: PHP extension hooks and request-time logic.
- `extension/gameshark_core.h`: C/Rust FFI boundary.
- `extension/rust/src/lib.rs`: SQLite schema, collection storage, and reports.
- `extension/tests/*.phpt`: executable behavior examples.
