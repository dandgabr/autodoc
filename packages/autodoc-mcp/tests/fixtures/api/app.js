app.get('/health', healthHandler);
function healthHandler() { return { ok: true }; }
