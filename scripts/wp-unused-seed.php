<?php

if ( $argc < 5 ) {
	fwrite( STDERR, "usage: php wp-unused-seed.php <wp-root> <run-dir> <base-url> <run-id>\n" );
	exit( 2 );
}

$wp_root  = rtrim( $argv[1], '/' );
$run_dir  = rtrim( $argv[2], '/' );
$base_url = rtrim( $argv[3], '/' );
$run_id   = $argv[4];

$_SERVER['HTTP_HOST']      = parse_url( $base_url, PHP_URL_HOST ) . ':' . parse_url( $base_url, PHP_URL_PORT );
$_SERVER['SERVER_NAME']    = parse_url( $base_url, PHP_URL_HOST );
$_SERVER['SERVER_PORT']    = (string) parse_url( $base_url, PHP_URL_PORT );
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['REQUEST_URI']    = '/';
$_SERVER['PHP_SELF']       = '/index.php';

define( 'WP_INSTALLING', true );
require_once $wp_root . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';

$admin_password      = 'admin-' . bin2hex( random_bytes( 6 ) );
$editor_password     = 'editor-' . bin2hex( random_bytes( 6 ) );
$author_password     = 'author-' . bin2hex( random_bytes( 6 ) );
$subscriber_password = 'subscriber-' . bin2hex( random_bytes( 6 ) );

if ( ! is_blog_installed() ) {
	wp_install(
		'Gameshark unused fuzz ' . $run_id,
		'admin',
		'admin@example.test',
		false,
		'',
		$admin_password,
		'en_US'
	);
} else {
	$user = get_user_by( 'login', 'admin' );
	if ( $user ) {
		wp_set_password( $admin_password, $user->ID );
	}
}

wp_set_current_user( 1 );

function gs_seed_user( string $login, string $email, string $role, string $password ): int {
	$user = get_user_by( 'login', $login );
	if ( $user ) {
		wp_set_password( $password, $user->ID );
		$user->set_role( $role );
		return (int) $user->ID;
	}

	return (int) wp_insert_user(
		array(
			'user_login'   => $login,
			'user_pass'    => $password,
			'user_email'   => $email,
			'display_name' => ucfirst( $login ) . ' User',
			'role'         => $role,
		)
	);
}

$users = array(
	'admin'      => 1,
	'editor'     => gs_seed_user( 'editor', 'editor@example.test', 'editor', $editor_password ),
	'author'     => gs_seed_user( 'author', 'author@example.test', 'author', $author_password ),
	'subscriber' => gs_seed_user( 'subscriber', 'subscriber@example.test', 'subscriber', $subscriber_password ),
);

$terms = array();
foreach ( array( 'News', 'Events', 'Reviews' ) as $name ) {
	$term = term_exists( $name, 'category' );
	if ( ! $term ) {
		$term = wp_insert_term( $name, 'category' );
	}
	$terms[ strtolower( $name ) ] = (int) $term['term_id'];
}
$local = term_exists( 'Local', 'category' );
if ( ! $local ) {
	$local = wp_insert_term( 'Local', 'category', array( 'parent' => $terms['events'] ) );
}
$terms['local'] = (int) $local['term_id'];

foreach ( array( 'alpha', 'html-test', 'mysql-test', 'unicode-test' ) as $tag ) {
	if ( ! term_exists( $tag, 'post_tag' ) ) {
		wp_insert_term( $tag, 'post_tag' );
	}
}

function gs_post( array $args ): int {
	$existing = get_page_by_title( $args['post_title'], OBJECT, $args['post_type'] ?? 'post' );
	if ( $existing ) {
		$args['ID'] = $existing->ID;
		return (int) wp_update_post( $args, true );
	}

	return (int) wp_insert_post( $args, true );
}

