# Feed Organizer for Substack

A Chrome and Edge extension that adds your own publisher groups to Substack's Subscriptions (`substack.com/inbox`) and Home feed (`substack.com` and `substack.com/home`). It keeps posts on Substack and stores group names, publisher hostnames and display names, assignments, read marks, the selected filters, and feed width in the browser's extension storage. It doesn't copy or fetch article content. See [PRIVACY.md](PRIVACY.md).

Not made by or affiliated with Substack.

The bar uses Substack's colors, font and rounded corners, and switches between light and dark with Substack's own appearance setting.

It targets desktop Chrome and Edge. Safari on iPhone and iPad can't load this Chromium extension.

## Install for local use

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Open or reload `https://substack.com/inbox`.
5. Open the gear menu at the right end of the bar and choose **Manage groups**. The list on the left shows All publishers, Unassigned, your groups and Hidden, each with a count; click one to see its publishers. Use **+ New group** to add a group, then drag publishers onto it or pick a group from the button on each row. Manage opens over the page; close it with the X, Escape, or a click outside it.
   To hide a publisher or Note author entirely, click the eye-off button at the end of its row, or drag it onto Hidden. Their posts disappear from every view, including All publishers and Unassigned. Click the eye button to show them again, which returns them to Unassigned.

The bar has 4 controls: the group dropdown, the date control (**Day**, **3d**, **7d**, **All**), refresh, and a gear menu holding **Manage groups**, **Keyboard shortcuts**, **Pause organizer**, the read-post options, **Width** and **Sidebar**.

Choose a **Width** in the gear menu to change the feed width. Standard is Substack's 600px column, Wide is 960px and Full fills the window up to 1400px. The choice is saved and stays the same when you move between Home and Subscriptions; the page fades in after the switch instead of showing the column resize.

Use the date control to hide older posts. **Day**, **3d** and **7d** keep today and the previous 1, 3 or 7 calendar days; **All** shows any date. Dates come from the label Substack shows on each post, so a post with an unreadable label stays visible. It combines with the group filter.

With **All**, posts load as you scroll, the way Substack normally works. With **Day**, **3d** or **7d**, the bar loads older posts in the background only as far as the range: it stops after 2 batches in a row where fewer than a quarter of the new posts are in range, at the end of the feed, or at 600 posts on Subscriptions and 150 on Home (which slows down past about 200). If the posts already on the page reach past the range, it doesn't load at all. Switching groups, or to a shorter range, only re-filters what's loaded. Subscriptions and Home work the same way. While loading, the bar shows "Loading posts… N checked" with a **Stop** button and a loading ring in the middle of the screen, and hides the posts so the view doesn't move. If a filter matches no posts, a short message says so instead of leaving the page blank. While a filter is on or a publisher is hidden, newly loaded posts stay hidden until they're checked, so non-matching posts never flash on screen.

The refresh button (circular arrow, next to the gear) reloads the page so Substack fetches new articles, then the load overlay and the loading above run again.

On a full page load or a switch between Home and Subscriptions, the feed area stays hidden behind a loading ring (shown only after 250ms) until the filter has run and, with a date range, until the background load finishes, then fades in over 600ms. With All it shows almost at once. The left navigation stays visible. A 10-second cutoff shows the page regardless, so it can't stay hidden if something fails.

Use **Sidebar** in the gear menu to show or hide the right sidebar's panels (it appears only on pages with a sidebar). **Subscriptions** and **Recommended for you** are hidden by default.

Suggestion carousels in the Home feed, such as **People to follow**, are always hidden. They aren't counted as posts and don't appear in Manage or under Unassigned.

