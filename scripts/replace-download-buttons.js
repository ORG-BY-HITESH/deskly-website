const fs = require('fs');
const path = require('path');

const viewsDir = 'C:\\Users\\hites\\Desktop\\digitalwellbeing-final-deskly-work\\digitalwellbeing-final-deskly-work\\website\\deskly-website\\views';

function processFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;

    // 1. Replace the footer `#download` links first to convert them to proper tracking links
    const footerRegex = /<a\s+href="#download"\s+class="nav-cta"\s+style="([^"]*)"\s*>Download for Windows<\/a>/g;
    content = content.replace(footerRegex, '<a href="/download/windows?source=footer" class="nav-cta" style="$1">Get from Microsoft Store</a>');

    const footerRegexAlt = /<a\s+class="nav-cta"\s+style="([^"]*)"\s+href="#download"\s*>Download for Windows<\/a>/g;
    content = content.replace(footerRegexAlt, '<a href="/download/windows?source=footer" class="nav-cta" style="$1">Get from Microsoft Store</a>');

    const footerRegexSimple = /<a\s+href="#download"\s+class="nav-cta"\s*>Download for Windows<\/a>/g;
    content = content.replace(footerRegexSimple, '<a href="/download/windows?source=footer" class="nav-cta">Get from Microsoft Store</a>');

    // 2. Parse general <a> tags that link to "/download/windows"
    const aTagRegex = /<a\s+([^>]*href=["']\/download\/windows[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;

    content = content.replace(aTagRegex, (match, attrs, body) => {
        // If it's already a Microsoft Store badge or has an image/badge, skip it
        if (attrs.includes('ms-store-badge') || body.includes('ms-store-badge') || body.includes('<img') || body.includes('en-us')) {
            return match;
        }

        // Extract the source from href
        let source = 'unknown';
        const hrefMatch = attrs.match(/href=["']\/download\/windows(?:\?source=([^"'&]+))?/i);
        if (hrefMatch && hrefMatch[1]) {
            source = hrefMatch[1];
        }

        // If it's a primary button (btn-primary or has btn-primary class)
        if (attrs.includes('btn-primary')) {
            // Replace with the Microsoft Store Badge link
            return `<a href="/download/windows?source=${source}" class="ms-store-badge" data-analytics-event="web.cta.clicked" data-analytics-source="${source}">
                    <img src="https://get.microsoft.com/images/en-us%20dark.svg" alt="Get it from Microsoft Store" />
                </a>`;
        }

        // Otherwise (navbar, mobile-menu, or text links), update the label text
        // Keep existing attributes intact (class, styles, tracking tags)
        return `<a ${attrs}>Get from Microsoft Store</a>`;
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
console.log("Completed replacement of download buttons across all HTML files.");
