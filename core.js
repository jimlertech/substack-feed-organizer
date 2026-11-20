(function (root, factory) {
    const api = factory();
    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    root.SubstackOrganizerCore = api;
})(globalThis, function () {
    "use strict";

    function normalizePublisher(href) {
        try {
            const url = new URL(href);
            if (url.protocol !== "https:" && url.protocol !== "http:") {
                return null;
            }

            return url.hostname.toLowerCase().replace(/^www\./, "");
        } catch {
            return null;
        }
    }

    // Notes link to their author's profile rather than an article. Profile links come as
    // substack.com/@handle or substack.com/profile/<id>-<name>; both become "substack.com/@<handle or id>".
    function normalizeProfile(href) {
        try {
            const url = new URL(href);
            if (!/^(www\.)?substack\.com$/i.test(url.hostname)) {
                return null;
            }
            const handle = url.pathname.match(/^\/@([\w.-]+)\/?$/);
            if (handle) {
                return `substack.com/@${handle[1].toLowerCase()}`;
            }
            const profile = url.pathname.match(/^\/profile\/(\d+)(?:-[^/]*)?\/?$/);
            return profile ? `substack.com/@${profile[1]}` : null;
        } catch {
            return null;
        }
    }

    function toPublisherIds(value) {
        return Array.isArray(value) ? value : [value];
    }

    // Selecting this filter shows posts whose publishers aren't in any group.
    const UNASSIGNED = "\u0000unassigned";
    // Assigning a publisher this value hides its posts everywhere, including All publishers.
    const HIDDEN = "\u0000hidden";

    function isAssigned(publisherId, assignments) {
        return Object.hasOwn(assignments, publisherId);
    }

    // Inbox posts have one publisher; Home items can link articles from several publications.
    // A post from any hidden publisher stays hidden whatever the filter.
    function isPublisherVisible(publisherIds, activeGroup, assignments) {
        const ids = toPublisherIds(publisherIds);
        if (ids.some((publisherId) => isAssigned(publisherId, assignments) && assignments[publisherId] === HIDDEN)) {
            return false;
        }
        if (activeGroup === null) {
            return true;
        }
        if (activeGroup === UNASSIGNED) {
            return !ids.some((publisherId) => isAssigned(publisherId, assignments));
        }
        return ids.some((publisherId) => isAssigned(publisherId, assignments) && assignments[publisherId] === activeGroup);
    }

    function getPostCountForGroup(cards, group, assignments) {
        return cards.reduce(
            (count, card) => count + (isPublisherVisible(card.publisherIds ?? card.publisherId, group, assignments) ? 1 : 0),
            0
        );
    }

    function sortGroupNames(groups) {
        return [...groups].sort((left, right) =>
            left.localeCompare(right, undefined, { sensitivity: "base", numeric: true })
        );
    }

    const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

    function startOfDay(date) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }

    // Substack's inbox shows "9:02 AM" for today, "Nov 18" for this year and "Nov 18, 2025" for older posts.
    // Returns the post's local calendar day, or null when the label isn't a date.
    function parsePostDay(label, now = new Date()) {
        const text = String(label).trim().toLowerCase();
        const today = startOfDay(now);
        if (/^\d{1,2}:\d{2}\s*(am|pm)?$/.test(text) || /^(just now|now|today|\d+\s*(s|m|min|mins|h|hr|hrs)( ago)?)$/.test(text)) {
            return today;
        }
        if (text === "yesterday") {
            return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
        }
        const daysAgo = text.match(/^(\d+)\s*(d|days?)( ago)?$/);
        if (daysAgo) {
            return new Date(today.getFullYear(), today.getMonth(), today.getDate() - Number(daysAgo[1]));
        }
        const dated = text.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?(?:,?\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:am|pm)?)?$/);
        if (!dated) {
            return null;
        }
        const month = MONTHS.indexOf(dated[1]);
        const day = Number(dated[2]);
        if (month < 0 || day < 1 || day > 31) {
            return null;
        }
        if (dated[3]) {
            return new Date(Number(dated[3]), month, day);
        }
        const thisYear = new Date(today.getFullYear(), month, day);
        // A yearless date later than today belongs to last year (for example "Dec 30" seen in January).
        return thisYear > today ? new Date(today.getFullYear() - 1, month, day) : thisYear;
    }

    function getCutoffDay(days, now = new Date()) {
        const today = startOfDay(now);
        return new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
    }

    // Posts without a readable date stay visible so the filter never hides them by mistake.
    function isWithinDays(postDay, days, now = new Date()) {
        if (days === null || !postDay) {
            return true;
        }
        return postDay >= getCutoffDay(days, now);
    }

    // Applies one write to what's in storage. Writes are changes, not whole copies, so a tab holding older
    // settings can't overwrite newer ones from another tab:
    //   set:       { key: value }        replaces whole values (preferences, import)
    //   merge:     { key: { k: v } }     object entries to add or change; null removes the entry
    // Returns the values to store. Pure, so the background writer and the tests share it.
    const STORE_LIMITS = { readPosts: 3000, publisherNames: 1000 };
    function applyStorageWrite(stored, write) {
        const out = { ...(write.set ?? {}) };
        // Group changes are filed under the publication a writer was merged into, using the merges saved so
        // far plus any in this write, so a tab that hasn't seen a merge yet can't leave a group behind on
        // the writer's old entry.
        const aliases = { ...(stored.publisherAliases ?? {}), ...(write.merge?.publisherAliases ?? {}) };
        const resolve = (id) => {
            let current = id;
            const seen = new Set();
            while (aliases[current] && !seen.has(current)) {
                seen.add(current);
                current = aliases[current];
            }
            return current;
        };
        // A move into a group another tab has just deleted is dropped, so the publisher keeps its group.
        const groups = Array.isArray(write.set?.groups) ? write.set.groups : Array.isArray(stored.groups) ? stored.groups : null;
        const isKnownGroup = (group) => group === null || group === HIDDEN || !groups || groups.includes(group);
        for (const [key, rawChanges] of Object.entries(write.merge ?? {})) {
            const changes =
                key === "assignments"
                    ? Object.fromEntries(
                          Object.entries(rawChanges ?? {})
                              .filter(([, group]) => isKnownGroup(group))
                              .map(([id, group]) => [resolve(id), group])
                      )
                    : rawChanges;
            const current = stored[key] && typeof stored[key] === "object" && !Array.isArray(stored[key]) ? stored[key] : {};
            const next = { ...current };
            for (const [entry, value] of Object.entries(changes ?? {})) {
                if (value === null) {
                    delete next[entry];
                } else {
                    next[entry] = value;
                }
            }
            let entries = Object.entries(next);
            if (key === "readPosts" && entries.length > STORE_LIMITS.readPosts) {
                entries = entries.sort((left, right) => right[1] - left[1]).slice(0, STORE_LIMITS.readPosts);
            } else if (key === "publisherNames" && entries.length > STORE_LIMITS.publisherNames) {
                entries = entries.slice(-STORE_LIMITS.publisherNames);
            }
            out[key] = Object.fromEntries(entries);
        }
        // Conditional removals, decided against what's stored: an entry is removed only if it still has
        // the given value (undo removes only marks a newer mark hasn't replaced).
        for (const [key, entries] of Object.entries(write.removeIfEquals ?? {})) {
            const current = out[key] ?? stored[key];
            if (!current || typeof current !== "object") {
                continue;
            }
            const next = { ...current };
            for (const [entry, expected] of Object.entries(entries ?? {})) {
                if (next[entry] === expected) {
                    delete next[entry];
                }
            }
            out[key] = next;
        }
        // Writer → publication merges, decided against what's stored: the writer's group moves to the
        // publication only when the publication has none, and the writer's own entry is removed.
        if (write.moveAssignments) {
            const next = { ...(out.assignments ?? stored.assignments ?? {}) };
            for (const [alias, canonical] of Object.entries(write.moveAssignments)) {
                // The destination follows the same chain as group changes (writer → subdomain → custom
                // domain), so the group lands where the feed looks for it.
                const destination = resolve(canonical);
                if (destination && destination !== alias && Object.hasOwn(next, alias)) {
                    if (!Object.hasOwn(next, destination)) {
                        next[destination] = next[alias];
                    }
                    delete next[alias];
                }
            }
            out.assignments = next;
        }
        return out;
    }

    function getStorageWriteKeys(write) {
        return [
            ...new Set([
                ...Object.keys(write.merge ?? {}),
                ...Object.keys(write.removeIfEquals ?? {}),
                ...(write.moveAssignments ? ["assignments", "publisherAliases"] : []),
                ...(write.merge?.assignments ? ["publisherAliases", "groups"] : [])
            ])
        ];
    }

    return {
        HIDDEN,
        UNASSIGNED,
        applyStorageWrite,
        getStorageWriteKeys,
        getCutoffDay,
        getPostCountForGroup,
        isPublisherVisible,
        isWithinDays,
        normalizePublisher,
        normalizeProfile,
        parsePostDay,
        sortGroupNames
    };
});
