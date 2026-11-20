(function () {
    "use strict";

    const CORE = globalThis.SubstackOrganizerCore;
    const ROOT_ID = "substack-publisher-groups-root";
    const STORAGE_KEYS = ["groups", "assignments", "activeGroup", "days", "width", "publisherNames", "hiddenPanels", "publisherAliases", "readPosts", "hideRead", "paused"];
    // Read marks older than this are dropped, and at most this many are kept.
    const READ_MAX_AGE_MS = 120 * 24 * 60 * 60 * 1000;
    const READ_MAX_COUNT = 3000;
    const DEFAULT_HIDDEN_PANELS = ["Subscriptions", "Recommended for you"];
    const MAX_PUBLISHER_NAMES = 1000;
    const COLUMN_ATTRIBUTE = "substackOrganizerColumn";
    const DAY_OPTIONS = [null, 1, 3, 7];
    const WIDTHS = ["standard", "wide", "full"];
    const WIDTH_LABELS = { standard: "Standard", wide: "Wide", full: "Full" };
    const WIDTH_HINTS = { standard: "600px", wide: "960px", full: "Fill window" };
    const WIDTH_CACHE_KEY = "substackOrganizerWidth";
    const MAX_GROUP_NAME_LENGTH = 32;
    const RESERVED_GROUP_NAMES = new Set(["all publishers", "unassigned", "hidden"]);

    if (!CORE || !globalThis.chrome?.storage?.local) {
        return;
    }

    let appRoot = null;
    let shadow = null;
    let feed = null;
    let observer = null;
    let routeTimer = null;
    let scanTimer = null;
    // The group the feed was last drawn for; a change selects that group's newest post.
    let renderedGroup;
    let state = {
        groups: [],
        assignments: {},
        activeGroup: null,
        days: null,
        width: "wide",
        publisherNames: {},
        // Writer ids ("substack.com/@handle") and publication subdomains mapped to the writer's main
        // publication, so a writer and their publication are one entry. "" means no publication.
        publisherAliases: {},
        // Post key → time it was marked read.
        readPosts: {},
        hideRead: false,
        // Paused: the page behaves as if the extension were off, apart from the bar to resume it.
        paused: false,
        hiddenPanels: [...DEFAULT_HIDDEN_PANELS]
    };
    let cards = [];
    let publishers = [];
    let openMenu = null;
    let renderPending = false;
    let lastFilterKey = null;
    let fadeAfterLoad = false;
    let storageReady = false;
    let themeObserver = null;
    let initializing = false;
    let adapter = null;
    let markedColumn = null;
    let loadRun = null;
    let loadedRangeKey = null;
    let feedFullyLoaded = false;
    // The longest date range already loaded, so a shorter one only re-filters.
    let loadedDays = 0;
    let sidebarPanels = [];

    function getChildContaining(parent, element) {
        let child = element;
        while (child && child.parentElement !== parent) {
            child = child.parentElement;
        }
        return child;
    }

    // Each page Substack renders differently; an adapter finds its feed, items and width column.
    const ADAPTERS = {
        inbox: {
            name: "inbox",
            label: "Inbox",
            // The whole Inbox (about 180 posts) loads once at page load, so group switches only re-filter.
            loadLimit: 600,
            itemSelector: ".reader2-inbox-post",
            // The Inbox list and its tabs; a post opened from it (/inbox/post/<id>) is a different page.
            matches: (path) => /^\/inbox(?:\/(?!post\/)|$)/i.test(path),
            findFeed() {
                // Keep the current feed while it's on the page, so the bar isn't torn down mid-use.
                if (feed?.isConnected && adapter?.name === "inbox" && feed.querySelector(".reader2-inbox-post")) {
                    return { root: feed, mountParent: feed, mountBefore: feed.firstElementChild };
                }
                const firstPost = document.querySelector(".reader2-inbox-post");
                const feedRoot = firstPost?.closest(".reader2-post-container")?.parentElement?.parentElement;
                return feedRoot ? { root: feedRoot, mountParent: feedRoot, mountBefore: feedRoot.firstElementChild } : null;
            },
            findColumn: () => null,
            getCards(feedRoot) {
                const result = [];
                const seen = new Set();
                for (const post of (feedRoot ?? document).querySelectorAll(".reader2-inbox-post")) {
                    const container = post.closest(".reader2-post-container");
                    const publisherLink = post.querySelector(".reader2-post-head a[href]");
                    const publisherName = publisherLink?.textContent?.trim();
                    const publisherId = publisherLink ? CORE.normalizePublisher(publisherLink.href) : null;
                    if (!container || !publisherName || !publisherId || seen.has(container)) {
                        continue;
                    }
                    seen.add(container);
                    const canonicalId = toCanonicalIds([publisherId])[0];
                    result.push({
                        container,
                        rawIds: [publisherId],
                        publisherIds: [canonicalId],
                        names: { [canonicalId]: publisherName },
                        postDay: readInboxPostDay(post, publisherLink)
                    });
                }
                return result;
            }
        },
        home: {
            name: "home",
            label: "Home",
            // Home never ends and slows down past ~200 items (each carries videos and embeds), so like the
            // Inbox it loads once at page open, but stops at 150 items.
            loadLimit: 150,
            itemSelector: '[role="article"][class*="feedItem"]',
            // "/" and "/home" are For you; Following and other Home tabs live under "/home/secondary/<tab>".
            matches: (path) => /^\/(?:home(?:\/secondary\/[^/]+)?\/?)?$/i.test(path),
            findFeed() {
                const selector = '[role="article"][class*="feedItem"]';
                // Switching tabs (For you, Following) can leave the old list on the page but not displayed,
                // so only a rendered list counts. The extension never hides the list itself.
                const isRendered = (element) => element.getClientRects().length > 0;
                // Keep the current feed while it's displayed, so the bar isn't torn down mid-use.
                if (feed?.isConnected && adapter?.name === "home" && isRendered(feed) && feed.querySelector(selector)) {
                    return { root: feed, mountParent: feed.parentElement, mountBefore: feed };
                }
                // The feed list is the container holding the most items; a stray item elsewhere
                // (a preview or pop-up) must not pull the list up to a larger ancestor.
                const counts = new Map();
                for (const item of document.querySelectorAll(selector)) {
                    if (item.closest('.reader2-inbox-sidebar, [role="dialog"]') || !isRendered(item.parentElement)) {
                        continue;
                    }
                    counts.set(item.parentElement, (counts.get(item.parentElement) ?? 0) + 1);
                }
                let list = null;
                let best = 0;
                for (const [parent, count] of counts) {
                    if (count > best) {
                        list = parent;
                        best = count;
                    }
                }
                return list?.parentElement ? { root: list, mountParent: list.parentElement, mountBefore: list } : null;
            },
            // Home's center column caps its width with a pixel max-width on a wrapper above the feed.
            findColumn(feedRoot) {
                // Once widened, the marked column's max-width is no longer a plain pixel value, so keep it.
                if (markedColumn?.isConnected && markedColumn.contains(feedRoot)) {
                    return markedColumn;
                }
                for (let element = feedRoot; element && element !== document.body; element = element.parentElement) {
                    const maxWidth = Number.parseFloat(getComputedStyle(element).maxWidth);
                    if (Number.isFinite(maxWidth) && maxWidth < innerWidth * 0.8) {
                        return element;
                    }
                }
                return null;
            },
            getCards(feedRoot) {
                const result = [];
                const seen = new Set();
                for (const item of feedRoot.querySelectorAll('[role="article"][class*="feedItem"]')) {
                    const container = getChildContaining(feedRoot, item);
                    if (!container || seen.has(container)) {
                        continue;
                    }
                    seen.add(container);
                    const parsed = readHomeItem(item);
                    if (parsed.suggestion) {
                        setData(container, "substackOrganizerSuggestion", "true");
                        continue;
                    }
                    // A feed slot Substack reuses for a real post must not stay hidden as a suggestion.
                    if (container.dataset.substackOrganizerSuggestion) {
                        delete container.dataset.substackOrganizerSuggestion;
                    }
                    result.push({
                        container,
                        item,
                        rawIds: parsed.publisherIds,
                        publisherIds: toCanonicalIds(parsed.publisherIds),
                        names: parsed.names,
                        postDay: parsed.postDay,
                        articleKey: parsed.articleKey,
                        isNote: parsed.isNote
                    });
                }
                return result;
            }
        }
    };

    // A Note sharing an article that's also in the feed shows the same card twice. Among the copies that pass
    // the current filter, one is kept: the article itself (not a Note) when present, otherwise the first.
    // Returns the cards to hide as duplicates.
    function findDuplicateArticles(visibleCards) {
        const keep = new Map();
        for (const card of visibleCards) {
            if (!card.articleKey) {
                continue;
            }
            const current = keep.get(card.articleKey);
            if (!current || (current.isNote && !card.isNote)) {
                keep.set(card.articleKey, card);
            }
        }
        return new Set(visibleCards.filter((card) => card.articleKey && keep.get(card.articleKey) !== card));
    }

    function countForGroup(list, group) {
        return countUniquePosts(
            list.filter((card) => CORE.isPublisherVisible(card.publisherIds, group, state.assignments) && !(state.hideRead && isCardRead(card)))
        );
    }

    // Post element → its card, for click, hover and keyboard lookups.
    let cardByContainer = new WeakMap();

    // Posts counted once per article, so a shared article and its Note count as one.
    function countUniquePosts(list) {
        const keys = new Set();
        let count = 0;
        for (const card of list) {
            if (!card.articleKey) {
                count += 1;
            } else if (!keys.has(card.articleKey)) {
                keys.add(card.articleKey);
                count += 1;
            }
        }
        return count;
    }

    // Each post's own link identifies it for read marks and read-later: a Note's permalink, an article's URL
    // (shared by Home and Subscriptions, so a mark made on one shows on the other), or, for a Subscriptions
    // row with no article link, its link inside Substack. The key is the host and path. Cached per post
    // element, and read again if the post's article or type changes.
    const postKeyCache = new WeakMap();
    function getPostUrl(card) {
        const root = card.item ?? card.container;
        if (card.isNote) {
            const note = root.querySelector('a[href*="/note/c-"]');
            if (note) {
                return { url: note.href, anchor: note };
            }
        }
        if (card.articleKey) {
            return { url: `https://${card.articleKey}`, anchor: null };
        }
        const anchor =
            root.querySelector('a[href*="/p/"]') ??
            getInboxPostLink(card) ??
            root.querySelector('a[href*="/note/c-"], a[href*="/inbox/post/"], a[href*="/home/post/"]');
        return { url: anchor?.href ?? null, anchor };
    }

    function getInboxPostLink(card) {
        const root = card.item ?? card.container;
        const inboxPost = root.matches?.(".reader2-inbox-post") ? root : root.querySelector(".reader2-inbox-post");
        return inboxPost?.matches("a[href]") ? inboxPost : null;
    }

    function toPostKey(url) {
        try {
            const parsed = new URL(url, location.href);
            const path = parsed.pathname.match(/^\/p\/[^/]+/)?.[0] ?? parsed.pathname.replace(/\/+$/, "");
            return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${path}`;
        } catch {
            return null;
        }
    }

    function getPostKey(card) {
        const element = card.item ?? card.container;
        const cached = postKeyCache.get(element);
        // Still valid only if the post's article and type are unchanged and the link it came from is
        // still in this post with the same address (Substack can reuse an element for another post).
        if (
            cached &&
            cached.articleKey === card.articleKey &&
            cached.isNote === card.isNote &&
            (!cached.anchor || (cached.anchor.href === cached.url && element.contains(cached.anchor)))
        ) {
            return cached;
        }
        const { url, anchor } = getPostUrl(card);
        const entry = { articleKey: card.articleKey, isNote: card.isNote, anchor, url, key: url ? toPostKey(url) : null };
        if (entry.key) {
            postKeyCache.set(element, entry);
        } else {
            // A post with no usable link (some Home items) is keyed by its publisher and title, so it can
            // still be marked read. Not cached: the title may not be drawn yet on the first read.
            entry.key = getTextKey(card);
        }
        return entry;
    }

    function getTextKey(card) {
        const root = card.item ?? card.container;
        const heading = root.querySelector('h1, h2, h3, [class*="title" i]')?.textContent;
        const body = heading?.trim() ? heading : root.querySelector('[class*="body" i], p')?.textContent;
        const text = (body ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
        return text ? `text:${card.publisherIds[0] ?? ""}:${text}` : null;
    }

    // Checked once per change of the read marks, not once per post.
    let readMarksSeen = { posts: null, has: false };
    function hasReadMarks() {
        if (readMarksSeen.posts !== state.readPosts) {
            let has = false;
            for (const key in state.readPosts) {
                has = Boolean(key);
                break;
            }
            readMarksSeen = { posts: state.readPosts, has };
        }
        return readMarksSeen.has;
    }

    // A post that shares an article is marked under the article's key, so every copy of it (the post and
    // the Notes sharing it) reads the same, whichever copy is marked or unmarked. A Note's own key still
    // counts and is cleared on unmark, for marks saved before.
    function getReadKeys(card) {
        const own = getPostKey(card).key;
        return [...new Set([card.articleKey, own].filter(Boolean))];
    }

    function isCardRead(card) {
        if (!hasReadMarks()) {
            return false;
        }
        return getReadKeys(card).some((key) => state.readPosts[key]);
    }

    // Every save is sent as a change to the extension's single writer (background.js), which applies
    // changes one at a time to what's stored, so tabs can't overwrite each other. The message is sent
    // immediately, so a post opened in a full-page load still gets its read mark. The local preview has no
    // background script and applies the same merge itself.
    let localWriteQueue = Promise.resolve();
    function writeToStorage(write) {
        if (globalThis.chrome?.runtime?.id && chrome.runtime.sendMessage) {
            return chrome.runtime.sendMessage({ type: "substack-organizer-write", write }).then((response) => {
                if (!response?.ok) {
                    throw new Error(response?.error ?? "The save didn't complete.");
                }
            });
        }
        const run = localWriteQueue.then(async () => {
            const keys = CORE.getStorageWriteKeys(write);
            const stored = keys.length ? await chrome.storage.local.get(keys) : {};
            await chrome.storage.local.set(CORE.applyStorageWrite(stored, write));
        });
        localWriteQueue = run.catch(() => {});
        return run;
    }

    // Object entries that differ between two values, with null for removed entries.
    function diffEntries(before, after) {
        const changes = {};
        for (const [key, value] of Object.entries(after)) {
            if (JSON.stringify(before[key]) !== JSON.stringify(value)) {
                changes[key] = value;
            }
        }
        for (const key of Object.keys(before)) {
            if (!Object.hasOwn(after, key)) {
                changes[key] = null;
            }
        }
        return changes;
    }

    function reportStorageError(error) {
        const text = describeStorageError(error);
        setMessage(text, true);
        const count = shadow?.getElementById("post-count");
        if (count) {
            count.textContent = text;
        }
    }

    // Marks (or unmarks) posts read. Returns the change as { key: time } so it can be undone exactly.
    let lastMarkedRead = {};
    function setCardsRead(list, read) {
        if (!storageReady) {
            return {};
        }
        const changes = {};
        const time = Date.now();
        for (const card of list) {
            // Marking sets one key (the article's when there is one); unmarking clears every key that counts.
            for (const key of read ? getReadKeys(card).slice(0, 1) : getReadKeys(card)) {
                if (Boolean(state.readPosts[key]) !== read) {
                    changes[key] = read ? time : null;
                }
            }
        }
        if (!Object.keys(changes).length) {
            return changes;
        }
        const updated = { ...state.readPosts };
        for (const [key, time] of Object.entries(changes)) {
            if (time === null) {
                delete updated[key];
            } else {
                updated[key] = time;
            }
        }
        // Cap and age limits are applied only when the list is over its size.
        state = { ...state, readPosts: Object.keys(updated).length > READ_MAX_COUNT ? sanitizeReadPosts(updated) : updated };
        writeToStorage({ merge: { readPosts: changes } }).catch(reportStorageError);
        applyFilter();
        return changes;
    }

    function undoMarkRead(batch) {
        // Only marks still carrying this batch's time are removed; a post marked again later stays read. The
        // background writer checks this against what's stored, so another tab's newer mark is kept too.
        const expected = Object.fromEntries(Object.entries(batch).filter(([, time]) => time !== null));
        const readPosts = { ...state.readPosts };
        for (const [key, time] of Object.entries(expected)) {
            if (readPosts[key] === time) {
                delete readPosts[key];
            }
        }
        state = { ...state, readPosts };
        writeToStorage({ removeIfEquals: { readPosts: expected } }).catch(reportStorageError);
        applyFilter();
    }

    // Reading a Home post (several querySelectorAll calls over videos and embeds) is the costliest step of
    // a refresh, which runs several times a second. A post is cached once it has rendered its author and
    // date; until then it's read again on each refresh.
    const homeItemCache = new WeakMap();
    function readHomeItem(item) {
        const cached = homeItemCache.get(item);
        if (cached) {
            return cached;
        }
        if (isSuggestionModule(item)) {
            const parsed = { suggestion: true };
            homeItemCache.set(item, parsed);
            return parsed;
        }
        const publisherIds = [];
        const names = {};
        // The post's author (the first profile link) always counts, so a Note or restack that
        // links another publication's article still matches the author's group.
        let authorId = null;
        for (const link of item.querySelectorAll('a[href*="/@"], a[href*="/profile/"]')) {
            const id = CORE.normalizeProfile(link.href);
            if (!id || (authorId && id !== authorId)) {
                continue;
            }
            authorId = id;
            const name = link.textContent.trim();
            if (name) {
                names[authorId] = name.slice(0, 120);
                break;
            }
        }
        if (authorId) {
            publisherIds.push(authorId);
        }
        for (const link of item.querySelectorAll('a[href*="/p/"]')) {
            const publisherId = CORE.normalizePublisher(link.href);
            if (publisherId && publisherId !== "substack.com" && !publisherIds.includes(publisherId)) {
                publisherIds.push(publisherId);
            }
        }
        const parsed = {
            suggestion: false,
            publisherIds,
            names,
            postDay: readHomePostDay(item),
            articleKey: readArticleKey(item),
            // A Note's timestamp links to /@handle/note/c-<id>; an article item has no such link.
            isNote: Boolean(item.querySelector('a[href*="/note/c-"]'))
        };
        // Cached once complete, or after a few reads: a post with no author link or date (some video and
        // podcast posts) would otherwise be re-read, and refresh the feed, on every video change.
        const reads = (homeItemReads.get(item) ?? 0) + 1;
        homeItemReads.set(item, reads);
        if ((authorId && parsed.postDay) || reads >= 3) {
            homeItemCache.set(item, parsed);
        }
        return parsed;
    }
    const homeItemReads = new WeakMap();

    // The article an item links (host and path of its /p/ links), used to spot a Note that shares the same
    // article as another item. Items linking more than one article (a Note citing several) aren't matched.
    function readArticleKey(item) {
        let key = null;
        for (const link of item.querySelectorAll('a[href*="/p/"]')) {
            const linkKey = toArticleKey(link.href);
            if (!linkKey) {
                continue;
            }
            if (key && linkKey !== key) {
                return null;
            }
            key = linkKey;
        }
        return key;
    }

    // host + /p/<slug> for an article link; null for Substack's own app links and malformed ones.
    // open.substack.com/pub/<name>/p/<slug> is the same article as <name>.substack.com/p/<slug>.
    function toArticleKey(href) {
        try {
            const url = new URL(href, location.href);
            let host = url.hostname.toLowerCase().replace(/^www\./, "");
            let path = url.pathname;
            const openLink = host === "open.substack.com" ? path.match(/^\/pub\/([^/]+)(\/p\/[^/]+)/) : null;
            if (openLink) {
                host = `${openLink[1].toLowerCase()}.substack.com`;
                path = openLink[2];
            }
            if (host === "substack.com") {
                return null;
            }
            return `${host}${(path.match(/^\/p\/[^/]+/) ?? [path.replace(/\/+$/, "")])[0]}`;
        } catch {
            return null;
        }
    }

    function getPreviewAdapterName() {
        const preview = globalThis.__SUBSTACK_ORGANIZER_PREVIEW__;
        return preview === true ? "inbox" : typeof preview === "string" ? preview : null;
    }

    function getRouteAdapter() {
        const previewName = getPreviewAdapterName();
        if (previewName) {
            return ADAPTERS[previewName] ?? null;
        }
        return Object.values(ADAPTERS).find((candidate) => candidate.matches(location.pathname)) ?? null;
    }

    const styles = `
        :host {
            display: block;
            /* Pinned over the feed, so it has the page's background and a little room above and below. */
            padding: 8px 0;
            background: var(--sg-bg);
            color: var(--sg-text);
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-size: 13px;
            line-height: 1.4;
            color-scheme: dark;
            --sg-bg: #161718;
            --sg-panel: #232525;
            --sg-raised: #2c2e2e;
            --sg-border: #313333;
            --sg-text: #eeeeee;
            --sg-muted: #777777;
            --sg-accent: #232525;
            --sg-accent-text: #eeeeee;
            --sg-focus: #929292;
            --sg-danger: #ff6b6b;
            --sg-shadow: 0 4px 16px rgb(0 0 0 / 45%);
        }
        :host([data-theme="light"]) {
            color-scheme: light;
            --sg-bg: #ffffff;
            --sg-panel: #f0f0f0;
            --sg-raised: #e6e6e6;
            --sg-border: #dddddd;
            --sg-text: #363737;
            --sg-muted: #777777;
            --sg-accent: #f0f0f0;
            --sg-accent-text: #363737;
            --sg-focus: #929292;
            --sg-danger: #c0392b;
            --sg-shadow: 0 4px 16px rgb(0 0 0 / 12%);
        }
        *, *::before, *::after { box-sizing: border-box; }
        button, input { font: inherit; }
        button {
            min-height: 32px;
            border: 1px solid var(--sg-border);
            border-radius: 8px;
            background: transparent;
            color: var(--sg-muted);
            cursor: pointer;
            font-weight: 600;
            padding: 5px 10px;
            transition: background-color 0.15s ease-out, color 0.15s ease-out;
        }
        button:hover { background: var(--sg-panel); color: var(--sg-text); }
        button:focus-visible, input:focus-visible {
            outline: 2px solid var(--sg-focus);
            outline-offset: 2px;
        }
        button[aria-pressed="true"], button[aria-current="true"] {
            background: var(--sg-accent);
            color: var(--sg-accent-text);
        }
        input {
            min-width: 0;
            min-height: 36px;
            border: 1px solid var(--sg-border);
            border-radius: 8px;
            background: var(--sg-bg);
            color: var(--sg-text);
            padding: 6px 10px;
        }
        input::placeholder { color: var(--sg-muted); }
        @media (pointer: coarse) {
            input { font-size: 16px; }
        }
        [hidden] { display: none !important; }
        .shell {
            position: relative;
            z-index: 20;
            margin: 0 0 12px;
        }
        .toolbar {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 8px;
        }
        .brand {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-right: auto;
            color: var(--sg-muted);
            font-weight: 600;
            white-space: nowrap;
        }
        .brand-title { color: var(--sg-text); }
        .count, .muted { color: var(--sg-muted); }
        .menu-wrap { position: relative; }
        .menu {
            position: absolute;
            z-index: 30;
            top: calc(100% + 6px);
            left: 0;
            min-width: 240px;
            max-height: min(640px, calc(100vh - 120px));
            overflow: auto;
            border: 1px solid var(--sg-border);
            border-radius: 8px;
            background: var(--sg-bg);
            box-shadow: var(--sg-shadow);
            padding: 4px;
            scrollbar-width: thin;
            scrollbar-color: var(--sg-border) transparent;
        }
        .menu button {
            display: flex;
            width: 100%;
            justify-content: space-between;
            gap: 16px;
            text-align: left;
            white-space: nowrap;
            border: 0;
            border-radius: 6px;
            background: transparent;
            color: var(--sg-text);
        }
        .menu button[aria-current="true"] { background: var(--sg-accent); }
        .menu .menu-count { color: var(--sg-muted); }
        .menu .unassigned-option { margin-top: 4px; border-top: 1px solid var(--sg-border); border-radius: 0 0 6px 6px; }
        .menu button[aria-current="true"] .menu-count { color: inherit; }
        /* The gear's orange dot: read posts are hidden. */
        #settings-trigger { position: relative; }
        .gear-dot {
            position: absolute;
            top: 4px;
            right: 4px;
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: #ff6719;
            box-shadow: 0 0 0 2px var(--sg-bg);
            pointer-events: none;
        }
        .gear-dot[hidden] { display: none; }
        /* A chosen group (not All publishers): the same thin orange underline as the group labels on posts. */
        #filter-trigger.group-chosen {
            text-decoration: underline;
            text-decoration-color: #ff6719;
            text-decoration-thickness: 1px;
            text-underline-offset: 5px;
        }
        /* A modal over the page, so opening it doesn't push the feed down. Centered with inset and
           auto margins (no transform), so the publisher menus' position: fixed still uses the viewport. */
        .manager-backdrop {
            position: fixed;
            inset: 0;
            z-index: 10;
            background: rgb(0 0 0 / 45%);
        }
        .manager {
            position: fixed;
            inset: 0;
            z-index: 11;
            width: min(820px, calc(100vw - 32px));
            height: fit-content;
            max-height: calc(100vh - 64px);
            margin: auto;
            overflow-y: auto;
            overscroll-behavior: contain;
            border: 1px solid var(--sg-border);
            border-radius: 8px;
            padding: 16px;
            background: var(--sg-bg);
            box-shadow: var(--sg-shadow);
        }
        .manager-backdrop[hidden], .manager[hidden] { display: none; }
        .manager-head {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 12px;
        }
        .manager-head h2 {
            margin: 0 auto 0 0;
            font-size: 14px;
            font-weight: 600;
        }
        .message {
            margin: 0;
            padding: 8px 14px 0;
            color: var(--sg-muted);
        }
        .message:empty { display: none; }
        .message[data-error="true"] { color: var(--sg-danger); }
        /* Manage: a bordered header, then the view list flush to the edges beside the publishers. */
        #manager { padding: 0; }
        #manager .manager-head { margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--sg-border); }
        .manager-body {
            display: grid;
            grid-template-columns: 210px minmax(0, 1fr);
            align-items: stretch;
        }
        .rail {
            display: flex;
            flex-direction: column;
            gap: 2px;
            max-height: min(480px, 64vh);
            overflow-y: auto;
            overscroll-behavior: contain;
            padding: 8px;
            border-right: 1px solid var(--sg-border);
            background: var(--sg-panel);
            scrollbar-width: thin;
            scrollbar-color: var(--sg-border) transparent;
        }
        .rail-item { position: relative; display: flex; align-items: center; border-radius: 0; }
        .rail-item:hover { background: rgb(128 128 128 / 12%); }
        .rail-item.active { background: var(--sg-bg); box-shadow: inset 2px 0 0 #ff6719; }
        .rail-item.drop { background: var(--sg-bg); outline: 1px dashed var(--sg-text); outline-offset: -1px; }
        .rail-spacer { flex: 0 0 26px; }
        .rail .rail-target {
            display: flex;
            min-width: 0;
            flex: 1;
            justify-content: space-between;
            gap: 8px;
            border: 0;
            background: transparent;
            padding: 6px 8px 6px 14px;
            color: var(--sg-text);
            font-weight: 400;
            text-align: left;
        }
        .rail .rail-target:hover { background: transparent; }
        .rail-item.active .rail-target { font-weight: 600; }
        .rail-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .rail-count { color: var(--sg-muted); font-size: 12px; }
        .rail-grip { position: absolute; top: 0; bottom: 0; left: 0; z-index: 1; display: grid; width: 12px; place-items: center; color: var(--sg-muted); cursor: grab; opacity: 0; }
        .rail-grip svg { width: 12px; height: 12px; }
        .icon-button.rail-menu { width: 26px; min-width: 26px; min-height: 26px; padding: 0; border: 0; background: transparent; opacity: 0; }
        .rail-item:hover .rail-grip, .rail-item:hover .rail-menu, .rail-menu:focus-visible, .rail-menu[aria-expanded="true"] { opacity: 1; }
        .rail-sep { margin: 6px 0; border-top: 1px solid var(--sg-border); }
        .rail .rail-add { font-weight: 400; border: 0; background: transparent; color: var(--sg-muted); padding: 6px 8px 6px 14px; text-align: left; }
        .rail-editor { gap: 4px; padding: 2px 0; }
        .rail-editor:hover { background: transparent; }
        .rail-editor input { min-width: 0; flex: 1; }
        .pane { min-width: 0; padding: 10px 14px 12px; }
        .pane-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
        .pane-tools input { min-width: 160px; flex: 1; }
        .pane-tools .scope-row { margin: 0; }
        #publisher-list {
            max-height: min(400px, 56vh);
            overflow-y: auto;
            overscroll-behavior: contain;
            scrollbar-width: thin;
            scrollbar-color: var(--sg-border) transparent;
        }
        .publisher-detail[draggable="true"] { cursor: grab; }
        .publisher-row {
            display: flex;
            align-items: center;
            gap: 10px;
            min-height: 48px;
            border-bottom: 1px solid var(--sg-border);
            padding: 9px 0;
        }
        .publisher-name {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .publisher-detail {
            display: flex;
            min-width: 0;
            flex: 1;
            flex-direction: column;
        }
        .publisher-name { font-weight: 600; }
        .small-button { min-height: 28px; padding: 3px 7px; }
        .danger-button { color: var(--sg-danger); }
        .publisher-menu {
            position: fixed;
            z-index: 40;
            min-width: 190px;
            max-height: 220px;
            overflow: auto;
            border: 1px solid var(--sg-border);
            border-radius: 8px;
            background: var(--sg-bg);
            box-shadow: var(--sg-shadow);
            padding: 4px;
        }
        .publisher-menu button {
            display: block;
            width: 100%;
            text-align: left;
            border: 0;
            border-radius: 6px;
            color: var(--sg-text);
        }
        .assignment { position: relative; }
        .publisher-row[data-hidden="true"] .publisher-detail { opacity: 0.5; }
        .assignment > button {
            max-width: 190px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .search-row { margin: 10px 0; }
        .search-row input { width: min(100%, 360px); }
        .empty { margin: 12px 0; color: var(--sg-muted); }
        .icon-button {
            display: inline-grid;
            width: 32px;
            min-width: 32px;
            place-items: center;
            padding: 0;
        }
        svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; }
        .right-menu { left: auto; right: 0; }
        #refresh-trigger { display: inline-flex; align-items: center; justify-content: center; min-width: 32px; padding: 5px 8px; }
        #refresh-trigger.spinning svg { animation: sg-spin 0.8s linear infinite; }
        @keyframes sg-spin { to { transform: rotate(360deg); } }
        /* Date range: a segmented control whose highlight slides to the selected option. */
        .segmented { position: relative; display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--sg-border); border-radius: 8px; }
        .segmented button { position: relative; z-index: 1; min-height: 26px; padding: 3px 9px; border: 0; border-radius: 6px; background: transparent; }
        .segmented button:hover { background: transparent; color: var(--sg-text); }
        .segmented button[aria-pressed="true"] { background: transparent; color: var(--sg-text); }
        .seg-fill { position: absolute; top: 2px; bottom: 2px; left: 0; width: 0; border-radius: 6px; background: var(--sg-panel); transition: left 0.2s ease-out, width 0.2s ease-out; }
        .menu-heading { padding: 8px 10px 2px; color: var(--sg-muted); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
        .menu-separator { margin: 4px 0; border-top: 1px solid var(--sg-border); }
        .shortcuts { width: min(520px, calc(100vw - 32px)); padding: 20px 24px; }
        .shortcuts h2 { font-size: 16px; }
        .shortcut-list { display: grid; grid-template-columns: max-content 1fr; gap: 14px 24px; margin: 18px 0 6px; align-items: center; font-size: 15px; }
        .shortcut-list dt { display: flex; gap: 6px; white-space: nowrap; }
        .shortcut-list dd { margin: 0; color: var(--sg-text); }
        .shortcut-list kbd { display: inline-block; min-width: 28px; padding: 3px 8px; border: 1px solid var(--sg-border); border-radius: 4px; background: var(--sg-panel); color: var(--sg-text); font: inherit; font-size: 14px; font-weight: 600; text-align: center; }
        /* Paused: only the name and Resume (at the right end), so the bar stays out of the way. */
        :host([data-paused]) .toolbar > :not(.brand),
        :host([data-paused]) #refresh-trigger { display: none; }
        :host([data-paused]) .brand { flex: 1; margin-right: 0; }
        :host([data-paused]) #resume { margin-left: auto; }
        .empty-note { margin: 0; padding: 40px 16px; color: var(--sg-muted); font-size: 15px; text-align: center; }
        .empty-note[hidden] { display: none; }
        .scope-row { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; }
        .bulk-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; padding: 6px 8px; border: 1px solid var(--sg-border); border-radius: 8px; background: var(--sg-panel); }
        .bulk-bar[hidden] { display: none; }
        .publisher-row input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--sg-text); }
        .list-note { margin: 8px 0; color: var(--sg-muted); font-size: 12px; }
        .manager-tools { display: flex; gap: 6px; }
        #publisher-scope button[aria-pressed="true"] { background: var(--sg-panel); }
        @media (max-width: 600px) {
            .toolbar { align-items: stretch; }
            .brand { width: 100%; }
            .manager-body { grid-template-columns: 1fr; }
            .rail { flex-direction: row; max-height: none; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--sg-border); }
            .rail-item, .rail-add { flex: 0 0 auto; }
            .rail-sep { display: none; }
            .menu { max-width: calc(100vw - 32px); }
        }
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
        }
    `;

    const html = `
        <div class="shell">
            <div class="toolbar">
                <div class="brand"><span class="brand-title">Publisher groups</span><span class="count" id="post-count" aria-live="polite"></span><button class="small-button" id="stop-loading" type="button" hidden>Stop</button><button class="small-button" id="resume" type="button" hidden>Resume</button></div>
                <div class="menu-wrap">
                    <button id="filter-trigger" type="button" aria-haspopup="menu" aria-expanded="false">All publishers</button>
                    <div class="menu" id="filter-menu" role="menu" aria-label="Filter by publisher group" hidden></div>
                </div>
                <div class="segmented" id="days-control" role="group" aria-label="Post date">
                    <span class="seg-fill" aria-hidden="true"></span>
                    <button type="button" data-days="1" aria-label="Past day">Day</button>
                    <button type="button" data-days="3" aria-label="Past 3 days">3d</button>
                    <button type="button" data-days="7" aria-label="Past 7 days">7d</button>
                    <button type="button" data-days="" aria-label="Any time">All</button>
                </div>
                <button id="refresh-trigger" type="button" aria-label="Refresh articles"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg></button>
                <div class="menu-wrap">
                    <button class="icon-button" id="settings-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path></svg><span class="gear-dot" id="gear-dot" hidden></span></button>
                    <div class="menu right-menu" id="settings-menu" role="menu" aria-label="Settings" hidden></div>
                </div>
            </div>
            <p class="empty-note" id="empty-note" hidden></p>
            <div class="manager-backdrop" id="manager-backdrop" hidden></div>
            <section class="manager shortcuts" id="shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" hidden>
                <div class="manager-head">
                    <h2>Keyboard shortcuts</h2>
                    <button class="icon-button" id="close-shortcuts" type="button" aria-label="Close keyboard shortcuts">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>
                    </button>
                </div>
                <dl class="shortcut-list">
                    <dt><kbd>a</kbd></dt><dd>All publishers</dd>
                    <dt><kbd>g</kbd> <kbd>g</kbd></dt><dd>First post</dd>
                    <dt><kbd>G</kbd></dt><dd>Last loaded post</dd>
                    <dt><kbd>h</kbd></dt><dd>Hide / show read posts</dd>
                    <dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>Next / previous post</dd>
                    <dt><kbd>m</kbd></dt><dd>Mark read / unread</dd>
                    <dt><kbd>M</kbd></dt><dd>Mark all filtered posts read / unread</dd>
                    <dt><kbd>o</kbd> <kbd>Enter</kbd></dt><dd>Open the selected post</dd>
                    <dt><kbd>r</kbd></dt><dd>Reload articles</dd>
                    <dt><kbd>t</kbd></dt><dd>Switch between Home and Subscriptions</dd>
                    <dt><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></dt><dd>Day, 3 days, 7 days, All</dd>
                    <dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next group</dd>
                    <dt><kbd>?</kbd></dt><dd>Show or hide this list</dd>
                    <dt><kbd>Esc</kbd></dt><dd>Close</dd>
                </dl>
            </section>
            <section class="manager" id="manager" role="dialog" aria-modal="true" aria-label="Manage publisher groups" hidden>
                <div class="manager-head">
                    <h2>Manage publishers</h2>
                    <span class="muted" id="publisher-count"></span>
                    <div class="manager-tools">
                        <button class="small-button" id="export-settings" type="button">Export</button>
                        <button class="small-button" id="import-settings" type="button">Import</button>
                        <input id="import-file" type="file" accept="application/json,.json" hidden>
                    </div>
                    <button class="icon-button" id="close-manager" type="button" aria-label="Close publisher manager">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>
                    </button>
                </div>
                <div class="message" id="message" role="status" aria-live="polite"></div>
                <div class="manager-body">
                    <nav class="rail" id="group-rail" aria-label="Publisher views"></nav>
                    <div class="pane">
                        <div class="pane-tools">
                            <input id="publisher-search" type="search" autocomplete="off" aria-label="Search publishers" placeholder="Search publishers">
                            <div class="scope-row segmented" id="publisher-scope" role="group" aria-label="Which publishers">
                                <button type="button" class="small-button" data-scope="page" aria-pressed="true">On this page</button>
                                <button type="button" class="small-button" data-scope="all" aria-pressed="false">All known</button>
                            </div>
                        </div>
                        <div class="bulk-bar" id="bulk-bar" hidden>
                            <span id="bulk-count"></span>
                            <div class="assignment">
                                <button class="small-button" id="bulk-move" type="button" aria-haspopup="menu" aria-expanded="false">Move to…</button>
                                <div class="publisher-menu" id="bulk-menu" role="menu" aria-label="Move selected publishers to" hidden></div>
                            </div>
                            <button class="small-button" id="bulk-clear" type="button">Deselect</button>
                        </div>
                        <div id="publisher-list"></div>
                    </div>
                </div>
            </section>
        </div>
    `;

    function sanitizeState(value) {
        const groups = [];
        const seenGroups = new Set();
        for (const rawGroup of Array.isArray(value.groups) ? value.groups : []) {
            const group = String(rawGroup).trim().slice(0, MAX_GROUP_NAME_LENGTH);
            const key = group.toLowerCase();
            if (group && !RESERVED_GROUP_NAMES.has(key) && !seenGroups.has(key)) {
                groups.push(group);
                seenGroups.add(key);
            }
        }
        const allowed = new Set(groups);
        const assignments =
            value.assignments && typeof value.assignments === "object" && !Array.isArray(value.assignments)
                ? Object.fromEntries(
                      Object.entries(value.assignments).filter(
                          ([publisherId, group]) => publisherId && (allowed.has(group) || group === CORE.HIDDEN)
                      )
                  )
                : {};
        const activeGroup =
            groups.includes(value.activeGroup) || value.activeGroup === CORE.UNASSIGNED ? value.activeGroup : null;
        const publisherNames = {};
        if (value.publisherNames && typeof value.publisherNames === "object" && !Array.isArray(value.publisherNames)) {
            for (const [publisherId, name] of Object.entries(value.publisherNames).slice(-MAX_PUBLISHER_NAMES)) {
                if (publisherId && typeof name === "string" && name.trim()) {
                    publisherNames[publisherId] = name.trim().slice(0, 120);
                }
            }
        }

        return {
            // Kept in the user's order (set in Manage); new groups go to the end.
            groups,
            assignments,
            activeGroup,
            // 14 days was removed; a saved 14 becomes the new maximum of 7.
            days: value.days === 14 ? 7 : DAY_OPTIONS.includes(value.days) ? value.days : null,
            width: WIDTHS.includes(value.width) ? value.width : "wide",
            publisherNames,
            publisherAliases:
                value.publisherAliases && typeof value.publisherAliases === "object" && !Array.isArray(value.publisherAliases)
                    ? (() => {
                          const entries = Object.entries(value.publisherAliases).filter(
                              ([alias, canonical]) => alias && typeof canonical === "string" && canonical !== alias
                          );
                          // Merges back saved assignments, so they're never dropped; only "no publication"
                          // results are capped.
                          const merges = entries.filter(([, canonical]) => canonical);
                          const misses = entries.filter(([, canonical]) => !canonical).slice(-MAX_PUBLISHER_NAMES);
                          return Object.fromEntries([...merges, ...misses]);
                      })()
                    : {},
            hiddenPanels: Array.isArray(value.hiddenPanels)
                ? [...new Set(value.hiddenPanels.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim().slice(0, 80)))]
                : [...DEFAULT_HIDDEN_PANELS],
            readPosts: sanitizeReadPosts(value.readPosts),
            hideRead: value.hideRead === true,
            paused: value.paused === true
        };
    }

    function sanitizeReadPosts(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return {};
        }
        const cutoff = Date.now() - READ_MAX_AGE_MS;
        const entries = Object.entries(value)
            .filter(([key, time]) => key && Number.isFinite(time) && time >= cutoff)
            .sort((left, right) => right[1] - left[1])
            .slice(0, READ_MAX_COUNT);
        return Object.fromEntries(entries);
    }

    function setMessage(message, isError) {
        const element = shadow?.getElementById("message");
        if (!element) {
            return;
        }
        element.textContent = message;
        element.dataset.error = isError ? "true" : "false";
    }

    function isReservedGroup(name) {
        return RESERVED_GROUP_NAMES.has(name.toLowerCase());
    }

    function hasDuplicateGroup(name, excludedName = null) {
        return state.groups.some((group) => group !== excludedName && group.toLowerCase() === name.toLowerCase());
    }

    async function updateState(mutator) {
        if (!storageReady) {
            setMessage("Saved groups couldn't be loaded. Reload the page before making changes.", true);
            return false;
        }
        const previous = state;
        const next = structuredClone(state);
        mutator(next);
        state = sanitizeState(next);
        render();

        try {
            // Only changed keys are written, and keyed lists (assignments, names, merges, read marks) only
            // as their changed entries, so another tab's settings aren't overwritten.
            const write = { set: {}, merge: {} };
            for (const [key, value] of Object.entries(state)) {
                if (JSON.stringify(value) === JSON.stringify(previous[key])) {
                    continue;
                }
                if (["assignments", "publisherNames", "publisherAliases", "readPosts"].includes(key)) {
                    write.merge[key] = diffEntries(previous[key], value);
                } else {
                    write.set[key] = value;
                }
            }
            if (Object.keys(write.set).length || Object.keys(write.merge).length) {
                await writeToStorage(write);
            }
            setMessage("", false);
            return true;
        } catch (error) {
            state = previous;
            render();
            setMessage(describeStorageError(error), true);
            return false;
        }
    }

    // Reloading the extension at edge://extensions cuts off the copy already running in open tabs:
    // chrome.runtime.id disappears and every storage call fails until the tab is refreshed.
    function describeStorageError(error) {
        const text = String(error?.message ?? error ?? "");
        if (!globalThis.chrome?.runtime?.id || /context invalidated/i.test(text)) {
            return "The extension was updated. Refresh this page, then try again.";
        }
        return `Couldn't save changes: ${text || "unknown error"}. Refresh the page and try again.`;
    }

    function readInboxPostDay(post, publisherLink) {
        const head = post.querySelector(".reader2-post-head");
        for (const element of head.querySelectorAll("*")) {
            if (element.children.length || publisherLink.contains(element)) {
                continue;
            }
            const postDay = CORE.parsePostDay(element.textContent);
            if (postDay) {
                return postDay;
            }
        }
        return null;
    }

    // Home mixes suggestion carousels ("People to follow") into the feed. They aren't posts, so they're
    // left out of the cards and always hidden. A post has at most one Follow or Subscribe button.
    const SUGGESTION_HEADING = /^(people|writers|publications|creators) (to|you might) (follow|like)|^(recommended|suggested) for you|^who to follow/i;
    function isSuggestionModule(item) {
        let followButtons = 0;
        for (const button of item.querySelectorAll('button, [role="button"]')) {
            if (/^(follow|subscribe)$/i.test(button.textContent.trim()) && ++followButtons >= 2) {
                return true;
            }
        }
        return [...item.querySelectorAll('h1, h2, h3, h4, [role="heading"]')].some((heading) =>
            SUGGESTION_HEADING.test(heading.textContent.trim())
        );
    }

    // Home timestamps carry the full date ("Nov 9, 2026, 1:38 PM") in a title attribute.
    function readHomePostDay(item) {
        for (const element of item.querySelectorAll("[title]")) {
            const postDay = CORE.parsePostDay(element.getAttribute("title"));
            if (postDay) {
                return postDay;
            }
        }
        return null;
    }

    function isCardInDateRange(card) {
        return CORE.isWithinDays(card.postDay, state.days);
    }

    // The writer behind each merged publication, rebuilt only when the aliases change.
    let writerOfCache = { aliases: null, map: new Map() };
    function getWriterOf() {
        if (writerOfCache.aliases !== state.publisherAliases) {
            const map = new Map();
            for (const [alias, canonical] of Object.entries(state.publisherAliases)) {
                if (canonical && alias.startsWith("substack.com/@") && !map.has(canonical)) {
                    map.set(canonical, alias);
                }
            }
            writerOfCache = { aliases: state.publisherAliases, map };
        }
        return writerOfCache.map;
    }

    // A merged entry is listed under the writer's name, with the publication's name as detail.
    function getPublisherDisplay(publisherId, pageName) {
        const publicationName = pageName ?? state.publisherNames[publisherId];
        const writer = getWriterOf().get(publisherId);
        const writerName = writer ? state.publisherNames[writer] : undefined;
        return {
            name: writerName ?? publicationName ?? publisherId,
            detail: writerName && publicationName && publicationName !== writerName ? publicationName : ""
        };
    }

    function getPublishers(currentCards) {
        const items = new Map();
        for (const card of currentCards) {
            for (const publisherId of card.publisherIds) {
                let item = items.get(publisherId);
                if (!item) {
                    item = { id: publisherId, ...getPublisherDisplay(publisherId, card.names[publisherId]), count: 0 };
                    items.set(publisherId, item);
                }
                item.count += 1;
            }
        }
        return [...items.values()].sort((left, right) => left.name.localeCompare(right.name));
    }

    // Every publisher the extension knows (assigned, hidden, or seen before), not only those on the page, so
    // a publication that hasn't posted lately can still be managed. Page counts come from the loaded posts.
    function getKnownPublishers() {
        const items = new Map(publishers.map((publisher) => [publisher.id, publisher]));
        const known = new Set([...Object.keys(state.assignments), ...Object.keys(state.publisherNames)]);
        for (const id of known) {
            const canonical = toCanonicalIds([id])[0];
            if (!items.has(canonical)) {
                items.set(canonical, { id: canonical, ...getPublisherDisplay(canonical), count: 0 });
            }
        }
        return [...items.values()].sort((left, right) => left.name.localeCompare(right.name));
    }

    // Writers and their own publication are one entry: writer ids and publication subdomains map to the
    // writer's main publication.
    function toCanonicalIds(ids) {
        const result = [];
        for (const id of ids) {
            // Follows chains (writer → subdomain → custom domain), stopping on a loop.
            let canonical = id;
            const visited = new Set();
            while (state.publisherAliases[canonical] && !visited.has(canonical)) {
                visited.add(canonical);
                canonical = state.publisherAliases[canonical];
            }
            if (!result.includes(canonical)) {
                result.push(canonical);
            }
        }
        return result;
    }

    // Looks up each new writer's main publication on Substack's public profile API, one at a time and
    // once per writer (results are saved), so a writer and their publication merge in Manage.
    const pendingWriters = new Set();
    let writerLookupRunning = false;
    let writerLookupsBlocked = false;
    function queueWriterLookups(currentCards) {
        if (state.paused || !storageReady || writerLookupsBlocked || !/(^|\.)substack\.com$/.test(location.hostname)) {
            return;
        }
        for (const card of currentCards) {
            for (const id of card.rawIds ?? []) {
                if (id.startsWith("substack.com/@") && !Object.hasOwn(state.publisherAliases, id)) {
                    pendingWriters.add(id);
                }
            }
        }
        if (!writerLookupRunning && pendingWriters.size) {
            void runWriterLookups();
        }
    }

    async function runWriterLookups() {
        writerLookupRunning = true;
        let found = {};
        try {
            for (const writer of pendingWriters) {
                pendingWriters.delete(writer);
                let response;
                try {
                    response = await fetch(`/api/v1/user/${encodeURIComponent(writer.slice("substack.com/@".length))}/public_profile`, {
                        credentials: "include"
                    });
                } catch {
                    continue;
                }
                if (response.status === 429) {
                    // Rate limited: stop for this page load; the rest are looked up next time.
                    writerLookupsBlocked = true;
                    break;
                }
                if (!response.ok && response.status !== 404) {
                    continue;
                }
                let primary = null;
                try {
                    primary = response.ok ? (await response.json())?.primaryPublication : null;
                } catch {
                    primary = null;
                }
                const subdomainHost = primary?.subdomain ? `${primary.subdomain}.substack.com` : null;
                const host = primary?.custom_domain || subdomainHost;
                const publication = host ? CORE.normalizePublisher(`https://${host}`) : null;
                // The subdomain goes first so its group wins over the writer's when both merge into a custom domain.
                if (publication && subdomainHost && CORE.normalizePublisher(`https://${subdomainHost}`) !== publication) {
                    found[CORE.normalizePublisher(`https://${subdomainHost}`)] = publication;
                }
                found[writer] = publication ?? "";
                if (Object.keys(found).length >= 10) {
                    applyPublisherAliases(found);
                    found = {};
                }
                await delay(250);
            }
        } finally {
            writerLookupRunning = false;
            applyPublisherAliases(found);
        }
    }

    function applyPublisherAliases(found) {
        if (!Object.keys(found).length || !storageReady) {
            return;
        }
        // A choice made for the writer carries over to the merged entry when the publication had none.
        const assignments = { ...state.assignments };
        for (const [alias, canonical] of Object.entries(found)) {
            if (canonical && Object.hasOwn(assignments, alias)) {
                if (!Object.hasOwn(assignments, canonical)) {
                    assignments[canonical] = assignments[alias];
                }
                delete assignments[alias];
            }
        }
        state = sanitizeState({ ...state, assignments, publisherAliases: { ...state.publisherAliases, ...found } });
        // The move is decided again by the background writer against what's stored, so an assignment
        // another tab made in the meantime isn't overwritten.
        const write = { merge: { publisherAliases: found } };
        // Always sent: another tab may have assigned the writer since this tab last looked.
        const moves = Object.fromEntries(Object.entries(found).filter(([, canonical]) => canonical));
        if (Object.keys(moves).length) {
            write.moveAssignments = moves;
        }
        writeToStorage(write).catch(() => {});
        lastRefreshKey = "";
        refreshData();
    }

    // Home links articles by website only, so names seen on the Inbox are saved for reuse there.
    function rememberPublisherNames(currentCards) {
        if (!storageReady) {
            return;
        }
        const learned = {};
        for (const card of currentCards) {
            for (const [publisherId, name] of Object.entries(card.names)) {
                if (state.publisherNames[publisherId] !== name) {
                    learned[publisherId] = name;
                }
            }
        }
        if (!Object.keys(learned).length) {
            return;
        }
        state = sanitizeState({ ...state, publisherNames: { ...state.publisherNames, ...learned } });
        writeToStorage({ merge: { publisherNames: learned } }).catch(() => {});
    }

    function setOpenMenu(menu, trigger) {
        if (openMenu?.menu === menu) {
            closeOpenMenu();
            return;
        }
        closeOpenMenu();
        if (menu.hidden) {
            menu.hidden = false;
            trigger.setAttribute("aria-expanded", "true");
            openMenu = { menu, trigger };
            if (menu.classList.contains("publisher-menu")) {
                positionFloatingMenu(menu, trigger);
            }
            (menu.querySelector('[aria-checked="true"]') ?? menu.querySelector("button"))?.focus();
        }
    }

    // Publisher menus sit inside a scrolling list, so they're fixed to the viewport to avoid clipping.
    function positionFloatingMenu(menu, trigger) {
        const rect = trigger.getBoundingClientRect();
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const left = Math.min(Math.max(8, rect.right - width), innerWidth - width - 8);
        const fitsBelow = rect.bottom + 4 + height <= innerHeight - 8;
        const top = fitsBelow ? rect.bottom + 4 : Math.max(8, rect.top - 4 - height);
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
    }

    function closeOpenMenu(restoreFocus = false) {
        if (!openMenu) {
            return;
        }
        openMenu.menu.hidden = true;
        openMenu.trigger.setAttribute("aria-expanded", "false");
        if (restoreFocus) {
            openMenu.trigger.focus();
        }
        openMenu = null;
        if (renderPending) {
            setTimeout(render, 0);
        }
    }

    function wireMenuKeyboard(menu) {
        if (menu.dataset.keyboardBound === "true") {
            return;
        }
        menu.dataset.keyboardBound = "true";
        menu.addEventListener("keydown", (event) => {
            const buttons = [...menu.querySelectorAll("button:not([disabled])")];
            const index = buttons.indexOf(shadow.activeElement);
            if (!buttons.length) {
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                closeOpenMenu(true);
                return;
            }
            let nextIndex = index;
            if (event.key === "ArrowDown") {
                nextIndex = (index + 1 + buttons.length) % buttons.length;
            } else if (event.key === "ArrowUp") {
                nextIndex = (index - 1 + buttons.length) % buttons.length;
            } else if (event.key === "Home") {
                nextIndex = 0;
            } else if (event.key === "End") {
                nextIndex = buttons.length - 1;
            } else {
                return;
            }
            event.preventDefault();
            buttons[nextIndex].focus();
        });
    }

    function getGroupLabel(group) {
        return group === CORE.UNASSIGNED ? "Unassigned" : (group ?? "All publishers");
    }

    function renderFilterMenu() {
        const menu = shadow.getElementById("filter-menu");
        const trigger = shadow.getElementById("filter-trigger");
        trigger.textContent = getGroupLabel(state.activeGroup);
        // A chosen group (not All publishers) is underlined in Substack's orange.
        trigger.classList.toggle("group-chosen", state.activeGroup !== null);
        menu.replaceChildren();

        const datedCards = cards.filter(isCardInDateRange);
        const unassignedCount = countForGroup(datedCards, CORE.UNASSIGNED);
        const options = [null, ...state.groups];
        // Shown only when some posts on the page have no group (or it's the current filter).
        if (unassignedCount > 0 || state.activeGroup === CORE.UNASSIGNED) {
            options.push(CORE.UNASSIGNED);
        }
        for (const value of options) {
            const button = document.createElement("button");
            const count =
                value === CORE.UNASSIGNED ? unassignedCount : countForGroup(datedCards, value);
            button.type = "button";
            button.setAttribute("role", "menuitemradio");
            button.setAttribute("aria-checked", String(state.activeGroup === value));
            button.setAttribute("aria-current", String(state.activeGroup === value));
            if (value === CORE.UNASSIGNED) {
                button.classList.add("unassigned-option");
            }
            button.append(document.createTextNode(getGroupLabel(value)));
            const countElement = document.createElement("span");
            countElement.className = "menu-count";
            countElement.textContent = String(count);
            button.append(countElement);
            button.addEventListener("click", () => {
                closeOpenMenu(true);
                void updateState((next) => {
                    next.activeGroup = value;
                });
            });
            menu.append(button);
        }
        wireMenuKeyboard(menu);
    }

    // Manage: a rail of views (All, Unassigned, each group, Hidden) beside the publishers in the chosen view.
    // A view is typed, so a group named "all" or "hidden" never collides with the built-in views.
    let managerView = { kind: "all" };
    // The inline new-group or rename editor in the rail. Kept across re-renders so a feed refresh
    // doesn't erase what's being typed.
    let railEditor = null;
    // The current drag: { type: "publishers", ids } or { type: "group", group }.
    let drag = null;
    let managerRenderPending = false;
    let movePending = false;
    const GRIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1"></circle><circle cx="15" cy="6" r="1"></circle><circle cx="9" cy="12" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="9" cy="18" r="1"></circle><circle cx="15" cy="18" r="1"></circle></svg>';
    const DOTS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg>';

    function getViewKey(view) {
        return view.kind === "group" ? `group:${view.group}` : view.kind;
    }

    // The stored value a view stands for: null for Unassigned, CORE.HIDDEN for Hidden, the group's name.
    function viewToAssignment(view) {
        if (view.kind === "unassigned") {
            return null;
        }
        if (view.kind === "hidden") {
            return CORE.HIDDEN;
        }
        return view.group;
    }

    function isPublisherInView(publisher, view) {
        if (view.kind === "all") {
            return true;
        }
        return getAssignment(publisher.id) === viewToAssignment(view);
    }

    // A group deleted or renamed elsewhere (import, another tab) falls back to All publishers, except
    // while this tab's own rename of it is saving.
    function reconcileView() {
        if (managerView.kind !== "group" || state.groups.includes(managerView.group)) {
            return;
        }
        if (railEditor?.saving && railEditor.mode === "rename" && railEditor.group === managerView.group) {
            return;
        }
        managerView = { kind: "all" };
    }

    function setManagerView(view) {
        managerView = view;
        clearPublisherSelection();
        renderManager();
    }

    function getScopePublishers() {
        return publisherScope === "all" ? getKnownPublishers() : publishers;
    }

    function isGroupMissing(group) {
        return group !== null && group !== CORE.HIDDEN && !state.groups.includes(group);
    }

    function acceptsDrop(view) {
        if (drag?.type === "publishers") {
            return view.kind !== "all";
        }
        if (drag?.type === "group") {
            return view.kind === "group" && view.group !== drag.group;
        }
        return false;
    }

    function endDrag() {
        drag = null;
        for (const item of shadow?.querySelectorAll(".rail-item.drop") ?? []) {
            item.classList.remove("drop");
        }
        if (managerRenderPending) {
            managerRenderPending = false;
            renderManagerIfChanged();
        }
    }

    function startDrag(event, value) {
        drag = value;
        // Chromium needs some data set for the drag to start; the ids themselves stay in `drag`.
        event.dataTransfer.setData("text/plain", "");
        event.dataTransfer.effectAllowed = "move";
    }

    function renderRail(scopeList) {
        const rail = shadow.getElementById("group-rail");
        const counts = new Map();
        let unassigned = 0;
        let hidden = 0;
        for (const publisher of scopeList) {
            const group = getAssignment(publisher.id);
            if (group === null) {
                unassigned += 1;
            } else if (group === CORE.HIDDEN) {
                hidden += 1;
            } else {
                counts.set(group, (counts.get(group) ?? 0) + 1);
            }
        }
        rail.replaceChildren();
        const addSeparator = () => {
            const separator = document.createElement("div");
            separator.className = "rail-sep";
            rail.append(separator);
        };
        addRailEntry(rail, { kind: "all" }, "All publishers", scopeList.length);
        addRailEntry(rail, { kind: "unassigned" }, "Unassigned", unassigned);
        addSeparator();
        for (const [index, group] of state.groups.entries()) {
            if (railEditor?.mode === "rename" && railEditor.group === group) {
                addRailEditor(rail);
            } else {
                addRailEntry(rail, { kind: "group", group }, group, counts.get(group) ?? 0, index);
            }
        }
        if (railEditor?.mode === "new") {
            addRailEditor(rail);
        } else {
            const add = document.createElement("button");
            add.type = "button";
            add.className = "rail-add";
            add.dataset.focusKey = "rail-add";
            add.textContent = "+ New group";
            add.addEventListener("click", () => {
                railEditor = { mode: "new", draft: "", saving: false };
                renderManager();
            });
            rail.append(add);
        }
        addSeparator();
        addRailEntry(rail, { kind: "hidden" }, "Hidden", hidden);
    }

    function addRailEntry(rail, view, label, count, groupIndex = -1) {
        const isGroup = view.kind === "group";
        const item = document.createElement("div");
        item.className = "rail-item";
        const current = getViewKey(view) === getViewKey(managerView);
        item.classList.toggle("active", current);

        if (isGroup) {
            const grip = document.createElement("span");
            grip.className = "rail-grip";
            grip.draggable = true;
            grip.setAttribute("aria-hidden", "true");
            grip.innerHTML = GRIP;
            grip.addEventListener("dragstart", (event) => startDrag(event, { type: "group", group: view.group }));
            item.append(grip);
        }

        const target = document.createElement("button");
        target.type = "button";
        target.className = "rail-target";
        target.dataset.focusKey = `view:${getViewKey(view)}`;
        target.setAttribute("aria-current", String(current));
        const name = document.createElement("span");
        name.className = "rail-name";
        name.textContent = label;
        const countElement = document.createElement("span");
        countElement.className = "rail-count";
        countElement.textContent = String(count);
        target.append(name, countElement);
        target.addEventListener("click", () => setManagerView(view));
        item.append(target);

        if (isGroup) {
            const menuButton = document.createElement("button");
            menuButton.type = "button";
            menuButton.className = "icon-button rail-menu";
            menuButton.dataset.focusKey = `menu:${view.group}`;
            menuButton.setAttribute("aria-haspopup", "menu");
            menuButton.setAttribute("aria-expanded", "false");
            menuButton.setAttribute("aria-label", `Options for ${view.group}`);
            menuButton.innerHTML = DOTS;
            const menu = document.createElement("div");
            menu.className = "publisher-menu";
            menu.setAttribute("role", "menu");
            menu.setAttribute("aria-label", `Options for ${view.group}`);
            menu.hidden = true;
            menuButton.addEventListener("click", () => {
                buildRailMenu(menu, view.group, groupIndex);
                setOpenMenu(menu, menuButton);
            });
            item.append(menuButton, menu);
        } else {
            // Same width as a group's ⋯ button, so every count lines up in one column.
            const spacer = document.createElement("span");
            spacer.className = "rail-spacer";
            item.append(spacer);
        }

        if (view.kind !== "all") {
            item.addEventListener("dragover", (event) => {
                if (!acceptsDrop(view)) {
                    return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                item.classList.add("drop");
            });
            item.addEventListener("dragleave", (event) => {
                if (!item.contains(event.relatedTarget)) {
                    item.classList.remove("drop");
                }
            });
            item.addEventListener("drop", (event) => {
                event.preventDefault();
                const current = drag;
                const accepted = acceptsDrop(view);
                endDrag();
                if (!accepted) {
                    return;
                }
                if (current.type === "publishers") {
                    void movePublishers(current.ids, viewToAssignment(view));
                } else {
                    reorderGroup(current.group, view.group);
                }
            });
        }
        rail.append(item);
    }

    function buildRailMenu(menu, group, index) {
        menu.replaceChildren();
        const add = (label, onClick, disabled = false, danger = false) => {
            const button = document.createElement("button");
            button.type = "button";
            button.setAttribute("role", "menuitem");
            button.textContent = label;
            button.disabled = disabled;
            if (danger) {
                button.className = "danger-button";
            }
            button.addEventListener("click", () => {
                closeOpenMenu(true);
                onClick();
            });
            menu.append(button);
        };
        add("Rename", () => {
            railEditor = { mode: "rename", group, draft: group, saving: false };
            renderManager();
        });
        add("Move up", () => moveGroupBy(group, -1), index <= 0);
        add("Move down", () => moveGroupBy(group, 1), index >= state.groups.length - 1);
        add("Delete", () => deleteGroup(group), false, true);
        wireMenuKeyboard(menu);
    }

    function moveGroupBy(group, step) {
        void updateState((next) => {
            const from = next.groups.indexOf(group);
            const to = from + step;
            if (from >= 0 && to >= 0 && to < next.groups.length) {
                [next.groups[from], next.groups[to]] = [next.groups[to], next.groups[from]];
            }
        });
    }

    // Dropping a group on another puts it at that group's place.
    function reorderGroup(source, target) {
        let stale = false;
        void updateState((next) => {
            const from = next.groups.indexOf(source);
            const to = next.groups.indexOf(target);
            if (from < 0 || to < 0) {
                stale = true;
                return;
            }
            next.groups.splice(from, 1);
            next.groups.splice(to, 0, source);
        }).then(() => {
            if (stale) {
                setMessage("That group no longer exists.", true);
            }
        });
    }

    function deleteGroup(group) {
        // Counted over every assignment, including publishers not on this page.
        const assigned = Object.values(state.assignments).filter((value) => value === group).length;
        if (assigned && !confirm(`Delete ${group}? Its ${assigned} ${assigned === 1 ? "publisher becomes" : "publishers become"} Unassigned.`)) {
            return;
        }
        void updateState((next) => {
            next.groups = next.groups.filter((item) => item !== group);
            for (const [publisherId, assignedGroup] of Object.entries(next.assignments)) {
                if (assignedGroup === group) {
                    delete next.assignments[publisherId];
                }
            }
            if (next.activeGroup === group) {
                next.activeGroup = null;
            }
        });
    }

    function addRailEditor(rail) {
        const editor = railEditor;
        const item = document.createElement("div");
        item.className = "rail-item rail-editor";
        const input = document.createElement("input");
        input.value = editor.draft;
        input.maxLength = MAX_GROUP_NAME_LENGTH;
        input.disabled = editor.saving;
        input.dataset.focusKey = "rail-editor";
        input.setAttribute("aria-label", editor.mode === "rename" ? `New name for ${editor.group}` : "New group name");
        input.placeholder = "Group name";
        input.addEventListener("input", () => {
            editor.draft = input.value;
        });
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                void saveRailEditor();
            } else if (event.key === "Escape") {
                // Closes the editor only; Manage stays open.
                event.preventDefault();
                event.stopPropagation();
                cancelRailEditor();
            }
        });
        const save = document.createElement("button");
        save.type = "button";
        save.className = "small-button";
        save.textContent = "Save";
        save.disabled = editor.saving;
        save.addEventListener("click", () => void saveRailEditor());
        item.append(input, save);
        rail.append(item);
    }

    function focusByKey(key) {
        if (key) {
            shadow.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus();
        }
    }

    function cancelRailEditor() {
        const editor = railEditor;
        if (!editor || editor.saving) {
            return;
        }
        railEditor = null;
        setMessage("", false);
        renderManager();
        focusByKey(editor.mode === "rename" ? `menu:${editor.group}` : "rail-add");
    }

    async function saveRailEditor() {
        const editor = railEditor;
        if (!editor || editor.saving) {
            return;
        }
        const name = editor.draft.trim().slice(0, MAX_GROUP_NAME_LENGTH);
        const oldName = editor.mode === "rename" ? editor.group : null;
        const error = !name
            ? "Enter a group name."
            : isReservedGroup(name)
              ? "That name is reserved."
              : hasDuplicateGroup(name, oldName)
                ? "A group with that name already exists."
                : "";
        if (error) {
            setMessage(error, true);
            focusByKey("rail-editor");
            return;
        }
        if (name === oldName) {
            cancelRailEditor();
            return;
        }
        const priorView = managerView;
        editor.saving = true;
        let stale = false;
        const saved = await updateState((next) => {
            if (oldName === null) {
                next.groups.push(name);
                return;
            }
            if (!next.groups.includes(oldName)) {
                stale = true;
                return;
            }
            next.groups = next.groups.map((group) => (group === oldName ? name : group));
            for (const publisherId of Object.keys(next.assignments)) {
                if (next.assignments[publisherId] === oldName) {
                    next.assignments[publisherId] = name;
                }
            }
            if (next.activeGroup === oldName) {
                next.activeGroup = name;
            }
        });
        if (railEditor !== editor) {
            return;
        }
        if (saved && !stale && state.groups.includes(name)) {
            railEditor = null;
            managerView = { kind: "group", group: name };
            clearPublisherSelection();
            renderManager();
            focusByKey(`view:group:${name}`);
            return;
        }
        if (stale) {
            railEditor = null;
            renderManager();
            setMessage("That group no longer exists.", true);
            return;
        }
        editor.saving = false;
        managerView = priorView;
        renderManager();
        focusByKey("rail-editor");
    }

    // Manage's publisher list: this page's publishers or every known one, in the chosen view, with search,
    // selection for bulk edits, and a row cap so a long list stays quick. Group menus are built when opened.
    const PUBLISHER_ROW_LIMIT = 200;
    let publisherScope = "page";
    const selectedPublishers = new Set();
    // Bumped on every deliberate selection change, so a failed move only restores a selection the user
    // hasn't changed since.
    let selectionRevision = 0;
    function clearPublisherSelection() {
        selectedPublishers.clear();
        selectionRevision += 1;
    }
    const EYE_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.7 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"></path></svg>';

    function getAssignment(publisherId) {
        return Object.hasOwn(state.assignments, publisherId) ? state.assignments[publisherId] : null;
    }

    // A move to a group that no longer exists (deleted in another tab) changes nothing.
    function setAssignments(ids, group) {
        return updateState((next) => {
            if (group !== null && group !== CORE.HIDDEN && !next.groups.includes(group)) {
                return;
            }
            for (const id of ids) {
                const canonical = toCanonicalIds([id])[0];
                if (group === null) {
                    delete next.assignments[canonical];
                } else {
                    next.assignments[canonical] = group;
                }
            }
        });
    }

    // Bulk moves and drops. The live selection keeps tracking visible rows while the write is pending;
    // a failed write restores the selected ids that are visible again after the rollback.
    async function movePublishers(ids, group) {
        if (movePending || !ids.length) {
            return false;
        }
        if (isGroupMissing(group)) {
            setMessage("That group no longer exists.", true);
            return false;
        }
        const snapshot = [...selectedPublishers];
        const revision = selectionRevision;
        movePending = true;
        renderBulkBar();
        const saved = await setAssignments(ids, group);
        movePending = false;
        const stale = saved && isGroupMissing(group);
        if (saved && !stale) {
            for (const id of ids) {
                selectedPublishers.delete(id);
            }
        } else if (revision === selectionRevision) {
            for (const id of snapshot) {
                selectedPublishers.add(id);
            }
        }
        if (shadow && !shadow.getElementById("manager").hidden) {
            renderManager();
        }
        if (stale) {
            setMessage("That group no longer exists.", true);
        }
        return saved && !stale;
    }

    function buildGroupMenu(menu, selectedGroup, onPick, includeHidden = false) {
        menu.replaceChildren();
        for (const group of [...state.groups, null, ...(includeHidden ? [CORE.HIDDEN] : [])]) {
            const button = document.createElement("button");
            button.type = "button";
            button.setAttribute("role", "menuitemradio");
            button.setAttribute("aria-checked", String(selectedGroup === group));
            button.setAttribute("aria-current", String(selectedGroup === group));
            button.textContent = group === null ? "Unassigned" : group === CORE.HIDDEN ? "Hidden" : group;
            button.addEventListener("click", () => {
                closeOpenMenu(true);
                onPick(group);
            });
            menu.append(button);
        }
        wireMenuKeyboard(menu);
    }

    function renderBulkBar() {
        const bar = shadow.getElementById("bulk-bar");
        bar.hidden = selectedPublishers.size === 0;
        shadow.getElementById("bulk-count").textContent = `${selectedPublishers.size} selected`;
        shadow.getElementById("bulk-move").disabled = movePending;
    }

    function renderPublisherList(source = getScopePublishers()) {
        const list = shadow.getElementById("publisher-list");
        const query = shadow.getElementById("publisher-search").value.trim().toLocaleLowerCase();
        list.replaceChildren();
        for (const button of shadow.querySelectorAll("#publisher-scope button")) {
            button.setAttribute("aria-pressed", String(button.dataset.scope === publisherScope));
        }
        const inView = source.filter((publisher) => isPublisherInView(publisher, managerView));
        const visible = inView.filter(
            (publisher) =>
                publisher.name.toLocaleLowerCase().includes(query) || publisher.detail.toLocaleLowerCase().includes(query)
        );
        const rows = visible.slice(0, PUBLISHER_ROW_LIMIT);
        // Bulk actions and drags only ever act on publishers the user can see.
        const shown = new Set(rows.map((publisher) => publisher.id));
        for (const id of selectedPublishers) {
            if (!shown.has(id)) {
                selectedPublishers.delete(id);
            }
        }
        renderBulkBar();
        if (!rows.length) {
            const empty = document.createElement("p");
            empty.className = "empty";
            empty.textContent = inView.length
                ? "No publishers match that search."
                : managerView.kind === "group"
                  ? `No publishers in ${managerView.group} yet. Drag publishers onto it in the list on the left, or use Move to.`
                  : managerView.kind === "unassigned"
                    ? "Every publisher here is in a group."
                    : managerView.kind === "hidden"
                      ? "No hidden publishers."
                      : publisherScope === "all"
                        ? "No publishers known yet."
                        : adapter?.name === "home"
                          ? "No linked articles or Notes on this page yet."
                          : "No publishers found on this page.";
            list.append(empty);
            return;
        }

        for (const publisher of rows) {
            const row = document.createElement("div");
            row.className = "publisher-row";
            const selectedGroup = getAssignment(publisher.id);
            const isHidden = selectedGroup === CORE.HIDDEN;
            row.dataset.hidden = String(isHidden);

            const check = document.createElement("input");
            check.type = "checkbox";
            check.checked = selectedPublishers.has(publisher.id);
            check.dataset.focusKey = `check:${publisher.id}`;
            check.setAttribute("aria-label", `Select ${publisher.name}`);
            check.addEventListener("change", () => {
                if (check.checked) {
                    selectedPublishers.add(publisher.id);
                } else {
                    selectedPublishers.delete(publisher.id);
                }
                selectionRevision += 1;
                renderBulkBar();
            });

            // The name block is the drag handle: a checked row drags the whole selection.
            const detail = document.createElement("div");
            detail.className = "publisher-detail";
            detail.draggable = true;
            detail.addEventListener("dragstart", (event) => {
                if (movePending) {
                    event.preventDefault();
                    return;
                }
                const ids = selectedPublishers.has(publisher.id) ? [...selectedPublishers] : [publisher.id];
                startDrag(event, { type: "publishers", ids });
            });
            const name = document.createElement("span");
            name.className = "publisher-name";
            name.textContent = publisher.name;
            const count = document.createElement("span");
            count.className = "muted";
            const posts = publisher.count ? `${publisher.count} ${publisher.count === 1 ? "post" : "posts"}` : "No posts on this page";
            count.textContent = `${publisher.detail ? `${publisher.detail} · ` : ""}${posts}`;
            detail.append(name, count);

            const assignment = document.createElement("div");
            assignment.className = "assignment";
            const trigger = document.createElement("button");
            trigger.className = "small-button";
            trigger.type = "button";
            trigger.dataset.focusKey = `group:${publisher.id}`;
            trigger.textContent = isHidden ? "Hidden" : (selectedGroup ?? "Unassigned");
            trigger.setAttribute("aria-haspopup", "menu");
            trigger.setAttribute("aria-expanded", "false");
            trigger.setAttribute("aria-label", `Group for ${publisher.name}`);
            const menu = document.createElement("div");
            menu.className = "publisher-menu";
            menu.setAttribute("role", "menu");
            menu.setAttribute("aria-label", `Choose a group for ${publisher.name}`);
            menu.hidden = true;
            trigger.addEventListener("click", () => {
                // Built on first open: a list of hundreds of rows would otherwise build thousands of buttons.
                if (!menu.childElementCount) {
                    buildGroupMenu(menu, selectedGroup, (group) => void setAssignments([publisher.id], group));
                }
                setOpenMenu(menu, trigger);
            });
            assignment.append(trigger, menu);

            // One-click hide; showing again returns the publisher to Unassigned.
            const hideButton = document.createElement("button");
            hideButton.type = "button";
            hideButton.className = "icon-button hide-toggle";
            hideButton.dataset.focusKey = `hide:${publisher.id}`;
            hideButton.setAttribute("aria-pressed", String(isHidden));
            hideButton.setAttribute("aria-label", `${isHidden ? "Show" : "Hide"} ${publisher.name}`);
            hideButton.innerHTML = isHidden ? EYE_OPEN : EYE_OFF;
            hideButton.addEventListener("click", () => {
                closeOpenMenu();
                void setAssignments([publisher.id], isHidden ? null : CORE.HIDDEN);
            });
            row.append(check, detail, assignment, hideButton);
            list.append(row);
        }
        if (visible.length > PUBLISHER_ROW_LIMIT) {
            const note = document.createElement("p");
            note.className = "list-note";
            note.textContent = `Showing ${PUBLISHER_ROW_LIMIT} of ${visible.length}. Search to find others.`;
            list.append(note);
        }
    }

    function renderManager() {
        reconcileView();
        managerSignature = getManagerSignature();
        // Rebuilding resets scroll positions and drops focus, so both are restored by key.
        const focusKey = shadow.activeElement?.dataset?.focusKey;
        const editorInput = shadow.querySelector('[data-focus-key="rail-editor"]');
        const caret = editorInput && shadow.activeElement === editorInput ? editorInput.selectionStart : null;
        const scrollers = [shadow.getElementById("manager"), shadow.getElementById("group-rail"), shadow.getElementById("publisher-list")];
        const positions = scrollers.map((element) => element.scrollTop);
        shadow.getElementById("publisher-count").textContent = `${publishers.length} ${publishers.length === 1 ? "publisher" : "publishers"}`;
        const scopeList = getScopePublishers();
        renderRail(scopeList);
        renderPublisherList(scopeList);
        scrollers.forEach((element, index) => {
            element.scrollTop = positions[index];
        });
        if (railEditor && !railEditor.saving && (!focusKey || focusKey === "rail-editor" || focusKey.startsWith("menu:") || focusKey === "rail-add")) {
            const input = shadow.querySelector('[data-focus-key="rail-editor"]');
            input?.focus();
            const position = caret ?? input?.value.length ?? 0;
            input?.setSelectionRange(position, position);
        } else {
            focusByKey(focusKey);
        }
    }

    // Home's videos change the page several times a second, and each change refreshes the data. Rebuilding
    // hundreds of rows on every refresh made the open list stutter, so it rebuilds only when its content changes.
    let managerSignature = "";
    function getManagerSignature() {
        return JSON.stringify([
            publishers.map((publisher) => [publisher.id, publisher.name, publisher.count]),
            state.groups,
            state.assignments,
            getViewKey(managerView),
            publisherScope,
            publisherScope === "all" ? [state.publisherNames, state.publisherAliases] : null
        ]);
    }

    function renderManagerIfChanged() {
        // A rebuild mid-drag would replace the dragged row and the drop targets; it runs when the drag ends.
        if (drag) {
            managerRenderPending = true;
            return;
        }
        if (getManagerSignature() !== managerSignature) {
            renderManager();
        }
    }

    // Writing an unchanged attribute still makes the browser restyle, which adds up on a long feed.
    function setData(element, key, value) {
        if (element.dataset[key] !== value) {
            element.dataset[key] = value;
        }
    }

    // Substack adds skeletons and spinners to the feed list while it loads. With a filter on, they're
    // marked hidden directly; a CSS :has() rule doing the same re-checked the whole feed on every change.
    function markFeedExtras() {
        if (!feed) {
            return;
        }
        const filtering = isFiltering();
        // A holder is the feed child wrapping a post (the Inbox's 1px bordered "visibility-check" div).
        // When none of its posts are shown it's hidden too, or hundreds of empty borders stack into grey bands.
        const holders = new Map();
        for (const card of cards) {
            const holder = getChildContaining(feed, card.container);
            if (holder) {
                const shown = card.container.dataset.substackOrganizerHidden === "false";
                holders.set(holder, Boolean(holders.get(holder)) || shown);
            }
        }
        const containers = new Set(cards.map((card) => card.container));
        for (const child of feed.children) {
            if (child === appRoot || child.id === EMPTY_MESSAGE_ID) {
                continue;
            }
            // Clear the marker on post holders too: an earlier pass (before posts were read) may have set it.
            // A child that is itself a post (Home) is handled by its own hidden marker.
            const isWrapperOfHiddenPosts = holders.has(child) && !containers.has(child) && !holders.get(child);
            const hide = filtering && (!holders.has(child) || isWrapperOfHiddenPosts);
            setData(child, "substackOrganizerExtra", hide ? "hidden" : "");
            // Suggestion carousels are hidden on both pages, filter or not.
            if (!holders.has(child) && child.dataset.substackOrganizerSuggestion !== "true" && isSuggestionModule(child)) {
                setData(child, "substackOrganizerSuggestion", "true");
            }
        }
    }

    // Any group, date range or hidden publisher counts as filtering, on every page.
    function isFiltering() {
        return !state.paused && (Boolean(state.activeGroup) || state.days !== null || state.hideRead || Object.values(state.assignments).includes(CORE.HIDDEN));
    }

    // When the group or date filter changes, the posts now on screen fade in instead of snapping.
    // Only posts near the viewport animate, so long feeds stay cheap.
    function fadeInOnFilterChange() {
        const key = `${state.activeGroup}|${state.days}`;
        const changed = (lastFilterKey !== null && key !== lastFilterKey) || fadeAfterLoad;
        lastFilterKey = key;
        if (!changed || loadRun || matchMedia("(prefers-reduced-motion: reduce)").matches) {
            return;
        }
        fadeAfterLoad = false;
        let animated = 0;
        for (const card of cards) {
            if (animated >= 12) {
                break;
            }
            const target = getChildContaining(feed, card.container) ?? card.container;
            const box = target.getBoundingClientRect();
            // Cards are in page order, so nothing past the bottom of the screen needs measuring.
            if (box.top > innerHeight) {
                break;
            }
            if (!box.height || box.bottom < 0) {
                continue;
            }
            target.animate(
                [
                    { opacity: 0, transform: "translateY(6px)" },
                    { opacity: 1, transform: "none" }
                ],
                { duration: 280, delay: animated * 25, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)", fill: "backwards" }
            );
            animated += 1;
        }
    }

    // A filter with no matching posts shows a message instead of a blank page.
    // Shown in the extension's own bar (not inside Substack's feed) when a filter matches no posts.
    const EMPTY_MESSAGE_ID = "substack-organizer-empty";
    function updateEmptyMessage(visibleCount) {
        const note = shadow?.getElementById("empty-note");
        if (!note) {
            return;
        }
        const empty = !loadRun && Boolean(feed) && cards.length > 0 && isFiltering() && visibleCount === 0;
        note.hidden = !empty;
        if (empty) {
            note.textContent = state.hideRead
                ? "No unread posts match this group and date range. Turn off Hide read posts in the gear menu to see read ones."
                : "No posts match this group and date range. Try another group or a longer range.";
        }
    }

    function applyFilter() {
        // Paused: every post shows as Substack drew it (no filter, labels, dimming or duplicate hiding).
        if (state.paused) {
            for (const card of cards) {
                cardByContainer.set(card.container, card);
                setData(card.container, "substackOrganizerHidden", "false");
                setData(card.container, "substackOrganizerCard", "");
                setData(card.container, "substackOrganizerRead", "false");
                setData(card.container, "substackOrganizerGroup", "");
                if (card.item && card.item !== card.container) {
                    setData(card.item, "substackOrganizerHidden", "false");
                }
            }
            delete document.documentElement.dataset.substackOrganizerFiltering;
            markFeedExtras();
            updateEmptyMessage(cards.length);
            shadow.getElementById("post-count").textContent = "Paused";
            shadow.getElementById("stop-loading").hidden = true;
            return;
        }
        let visibleCount = 0;
        const matching = cards.filter(
            (card) =>
                CORE.isPublisherVisible(card.publisherIds, state.activeGroup, state.assignments) &&
                isCardInDateRange(card) &&
                !(state.hideRead && isCardRead(card))
        );
        const matchingSet = new Set(matching);
        const duplicates = findDuplicateArticles(matching);
        // Group labels show only in All publishers, where posts from different groups mix.
        const showLabels = state.activeGroup === null && state.groups.length > 0;
        for (const card of cards) {
            const visible = matchingSet.has(card) && !duplicates.has(card);
            cardByContainer.set(card.container, card);
            setData(card.container, "substackOrganizerHidden", String(!visible));
            setData(card.container, "substackOrganizerCard", "");
            setData(card.container, "substackOrganizerRead", String(isCardRead(card)));
            setData(card.container, "substackOrganizerGroup", showLabels ? getCardGroup(card) : "");
            // A Home item wrapped in its own container is matched by the CSS directly, so mark it too.
            if (card.item && card.item !== card.container) {
                setData(card.item, "substackOrganizerHidden", String(!visible));
            }
            if (visible) {
                visibleCount += 1;
            }
        }
        updateEmptyMessage(visibleCount);
        markFeedExtras();
        fadeInOnFilterChange();
        const total = countUniquePosts(cards);
        const filtering = isFiltering();
        if (filtering) {
            document.documentElement.dataset.substackOrganizerFiltering = "";
        } else {
            delete document.documentElement.dataset.substackOrganizerFiltering;
        }
        const countText = filtering ? `${visibleCount} of ${total} posts` : `${total} posts`;
        shadow.getElementById("post-count").textContent = loadRun ? `Loading posts… ${total} checked` : countText;
        shadow.getElementById("stop-loading").hidden = !loadRun;
    }

    function delay(milliseconds) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    // The group a post belongs to, for its label: the first of its publishers that's in a group.
    function getCardGroup(card) {
        for (const id of card.publisherIds) {
            const group = Object.hasOwn(state.assignments, id) ? state.assignments[id] : null;
            if (group && group !== CORE.HIDDEN) {
                return group;
            }
        }
        return "";
    }

    // With Any time, Substack's own scrolling loads posts. A date range loads in the background until
    // the range is covered; a shorter range than one already loaded only re-filters.
    function isLoadingWanted() {
        return !state.paused && getRouteAdapter() === adapter && Boolean(adapter?.loadLimit) && !feedFullyLoaded && state.days !== null && state.days > loadedDays;
    }

    function getLoadKey() {
        return `${adapter?.name ?? ""}:${state.days}`;
    }

    // Counting elements is enough to see that a batch arrived; reading every post here ran 5 times a second.
    function countLoadedCards() {
        return adapter && feed ? feed.querySelectorAll(adapter.itemSelector).length : 0;
    }

    // Substack loads the next page from a scroll handler when the page bottom is in view. Hiding the
    // posts keeps the page short, so a synthetic scroll event loads more without moving the view.
    async function requestMorePosts(run) {
        const previousCount = countLoadedCards();
        globalThis.dispatchEvent(new Event("scroll"));
        document.dispatchEvent(new Event("scroll"));
        for (let waited = 0; waited < 1500 && !run.stopped; waited += 200) {
            await delay(200);
            if (countLoadedCards() > previousCount) {
                await delay(300);
                return true;
            }
        }
        return false;
    }

    // The feeds are only roughly in date order (Home mixes in older posts, the Inbox sorts by Priority).
    // A set of posts counts as past the range when at least 3 have a readable date and fewer than a
    // quarter of those are in range.
    function isPastRange(list) {
        const dated = list.filter((card) => card.postDay);
        return dated.length >= 3 && dated.filter(isCardInDateRange).length < dated.length / 4;
    }

    // Loads only as far as the date range: it stops at the first batch that's mostly older than the
    // range, at the end of the feed, or at the adapter's limit.
    async function loadDateRange() {
        if (!isLoadingWanted() || !adapter || !feed || loadRun) {
            return;
        }
        const rangeKey = getLoadKey();
        if (loadedRangeKey === rangeKey) {
            return;
        }
        const runDays = state.days;
        // The last posts already on the page may cover the range, in which case nothing needs loading.
        if (isPastRange(cards.slice(-10))) {
            loadedRangeKey = rangeKey;
            loadedDays = Math.max(loadedDays, runDays);
            revealWhenSettled();
            return;
        }
        const run = { stopped: false, days: runDays };
        loadRun = run;
        const savedScroll = scrollY;
        document.documentElement.dataset.substackOrganizerLoading = "";
        applyFilter();
        let pastRangeBatches = 0;
        let failedRequests = 0;
        try {
            // 2 batches in a row past the range, so a single batch of older suggested posts doesn't end it early.
            // The cap counts every post on the page, including hidden duplicates: they still carry videos.
            while (!run.stopped && failedRequests < 2 && pastRangeBatches < 2 && countLoadedCards() < adapter.loadLimit) {
                const before = new Set(cards.map((card) => card.container));
                if (!(await requestMorePosts(run))) {
                    failedRequests += 1;
                    continue;
                }
                failedRequests = 0;
                if (loadRun !== run || !appRoot) {
                    return;
                }
                refreshData();
                // The group doesn't count here, so one load covers the range for every group.
                pastRangeBatches = isPastRange(cards.filter((card) => !before.has(card.container))) ? pastRangeBatches + 1 : 0;
            }
            if (!run.stopped) {
                loadedDays = Math.max(loadedDays, runDays);
            }
            // At the cap, later ranges only re-filter. A timeout doesn't count: it can be a slow response.
            if (!run.stopped && countLoadedCards() >= adapter.loadLimit) {
                feedFullyLoaded = true;
            }
        } finally {
            if (loadRun === run) {
                loadRun = null;
                // A stopped run hasn't covered its range, so choosing the range again loads it.
                loadedRangeKey = run.stopped ? null : rangeKey;
                fadeAfterLoad = !document.documentElement.hasAttribute("data-substack-organizer-booting");
                delete document.documentElement.dataset.substackOrganizerLoading;
                scrollTo(0, savedScroll);
                if (appRoot) {
                    refreshData();
                }
                revealPage();
                // A group switch made during the load selects its newest post now that posts are shown.
                if (appRoot && state.activeGroup !== renderedGroup) {
                    render();
                }
            }
        }
    }

    // Ends the page-load overlay set by width-early.js; the content fades in via CSS.
    function revealPage() {
        clearTimeout(settleTimer);
        settleTimer = null;
        navFirstItem = null;
        delete document.documentElement.dataset.substackOrganizerBooting;
    }

    // Substack draws a feed in steps (a few posts, then the rest), so lifting the overlay on the first posts
    // showed a half-drawn page. This waits until the post count stops growing for 300ms (at most 3s).
    let settleTimer = null;
    let navFirstItem = null;
    let navPostCount = -1;
    function revealWhenSettled() {
        if (!document.documentElement.hasAttribute("data-substack-organizer-booting") || settleTimer) {
            return;
        }
        const started = performance.now();
        let lastCount = -1;
        let stableSince = started;
        const navCount = navPostCount;
        const check = () => {
            const count = countLoadedCards();
            const now = performance.now();
            if (count !== lastCount) {
                lastCount = count;
                stableSince = now;
            }
            // The new page counts as drawn once its posts differ from the previous page's (a new first
            // post or a different count). An empty feed counts once it has stayed empty for a second.
            const firstItem = feed && adapter ? feed.querySelector(adapter.itemSelector) : null;
            const replaced = !navFirstItem || (firstItem && firstItem !== navFirstItem) || count !== navCount;
            const settled = count > 0 ? now - stableSince >= 300 : now - stableSince >= 1000;
            if ((replaced && settled) || now - started >= 3000) {
                revealPage();
                return;
            }
            settleTimer = setTimeout(check, 100);
        };
        settleTimer = setTimeout(check, 100);
    }

    function stopLoading() {
        if (!loadRun) {
            return;
        }
        loadRun.stopped = true;
    }

    // Set by the Stop button, so the stopped range isn't reloaded automatically; picking a date clears it.
    let stoppedRangeKey = null;

    // The right sidebar holds titled panels ("Subscriptions", "Recommended for you"), one per wrapper.
    function findSidebarPanels() {
        const sidebar = document.querySelector(".reader2-inbox-sidebar");
        if (!sidebar) {
            return [];
        }
        const panels = [];
        for (const wrapper of sidebar.children) {
            const title = wrapper.querySelector('[class*="weight-semibold"]')?.textContent?.trim();
            if (title && !panels.some((panel) => panel.title === title)) {
                panels.push({ title, wrapper });
            }
        }
        return panels;
    }

    function applySidebarPanels() {
        sidebarPanels = findSidebarPanels();
        for (const panel of sidebarPanels) {
            const hidden = String(!state.paused && state.hiddenPanels.includes(panel.title));
            if (panel.wrapper.dataset.substackOrganizerPanelHidden !== hidden) {
                panel.wrapper.dataset.substackOrganizerPanelHidden = hidden;
            }
        }
    }

    // The gear menu holds the set-once choices: Manage groups, feed width and sidebar panels.
    function renderSettingsMenu() {
        applySidebarPanels();
        const menu = shadow.getElementById("settings-menu");
        menu.replaceChildren();
        const addHeading = (text) => {
            const separator = document.createElement("div");
            separator.className = "menu-separator";
            const heading = document.createElement("div");
            heading.className = "menu-heading";
            heading.textContent = text;
            menu.append(separator, heading);
        };
        const addItem = (role, label, hint, checked, onClick) => {
            const button = document.createElement("button");
            button.type = "button";
            button.setAttribute("role", role);
            if (checked !== null) {
                button.setAttribute("aria-checked", String(checked));
                button.setAttribute("aria-current", String(checked));
            }
            button.append(document.createTextNode(label));
            if (hint) {
                const span = document.createElement("span");
                span.className = "menu-count";
                span.textContent = hint;
                button.append(span);
            }
            button.addEventListener("click", onClick);
            menu.append(button);
        };

        addItem("menuitem", "Manage groups", "", null, () => {
            closeOpenMenu();
            setManagerOpen?.(true);
        });
        addItem("menuitem", "Keyboard shortcuts", "?", null, () => {
            closeOpenMenu();
            setShortcutsOpen?.(true);
        });
        addItem("menuitem", "Pause organizer", "", null, () => {
            closeOpenMenu();
            setPaused(true);
        });
        addHeading("Read posts");
        addItem("menuitemcheckbox", "Hide read posts", "", state.hideRead, () => {
            closeOpenMenu(true);
            void updateState((next) => {
                next.hideRead = !next.hideRead;
            });
        });
        addItem("menuitem", "Mark shown as read", "", null, () => {
            closeOpenMenu(true);
            const shown = cards.filter((card) => card.container.dataset.substackOrganizerHidden === "false");
            lastMarkedRead = setCardsRead(shown, true);
            renderSettingsMenu();
        });
        const undoCount = Object.keys(lastMarkedRead).length;
        if (undoCount) {
            addItem("menuitem", "Undo mark as read", String(undoCount), null, () => {
                closeOpenMenu(true);
                undoMarkRead(lastMarkedRead);
                lastMarkedRead = {};
                renderSettingsMenu();
            });
        }
        if (isWidthSupported()) {
            addHeading("Width");
            for (const width of WIDTHS) {
                addItem("menuitemradio", WIDTH_LABELS[width], WIDTH_HINTS[width], state.width === width, () => {
                    closeOpenMenu(true);
                    void updateState((next) => {
                        next.width = width;
                    });
                });
            }
        }
        if (sidebarPanels.length) {
            addHeading("Sidebar");
            for (const panel of sidebarPanels) {
                const shown = !state.hiddenPanels.includes(panel.title);
                addItem("menuitemcheckbox", panel.title, shown ? "Shown" : "Hidden", shown, () => {
                    closeOpenMenu(true);
                    void updateState((next) => {
                        next.hiddenPanels = shown
                            ? [...next.hiddenPanels, panel.title]
                            : next.hiddenPanels.filter((title) => title !== panel.title);
                    });
                });
            }
        }
        wireMenuKeyboard(menu);
    }

    function setPaused(paused) {
        if (paused && loadRun) {
            stopLoading?.();
        }
        void updateState((next) => {
            next.paused = paused;
        });
    }

    function renderDaysControl() {
        const control = shadow.getElementById("days-control");
        let selected = null;
        for (const button of control.querySelectorAll("button")) {
            const days = button.dataset.days ? Number(button.dataset.days) : null;
            const pressed = state.days === days;
            button.setAttribute("aria-pressed", String(pressed));
            if (pressed) {
                selected = button;
            }
        }
        // The fill slides between options; the CSS transition animates the change. Measuring forces a
        // layout of the whole page, so it happens only when the selection changes.
        const fill = control.querySelector(".seg-fill");
        if (selected && fill.dataset.days !== String(state.days)) {
            // Not laid out yet (just created, or hidden): the ResizeObserver measures again once it has a size.
            if (!selected.offsetWidth) {
                return;
            }
            fill.style.left = `${selected.offsetLeft}px`;
            fill.style.width = `${selected.offsetWidth}px`;
            fill.dataset.days = String(state.days);
        }
    }

    function render() {
        if (!shadow) {
            return;
        }
        appRoot.dataset.theme = resolveSubstackTheme();
        // A run loads for one date range; a different range stops it and starts its own. Pausing (here or
        // in another tab) stops it too.
        if (loadRun && (loadRun.days !== state.days || state.paused)) {
            stopLoading();
        }
        // Pausing closes any open menu and the Note overlay, so the page returns to Substack's own look at once.
        if (state.paused) {
            closeNoteOverlay();
            if (openMenu) {
                closeOpenMenu();
            }
        }
        // Rebuilding an open menu replaces the item under the pointer, so wait until it closes.
        if (openMenu) {
            renderPending = true;
            applyFilter();
            return;
        }
        renderPending = false;
        const hidingRead = state.hideRead && !state.paused;
        shadow.getElementById("gear-dot").hidden = !hidingRead;
        shadow.getElementById("settings-trigger").setAttribute("aria-label", hidingRead ? "Settings (read posts hidden)" : "Settings");
        if (state.paused) {
            // Nothing of the organizer's stays on the page: no overlay or selection outline.
            if (document.documentElement.hasAttribute("data-substack-organizer-booting")) {
                revealPage();
            }
            selectCard(null);
        }
        renderWidth();
        renderFilterMenu();
        renderDaysControl();
        renderSettingsMenu();
        if (!shadow.getElementById("manager").hidden) {
            renderManagerIfChanged();
        }
        applyFilter();
        // Switching groups selects that group's newest post, so j/k continue from the top. During a
        // background load the posts are hidden, so this waits until the load ends.
        if (state.activeGroup !== renderedGroup && !loadRun) {
            const changed = renderedGroup !== undefined;
            renderedGroup = state.activeGroup;
            if (changed && !state.paused) {
                const first = getVisibleCards()[0];
                if (first) {
                    selectCard(first);
                } else {
                    selectCard(null);
                    scrollTo({ top: 0 });
                }
            }
        }
        // A range the user stopped stays stopped until they pick a date again.
        const loadKey = getLoadKey();
        if (isLoadingWanted() && !loadRun && loadedRangeKey !== loadKey && stoppedRangeKey !== loadKey) {
            // Deferred so a render inside the loader's own refresh doesn't start a second run.
            setTimeout(() => void loadDateRange(), 0);
        }
    }

    function renderWidth() {
        const root = document.documentElement;
        // Paused: Substack's own width, and a marker the CSS and the early script use to stay out of the way.
        if (state.paused) {
            delete root.dataset.substackOrganizerWidth;
            root.dataset.substackOrganizerPaused = "";
        } else {
            delete root.dataset.substackOrganizerPaused;
            if (root.dataset.substackOrganizerWidth !== state.width) {
                root.dataset.substackOrganizerWidth = state.width;
            }
        }
        appRoot?.toggleAttribute("data-paused", state.paused);
        const resume = shadow?.getElementById("resume");
        if (resume) {
            resume.hidden = !state.paused;
        }
        try {
            if ((localStorage.getItem("substackOrganizerPaused") === "1") !== state.paused) {
                localStorage.setItem("substackOrganizerPaused", state.paused ? "1" : "0");
            }
        } catch {
            // The early script then assumes not paused.
        }
        if (readCachedWidth() !== state.width) {
            cacheWidth(state.width);
        }
    }

    // width-early.js reads this synchronous copy before first paint; extension storage is async.
    function cacheWidth(width) {
        try {
            localStorage.setItem(WIDTH_CACHE_KEY, width);
        } catch {
            // The early script falls back to the default width.
        }
    }

    function readCachedWidth() {
        try {
            const cached = localStorage.getItem(WIDTH_CACHE_KEY);
            return WIDTHS.includes(cached) ? cached : "wide";
        } catch {
            return "wide";
        }
    }

    // Substack toggles a dark-mode class on <html> from its own appearance setting.
    function resolveSubstackTheme() {
        return document.documentElement.classList.contains("dark-mode") ? "dark" : "light";
    }

    let lastRefreshKey = "";
    function refreshData() {
        if (!appRoot || !appRoot.isConnected || !adapter) {
            return;
        }
        cards = adapter.getCards(feed);
        // Most refreshes find the same posts; rebuilding the menus and re-filtering then does nothing useful.
        // Posts Substack re-rendered into new elements lack the extension's marker, so they force a pass.
        const refreshKey = `${Boolean(loadRun)}|${cards.map((card) => `${card.publisherIds.join(",")}:${card.postDay?.getTime() ?? ""}:${getPostKey(card).key ?? ""}`).join("|")}`;
        const unmarked = cards.some((card) => card.container.dataset.substackOrganizerCard === undefined);
        if (refreshKey === lastRefreshKey && !renderPending && !unmarked) {
            return;
        }
        lastRefreshKey = refreshKey;
        rememberPublisherNames(cards);
        queueWriterLookups(cards);
        publishers = getPublishers(cards);
        markWidthColumn();
        render();
    }

    // The Inbox column is styled by class in content.css; other pages mark theirs at runtime.
    function markWidthColumn() {
        const column = adapter.findColumn(feed);
        if (column === markedColumn) {
            return;
        }
        if (markedColumn) {
            delete markedColumn.dataset[COLUMN_ATTRIBUTE];
        }
        markedColumn = column;
        if (column) {
            column.dataset[COLUMN_ATTRIBUTE] = "";
        }
    }

    function isWidthSupported() {
        return adapter?.name === "inbox" || Boolean(markedColumn);
    }

    // Substack's own rows above the bar stay pinned with it: the tabs row on Subscriptions (All, Listen,
    // Paid…); on Home, the post box ("What's on your mind?") and the feed picker (Following). Each pins
    // right below the one above it, and the bar below them all.
    let pinnedHeaders = [];
    let pinObserver = null;
    function findPinnedHeaders() {
        const isHeader = (element) => {
            const height = element?.getBoundingClientRect().height ?? 0;
            return Boolean(element) && height > 0 && height < 160 && !element.querySelector('[role="article"], .reader2-inbox-post');
        };
        if (adapter?.name === "inbox") {
            const tabs = appRoot.parentElement?.previousElementSibling;
            return isHeader(tabs) ? [tabs] : [];
        }
        const headers = [];
        for (let element = appRoot.previousElementSibling; isHeader(element) && headers.length < 3; element = element.previousElementSibling) {
            headers.unshift(element);
        }
        return headers;
    }

    function pinHeader() {
        if (!appRoot?.isConnected) {
            return;
        }
        const headers = findPinnedHeaders();
        if (headers.length !== pinnedHeaders.length || headers.some((header, index) => header !== pinnedHeaders[index])) {
            unpinHeader();
            pinnedHeaders = headers;
            if (headers.length) {
                pinObserver = new ResizeObserver(updatePinOffset);
                for (const header of headers) {
                    header.dataset.substackOrganizerPinned = "";
                    pinObserver.observe(header);
                }
                pinObserver.observe(appRoot);
            }
        }
        // The pinned rows need an opaque background to cover the feed scrolling under them: the nearest one
        // above the bar (the page may set it on <html> rather than <body>), else the theme's own.
        let background = null;
        for (let element = appRoot.parentElement; element && !background; element = element.parentElement) {
            const color = getComputedStyle(element).backgroundColor;
            if (color && color !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(color)) {
                background = color;
            }
        }
        background ??= resolveSubstackTheme() === "light" ? "#ffffff" : "#161718";
        document.documentElement.style.setProperty("--substack-organizer-page-bg", background);
        updatePinOffset();
    }

    function updatePinOffset() {
        if (!appRoot) {
            return;
        }
        // Home's post box sits 24px below the top (Substack's own padding); pinned rows keep that gap so the
        // page looks the same scrolled or not. Subscriptions' tabs row has its padding inside it.
        let top = adapter?.name === "home" && pinnedHeaders.length ? 24 : 0;
        document.documentElement.style.setProperty("--substack-organizer-pin-gap", `${top}px`);
        pinnedHeaders.forEach((header, index) => header.toggleAttribute("data-substack-organizer-pin-gap", index === 0 && top > 0));
        for (const header of pinnedHeaders) {
            const value = `${top}px`;
            if (header.style.top !== value) {
                header.style.top = value;
            }
            if (header.isConnected && !state.paused) {
                top += Math.round(header.getBoundingClientRect().height);
            }
        }
        const value = `${state.paused ? 0 : top}px`;
        if (appRoot.style.top !== value) {
            appRoot.style.top = value;
        }
    }

    function unpinHeader() {
        pinObserver?.disconnect();
        pinObserver = null;
        for (const header of pinnedHeaders) {
            delete header.dataset.substackOrganizerPinned;
            header.removeAttribute("data-substack-organizer-pin-gap");
            header.style.removeProperty("top");
        }
        pinnedHeaders = [];
    }

    // How far below the window's top a selected post lands: under the pinned row and bar (their pinned
    // height, not their current position, which is lower before the page has scrolled).
    function getPinnedHeight() {
        if (!appRoot?.isConnected) {
            return 80;
        }
        return Math.max(80, (Number.parseFloat(appRoot.style.top) || 0) + appRoot.offsetHeight + 12);
    }

    function createRoot(mount) {
        lastRefreshKey = "";
        appRoot = document.createElement("div");
        appRoot.id = ROOT_ID;
        appRoot.setAttribute("data-substack-organizer", "");
        shadow = appRoot.attachShadow({ mode: "open" });
        shadow.innerHTML = `<style>${styles}</style>${html}`;
        mount.mountParent.insertBefore(appRoot, mount.mountBefore);
        pinHeader();
        // Events from shadow DOM reach the page retargeted to this host, so Substack's
        // single-letter shortcuts can't tell the user is typing and cancel the key.
        for (const type of ["keydown", "keypress", "keyup"]) {
            appRoot.addEventListener(type, stopTypingFromReachingPage);
        }
        wireControls();
        render();
    }

    function stopTypingFromReachingPage(event) {
        const origin = event.composedPath()[0];
        if (origin instanceof HTMLInputElement || origin instanceof HTMLTextAreaElement) {
            event.stopPropagation();
        }
    }

    let setManagerOpen = null;
    let setShortcutsOpen = null;

    function exportSettings() {
        const settings = Object.fromEntries(STORAGE_KEYS.map((key) => [key, state[key]]));
        const payload = JSON.stringify({ app: "substack-organizer", version: 1, exportedAt: new Date().toISOString(), settings }, null, 2);
        const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
        const link = document.createElement("a");
        const today = new Date();
        link.href = url;
        link.download = `substack-organizer-${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage("Settings exported.", false);
    }

    // Restores an export: groups, assignments, names, merges and read marks replace
    // the current ones. Anything malformed is dropped by the same checks used when loading settings.
    async function importSettings(file) {
        let data;
        try {
            data = JSON.parse(await file.text());
        } catch {
            setMessage("That file isn't a settings export.", true);
            return;
        }
        const settings = data?.app === "substack-organizer" && data.version === 1 ? data.settings : null;
        // A v1 export always has every key, with these types; anything else is rejected before asking.
        const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
        const valid =
            isPlainObject(settings) &&
            Array.isArray(settings.groups) &&
            ["assignments", "publisherNames", "publisherAliases", "readPosts"].every((key) => isPlainObject(settings[key])) &&
            Array.isArray(settings.hiddenPanels) &&
            typeof settings.hideRead === "boolean";
        if (!valid) {
            setMessage("That file isn't a complete Substack organizer export.", true);
            return;
        }
        // The file replaces the current setup entirely; nothing from the current settings is kept.
        const next = sanitizeState(Object.fromEntries(STORAGE_KEYS.map((key) => [key, settings[key]])));
        const describe = (value) =>
            `${value.groups.length} groups, ${Object.keys(value.assignments).length} assignments, ` +
            `${Object.keys(value.readPosts).length} and ${Object.keys(value.readPosts).length} read marks`;
        if (!globalThis.confirm(`Replace your ${describe(state)} with the file's ${describe(next)}?`)) {
            setMessage("Import cancelled.", false);
            return;
        }
        try {
            await writeToStorage({ set: next });
        } catch (error) {
            setMessage(describeStorageError(error), true);
            return;
        }
        state = next;
        lastRefreshKey = "";
        refreshData();
        renderManager();
        setMessage(`Imported ${state.groups.length} groups and ${Object.keys(state.assignments).length} assignments.`, false);
    }
    function wireControls() {
        const filterTrigger = shadow.getElementById("filter-trigger");
        const filterMenu = shadow.getElementById("filter-menu");
        const settingsTrigger = shadow.getElementById("settings-trigger");
        const settingsMenu = shadow.getElementById("settings-menu");
        const manager = shadow.getElementById("manager");

        filterTrigger.addEventListener("click", () => setOpenMenu(filterMenu, filterTrigger));
        settingsTrigger.addEventListener("click", () => setOpenMenu(settingsMenu, settingsTrigger));
        // The highlight is measured once per selection, so it's measured again whenever the control's size
        // changes (fonts loading, the bar wrapping), or it would sit in the wrong place.
        const daysControl = shadow.getElementById("days-control");
        new ResizeObserver(() => {
            if (!shadow || !daysControl.isConnected) {
                return;
            }
            delete daysControl.querySelector(".seg-fill").dataset.days;
            renderDaysControl();
        }).observe(daysControl);
        for (const button of shadow.querySelectorAll("#days-control button")) {
            button.addEventListener("click", () => {
                const days = button.dataset.days ? Number(button.dataset.days) : null;
                closeOpenMenu();
                stoppedRangeKey = null;
                if (state.days !== days) {
                    void updateState((next) => {
                        next.days = days;
                    });
                } else {
                    // Clicking the current range again retries a load the user stopped.
                    render();
                }
            });
        }
        shadow.getElementById("stop-loading").addEventListener("click", () => {
            stoppedRangeKey = getLoadKey();
            stopLoading();
        });
        // Substack only fetches new articles on a page load, so Refresh reloads the page; the load overlay
        // and the Inbox's full load then run as usual.
        shadow.getElementById("refresh-trigger").addEventListener("click", (event) => {
            event.currentTarget.disabled = true;
            event.currentTarget.classList.add("spinning");
            location.reload();
        });
        const backdrop = shadow.getElementById("manager-backdrop");
        setManagerOpen = (open) => {
            manager.hidden = !open;
            backdrop.hidden = !open;
            // Lifts the bar above Substack's own fixed elements while the modal covers the page.
            appRoot.toggleAttribute("data-manager-open", open);
            if (open) {
                renderManager();
                shadow.getElementById("publisher-search").focus();
            } else {
                endDrag();
                railEditor = null;
                clearPublisherSelection();
                settingsTrigger.focus();
            }
        };
        shadow.getElementById("close-manager").addEventListener("click", () => setManagerOpen(false));
        const shortcuts = shadow.getElementById("shortcuts");
        setShortcutsOpen = (open) => {
            shortcuts.hidden = !open;
            backdrop.hidden = !open;
            appRoot.toggleAttribute("data-manager-open", open);
            if (open) {
                shadow.getElementById("close-shortcuts").focus();
            } else if (shadow.activeElement && shortcuts.contains(shadow.activeElement)) {
                shadow.activeElement.blur();
            }
        };
        shadow.getElementById("close-shortcuts").addEventListener("click", () => setShortcutsOpen(false));
        shadow.getElementById("resume").addEventListener("click", () => setPaused(false));
        backdrop.addEventListener("click", () => {
            if (!shortcuts.hidden) {
                setShortcutsOpen(false);
            } else {
                setManagerOpen(false);
            }
        });
        shadow.addEventListener("keydown", (event) => {
            // defaultPrevented means a menu inside the modal already handled this Escape.
            if (event.key !== "Escape" || event.defaultPrevented || openMenu) {
                return;
            }
            if (!manager.hidden) {
                event.preventDefault();
                setManagerOpen(false);
            } else if (!shortcuts.hidden) {
                event.preventDefault();
                setShortcutsOpen(false);
            }
        });
        for (const button of shadow.querySelectorAll("#publisher-scope button")) {
            button.addEventListener("click", () => {
                publisherScope = button.dataset.scope;
                renderManager();
            });
        }
        const bulkMove = shadow.getElementById("bulk-move");
        const bulkMenu = shadow.getElementById("bulk-menu");
        bulkMove.addEventListener("click", () => {
            buildGroupMenu(bulkMenu, undefined, (group) => void movePublishers([...selectedPublishers], group), true);
            setOpenMenu(bulkMenu, bulkMove);
        });
        shadow.getElementById("bulk-clear").addEventListener("click", () => {
            clearPublisherSelection();
            renderPublisherList();
        });
        shadow.addEventListener("dragend", endDrag);
        shadow.getElementById("export-settings").addEventListener("click", exportSettings);
        const importFile = shadow.getElementById("import-file");
        shadow.getElementById("import-settings").addEventListener("click", () => importFile.click());
        importFile.addEventListener("change", () => {
            const file = importFile.files?.[0];
            importFile.value = "";
            if (file) {
                void importSettings(file);
            }
        });
        shadow.getElementById("publisher-search").addEventListener("input", () => renderPublisherList());

        let tabbing = false;
        shadow.addEventListener("keydown", (event) => {
            tabbing = event.key === "Tab";
            if (event.key === "Escape" && openMenu) {
                event.preventDefault();
                closeOpenMenu(true);
            }
        });
        shadow.addEventListener("pointerdown", () => {
            tabbing = false;
        });
        // Close on focus loss only when the user moves focus (Tab, or another control in the bar).
        // Substack can move focus on its own while it updates the page, which shouldn't close a menu.
        shadow.addEventListener("focusout", (event) => {
            if (!openMenu) {
                return;
            }
            const nextTarget = event.relatedTarget;
            if (!nextTarget || openMenu.menu.contains(nextTarget) || nextTarget === openMenu.trigger) {
                return;
            }
            const movedWithinBar = nextTarget.getRootNode?.() === shadow;
            if (!tabbing && !movedWithinBar) {
                return;
            }
            queueMicrotask(() => {
                if (openMenu && !openMenu.menu.contains(shadow.activeElement) && shadow.activeElement !== openMenu.trigger) {
                    closeOpenMenu();
                }
            });
        });
        document.addEventListener("pointerdown", handleOutsidePointerDown, true);
        shadow.addEventListener("scroll", closeFloatingMenuOnScroll, true);
        globalThis.addEventListener("scroll", closeFloatingMenuOnScroll, true);
        themeObserver = new MutationObserver(() => {
            if (appRoot) {
                appRoot.dataset.theme = resolveSubstackTheme();
            }
        });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    }

    function closeFloatingMenuOnScroll(event) {
        if (!openMenu?.menu.classList.contains("publisher-menu")) {
            return;
        }
        if (!openMenu.menu.contains(event.composedPath()[0])) {
            closeOpenMenu();
        }
    }

    function handleOutsidePointerDown(event) {
        if (openMenu && !appRoot.contains(event.target)) {
            closeOpenMenu();
        }
    }

    async function startOnPage() {
        const routeAdapter = getRouteAdapter();
        if (!routeAdapter) {
            stopOnOtherRoute();
            return;
        }

        if (!document.body) {
            return;
        }
        const mount = routeAdapter.findFeed();
        if (!mount) {
            return;
        }

        if (appRoot && (feed !== mount.root || adapter !== routeAdapter)) {
            dispose();
        }
        adapter = routeAdapter;
        feed = mount.root;
        feed.dataset.substackOrganizerFeed = "";
        if (!appRoot) {
            if (initializing) {
                return;
            }
            initializing = true;
            try {
                state = sanitizeState(await chrome.storage.local.get(STORAGE_KEYS));
                storageReady = true;
            } catch {
                storageReady = false;
            } finally {
                initializing = false;
            }
            if (getRouteAdapter() !== routeAdapter || !mount.root.isConnected) {
                return;
            }
            createRoot(mount);
            if (!storageReady) {
                setMessage("Saved groups couldn't be loaded. Reload the page to try again.", true);
            }
        }
        refreshData();
        // If a background load is about to start, the overlay stays until it finishes.
        if (!(isLoadingWanted() && loadedRangeKey !== getLoadKey())) {
            revealWhenSettled();
        }
        if (!observer) {
            observer = new MutationObserver((mutations) => {
                if (!adapter || !feed || !shadow) {
                    return;
                }
                // Mutation callbacks run before the next paint, so new posts are filtered before they show.
                // Every mutation is checked (not just until the first match), so each affected post's cached
                // reading is dropped even in a batch that also adds posts.
                let changed = false;
                for (const mutation of mutations) {
                    if (changesFeedContent(mutation)) {
                        changed = true;
                    }
                }
                if (mutations.some((mutation) => addsFeedItems(mutation))) {
                    cards = adapter.getCards(feed);
                    applyFilter();
                } else if (!changed) {
                    // Home's videos and embeds change the page constantly; those changes need no refresh.
                    return;
                }
                // Throttled rather than debounced, so a burst of changes can't postpone the refresh indefinitely.
                if (!scanTimer) {
                    scanTimer = setTimeout(() => {
                        scanTimer = null;
                        refreshData();
                    }, 250);
                }
            });
            // Link address changes are watched too (with the old address, to catch a post link that was
            // changed to something else): a reused post element can point at a different post.
            observer.observe(feed, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"], attributeOldValue: true });
        }
    }

    // A refresh is needed when the feed's own children change, or when a Home post that hasn't
    // finished rendering (not yet cached) fills in its author, links or date.
    // Links that identify a post or its author; other link changes (embeds, players) don't matter.
    const IDENTITY_LINKS = 'a[href*="/@"], a[href*="/profile/"], a[href*="/p/"], a[href*="/note/c-"], a[href*="/inbox/post/"], a[href*="/home/post/"]';
    const IDENTITY_PATH = /\/(@|profile\/|p\/|note\/c-|inbox\/post\/|home\/post\/)/;

    // Drops both cached readings (the Home item's and the post key) for the post containing an element.
    function invalidatePost(element) {
        const item = adapter ? element.closest?.(adapter.itemSelector) : null;
        if (item) {
            homeItemCache.delete(item);
            postKeyCache.delete(item);
        }
        const container = element.closest?.("[data-substack-organizer-card]");
        if (container) {
            postKeyCache.delete(container);
        }
        return Boolean(item || container);
    }

    function changesFeedContent(mutation) {
        if (mutation.type === "attributes") {
            // Only a post or author link changing (to or from such an address) makes a cached reading stale.
            const wasIdentity = IDENTITY_PATH.test(mutation.oldValue ?? "");
            return wasIdentity || mutation.target.matches?.(IDENTITY_LINKS) ? invalidatePost(mutation.target) || true : false;
        }
        if (mutation.target === feed) {
            return true;
        }
        const item = adapter ? mutation.target.closest?.(adapter.itemSelector) : null;
        if (!item && adapter?.name === "home") {
            return false;
        }
        // Substack can reuse a post element for a different post. Post or author links added or removed
        // mean the cached reading is stale; video and embed changes don't touch those.
        for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
            if (node.nodeType === Node.ELEMENT_NODE && (node.matches(IDENTITY_LINKS) || node.querySelector(IDENTITY_LINKS))) {
                invalidatePost(mutation.target);
                return true;
            }
        }
        // A Home post still rendering (not yet cached) needs a refresh as its details arrive.
        return adapter?.name === "home" && Boolean(item) && !homeItemCache.has(item);
    }

    function addsFeedItems(mutation) {
        // The extension's own elements (the bar, the empty-result message) don't need a rescan.
        const isOwn = (node) => node === appRoot || node.id === EMPTY_MESSAGE_ID;
        if (mutation.target === feed && [...mutation.addedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE && !isOwn(node))) {
            return true;
        }
        for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && (node.matches(adapter.itemSelector) || node.querySelector(adapter.itemSelector))) {
                return true;
            }
        }
        return false;
    }

    // Leaving a feed for another Substack page: Substack keeps the old feed on screen until the new page
    // draws, so undoing the filter and width at once showed the feed in Substack's own layout for a moment.
    // Cleanup waits until the feed is removed (checked before each paint), or 3 seconds at most.
    let leaving = null;
    function stopOnOtherRoute() {
        closeNoteOverlay();
        if (appRoot && feed?.isConnected && feed.checkVisibility?.() !== false) {
            if (!leaving) {
                stopLoading();
                const observer = new MutationObserver(() => {
                    // Gone, or kept but hidden by Substack: either way the new page is what's on screen.
                    if (!feed?.isConnected || feed.checkVisibility?.() === false) {
                        finishLeaving();
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true });
                leaving = { observer, timer: setTimeout(finishLeaving, 3000) };
            }
            return;
        }
        finishLeaving();
    }

    function cancelLeaving() {
        if (leaving) {
            leaving.observer.disconnect();
            clearTimeout(leaving.timer);
            leaving = null;
        }
    }

    function finishLeaving() {
        cancelLeaving();
        // Back on a feed by now (a quick back navigation): nothing to undo.
        if (getRouteAdapter()) {
            return;
        }
        if (appRoot) {
            dispose();
        }
        delete document.documentElement.dataset.substackOrganizerWidth;
        revealPage();
    }

    // Moving between Subscriptions and Home inside Substack's app doesn't reload the page, so the
    // page-load overlay is shown again until the new page's feed is filtered and widened.
    let revealTimer = null;
    function hidePageUntilReady() {
        if (state.paused) {
            return;
        }
        document.documentElement.dataset.substackOrganizerBooting = "nav";
        // The settle check waits for the feed to change from this post, so the previous page's posts
        // (still on screen for a moment) don't count as the new page being ready.
        navFirstItem = feed && adapter ? feed.querySelector(adapter.itemSelector) : null;
        navPostCount = navFirstItem ? countLoadedCards() : -1;
        clearTimeout(settleTimer);
        settleTimer = null;
        clearTimeout(revealTimer);
        revealTimer = setTimeout(revealPage, 3000);
    }

    // The route timer notices a page change up to 250ms late, after Substack has already drawn the new
    // page, which then flashed before the overlay covered it. These cover the page as navigation starts.
    function hideIfNavigatingToFeed(url) {
        try {
            const target = new URL(url, location.href);
            const isFeed = Object.values(ADAPTERS).some((candidate) => candidate.matches(target.pathname));
            if (target.origin === location.origin && toPageKey(target.pathname) !== toPageKey(location.pathname) && isFeed && !isClosingReader(target.pathname)) {
                hidePageUntilReady();
            }
        } catch {
            // Not a URL we can read; the route timer still handles the change.
        }
    }
    // Both run: the navigate event isn't delivered to extension scripts in every browser version. The click
    // listener runs in the capture phase, before Substack's own handler draws the new page.
    globalThis.navigation?.addEventListener?.("navigate", (event) => hideIfNavigatingToFeed(event.destination.url));
    document.addEventListener(
        "click",
        (event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
                return;
            }
            const link = event.target.closest?.("a[href]");
            if (link) {
                if (link.target !== "_blank") {
                    hideIfNavigatingToFeed(link.href);
                }
                return;
            }
            // Substack's left menu may use buttons; its Home and Subscriptions items are matched by label.
            const navItem = event.target.closest?.('nav button, nav [role="button"], [class*="reader-nav"] button, [class*="reader-nav"] [role="button"]');
            const label = navItem?.textContent.trim();
            if (label === "Home" || label === "Subscriptions") {
                hideIfNavigatingToFeed(label === "Home" ? "/home" : "/inbox");
            }
        },
        true
    );
    globalThis.addEventListener("popstate", () => {
        if (location.pathname !== lastPath && getRouteAdapter() && !isClosingReader(location.pathname)) {
            hidePageUntilReady();
        }
    });

    // Closing Substack's reader back to the feed it opened over: the feed is still organized, so there's
    // nothing to cover or reload.
    function isClosingReader(targetPath) {
        return Boolean(appRoot) && readerReturnPath !== null && toPageKey(targetPath) === toPageKey(readerReturnPath);
    }

    // "/" and "/home" are the same page, and a trailing slash doesn't make another one.
    function toPageKey(path) {
        return /^\/home\/?$/i.test(path) ? "/" : path.replace(/\/+$/, "") || "/";
    }

    // A mouse click on a Home Note opens it the way o does: its article in Substack's reader, or the Note in
    // the overlay, in place of Substack's Note page. Links and buttons inside the Note (author, timestamp,
    // See more, like, reply) keep Substack's own behavior. Runs in the capture phase, before Substack's handler.
    document.addEventListener(
        "click",
        (event) => {
            if (!event.isTrusted || !appRoot || state.paused || adapter?.name !== "home" || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return;
            }
            const target = event.target;
            if (!(target instanceof Element) || target.closest('a, button, [role="button"], input, textarea, select, video, audio, iframe, [contenteditable="true"]')) {
                return;
            }
            const container = target.closest("[data-substack-organizer-card]");
            const card = container && feed?.contains(container) ? cardByContainer.get(container) : null;
            if (!card?.isNote) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            openCard(card);
        },
        true
    );

    // Keyboard shortcuts. They run before Substack's own key handling, only for these keys, and never while
    // typing, with the extension's or Substack's dialogs open, or with a menu open. The selected post is
    // tracked by its element, which survives the feed being re-read.
    let currentContainer = null;
    function getVisibleCards() {
        return cards.filter((card) => card.container.dataset.substackOrganizerHidden === "false" && card.container.isConnected);
    }

    function getCurrentCard() {
        if (!currentContainer?.isConnected || currentContainer.dataset.substackOrganizerHidden !== "false") {
            return null;
        }
        return cardByContainer.get(currentContainer) ?? null;
    }

    let lastGPress = 0;

    function selectCard(card) {
        if (currentContainer) {
            delete currentContainer.dataset.substackOrganizerCurrent;
        }
        currentContainer = card?.container ?? null;
        if (!card) {
            return;
        }
        card.container.dataset.substackOrganizerCurrent = "true";
        scrollToCard(card.container);
    }

    // Posts off screen skip layout (content-visibility) and use an estimated height, so a far target's
    // position is only a guess until the posts before it are drawn. Long jumps go instantly and are then
    // corrected over a few frames until the post settles at the top; short moves scroll smoothly.
    let scrollFixRun = 0;
    function scrollToCard(container) {
        const run = ++scrollFixRun;
        const offset = () => container.getBoundingClientRect().top - getPinnedHeight();
        const far = Math.abs(offset()) > innerHeight * 1.5;
        const smooth = !far && !matchMedia("(prefers-reduced-motion: reduce)").matches;
        scrollTo({ top: scrollY + offset(), behavior: smooth ? "smooth" : "auto" });
        if (smooth) {
            return;
        }
        let frames = 0;
        const fix = () => {
            if (run !== scrollFixRun || !container.isConnected || frames++ > 20) {
                return;
            }
            const delta = offset();
            if (Math.abs(delta) > 2) {
                scrollTo({ top: scrollY + delta, behavior: "auto" });
            }
            requestAnimationFrame(fix);
        };
        requestAnimationFrame(fix);
    }

    function moveSelection(step) {
        const list = getVisibleCards();
        if (!list.length) {
            return;
        }
        let index = currentContainer ? list.findIndex((card) => card.container === currentContainer) : -1;
        if (index >= 0) {
            selectCard(list[Math.min(list.length - 1, Math.max(0, index + step))]);
            return;
        }
        if (currentContainer?.isConnected) {
            // The selected post was hidden: continue from where it was.
            index = list.findIndex((card) => currentContainer.compareDocumentPosition(card.container) & Node.DOCUMENT_POSITION_FOLLOWING);
            if (index >= 0) {
                selectCard(list[step > 0 ? index : Math.max(0, index - 1)]);
                return;
            }
        }
        // Nothing selected yet: start from the first post on screen.
        const onScreen = list.findIndex((card) => card.container.getBoundingClientRect().bottom > getPinnedHeight());
        selectCard(list[Math.max(0, onScreen)]);
    }

    // Home ↔ Subscriptions. Substack's own nav link keeps it an in-page switch (with the usual overlay);
    // a full page load is the fallback.
    function switchFeed() {
        const target = adapter?.name === "home" ? "/inbox" : "/home";
        // Substack's Home link can point at "/" as well as "/home".
        const paths = target === "/home" ? ["/home", "/"] : [target];
        const selector = paths.flatMap((path) => [`a[href="${path}"]`, `a[href^="${path}?"]`, `a[href="https://substack.com${path}"]`]).join(", ");
        const link = [...document.querySelectorAll(selector)].find(
            (candidate) => !appRoot?.contains(candidate) && candidate.getClientRects().length > 0
        );
        if (link) {
            link.click();
        } else {
            location.assign(`https://substack.com${target}`);
        }
    }

    // The Note overlay copies the layout of Substack's own reader (the panel that opens an article from
    // Home): it covers everything right of Substack's left navigation, inside a 12px margin, as a framed panel
    // with a translucent 72px header holding a 40px close button, and the post in a 600px column. It lives
    // in the page (not the bar's shadow root) so the copied Note keeps Substack's styles. The copy has no
    // Substack handlers, so its buttons are removed; links work.
    const NOTE_OVERLAY_ID = "substack-organizer-note-overlay";
    const LUCIDE_X = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
    const LUCIDE_EXTERNAL = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>';
    function showNoteOverlay(item) {
        closeNoteOverlay();
        if (!item.isConnected) {
            return;
        }
        // Colors follow the page: Substack's reader uses the page background, a 10% divider and an 80%
        // translucent header.
        const pageBackground = [document.body, document.documentElement]
            .map((element) => getComputedStyle(element).backgroundColor)
            .find((color) => color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") ?? "rgb(255, 255, 255)";
        const [red = 255, green = 255, blue = 255] = (pageBackground.match(/[\d.]+/g) ?? []).map(Number);
        const dark = 0.299 * red + 0.587 * green + 0.114 * blue < 128;
        const nav = document.querySelector('[aria-label="Main navigation"]');
        // Substack collapses its navigation to an 80px icon strip while the reader is open, so the reader
        // starts there; the overlay covers the labels the same way.
        const navRight = nav && nav.getClientRects().length ? Math.min(80, Math.max(0, Math.round(nav.getBoundingClientRect().right))) : 0;

        const overlay = document.createElement("div");
        overlay.id = NOTE_OVERLAY_ID;
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Note");
        overlay.style.setProperty("--sfo-bg", `rgb(${red}, ${green}, ${blue})`);
        overlay.style.setProperty("--sfo-header", `rgb(${red} ${green} ${blue} / 80%)`);
        overlay.style.setProperty("--sfo-line", dark ? "rgb(255 255 255 / 10%)" : "rgb(0 0 0 / 10%)");
        overlay.style.setProperty("--sfo-button", dark ? "rgb(35, 37, 37)" : "rgb(240, 240, 240)");
        overlay.style.setProperty("--sfo-text", dark ? "rgb(238, 238, 238)" : "rgb(54, 55, 55)");
        overlay.style.left = `${navRight}px`;

        const frame = document.createElement("div");
        frame.className = "substack-organizer-note-frame";
        const header = document.createElement("div");
        header.className = "substack-organizer-note-header";
        const close = document.createElement("button");
        close.type = "button";
        close.className = "substack-organizer-note-button";
        close.setAttribute("aria-label", "Close");
        close.innerHTML = LUCIDE_X;
        close.addEventListener("click", closeNoteOverlay);
        header.append(close);
        const pageLink = item.querySelector('a[href*="/note/c-"]');
        if (pageLink) {
            const open = document.createElement("a");
            open.href = pageLink.href;
            open.className = "substack-organizer-note-button";
            open.setAttribute("aria-label", "Open Note page");
            open.innerHTML = LUCIDE_EXTERNAL;
            header.append(open);
        }

        const scroller = document.createElement("div");
        scroller.className = "substack-organizer-note-scroll";
        scroller.tabIndex = -1;
        const column = document.createElement("div");
        column.className = "substack-organizer-note-column";
        column.append(copyNote(item));
        scroller.append(column);
        frame.append(header, scroller);
        overlay.append(frame);
        overlay.addEventListener("click", (event) => {
            if (event.target.closest("a[href]")) {
                closeNoteOverlay();
            }
        });
        noteOverlayKeys = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopImmediatePropagation();
                closeNoteOverlay();
            }
        };
        globalThis.addEventListener("keydown", noteOverlayKeys, true);
        document.body.append(overlay);
        // Substack's reader shrinks the left navigation to an icon strip; content.css does the same while
        // this is open.
        document.documentElement.dataset.substackOrganizerNoteOpen = "";
        scroller.focus();
    }

    function copyNote(item) {
        const copy = item.cloneNode(true);
        for (const element of copy.querySelectorAll('button, [role="button"], [class*="seeMore"]')) {
            element.remove();
        }
        for (const element of copy.querySelectorAll("[id]")) {
            element.removeAttribute("id");
        }
        for (const marker of ["substackOrganizerHidden", "substackOrganizerCard", "substackOrganizerRead", "substackOrganizerGroup", "substackOrganizerCurrent"]) {
            delete copy.dataset[marker];
        }
        return copy;
    }

    // Replaces the copy's cut-off paragraphs with the Note's full text. Built as DOM nodes from the Note's
    // structured body (never as HTML), with Substack's own paragraph styling copied from the cut-off text.
    async function loadFullNote(noteId, column) {
        let body;
        try {
            const response = await fetch(`/api/v1/reader/comment/${noteId}`, { credentials: "include" });
            if (!response.ok) {
                return;
            }
            body = (await response.json())?.item?.comment?.body_json;
        } catch {
            return;
        }
        // The overlay may have been closed, or replaced by another Note's, while the text loaded.
        if (!column?.isConnected) {
            return;
        }
        const firstParagraph = column.querySelector("p");
        if (!firstParagraph || !Array.isArray(body?.content)) {
            return;
        }
        const container = firstParagraph.parentElement;
        const paragraphClass = firstParagraph.className;
        const nodes = body.content.map((node) => renderNoteNode(node, paragraphClass)).filter(Boolean);
        if (nodes.length) {
            // Only the cut-off text is replaced; images or embeds next to it stay.
            const cutOff = [...container.children].filter((child) => child.matches("p, ul, ol, blockquote"));
            firstParagraph.before(...nodes);
            for (const element of cutOff) {
                element.remove();
            }
        }
    }

    function renderNoteNode(node, paragraphClass) {
        if (!node || typeof node !== "object") {
            return null;
        }
        const children = () => (Array.isArray(node.content) ? node.content.map((child) => renderNoteNode(child, paragraphClass)).filter(Boolean) : []);
        switch (node.type) {
            case "text": {
                let element = document.createTextNode(String(node.text ?? ""));
                for (const mark of Array.isArray(node.marks) ? node.marks : []) {
                    let wrapper = null;
                    if (mark.type === "bold" || mark.type === "strong") {
                        wrapper = document.createElement("strong");
                    } else if (mark.type === "italic" || mark.type === "em") {
                        wrapper = document.createElement("em");
                    } else if (mark.type === "link" && /^https?:\/\//i.test(String(mark.attrs?.href ?? ""))) {
                        wrapper = document.createElement("a");
                        wrapper.href = mark.attrs.href;
                        wrapper.target = "_blank";
                        wrapper.rel = "noopener noreferrer";
                    }
                    if (wrapper) {
                        wrapper.append(element);
                        element = wrapper;
                    }
                }
                return element;
            }
            case "hard_break":
                return document.createElement("br");
            case "paragraph": {
                const paragraph = document.createElement("p");
                paragraph.className = paragraphClass;
                paragraph.append(...children());
                return paragraph;
            }
            case "heading": {
                const heading = document.createElement("p");
                heading.className = paragraphClass;
                const strong = document.createElement("strong");
                strong.append(...children());
                heading.append(strong);
                return heading;
            }
            case "blockquote": {
                const quote = document.createElement("blockquote");
                quote.append(...children());
                return quote;
            }
            case "bullet_list":
            case "bulletList":
            case "ordered_list":
            case "orderedList": {
                const list = document.createElement(node.type.startsWith("ordered") ? "ol" : "ul");
                list.append(...children());
                return list;
            }
            case "list_item":
            case "listItem": {
                const item = document.createElement("li");
                item.append(...children());
                return item;
            }
            default: {
                // Unknown block (an embed): keep any text it carries.
                const parts = children();
                if (!parts.length) {
                    return null;
                }
                const paragraph = document.createElement("p");
                paragraph.className = paragraphClass;
                paragraph.append(...parts);
                return paragraph;
            }
        }
    }

    let noteOverlayKeys = null;
    function closeNoteOverlay() {
        document.getElementById(NOTE_OVERLAY_ID)?.remove();
        delete document.documentElement.dataset.substackOrganizerNoteOpen;
        if (noteOverlayKeys) {
            globalThis.removeEventListener("keydown", noteOverlayKeys, true);
            noteOverlayKeys = null;
        }
    }

    function openCard(card) {
        const { key, url } = getPostKey(card);
        const root = card.item ?? card.container;
        // A Home post sharing an article opens through the article link, which Substack shows in its
        // in-app reader; the Note's own link would open the Note page instead.
        const articleLink = card.articleKey
            ? [...root.querySelectorAll('a[href*="/p/"]')].find((candidate) => toArticleKey(candidate.href) === card.articleKey)
            : null;
        // Substack has no reader for Notes, so a Note without an article opens in an overlay over the feed.
        // A shortened Note's full text comes from Substack's API: its own "See more" opens the Note's page
        // for longer Notes instead of expanding.
        if (!articleLink && card.isNote) {
            showNoteOverlay(root);
            const shortened = [...root.querySelectorAll(':is(a, button, [role="button"])[class*="seeMore"], [class*="seeMore"] :is(a, button, [role="button"])')].some(
                (candidate) => candidate.textContent.trim() === "See more"
            );
            const noteId = root.querySelector('a[href*="/note/c-"]')?.getAttribute("href")?.match(/\/note\/c-(\d+)/)?.[1];
            if (shortened && noteId) {
                void loadFullNote(noteId, document.querySelector(`#${NOTE_OVERLAY_ID} .substack-organizer-note-column`));
            }
            return;
        }
        const link =
            getInboxPostLink(card) ??
            articleLink ??
            [...root.querySelectorAll("a[href]")].find((candidate) => key && toPostKey(candidate.href) === key);
        if (link) {
            link.click();
        } else if (url) {
            location.assign(url);
        } else {
            root.click();
        }
    }

    // Groups [ and ] step through: only ones with posts in the current date range (and read filter), plus
    // the current one so stepping still has a starting point.
    function getGroupCycle() {
        const dated = cards.filter(isCardInDateRange);
        return [null, ...state.groups, CORE.UNASSIGNED].filter(
            (group) => group === state.activeGroup || countForGroup(dated, group) > 0
        );
    }

    function handleShortcut(key, shift = false) {
        const days = { 1: 1, 2: 3, 3: 7, 4: null };
        // G jumps to the last post; g twice within half a second jumps to the first.
        if (key === "g") {
            if (loadRun) {
                return true;
            }
            const list = getVisibleCards();
            if (shift) {
                lastGPress = 0;
                if (list.length) {
                    selectCard(list.at(-1));
                }
            } else if (performance.now() - lastGPress < 500) {
                lastGPress = 0;
                if (list.length) {
                    selectCard(list[0]);
                }
            } else {
                lastGPress = performance.now();
            }
            return true;
        }
        lastGPress = 0;
        if (key === "j" || key === "k") {
            if (!loadRun) {
                moveSelection(key === "j" ? 1 : -1);
            }
            return true;
        }
        if (key in days) {
            stoppedRangeKey = null;
            if (state.days !== days[key]) {
                void updateState((next) => {
                    next.days = days[key];
                });
            }
            return true;
        }
        if (key === "[" || key === "]") {
            const options = getGroupCycle();
            if (options.length < 2) {
                return true;
            }
            const index = Math.max(0, options.indexOf(state.activeGroup));
            const group = options[(index + (key === "]" ? 1 : -1) + options.length) % options.length];
            void updateState((next) => {
                next.activeGroup = group;
            });
            return true;
        }
        // During a background load the posts are hidden by CSS, so post shortcuts wait.
        // M (Shift): every post in the current group and date range (not only those in view, and including
        // read ones hidden by Hide read posts) read, or, when they're all read already, all unread.
        if (key === "m" && shift) {
            if (loadRun) {
                return true;
            }
            const shown = cards.filter(
                (card) =>
                    card.container.isConnected &&
                    CORE.isPublisherVisible(card.publisherIds, state.activeGroup, state.assignments) &&
                    isCardInDateRange(card)
            );
            if (!shown.length) {
                return true;
            }
            if (shown.some((card) => !isCardRead(card))) {
                lastMarkedRead = setCardsRead(shown, true);
            } else {
                setCardsRead(shown, false);
                lastMarkedRead = {};
            }
            if (!openMenu) {
                renderSettingsMenu();
            }
            return true;
        }
        if (key === "r") {
            shadow.getElementById("refresh-trigger")?.click();
            return true;
        }
        if (key === "a") {
            if (state.activeGroup !== null) {
                void updateState((next) => {
                    next.activeGroup = null;
                });
            }
            return true;
        }
        if (key === "t") {
            switchFeed();
            return true;
        }
        if (key === "h") {
            void updateState((next) => {
                next.hideRead = !next.hideRead;
            });
            // A selected read post is now hidden, so the selection moves on to the next visible one.
            if (currentContainer?.isConnected && currentContainer.dataset.substackOrganizerHidden === "true") {
                moveSelection(1);
            }
            return true;
        }
        const card = loadRun ? null : getCurrentCard();
        if (!card) {
            return false;
        }
        if (key === "o" || key === "enter") {
            openCard(card);
        } else if (key === "m") {
            const read = !isCardRead(card);
            // With read posts hidden, the marked post disappears, so the selection moves to the next one.
            let next = null;
            if (read && state.hideRead) {
                const list = getVisibleCards();
                // By element: a rescan can replace the card objects for the same posts.
                const index = list.findIndex((item) => item.container === card.container);
                next = index < 0 ? null : (list[index + 1] ?? list[index - 1] ?? null);
            }
            const changed = Object.keys(setCardsRead([card], read)).length > 0;
            // The last visible post leaves nothing to move to, so the selection clears.
            if (changed && read && state.hideRead) {
                selectCard(next);
            }
        } else {
            return false;
        }
        return true;
    }

    function isSubstackDialogOpen() {
        return [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].some(
            (dialog) => dialog !== appRoot && !appRoot?.contains(dialog) && dialog.getClientRects().length > 0
        );
    }

    globalThis.addEventListener(
        "keydown",
        (event) => {
            if (!appRoot?.isConnected || !shadow || state.paused || event.ctrlKey || event.metaKey || event.altKey || /^\/(?:home|inbox)\/post\//i.test(location.pathname)) {
                return;
            }
            // Caps Lock still works: letters are compared in lowercase.
            const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
            if (event.repeat && key !== "j" && key !== "k") {
                return;
            }
            const target = event.composedPath()[0];
            // Escape closes an open Manage or shortcuts window even when focus has left the bar (for
            // example after a bulk action rebuilt the list under the focused button).
            if (key === "escape" && !openMenu && !target?.closest?.("input, textarea")) {
                if (!shadow.getElementById("manager").hidden) {
                    event.preventDefault();
                    setManagerOpen?.(false);
                    return;
                }
                if (!shadow.getElementById("shortcuts").hidden) {
                    event.preventDefault();
                    setShortcutsOpen?.(false);
                    return;
                }
            }
            if (target instanceof Element && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))) {
                return;
            }
            // ? toggles the shortcut list; it works with the list itself open.
            if (key === "?" && !openMenu && shadow.getElementById("manager").hidden && !isSubstackDialogOpen()) {
                event.preventDefault();
                event.stopImmediatePropagation();
                setShortcutsOpen?.(shadow.getElementById("shortcuts").hidden);
                return;
            }
            // Enter stays with a focused link or button (including the bar's own, inside its shadow root); it
            // opens the selected post only otherwise.
            if (key === "enter" && target instanceof Element && target.closest('a, button, [role="button"], [tabindex]')) {
                return;
            }
            if (openMenu || !shadow.getElementById("manager").hidden || !shadow.getElementById("shortcuts").hidden || isSubstackDialogOpen()) {
                return;
            }
            if (handleShortcut(key, event.shiftKey)) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        },
        true
    );

    function dispose() {
        closeNoteOverlay();
        unpinHeader();
        lastRefreshKey = "";
        renderedGroup = undefined;
        setManagerOpen = null;
        setShortcutsOpen = null;
        selectCard(null);
        clearPublisherSelection();
        document.getElementById(EMPTY_MESSAGE_ID)?.remove();
        observer?.disconnect();
        observer = null;
        clearTimeout(scanTimer);
        scanTimer = null;
        if (appRoot) {
            appRoot.remove();
        }
        // The width marker stays: removing it between Subscriptions and Home snapped the column to
        // Substack's own width for a frame before widening it again.
        if (markedColumn) {
            delete markedColumn.dataset[COLUMN_ATTRIBUTE];
        }
        markedColumn = null;
        if (loadRun) {
            loadRun.stopped = true;
        }
        loadRun = null;
        loadedRangeKey = null;
        feedFullyLoaded = false;
        loadedDays = 0;
        delete document.documentElement.dataset.substackOrganizerLoading;
        delete document.documentElement.dataset.substackOrganizerFiltering;
        for (const panel of sidebarPanels) {
            delete panel.wrapper.dataset.substackOrganizerPanelHidden;
        }
        sidebarPanels = [];
        for (const card of cards) {
            delete card.container.dataset.substackOrganizerHidden;
            delete card.container.dataset.substackOrganizerCard;
            delete card.container.dataset.substackOrganizerRead;
            delete card.container.dataset.substackOrganizerGroup;
            if (card.item) {
                delete card.item.dataset.substackOrganizerHidden;
            }
        }
        navFirstItem = null;
        if (feed) {
            for (const child of feed.children) {
                delete child.dataset.substackOrganizerExtra;
                delete child.dataset.substackOrganizerSuggestion;
            }
        }
        document.removeEventListener("pointerdown", handleOutsidePointerDown, true);
        globalThis.removeEventListener("scroll", closeFloatingMenuOnScroll, true);
        themeObserver?.disconnect();
        themeObserver = null;
        appRoot = null;
        shadow = null;
        if (feed) {
            delete feed.dataset.substackOrganizerFeed;
        }
        feed = null;
        adapter = null;
        cards = [];
        publishers = [];
        openMenu = null;
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !appRoot) {
            return;
        }
        const changedKeys = STORAGE_KEYS.filter((key) => changes[key]);
        // A read mark (this tab's own write coming back, or another tab's) only needs the feed re-filtered;
        // rebuilding every menu on each opened post isn't needed.
        if (changedKeys.length === 1 && changedKeys[0] === "readPosts") {
            const readPosts = changes.readPosts.newValue ?? {};
            if (JSON.stringify(readPosts) !== JSON.stringify(state.readPosts)) {
                state = { ...state, readPosts: sanitizeReadPosts(readPosts) };
                applyFilter();
            }
            return;
        }
        const updated = { ...state };
        for (const key of changedKeys) {
            updated[key] = changes[key].newValue;
        }
        state = sanitizeState(updated);
        // New aliases or names change which entry each post belongs to, so the cards are rebuilt.
        if (changes.publisherAliases || changes.publisherNames) {
            lastRefreshKey = "";
            refreshData();
            return;
        }
        render();
    });

    let lastPath = location.pathname;
    // Substack's reader (/home/post/…, /inbox/post/…) opens over the feed and leaves it in place, so the
    // organized feed is kept as it is. Closing the reader back to the same feed isn't a page change: no
    // overlay and no reload.
    const READER_PATH = /^\/(?:home|inbox)\/post\//i;
    let readerReturnPath = null;
    routeTimer = setInterval(() => {
        const path = location.pathname;
        if (READER_PATH.test(path) && appRoot) {
            if (readerReturnPath === null) {
                readerReturnPath = lastPath;
            }
            cancelLeaving();
            lastPath = path;
            return;
        }
        const routeAdapter = getRouteAdapter();
        let pathChanged = path !== lastPath;
        if (readerReturnPath !== null) {
            if (toPageKey(path) === toPageKey(readerReturnPath)) {
                pathChanged = false;
            }
            readerReturnPath = null;
        }
        lastPath = path;
        if (!routeAdapter) {
            stopOnOtherRoute();
        } else {
            cancelLeaving();
            if (pathChanged) {
                hidePageUntilReady();
            }
            // Inside Substack's single-page app, width-early.js doesn't rerun on navigation between pages.
            if (!state.paused && !document.documentElement.dataset.substackOrganizerWidth) {
                document.documentElement.dataset.substackOrganizerWidth = readCachedWidth();
            }
            const mount = routeAdapter.findFeed();
            if (mount && (!appRoot || mount.root !== feed || routeAdapter !== adapter)) {
                void startOnPage();
            } else if (!mount && appRoot && !appRoot.isConnected) {
                dispose();
            } else if (appRoot && shadow) {
                pinHeader();
                // A Home tab switch can reuse the same list element with different posts, so what was
                // loaded for the previous tab no longer counts.
                if (pathChanged) {
                    stopLoading();
                    loadedRangeKey = null;
                    loadedDays = 0;
                    feedFullyLoaded = false;
                    stoppedRangeKey = null;
                    lastRefreshKey = "";
                    refreshData();
                }
                // A path change that kept the same feed has nothing more to wait for unless a load is due.
                // Not on the tick of the change itself: the old tab's posts may still be on screen.
                if (!pathChanged && mount && !loadRun && !(isLoadingWanted() && loadedRangeKey !== getLoadKey())) {
                    revealWhenSettled();
                }
                // The sidebar renders separately from the feed, so its panels are rechecked here.
                const titles = sidebarPanels.map((panel) => panel.title).join("|");
                applySidebarPanels();
                if (sidebarPanels.map((panel) => panel.title).join("|") !== titles) {
                    // An open gear menu isn't rebuilt under the user; it updates when it closes.
                    if (openMenu?.menu.id === "settings-menu") {
                        renderPending = true;
                    } else {
                        renderSettingsMenu();
                    }
                }
            }
        }
    }, 250);

    void startOnPage();
    globalThis.addEventListener("pagehide", () => {
        clearInterval(routeTimer);
        cancelLeaving();
        dispose();
    }, { once: true });
})();