$block_content = <<<HTML
<!-- wp:paragraph -->
<p>Block-heavy seeded content for runtime coverage.</p>
<!-- /wp:paragraph -->
<!-- wp:heading -->
<h2>HTML and SQL-ish text</h2>
<!-- /wp:heading -->
<!-- wp:html -->
<div data-test="&lt;script&gt;">quoted 'value' and "double"</div>
<!-- /wp:html -->
<!-- wp:list -->
<ul><li>alpha</li><li>beta</li></ul>
<!-- /wp:list -->
HTML;

$posts = array();
$posts['hello'] = gs_post(
	array(
		'post_title'    => "$run_id hello world",
		'post_name'     => "$run_id-hello-world",
		'post_content'  => 'Hello world for Gameshark unused mode.',
		'post_status'   => 'publish',
		'post_author'   => $users['admin'],
		'post_category' => array( $terms['news'] ),
		'tags_input'    => array( 'alpha', 'html-test' ),
		'comment_status'=> 'open',
	)
);
$posts['block_heavy'] = gs_post(
	array(
		'post_title'    => "$run_id block heavy",
		'post_name'     => "$run_id-block-heavy",
		'post_content'  => $block_content,
		'post_status'   => 'publish',
		'post_author'   => $users['editor'],
		'post_category' => array( $terms['events'] ),
		'comment_status'=> 'open',
	)
);
$posts['comment_rich'] = gs_post(
	array(
		'post_title'    => "$run_id comments",
		'post_name'     => "$run_id-comments",
		'post_content'  => 'Comment-rich post.',
		'post_status'   => 'publish',
		'post_author'   => $users['author'],
		'comment_status'=> 'open',
	)
);
$posts['draft'] = gs_post(
	array(
		'post_title'   => "$run_id draft",
		'post_content' => 'Draft content.',
		'post_status'  => 'draft',
		'post_author'  => $users['author'],
	)
);
$posts['scheduled'] = gs_post(
	array(
		'post_title'   => "$run_id scheduled",
		'post_content' => 'Scheduled content.',
		'post_status'  => 'future',
		'post_date'    => gmdate( 'Y-m-d H:i:s', time() + 600 ),
		'post_author'  => $users['admin'],
	)
);
$posts['private'] = gs_post(
	array(
		'post_title'   => "$run_id private",
		'post_content' => 'Private content.',
		'post_status'  => 'private',
		'post_author'  => $users['admin'],
	)
);
$posts['password'] = gs_post(
	array(
		'post_title'    => "$run_id password",
		'post_content'  => 'Password-protected content.',
		'post_status'   => 'publish',
		'post_password' => 'secret',
		'post_author'   => $users['admin'],
	)
);
stick_post( $posts['hello'] );

$pages = array();
$pages['parent'] = gs_post(
	array(
		'post_type'    => 'page',
		'post_title'   => "$run_id parent page",
		'post_name'    => "$run_id-parent",
		'post_content' => 'Parent page.',
		'post_status'  => 'publish',
		'post_author'  => $users['admin'],
	)
);
$pages['child'] = gs_post(
	array(
		'post_type'    => 'page',
		'post_title'   => "$run_id child page",
		'post_name'    => "$run_id-child",
		'post_parent'  => $pages['parent'],
		'post_content' => 'Child page.',
		'post_status'  => 'publish',
		'post_author'  => $users['admin'],
	)
);
$pages['html'] = gs_post(
	array(
		'post_type'    => 'page',
		'post_title'   => "$run_id html page",
		'post_name'    => "$run_id-html",
		'post_content' => '<p>HTML-ish <strong>page</strong> with [shortcode_like] text.</p>',
		'post_status'  => 'publish',
		'post_author'  => $users['editor'],
	)
);

foreach (
	array(
		array( 'Approved Author', 'approved@example.test', 'Approved comment with <b>HTML</b> and SQL-ish quote \'.', '1' ),
		array( 'Pending Author', 'pending@example.test', 'Pending comment.', '0' ),
		array( 'Spam Author', 'spam@example.test', 'Spam-looking comment buy now.', 'spam' ),
	) as $comment
) {
	wp_insert_comment(
		array(
			'comment_post_ID'      => $posts['comment_rich'],
			'comment_author'       => $comment[0],
			'comment_author_email' => $comment[1],
			'comment_content'      => $comment[2],
			'comment_approved'     => $comment[3],
		)
	);
}

