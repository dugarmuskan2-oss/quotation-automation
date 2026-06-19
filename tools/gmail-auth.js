/**
 * One-time Gmail OAuth setup.
 * Run with: node tools/gmail-auth.js
 *
 * Opens your browser → you approve Gmail send permission →
 * refresh token is saved to .env automatically.
 */

require('dotenv').config();
const { google } = require('googleapis');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3002/oauth2callback';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.metadata',
];
const ENV_PATH = path.join(__dirname, '..', '.env');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('\n=== Gmail OAuth Setup ===\n');
console.log('Opening your browser to approve Gmail send permission...');
console.log('If the browser does not open, paste this URL manually:\n');
console.log(authUrl);
console.log('\nWaiting for approval...\n');

// Open browser automatically
const { exec } = require('child_process');
exec(`start "" "${authUrl}"`);

// Temporary local server to capture the auth code
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) return;

  const url = new URL(req.url, 'http://localhost:3002');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Access denied.</h2><p>You can close this tab.</p>');
    console.error('ERROR: Access was denied:', error);
    server.close();
    return;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<h2>No code received.</h2>');
    server.close();
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>No refresh token received.</h2><p>Try revoking access at myaccount.google.com/permissions and running this script again.</p>');
      console.error('ERROR: No refresh token in response. Revoke app access and try again.');
      server.close();
      return;
    }

    // Save refresh token to .env
    let envContent = fs.readFileSync(ENV_PATH, 'utf8');
    if (envContent.includes('GMAIL_REFRESH_TOKEN=')) {
      envContent = envContent.replace(/GMAIL_REFRESH_TOKEN=.*/g, `GMAIL_REFRESH_TOKEN=${refreshToken}`);
    } else {
      envContent = envContent.trimEnd() + `\nGMAIL_REFRESH_TOKEN=${refreshToken}\n`;
    }
    fs.writeFileSync(ENV_PATH, envContent);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2 style="color:green">✅ Gmail authorised successfully!</h2><p>You can close this tab and return to the terminal.</p>');

    console.log('✅ Success! Refresh token saved to .env as GMAIL_REFRESH_TOKEN');
    console.log('You can now restart the app and Gmail send will work.\n');
    server.close();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('<h2>Error exchanging code for token.</h2><p>' + err.message + '</p>');
    console.error('ERROR:', err.message);
    server.close();
  }
});

server.listen(3002, () => {
  // Server ready, waiting for redirect
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('ERROR: Port 3002 is already in use. Stop whatever is using it and try again.');
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
