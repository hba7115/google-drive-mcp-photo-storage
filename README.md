# Claude Google Drive MCP (expanded) - Photo_Storage only

This repository contains a Node.js MCP-style helper server that allows Claude (or other clients) to access a single Google Drive folder (`Photo_Storage`) and its subtree. Features: recursive listing, search (name + content), file/folder CRUD, batch delete, metadata, and optional shared-secret protection.

## Files
- `server.js` - main server
- `package.json` - dependencies
- `Dockerfile` - optional
- `.gitignore` - ignore tokens and node_modules

## Deploy (Render)
1. Push this repo to GitHub.
2. Create a new Web Service on Render and connect the repo.
3. Set Environment Variables in Render:
   - `GOOGLE_CLIENT_ID` (from Google Cloud)
   - `GOOGLE_CLIENT_SECRET` (from Google Cloud)
   - `SESSION_SECRET` (any random string)
   - `DRIVE_FOLDER_NAME` = `Photo_Storage`
   - `MCP_SHARED_SECRET` (optional; use a long random string to require header)
   - `OAUTH_REDIRECT_URI` = `https://<your-render-service>.onrender.com/oauth2callback` (optional)
4. Deploy and start.

## First-time auth
Open:
`https://<your-render-service>.onrender.com/auth`
Sign in to the Google account you want to use and accept consent.

## Endpoints (selected)
- GET `/info` - basic info
- GET `/auth` - start OAuth
- GET `/oauth2callback` - OAuth callback
- GET `/list?parentId=...&depth=...` - recursive listing
- GET `/file/:id` - download file
- POST `/upload` - create/update file (base64 content)
- POST `/folder` - create folder
- POST `/move` - move file/folder
- POST `/batch-delete` - delete many
- GET `/search?q=term&content=true` - search by name or content
- POST `/rename` - rename file
- DELETE `/delete/:id` - delete file or folder

## Security
- The server enforces that all operations occur under the folder named `Photo_Storage` in the connected Drive.
- Optionally set `MCP_SHARED_SECRET` to require `X-MCP-SECRET` header for calls.
- Tokens are stored in `tokens.json` by default. For production: use a secret manager.

## Testing (curl)
See README from the conversation for exact curl examples.

## Revoke access
From your Google Account → Security → Third-party apps → remove access for the app.
