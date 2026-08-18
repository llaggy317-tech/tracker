# PROJECT GUIDELINES & INTEGRITY RULES (CRITICAL)

## ⚠️ STRICT DEVELOPMENT RULES

### 1. Do Not Modify Unrelated Code, CSS, Tokens, or Architecture
* **Rule**: When fixing an issue or adding a provider, **NEVER** modify unrelated files, stylesheets (CSS), token formats, or core data flow.
* **Scope**: Only touch the exact components strictly necessary to resolve the specific task.

---

### 2. Preserve Live Terminal / Console Process Logs
* The terminal window launched from `start.bat` (`server.js`) **must always display live, detailed process information** for each consignment:
  - `[TOKEN]` Session token generation and validation.
  - `[CAPTCHA]` CAPTCHA fetching and local Python OCR auto-solving (`"Solving for <ID>... Solved: <ANSWER>"`).
  - `[TRACK]` Live query status per consignment: `<ID> → <STATUS> (<DETAILS>)`.
  - `[RETRY]` Captcha mismatch or network retry attempts.
  - `[ERROR]` Specific error reasons (timeout, session expiry, unreachable upstream).
* **Never suppress, truncate, or remove process logging from `server.js`.**

---

### 3. Keep India Post Official Engine Pristine
* The **India Post Official** tracking pipeline (Next.js Server Actions, RSC parser, OCR auto-solver, session token retrieval) is the primary foundation.
* **Do NOT alter India Post session token handshake, hashes, or payload structures.**
* **Do NOT force-switch or override India Post selection** when India Post servers are down.

---

### 4. External Site Integrations Must Remain Modular Adapters
* Third-party tracking providers (`MySpeedPost`, `SpeedPostLive`, etc.) must be isolated in their own client modules (e.g. `myspeedpost_client.js`, `speedpostlive_client.js`).
* They must never interfere with, alter, or break India Post Official's token or network logic.

---

### 5. Terminology Consistency
* Any consignment with no tracking history or unbooked status is termed **`Not Booked`** across the server, UI, exports, and history.
