<?php

if ( $argc < 3 ) {
	fwrite( STDERR, "usage: php wp-unused-aggregate-report.php <db> <text|json>\n" );
	exit( 2 );
}

ini_set( 'memory_limit', '-1' );

$db_path = $argv[1];
$format  = $argv[2];

$pdo = new PDO( 'sqlite:' . $db_path );
$pdo->setAttribute( PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION );

function use_color(): bool {
	$mode = getenv( 'GAMESHARK_COLOR' );
	if ( 'always' === $mode ) {
		return true;
	}
	if ( 'never' === $mode ) {
		return false;
	}
	if ( false !== getenv( 'NO_COLOR' ) ) {
		return false;
	}
	return function_exists( 'posix_isatty' ) && posix_isatty( STDOUT );
}

function ansi( bool $color, string $code, string $text ): string {
	if ( ! $color || '' === $text ) {
		return $text;
	}
	return "\033[" . $code . 'm' . $text . "\033[0m";
}

function rows( PDO $pdo, string $sql ): array {
	return $pdo->query( $sql )->fetchAll( PDO::FETCH_ASSOC );
}

$runs = rows( $pdo, "SELECT * FROM unused_runs WHERE status = 'complete' ORDER BY run_id" );
$run_count = count( $runs );

$completed = "SELECT run_id FROM unused_runs WHERE status = 'complete'";

$declarations = array();
foreach ( rows(
	$pdo,
	"
	SELECT d.*
	FROM unused_declarations d
	JOIN (
		SELECT identity_hash, MIN(run_id) AS run_id
		FROM unused_declarations
		WHERE run_id IN ($completed)
		GROUP BY identity_hash
	) first_seen ON first_seen.identity_hash = d.identity_hash AND first_seen.run_id = d.run_id
	"
) as $row ) {
	$key = $row['identity_hash'];
	if ( ! isset( $declarations[ $key ] ) ) {
		$declarations[ $key ] = $row;
	}
}

$access_counts = array();
$active_files = array();
foreach ( rows(
	$pdo,
	"
	SELECT identity_hash, access_kind, MAX(file) AS file, SUM(access_count) AS access_count
	FROM unused_accesses
	WHERE run_id IN ($completed)
	GROUP BY identity_hash, access_kind
	"
) as $row ) {
	$key = $row['identity_hash'] . "\0" . $row['access_kind'];
	$access_counts[ $key ] = ( $access_counts[ $key ] ?? 0 ) + (int) $row['access_count'];
	if ( ! empty( $row['file'] ) ) {
		$active_files[ $row['file'] ] = true;
	}
	if ( isset( $declarations[ $row['identity_hash'] ] ) && ! empty( $declarations[ $row['identity_hash'] ]['file'] ) ) {
		$active_files[ $declarations[ $row['identity_hash'] ]['file'] ] = true;
	}
}

function access_count( array $access_counts, string $hash, string $kind ): int {
	return $access_counts[ $hash . "\0" . $kind ] ?? 0;
}

function constant_value_access_count( array $access_counts, array $row ): int {
	if ( 'global_constant' === $row['kind'] ) {
		return access_count( $access_counts, $row['identity_hash'], 'global_constant_fetch_observed' )
			+ access_count( $access_counts, $row['identity_hash'], 'global_constant_read' );
	}
	if ( 'class_constant' === $row['kind'] ) {
		return access_count( $access_counts, $row['identity_hash'], 'class_constant_fetch_observed' )
			+ access_count( $access_counts, $row['identity_hash'], 'class_constant_read' );
	}
	return 0;
}

function report_row( array $row, array $access_counts, array $active_files ): array {
	$hash = $row['identity_hash'];
	return array(
		'kind'                   => $row['kind'],
		'display_name'           => $row['display_name'],
		'scope_name'             => $row['scope_name'],
		'name'                   => $row['name'],
		'file'                   => $row['file'],
		'start_line'             => (int) $row['start_line'],
		'end_line'               => (int) $row['end_line'],
		'flags'                  => (int) $row['flags'],
		'call_count'             => access_count( $access_counts, $hash, 'function_call' ) + access_count( $access_counts, $hash, 'method_call' ),
		'new_observed_count'     => access_count( $access_counts, $hash, 'new_opcode_observed' ),
		'fetch_observed_count'   => access_count( $access_counts, $hash, 'global_constant_fetch_observed' ) + access_count( $access_counts, $hash, 'class_constant_fetch_observed' ),
		'read_observed_count'    => access_count( $access_counts, $hash, 'global_constant_read' ) + access_count( $access_counts, $hash, 'class_constant_read' ),
		'defined_probe_count'    => access_count( $access_counts, $hash, 'global_constant_probe' ) + access_count( $access_counts, $hash, 'class_constant_probe' ),
		'file_had_any_access'    => $row['file'] ? isset( $active_files[ $row['file'] ] ) : null,
	);
}

