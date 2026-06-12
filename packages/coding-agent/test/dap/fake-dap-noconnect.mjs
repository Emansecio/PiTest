// Fake socket-mode DAP adapter that deliberately NEVER dials back to the
// listening port. Used to exercise the connect-timeout path in DapClient
// (#spawnSocket): the harness must kill this process instead of leaking it.
// It just idles until killed; an interval keeps the event loop alive.
const keepAlive = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
	clearInterval(keepAlive);
	process.exit(0);
});
