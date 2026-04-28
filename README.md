# AI Chat Logger

A Chrome extension that captures and logs AI chat messages in real-time — token by token as the AI streams its response — from the most popular AI chat platforms.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![License](https://img.shields.io/badge/License-MIT-blue)

---

## Features

- **Real-time streaming capture** — logs each word as it's typed, not just after the message finishes
- **Supports 5 platforms** — Claude, ChatGPT, Gemini, and DeepSeek out of the box
- **Side panel viewer** — opens alongside your chat so you can monitor logs without switching tabs
- **Dual capture strategy** — DOM MutationObserver + network fetch/XHR interception for maximum reliability
- **Live status badge** — a small overlay on the page shows the extension is running and counts captured messages (toggle with `Alt+Shift+L`)
- **Export to JSON** — download your full chat log with one click
- **Clear logs** — wipe the session log from the viewer panel
- **Raw network stream view** — optional toggle to inspect the raw SSE chunks as they arrive
- **Dark mode support** — viewer panel respects your system theme
- **Streaming indicator** — a blinking cursor shows which assistant message is still being written

---

## Supported Sites

| Platform | URL |
|---|---|
| Claude | `claude.ai` |
| ChatGPT | `chat.openai.com`, `chatgpt.com` |
| Gemini | `gemini.google.com` |
| DeepSeek | `chat.deepseek.com` |

---

## Installation

### Option A — Install the .crx file (easiest)

1. Download `ai-chat-logger.crx` from the [Releases](https://github.com/togg53192-cmd/Ai-chat-logger/releases) page
2. Open `chrome://extensions` in your browser
3. Enable **Developer mode** (toggle in the top-right corner)
4. Drag and drop the `.crx` file onto the extensions page

> **Note:** Chrome may warn you about installing extensions outside the Web Store. Click **Keep** to proceed.

### Option B — Load unpacked (for development)

1. Download or clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the `deepseek/` folder (the one containing `manifest.json`)

---

## Usage

1. Navigate to any supported AI chat site (e.g. `chat.deepseek.com`, `claude.ai`)
2. Click the **AI Chat Logger** icon in your Chrome toolbar to open the side panel
3. Start a conversation — messages will appear in the panel in real-time as they stream
4. Use the toolbar in the panel to:
   - Toggle **Auto-scroll** to follow new messages automatically
   - Toggle **Show raw stream** to see the raw network chunks
   - Click **Export JSON** to download the full log
   - Click **Clear** to reset the current session log

A small status badge will appear in the bottom-right corner of the chat page confirming the extension is active. Press `Alt+Shift+L` to hide or show it.

---

## File Structure

```
deepseek/
├── manifest.json              # Extension manifest (Manifest V3)
├── background.js              # Service worker — manages log state and side panel
├── content/
│   ├── observer.js            # Content script — DOM MutationObserver per site
│   └── inject.js              # Page-world script — intercepts fetch() and XHR
└── viewer/
    ├── viewer.html            # Side panel UI
    ├── viewer.js              # Side panel logic — renders log entries live
    └── viewer.css             # Side panel styles (light + dark mode)
```

---

## How It Works

The extension uses two complementary capture strategies:

**1. DOM Observer (`observer.js`)**
A `MutationObserver` watches the chat page's DOM tree for changes. Each site has its own selector config to identify user and assistant message elements. When a node is first seen it gets registered with a unique ID and its text is sent to the background. On every subsequent mutation the text is diffed and an update is sent if it changed. A 750ms polling interval acts as a safety net for missed mutations.

**2. Network Interception (`inject.js`)**
A page-world script wraps `window.fetch` and `XMLHttpRequest` to intercept streaming API calls. It tees the response body so the original call is unaffected, then reads SSE chunks as they arrive and forwards them via `window.postMessage` to the content script.

**3. Background service worker (`background.js`)**
Aggregates log entries from all tabs, persists them to `chrome.storage.session` so they survive worker restarts, and broadcasts updates to any connected viewer panels over a long-lived `chrome.runtime.connect` port.

**4. Side panel viewer (`viewer.js`)**
Connects to the background over a persistent port and renders log entries incrementally. Handles `log:create` for new messages and `log:update` for streaming updates — updating only the text node of the relevant entry rather than re-rendering the whole list.

---

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Persist logs across service worker restarts via `chrome.storage.session` |
| `sidePanel` | Open the log viewer as a Chrome side panel |
| `scripting` | Inject the page-world fetch hook |
| `tabs` | Associate log entries with their source tab |

Host permissions are limited to the five supported AI chat domains.

---

## Privacy

All data stays local. Nothing is sent to any external server. Logs are held in `chrome.storage.session` (cleared when you close the browser) and are only accessible within the extension itself.

---

## Contributing

Pull requests are welcome! To add support for a new site, add a new entry to the `SITE_CONFIGS` block in `content/observer.js` with:
- `name` — display name
- `modelLabel()` — function returning a model string
- `findTurns()` — function returning `[{ node, role }]` for every visible chat turn

---

## License

MIT