$classes_by_name = array();
foreach ( $declarations as $row ) {
	if ( 'class' === $row['kind'] ) {
		$classes_by_name[ $row['name'] ] = (int) $row['flags'];
	}
}

$abstract_flag = 1 << 6;
$uninstantiable_flags = ( 1 << 0 ) | ( 1 << 1 ) | ( 1 << 4 ) | ( 1 << 6 ) | ( 1 << 28 );

$report = array(
	'summary' => array(
		'run_count' => $run_count,
	),
	'runs' => $runs,
	'uncalled_functions' => array(),
	'uncalled_concrete_methods' => array(),
	'classes_with_no_new_opcode_observed' => array(),
	'global_constants_without_value_access_observed' => array(),
	'class_constants_without_value_access_observed' => array(),
	'included_files_with_no_accessed_declarations' => array(),
	'included_files_without_declarations' => array(),
);

foreach ( $declarations as $row ) {
	$hash = $row['identity_hash'];
	switch ( $row['kind'] ) {
		case 'function':
			if ( 0 === access_count( $access_counts, $hash, 'function_call' ) ) {
				$report['uncalled_functions'][] = report_row( $row, $access_counts, $active_files );
			}
			break;
		case 'method':
			$owning_flags = isset( $classes_by_name[ $row['scope_name'] ] ) ? $classes_by_name[ $row['scope_name'] ] : 0;
			if (
				0 === access_count( $access_counts, $hash, 'method_call' )
				&& 0 === ( (int) $row['flags'] & $abstract_flag )
				&& 0 === ( $owning_flags & $uninstantiable_flags )
			) {
				$report['uncalled_concrete_methods'][] = report_row( $row, $access_counts, $active_files );
			}
			break;
		case 'class':
			if ( 0 === access_count( $access_counts, $hash, 'new_opcode_observed' ) && 0 === ( (int) $row['flags'] & $uninstantiable_flags ) ) {
				$report['classes_with_no_new_opcode_observed'][] = report_row( $row, $access_counts, $active_files );
			}
			break;
		case 'global_constant':
			if ( 0 === constant_value_access_count( $access_counts, $row ) ) {
				$report['global_constants_without_value_access_observed'][] = report_row( $row, $access_counts, $active_files );
			}
			break;
		case 'class_constant':
			if ( 0 === constant_value_access_count( $access_counts, $row ) ) {
				$report['class_constants_without_value_access_observed'][] = report_row( $row, $access_counts, $active_files );
			}
			break;
	}
}

foreach ( array_keys( $report ) as $key ) {
	if ( is_array( $report[ $key ] ) && isset( $report[ $key ][0]['display_name'] ) ) {
		usort( $report[ $key ], fn( $a, $b ) => strcmp( $a['display_name'], $b['display_name'] ) ?: strcmp( (string) $a['file'], (string) $b['file'] ) );
	}
}

$included = array();
foreach ( rows( $pdo, "SELECT file, SUM(include_count) AS include_count FROM unused_included_files WHERE run_id IN (SELECT run_id FROM unused_runs WHERE status = 'complete') GROUP BY file ORDER BY file" ) as $row ) {
	$included[ $row['file'] ] = array(
		'file' => $row['file'],
		'include_count' => (int) $row['include_count'],
		'declaration_count' => 0,
		'accessed_declaration_count' => 0,
		'function_declaration_count' => 0,
		'method_declaration_count' => 0,
		'class_declaration_count' => 0,
		'global_constant_declaration_count' => 0,
		'class_constant_declaration_count' => 0,
	);
}

foreach ( $declarations as $row ) {
	if ( empty( $row['file'] ) || ! isset( $included[ $row['file'] ] ) ) {
		continue;
	}
	$file =& $included[ $row['file'] ];
	++$file['declaration_count'];
	$counter_key = $row['kind'] . '_declaration_count';
	if ( isset( $file[ $counter_key ] ) ) {
		++$file[ $counter_key ];
	}
	$hash = $row['identity_hash'];
	$accessed = false;
	if ( 'function' === $row['kind'] ) {
		$accessed = access_count( $access_counts, $hash, 'function_call' ) > 0;
	} elseif ( 'method' === $row['kind'] ) {
		$accessed = access_count( $access_counts, $hash, 'method_call' ) > 0;
	} elseif ( 'class' === $row['kind'] ) {
		$accessed = access_count( $access_counts, $hash, 'new_opcode_observed' ) > 0;
	} elseif ( 'global_constant' === $row['kind'] || 'class_constant' === $row['kind'] ) {
		$accessed = constant_value_access_count( $access_counts, $row ) > 0;
	}
	if ( $accessed ) {
		++$file['accessed_declaration_count'];
	}
	unset( $file );
}

