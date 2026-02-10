/**
 * Deskly Website & Auth Server
 * 
 * Serves the deskly.in landing page and handles WorkOS OAuth
 * for the Deskly desktop app (Electron).
 * 
 * Auth flow:
 *   1. Desktop app opens https://deskly.in/auth/login?device_id=xxx
 *   2. Server redirects to WorkOS OAuth (Google, SSO, etc.)
 *   3. WorkOS redirects back to /auth/callback with ?code=xxx
 *   4. Server exchanges code for user info via WorkOS SDK
 *   5. Server creates a signed JWT and redirects to deskly://auth/callback?token=xxx
 *   6. Electron app handles the deep link, stores the token, shows the user as signed in
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { WorkOS } = require('@workos-inc/node');

const app = express();
const port = process.env.PORT || 4000;
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';
const desktopScheme = process.env.DESKTOP_SCHEME || 'deskly';

// WorkOS client (lazy init — only needed for auth routes)
let workos = null;
function getWorkOS() {
    if (!workos) {
        workos = new WorkOS({
            apiKey: process.env.WORKOS_API_KEY,
            clientId: process.env.WORKOS_CLIENT_ID,
        });
    }
    return workos;
}

app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ───────────────────────────────────────────────────────────────────

function signToken(user) {
    return jwt.sign(
        {
            sub: user.id,
            email: user.email,
            name: user.firstName
                ? `${user.firstName}${user.lastName ? ' ' + user.lastName : ''}`
                : user.email.split('@')[0],
            picture: user.profilePictureUrl || null,
        },
        jwtSecret,
        { expiresIn: '30d' }
    );
}

function verifyToken(token) {
    try {
        return jwt.verify(token, jwtSecret);
    } catch {
        return null;
    }
}

// ─── Landing Page ──────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'landing.html'));
});

// ─── Account Page (browser-based, for web visitors) ────────────────────────────

app.get('/account', (req, res) => {
    // If WorkOS is not configured, show a friendly page instead of crashing
    if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID) {
        return res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deskly — Account</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',-apple-system,system-ui,sans-serif;background:#09090b;color:#ededef;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}a{color:#818cf8;text-decoration:none}.wrap{max-width:380px}.wrap h1{font-size:1.5rem;font-weight:700;letter-spacing:-0.03em;margin-bottom:8px}.wrap p{font-size:0.88rem;color:#8b8b92;line-height:1.6;margin-bottom:24px}.btn{display:inline-flex;align-items:center;gap:8px;font-size:0.84rem;font-weight:500;padding:10px 20px;border-radius:9px;background:#fff;color:#09090b;transition:opacity 0.2s}.btn:hover{opacity:0.85}</style></head><body><div class="wrap"><h1>Account</h1><p>Sign in is available when the server is connected to WorkOS. For now, Deskly works entirely without an account.</p><a href="/" class="btn">← Back to home</a></div></body></html>`);
    }

    const token = req.cookies?.deskly_token;
    const user = token ? verifyToken(token) : null;

    if (!user) {
        // Not signed in — redirect to login (web mode, not desktop)
        return res.redirect('/auth/login?source=web');
    }

    res.send(accountPage(user));
});

// ─── Auth: Start Login ─────────────────────────────────────────────────────────

app.get('/auth/login', async (req, res, next) => {
    try {
        const { device_id, source } = req.query;

        // Store context in state so we get it back in the callback
        const state = JSON.stringify({
            device_id: device_id || null,
            source: source || 'desktop', // 'desktop' or 'web'
        });

        const authorizationUrl = getWorkOS().userManagement.getAuthorizationUrl({
            clientId: process.env.WORKOS_CLIENT_ID,
            redirectUri: `${baseUrl}/auth/callback`,
            provider: 'authkit',
            state,
        });

        res.redirect(authorizationUrl);
    } catch (err) {
        console.error('Error starting WorkOS auth:', err);
        next(err);
    }
});

// ─── Auth: OAuth Callback ──────────────────────────────────────────────────────

app.get('/auth/callback', async (req, res, next) => {
    try {
        const { code, state } = req.query;

        if (!code) {
            return res.status(400).send('Missing authorization code from WorkOS');
        }

        // Exchange code for user
        const { user } = await getWorkOS().userManagement.authenticateWithCode({
            clientId: process.env.WORKOS_CLIENT_ID,
            code: String(code),
        });

        // Create a signed JWT
        const token = signToken(user);

        // Parse state to figure out where to send the user
        let context = { source: 'desktop', device_id: null };
        try {
            if (state) context = JSON.parse(state);
        } catch { /* ignore */ }

        // Always set a cookie so the website can show signed-in state
        res.cookie('deskly_token', token, {
            httpOnly: true,
            secure: baseUrl.startsWith('https'),
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        });

        if (context.source === 'web') {
            // Web login — redirect to /account
            return res.redirect('/account');
        }

        // Desktop login — redirect to deep link so Electron picks it up
        const deepLink = `${desktopScheme}://auth/callback?token=${encodeURIComponent(token)}`;
        res.send(desktopCallbackPage(user, deepLink));
    } catch (err) {
        console.error('Error in WorkOS callback:', err);
        next(err);
    }
});

// ─── Auth: Sign Out ────────────────────────────────────────────────────────────

app.get('/auth/logout', (req, res) => {
    res.clearCookie('deskly_token');
    res.redirect('/');
});

// ─── API: Verify token (desktop app or website can call this) ──────────────────

