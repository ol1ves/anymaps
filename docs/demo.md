# Demo script (Column C)

The rehearsal script for all three demo criteria.

## Compatibility status after updating from main

Section C's manifests and bundles match the current schema, server channel
routes, SDK coordinate order, marker events, panels, and geolocation API.
The agent validates both the schema and the shared cross-channel invariants.
Its model request includes the schema and SDK guidance, and its CORS defaults
allow the client at localhost:5173 and 127.0.0.1:5173.

Current client integration dependencies: `client/src/install.js`,
`client/src/ui/gallery.js`, and `client/src/ui/wizard.js` are still stubs.
Install does not call the provisioning endpoint; startup does not restore
enabled widgets. Friends room/name/leave controls are not implemented either.
Use the manual path below until Column A supplies those features. The three
demo sections later in this document are acceptance criteria, not claims that
the current UI implements them.

The wizard's live model output and live feed availability require a separate
rehearsal. Source testing currently happens after candidate generation and
before publication, rather than the source-before-generation sequence in
CONTRACTS.md section 15. Authenticated candidates rely on a previous
`/wizard/secrets` call; the stateless service does not prove that a referenced
secret was verified against that exact source. Do not treat a mocked wizard
test as verification of this full workflow.

## Automated checks (PowerShell, repository root)

```powershell
py -3.13 -m pip install -r server/requirements.txt -r agent/requirements.txt -r server/requirements-dev.txt
py -3.13 -m pytest -q
py -3.13 -m pytest agent/tests/test_integration.py -v
```

The integration tests use the actual three manifests and bundles with a real
server and temporary SQLite database. They cover publish/fetch, idempotent
provisioning, external feed mappings and filters, and two users in an isolated
friends room. Feed responses are deterministic; no API key or network needed.

With Node.js/npm installed, also run from `client/`:

```powershell
npm ci
npm test
npm run build
```

## Manual integration path while client UI is pending

Start these commands in separate terminals from the repository root:

```powershell
py -3.13 -m uvicorn server.app.main:app --reload --port 8000
py -3.13 -m uvicorn agent.app.main:app --reload --port 8001 --env-file .env
```

Start `npm run dev` in `client/`, then visit http://localhost:5173.
The agent reads `WIZARD_LLM_API_KEY`; `--env-file .env` loads the existing file.
`SERVER_URL` defaults to http://localhost:8000. Use `/health` on ports 8000
and 8001 to confirm both services are up.

Publish the checked-in demo assets from PowerShell:

```powershell
foreach ($folder in @('bathrooms', 'flights', 'friends')) {
  $manifest = Get-Content "widgets/$folder/manifest.json" -Raw | ConvertFrom-Json
  $bundle = Get-Content "widgets/$folder/bundle.js" -Raw -Encoding UTF8
  $body = @{ manifest = $manifest; bundle = $bundle } | ConvertTo-Json -Depth 30
  Invoke-RestMethod http://localhost:8000/widgets -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
}
```

Expect one identity/version response per widget. A repeat publish returns 409;
use the already published version only if its assets match your working files.
Changed bundles require a new manifest version. Provisioning is first-wins by
widget id: a version bump does not replace existing channel configuration.
For an isolated rerun with changed channels, start the server with
`$env:DATABASE_PATH = 'data/rehearsal-new.db'` using a fresh filename.

Run this in the browser developer console to provision and enable all three:

```javascript
async function enableDemo(id, version = '0.1.0') {
  const baseUrl = 'http://localhost:8000';
  async function checked(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(await response.text());
    return response;
  }
  const prefix = `${baseUrl}/widgets/${id}/versions/${version}`;
  const manifest = await (await checked(`${prefix}/manifest`)).json();
  const bundleSource = await (await checked(`${prefix}/bundle`)).text();
  await checked(`${baseUrl}/widgets/${id}/provision`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({manifest})
  });
  await window.__ANYMAPS_DEV__.manager.enable({manifest, bundleSource, baseUrl});
}
for (const id of ['nyc-bathrooms', 'flights-nyc', 'find-my-friends']) {
  await enableDemo(id);
}
```

