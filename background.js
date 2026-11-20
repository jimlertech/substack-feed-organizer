// The extension's single storage writer. Content scripts in every tab send their changes here; applying
// them one at a time to what's stored keeps tabs from overwriting each other's newer settings.
importScripts("core.js");

const CORE = globalThis.SubstackOrganizerCore;
let queue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "substack-organizer-write") {
        return false;
    }
    queue = queue
        .then(async () => {
            const keys = CORE.getStorageWriteKeys(message.write);
            const stored = keys.length ? await chrome.storage.local.get(keys) : {};
            await chrome.storage.local.set(CORE.applyStorageWrite(stored, message.write));
        })
        .then(
            () => sendResponse({ ok: true }),
            (error) => sendResponse({ ok: false, error: String(error?.message ?? error) })
        );
    return true;
});
