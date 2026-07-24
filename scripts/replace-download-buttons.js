const fs = require('fs');
const path = require('path');

const viewsDir = 'C:\\Users\\hites\\Desktop\\digitalwellbeing-final-deskly-work\\digitalwellbeing-final-deskly-work\\website\\deskly-website\\views';

const badgeScriptTag = '<script type="module" src="https://get.microsoft.com/badge/ms-store-badge.bundled.js"></script>';

const msStoreBadgeComponent = `<ms-store-badge
    productid="9N3XS93TJ82Q"
    productname="Deskly - Screen Time, App Lock, Widgets & More"
    window-mode="direct"
    theme="auto"
    size="large"
    language="en-us"
    animation="on">
</ms-store-badge>`;

function processFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;

    // 1. Ensure the ms-store-badge script is present in the <head>
    if (!content.includes('ms-store-badge.bundled.js')) {
        if (content.includes('</head>')) {
            content = content.replace('</head>', `    ${badgeScriptTag}\n</head>`);
        } else if (content.includes('<head>')) {
            content = content.replace('<head>', `<head>\n    ${badgeScriptTag}`);
        }
    }

    // 2. Replace primary CTA buttons (either class="ms-store-badge" or class="btn btn-primary" with download link)
    // Match <a ... class="ms-store-badge" ...> ... </a>
    const badgeAnchorRegex = /<a\s+[^>]*class="ms-store-badge"[^>]*>[\s\S]*?<\/a>/gi;
    content = content.replace(badgeAnchorRegex, msStoreBadgeComponent);

    // Also match any leftover <a ... href="/download/windows?source=..." class="btn btn-primary" ...> ... </a>
    const primaryBtnRegex = /<a\s+[^>]*href=["']\/download\/windows[^"']*["'][^>]*class=["'][^"']*btn-primary[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
    content = content.replace(primaryBtnRegex, msStoreBadgeComponent);

    const primaryBtnRegexAlt = /<a\s+[^>]*class=["'][^"']*btn-primary[^"']*["'][^>]*href=["']\/download\/windows[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
    content = content.replace(primaryBtnRegexAlt, msStoreBadgeComponent);

    if (content !== original) {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`Processed: ${filePath}`);
    }
}

function walkDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            walkDir(fullPath);
        } else if (file.endsWith('.html')) {
            processFile(fullPath);
        }
    }
}

walkDir(viewsDir);
console.log("Completed inserting Microsoft Store Web Component badge across all HTML files.");
