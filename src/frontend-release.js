import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Content-based, so copying files into a running server also publishes a release.
const files = ['dashboard.html', 'dashboard.css', 'dashboard.js', 'live-updates.js',
  'attention.js', 'day-model.js', 'dashboard-examples.js', 'hermy-sheet-v4.png'];

export async function readFrontendRelease(publicDir) {
  const contents = await Promise.all(files.map(file => readFile(path.join(publicDir, file))));
  const hash = createHash('sha256');
  contents.forEach((content, index) => hash.update(files[index]).update('\0').update(content));
  const version = hash.digest('hex');
  const html = contents[0].toString().replace('</head>',
    `<meta name="mirror-release" content="${version}"></head>`);
  return { version, html };
}

export function mountLiveDashboard(app, publicDir) {
  app.get('/', (_req, res) => res.set('Cache-Control', 'no-store').redirect(302, '/dashboard?view=mirror'));
  app.get('/api/frontend-version', async (_req, res, next) => {
    try {
      const { version } = await readFrontendRelease(publicDir);
      res.set('Cache-Control', 'no-store').json({ version });
    } catch (error) { next(error); }
  });
  app.get(['/dashboard', '/dashboard.html'], async (_req, res, next) => {
    try {
      const { html } = await readFrontendRelease(publicDir);
      res.set('Cache-Control', 'no-store').type('html').send(html);
    } catch (error) { next(error); }
  });
}
