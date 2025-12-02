// server.js
// Expanded Google Drive MCP helper for Claude - WITH MCP PROTOCOL SUPPORT (ES Module version)
// Restricted to DRIVE_FOLDER_NAME (Photo_Storage)

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import bodyParser from 'body-parser';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// ES Module equivalents for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const DRIVE_FOLDER_NAME = process.env.DRIVE_FOLDER_NAME || 'Photo_Storage';
const TOKEN_FILE = path.join(__dirname, 'tokens.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_session_secret';
const MCP_SHARED_SECRET = process.env.MCP_SHARED_SECRET || '';

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
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.metadata.readonly'
];

// ========== MCP SERVER SETUP ==========
const mcpServer = new Server(
  {
    name: 'google-drive-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define MCP Tools
mcpServer.setRequestHandler('tools/list', async () => {
  return {
    tools: [
      {
        name: 'list_files',
        description: 'List files and folders in Photo_Storage (recursive)',
        inputSchema: {
          type: 'object',
          properties: {
            parentId: { type: 'string', description: 'Parent folder ID (optional)' },
            depth: { type: 'number', description: 'Recursion depth (default 4)' }
          }
        }
      },
      {
        name: 'create_folder',
        description: 'Create a new folder in Photo_Storage',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Folder name' },
            parentId: { type: 'string', description: 'Parent folder ID (optional)' }
          },
          required: ['name']
        }
      },
      {
        name: 'upload_file',
        description: 'Upload or update a file in Photo_Storage',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name' },
            content: { type: 'string', description: 'Base64 encoded content' },
            mimeType: { type: 'string', description: 'MIME type' },
            parentId: { type: 'string', description: 'Parent folder ID (optional)' },
            fileId: { type: 'string', description: 'File ID to update (optional)' }
          }
        }
      },
      {
        name: 'read_file',
        description: 'Read file content from Photo_Storage',
        inputSchema: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'File ID to read' }
          },
          required: ['fileId']
        }
      },
      {
        name: 'search_files',
        description: 'Search files by name or content',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            contentSearch: { type: 'boolean', description: 'Search file contents (default false)' }
          },
          required: ['query']
        }
      },
      {
        name: 'move_item',
        description: 'Move a file or folder to a new parent',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Item ID to move' },
            newParentId: { type: 'string', description: 'New parent folder ID' }
          },
          required: ['id', 'newParentId']
        }
      },
      {
        name: 'rename_item',
        description: 'Rename a file or folder',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Item ID to rename' },
            newName: { type: 'string', description: 'New name' }
          },
          required: ['id', 'newName']
        }
      },
      {
        name: 'delete_item',
        description: 'Delete a file or folder',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Item ID to delete' }
          },
          required: ['id']
        }
      }
    ]
  };
});

