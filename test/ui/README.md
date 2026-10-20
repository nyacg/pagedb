# Browser checks (Playwright), against a deployed Worker

Run from the repo root (they read `.env` for the admin token where needed):

    B=https://pagedb-preview.do-pool-lab.workers.dev node test/ui/check.cjs

| script | checks |
|---|---|
| check.cjs | tracker: list, infinite scroll, search terms, owner suggestions, detail, board, feed, a two-tab edit |
| search.cjs | tracker: stacked search chips (priority, tag, comment, status), results checked against the database |
| live-comment.cjs | tracker: comment search is live (a matching comment adds the issue, deleting it removes it) |
| create.cjs | tracker: a new issue reaches other tabs (list, scrolled list, board) |
| hn.cjs, hn-thread.cjs | Hacker News pages, a thread, a live reply and upvote across tabs |
| hn-search.cjs | Hacker News: the search box (typed, submitted), stopwords ignored |
| place.cjs | r/place: canvas, pixel history, a user's pixels, a paint across tabs, the timelapse |
| sheet.cjs | taxi sheet: jump to a row, sorts, group counts and filters, note and tip edits across tabs |