foreach ( $included as $file ) {
	if ( 0 === $file['declaration_count'] ) {
		$report['included_files_without_declarations'][] = $file;
	} elseif ( 0 === $file['accessed_declaration_count'] ) {
		$report['included_files_with_no_accessed_declarations'][] = $file;
	}
}

$report['summary'] += array(
	'declaration_count' => count( $declarations ),
	'access_identity_count' => count( $access_counts ),
	'included_file_count' => count( $included ),
	'uncalled_function_count' => count( $report['uncalled_functions'] ),
	'uncalled_concrete_method_count' => count( $report['uncalled_concrete_methods'] ),
	'class_without_new_count' => count( $report['classes_with_no_new_opcode_observed'] ),
	'global_constant_without_value_access_count' => count( $report['global_constants_without_value_access_observed'] ),
	'class_constant_without_value_access_count' => count( $report['class_constants_without_value_access_observed'] ),
	'included_file_with_no_accessed_declaration_count' => count( $report['included_files_with_no_accessed_declarations'] ),
	'included_file_without_declaration_count' => count( $report['included_files_without_declarations'] ),
);

if ( 'json' === $format ) {
	echo json_encode( $report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ), "\n";
	exit;
}

$color = use_color();

echo ansi( $color, '1', 'Gameshark aggregate unused coverage report' ) . "\n";
echo ansi( $color, '2', 'completed request runs:' ) . ' ' . ansi( $color, '33', (string) $report['summary']['run_count'] ) . "\n";
echo ansi( $color, '2', 'declarations:' ) . ' ' . ansi( $color, '33', (string) $report['summary']['declaration_count'] )
	. ' | ' . ansi( $color, '2', 'access identities:' ) . ' ' . ansi( $color, '33', (string) $report['summary']['access_identity_count'] )
	. ' | ' . ansi( $color, '2', 'included files:' ) . ' ' . ansi( $color, '33', (string) $report['summary']['included_file_count'] ) . "\n";
echo ansi( $color, '2', 'uncalled functions:' ) . ' ' . ansi( $color, '31', (string) $report['summary']['uncalled_function_count'] )
	. ' | ' . ansi( $color, '2', 'uncalled methods:' ) . ' ' . ansi( $color, '31', (string) $report['summary']['uncalled_concrete_method_count'] )
	. ' | ' . ansi( $color, '2', 'classes without new:' ) . ' ' . ansi( $color, '31', (string) $report['summary']['class_without_new_count'] ) . "\n";
echo ansi( $color, '2', 'constants without value access:' ) . ' '
	. ansi( $color, '31', (string) $report['summary']['global_constant_without_value_access_count'] )
	. '/' . ansi( $color, '31', (string) $report['summary']['class_constant_without_value_access_count'] )
	. ' | ' . ansi( $color, '2', 'included-file buckets:' ) . ' '
	. ansi( $color, '31', (string) $report['summary']['included_file_with_no_accessed_declaration_count'] )
	. '/' . ansi( $color, '31', (string) $report['summary']['included_file_without_declaration_count'] ) . "\n";
echo ansi( $color, '33', 'Caveat:' ) . " this is an aggregate coverage profile across HTTP request runs, not proof of dead code.\n\n";

foreach (
	array(
		'uncalled_functions' => 'Uncalled functions',
		'uncalled_concrete_methods' => 'Uncalled concrete methods',
		'classes_with_no_new_opcode_observed' => 'Classes with no new observed',
		'global_constants_without_value_access_observed' => 'Global constants without value access',
		'class_constants_without_value_access_observed' => 'Class constants without value access',
		'included_files_with_no_accessed_declarations' => 'Included files with no accessed declarations',
		'included_files_without_declarations' => 'Included files without declarations',
	) as $key => $title
) {
	echo ansi( $color, '36', "$title (" . count( $report[ $key ] ) . ')' ) . "\n";
	foreach ( $report[ $key ] as $row ) {
		if ( isset( $row['display_name'] ) ) {
			$file = $row['file'] ? ansi( $color, '35', $row['file'] ) : ansi( $color, '2', '<unknown file>' );
			$line = $row['start_line'] ? ansi( $color, '33', (string) $row['start_line'] ) : ansi( $color, '2', '?' );
			$activity = null === $row['file_had_any_access']
				? ansi( $color, '2', 'file-unknown' )
				: ( $row['file_had_any_access'] ? ansi( $color, '32', 'file-active' ) : ansi( $color, '2', 'file-inactive' ) );
			echo '  ' . ansi( $color, '1', $row['display_name'] ) . " {$file}:{$line} {$activity}\n";
		} else {
			echo '  ' . ansi( $color, '35', $row['file'] )
				. ' declarations=' . ansi( $color, '33', (string) $row['declaration_count'] )
				. ' accessed=' . ansi( $color, '33', (string) $row['accessed_declaration_count'] )
				. ' includes=' . ansi( $color, '33', (string) $row['include_count'] ) . "\n";
		}
	}
	echo "\n";
}
