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

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WorkOS } = require('@workos-inc/node');
const compression = require('compression');
const { PostHog } = require('posthog-node');

// ─── CSRF Token Store (in production, use Redis) ──────────────────────────────
const csrfTokenStore = new Map();

const app = express();

app.set('trust proxy', 1);
const port = process.env.PORT || 4000;
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
const isProduction = process.env.NODE_ENV === 'production';
const desktopScheme = process.env.DESKTOP_SCHEME || 'deskly';
const enablePerfMetrics = process.env.ENABLE_PERF_METRICS === 'true';
const desktopDownloadUrl = process.env.DESKTOP_DOWNLOAD_URL || 'ms-windows-store://pdp/?ProductId=9N3XS93TJ82Q';
const desktopUpdatesRepo = process.env.DESKTOP_UPDATES_REPO || 'ORG-BY-HITESH/deskly-updates';

function resolveCookieDomain(urlString) {
    try {
        const hostname = new URL(urlString).hostname.toLowerCase();
        if (!hostname || hostname === 'localhost') return null;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null;
        if (hostname.endsWith('.localhost')) return null;
        if (hostname.startsWith('www.')) return `.${hostname.slice(4)}`;
        return `.${hostname}`;
    } catch {
        return null;
    }
}

const authCookieDomain = resolveCookieDomain(baseUrl);
const authCookieBaseOptions = {
    httpOnly: true,
    secure: isProduction || process.env.FORCE_SECURE_COOKIES === 'true',
    sameSite: 'lax',
    path: '/',
};
if (authCookieDomain) {
    authCookieBaseOptions.domain = authCookieDomain;
}

const WEBSITE_POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || '';
const WEBSITE_POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const websiteAnalyticsEnabled = Boolean(WEBSITE_POSTHOG_API_KEY);
const websitePosthog = websiteAnalyticsEnabled
    ? new PostHog(WEBSITE_POSTHOG_API_KEY, {
        host: WEBSITE_POSTHOG_HOST,
        flushAt: 1,
        flushInterval: 10000,
    })
    : null;

const latestReleaseCache = {
    tag: null,
    fetchedAt: 0,
};

