# Server notes for the new Local Video room

The client talks to your existing WebSocket server. Nothing existing changed. Two new message
types are used, and **the server must forward them to the other person in the room**, exactly
like it already does for `yt_play`, `yt_pause`, `yt_seek` and `yt_subtitle_offset`.

| type | purpose | payload |
|---|---|---|
| `yt_subtitle_file` | sends the chosen subtitle to your friend (in chunks) | `{ id, name, index, total, chunk }` |
| `yt_tick` | gentle drift correction every 5 s while playing | `{ id, position }` |

`yt_load_video` is unchanged as a type but now also carries `{ name, size, duration }` (used for the
"same video on both sides" check). If your server rebuilds that message instead of forwarding it as-is,
make it pass those three fields through.

## If your server relays every `yt_*` type
Nothing to do.

## If it has a whitelist (typical)
Add the two types next to the existing ones, for example:

```js
const RELAY_TYPES = new Set([
  'yt_play', 'yt_pause', 'yt_seek', 'yt_load_video', 'yt_subtitle_offset',
  'yt_subtitle_file',   // new
  'yt_tick',            // new
]);
```

## Message size
Each `yt_subtitle_file` message is at most ~24,000 characters of subtitle text plus a small envelope
(well under 100 KB even with multi-byte text), so default WebSocket limits are fine. A normal subtitle
file is 1 to 6 messages. If your server has a per-connection rate limiter, allow a burst of ~100 messages
(only needed for very large .ass files; the client refuses files above 4 MB).

## Late joiners
No server storage needed. When someone joins, the client already in the room re-sends its subtitle,
subtitle offset and file info after receiving `user_joined`.

## Without the server change
Everything still works (playing, pausing, seeking, offset sync) except sharing the subtitle file,
drift correction and the file-match check. The person who loads a subtitle would just see it locally.
