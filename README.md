# Subtitle Export for Udemy

Chrome extension that exports subtitles from Udemy courses as a text file — useful for study notes, searching through lectures, and offline reference.

**Open source** — full code available in this repository.

## How It Works

The extension appears as a floating panel on any Udemy course page. It automatically detects the course, loads the lesson list, and collects VTT subtitle files as you navigate through lectures (or lets it run automatically).

Collected subtitles are stored locally in your browser and can be exported as a single `.txt` file at any time.

## Installation

### From source (developer mode)

1. Clone or download this repository
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked** → select the folder with `manifest.json`
5. Navigate to any Udemy course lesson — the panel appears automatically

## Usage

1. **Open any Udemy course lesson** — the extension panel appears in the top-right corner of the page
2. **Wait for loading** — the panel shows a spinner while it fetches the course curriculum
3. **Click "Start"** to begin collecting subtitles from lesson 1, or **click any lesson** in the list to set your starting position, then click **"Continue"**
4. The extension navigates through lessons automatically, collecting subtitle files
5. **Click "Stop"** at any time — progress is saved, you can resume later
6. **Click "Export"** to download all collected subtitles as a single text file

### Panel controls

| Button | Action |
|--------|--------|
| ▶ Start | Begin from lesson 1 (asks for confirmation) |
| ⏩ Continue | Resume from current position |
| ⏹ Stop | Pause collection (progress saved) |
| 💾 Export | Download subtitles as `.txt` file |
| 🗑 Reset | Clear all collected data for this course |

### Tips

- You can **click any lesson** in the list to jump to that position before continuing
- The **▶ button** next to each lesson starts collection from that specific lesson
- Lessons with ✓ already have subtitles saved
- The panel is **draggable** — grab the header to reposition it
- **Minimize** with the − button in the header
- Progress **persists across page reloads** and browser restarts
- Works with **multiple courses** — each course has separate storage

## How subtitles are collected

The extension uses the browser's Performance API to detect `.vtt` (WebVTT) subtitle files that Udemy loads when you watch a lecture. It reads these files and stores them locally via `chrome.storage`. No external servers are involved — everything stays in your browser.

## Permissions

| Permission | Why |
|------------|-----|
| `storage` | Save collected subtitles and progress locally |
| `activeTab` | Communicate between popup and course page |
| `scripting` | Inject the panel UI into Udemy pages |
| `*://*.udemy.com/*` | Access Udemy API for course curriculum |
| `*://*.udemycdn.com/*` | Fetch VTT subtitle files from Udemy CDN |

## Privacy

- **No data leaves your browser.** All subtitles are stored locally in `chrome.storage.local`
- **No analytics, no tracking, no external requests** except to Udemy's own API (for course data) and CDN (for subtitle files)
- **No account required.** The extension uses your existing Udemy session cookies
- The extension only activates on `udemy.com/course/*/learn/*` pages

## File structure

```
manifest.json    — Extension manifest (Manifest V3)
content.js       — Main logic: curriculum fetch, VTT scan, UI panel
panel.css        — Panel styles
background.js    — Badge counter updates
popup.html       — Extension popup (quick stats)
popup.js         — Popup logic
icon48.png       — Toolbar icon
icon128.png      — Store icon
```

## Requirements

- Google Chrome (or any Chromium-based browser)
- An active Udemy account with access to the course

## License

MIT
