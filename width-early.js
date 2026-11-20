// Runs at document_start so the saved feed width applies before Substack's first paint.
(function () {
    "use strict";

    const WIDTHS = ["standard", "wide", "full"];
    // Same pages as content.js: the Inbox list and tabs (not an opened post), and Home with its tabs.
    const supportedPage = /^\/(?:inbox(?:\/(?!post\/)|$)|home(?:\/secondary\/[^/]+)?\/?$|$)/i.test(location.pathname);
    if (!supportedPage && !globalThis.__SUBSTACK_ORGANIZER_PREVIEW__) {
        return;
    }

    let width = "wide";
    let paused = false;
    try {
        const cached = localStorage.getItem("substackOrganizerWidth");
        if (WIDTHS.includes(cached)) {
            width = cached;
        }
        paused = localStorage.getItem("substackOrganizerPaused") === "1";
    } catch {
        // Storage can be blocked; fall back to the default width.
    }
    // While the organizer is paused, Substack's page is left exactly as it is: no width and no overlay.
    if (paused) {
        document.documentElement.dataset.substackOrganizerPaused = "";
        return;
    }
    document.documentElement.dataset.substackOrganizerWidth = width;

    // Hide the feed behind a loading overlay until content.js has filtered it. The timeout is a safety
    // net so the page can never stay hidden if the extension fails to start; it clears only this
    // page-load overlay ("boot"), not one content.js starts later for a page change ("nav").
    document.documentElement.dataset.substackOrganizerBooting = "boot";
    setTimeout(() => {
        if (document.documentElement.dataset.substackOrganizerBooting === "boot") {
            delete document.documentElement.dataset.substackOrganizerBooting;
        }
    }, 10000);
})();
