# Find My Friends

This widget uses the contract's worked example: private client-write channel
`fmfW` and private client-read channel `fmfR`, with one hour of series
retention. The bundle creates a room with `POST /widgets/find-my-friends/instances`
when `state.iid` is absent, persists the 32-hex instance token and a generated
`clientId`, posts SDK geolocation fixes, and reads `fmfR?latest=1` every five
seconds. Friend records are rendered as map markers and reconciled on every
poll.

The widget supplies room join, display-name input, and a Leave room button. A
room join centers the map on the user's first location fix. Leaving stops
location sharing and polling, removes the room's markers, clears `state.iid`,
and returns to the join/create view.
The frozen SDK has no
worker-to-DOM input event. See CONTRACTS.md sections 5–9 and SPEC.md sections
8.4 and 9.3.

See `docs/demo.md` for the current developer-console join and leave procedure.
