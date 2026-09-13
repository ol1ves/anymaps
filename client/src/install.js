// Provisioning, install, registry ops, startup (Task 6). Stub after Task 2.
//
// Task 2's stub derives channelRoutes locally without HTTP: for each channel
// `cid`, route = `${baseUrl}/widgets/${manifest.id}/channels/${cid}`. Task 6
// replaces provision with the real POST /widgets/{id}/provision call and
// implements startupEnable. The seam signature never changes.

// provision(manifest, baseUrl) -> Promise<channelRoutes>
// Stub: derive routes locally, no HTTP. Real: POST /widgets/{id}/provision.
export function provision(manifest, baseUrl) {
  const channels = (manifest && manifest.server && manifest.server.channels) || [];
  const channelRoutes = {};
  for (const ch of channels) {
    channelRoutes[ch.id] = `${baseUrl}/widgets/${manifest.id}/channels/${ch.id}`;
  }
  return Promise.resolve(channelRoutes);
}

// startupEnable(manager) -> Promise<void>
// Stub: no-op returning []. Real (Task 6): re-enable registry entries flagged
// enabled by fetching manifest + bundle and calling manager.enable.
export function startupEnable(_manager) {
  return Promise.resolve([]);
}

export function register(ctx) { /* Task 6 implements this */ }
