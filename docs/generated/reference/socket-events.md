# Realtime WebSocket & WebRTC Contracts

Total Realtime Events Cataloged: **5**

| Event Name | Direction | Protocol | Payload Type | Typed Contract | Source File |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `eventName` | CLIENT_TO_SERVER | SOCKET_IO | `any` | No | `packages/autodoc-mcp/src/analyzers/realtime/index.ts` |
| `webrtc:offer` | BIDIRECTIONAL | WEBRTC | `RTCSessionDescriptionInit | RTCIceCandidateInit` | Yes | `packages/autodoc-mcp/src/analyzers/realtime/index.ts` |
| `webrtc:answer` | BIDIRECTIONAL | WEBRTC | `RTCSessionDescriptionInit | RTCIceCandidateInit` | Yes | `packages/autodoc-mcp/src/analyzers/realtime/index.ts` |
| `webrtc:candidate` | BIDIRECTIONAL | WEBRTC | `RTCSessionDescriptionInit | RTCIceCandidateInit` | Yes | `packages/autodoc-mcp/src/analyzers/realtime/index.ts` |
| `webrtc:ice-candidate` | BIDIRECTIONAL | WEBRTC | `RTCSessionDescriptionInit | RTCIceCandidateInit` | Yes | `packages/autodoc-mcp/src/analyzers/realtime/index.ts` |