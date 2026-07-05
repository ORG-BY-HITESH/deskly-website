/**
 * Deskly website analytics — posthog-js (browser SDK).
 * Loaded on every page; owns PostHog init, the shared capture/identify
 * wrapper, and the single delegated click handler for [data-analytics-event].
 */
(function () {
    'use strict';

    var POSTHOG_KEY = 'phc_Ih8aJwp4VjcZyZC4PPGVcaqPNyF6aOdRc9Adlwo9b0k';
    var POSTHOG_HOST = 'https://us.i.posthog.com';

    !function (t, e) { var o, n, p, r; e.__SV || (window.posthog = e, e._i = [], e.init = function (i, s, a) { function g(t, e) { var o = e.split("."); 2 == o.length && (t = t[o[0]], e = o[1]), t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))) } } (p = t.createElement("script")).type = "text/javascript", p.crossOrigin = "anonymous", p.async = !0, p.src = s.api_host + "/static/array.full.js", (r = t.getElementsByTagName("script")[0]).parentNode.insertBefore(p, r); var u = e; for (void 0 !== a ? u = e[a] = [] : a = "posthog", u.people = u.people || [], u.toString = function (t) { var e = "posthog"; return "posthog" !== a && (e += "." + a), t || (e += " (stub)"), e }, u.people.toString = function () { return u.toString(1) + ".people (stub)" }, o = "capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getSurveys getActiveMatchingSurveys captureException".split(" "), n = 0; n < o.length; n++)g(u, o[n]); e._i.push([i, s, a]) }, e.__SV = 1) }(document, window.posthog || []);

    posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        capture_pageview: 'history_change',
        autocapture: true,
        disable_session_recording: true,
        exception_autocapture: true,
        persistence: 'localStorage+cookie',
    });

    window.desklyAnalytics = {
        capture: function (eventName, properties) {
            if (!eventName || typeof posthog === 'undefined' || typeof posthog.capture !== 'function') return;
            posthog.capture(eventName, Object.assign({ source: 'website', path: window.location.pathname }, properties || {}));
        },
    };

    // Single delegated handler for every tracked click — the old per-page
    // scripts had both this and a separate generic nav-link listener, so a
    // nav CTA carrying data-analytics-event fired twice per click.
    document.addEventListener('click', function (event) {
        var el = event.target.closest('[data-analytics-event]');
        if (!el) return;
        var eventName = el.getAttribute('data-analytics-event');
        if (!eventName) return;

        window.desklyAnalytics.capture(eventName, {
            cta_source: el.getAttribute('data-analytics-source') || 'unknown',
            href: el.getAttribute('href') || null,
        });
    }, true);
})();
