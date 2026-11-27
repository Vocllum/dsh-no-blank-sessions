<p align="center"><img src="icon.svg" width="96" alt=""></p>

<h1 align="center">dsh-no-blank-sessions</h1>

<p align="center">"New Session" reuses an existing blank draft instead of piling up empty sessions.</p>

<p align="center">English | <a href="README.zh.md">中文</a></p>

When a New Session request does not name an existing session, DSH's session controller always creates a new one, so blank sessions can pile up. Its own check also counts any session with no completed turn as blank, even one that is pinned, seeded or delegated. With this plugin, New Session first looks for a blank draft in the same workspace and opens that instead. A new session is created only when there is no blank one to reuse.

## What counts as blank

A session is reused only when all of these hold:

- It was never used: it has no seed, inherits nothing from another session, and is not a subagent or other delegated session.
- Its history holds nothing but setup choices: agent preset, approval policy, model, permission preset and sandbox mode.
- It is in the same workspace folder, and when you pick an agent preset it has the same one.
- It is not pinned and not archived.

## What else it does

- Several New Session requests that arrive at once for the same workspace and preset share one lookup, so a double click does not create two sessions.
- DSH decides whether to reuse a live or resumed session with its own "is this blank" check. The plugin tightens that check with the rules above, so a session that has history is never taken for a blank one.
- If you also run the OpenViking memory plugin with auto-capture or turn sync turned off, a session that still has only setup events does not start an OpenViking session until you actually use it.

Only a New Session you trigger yourself is redirected. Calls from services and from delegated sessions choose their own session IDs, as before.

## Similar plugins

[dsh-session-drafts](https://github.com/ne-ilyxa/dsh-session-drafts) also makes New Session reuse an empty draft, and adds a draft list to the sidebar. Both change how New Session picks a session, so use one of them, not both. They have not been tested together.

## Install

```sh
dsh plugin --profile desktop add "github:Vocllum/dsh-no-blank-sessions"
```

Use `--profile web` for `dsh web`. For DSH Desktop, launch it once, quit it fully, run the command, then start it again.

Requires DSH `>=0.2.2-rc.5 <0.3.0`. The plugin wraps two internals of DSH's session controller (`create` and `agents.isBlank`). If DSH does not provide them, it logs a warning and does nothing.

## Uninstall

Remove the plugin. It stores no data, and the original behaviour comes back when it unloads.

## Development

There is no automated test suite yet.

## License

MIT
