// TODO(A): geolocation proxy. The worker cannot call navigator.geolocation.
// startGeolocation begins a watchPosition on the main thread; stopGeolocation
// ends it. While active, the WidgetManager draws a native user-location dot.
// Events: geolocation, geolocationError. Contract: CONTRACTS.md sections 4-5.