async function getLatestReleaseTag() {
    const now = Date.now();
    if (latestReleaseCache.tag && now - latestReleaseCache.fetchedAt < 5 * 60 * 1000) {
        return latestReleaseCache.tag;
    }

    const response = await fetch(`https://api.github.com/repos/${desktopUpdatesRepo}/releases/latest`, {
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Deskly-Website',
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch latest release tag: ${response.status}`);
    }

    const payload = await response.json();
    const tag = String(payload?.tag_name || '').trim();
    if (!tag) {
        throw new Error('Latest release tag missing from GitHub response.');
    }

    latestReleaseCache.tag = tag;
    latestReleaseCache.fetchedAt = now;
    return tag;
}

// ─── Validate Environment Variables ─────────────────────────────────────────────
const requiredEnv = ['JWT_SECRET'];
if (isProduction) {
    requiredEnv.push('WORKOS_API_KEY', 'WORKOS_CLIENT_ID');
    const missing = requiredEnv.filter(key => !process.env[key]);
    if (missing.length > 0) {
        console.error(`FATAL: Missing environment variables in production: ${missing.join(', ')}`);
        process.exit(1);
    }
}

const JWT_KEY = process.env.JWT_SECRET || 'dev-secret-change-me';

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

// ─── Security middleware ───────────────────────────────────────────────────────
const cspConnectSources = ["'self'"];
const cspScriptSources = ["'self'", "'unsafe-inline'"];
try {
    const analyticsHost = new URL(WEBSITE_POSTHOG_HOST).origin;
    cspConnectSources.push(analyticsHost);
    cspScriptSources.push(analyticsHost);
} catch (_) {
    // Keep strict default when host is invalid.
}

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: cspScriptSources,
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "https://cdn.simpleicons.org", "data:", "https:"],
            connectSrc: cspConnectSources,
        },
    },
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// ─── SEO: force a single canonical host + protocol ─────────────────────────────
// All canonical/og:url tags across the site point at the bare apex over https.
// Without this, www.deskly.in and http:// requests serve duplicate content on a
// different URL, splitting ranking signals between hosts. Redirect everything
// else to the canonical host with a permanent (301) redirect before any route
// or rate limiter runs, so crawlers only ever see one URL per page.
const CANONICAL_HOST = 'deskly.in';
if (isProduction) {
    app.use((req, res, next) => {
        const host = (req.headers.host || '').toLowerCase();
        const proto = req.headers['x-forwarded-proto'] || req.protocol;
        if (host && host !== CANONICAL_HOST) {
            return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
        }
        if (proto !== 'https') {
            return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
        }
        next();
    });
}

// Rate limiting on auth routes
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,                   // 20 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many auth requests. Please try again later.',
});

const accountLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,   // 5 minutes
    max: 30,                   // 30 requests per window
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,  // 1 minute
    max: 60,                   // 60 requests per window
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(cookieParser());
app.use(express.json({ limit: '32kb' }));

// ─── SEO: keep non-marketing routes out of the index ───────────────────────────
// robots.txt disallows crawling these paths, but an explicit X-Robots-Tag header
// also stops indexing of any URL that gets discovered via an external link.
const NOINDEX_PATH_PREFIXES = ['/account', '/auth/', '/api/', '/download/', '/.well-known/'];
app.use((req, res, next) => {
    if (NOINDEX_PATH_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    }
    next();
});

// ─── Performance Middleware ────────────────────────────────────────────────────

// Gzip compression for all responses
app.use(compression({ level: 6, threshold: 1024 }));

// Performance monitoring middleware
const performanceMetrics = {
    totalRequests: 0,
    totalResponseTime: 0,
    avgResponseTime: 0,
    minResponseTime: Infinity,
    maxResponseTime: 0,
    routes: {},
    startTime: Date.now(),
};

if (enablePerfMetrics) {
    app.use((req, res, next) => {
        const startTime = Date.now();
        const originalSend = res.send;

        res.send = function (data) {
            const responseTime = Date.now() - startTime;

            // Update metrics
            performanceMetrics.totalRequests++;
            performanceMetrics.totalResponseTime += responseTime;
            performanceMetrics.avgResponseTime = Math.round(performanceMetrics.totalResponseTime / performanceMetrics.totalRequests);
            performanceMetrics.minResponseTime = Math.min(performanceMetrics.minResponseTime, responseTime);
            performanceMetrics.maxResponseTime = Math.max(performanceMetrics.maxResponseTime, responseTime);

            // Track per-route metrics — cap map size to prevent memory growth from scanner/crawler paths
            const route = req.path;
            if (Object.keys(performanceMetrics.routes).length < 200 || performanceMetrics.routes[route]) {
                if (!performanceMetrics.routes[route]) {
                    performanceMetrics.routes[route] = { count: 0, totalTime: 0, avgTime: 0 };
                }
                performanceMetrics.routes[route].count++;
                performanceMetrics.routes[route].totalTime += responseTime;
                performanceMetrics.routes[route].avgTime = Math.round(performanceMetrics.routes[route].totalTime / performanceMetrics.routes[route].count);
            }

            // Add performance headers
            res.set('Server-Timing', `total;dur=${responseTime}`);
            res.set('X-Response-Time', `${responseTime}ms`);

            return originalSend.call(this, data);
        };

        next();
    });
}

// Static file serving with aggressive caching
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d',
    etag: true,
    setHeaders: (res, path) => {
        // Cache static assets for 1 day
        if (path.endsWith('.js') || path.endsWith('.css') || path.endsWith('.woff2') || path.endsWith('.woff')) {
            res.set('Cache-Control', 'public, max-age=86400, immutable');
        }
        // Cache images for 7 days — no immutable since filenames aren't content-hashed
        else if (path.match(/\.(jpg|jpeg|png|gif|svg|webp)$/)) {
            res.set('Cache-Control', 'public, max-age=604800');
        }
        // HTML and JSON: no caching, must revalidate
        else if (path.endsWith('.html') || path.endsWith('.json')) {
            res.set('Cache-Control', 'public, max-age=3600, must-revalidate');
        }
    },
}));

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Escape HTML entities to prevent XSS in template strings */
function esc(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Safely embeds a JS value inside an inline <script> block: JSON-encodes it,
// then neutralizes "</" so the value can never prematurely close the tag.
function toScriptJSON(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Validate input parameters */
function validateDeviceId(deviceId) {
    return typeof deviceId === 'string' && /^[a-z0-9_-]{1,64}$/i.test(deviceId);
}

function validateSource(source) {
    return ['web', 'desktop'].includes(source);
}

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
        JWT_KEY,
        { expiresIn: '30d' }
    );
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_KEY);
    } catch {
        return null;
    }
}

const WEBSITE_EVENT_ALLOWLIST = new Set([
    'web.landing.viewed',
    'web.section.viewed',
    'web.nav.opened',
    'web.nav.closed',
    'web.nav.link_clicked',
    'web.cta.clicked',
    'web.download.requested',
    'web.account.page_opened',
]);

function sanitizeAnalyticsProperties(properties = {}) {
    const result = {};
    if (!properties || typeof properties !== 'object') return result;

    const entries = Object.entries(properties).slice(0, 30);
    for (const [key, value] of entries) {
        if (!/^[a-z0-9_]+$/i.test(key)) continue;

        if (typeof value === 'string') {
            result[key] = value.slice(0, 200);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            result[key] = value;
        }
    }

    return result;
}

function trackWebsiteEvent(eventName, distinctId, properties = {}) {
    if (!websitePosthog || !websiteAnalyticsEnabled) return;
    if (!WEBSITE_EVENT_ALLOWLIST.has(eventName)) return;
    if (!distinctId || typeof distinctId !== 'string') return;

    websitePosthog.capture({
        distinctId: distinctId.slice(0, 128),
        event: eventName,
        properties: {
            ...sanitizeAnalyticsProperties(properties),
            source: 'website',
            environment: process.env.NODE_ENV || 'development',
        },
    });
}

// ─── Landing Page ──────────────────────────────────────────────────────────────
// --- Navigation Routes ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'landing.html'));
});

app.get('/windows-screen-time-tracker', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'windows-screen-time-tracker.html'));
});

app.get('/digital-wellbeing-windows', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'digital-wellbeing-windows.html'));
});

app.get('/windows-app-usage-tracker', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'windows-app-usage-tracker.html'));
});

app.get('/windows-app-and-website-limits', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'windows-app-and-website-limits.html'));
});

app.get('/focus-app-for-windows', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'focus-app-for-windows.html'));
});

app.get('/app-blocker-for-windows', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'app-blocker-for-windows.html'));
});

app.get('/solutions', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'solutions.html'));
});

app.get('/screen-time-timeline-windows', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'screen-time-timeline-windows.html'));
});

app.get('/desktop-widgets-for-windows', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'desktop-widgets-for-windows.html'));
});

app.get('/features', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'features.html'));
});

app.get('/how-it-works', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'how-it-works.html'));
});

app.get('/security', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'security.html'));
});

app.get('/blog', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'blog.html'));
});

app.get('/blog/reduce-screen-time-windows', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'blog', 'reduce-screen-time-windows.html'));
});

app.get('/blog/digital-wellbeing-guide', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'blog', 'digital-wellbeing-guide.html'));
});

app.get('/blog/block-distracting-apps-windows', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'blog', 'block-distracting-apps-windows.html'));
});

app.get('/deskly-vs-rescuetime', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'deskly-vs-rescuetime.html'));
});

app.get('/deskly-vs-cold-turkey', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'deskly-vs-cold-turkey.html'));
});

app.get('/deskly-vs-freedom', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'deskly-vs-freedom.html'));
});

// Common intent phrase aliases redirected to canonical keyword landing pages.
app.get('/screen-time-for-windows', (req, res) => {
    res.redirect(301, '/windows-screen-time-tracker');
});

app.get('/windows-digital-wellbeing', (req, res) => {
    res.redirect(301, '/digital-wellbeing-windows');
});

app.get('/app-usage-tracker-windows', (req, res) => {
    res.redirect(301, '/windows-app-usage-tracker');
});

app.get('/windows-app-limits', (req, res) => {
    res.redirect(301, '/windows-app-and-website-limits');
});

app.get('/windows-focus-app', (req, res) => {
    res.redirect(301, '/focus-app-for-windows');
});

app.get('/windows-app-blocker', (req, res) => {
    res.redirect(301, '/app-blocker-for-windows');
});

app.get('/app-lock-for-windows', (req, res) => {
    res.redirect(301, '/app-blocker-for-windows');
});

app.get('/windows-timeline-app', (req, res) => {
    res.redirect(301, '/screen-time-timeline-windows');
});

app.get('/windows-desktop-widgets', (req, res) => {
    res.redirect(301, '/desktop-widgets-for-windows');
});

app.get('/rescuetime-alternative', (req, res) => {
    res.redirect(301, '/deskly-vs-rescuetime');
});

app.get('/rescuetime-alternative-windows', (req, res) => {
    res.redirect(301, '/deskly-vs-rescuetime');
});

app.get('/cold-turkey-alternative', (req, res) => {
    res.redirect(301, '/deskly-vs-cold-turkey');
});

app.get('/cold-turkey-blocker-alternative', (req, res) => {
    res.redirect(301, '/deskly-vs-cold-turkey');
});

app.get('/freedom-app-alternative', (req, res) => {
    res.redirect(301, '/deskly-vs-freedom');
});

app.get('/freedom-alternative-windows', (req, res) => {
    res.redirect(301, '/deskly-vs-freedom');
});

// Privacy Policy Route
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'privacy.html'));
});

// Terms of Conditions Route
app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'terms.html'));
});

app.get('/download/windows', apiLimiter, (req, res) => {
    const ctaSource = typeof req.query.source === 'string' ? req.query.source.slice(0, 60) : 'unknown';
    const distinctId = typeof req.query.aid === 'string' && req.query.aid.trim()
        ? req.query.aid.trim()
        : `web_${req.ip || 'unknown'}`;

    trackWebsiteEvent('web.download.requested', distinctId, {
        cta_source: ctaSource,
        target: 'windows_installer',
    });

    return res.redirect(302, desktopDownloadUrl);
});

// App Dashboard Route (Requires auth)owser-based, for web visitors) ────────────────────────────

app.get('/account', accountLimiter, (req, res) => {
    // If WorkOS is not configured, show a friendly page instead of crashing
    if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID) {
        return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Deskly — Account</title>
    <link rel="stylesheet" href="/styles/auth.css" />
</head>
<body class="auth-page">
    <div class="auth-card centered">
        <h1 class="auth-title">Account</h1>
        <p class="auth-hint">Sign in is available when the server is connected to WorkOS. For now, Deskly works entirely without an account.</p>
        <a href="/" class="auth-btn">Back to home</a>
    </div>
</body>
</html>`);
    }

    const token = req.cookies?.deskly_token;
    const user = token ? verifyToken(token) : null;

    if (!user) {
        // Not signed in — redirect to login (web mode, not desktop)
        return res.redirect('/auth/login?source=web');
    }

    trackWebsiteEvent('web.account.page_opened', `account_${user.sub}`, {
        source: 'account_page',
    });

    res.send(accountPage(user));
});