When Home shows the same article twice (for example a writer's Note promoting their new post, next to the post itself), only one is kept: the article itself when it's in the feed, otherwise the first Note that shares it. The hidden copy isn't counted. A Note's own text is hidden along with it.

## Groups and publishers

- **Group order:** drag a group by the handle at its left in Manage's list, or use **Move up** and **Move down** in its ⋯ menu. The group dropdown follows that order.
- **Rename and delete:** in each group's ⋯ menu. Delete asks first when publishers are in the group, and they become Unassigned.
- **Group labels:** in All publishers, each post shows a small tag with its group above it.
- **All known publishers:** Manage's "All known" switch lists every publisher the extension has seen or assigned, including ones with no posts on the page. The counts on the left follow the switch. Search narrows the list; at most 200 rows show at once.
- **Bulk edits:** tick several publishers, then drag any ticked row onto a group, Unassigned or Hidden, or use **Move to…** in the bar above the list. **Deselect** clears the ticks. Only visible publishers stay ticked.
- **Backup:** **Export** in Manage downloads your groups, assignments and read marks as a JSON file. **Import** checks the file is a complete export from this extension, shows what it will replace, and asks before replacing everything.

## Reading

- **Read marks:** press **M** on the selected post to mark it read (opening a post doesn't mark it). Read posts are dimmed. **Hide read posts** in the gear menu removes them; **Mark shown as read** marks everything on screen, with **Undo**.
- **Keyboard:** **J**/**K** select the next or previous post, **g g** jumps to the first post and **G** to the last loaded one, **O** or **Enter** opens it (a post or Note that shares an article opens in Substack's reader; any other Note opens in full in an overlay laid out like that reader, closed with Esc or the X. Clicking a Note on Home does the same; its links and buttons work as usual), **M** toggles read (with read posts hidden, the selection moves to the next post), **Shift+M** marks every post matching the current filter read, not only those in view (or, when they're all read, unread), **H** hides or shows read posts, **1**–**4** pick Day, 3d, 7d or All, and **[** / **]** switch to the previous or next group, selecting its newest post. **A** shows All publishers, **R** reloads the articles, and **T** switches between Home and Subscriptions. **?** shows or hides the shortcut list. Shortcuts are off while typing, while a menu or dialog is open, and while posts load.
- **Pause:** **Pause organizer** in the gear menu leaves Substack as it normally looks: no filtering, width, labels, dimming, hidden panels, loading or shortcuts. The bar shrinks to its name and a **Resume** button. Groups and settings are kept.
- Settings are saved by a small background script, which applies changes from every open Substack tab in order, so two tabs can't overwrite each other.

The extension does not read or store passwords, fetch posts, or change Substack subscription settings. Group assignments stay in the browser profile where you installed it.

## Home feed

The same bar appears above the Home feed, sharing your groups, filters and width with the Inbox.

- An item matches a group when it links an article from a publication in that group. Notes without an article link, or linking only publications outside the group, are hidden while a group is selected.
- Home links articles by website only. The Manage list shows publication names the Inbox has already seen, and the website address otherwise. Every Home post also counts under its author, who appears in Manage by name and can be assigned like a publication. A post counts as Unassigned only when neither its author nor any publication it links is in a group, so a Note that shares another publication's article still follows its author's group. A writer and their own publication are one entry: the extension looks up each new writer's main publication on Substack's public profile (once per writer, saved), then lists the pair under the writer's name, with the publication's name next to the post count when it's known. If the writer and the publication were in different groups, the publication's group is kept.
- Dates come from each item's full timestamp.
- On Home, the width is applied once the feed is found; the page-load overlay usually covers that change.

## Development

Run the focused checks with:

```powershell
npm test
```

`npm run preview` serves `preview.html` at `http://127.0.0.1:4173/`, a fixture Inbox for testing the bar without signing in.

Each page has an adapter in `content.js` (`ADAPTERS`). The Inbox adapter uses Substack's `.reader2-inbox-post` card marker and publisher links inside `.reader2-post-head`. The Home adapter uses feed items marked `[role="article"]` with a `feedItem` class, article links containing `/p/`, and timestamp `title` attributes. If Substack changes those page elements, the matching adapter needs its selectors updated.

## Releasing

1. Raise `version` in `manifest.json` (the stores reject a repeated version).
2. Run `npm test`, then `npm run package`. The upload is `dist/feed-organizer-<version>.zip`, holding only the files the extension loads.
3. Upload the zip to the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) and [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview). Listing text and form answers are in [STORE.md](STORE.md).

## License

[MIT](LICENSE)
