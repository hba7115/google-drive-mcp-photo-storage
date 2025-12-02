// server.js
// Expanded Google Drive MCP helper for Claude - restricted to DRIVE_FOLDER_NAME (Photo_Storage)
// Features: recursive listing, search, file CRUD, folder CRUD, metadata, batch ops, shared-secret protection.
// NOTE: For production store tokens in a secure store. This sample stores them in tokens.json (simple).

const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const bodyParser = require('body-parser');

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const DRIVE_FOLDER_NAME = process.env.DRIVE_FOLDER_NAME || 'Photo_Storage';
const TOKEN_FILE = path.join(__dirname, 'tokens.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_session_secret';
const MCP_SHARED_SECRET = process.env.MCP_SHARED_SECRET || ''; // optional: set to require header

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in env.');
  process.exit(1);
}

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  process.env.OAUTH_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`
);

const SCOPES = [
  'https://www.googleapis.com/auth/drive', // full drive API but we enforce folder restriction
  'https://www.googleapis.com/auth/drive.metadata.readonly'
];

function protectiveMiddleware(req, res, next) {
  // If a shared secret is configured, require it in X-MCP-SECRET header
  if (MCP_SHARED_SECRET) {
    const got = req.get('X-MCP-SECRET') || '';
    if (!got || got !== MCP_SHARED_SECRET) {
      return res.status(401).json({ error: 'Missing or invalid MCP shared secret header' });
    }
  }
  next();
}
app.use(protectiveMiddleware);

// Utilities for tokens
function storeTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}
function getStoredTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function getDrive() {
  const tokens = getStoredTokens();
  if (!tokens) throw new Error('No tokens — authenticate at /auth');
  oauth2Client.setCredentials(tokens);
  // googleapis handles refreshing with the oauth2Client if refresh_token present
  oauth2Client.on('tokens', (toks) => {
    const existing = getStoredTokens() || {};
    const merged = { ...existing, ...toks };
    storeTokens(merged);
  });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

// Ensure root folder exists and return its id
async function ensureRootFolder() {
  const drive = await getDrive();
  // search top-level folder with that name (not trashed)
  const name = DRIVE_FOLDER_NAME.replace(/'/g, "\\'");
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id, name, parents)', pageSize: 10 });
  if (res.data.files && res.data.files.length > 0) return res.data.files[0].id;

  // create at root
  const created = await drive.files.create({
    requestBody: {
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    },
    fields: 'id, name'
  });
  return created.data.id;
}

// Helper: check if file/folder is descendant of root
async function isDescendant(drive, candidateId, rootId) {
  if (candidateId === rootId) return true;
  // climb parent chain up to a sensible depth
  let toCheck = [candidateId];
  for (let depth = 0; depth < 30; depth++) {
    const next = [];
    for (const id of toCheck) {
      try {
        const md = await drive.files.get({ fileId: id, fields: 'id, parents' });
        if (!md.data.parents || md.data.parents.length === 0) continue;
        for (const p of md.data.parents) {
          if (p === rootId) return true;
          next.push(p);
        }
      } catch (e) {
        // if we cannot get metadata, assume false for this branch
        continue;
      }
    }
    if (next.length === 0) return false;
    toCheck = next;
  }
  return false;
}

// ---------- ROUTES ----------

// Info
app.get('/info', async (req, res) => {
  res.json({
    name: 'Claude Google Drive MCP (expanded)',
    folder: DRIVE_FOLDER_NAME
  });
});

// Start OAuth
app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(url);
});

// OAuth callback
app.get('/oauth2callback', async (req, res) => {
  try {
    if (!req.query.code) return res.status(400).send('Missing code');
    const { tokens } = await oauth2Client.getToken(req.query.code);
    storeTokens(tokens);
    oauth2Client.setCredentials(tokens);
    // ensure root
    await ensureRootFolder();
    res.send('Authentication successful — you can close this tab.');
  } catch (err) {
    console.error('oauth callback error', err);
    res.status(500).send('OAuth error: ' + err.message);
  }
});

// Recursive list: returns tree under parentId or root
app.get('/list', async (req, res) => {
  try {
    const drive = await getDrive();
    const root = await ensureRootFolder();
    const start = req.query.parentId || root;
    // verify start is descendant
    if (!(await isDescendant(drive, start, root))) return res.status(403).json({ error: 'Not allowed' });

    // BFS traversal but limited to depth param (default 4)
    const maxDepth = parseInt(req.query.depth || '4', 10);
    const queue = [{ id: start, depth: 0 }];
    const results = [];
    while (queue.length) {
      const node = queue.shift();
      // list children
      const list = await drive.files.list({
        q: `'${node.id}' in parents and trashed=false`,
        fields: 'files(id, name, mimeType, size, modifiedTime, parents)',
        pageSize: 1000
      });
      for (const f of list.data.files || []) {
        results.push({ ...f, depth: node.depth });
        if (f.mimeType === 'application/vnd.google-apps.folder' && node.depth + 1 < maxDepth) {
          queue.push({ id: f.id, depth: node.depth + 1 });
        }
      }
    }
    res.json({ files: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Metadata endpoint
app.get('/meta/:id', async (req, res) => {
  try {
    const drive = await getDrive();
    const root = await ensureRootFolder();
    const id = req.params.id;
    if (!(await isDescendant(drive, id, root))) return res.status(403).json({ error: 'Not allowed' });
    const meta = await drive.files.get({ fileId: id, fields: 'id, name, mimeType, size, modifiedTime, parents' });
    res.json(meta.data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Download file (exports Google Docs to text, otherwise streams binary)
app.get('/file/:id', async (req, res) => {
  try {
    const drive = await getDrive();
    const root = await ensureRootFolder();
    const id = req.params.id;
    if (!(await isDescendant(drive, id, root))) return res.status(403).json({ error: 'Not allowed' });

    const meta = await drive.files.get({ fileId: id, fields: 'id, name, mimeType' });
    const mime = meta.data.mimeType;

    if (mime === 'application/vnd.google-apps.document') {
      const x = await drive.files.export({ fileId: id, mimeType: 'text/plain' }, { responseType: 'stream' });
      res.setHeader('content-disposition', `attachment; filename="${meta.data.name}.txt"`);
      x.data.pipe(res);
      return;
    }
    const dl = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' });
    res.setHeader('content-disposition', `attachment; filename="${meta.data.name}"`);
    dl.data.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Upload/create or update file. Supports base64 content (body.content) and optional fileId for update
app.post('/upload', async (req, res) => {
  try {
    const { name, content, mimeType, parentId, fileId } = req.body;
    if (!name && !fileId) return res.status(400).json({ error: 'Missing name or fileId' });

    const drive = await getDrive();
    const root = await ensureRootFolder();
    const parent = parentId || root;

    if (!(await isDescendant(drive, parent, root))) return res.status(403).json({ error: 'Parent not allowed' });

    // decode base64 content if provided; if no content and updating fileId, treat as metadata-only rename
    const mediaBody = content ? Buffer.from(content, 'base64') : null;

    if (fileId) {
      // make sure target is descendant
      if (!(await isDescendant(drive, fileId, root))) return res.status(403).json({ error: 'Target not allowed' });
      const resp = await drive.files.update({
        fileId,
        requestBody: { name, mimeType },
        media: mediaBody ? { mimeType: mimeType || 'application/octet-stream', body: mediaBody } : undefined,
        fields: 'id, name'
      });
      return res.json({ updated: resp.data });
    } else {
      const resp = await drive.files.create({
        requestBody: { name, parents: [parent], mimeType: mimeType || 'text/markdown' },
        media: mediaBody ? { mimeType: mimeType || 'text/markdown', body: mediaBody } : undefined,
        fields: 'id, name'
      });
      return res.json({ created: resp.data });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create folder under parent
app.post('/folder', async (req, res) => {
  try {
    const { name, parentId } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing name' });
    const drive = await getDrive();
    const root = await ensureRootFolder();
    const parent = parentId || root;
    if (!(await isDescendant(drive, parent, root))) return res.status(403).json({ error: 'Parent not allowed' });

    const resp = await drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] },
      fields: 'id, name'
    });
    res.json({ folder: resp.data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Move file/folder to new parent
app.post('/move', async (req, res) => {
  try {
    const { id, newParentId } = req.body;
    if (!id || !newParentId) return res.status(400).json({ error: 'Missing id or newParentId' });
    const drive = await getDrive();
    const root = await ensureRootFolder();
    if (!(await isDescendant(drive, id, root)) || !(await isDescendant(drive, newParentId, root))) return res.status(403).json({ error: 'Not allowed' });

    // get current parents
    const meta = await drive.files.get({ fileId: id, fields: 'parents' });
    const previousParents = meta.data.parents ? meta.data.parents.join(',') : '';
    const updated = await drive.files.update({ fileId: id, addParents: newParentId, removeParents: previousParents, fields: 'id, name, parents' });
    res.json({ moved: updated.data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Batch delete - accepts array of ids
app.post('/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Missing ids array' });
    const drive = await getDrive();
    const root = await ensureRootFolder();
    const results = [];
    for (const id of ids) {
      try {
        if (!(await isDescendant(drive, id, root))) { results.push({ id, ok: false, reason: 'not allowed' }); continue; }
        await drive.files.delete({ fileId: id });
        results.push({ id, ok: true });
      } catch (e) { results.push({ id, ok: false, reason: e.message }); }
    }
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Search by name and, for text files, can optionally do text extraction to search content
// ?q=term&content=true
app.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing q param' });
    const contentSearch = (req.query.content || 'false') === 'true';
    const drive = await getDrive();
    const root = await ensureRootFolder();

    // name-based search first (fast)
    const nameMatches = await drive.files.list({
      q: `name contains '${q.replace(/'/g, "\\'")}' and trashed=false`,
      fields: 'files(id, name, mimeType, parents)',
      pageSize: 100
    });

    // filter to descendants
    const filtered = [];
    for (const f of (nameMatches.data.files || [])) {
      if (await isDescendant(drive, f.id, root)) filtered.push(f);
    }

    if (!contentSearch) return res.json({ files: filtered });

    // If contentSearch true, also search by exported text for text-like mime types (list of candidate mimes)
    const extras = [];
    const candidates = await drive.files.list({ q: `trashed=false`, fields: 'files(id, name, mimeType, parents)', pageSize: 1000 });
    for (const c of (candidates.data.files || [])) {
      if (!await isDescendant(drive, c.id, root)) continue;
      try {
        // Only attempt for types we can export or that are plain text
        const mime = c.mimeType;
        let text = null;
        if (mime === 'application/vnd.google-apps.document') {
          const x = await drive.files.export({ fileId: c.id, mimeType: 'text/plain' }, { responseType: 'text' });
          text = x.data;
        } else if (mime.startsWith('text/') || mime.includes('json') || mime.includes('markdown') || mime.includes('csv')) {
          const r = await drive.files.get({ fileId: c.id, alt: 'media' }, { responseType: 'text' });
          text = r.data;
        } else {
          // skip binary
        }
        if (text && text.toLowerCase().includes(q.toLowerCase())) extras.push(c);
      } catch (e) {
        continue;
      }
    }
    // combine unique
    const combined = [...filtered];
    for (const e of extras) if (!combined.find(x => x.id === e.id)) combined.push(e);
    res.json({ files: combined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Rename
app.post('/rename', async (req, res) => {
  try {
    const { id, newName } = req.body;
    if (!id || !newName) return res.status(400).json({ error: 'Missing id or newName' });
    const drive = await getDrive();
    const root = await ensureRootFolder();
    if (!(await isDescendant(drive, id, root))) return res.status(403).json({ error: 'Not allowed' });
    const r = await drive.files.update({ fileId: id, requestBody: { name: newName }, fields: 'id, name' });
    res.json({ renamed: r.data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Delete single
app.delete('/delete/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const drive = await getDrive();
    const root = await ensureRootFolder();
    if (!(await isDescendant(drive, id, root))) return res.status(403).json({ error: 'Not allowed' });
    await drive.files.delete({ fileId: id });
    res.json({ deleted: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Start
app.listen(PORT, () => console.log(`MCP server listening on ${PORT}`));