require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/media.php';

$fixture_dir = $run_dir . '/fixtures';
if ( ! is_dir( $fixture_dir ) ) {
	mkdir( $fixture_dir, 0777, true );
}

function gs_make_image( string $file, int $width, int $height, array $rgb ): void {
	$image = imagecreatetruecolor( $width, $height );
	$color = imagecolorallocate( $image, $rgb[0], $rgb[1], $rgb[2] );
	imagefilledrectangle( $image, 0, 0, $width, $height, $color );
	if ( str_ends_with( $file, '.png' ) ) {
		imagepng( $image, $file );
	} else {
		imagejpeg( $image, $file, 85 );
	}
	imagedestroy( $image );
}

gs_make_image( "$fixture_dir/tiny-$run_id.jpg", 4, 4, array( 120, 20, 20 ) );
gs_make_image( "$fixture_dir/large-$run_id.jpg", 1600, 900, array( 20, 100, 180 ) );
gs_make_image( "$fixture_dir/transparent-$run_id.png", 32, 32, array( 20, 180, 90 ) );
file_put_contents( "$fixture_dir/document-$run_id.txt", "plain text fixture for $run_id\n" );
file_put_contents( "$fixture_dir/document-$run_id.pdf", "%PDF-1.1\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n" );
file_put_contents( "$fixture_dir/invalid-$run_id.jpg", "not really an image\n" );

$media = array();
foreach ( glob( "$fixture_dir/*" ) as $file ) {
	$tmp = wp_tempnam( basename( $file ) );
	copy( $file, $tmp );
	$attachment_id = media_handle_sideload(
		array(
			'name'     => basename( $file ),
			'tmp_name' => $tmp,
		),
		0,
		"Fixture " . basename( $file )
	);
	if ( ! is_wp_error( $attachment_id ) ) {
		$media[ basename( $file ) ] = (int) $attachment_id;
	}
}

if ( ! empty( $media ) ) {
	set_post_thumbnail( $posts['hello'], reset( $media ) );
}

update_option( 'permalink_structure', '/%postname%/' );
update_option( 'blog_public', '0' );
update_option( 'default_comment_status', 'open' );
update_option( 'comment_moderation', '1' );
update_option( 'posts_per_page', '3' );
update_option( 'users_can_register', '1' );
update_option( 'default_role', 'subscriber' );
flush_rewrite_rules( true );

$app_password = null;
if ( class_exists( 'WP_Application_Passwords' ) ) {
	$created = WP_Application_Passwords::create_new_application_password(
		$users['admin'],
		array( 'name' => 'gameshark-' . $run_id )
	);
	if ( ! is_wp_error( $created ) ) {
		$app_password = $created[0];
	}
}

$ids = array(
	'run_id'   => $run_id,
	'base_url' => $base_url,
	'users'    => $users,
	'terms'    => $terms,
	'posts'    => $posts,
	'pages'    => $pages,
	'media'    => $media,
);

$credentials = array(
	'admin'      => array( 'username' => 'admin', 'password' => $admin_password ),
	'editor'     => array( 'username' => 'editor', 'password' => $editor_password ),
	'author'     => array( 'username' => 'author', 'password' => $author_password ),
	'subscriber' => array( 'username' => 'subscriber', 'password' => $subscriber_password ),
	'app_password' => $app_password,
);

file_put_contents( $run_dir . '/ids.json', json_encode( $ids, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) );
file_put_contents( $run_dir . '/manifest.private.json', json_encode( array( 'credentials' => $credentials ), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) );
chmod( $run_dir . '/manifest.private.json', 0600 );

echo "seeded $run_id\n";
