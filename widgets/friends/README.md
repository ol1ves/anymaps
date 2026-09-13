# Find My Friends

This widget uses the contract's worked example: private client-write channel
`fmfW` and private client-read channel `fmfR`, with one hour of series
retention. The bundle creates a room with `POST /widgets/find-my-friends/instances`
when `state.iid` is absent, persists the 32-hex instance token and a generated
`clientId`, posts SDK geolocation fixes, and reads `fmfR?latest=1` every five
seconds. Friend records are rendered as map markers and reconciled on every
poll.

The client must supply room join, display-name input, and the client-side leave
button; those controls are still pending on main. They must persist or clear `state.iid`
and restart or disable the worker so its captured room state cannot keep writing.
The frozen SDK has no
worker-to-DOM input event. See CONTRACTS.md sections 5–9 and SPEC.md sections
8.4 and 9.3.

See `docs/demo.md` for the current developer-console join and leave procedure.