// ─── Auth: Start Login ─────────────────────────────────────────────────────────

app.get('/auth/login', authLimiter, async (req, res, next) => {
    try {
        let { device_id, source } = req.query;

        // Input validation FIRST (before WorkOS check)
        if (device_id && !validateDeviceId(device_id)) {
            return res.status(400).send('Invalid device_id format');
        }
        if (source && !validateSource(source)) {
            return res.status(400).send('Invalid source value');
        }

        // NOW check if WorkOS is configured
        if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID) {
            return res.status(503).send('Authentication service is not configured. Please try again later.');
        }

        device_id = device_id || null;
        source = source || 'desktop';

        // CSRF-safe OAuth state: random nonce stored in a short-lived cookie
        const nonce = crypto.randomBytes(24).toString('base64url');
        const statePayload = {
            n: nonce,
            device_id,
            source,
        };
        // Encode state as base64url to prevent tampering
        const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');

        // Store nonce in a short-lived cookie to verify on callback
        res.cookie('oauth_nonce', nonce, {
            ...authCookieBaseOptions,
            maxAge: 10 * 60 * 1000, // 10 minutes — plenty for OAuth round-trip
            path: '/auth/callback',
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

app.get('/auth/callback', authLimiter, async (req, res, next) => {
    try {
        const { code, state } = req.query;

        if (!code) {
            return res.status(400).send('Missing authorization code from WorkOS');
        }

        // Verify CSRF nonce from the state matches the cookie
        let context = { source: 'desktop', device_id: null };
        try {
            if (state) {
                // Decode base64url state
                const decoded = Buffer.from(state, 'base64url').toString('utf-8');
                const parsed = JSON.parse(decoded);
                const savedNonce = req.cookies?.oauth_nonce;
                if (!savedNonce || parsed.n !== savedNonce) {
                    return res.status(403).send('OAuth state mismatch — possible CSRF. Please try signing in again.');
                }
                context = { source: parsed.source || 'desktop', device_id: parsed.device_id || null };
            }
        } catch (err) {
            console.error('State parsing error:', err);
            return res.status(400).send('Invalid OAuth state');
        }

        // Clear the one-time nonce cookie
        res.clearCookie('oauth_nonce', {
            ...authCookieBaseOptions,
            path: '/auth/callback',
        });

        // Exchange code for user
        const { user } = await getWorkOS().userManagement.authenticateWithCode({
            clientId: process.env.WORKOS_CLIENT_ID,
            code: String(code),
        });

        // Create a signed JWT
        const token = signToken(user);

        // Always set a cookie so the website can show signed-in state
        // Cookie expires slightly before JWT (25 days < 30 day JWT expiry)
        res.cookie('deskly_token', token, {
            ...authCookieBaseOptions,
            maxAge: 25 * 24 * 60 * 60 * 1000, // 25 days (before JWT expiry)
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

app.post('/auth/logout', (req, res) => {
    res.clearCookie('deskly_token', authCookieBaseOptions);
    res.clearCookie('deskly_session', {
        ...authCookieBaseOptions,
        httpOnly: false,
    });
    return res.redirect('/');
});

// Keep GET as a fallback so direct links / bookmarked logouts still work
app.get('/auth/logout', (req, res) => {
    res.clearCookie('deskly_token', authCookieBaseOptions);
    res.redirect('/');
});

// ─── API: Verify token (desktop app or website can call this) ──────────────────

app.get('/api/me', apiLimiter, (req, res) => {
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

app.get('/api/release-version', apiLimiter, async (req, res) => {
    try {
        const tag = await getLatestReleaseTag();
        res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
        return res.json({ tag });
    } catch (error) {
        console.error('Failed to resolve latest release version:', error);
        return res.status(503).json({ error: 'Release version unavailable' });
    }
});

// ─── HTML Templates ────────────────────────────────────────────────────────────

function desktopCallbackPage(user, deepLink) {
    const displayName = user.firstName
        ? `${user.firstName}${user.lastName ? ' ' + user.lastName : ''}`
        : user.email;
    const safeDeepLink = esc(deepLink);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Signed In — Deskly</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: "Inter", system-ui, -apple-system, sans-serif;
            background: #09090b;
            color: #ededef;
            min-height: 100vh;
        }
        :root {
            --aurora-bg: #000000;
            --aurora-transparent: rgba(0,0,0,0);
            --aurora-1: #3b82f6;
            --aurora-2: #a5b4fc;
            --aurora-3: #93c5fd;
            --aurora-4: #ddd6fe;
            --aurora-5: #60a5fa;
        }
        .aurora-container {
            position: fixed;
            inset: 0;
            overflow: hidden;
            pointer-events: none;
            z-index: 0;
        }
        .aurora-effect {
            --dark-gradient: repeating-linear-gradient(100deg,
                var(--aurora-bg) 0%, var(--aurora-bg) 7%,
                var(--aurora-transparent) 10%, var(--aurora-transparent) 12%,
                var(--aurora-bg) 16%);
            --aurora-gradient: repeating-linear-gradient(100deg,
                var(--aurora-1) 10%, var(--aurora-2) 15%,
                var(--aurora-3) 20%, var(--aurora-4) 25%,
                var(--aurora-5) 30%);
            position: absolute;
            top: -10px; right: -10px; bottom: -10px; left: -10px;
            background-image: var(--dark-gradient), var(--aurora-gradient);
            background-size: 300% 200%;
            background-position: 50% 50%, 50% 50%;
            filter: blur(10px);
            opacity: 0.5;
            transform: translateZ(0);
            will-change: transform;
            mask-image: radial-gradient(ellipse at 100% 0%, black 10%, transparent 70%);
            -webkit-mask-image: radial-gradient(ellipse at 100% 0%, black 10%, transparent 70%);
        }
        .aurora-effect::after {
            content: '';
            position: absolute;
            inset: 0;
            background-image: var(--dark-gradient), var(--aurora-gradient);
            background-size: 200% 100%;
            mix-blend-mode: difference;
            animation: aurora-move 60s linear infinite;
        }
        @keyframes aurora-move {
            from { background-position: 50% 50%, 50% 50%; }
            to   { background-position: 350% 50%, 350% 50%; }
        }
        .topnav {
            position: sticky;
            top: 0;
            width: 100%;
            height: 56px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 24px;
            background: rgba(9,9,11,0.82);
            backdrop-filter: blur(14px);
            -webkit-backdrop-filter: blur(14px);
            border-bottom: 1px solid rgba(255,255,255,0.06);
            z-index: 50;
        }
        .topnav-brand {
            display: flex;
            align-items: center;
            gap: 8px;
            text-decoration: none;
            color: #fff;
            font-weight: 700;
            font-size: 0.95rem;
            letter-spacing: -0.01em;
        }
        .topnav-brand-text { white-space: nowrap; }
        .topnav-brand-icon {
            width: 26px;
            height: 26px;
            flex-shrink: 0;
            border-radius: 7px;
            overflow: hidden;
            display: block;
        }
        .topnav-brand-icon svg,
        .topnav-brand-icon img {
            width: 26px;
            height: 26px;
            display: block;
        }
        .topnav-back {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 0.82rem;
            font-weight: 500;
            color: #9ca3af;
            text-decoration: none;
            transition: color 0.15s;
        }
        .topnav-back-text { white-space: nowrap; }
        .topnav-back:hover { color: #ededef; }
        .topnav-back svg { width: 13px; height: 13px; flex-shrink: 0; }
        .page-body {
            position: relative;
            z-index: 10;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: calc(100vh - 56px);
            padding: 32px 20px;
        }
        .card {
            background: rgba(15,15,18,0.88);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.09);
            border-radius: 20px;
            padding: 40px 32px 32px;
            width: 100%;
            max-width: 420px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(61,107,234,0.07);
        }

        .cb-check {
            width: 64px;
            height: 64px;
            border-radius: 50%;
            border: 1px solid rgba(255,255,255,0.12);
            background: rgba(255,255,255,0.03);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 2rem;
            margin: 0 auto 16px;
        }
        .cb-title {
            font-size: 1.9rem;
            font-weight: 700;
            letter-spacing: -0.02em;
            margin-bottom: 6px;
            text-align: center;
        }
        .cb-email {
            color: #3d6bea;
            font-size: 0.95rem;
            font-weight: 500;
            text-align: center;
            margin-bottom: 16px;
            word-break: break-word;
        }
        .cb-hint {
            color: #9ca3af;
            text-align: center;
            font-size: 0.94rem;
            margin-bottom: 20px;
            line-height: 1.5;
        }
        .cb-cta-row {
            display: flex;
            gap: 10px;
            justify-content: center;
            margin-bottom: 14px;
        }
        .cb-btn {
            display: inline-block;
            padding: 11px 18px;
            border-radius: 10px;
            border: 1px solid transparent;
            background: #fff;
            color: #09090b;
            font-weight: 600;
            font-size: 0.92rem;
            text-decoration: none;
            cursor: pointer;
            font-family: inherit;
            transition: opacity 0.15s, background 0.15s;
        }
        .cb-btn:hover { opacity: 0.85; }
        .cb-btn.secondary {
            background: rgba(255,255,255,0.06);
            color: #ededef;
            border-color: rgba(255,255,255,0.14);
        }
        .cb-btn.secondary:hover {
            opacity: 1;
            background: rgba(255,255,255,0.1);
        }
        .cb-manual {
            text-align: center;
            font-size: 0.82rem;
            color: #6b7280;
            line-height: 1.5;
            margin-bottom: 10px;
        }
        .cb-manual a { color: #3d6bea; }
        .cb-details {
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 10px;
            background: rgba(255,255,255,0.02);
            padding: 10px 12px;
        }
        .cb-details summary {
            cursor: pointer;
            user-select: none;
            color: #9ca3af;
            font-size: 0.9rem;
            text-align: center;
        }
        .cb-details code {
            display: block;
            margin-top: 8px;
            padding: 8px;
            border-radius: 8px;
            border: 1px solid rgba(255,255,255,0.07);
            background: rgba(0,0,0,0.35);
            color: #8d96a8;
            font-size: 0.73rem;
            word-break: break-all;
            max-height: 140px;
            overflow: auto;
        }

        @media (max-width: 768px) {
            .topnav {
                height: 52px;
                padding: 0 14px;
            }
            .topnav-brand { font-size: 0.9rem; }
            .topnav-back { font-size: 0.78rem; gap: 4px; }
            .page-body {
                min-height: calc(100vh - 52px);
                padding: 18px 12px;
            }
            .card {
                border-radius: 16px;
                padding: 24px 16px 18px;
                max-width: 100%;
            }
            .cb-title { font-size: 1.5rem; }
            .cb-cta-row { flex-direction: column; }
            .cb-btn { width: 100%; text-align: center; }
        }

        @media (max-width: 480px) {
            .topnav {
                padding: 0 10px;
            }
            .topnav-brand-icon,
            .topnav-brand-icon svg,
            .topnav-brand-icon img {
                width: 22px;
                height: 22px;
            }
            .topnav-brand {
                font-size: 0.86rem;
                gap: 6px;
            }
            .topnav-back-text { display: none; }
            .topnav-back svg {
                width: 16px;
                height: 16px;
            }
            .page-body { padding: 14px 10px; }
            .card { padding: 18px 12px 14px; }
        }
    </style>
</head>
<body>
    <div class="aurora-container">
        <div class="aurora-effect"></div>
    </div>

    <nav class="topnav">
        <a href="/" class="topnav-brand" title="Deskly home" aria-label="Deskly home">
            <span class="topnav-brand-icon" aria-hidden="true">
                <img src="/assets/icon.svg" alt="" width="26" height="26" />
            </span>
            <span class="topnav-brand-text">Deskly</span>
        </a>

        <a href="/" class="topnav-back" title="Back to home" aria-label="Back to home">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"/>
            </svg>
            <span class="topnav-back-text">Back to home</span>
        </a>
    </nav>

    <div class="page-body">
        <div class="card">
            <div class="cb-check">✓</div>
            <div class="cb-title">Welcome, ${esc(displayName)}!</div>
            <div class="cb-email">${esc(user.email)}</div>
            <p class="cb-hint">You're all set. Click below to return to the Deskly app.</p>

            <div class="cb-cta-row">
                <a href="${safeDeepLink}" class="cb-btn">Open Deskly App</a>
                <button type="button" class="cb-btn secondary" id="copy-link-btn">Copy Link</button>
            </div>

            <p class="cb-manual">
                If your browser blocks the app prompt, use <a href="${safeDeepLink}">this direct link</a>.
            </p>

            <details class="cb-details">
                <summary>Show manual link</summary>
                <code>${safeDeepLink}</code>
            </details>
        </div>
    </div>
    <script>
        // Auto-redirect to the deep link
        setTimeout(() => { window.location.href = "${safeDeepLink}"; }, 1500);

        const copyBtn = document.getElementById('copy-link-btn');
        const deepLink = ${JSON.stringify(deepLink)};

        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(deepLink);
                    copyBtn.textContent = 'Copied';
                    setTimeout(() => { copyBtn.textContent = 'Copy Link'; }, 1400);
                } catch {
                    copyBtn.textContent = 'Copy failed';
                    setTimeout(() => { copyBtn.textContent = 'Copy Link'; }, 1600);
                }
            });
        }
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
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: "Inter", system-ui, -apple-system, sans-serif;
            background: #09090b;
            color: #ededef;
            min-height: 100vh;
        }
        /* ── Aurora (exact copy from Deskly setup wizard) ── */
        :root {
            --aurora-bg: #000000;
            --aurora-transparent: rgba(0,0,0,0);
            --aurora-1: #3b82f6;
            --aurora-2: #a5b4fc;
            --aurora-3: #93c5fd;
            --aurora-4: #ddd6fe;
            --aurora-5: #60a5fa;
        }
        .aurora-container {
            position: fixed;
            inset: 0;
            overflow: hidden;
            pointer-events: none;
            z-index: 0;
        }
        .aurora-effect {
            --dark-gradient: repeating-linear-gradient(100deg,
                var(--aurora-bg) 0%, var(--aurora-bg) 7%,
                var(--aurora-transparent) 10%, var(--aurora-transparent) 12%,
                var(--aurora-bg) 16%);
            --aurora-gradient: repeating-linear-gradient(100deg,
                var(--aurora-1) 10%, var(--aurora-2) 15%,
                var(--aurora-3) 20%, var(--aurora-4) 25%,
                var(--aurora-5) 30%);
            position: absolute;
            top: -10px; right: -10px; bottom: -10px; left: -10px;
            background-image: var(--dark-gradient), var(--aurora-gradient);
            background-size: 300% 200%;
            background-position: 50% 50%, 50% 50%;
            filter: blur(10px);
            opacity: 0.5;
            transform: translateZ(0);
            will-change: transform;
            mask-image: radial-gradient(ellipse at 100% 0%, black 10%, transparent 70%);
            -webkit-mask-image: radial-gradient(ellipse at 100% 0%, black 10%, transparent 70%);
        }
        .aurora-effect::after {
            content: '';
            position: absolute;
            inset: 0;
            background-image: var(--dark-gradient), var(--aurora-gradient);
            background-size: 200% 100%;
            mix-blend-mode: difference;
            animation: aurora-move 60s linear infinite;
        }
        @keyframes aurora-move {
            from { background-position: 50% 50%, 50% 50%; }
            to   { background-position: 350% 50%, 350% 50%; }
        }
        /* Top nav */
        .topnav {
            position: sticky;
            top: 0;
            width: 100%;
            height: 56px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 24px;
            background: rgba(9,9,11,0.82);
            backdrop-filter: blur(14px);
            -webkit-backdrop-filter: blur(14px);
            border-bottom: 1px solid rgba(255,255,255,0.06);
            z-index: 50;
        }
        .topnav-brand {
            display: flex;
            align-items: center;
            gap: 8px;
            text-decoration: none;
            color: #fff;
            font-weight: 700;
            font-size: 0.95rem;
            letter-spacing: -0.01em;
        }
        .topnav-brand-text { white-space: nowrap; }
        .topnav-brand-icon {
            width: 26px;
            height: 26px;
            flex-shrink: 0;
            border-radius: 7px;
            overflow: hidden;
            display: block;
        }
        .topnav-brand-icon svg,
        .topnav-brand-icon img {
            width: 26px;
            height: 26px;
            display: block;
        }
        .topnav-back {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 0.82rem;
            font-weight: 500;
            color: #9ca3af;
            text-decoration: none;
            transition: color 0.15s;
        }
        .topnav-back-text { white-space: nowrap; }
        .topnav-back:hover { color: #ededef; }
        .topnav-back svg { width: 13px; height: 13px; flex-shrink: 0; }
        /* Main content */
        .page-body {
            position: relative;
            z-index: 10;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: calc(100vh - 56px);
            padding: 32px 20px;
        }
        /* Card */
        .card {
            background: rgba(15,15,18,0.88);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.09);
            border-radius: 20px;
            padding: 40px 32px 32px;
            width: 100%;
            max-width: 420px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(61,107,234,0.07);
        }
        .avatar {
            width: 64px;
            height: 64px;
            border-radius: 50%;
            background: linear-gradient(135deg, #3d6bea, #4873f1);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.5rem;
            font-weight: 700;
            color: #fff;
            margin-bottom: 16px;
            overflow: hidden;
        }
        .avatar img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
        .uname { font-size: 1.35rem; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 4px; }
        .uemail { color: #9ca3af; font-size: 0.9rem; margin-bottom: 24px; }
        .row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 11px 0;
            border-top: 1px solid rgba(255,255,255,0.07);
            font-size: 0.88rem;
        }
        .row-label { color: #8a93a5; }
        .row-val { font-weight: 500; }
        .row-val.small { font-size: 0.78rem; color: #6b7280; max-width: 220px; text-align: right; word-break: break-all; }
        /* Download section */
        .dl-section {
            margin-top: 22px;
            padding-top: 20px;
            border-top: 1px solid rgba(255,255,255,0.07);
            text-align: center;
        }
        .dl-hint { font-size: 0.82rem; color: #6b7280; margin-bottom: 12px; }
        .dl-btn {
            display: inline-block;
            padding: 11px 22px;
            border-radius: 10px;
            background: #fff;
            color: #09090b;
            font-weight: 600;
            font-size: 0.88rem;
            text-decoration: none;
            transition: opacity 0.15s;
        }
        .dl-btn:hover { opacity: 0.85; }
        /* Sign out */
        .signout-form { margin-top: 20px; }
        .signout-btn {
            display: block;
            width: 100%;
            padding: 12px 0;
            border-radius: 12px;
            border: 1px solid #ef4444;
            background: transparent;
            color: #ef4444;
            font-weight: 600;
            font-size: 0.9rem;
            cursor: pointer;
            font-family: inherit;
            transition: background 0.15s;
        }
        .signout-btn:hover { background: rgba(239,68,68,0.1); }

        /* Mobile optimization */
        @media (max-width: 768px) {
            .topnav {
                height: 52px;
                padding: 0 14px;
            }

            .topnav-brand {
                font-size: 0.9rem;
            }

            .topnav-back {
                font-size: 0.78rem;
                gap: 4px;
            }

            .page-body {
                min-height: calc(100vh - 52px);
                padding: 18px 12px;
            }

            .card {
                border-radius: 16px;
                padding: 24px 16px 18px;
                max-width: 100%;
            }

            .avatar {
                width: 56px;
                height: 56px;
                margin-bottom: 12px;
            }

            .uname {
                font-size: 1.15rem;
            }

            .uemail {
                font-size: 0.85rem;
                margin-bottom: 18px;
                word-break: break-word;
            }

            .row {
                align-items: flex-start;
                gap: 8px;
            }

            .row-val.small {
                max-width: 62%;
                font-size: 0.75rem;
            }

            .dl-btn {
                width: 100%;
                text-align: center;
            }
        }

        @media (max-width: 480px) {
            .topnav {
                padding: 0 10px;
            }

            .topnav-brand-icon,
            .topnav-brand-icon svg,
            .topnav-brand-icon img {
                width: 22px;
                height: 22px;
            }

            .topnav-brand {
                font-size: 0.86rem;
                gap: 6px;
            }

            .topnav-back-text {
                display: none;
            }

            .topnav-back svg {
                width: 16px;
                height: 16px;
            }

            .page-body {
                padding: 14px 10px;
            }

            .card {
                padding: 18px 12px 14px;
            }

            .row {
                flex-direction: column;
                gap: 6px;
            }

            .row-val,
            .row-val.small {
                max-width: 100%;
                text-align: left;
            }
        }
    </style>
</head>
<body>
    <!-- Aurora background (exact setup wizard copy) -->
    <div class="aurora-container">
        <div class="aurora-effect"></div>
    </div>

    <nav class="topnav">
        <a href="/" class="topnav-brand">
            <span class="topnav-brand-icon">
                <img src="/assets/icon.svg" alt="" width="26" height="26" />
            </span>
            <span class="topnav-brand-text">Deskly</span>
        </a>
        <a href="/" class="topnav-back" title="Back to home" aria-label="Back to home">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"/>
            </svg>
            <span class="topnav-back-text">Back to home</span>
        </a>
    </nav>

    <div class="page-body">
        <div class="card">
            <div class="avatar">
                ${user.picture
                    ? `<img src="${esc(user.picture)}" alt="avatar" />`
                    : esc(user.name?.charAt(0)?.toUpperCase() || '?')
                }
            </div>
            <div class="uname">${esc(user.name || 'Deskly User')}</div>
            <div class="uemail">${esc(user.email)}</div>
            <div class="row">
                <span class="row-label">User ID</span>
                <span class="row-val small">${esc(user.sub)}</span>
            </div>
            <div class="row">
                <span class="row-label">Auth Provider</span>
                <span class="row-val">WorkOS</span>
            </div>
            <div class="dl-section">
                <p class="dl-hint">Don't have the app yet?</p>
                <a href="/download/windows" class="dl-btn">Download Deskly for Windows</a>
            </div>
            <form class="signout-form" action="/auth/logout" method="post">
                <button type="submit" class="signout-btn">Sign Out</button>
            </form>
        </div>
    </div>
    <script src="/js/analytics.js"></script>
    <script>
        posthog.identify(
            ${toScriptJSON(`account_${user.sub}`)},
            ${toScriptJSON({ email: user.email, has_name: Boolean(user.name) })}
        );
    </script>
</body>
</html>`;
}

function statusPage({ title, message, code = null, danger = false }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${esc(title)} — Deskly</title>
    <link rel="stylesheet" href="/styles/auth.css" />
</head>
<body class="status-page">
    <div class="status-card">
        ${code ? `<h1 class="status-code">${esc(code)}</h1>` : ''}
        <h2 class="status-title${danger ? ' danger' : ''}">${esc(title)}</h2>
        <p class="status-message">${esc(message)}</p>
        <a href="/" class="status-link">Back to Deskly</a>
    </div>
</body>
</html>`;
}

// ─── 404 handler ───────────────────────────────────────────────────────────────

// ─── Performance Metrics Endpoint (protected) ─────────────────────────────────

app.get('/.well-known/metrics', (req, res) => {
    // Require a secret token so this endpoint isn't publicly accessible
    const secret = process.env.METRICS_SECRET;
    if (secret && req.headers['x-metrics-secret'] !== secret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const uptime = Date.now() - performanceMetrics.startTime;
    const uptimeHours = (uptime / (1000 * 60 * 60)).toFixed(2);

    res.json({
        status: 'healthy',
        uptime: `${uptimeHours}h`,
        timestamp: new Date().toISOString(),
        requests: {
            total: performanceMetrics.totalRequests,
            avgResponseTime: performanceMetrics.avgResponseTime,
            minResponseTime: performanceMetrics.minResponseTime === Infinity ? 0 : performanceMetrics.minResponseTime,
            maxResponseTime: performanceMetrics.maxResponseTime,
        },
        routes: performanceMetrics.routes,
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            limit: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
            unit: 'MB',
        },
    });
});

// ─── Health Check Endpoint ────────────────────────────────────────────────────

app.get('/.well-known/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
    });
});

// ─── Test Endpoint (dev only) ────────────────────────────────────────────────

if (!isProduction) {
    app.get('/test', (req, res) => {
        res.json({ test: 'works' });
    });
}

// ─── 404 Handler ────────────────────────────────────────────────────────────────

app.use((req, res) => {
    res.status(404).send(statusPage({
        title: 'Not Found',
        message: 'This page does not exist. It may have moved or the URL may be incorrect.',
        code: '404',
    }));
});
// ─── Error handler ─────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
    console.error(err);
    // Never leak internal error details to the client
    const safeMessage = isProduction
        ? 'An unexpected error occurred. Please try again later.'
        : (err.message || 'Unknown error');
    res.status(500).send(statusPage({
        title: 'Something went wrong',
        message: safeMessage,
        danger: true,
    }));
});

// ─── Start ─────────────────────────────────────────────────────────────────────

// Export for Vercel serverless deployment
module.exports = app;

async function flushWebsiteAnalytics() {
    if (!websitePosthog) return;
    try {
        await websitePosthog._shutdown(2000);
    } catch (_) {
        // Ignore flush failures on shutdown.
    }
}

process.on('SIGTERM', () => {
    flushWebsiteAnalytics().finally(() => process.exit(0));
});

process.on('SIGINT', () => {
    flushWebsiteAnalytics().finally(() => process.exit(0));
});

// Start locally if run directly (not imported by Vercel)
if (require.main === module) {
    app.listen(port, () => {
        console.log(`Deskly website running at ${baseUrl} (port ${port})`);
    });
}
