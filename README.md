# Gemini Browser Controller

A Chrome extension that uses Google's Gemini API to control your browser with natural language. Click, type, navigate, take screenshots, and manage tab groups — all by describing what you want in plain English.

## Features

- **Natural Language Browser Control** — Tell Gemini what to do: "Click the login button", "Fill in the search box with cats", "Scroll down"
- **Chrome DevTools Protocol** — Uses `chrome.debugger` for reliable screenshots and low-level browser control
- **DOM Inspection** — Automatically builds a simplified DOM tree so Gemini understands the page structure
- **Element Highlighting** — Visually shows which elements are being targeted during actions
- **Tab Group Management** — Create, modify, and organize tab groups via commands
- **Side Panel Chat** — Persistent chat interface in Chrome's side panel for ongoing interaction
- **Multi-Action Chains** — Gemini can plan and execute sequences of actions in order
- **Conversation Memory** — Maintains context across commands within a session

## Supported Actions

| Action | Description | Example Command |
|--------|-------------|-----------------|
| Click | Click any element | "Click the Submit button" |
| Type | Type text into inputs | "Type hello@example.com in the email field" |
| Navigate | Go to a URL | "Go to github.com" |
| Scroll | Scroll page or element | "Scroll down" |
| Screenshot | Capture the page | "Take a screenshot" |
| Extract | Pull data from elements | "Get all the links on this page" |
| Keyboard | Press keys | "Press Enter" |
| Hover | Hover over elements | "Hover over the dropdown menu" |
| Select | Choose dropdown options | "Select 'Large' from the size dropdown" |
| Tab Management | Open/close/switch tabs | "Open a new tab to wikipedia.org" |
| Tab Groups | Organize tabs | "Create a tab group called Research" |
| Evaluate | Run JavaScript | "Run document.title" |
| Wait | Wait for elements/time | "Wait for the loading spinner to disappear" |

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the `chromecontroller` directory
5. The extension icon will appear in your toolbar

## Setup

1. Click the extension icon in your toolbar
2. Enter your Gemini API key (get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey))
3. Click **Save** — the key is validated and stored locally

## Usage

### Popup
Click the extension icon for quick commands and action buttons:
- **Screenshot** — Capture the current page
- **Inspect** — Get a description of the current page
- **Tab Groups** — List all tabs and groups
- **Stop** — Cancel a running command

### Side Panel
Click the side panel button (in the popup header) for a persistent chat interface. The side panel stays open as you browse, maintaining conversation context.

### Example Commands

```
Go to google.com and search for "chrome extensions"
Click the first search result
Scroll down to the bottom of the page
Fill in the username field with admin and the password field with secret123
Create a tab group called "Work" with blue color
Take a screenshot
Open a new tab to github.com
List all open tabs and their groups
```

## Architecture

```
manifest.json        — Extension manifest (Manifest V3)
background.js        — Service worker: orchestrates everything
gemini-api.js        — Gemini API client with conversation history
content.js           — Content script: DOM interaction and element targeting
content.css          — Styles for element highlighting overlay
popup.html/css/js    — Popup UI for quick access
sidepanel.html/css/js — Side panel chat interface
icons/               — Extension icons
```

## Permissions

- `activeTab` — Access the current tab
- `tabs` — Query and manage tabs
- `tabGroups` — Create and manage tab groups
- `debugger` — Chrome DevTools Protocol for screenshots
- `scripting` — Inject content scripts
- `storage` — Store API key locally
- `sidePanel` — Side panel UI
- `<all_urls>` — Interact with any webpage

## API Key Security

Your Gemini API key is stored locally in Chrome's extension storage (`chrome.storage.local`). It is never sent anywhere except directly to Google's Gemini API endpoints.

## Requirements

- Google Chrome (version 114+)
- A Google Gemini API key ([get one here](https://aistudio.google.com/apikey))
