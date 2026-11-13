# D0014: The snip: overlays loaded ahead and hidden, a three-call bridge, the crop in DIPs, links to the browser

Date: 2026-11-13. Status: active.

The owner asked for "a hotkey that directly opens a similar screenshot view, and when you outline the area, then you can straight away start typing the prompt". The snip hotkey (`snipHotkey`, default `Control+Alt+S`) freezes every display, and the person drags an area and types the task in a box beside it. How it works is in [windows-shell](../windows-shell.md) ("The snip").

## Decisions
- **The overlays are made and loaded ahead, hidden.** One window per display is created and loads `/assets/snip.html` once the runner answers, and again right after each snip closes and when the displays change. The key then only captures, hands each page its image and shows the windows. The page's `getCapture()` waits until the key has been pressed.
- **One `desktopCapturer` call for every display**, sized to the largest display at its native resolution (`captureSize`). Sources are matched to displays by `display_id`, or by order where Windows gives no id (`matchSources`).
- **The page sees a JPEG; the crop comes from the full capture.** `getCapture()` returns a `data:image/jpeg` URL (quality 92) of the page's own display. The PNG that is saved is cut from the image the main process kept, never from what the page shows.
- **`crop(rect)` takes CSS pixels of the overlay**, which are the display's DIPs from its top left. The main process checks it (`acceptedRect`: exactly `x`, `y`, `width` and `height`, finite numbers, at least one pixel, inside the display) and turns it into device pixels (`cropPlan`): left and top rounded down, right and bottom up, so everything selected is in. The page shows the size with the same rule (`devicePixels`), and a test checks that the two rules agree.
- **The bridge is three calls and nothing else**, given only to the overlay windows: `getCapture()`, `crop(rect)` and `close()`. Each is answered only from one of the shell's own overlay windows, from its main frame, on the runner's `/assets/snip.html` (`acceptedSender`). The file name comes from the clock, and the folder is `<temp>\intuition`. Nothing the page sends names a file.
- **Snips are pruned with the clips**: the newest 20 `clip-` and `snip-` files together, by their time.
- **Links to `http:`, `https:` and `mailto:` go to the default browser** (`externalLink`), from a new window or from a link followed in the page. Links to the runner's own origin stay with the shell, which opens them in its windows or refuses them. Redirects never go to the browser, and neither does a URL with a user name or password. Another origin on this machine (`localhost`, another port) counts as elsewhere.

## Why
- **Made ahead, because of the time.** Making three windows and loading the page took about 300 ms on this machine, and blocked the main process while the capture was meant to run. That came on top of the capture itself, about 430 ms for three displays (one at 200%), so the first measured snip took 880 ms. With the windows made ahead it is the capture and the drawing: 570 to 640 ms on the same three displays. The spec aims for about 300 ms. The capture is most of the rest, and one `getSources` call is the only way Electron offers.
- **JPEG for the view:** a PNG of a 2880x1802 display takes noticeably longer to encode than a JPEG at quality 92, and the view is only looked at.
- **DIPs in, device pixels in the main process:** the page can't know the display's scale for certain, and the main process has the image. Rounding outwards means a selection never loses its edge pixels.
- **Matching by ratio when the image isn't native:** one call sizes every screen to fit the largest, so a smaller display's image can come back larger than its own pixels. The cut is then made in that image's pixels and resized to the display's own. At its native size the image is taken at the display's scale, because Windows rounds DIPs: 2560 pixels at 150% are 1707 DIPs.
- **Links:** the owner asked that links from the pages open in the browser, not be refused. Only these three schemes, because `file:`, `ms-settings:` and other protocol handlers would run things on the machine.

## What this costs
- **Hidden renderers.** One renderer process per display stays loaded for the life of the shell, as the dock's does, with `backgroundThrottling: false` so it draws at once. On three displays that is three more processes.
- **Two overlays can each hold a selection for a moment.** A press on a second display takes the focus there, and the first page lets its selection go when it loses the focus. What was typed in the first box stays in that box and is not carried over.
- **Over 300 ms.** The self-test prints the time, and fails only past 3 seconds, which would mean something is broken rather than slow.
