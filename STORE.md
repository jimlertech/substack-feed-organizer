# Store listing

Text and answers to paste into the Chrome Web Store and Edge Add-ons forms. Build the upload with `npm run package`; the zip lands in `dist/`.

## Name

Feed Organizer for Substack

## Short description (132 characters max)

Sort your Substack Home feed and Subscriptions into your own publisher groups, with date filters, read marks and keyboard shortcuts.

## Description

Feed Organizer for Substack adds a small bar to your Substack Home feed and Subscriptions so you can read by topic instead of one long stream.

Groups
- Create your own groups (Tech, Markets, News…) and put each publisher in one.
- Switch groups from the bar or with [ and ]. Each post in All publishers shows its group.
- Hide publishers you never want to see.
- Manage window: drag publishers onto groups, tick several to move them at once, rename, reorder and delete groups.

Filters
- Show only the past day, 3 days or 7 days. The extension loads older posts in the background until the range is covered.
- Duplicates are removed: a Note sharing an article appears once.
- Choose a wider feed and hide sidebar panels you don't use.

Reading
- Mark posts read with M; read posts are dimmed, or hidden with Hide read posts (H).
- Keyboard: J/K next and previous, g g first, G last, O open, 1-4 date range, T switch between Home and Subscriptions, ? for the full list.

Private by design
- Everything stays in your browser. No account, no server, no tracking.
- Export and import your setup as a file.
- Pause the organizer any time to see Substack as usual.

Not made by or affiliated with Substack.

## Category

Chrome: Productivity (Workflow & planning). Edge: Productivity.

## Language

English

## Privacy

- Privacy policy URL: https://github.com/jimlertech/substack-feed-organizer/blob/main/PRIVACY.md
- Single purpose: organize the Substack Home feed and Subscriptions page by user-defined publisher groups.
- `storage` permission: saves your groups, assignments, read marks and view settings on your device.
- Host permission `https://substack.com/*`: the extension runs only on Substack pages, to filter and label the feed, and looks up which publication a writer runs from Substack's public profile endpoint, and loads a shortened Note's full text from Substack when you open it.
- Remote code: none. All code ships in the package.
- Data use disclosures (Chrome): no data collected or sold. Tick none of the data types; certify the three statements (not sold, not used for unrelated purposes, not used for credit).

## Support

- Support / homepage URL: https://github.com/jimlertech/substack-feed-organizer
- Issues: https://github.com/jimlertech/substack-feed-organizer/issues

## Images

- Icon: `icons/icon-128.png`.
- Screenshots: 1280×800 PNG, at least 1 (Chrome allows 5, Edge 10). Take them on your own Substack Home and Subscriptions pages at 1280×800: the bar with a group selected, the Manage window, and the keyboard shortcuts window.
- Chrome small promo tile (optional): 440×280.
