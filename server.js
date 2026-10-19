const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
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
    storageBucket: 'week-notes.firebasestorage.app'
  });
  bucket = admin.storage().bucket();
  console.log(`Firebase Admin initialised for project: ${serviceAccount.project_id}`);
} catch (err) {
  console.error('Firebase Admin init failed:', err.message);
}

// ── Link token (HMAC-SHA256) ──────────────────────────────────────────────
function linkToken(uid, projectId, noteSlug, password = '') {
  const secret = process.env.LINK_SECRET || 'dev-secret-change-in-production';
  return crypto.createHmac('sha256', secret).update(`${uid}:${projectId}:${noteSlug}:${password}`).digest('hex');
}

function verifyLinkToken(uid, projectId, noteSlug, token, password = '') {
  if (!token || token.length !== 64) return false;
  try {
    const expected = Buffer.from(linkToken(uid, projectId, noteSlug, password), 'hex');
    const actual   = Buffer.from(token, 'hex');
    return crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

// ── Auth middleware ───────────────────────────────────────────────────────
async function requireIdeoAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Your session has expired. Please sign out and sign back in.' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (!decoded.email?.endsWith('@ideo.com')) {
      return res.status(403).json({ error: 'Access is restricted to @ideo.com accounts.' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Please sign out and sign back in.' });
  }
}

// ── Publish note to Firebase Storage ─────────────────────────────────────
app.post('/api/publish-note', requireIdeoAuth, async (req, res) => {
  if (!bucket) return res.status(500).json({ error: 'Publishing is not set up correctly. Please contact Rita.' });

  const { projectId, noteSlug, htmlContent, password = '' } = req.body;
  if (!projectId || !noteSlug || !htmlContent) {
    return res.status(400).json({ error: 'Something went wrong building the note. Please try again.' });
  }

  const uid = req.user.uid;
  const filePath = `notes/${uid}/${projectId}/${noteSlug}.html`;
  try {
    const file = bucket.file(filePath);
    await file.save(htmlContent, {
      contentType: 'text/html',
      metadata: { cacheControl: 'private, max-age=0' }
    });
    const token = linkToken(uid, projectId, noteSlug, password);
    const locked = password ? '&locked=1' : '';
    res.json({
      success: true,
      url: `https://projectweeklynotes.com/view?uid=${uid}&project=${projectId}&note=${noteSlug}&token=${token}${locked}`
    });
  } catch (err) {
    console.error(err);
    const msg = err.code === 'storage/unknown' || err.message?.includes('too large')
      ? 'This note is too large to publish. Try using smaller or fewer photos.'
      : 'Something went wrong while publishing. Please try again or contact Rita.';
    res.status(500).json({ error: msg });
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
    return res.status(403).json({ error: 'Your session has expired. Please sign out and sign back in.' });
  }

  if (!bucket) return res.status(500).json({ error: 'Storage is not available. Please contact Rita.' });

  const { project, note, uid } = req.query;
  if (!project || !note || !uid) return res.status(400).json({ error: 'The note link is incomplete. Please publish again to get a new link.' });

  try {
    const file = bucket.file(`notes/${uid}/${project}/${note}.html`);
    const [contents] = await file.download();
    res.setHeader('Content-Type', 'text/html');
    res.send(contents.toString('utf8'));
  } catch (err) {
    res.status(404).json({ error: 'Note not found. It may have been deleted or the link may be out of date.' });
  }
});

// ── Shared helper: fetch note from storage and send ───────────────────────
async function serveNote(uid, project, note, res) {
  if (!bucket) return res.status(500).send('This note is temporarily unavailable. Please try again later.');
  try {
    const file = bucket.file(`notes/${uid}/${project}/${note}.html`);
    const [contents] = await file.download();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(contents.toString('utf8'));
  } catch (err) {
    res.status(404).send('Note not found. The link may be out of date — please ask for a new one.');
  }
}

// ── Password gate HTML ────────────────────────────────────────────────────
function passwordGateHtml(uid, project, note, token, error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weekly Note</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{background:#DBE0E3;font-family:'Geist',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;}
  .card{background:#fff;border:0.5px solid #e8e6df;border-radius:8px;padding:52px 44px 44px;max-width:360px;width:90%;text-align:center;}
  .title{font-family:'Manrope',system-ui,sans-serif;font-weight:700;font-size:20px;color:#1a1a18;letter-spacing:-.02em;margin-bottom:6px;}
  .sub{font-size:12px;color:#888780;margin-bottom:28px;line-height:1.5;}
  .input{width:100%;font-size:14px;color:#1a1a18;border:0.5px solid #d3d1c7;border-radius:4px;padding:11px 14px;outline:none;margin-bottom:10px;font-family:inherit;}
  .input:focus{border-color:#888780;}
  .btn{width:100%;background:#1a1a18;color:#f5f4f0;border:none;border-radius:4px;padding:12px;font-size:14px;font-family:inherit;cursor:pointer;}
  .btn:hover{opacity:.85;}
  .err{font-size:12px;color:#c0392b;margin-top:10px;}
</style>
</head>
<body>
<div class="card">
  <div class="title">Weekly Note</div>
  <div class="sub">This note is password protected.</div>
  <form method="POST" action="/view">
    <input type="hidden" name="uid" value="${uid}"/>
    <input type="hidden" name="project" value="${project}"/>
    <input type="hidden" name="note" value="${note}"/>
    <input type="hidden" name="token" value="${token}"/>
    <input class="input" type="password" name="password" placeholder="Enter password" autofocus/>
    <button class="btn" type="submit">View note</button>
    ${error ? `<div class="err">${error}</div>` : ''}
  </form>
</div>
</body>
</html>`;
}

// ── Client view route — token-gated, optional password ───────────────────
app.get('/view', async (req, res) => {
  const { uid, project, note, token, locked } = req.query;
  if (!uid || !project || !note || !token) {
    return res.status(400).send('This link is incomplete. Please ask for a new one.');
  }
  if (locked === '1') {
    return res.send(passwordGateHtml(uid, project, note, token));
  }
  if (!verifyLinkToken(uid, project, note, token)) {
    return res.status(403).send('This link is not valid or has expired. Please ask for a new one.');
  }
  await serveNote(uid, project, note, res);
});

app.use(express.urlencoded({ extended: false }));

app.post('/view', async (req, res) => {
  const { uid, project, note, token, password = '' } = req.body;
  if (!uid || !project || !note || !token) {
    return res.status(400).send('This link is incomplete. Please ask for a new one.');
  }
  if (!verifyLinkToken(uid, project, note, token, password)) {
    return res.status(403).send(passwordGateHtml(uid, project, note, token, 'That password is incorrect. Please try again.'));
  }
  await serveNote(uid, project, note, res);
});

// ── Legacy GitHub publish proxy (kept as fallback) ────────────────────────
app.post('/publish', async (req, res) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'Publishing is not set up correctly. Please contact Rita.' });

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
    if (!ghRes.ok) return res.status(ghRes.status).json({ error: 'Something went wrong while publishing. Please try again or contact Rita.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong while publishing. Please try again or contact Rita.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Weeknote tool server listening on port ${port}`);
  console.log(`FIREBASE_SERVICE_ACCOUNT: ${process.env.FIREBASE_SERVICE_ACCOUNT ? 'present' : 'NOT SET'}`);
  console.log(`GITHUB_TOKEN: ${process.env.GITHUB_TOKEN ? 'present' : 'NOT SET'}`);
});
