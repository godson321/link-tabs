# Background Link Tabs — Design Specification

**Status:** User-approved direction; awaiting spec review  
**Target:** `E:\\90 AI\\浏览器扩展`  
**Date:** 2026-09-28

## Goal

Build a Microsoft Edge extension that can make ordinary left-clicks on web links open in a new tab without switching away from the current tab. The user can quickly enable/disable the behavior and configure global, domain, and URL-pattern rules.

## Product behavior

- The extension is enabled by default after installation.
- The global default action is **Background tab**: create a new tab, leave it inactive, and keep the current tab selected.
- A toolbar popup exposes a clear master on/off toggle.
- An options page lets the user change the global default and add, edit, reorder, or remove rules.
- Each rule can choose one of three actions: **Background tab**, **Foreground tab**, or **Use browser behavior** (do not intercept; let the website/browser handle the link normally).
- Supported rule kinds:
  - **Domain**: match an exact hostname by default, with an explicit “include subdomains” checkbox.
  - **URL pattern**: match an HTTP(S) URL using `*` as a wildcard for zero or more characters; compare hostnames case-insensitively.
- Rule resolution: matching URL-pattern rules take precedence over domain rules; otherwise use the global default. Within each rule kind, the first matching rule in the user-defined order wins.
- Turning the extension off restores normal browser/site link behavior without deleting settings.

## Scope and exclusions

- Intercept unmodified primary-button clicks on ordinary `<a href>` links whose destination is HTTP or HTTPS.
- Preserve native behavior for Ctrl/Shift/Alt-modified clicks, middle/right clicks, downloads, `mailto:`, `javascript:`, other non-web schemes, and same-document fragment navigation.
- Browser-protected pages (for example `edge://` pages and the Edge Add-ons store) cannot be controlled by the extension.
- This extension changes link navigation, not arbitrary button-driven JavaScript navigation.
- Sites that implement custom click behavior may be affected when a link is intercepted; the implementation should limit interception to eligible anchors and avoid unrelated page changes.

## Architecture

- **Manifest V3 content script:** observes eligible anchor clicks on permitted web pages and resolves the configured action.
- **Service worker:** receives the resolved destination and creates a tab. Background action uses `active: false`; foreground action uses `active: true`.
- **Toolbar popup:** reads/writes the master enabled flag for quick control.
- **Options page:** edits the default action and ordered domain/URL rules.
- **Shared rule resolver:** a small pure module used by the content script and automated tests.
- **Storage:** `chrome.storage.local`; settings remain local and no browsing data is transmitted externally.

## Permissions and privacy

To apply to links on all ordinary websites, the extension requires access to all websites (host access for the content script), plus extension storage. The install/permission UI must make this broad access understandable. The extension performs no analytics, remote requests, or browsing-history collection; it stores only user settings.

## Interaction flow

1. On an eligible plain left-click, the content script finds the nearest eligible anchor and resolves the URL/domain rules.
2. If disabled or the resulting action is **Use browser behavior**, it leaves the click untouched.
3. For a background/foreground action, it prevents the anchor's default navigation and sends the destination/action to the service worker.
4. The service worker creates a tab with the selected active state.
5. The current tab remains selected for the default background action.

## Failure behavior

- On first install, initialize the extension as enabled with **Background tab** as the global default. If settings cannot be read at runtime, preserve native browser behavior and log a diagnostic rather than risk losing the original navigation.
- If a message/tab creation fails after interception, report a diagnostic to the extension console; do not silently change the requested action to a foreground tab.
- Invalid rules are rejected in the options page with a clear validation message and are not saved.

## Verification / acceptance criteria

1. With a fresh install and extension enabled, a plain left-click on an HTTP(S) link creates a new inactive tab and leaves the source tab selected.
2. A URL-pattern rule overrides a matching domain rule; domain rules apply when no URL rule matches; unmatched links use the configured global default.
3. Background, foreground, and browser-behavior actions each produce their specified result.
4. Disabling the master toggle restores native behavior; re-enabling restores the saved configuration.
5. Modified clicks, downloads, non-HTTP(S) links, and same-document fragments retain native behavior.
6. Rule matching and validation have automated tests; the unpacked extension is manually smoke-tested in Edge.
7. The repository includes concise instructions for loading the unpacked extension through `edge://extensions`.

## Approaches considered

- **Recommended/selected: Edge MV3 extension with a content script and service worker.** Meets global interception, background tab creation, and editable rules; requires broad host access.
- **User script:** lower setup overhead but weaker all-site management and settings UX.
- **Browser-native settings/context menu:** cannot make ordinary left-clicks universally open inactive tabs, so it does not meet the requirements.
