// anymaps SDK runtime (Column A).
//
// This file is prepended to every widget bundle before the blob worker is
// created, so `anymaps` is a global inside the worker. Widget authors and
// agents write against this surface, never against raw postMessage.
//
// Contract: CONTRACTS.md sections 2-6. Envelope kinds: init, cmd, event,
// error. The library assigns a unique id to each command it sends and routes
// incoming event and error messages to registered handlers.
//
// TODO(A): implement the full surface: ready/config/state, all render
// commands, persist, camera, geolocation, on/off.
