# Deskly — Authority, Backlink & Launch Action Plan

Status snapshot as of 2026-07-04. On-site technical SEO, content hub, and internal linking are done (see task history below). This document covers what's left: earning external authority (backlinks, mentions, reviews) and executing a launch that turns traffic into installs.

## 1. What's already shipped (on-site)

- Canonical/OG/Twitter tags fixed, sitemap.xml rebuilt (22 URLs), robots.txt verified, www→apex normalization.
- 9 keyword landing pages (screen time tracker, digital wellbeing, app & website limits, app usage tracker, app blocker, screen time timeline, desktop widgets, focus app, solutions hub) all indexable, all wired into nav.
- 3 comparison pages (vs RescueTime, vs Cold Turkey, vs Freedom) with comparison tables + FAQPage schema.
- BreadcrumbList + FAQPage + SoftwareApplication schema audited site-wide.
- Blog hub (`/blog`) with 3 cornerstone posts, cross-linked from all 18 pages via nav, mobile nav, footer, and topical `.seo-related-links`.
- README feature table corrected to match real shipped features.

This gives Google something coherent to crawl and rank. **None of it earns backlinks or trust by itself** — that requires the steps below.

## 2. Backlink & authority targets (do these first — highest ROI for a Windows utility app)

### Directory listings (fast, high-authority, free)
- [ ] AlternativeTo.net — list Deskly as an alternative to RescueTime, Cold Turkey, Freedom, StayFocusd, Forest. Each "alternative to X" entry is itself a long-tail ranking surface.
- [ ] Slant.co — answer/contribute to "best screen time tracker for Windows" and "best app blocker" questions.
- [ ] SaaSHub — free listing, links back to deskly.in.
- [ ] Product Hunt — launch listing (see §3), permanent backlink regardless of launch-day performance.
- [ ] Windows-specific directories: Softpedia, FileHippo, MajorGeeks, Neowin software section.
- [ ] G2 / Capterra — free vendor profile for "productivity software" / "employee monitoring" adjacent categories (skip if positioning conflicts with privacy-first messaging).

### Community presence (Reddit, forums)
- [ ] r/software, r/productivity, r/WindowsApps, r/digitalminimalism — genuine participation, not drive-by links. Answer existing "how do I block distracting apps on Windows" threads with a helpful answer that happens to mention Deskly.
- [ ] Indie Hackers — build-in-public post about why you built a local-first alternative to cloud-based trackers.
- [ ] Hacker News "Show HN" — local-first + privacy angle plays well here specifically (avoid generic "productivity app" framing, HN is skeptical of that).

### Content-driven links
- [ ] Pitch the 3 cornerstone blog posts to newsletter curators in the productivity/self-improvement space (e.g. Ali Abdaal-adjacent newsletters, Zapier blog contributors, Toggl/Clockify blogs sometimes link out to complementary tools).
- [ ] Reach out to YouTube channels that review Windows utilities or cover "digital detox" content — offer a free walkthrough, not paid placement, in exchange for an honest review + link in description.
- [ ] Get listed in "best RescueTime/Cold Turkey/Freedom alternatives" roundup articles — search for these roundups and email the authors with the comparison-page URL as a resource.

### Technical/dev authority
- [ ] Keep the GitHub repo public, polished README (done), add topics (`screen-time`, `digital-wellbeing`, `windows`, `electron`, `productivity`) so it surfaces in GitHub topic search.
- [ ] Submit to Electron's official "apps built with Electron" showcase if one exists.

## 3. Launch sequencing

1. **Soft launch (week 1)**: directory listings + Reddit/forum presence, no big push yet. Goal: get first inbound links and first real user feedback before a bigger spike of traffic.
2. **Product Hunt launch (week 2-3)**: time it for a Tuesday–Thursday. Prep assets (GIF demo, tagline, first-comment story) in advance. Line up 10-15 people who'll upvote/comment organically in the first hour — PH's algorithm rewards early velocity.
3. **Show HN (week 3-4, separate from PH)**: different audience, different framing (local-first/privacy angle, not "check out my new app").
4. **Content distribution (ongoing)**: share each blog post on relevant subreddits/forums as it's useful, not promotional — the post should stand alone as helpful content with Deskly mentioned, not pitched.

## 4. Measurement

- Track referral traffic per channel in analytics (source= query params are already wired into every download CTA across all pages — use them).
- Watch Google Search Console for: new indexed pages (should climb to 22+ within 2-4 weeks of sitemap resubmission), impressions for the target keyword set (screen time tracker windows, app blocker windows, digital wellbeing windows, rescuetime alternative, cold turkey alternative, freedom app alternative), and click-through rate per landing page.
- Re-submit sitemap.xml in Search Console after this round of changes (new /blog URLs need to be crawled).

## 5. Immediate next actions (do these, in order)

1. Resubmit sitemap.xml to Google Search Console + Bing Webmaster Tools.
2. Create AlternativeTo, SaaSHub, Slant listings (can be done in one sitting, ~1-2 hours total).
3. Draft the Product Hunt launch post + assets.
4. Identify 5 existing "best Windows productivity apps" or "RescueTime alternatives" roundup articles and email the authors.
