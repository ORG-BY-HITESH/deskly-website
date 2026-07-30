const fs = require('fs');
const path = require('path');

const viewsDir = 'C:\\Users\\hites\\Desktop\\digitalwellbeing-final-deskly-work\\digitalwellbeing-final-deskly-work\\website\\deskly-website\\views';

const badgeScriptTag = '<script type="module" src="https://get.microsoft.com/badge/ms-store-badge.bundled.js"></script>';

const msStoreBadgeComponent = (source = 'hero') => `<ms-store-badge
    productid="9N3XS93TJ82Q"
    productname="Deskly - Screen Time, App Lock, Widgets & More"
    window-mode="direct"
    theme="auto"
    size="large"
    language="en-us"
    animation="on">
    <a href="ms-windows-store://pdp/?ProductId=9N3XS93TJ82Q" class="ms-store-badge-fallback" data-analytics-event="web.cta.clicked" data-analytics-source="${source}">
        <img src="https://get.microsoft.com/images/en-us%20dark.svg" alt="Get it from Microsoft Store" />
    </a>
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

    // 2. Replace any <ms-store-badge ...> ... </ms-store-badge> blocks or standalone badge anchors
    const badgeComponentRegex = /<ms-store-badge[\s\S]*?<\/ms-store-badge>/gi;
    content = content.replace(badgeComponentRegex, (match) => {
        return msStoreBadgeComponent('web_badge');
    });

    const badgeAnchorRegex = /<a\s+[^>]*class="ms-store-badge"[^>]*>[\s\S]*?<\/a>/gi;
    content = content.replace(badgeAnchorRegex, (match) => {
        return msStoreBadgeComponent('web_badge');
    });

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
console.log("Completed inserting Microsoft Store Web Component badge with ms-windows-store:// URI links across all HTML files.");
