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
    storageBucket: 'week-notes.firebasestorage.app'
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

// ── Client view route — email gate + magic link flow ──────────────────────
app.get('/view', (req, res) => {
  const { project, note } = req.query;
  if (!project || !note) return res.status(400).send('Missing project or note parameter');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weekly Note</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{background:#DBE0E3;font-family:'Geist',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;}
  .card{background:#fff;border:0.5px solid #e8e6df;border-radius:8px;padding:52px 44px 44px;max-width:380px;width:90%;text-align:center;}
  .title{font-family:'Manrope',system-ui,sans-serif;font-weight:700;font-size:20px;color:#1a1a18;letter-spacing:-.02em;margin-bottom:6px;}
  .sub{font-size:12px;color:#888780;margin-bottom:36px;line-height:1.5;}
  .input{width:100%;font-size:14px;color:#1a1a18;border:0.5px solid #d3d1c7;border-radius:4px;padding:11px 14px;outline:none;margin-bottom:10px;font-family:inherit;}
  .input:focus{border-color:#888780;}
  .btn{width:100%;background:#1a1a18;color:#f5f4f0;border:none;border-radius:4px;padding:12px;font-size:14px;font-family:inherit;cursor:pointer;}
  .btn:hover{opacity:.85;}
  .btn:disabled{opacity:.4;cursor:not-allowed;}
  .msg{font-size:12px;margin-top:14px;line-height:1.6;color:#888780;min-height:18px;}
  .msg.err{color:#c0392b;}
  .msg.ok{color:#2d6a4f;}
  #loading{display:none;color:#888780;font-size:13px;}
</style>
</head>
<body>

<div class="card" id="gate-card">
  <div class="title">Weekly Note</div>
  <div class="sub">Enter your email to receive a secure link<br>and view this newsletter.</div>
  <input class="input" id="email-input" type="email" placeholder="you@example.com" autocomplete="email"/>
  <button class="btn" id="send-btn" onclick="requestLink()">Send me the link</button>
  <div class="msg" id="gate-msg"></div>
</div>

<div id="loading">Loading your newsletter…</div>

<script type="module">
  import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
  import { getAuth, isSignInWithEmailLink, signInWithEmailLink, sendSignInLinkToEmail }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';

  const firebaseConfig = {
    apiKey: 'AIzaSyCP6NSkcs1a6TisyNgPG8wXNsISIIDNUzg',
    authDomain: 'week-notes.firebaseapp.com',
    projectId: 'week-notes',
    storageBucket: 'week-notes.firebasestorage.app',
    messagingSenderId: '976713620391',
    appId: '1:976713620391:web:f7b037ca4b4dddc73d3482'
  };

  const app  = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const PROJECT = '${project}';
  const NOTE    = '${note}';
  const VIEW_URL = window.location.origin + '/view?project=' + PROJECT + '&note=' + NOTE;

  // ── Complete magic link sign-in if this is a return visit ────────────────
  if (isSignInWithEmailLink(auth, window.location.href)) {
    document.getElementById('gate-card').style.display = 'none';
    document.getElementById('loading').style.display   = 'block';

    let email = localStorage.getItem('clientEmailForSignIn');
    if (!email) email = window.prompt('Please re-enter your email to confirm:');

    signInWithEmailLink(auth, email, window.location.href)
      .then(async result => {
        localStorage.removeItem('clientEmailForSignIn');
        // Clean the oobCode etc from the URL
        window.history.replaceState({}, '', VIEW_URL);
        // Fetch the newsletter with the user's token
        const token = await result.user.getIdToken();
        const res = await fetch('/api/get-note?project=' + PROJECT + '&note=' + NOTE, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!res.ok) throw new Error('Newsletter not found (status ' + res.status + ')');
        const html = await res.text();
        document.open();
        document.write(html);
        document.close();
      })
      .catch(err => {
        document.getElementById('gate-card').style.display = 'block';
        document.getElementById('loading').style.display   = 'none';
        const msg = document.getElementById('gate-msg');
        msg.className = 'msg err';
        msg.textContent = 'Sign-in failed: ' + err.message + ' — try requesting a new link.';
      });
  }

  // ── Send magic link ───────────────────────────────────────────────────────
  window.requestLink = async () => {
    const email = document.getElementById('email-input').value.trim();
    const msg   = document.getElementById('gate-msg');
    const btn   = document.getElementById('send-btn');

    if (!email) { msg.className='msg err'; msg.textContent='Please enter your email address.'; return; }

    btn.disabled = true;
    msg.className = 'msg';
    msg.textContent = 'Sending…';

    try {
      await sendSignInLinkToEmail(auth, email, { url: VIEW_URL, handleCodeInApp: true });
      localStorage.setItem('clientEmailForSignIn', email);
      msg.className = 'msg ok';
      msg.textContent = 'Link sent to ' + email + '. Check your inbox (and spam folder) and click the link to open the newsletter.';
      document.getElementById('email-input').value = '';
    } catch(err) {
      console.error(err);
      msg.className = 'msg err';
      msg.textContent = 'Could not send link: ' + (err.message || err.code);
    } finally {
      btn.disabled = false;
    }
  };
</script>
</body>
</html>`);
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
