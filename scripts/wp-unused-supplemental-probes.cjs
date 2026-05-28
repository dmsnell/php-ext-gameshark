#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const runDir = process.env.RUN_DIR;
const base = process.env.BASE_URL;
const durationSeconds = Number(process.env.SUPPLEMENTAL_SECONDS || process.env.DURATION_SECONDS || 300);
const worker = process.env.WORKER_NAME || 'supplemental-probes';

if (!runDir || !base) {
  console.error('RUN_DIR and BASE_URL are required');
  process.exit(2);
}

const logsDir = path.join(runDir, 'logs');
const workersDir = path.join(logsDir, 'workers');
const responseDir = path.join(logsDir, 'api-responses');
for (const dir of [logsDir, workersDir, responseDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const ids = JSON.parse(fs.readFileSync(path.join(runDir, 'ids.json'), 'utf8'));
const privateManifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.private.json'), 'utf8'));
const credentials = privateManifest.credentials || {};
const deadline = Date.now() + durationSeconds * 1000;

function now() {
  return new Date().toISOString();
}

function safeUrl(urlPath) {
  return new URL(urlPath, base).href;
}

function appendJsonl(file, row) {
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

function log(event) {
  const row = { ts: now(), worker, ...event };
  appendJsonl(path.join(workersDir, `${worker}.jsonl`), row);
  appendJsonl(path.join(logsDir, 'events.jsonl'), row);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeader() {
  const appPass = credentials.app_password;
  const admin = credentials.admin;
  if (!appPass || !admin) return {};
  return {
    Authorization: `Basic ${Buffer.from(`${admin.username}:${appPass}`).toString('base64')}`,
  };
}

function bodyFile(method, url) {
  const parsed = new URL(url);
  const name = `${Date.now()}-${worker}-${method}-${parsed.pathname}`.replace(/[^A-Za-z0-9_.-]/g, '-');
  return path.join(responseDir, `${name}.body`);
}

async function request(method, urlPath, options = {}) {
  const url = safeUrl(urlPath);
  const headers = {
    ...(options.auth ? authHeader() : {}),
    ...(options.body ? { 'content-type': options.contentType || 'application/json' } : {}),
    ...(options.headers || {}),
  };
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeout || 12000),
    });
    const buf = Buffer.from(await response.arrayBuffer());
    const file = bodyFile(method, url);
    fs.writeFileSync(file, buf.subarray(0, 256 * 1024));
    log({
      action: 'request',
      method,
      url,
      status: response.status,
      bytes: buf.length,
      elapsed_ms: Date.now() - start,
      body_file: file,
      auth: Boolean(options.auth),
      outcome: response.status >= 500 ? 'server_error' : 'success',
    });
    return { status: response.status, body: buf.toString('utf8') };
  } catch (error) {
    log({
      action: 'request',
      method,
      url,
      elapsed_ms: Date.now() - start,
      outcome: 'timeout',
      error: String(error.message || error),
      auth: Boolean(options.auth),
    });
    return null;
  }
}

function json(data) {
  return JSON.stringify(data);
}

function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[c]));
}

function xmlString(value) {
  return `<param><value><string>${xmlEscape(value)}</string></value></param>`;
}

function xmlInt(value) {
  return `<param><value><int>${Number(value)}</int></value></param>`;
}

function xmlArray(items) {
  return `<param><value><array><data>${items.map((item) => `<value><string>${xmlEscape(item)}</string></value>`).join('')}</data></array></value></param>`;
}

function xmlStruct(record) {
  return `<param><value><struct>${Object.entries(record).map(([key, value]) => `<member><name>${xmlEscape(key)}</name><value><string>${xmlEscape(value)}</string></value></member>`).join('')}</struct></value></param>`;
}

function xmlPayload(method, params) {
  return `<?xml version="1.0"?><methodCall><methodName>${xmlEscape(method)}</methodName><params>${params}</params></methodCall>`;
}

async function xmlrpc(method, params) {
  return request('POST', '/xmlrpc.php', {
    headers: { 'content-type': 'text/xml' },
    body: xmlPayload(method, params),
    timeout: 15000,
  });
}