Allow location access. Pan around NYC after the initial upstream poll finishes;
bathrooms refresh on map movement and flights refresh every five seconds.
Click an aircraft to inspect details and its trail. Watch both the browser
console and server logs for errors. Repeat the console setup after reloading
because automatic startup is still a stub.

For a second browser profile, run the helper above there too. Copy the token
from browser 1's Friends panel; in browser 2 run:

```javascript
window.__ANYMAPS_DEV__.manager.disable('find-my-friends');
const key = 'anymaps.state.find-my-friends';
const state = JSON.parse(localStorage.getItem(key) || '{}');
state.iid = 'PASTE_BROWSER_1_ROOM_TOKEN';
state.displayName = 'Browser 2';
localStorage.setItem(key, JSON.stringify(state));
await enableDemo('find-my-friends');
```

Do not copy `clientId` between profiles. Disable/re-enable after changing room
or name because the running worker captures those values at startup. To leave,
disable the widget, remove `iid` from its saved state, and leave it disabled;
enabling without an iid creates a new room. Old location records remain until
the server's retention cleanup; there is no DELETE API.

Test the wizard independently of the unfinished panel through
http://localhost:8001/docs (`POST /wizard/generate`) using:

```json
{"messages":[{"role":"user","content":"Create an NYC drinking-water fountains map using Overpass. Ask me to confirm the proposed widget before publishing."}]}
```

For each next turn, resend the full transcript with the returned question as
an assistant message and your answer as a user message. A completed response
must identify a published version fetchable through the server; enable it with
`enableDemo(response.widgetId, response.version)`. Keep raw source credentials
out of this transcript; use `/wizard/secrets` separately.

Optional live LLM smoke test (makes one billed request; load the key into the
terminal environment first):

```powershell
$env:RUN_LIVE_DEEPSEEK_TEST = '1'
py -3.13 -m pytest agent/tests/test_wizard.py::test_live_deepseek_smoke -v
Remove-Item Env:RUN_LIVE_DEEPSEEK_TEST
```

## Demo 1 — three widgets live

1. Start the server and client in a secure context, then open the gallery.
2. Install and enable `nyc-bathrooms`, `flights-nyc`, and
   `find-my-friends` from the registry.
3. Confirm the client has three workers and that all three draw through the
   SDK: bathroom markers, aircraft markers, and friend markers.
4. Move the map. Bathrooms and flights must refetch through their provisioned
   public routes; the friends widget must continue its private-room poll.
5. Confirm one widget's markers and panel remain isolated from the other two.

## Demo 2 — publish and second-user install

1. Publish `widgets/friends/manifest.json` and `widgets/friends/bundle.js` with
   `POST /widgets`; expect `201` with `find-my-friends` and `0.1.0`.
2. In each browser, install the same published version. Provisioning must be
   idempotent and return the same `fmfW` and `fmfR` route prefixes.
3. Browser 1 creates a room with `POST /widgets/find-my-friends/instances` and
   shares the returned 32-hex token with browser 2 out of band.
4. Browser 1 enters a display name and shares a geolocation fix. Browser 2
   enters the token and its display name. Both read only
   `/channels/fmfR/instances/{token}?latest=1` and see the other marker.
5. Create a second room and post a record there. Confirm the first room cannot
   read it. Leave the first room and confirm the client clears `state.iid` and
   stops writing; the server has no DELETE route.

## Demo 3 — wizard

1. Open the wizard panel and submit one concrete widget problem.
2. If the DeepSeek key is missing, confirm the panel shows the actionable key
   setup error and does not make an LLM request.
3. With the key configured, confirm each turn sends the full transcript and
   returns either one clarifying question or the exact `{done, widgetId,
   version, manifest}` response shape.
4. For a public source, confirm the Agent Service tests it once under the
   HTTPS/SSRF and response-size limits before publishing.
5. For an authenticated source, verify the temporary key route first, then
   confirm the server receives the secret through `POST /secrets`; the key must
   never appear in the transcript, manifest, bundle, or response.
6. Confirm the service publishes with `POST /widgets`, then the client fetches
   the returned version and enables the widget automatically.