app.get('/api/me', (req, res) => {
    const authHeader = req.headers.authorization;
    let token = null;

    // Prefer explicit Bearer token (desktop app, API clients)
    if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.slice(7);
    } else if (req.cookies?.deskly_token) {
        // Fallback to cookie (website)
        token = req.cookies.deskly_token;
    }

    if (!token) {
        return res.status(401).json({ error: 'Missing token' });
    }

    const user = verifyToken(token);
    if (!user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    res.json({ user });
});

// ─── HTML Templates ────────────────────────────────────────────────────────────

function desktopCallbackPage(user, deepLink) {
    const displayName = user.firstName
        ? `${user.firstName}${user.lastName ? ' ' + user.lastName : ''}`
        : user.email;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Signed In — Deskly</title>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background: #020617;
            color: #E8E6EB;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
        }
        .card {
            background: #0F1117;
            border: 1px solid rgba(148,163,184,0.15);
            border-radius: 20px;
            padding: 40px 32px;
            max-width: 440px;
            width: 100%;
            text-align: center;
        }
        .check { font-size: 48px; margin-bottom: 16px; }
        h1 { font-size: 1.5rem; margin-bottom: 8px; font-weight: 600; }
        .email { color: #818CF8; font-weight: 500; }
        .hint { color: #6b7280; margin: 16px 0 24px; line-height: 1.5; font-size: 0.9rem; }
        .btn {
            display: inline-block;
            padding: 12px 28px;
            border-radius: 999px;
            border: none;
            background: linear-gradient(135deg, #818CF8, #6366F1);
            color: white;
            font-weight: 600;
            font-size: 0.95rem;
            cursor: pointer;
            text-decoration: none;
        }
        .btn:hover { filter: brightness(1.08); }
        .manual { margin-top: 16px; font-size: 0.8rem; color: #4b5563; }
        .manual a { color: #818CF8; }
    </style>
</head>
<body>
    <div class="card">
        <div class="check">✓</div>
        <h1>Welcome, ${displayName}!</h1>
        <p class="email">${user.email}</p>
        <p class="hint">You're all set. Click below to return to the Deskly app.</p>
        <a href="${deepLink}" class="btn">Open Deskly App</a>
        <p class="manual">
            Button not working? <a href="${deepLink}">Click here</a> or copy this link:<br/>
            <code style="font-size:0.7rem;color:#6b7280;word-break:break-all;">${deepLink}</code>
        </p>
    </div>
    <script>
        // Auto-redirect to the deep link
        setTimeout(() => { window.location.href = "${deepLink}"; }, 1500);
    </script>
</body>
</html>`;
}

function accountPage(user) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Account — Deskly</title>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background: #020617;
            color: #E8E6EB;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
        }
        .card {
            background: #0F1117;
            border: 1px solid rgba(148,163,184,0.15);
            border-radius: 20px;
            padding: 40px 32px;
            max-width: 440px;
            width: 100%;
        }
        .avatar {
            width: 64px; height: 64px;
            border-radius: 50%;
            background: linear-gradient(135deg, #818CF8, #6366F1);
            display: flex; align-items: center; justify-content: center;
            font-size: 1.5rem; font-weight: 700; color: white;
            margin-bottom: 16px;
        }
        .avatar img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
        h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 4px; }
        .email { color: #A8A5B0; margin-bottom: 24px; }
        .info-row {
            display: flex; justify-content: space-between; align-items: center;
            padding: 12px 0;
            border-top: 1px solid rgba(148,163,184,0.1);
        }
        .info-label { color: #6b7280; font-size: 0.9rem; }
        .info-value { font-weight: 500; }
        .btn-logout {
            display: block; width: 100%; margin-top: 24px;
            padding: 12px 0; border-radius: 12px; border: 1px solid #EF4444;
            background: transparent; color: #EF4444; font-weight: 600;
            cursor: pointer; font-size: 0.95rem;
        }
        .btn-logout:hover { background: rgba(239,68,68,0.1); }
    </style>
</head>
<body>
    <div class="card">
        <div class="avatar">
            ${user.picture
                ? `<img src="${user.picture}" alt="avatar" />`
                : user.name?.charAt(0)?.toUpperCase() || '?'
            }
        </div>
        <h1>${user.name || 'Deskly User'}</h1>
        <p class="email">${user.email}</p>
        <div class="info-row">
            <span class="info-label">User ID</span>
            <span class="info-value" style="font-size:0.8rem;color:#6b7280;">${user.sub}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Auth Provider</span>
            <span class="info-value">WorkOS</span>
        </div>
        <form action="/auth/logout" method="get">
            <button type="submit" class="btn-logout">Sign Out</button>
        </form>
    </div>
</body>
</html>`;
}

// ─── Error handler ─────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send(`
        <div style="font-family:system-ui;background:#020617;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;">
            <div style="text-align:center;">
                <h1 style="color:#EF4444;">Something went wrong</h1>
                <p style="color:#6b7280;margin-top:8px;">${err.message || 'Unknown error'}</p>
                <a href="/" style="color:#818CF8;margin-top:16px;display:inline-block;">Go Home</a>
            </div>
        </div>
    `);
});

// ─── Start ─────────────────────────────────────────────────────────────────────

// Export for Vercel serverless deployment
module.exports = app;

// Start locally if run directly (not imported by Vercel)
if (require.main === module) {
    app.listen(port, () => {
        console.log(`Deskly website running at ${baseUrl} (port ${port})`);
    });
}
