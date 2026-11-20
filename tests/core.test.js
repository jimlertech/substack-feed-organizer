const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

test("normalizePublisher uses the publisher hostname without www", () => {
    assert.equal(core.normalizePublisher("https://www.example.com/news/post?ref=inbox"), "example.com");
    assert.equal(core.normalizePublisher("https://writer.substack.com/p/post"), "writer.substack.com");
});

test("normalizePublisher rejects malformed and non-web URLs", () => {
    assert.equal(core.normalizePublisher("not a url"), null);
    assert.equal(core.normalizePublisher("javascript:alert(1)"), null);
});

test("normalizeProfile turns Note author links into one id per author", () => {
    assert.equal(core.normalizeProfile("https://substack.com/@AakashGupta"), "substack.com/@aakashgupta");
    assert.equal(core.normalizeProfile("https://substack.com/profile/12345-chris-tottman"), "substack.com/@12345");
    assert.equal(core.normalizeProfile("https://writer.substack.com/@someone"), null);
    assert.equal(core.normalizeProfile("https://substack.com/@someone/note/c-1"), null);
});

test("hidden publishers stay hidden under every filter", () => {
    const assignments = { "spam.com": core.HIDDEN, "example.com": "Markets" };
    assert.equal(core.isPublisherVisible("spam.com", null, assignments), false);
    assert.equal(core.isPublisherVisible("spam.com", core.UNASSIGNED, assignments), false);
    assert.equal(core.isPublisherVisible(["example.com", "spam.com"], "Markets", assignments), false);
    assert.equal(core.isPublisherVisible("other.com", null, assignments), true);
    assert.equal(core.getPostCountForGroup([{ publisherIds: ["spam.com"] }, { publisherIds: ["other.com"] }], core.UNASSIGNED, assignments), 1);
});

test("storage writes merge changes into what's stored", () => {
    const stored = { readPosts: { a: 1, b: 2 }, assignments: { x: "Tech" } };
    const out = core.applyStorageWrite(stored, {
        merge: { readPosts: { c: 3, a: null }, assignments: { y: "AI" } },
        set: { days: 7 }
    });
    // Another tab's entries (b, x) survive; only the changes are applied.
    assert.deepEqual(out.readPosts, { b: 2, c: 3 });
    assert.deepEqual(out.assignments, { x: "Tech", y: "AI" });
    assert.equal(out.days, 7);
    const many = Object.fromEntries(Array.from({ length: 3001 }, (_, index) => [`k${index}`, index]));
    assert.equal(Object.keys(core.applyStorageWrite({ readPosts: many }, { merge: { readPosts: {} } }).readPosts).length, 3000);
    // A move into a group deleted in another tab is dropped; Hidden and Unassigned always apply.
    const moved = core.applyStorageWrite(
        { groups: ["Tech"], assignments: { a: "Tech" } },
        { merge: { assignments: { a: "Gone", b: core.HIDDEN, c: "Tech" } } }
    );
    assert.deepEqual(moved.assignments, { a: "Tech", b: core.HIDDEN, c: "Tech" });
});

test("storage writes decide undo and writer merges against what's stored", () => {
    // Undo removes a mark only if it still has the batch's time; a newer mark from another tab stays.
    const undone = core.applyStorageWrite({ readPosts: { a: 5, b: 9 } }, { removeIfEquals: { readPosts: { a: 5, b: 6 } } });
    assert.deepEqual(undone.readPosts, { b: 9 });
    // The writer's group moves only when the publication has none in storage.
    const moved = core.applyStorageWrite(
        { assignments: { "@w1": "AI", "@w2": "AI", "pub2.com": "News" } },
        { moveAssignments: { "@w1": "pub1.com", "@w2": "pub2.com" } }
    );
    assert.deepEqual(moved.assignments, { "pub1.com": "AI", "pub2.com": "News" });
    assert.deepEqual(core.getStorageWriteKeys({ moveAssignments: {}, removeIfEquals: { readPosts: {} } }).sort(), ["assignments", "publisherAliases", "readPosts"]);
});

test("writer merges keep groups whichever tab's write lands first", () => {
    // Order 1: another tab assigned the writer, then the merge arrives and moves the group.
    const assignedFirst = core.applyStorageWrite(
        { assignments: { "@w": "AI" }, publisherAliases: {} },
        { merge: { publisherAliases: { "@w": "pub.com" } }, moveAssignments: { "@w": "pub.com" } }
    );
    assert.deepEqual(assignedFirst.assignments, { "pub.com": "AI" });
    // Order 2: the merge is saved first, then a tab that hasn't seen it assigns the writer.
    const mergedFirst = core.applyStorageWrite(
        { assignments: {}, publisherAliases: { "@w": "pub.com" } },
        { merge: { assignments: { "@w": "AI" } } }
    );
    assert.deepEqual(mergedFirst.assignments, { "pub.com": "AI" });
    assert.ok(core.getStorageWriteKeys({ merge: { assignments: {} } }).includes("publisherAliases"));
    // Two steps: a saved subdomain → custom domain move, then a new writer → subdomain merge. A hidden
    // writer stays hidden on the custom domain the feed uses, and an existing group there is kept.
    const twoHops = core.applyStorageWrite(
        { assignments: { "@w": core.HIDDEN, "@v": "AI", "custom.com": "News" }, publisherAliases: { "pub.substack.com": "custom.com" } },
        { merge: { publisherAliases: { "@w": "pub.substack.com" } }, moveAssignments: { "@w": "pub.substack.com", "@v": "pub.substack.com" } }
    );
    assert.deepEqual(twoHops.assignments, { "custom.com": "News" });
    const hiddenTwoHops = core.applyStorageWrite(
        { assignments: { "@w": core.HIDDEN }, publisherAliases: { "pub.substack.com": "custom.com" } },
        { merge: { publisherAliases: { "@w": "pub.substack.com" } }, moveAssignments: { "@w": "pub.substack.com" } }
    );
    assert.deepEqual(hiddenTwoHops.assignments, { "custom.com": core.HIDDEN });
});

