# Privacy policy

Feed Organizer for Substack runs only on substack.com pages and keeps everything in your browser.

## What it stores

In the browser's extension storage (`chrome.storage.local`), on your device only:

- Your group names and their order.
- Which group each publisher is in, and which publishers you've hidden.
- Publisher names and links between a writer and their publication, so a writer and their publication count as one publisher.
- Read marks: the address of each post you marked read and when, up to 3000 entries, kept for 120 days.
- Your view settings: selected group, date range, feed width, sidebar panels, Hide read posts and Pause.

## What it sends

Nothing leaves your browser except requests to Substack's own site:

- When a Note's author is a writer with a publication, the extension asks Substack's public profile endpoint (`substack.com/api/v1/user/<handle>/public_profile`) which publication that writer runs.
- When you open a shortened Note, the extension loads its full text from Substack (`substack.com/api/v1/reader/comment/<id>`), the same request Substack's own Note page makes.

These requests go only to Substack, with your existing Substack session, the same as Substack's own pages.

The extension has no server, no analytics, no ads and no tracking. It doesn't read or copy article content.

## Export

**Export** in the Manage window downloads your settings as a JSON file to your computer. Nothing is uploaded.

## Removing your data

Uninstalling the extension deletes everything it stored.

## Contact

Questions or problems: open an issue at https://github.com/jimlertech/substack-feed-organizer/issues.

Feed Organizer for Substack isn't made by or affiliated with Substack.