// Handle MCP tool calls
mcpServer.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    switch (name) {
      case 'list_files': {
        const drive = await getDrive();
        const root = await ensureRootFolder();
        const start = args.parentId || root;
        const maxDepth = parseInt(args.depth || '4', 10);
        
        if (!(await isDescendant(drive, start, root))) {
          return { content: [{ type: 'text', text: 'Error: Not allowed' }], isError: true };
        }
        
        const queue = [{ id: start, depth: 0 }];
        const results = [];
        while (queue.length) {
          const node = queue.shift();
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
        return { content: [{ type: 'text', text: JSON.stringify({ files: results }, null, 2) }] };
      }
      
      case 'create_folder': {
        const drive = await getDrive();
        const root = await ensureRootFolder();
        const parent = args.parentId || root;
        
        if (!(await isDescendant(drive, parent, root))) {
          return { content: [{ type: 'text', text: 'Error: Parent not allowed' }], isError: true };
        }
        
        const resp = await drive.files.create({
          requestBody: { name: args.name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] },
          fields: 'id, name'
        });
        return { content: [{ type: 'text', text: JSON.stringify({ folder: resp.data }, null, 2) }] };
      }
      
      case 'upload_file': {
        const drive = await getDrive();
        const root = await ensureRootFolder();
        const parent = args.parentId || root;
        
        if (!(await isDescendant(drive, parent, root))) {
          return { content: [{ type: 'text', text: 'Error: Parent not allowed' }], isError: true };
        }
        
        const mediaBody = args.content ? Buffer.from(args.content, 'base64') : null;
        
        if (args.fileId) {
          if (!(await isDescendant(drive, args.fileId, root))) {
            return { content: [{ type: 'text', text: 'Error: Target not allowed' }], isError: true };
          }
          const resp = await drive.files.update({
            fileId: args.fileId,
            requestBody: { name: args.name, mimeType: args.mimeType },
            media: mediaBody ? { mimeType: args.mimeType || 'application/octet-stream', body: mediaBody } : undefined,
            fields: 'id, name'
          });
          return { content: [{ type: 'text', text: JSON.stringify({ updated: resp.data }, null, 2) }] };
        } else {
          const resp = await drive.files.create({
            requestBody: { name: args.name, parents: [parent], mimeType: args.mimeType || 'text/markdown' },
            media: mediaBody ? { mimeType: args.mimeType || 'text/markdown', body: mediaBody } : undefined,
            fields: 'id, name'
          });
          return { content: [{ type: 'text', text: JSON.stringify({ created: resp.data }, null, 2) }] };
        }
      }
      
      case 'read_file': {
        const drive = await getDrive();
        const root = await ensureRootFolder();
        
        if (!(await isDescendant(drive, args.fileId, root))) {
          return { content: [{ type: 'text', text: 'Error: Not allowed' }], isError: true };
        }
        
        const meta = await drive.files.get({ fileId: args.fileId, fields: 'id, name, mimeType' });
        const mime = meta.data.mimeType;
        
        if (mime === 'application/vnd.google-apps.document') {
          const x = await drive.files.export({ fileId: args.fileId, mimeType: 'text/plain' }, { responseType: 'text' });
          return { content: [{ type: 'text', text: x.data }] };
        }
        
        const dl = await drive.files.get({ fileId: args.fileId, alt: 'media' }, { responseType: 'text' });
        return { content: [{ type: 'text', text: dl.data }] };
      }
      
      case 'search_files': {
        const drive = await getDrive();
        const root = await ensureRootFolder();
        const q = args.query.trim();
        
        const nameMatches = await drive.files.list({
          q: `name contains '${q.replace(/'/g, "\\'")}' and trashed=false`,
          fields: 'files(id, name, mimeType, parents)',
          pageSize: 100
        });
        
        const filtered = [];
        for (const f of (nameMatches.data.files || [])) {
          if (await isDescendant(drive, f.id, root)) filtered.push(f);
        }
        
        return { content: [{ type: 'text', text: JSON.stringify({ files: filtered }, null, 2) }] };
      }
      
      case 'move_item': {
        const drive = await getDrive();
        const root = await ensureRootFolder();
        
        if (!(await isDescendant(drive, args.id, root)) || !(await isDescendant(drive, args.newParentId, root))) {
          return { content: [{ type: 'text', text: 'Error: Not allowed' }], isError: true };
        }
        
        const meta = await drive.files.get({ fileId: args.id, fields: 'parents' });
        const previousParents = meta.data.parents ? meta.data.parents.join(',') : '';
        const updated = await drive.files.update({
          fileId: args.id,
          addParents: args.newParentId,
          removeParents: previousParents,
          fields: 'id, name, parents'
        });
        return { content: [{ type: 'text', text: JSON.stringify({ moved: updated.data }, null, 2) }] };
      }
      
      case 'rename_item': {
        const drive = await getDrive();
        const root = await ensureRootFolder();
        
        if (!(await isDescendant(drive, args.id, root))) {
          return { content: [{ type: 'text', text: 'Error: Not allowed' }], isError: true };
        }
        
        const r = await drive.files.update({
          fileId: args.id,
          requestBody: { name: args.newName },
          fields: 'id, name'
        });
        return { content: [{ type: 'text', text: JSON.stringify({ renamed: r.data }, null, 2) }] };
      }
      
      case 'delete_item': {
        const drive = await getDrive();
        const root = await ensureRootFolder();
        
        if (!(await isDescendant(drive, args.id, root))) {
          return { content: [{ type: 'text', text: 'Error: Not allowed' }], isError: true };
        }
        
        await drive.files.delete({ fileId: args.id });
        return { content: [{ type: 'text', text: JSON.stringify({ deleted: args.id }, null, 2) }] };
      }
      
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

// ========== UTILITY FUNCTIONS ==========

function protectiveMiddleware(req, res, next) {
  if (MCP_SHARED_SECRET) {
    const got = req.get('X-MCP-SECRET') || '';
    if (!got || got !== MCP_SHARED_SECRET) {
      return res.status(401).json({ error: 'Missing or invalid MCP shared secret header' });
    }
  }
  next();
}
app.use(protectiveMiddleware);

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
  oauth2Client.on('tokens', (toks) => {
    const existing = getStoredTokens() || {};
    const merged = { ...existing, ...toks };
    storeTokens(merged);
  });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

async function ensureRootFolder() {
  const drive = await getDrive();
  const name = DRIVE_FOLDER_NAME.replace(/'/g, "\\'");
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id, name, parents)', pageSize: 10 });
  if (res.data.files && res.data.files.length > 0) return res.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    },
    fields: 'id, name'
  });
  return created.data.id;
}

