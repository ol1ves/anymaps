# Flights NYC

This widget reads the public ADSB.lol cache through the `flights_nyc` external
channel. The server polls ADSB.lol every five seconds into a series cache using
`@ingestedAt` for indexing. The worker requests current aircraft with
`?bounds=...&latest=1`, interpolates marker positions between polls, and loads a
selected aircraft's trail with `?ids=<hex>`.

Aircraft markers use `track` as their rotation and show callsign, registration,
type, altitude, and ground speed in the info panel. The bundle uses only the
`anymaps` SDK and the provisioned channel route; it never calls ADSB.lol
directly. See SPEC.md sections 10.3 and 11.6.