test("publisher group filtering leaves unassigned publishers in the all view", () => {
    const assignments = { "example.com": "Markets" };
    assert.equal(core.isPublisherVisible("example.com", null, assignments), true);
    assert.equal(core.isPublisherVisible("other.com", null, assignments), true);
    assert.equal(core.isPublisherVisible("example.com", "Markets", assignments), true);
    assert.equal(core.isPublisherVisible("other.com", "Markets", assignments), false);
});

test("publisher group filtering doesn't read inherited assignment properties", () => {
    assert.equal(core.isPublisherVisible("toString", "Markets", {}), false);
});

test("an item linking several publications matches a group when any of them is in it", () => {
    const assignments = { "a.com": "Markets", "b.com": "AI" };
    assert.equal(core.isPublisherVisible(["x.com", "b.com"], "AI", assignments), true);
    assert.equal(core.isPublisherVisible(["x.com", "b.com"], "Markets", assignments), false);
    assert.equal(core.isPublisherVisible([], "AI", assignments), false);
    assert.equal(core.isPublisherVisible([], null, assignments), true);
});

test("the unassigned filter shows posts whose publishers have no group", () => {
    const assignments = { "a.com": "Markets" };
    assert.equal(core.isPublisherVisible("x.com", core.UNASSIGNED, assignments), true);
    assert.equal(core.isPublisherVisible("a.com", core.UNASSIGNED, assignments), false);
    assert.equal(core.isPublisherVisible(["x.com", "a.com"], core.UNASSIGNED, assignments), false);
    assert.equal(core.isPublisherVisible([], core.UNASSIGNED, assignments), true);
    assert.equal(core.getPostCountForGroup([{ publisherIds: ["x.com"] }, { publisherIds: ["a.com"] }], core.UNASSIGNED, assignments), 1);
});

test("group names sort alphabetically, ignoring case and ordering numbers naturally", () => {
    const groups = ["sports", "AI", "News", "investing", "Group 10", "Group 2"];
    assert.deepEqual(core.sortGroupNames(groups), ["AI", "Group 2", "Group 10", "investing", "News", "sports"]);
    assert.deepEqual(groups[0], "sports");
});

test("group post counts include only assigned publishers", () => {
    const cards = [
        { publisherId: "example.com" },
        { publisherId: "example.com" },
        { publisherId: "other.com" }
    ];
    const assignments = { "example.com": "Markets" };
    assert.equal(core.getPostCountForGroup(cards, null, assignments), 3);
    assert.equal(core.getPostCountForGroup(cards, "Markets", assignments), 2);
    assert.equal(core.getPostCountForGroup(cards, "Unassigned", assignments), 0);
});

const NOW = new Date(2026, 10, 19, 9, 30);
const day = (year, month, date) => new Date(year, month - 1, date).getTime();

test("parsePostDay reads Substack's time, month-day and full-date labels", () => {
    assert.equal(core.parsePostDay("9:02 AM", NOW).getTime(), day(2026, 11, 19));
    assert.equal(core.parsePostDay("Nov 18", NOW).getTime(), day(2026, 11, 18));
    assert.equal(core.parsePostDay("NOV 5", NOW).getTime(), day(2026, 11, 5));
    assert.equal(core.parsePostDay("Mar 3, 2025", NOW).getTime(), day(2025, 3, 3));
    assert.equal(core.parsePostDay("Yesterday", NOW).getTime(), day(2026, 11, 18));
    assert.equal(core.parsePostDay("3d", NOW).getTime(), day(2026, 11, 16));
    assert.equal(core.parsePostDay("14m", NOW).getTime(), day(2026, 11, 19));
    assert.equal(core.parsePostDay("Nov 9, 2026, 1:38 PM", NOW).getTime(), day(2026, 11, 9));
});

test("parsePostDay puts a yearless date after today in the previous year", () => {
    const january = new Date(2027, 0, 4, 8, 0);
    assert.equal(core.parsePostDay("Dec 30", january).getTime(), day(2026, 12, 30));
});

test("parsePostDay returns null for text that isn't a date", () => {
    assert.equal(core.parsePostDay("The Pragmatic Engineer", NOW), null);
    assert.equal(core.parsePostDay("12 min read", NOW), null);
    assert.equal(core.parsePostDay("Foo 12", NOW), null);
});

test("isWithinDays counts today plus the previous N calendar days and keeps unknown dates", () => {
    assert.equal(core.isWithinDays(new Date(day(2026, 11, 18)), 1, NOW), true);
    assert.equal(core.isWithinDays(new Date(day(2026, 11, 17)), 1, NOW), false);
    assert.equal(core.isWithinDays(new Date(day(2026, 11, 5)), 14, NOW), true);
    assert.equal(core.isWithinDays(new Date(day(2026, 11, 4)), 14, NOW), false);
    assert.equal(core.isWithinDays(null, 7, NOW), true);
    assert.equal(core.isWithinDays(new Date(day(2020, 1, 1)), null, NOW), true);
});
