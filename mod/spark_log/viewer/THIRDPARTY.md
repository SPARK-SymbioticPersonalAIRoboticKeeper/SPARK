# Third-party libraries

- marked 18.0.14 - MIT - https://github.com/markedjs/marked
- DOMPurify 3.4.16 - MPL-2.0 OR Apache-2.0 - https://github.com/cure53/DOMPurify
- Mermaid 12.1.0 - MIT - https://github.com/mermaid-js/mermaid

These files are vendored so the viewer works without network access at runtime.

Upstream license texts distributed with this repository are stored under `vendor/licenses/`. The filename `THIRDPARTY.md` itself is not required by the MIT license; it is kept as a compact inventory.

## OpenUI generative and interactive UI runtime

- **Package:** `@openuidev/browser-bundle` **0.2.1**, **MIT**.
- **Upstream:** https://github.com/thesysdev/openui/tree/main/packages/browser-bundle
- **Distribution:** https://www.npmjs.com/package/@openuidev/browser-bundle
- **Pinned vendored runtime:** `vendor/openui-bundle-0.2.1.min.js` (SHA-256 `bba936ff93f31a2955460f40d80bcd329b6a5848d6a05df54427e5dd137181df`).
- **Pinned vendored stylesheet:** `vendor/openui-styles-0.2.1.css` (SHA-256 `93b69b218203bd054a88b7c8821d6c0dc6944af38119ada37e8082e59c0a18f3`).
- **License:** `vendor/licenses/openui-MIT.txt` (verified identical to the LICENSE in pinned npm package 0.2.1).
- **Embedded third-party dependencies:** React/ReactDOM and OpenUI React runtime/UI packages are bundled, as documented by the npm package. The distributed code is not individually authored by SPARK.
- **Role in SPARK:** OpenUI renders archived CodeBlock and WritingBlock using its own React components, provides its own CodeBlock copy control and interactive runtime, and exposes `onAction` callbacks. A narrow compatibility bridge is required because OpenAI ChatGPT DIL and OpenUI Lang are different protocols. The bridge never removes original JSONL callbacks or rewrites the saved conversation.
- **Scope:** a locally supported action such as clipboard Copy can run on user click; original ChatGPT host-specific operations require a live authorized host. The offline Viewer records and exposes original action definitions instead of fabricating successful remote execution.

**No external CDN is required at Viewer runtime.** All added assets are pinned under the existing `vendor/` directory; no new project-root or Level1 directory was created.