async function isDescendant(drive, candidateId, rootId) {
  if (candidateId === rootId) return true;
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
        continue;
      }
    }
    if (next.length === 0) return false;
    toCheck = next;
  }
  return false;
}

// ========== REST API ROUTES ==========

app.get('/info', async (req, res) => {
  res.json({
    name: 'Claude Google Drive MCP (expanded with MCP protocol)',
    folder: DRIVE_FOLDER_NAME,
    mcpEnabled: true
  });
});

app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(url);
});

app.get('/authorize', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    if (!req.query.code) return res.status(400).send('Missing code');
    const { tokens } = await oauth2Client.getToken(req.query.code);
    storeTokens(tokens);
    oauth2Client.setCredentials(tokens);
    await ensureRootFolder();
    res.send('Authentication successful — you can close this tab.');
  } catch (err) {
    console.error('oauth callback error', err);
    res.status(500).send('OAuth error: ' + err.message);
  }
});

app.get('/list', async (req, res) => {
  try {
    const drive = await getDrive();
    const root = await ensureRootFolder();
    const start = req.query.parentId || root;
    if (!(await isDescendant(drive, start, root))) return res.status(403).json({ error: 'Not allowed' });

    const maxDepth = parseInt(req.query.depth || '4', 10);
    const queue = [{ id: start, depth: 0 }];
    const results = [];
    while (queue.length) {
      const node = queue.shift();
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

app.post('/upload', async (req, res) => {
  try {
    const { name, content, mimeType, parentId, fileId } = req.body;
    if (!name && !fileId) return res.status(400).json({ error: 'Missing name or fileId' });

    const drive = await getDrive();
    const root = await ensureRootFolder();
    const parent = parentId || root;

    if (!(await isDescendant(drive, parent, root))) return res.status(403).json({ error: 'Parent not allowed' });

    const mediaBody = content ? Buffer.from(content, 'base64') : null;

    if (fileId) {
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

app.post('/move', async (req, res) => {
  try {
    const { id, newParentId } = req.body;
    if (!id || !newParentId) return res.status(400).json({ error: 'Missing id or newParentId' });
    const drive = await getDrive();
    const root = await ensureRootFolder();
    if (!(await isDescendant(drive, id, root)) || !(await isDescendant(drive, newParentId, root))) return res.status(403).json({ error: 'Not allowed' });

    const meta = await drive.files.get({ fileId: id, fields: 'parents' });
    const previousParents = meta.data.parents ? meta.data.parents.join(',') : '';
    const updated = await drive.files.update({ fileId: id, addParents: newParentId, removeParents: previousParents, fields: 'id, name, parents' });
    res.json({ moved: updated.data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing q param' });
    const contentSearch = (req.query.content || 'false') === 'true';
    const drive = await getDrive();
    const root = await ensureRootFolder();

    const nameMatches = await drive.files.list({
      q: `name contains '${q.replace(/'/g, "\\'")}' and trashed=false`,
      fields: 'files(id, name, mimeType, parents)',
      pageSize: 100
    });

    const filtered = [];
    for (const f of (nameMatches.data.files || [])) {
      if (await isDescendant(drive, f.id, root)) filtered.push(f);
    }

    if (!contentSearch) return res.json({ files: filtered });

    const extras = [];
    const candidates = await drive.files.list({ q: `trashed=false`, fields: 'files(id, name, mimeType, parents)', pageSize: 1000 });
    for (const c of (candidates.data.files || [])) {
      if (!await isDescendant(drive, c.id, root)) continue;
      try {
        const mime = c.mimeType;
        let text = null;
        if (mime === 'application/vnd.google-apps.document') {
          const x = await drive.files.export({ fileId: c.id, mimeType: 'text/plain' }, { responseType: 'text' });
          text = x.data;
        } else if (mime.startsWith('text/') || mime.includes('json') || mime.includes('markdown') || mime.includes('csv')) {
          const r = await drive.files.get({ fileId: c.id, alt: 'media' }, { responseType: 'text' });
          text = r.data;
        }
        if (text && text.toLowerCase().includes(q.toLowerCase())) extras.push(c);
      } catch (e) {
        continue;
      }
    }
    const combined = [...filtered];
    for (const e of extras) if (!combined.find(x => x.id === e.id)) combined.push(e);
    res.json({ files: combined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/health', (req, res) => res.json({ ok: true, mcpEnabled: true }));

// Start Express server
app.listen(PORT, () => console.log(`MCP server listening on ${PORT}`));

// Start MCP server for stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.log('MCP protocol server started');
}

if (process.env.MCP_STDIO_MODE === 'true') {
  main().catch(console.error);
}
