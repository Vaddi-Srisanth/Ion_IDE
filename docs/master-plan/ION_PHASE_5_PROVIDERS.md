# Phase 5 — Reviewed provider responses

In Full mode, open the online Tutor or Project Lens explanation dialog and select **Stream provider response** before reviewing a request. The review shows the response mode. Changing the mode retires the earlier review. A native confirmation authorizes a single send to the selected provider and model. The option resets after sending.

Ion uses the configured HTTPS Chat Completions endpoint and preserves the exact approved request body. Streaming is off by default. Both modes validate the complete structured answer, its citations and its source lease before showing it. A partial answer cannot open a file or produce an actionable recommendation. Streaming currently applies to explanations. Project-plan generation uses its existing single-response transport.

The parser accepts fragmented UTF-8 server-sent events for one assistant choice, an explicit stop and the terminal marker. Input is bounded to 1 MiB on the wire, 160 KiB of assembled text, 32 KiB per line, 64 KiB per event and 4,096 messages. Cancel, close and the existing request deadline stop a pending read. Invalid replies, unreviewed sources, credential echoes and tool calls produce errors. Transport changes never retry an approved request or contact a second provider.

The production build includes the parser in the on-demand explanation session. It adds no dependency, polling loop, independent process, or ordinary-editor network request. This checkpoint makes no comparative RAM, speed or model-quality claim. [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat)

The focused fixtures use synthetic responses, explicit approval and disposable profiles. They exercise the existing single-response behavior, byte-for-byte opt-in requests, cancellation mid-stream, stale source revisions, split UTF-8 and credentials across deltas, malformed responses and citation bounds. Live provider compatibility and additional provider protocols require separate evidence.

## Stop checkpoint

Candidate `12c223b9c0d24017719bf826a1db480aef1c394e` passed 58 focused tests locally and on hosted macOS ARM64. The macOS disposable production Electron journey passed. Windows reached the desktop journey after the build and focused tests; cancellation was requested when development was paused. Windows desktop acceptance remains open. Provider fixtures stayed offline throughout. [Native run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45934837451)
