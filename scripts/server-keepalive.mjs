setInterval(() => {
  // Keep the process alive in environments where stdio pipes are unref'd.
}, 60_000);

// Boot the compiled service entrypoint after keepalive timer is registered.
await import("../dist/index.js");
