const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve the static builder
app.use(express.static('.'));

// ── GitHub publish proxy ──────────────────────────────────────────────────
app.post('/publish', async (req, res) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not configured on server' });
  }

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

  // Check if file already exists (need SHA to update)
  let sha = null;
  try {
    const check = await fetch(apiBase, { headers });
    if (check.ok) {
      const d = await check.json();
      sha = d.sha;
    }
  } catch (_) {}

  const body = { message: `Add ${filename}`, content, branch: 'main' };
  if (sha) body.sha = sha;

  try {
    const ghRes = await fetch(apiBase, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body)
    });
    const data = await ghRes.json();
    if (!ghRes.ok) {
      return res.status(ghRes.status).json({ error: data.message || 'GitHub error' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Publish failed: ' + err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Weeknote tool server listening on port ${port}`);
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    console.log(`GITHUB_TOKEN: present (starts with ${token.slice(0, 6)}…, length ${token.length})`);
  } else {
    console.log('GITHUB_TOKEN: NOT SET');
  }
});
