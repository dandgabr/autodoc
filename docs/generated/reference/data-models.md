# Data Models & Persistence Schemas

Total Data Models Discovered: **2**

### Model: `User` (`users`)
- **Framework**: Mongoose
- **Soft Delete**: Disabled
- **Timestamps**: Enabled
- **Source**: `models/User.ts`

| Field Name | Type | Required | Indexing |
| :--- | :--- | :--- | :--- |
| `id` | `String` | Yes | Indexed |
| `username` | `String` | Yes | Indexed |
| `walletBalance` | `Number` | Yes | - |
| `createdAt` | `Date` | No | - |

### Model: `GameSession` (`gamesessions`)
- **Framework**: Mongoose
- **Soft Delete**: Enabled
- **Timestamps**: Enabled
- **Source**: `models/GameSession.ts`

| Field Name | Type | Required | Indexing |
| :--- | :--- | :--- | :--- |
| `sessionId` | `String` | Yes | Indexed |
| `gameType` | `String` | Yes | - |
| `status` | `String` | Yes | - |
| `totalBets` | `Number` | No | - |
