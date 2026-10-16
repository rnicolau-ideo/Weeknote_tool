const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

app.use(cors({
  origin: ['https://projectweeklynotes.com', 'https://www.projectweeklynotes.com', 'https://rnicolau-ideo.github.io', 'http://localhost:3000', 'http://localhost:8080'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// Serve the static builder
app.use(express.static('.'));

// ── Firebase Admin init ───────────────────────────────────────────────────
let bucket;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: `${serviceAccount.project_id}.appspot.com`
  });
  bucket = admin.storage().bucket();
  console.log(`Firebase Admin initialised for project: ${serviceAccount.project_id}`);
} catch (err) {
  console.error('Firebase Admin init failed:', err.message);
}

// ── Auth middleware ───────────────────────────────────────────────────────
async function requireIdeoAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing auth token' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (!decoded.email?.endsWith('@ideo.com')) {
      return res.status(403).json({ error: 'Forbidden: Must be an @ideo.com email address' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

// ── Publish note to Firebase Storage ─────────────────────────────────────
app.post('/api/publish-note', requireIdeoAuth, async (req, res) => {
  if (!bucket) return res.status(500).json({ error: 'Firebase Storage not initialised' });

  const { projectId, noteSlug, htmlContent } = req.body;
  if (!projectId || !noteSlug || !htmlContent) {
    return res.status(400).json({ error: 'projectId, noteSlug and htmlContent are required' });
  }

  const filePath = `notes/${projectId}/${noteSlug}.html`;
  try {
    const file = bucket.file(filePath);
    await file.save(htmlContent, {
      contentType: 'text/html',
      metadata: { cacheControl: 'private, max-age=0' }
    });
    res.json({
      success: true,
      url: `https://projectweeklynotes.com/view?project=${projectId}&note=${noteSlug}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to publish note: ' + err.message });
  }
});

// ── Fetch note from Firebase Storage ─────────────────────────────────────
app.get('/api/get-note', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    await admin.auth().verifyIdToken(token);
  } catch (err) {
    return res.status(403).json({ error: 'Forbidden: Invalid session' });
  }

  if (!bucket) return res.status(500).json({ error: 'Firebase Storage not initialised' });

  const { project, note } = req.query;
  if (!project || !note) return res.status(400).json({ error: 'project and note query params required' });

  try {
    const file = bucket.file(`notes/${project}/${note}.html`);
    const [contents] = await file.download();
    res.setHeader('Content-Type', 'text/html');
    res.send(contents.toString('utf8'));
  } catch (err) {
    res.status(404).json({ error: 'Note not found' });
  }
});

// ── Legacy GitHub publish proxy (kept as fallback) ────────────────────────
app.post('/publish', async (req, res) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not configured on server' });

  const { repo, filename, content } = req.body;
  if (!repo || !filename || !content) {
    return res.status(400).json({ error: 'repo, filename and content are required' });
  }

  const apiBase = `https://api.github.com/repos/${repo}/contents/${filename}`;
  const headers = {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'weeknote-tool'
  };

  let sha = null;
  try {
    const check = await fetch(apiBase, { headers });
    if (check.ok) { const d = await check.json(); sha = d.sha; }
  } catch (_) {}

  const body = { message: `Add ${filename}`, content, branch: 'main' };
  if (sha) body.sha = sha;

  try {
    const ghRes = await fetch(apiBase, { method: 'PUT', headers, body: JSON.stringify(body) });
    const data = await ghRes.json();
    if (!ghRes.ok) return res.status(ghRes.status).json({ error: data.message || 'GitHub error' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Publish failed: ' + err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Weeknote tool server listening on port ${port}`);
  console.log(`FIREBASE_SERVICE_ACCOUNT: ${process.env.FIREBASE_SERVICE_ACCOUNT ? 'present' : 'NOT SET'}`);
  console.log(`GITHUB_TOKEN: ${process.env.GITHUB_TOKEN ? 'present' : 'NOT SET'}`);
});
