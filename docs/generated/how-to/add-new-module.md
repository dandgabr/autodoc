# How-To: Add a New Domain Module to autodoc

1. Define domain entities in shared contracts.
2. Implement business logic and state machine handlers in service controllers.
3. Register REST routers and Socket.io event listeners.
4. Run `autodoc_scan_repository` to re-index the AST graph into SQLite.