async function main() {
  const postId = ids.posts.hello;
  const pageId = ids.pages.parent;
  const mediaId = Object.values(ids.media || {})[0];
  const termId = ids.terms.news;
  const admin = credentials.admin || { username: 'admin', password: '' };
  const blog = xmlInt(1);
  const userPass = xmlString(admin.username) + xmlString(admin.password);
  const endpoints = [
    '/',
    '/?s=alpha+beta',
    '/?s=%3Cscript%3E%22quote%27%20UNION%20SELECT',
    `/?p=${postId}&preview=true`,
    `/?page_id=${pageId}`,
    `/?attachment_id=${mediaId}`,
    '/feed/',
    '/comments/feed/',
    '/wp-sitemap.xml',
    '/wp-sitemap-posts-post-1.xml',
    '/wp-sitemap-posts-page-1.xml',
    '/wp-sitemap-taxonomies-category-1.xml',
    '/wp-sitemap-users-1.xml',
    `/wp-json/oembed/1.0/embed?url=${encodeURIComponent(`${base}/?p=${postId}`)}&format=json`,
    '/wp-json/wp/v2/types?context=edit',
    '/wp-json/wp/v2/statuses?context=edit',
    '/wp-json/wp/v2/taxonomies?context=edit',
    '/wp-json/wp/v2/categories?context=edit&per_page=20',
    '/wp-json/wp/v2/tags?context=edit&per_page=20',
    `/wp-json/wp/v2/categories/${termId}?context=edit`,
    `/wp-json/wp/v2/posts/${postId}/revisions?context=edit`,
    `/wp-json/wp/v2/posts/${postId}/autosaves?context=edit`,
    `/wp-json/wp/v2/pages/${pageId}?context=edit`,
    `/wp-json/wp/v2/media/${mediaId}?context=edit`,
    '/wp-json/wp/v2/users/me?context=edit',
    '/wp-json/wp/v2/users?context=edit&per_page=20',
    '/wp-json/wp/v2/settings',
    '/wp-json/wp/v2/block-directory/search?term=image',
    '/wp-json/wp/v2/pattern-directory/patterns?keyword=gallery',
    '/wp-json/wp/v2/templates?context=edit',
    '/wp-json/wp/v2/template-parts?context=edit',
    '/wp-json/wp/v2/navigation?context=edit',
    '/wp-json/wp/v2/menu-locations',
    '/wp-json/wp/v2/global-styles/themes/twentytwentysix?context=edit',
  ];

  let i = 0;
  while (Date.now() < deadline) {
    const endpoint = endpoints[i % endpoints.length];
    const auth = endpoint.includes('context=edit') || endpoint.includes('/settings') || endpoint.includes('/users');
    await request('GET', endpoint, { auth });
    if (i % 11 === 0) await request('OPTIONS', endpoint.split('?')[0], { auth });
    if (i % 17 === 0) {
      await request('POST', `/wp-json/wp/v2/comments`, {
        auth: false,
        body: json({
          post: postId,
          author_name: `Supplemental ${i}`,
          author_email: `supplemental-${i}@example.test`,
          content: `supplemental comment ${i} <b>html</b> 'sql'`,
        }),
      });
    }
    if (i % 23 === 0) {
      await request('POST', `/wp-json/wp/v2/posts/${postId}`, {
        auth: true,
        body: json({ meta: {}, comment_status: i % 46 === 0 ? 'open' : 'closed' }),
      });
    }
    if (i % 29 === 0) {
      const methods = [
        ['wp.getPost', blog + userPass + xmlInt(postId)],
        ['wp.getPage', blog + userPass + xmlInt(pageId)],
        ['wp.getPostTypes', blog + userPass],
        ['wp.getPostStatusList', blog + userPass],
        ['wp.getCommentStatusList', blog + userPass],
        ['wp.getCategories', blog + userPass],
        ['wp.getTags', blog + userPass],
        ['wp.getTerms', blog + userPass + xmlString('category')],
        ['wp.getComments', blog + userPass + xmlStruct({ post_id: postId, number: 5 })],
        ['wp.getMediaLibrary', blog + userPass + xmlStruct({ number: 5 })],
        ['metaWeblog.getRecentPosts', blog + userPass + xmlInt(5)],
        ['blogger.getUserInfo', xmlString('') + userPass],
        ['pingback.extensions.getPingbacks', xmlString(`${base}/?p=${postId}`)],
        ['system.multicall', xmlArray(['system.listMethods', 'demo.sayHello'])],
      ];
      const [method, params] = methods[Math.floor(i / 29) % methods.length];
      await xmlrpc(method, params);
    }
    i += 1;
    await sleep(1500);
  }
  log({ action: 'complete', requests_attempted: i });
}

main().catch((error) => {
  console.error(error);
  log({ action: 'fatal', outcome: 'fatal', error: String(error.stack || error) });
  process.exit(1);
});
